use adobepy_protocol::{PhotoshopBootstrapRequest, PhotoshopHostTarget};
use anyhow::{anyhow, Context};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::bootstrap_transaction::{
    same_file_identity, ConfigCommitConfirmation, ConfigLease, ConfigPublicationPermit,
    ConfigTransactionOwner, FileReceipt, HostProcessBroker, OwnedHostProcess, StagedArtifact,
};

const MAX_HASH_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const CONFIG_NAME: &str = "adobepy.config.js";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObservedHostProcess {
    pub pid: u32,
    pub process_start_identity: String,
    pub executable_path: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedBootstrap {
    config_path: Option<PathBuf>,
    previous_config: Option<Vec<u8>>,
    transient_config: Option<Vec<u8>>,
    committed_config: Option<Vec<u8>>,
    pub module_sha256: String,
    illustrator_receipt: Option<IllustratorPluginReceipt>,
}

#[derive(Debug, Clone)]
pub(crate) struct BlockingDeadline {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

#[derive(Debug, thiserror::Error)]
#[error("bounded bootstrap operation was cancelled")]
struct BlockingOperationCancelled;

impl BlockingDeadline {
    pub(crate) fn new(timeout: Duration) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + timeout,
        }
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub(crate) fn checkpoint(&self) -> anyhow::Result<()> {
        if self.cancelled.load(Ordering::SeqCst) || Instant::now() >= self.deadline {
            return Err(BlockingOperationCancelled.into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn interruptible_sleep(&self, duration: Duration) -> anyhow::Result<()> {
        let sleep_deadline = Instant::now() + duration;
        loop {
            self.checkpoint()?;
            let now = Instant::now();
            if now >= sleep_deadline {
                return Ok(());
            }
            thread::sleep((sleep_deadline - now).min(Duration::from_millis(2)));
        }
    }
}

pub(crate) fn is_blocking_deadline_error(error: &anyhow::Error) -> bool {
    error.is::<BlockingOperationCancelled>()
        || error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::TimedOut)
}

impl PreparedBootstrap {
    #[cfg(test)]
    pub(crate) fn fake(module_sha256: impl Into<String>) -> Self {
        Self {
            config_path: None,
            previous_config: None,
            transient_config: None,
            committed_config: None,
            module_sha256: module_sha256.into(),
            illustrator_receipt: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn config_test(
        config_path: PathBuf,
        previous_config: Option<Vec<u8>>,
        transient_config: Vec<u8>,
        committed_config: Vec<u8>,
        module_sha256: impl Into<String>,
    ) -> Self {
        Self {
            config_path: Some(config_path),
            previous_config,
            transient_config: Some(transient_config),
            committed_config: Some(committed_config),
            module_sha256: module_sha256.into(),
            illustrator_receipt: None,
        }
    }
}

pub(crate) trait PhotoshopBootstrapTransaction: Send + Sync {
    fn module_sha256(&self) -> &str;
    fn validate_prepared_identity_bounded(
        &self,
        deadline: &BlockingDeadline,
    ) -> anyhow::Result<()> {
        deadline.checkpoint()
    }
    fn activate(&self) -> anyhow::Result<()>;
    fn finalize_pending(&self) -> anyhow::Result<()>;
    fn prepare_commit_confirmation(
        self: Arc<Self>,
    ) -> anyhow::Result<Box<dyn PhotoshopBootstrapCommitConfirmation>>;
    fn revoke(&self);
    fn rollback(&self) -> anyhow::Result<()>;
}

pub(crate) trait PhotoshopBootstrapCommitConfirmation: Send {
    fn confirm(self: Box<Self>) -> anyhow::Result<Box<dyn PhotoshopBootstrapPublicationPermit>>;
}

pub(crate) trait PhotoshopBootstrapPublicationPermit: Send {
    fn publish(self: Box<Self>) -> anyhow::Result<()>;
}

pub(crate) struct LaunchedHostProcess {
    pub observed: ObservedHostProcess,
    owned: Option<OwnedHostProcess>,
    #[cfg(test)]
    fake_live: Option<Arc<AtomicBool>>,
    #[cfg(test)]
    fake_terminations: Option<Arc<AtomicUsize>>,
    #[cfg(test)]
    fake_termination_delay_ms: Option<Arc<AtomicU64>>,
}

impl LaunchedHostProcess {
    fn owned(observed: ObservedHostProcess, owned: OwnedHostProcess) -> Self {
        Self {
            observed,
            owned: Some(owned),
            #[cfg(test)]
            fake_live: None,
            #[cfg(test)]
            fake_terminations: None,
            #[cfg(test)]
            fake_termination_delay_ms: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn fake(
        observed: ObservedHostProcess,
        live: Arc<AtomicBool>,
        terminations: Arc<AtomicUsize>,
        termination_delay_ms: Arc<AtomicU64>,
    ) -> Self {
        Self {
            observed,
            owned: None,
            fake_live: Some(live),
            fake_terminations: Some(terminations),
            fake_termination_delay_ms: Some(termination_delay_ms),
        }
    }

    pub(crate) async fn terminate_and_reap(
        mut self,
        deadline: tokio::time::Instant,
    ) -> anyhow::Result<()> {
        #[cfg(test)]
        if let Some(live) = self.fake_live.take() {
            let delay_ms = self
                .fake_termination_delay_ms
                .take()
                .map(|delay| delay.load(Ordering::SeqCst))
                .unwrap_or_default();
            if tokio::time::timeout_at(
                deadline,
                tokio::time::sleep(Duration::from_millis(delay_ms)),
            )
            .await
            .is_err()
            {
                return Err(anyhow!("fake host termination exceeded its deadline"));
            }
            live.store(false, Ordering::SeqCst);
            if let Some(terminations) = self.fake_terminations.take() {
                terminations.fetch_add(1, Ordering::SeqCst);
            }
            return Ok(());
        }
        let owned = self
            .owned
            .take()
            .context("host process ownership is missing")?;
        owned
            .terminate_and_reap(deadline)
            .await
            .map(|_| ())
            .map_err(anyhow::Error::from)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PathReceipt {
    requested: PathBuf,
    canonical: PathBuf,
    filesystem_identity: (u64, u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IllustratorFileReceipt {
    path: PathReceipt,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IllustratorPluginReceipt {
    root: PathReceipt,
    manifest: IllustratorFileReceipt,
    index: IllustratorFileReceipt,
    module: IllustratorFileReceipt,
}

impl IllustratorPluginReceipt {
    pub(crate) fn validate_bounded(&self, deadline: &BlockingDeadline) -> anyhow::Result<()> {
        recapture_illustrator_receipt_bounded(self, Some(deadline))
    }
}

pub(crate) trait PhotoshopBootstrapBackend: Send + Sync {
    fn attest(&self, request: &PhotoshopBootstrapRequest) -> anyhow::Result<String>;

    fn prepare(
        &self,
        request: &PhotoshopBootstrapRequest,
        nonce: &str,
        token: &str,
        websocket_url: &str,
    ) -> anyhow::Result<PreparedBootstrap>;

    fn begin_transaction(
        &self,
        prepared: PreparedBootstrap,
    ) -> anyhow::Result<Arc<dyn PhotoshopBootstrapTransaction>>;

    fn launch_owned(
        &self,
        target: &PhotoshopHostTarget,
        cancelled: Arc<AtomicBool>,
    ) -> anyhow::Result<LaunchedHostProcess>;

    fn process_matches(&self, observed: &ObservedHostProcess) -> bool;

    fn executable_sha256(&self, path: &str) -> anyhow::Result<String>;

    fn capture_illustrator_receipt_bounded(
        &self,
        _request: &PhotoshopBootstrapRequest,
        deadline: &BlockingDeadline,
    ) -> anyhow::Result<Option<IllustratorPluginReceipt>> {
        deadline.checkpoint()?;
        Ok(None)
    }

    fn attest_bounded(
        &self,
        request: &PhotoshopBootstrapRequest,
        deadline: &BlockingDeadline,
    ) -> anyhow::Result<String> {
        deadline.checkpoint()?;
        let result = self.attest(request);
        deadline.checkpoint()?;
        result
    }

    fn executable_sha256_bounded(
        &self,
        path: &str,
        deadline: &BlockingDeadline,
    ) -> anyhow::Result<String> {
        deadline.checkpoint()?;
        let result = self.executable_sha256(path);
        deadline.checkpoint()?;
        result
    }
}

#[derive(Debug, Default)]
pub(crate) struct SystemPhotoshopBootstrapBackend {
    config_owners: Mutex<HashMap<PathBuf, ConfigTransactionOwner>>,
    host_owner: HostProcessBroker,
    launch_arguments: Arc<[String]>,
}

#[derive(Debug, Default)]
pub(crate) struct SystemIllustratorBootstrapBackend {
    config_owners: Mutex<HashMap<PathBuf, ConfigTransactionOwner>>,
    host_owner: HostProcessBroker,
    launch_arguments: Arc<[String]>,
}

impl SystemPhotoshopBootstrapBackend {
    #[cfg(all(test, windows))]
    fn with_launch_arguments(arguments: Vec<String>) -> Self {
        Self {
            launch_arguments: arguments.into(),
            ..Self::default()
        }
    }
}

struct SystemBootstrapTransaction {
    module_sha256: String,
    illustrator_receipt: Option<IllustratorPluginReceipt>,
    cancelled: Arc<AtomicBool>,
    state: Mutex<SystemBootstrapTransactionState>,
}

struct SystemBootstrapTransactionState {
    lease: Option<Arc<ConfigLease>>,
    staged: StagedArtifact,
    committed_config: Vec<u8>,
    staging_path: PathBuf,
    activated: bool,
    commit_receipt: Option<FileReceipt>,
}

struct SystemBootstrapCommitConfirmation {
    transaction: Arc<SystemBootstrapTransaction>,
    lease: Arc<ConfigLease>,
    confirmation: ConfigCommitConfirmation,
}

struct SystemBootstrapPublicationPermit {
    transaction: Arc<SystemBootstrapTransaction>,
    publication: ConfigPublicationPermit,
}

impl PhotoshopBootstrapCommitConfirmation for SystemBootstrapCommitConfirmation {
    fn confirm(self: Box<Self>) -> anyhow::Result<Box<dyn PhotoshopBootstrapPublicationPermit>> {
        if self.transaction.cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        if let Some(receipt) = self.transaction.illustrator_receipt.as_ref() {
            recapture_illustrator_receipt(receipt)?;
        }
        let state = self
            .transaction
            .state
            .lock()
            .map_err(|_| anyhow!("transaction lock failed"))?;
        if self.transaction.cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        let current_lease = state
            .lease
            .as_ref()
            .context("Photoshop config lease is unavailable")?;
        if !Arc::ptr_eq(current_lease, &self.lease) {
            return Err(anyhow!("Photoshop config lease is stale"));
        }
        drop(state);
        let publication = self.lease.confirm_prevalidated(self.confirmation)?;
        Ok(Box::new(SystemBootstrapPublicationPermit {
            transaction: self.transaction,
            publication,
        }))
    }
}

impl PhotoshopBootstrapPublicationPermit for SystemBootstrapPublicationPermit {
    fn publish(self: Box<Self>) -> anyhow::Result<()> {
        if self.transaction.cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        if let Some(receipt) = self.transaction.illustrator_receipt.as_ref() {
            recapture_illustrator_receipt(receipt)?;
        }
        self.publication.publish()?;
        Ok(())
    }
}

impl PhotoshopBootstrapTransaction for SystemBootstrapTransaction {
    fn module_sha256(&self) -> &str {
        &self.module_sha256
    }

    fn validate_prepared_identity_bounded(
        &self,
        deadline: &BlockingDeadline,
    ) -> anyhow::Result<()> {
        deadline.checkpoint()?;
        if let Some(receipt) = self.illustrator_receipt.as_ref() {
            recapture_illustrator_receipt_bounded(receipt, Some(deadline))?;
        }
        deadline.checkpoint()
    }

    fn activate(&self) -> anyhow::Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        let (lease, staged) = {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow!("transaction lock failed"))?;
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
            }
            (
                state
                    .lease
                    .as_ref()
                    .context("Photoshop config lease is unavailable")?
                    .clone(),
                state.staged.clone(),
            )
        };
        lease.activate_cancellable(&staged, &self.cancelled)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("transaction lock failed"))?;
        if self.cancelled.load(Ordering::SeqCst)
            || !state
                .lease
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &lease))
        {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        state.activated = true;
        Ok(())
    }

    fn finalize_pending(&self) -> anyhow::Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        if let Some(receipt) = self.illustrator_receipt.as_ref() {
            recapture_illustrator_receipt(receipt)?;
        }
        let (lease, committed, staging_path) = {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow!("transaction lock failed"))?;
            if !state.activated || self.cancelled.load(Ordering::SeqCst) {
                return Err(anyhow!("Photoshop bootstrap transaction is not active"));
            }
            (
                state
                    .lease
                    .as_ref()
                    .context("Photoshop config lease is unavailable")?
                    .clone(),
                state.committed_config.clone(),
                state.staging_path.clone(),
            )
        };
        let receipt = lease.prepare_commit_cancellable(&committed, &self.cancelled)?;
        remove_staging_file(&staging_path)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("transaction lock failed"))?;
        if self.cancelled.load(Ordering::SeqCst)
            || !state
                .lease
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &lease))
        {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        state.commit_receipt = Some(receipt);
        Ok(())
    }

    fn prepare_commit_confirmation(
        self: Arc<Self>,
    ) -> anyhow::Result<Box<dyn PhotoshopBootstrapCommitConfirmation>> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        if let Some(receipt) = self.illustrator_receipt.as_ref() {
            recapture_illustrator_receipt(receipt)?;
        }
        let (lease, receipt) = {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow!("transaction lock failed"))?;
            (
                state
                    .lease
                    .as_ref()
                    .context("Photoshop config lease is unavailable")?
                    .clone(),
                state
                    .commit_receipt
                    .as_ref()
                    .context("Photoshop commit receipt is unavailable")?
                    .clone(),
            )
        };
        let confirmation = lease.prepare_commit_confirmation(&receipt)?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop bootstrap transaction is revoked"));
        }
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("transaction lock failed"))?;
        if !state
            .lease
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &lease))
        {
            return Err(anyhow!("Photoshop config lease is stale"));
        }
        drop(state);
        Ok(Box::new(SystemBootstrapCommitConfirmation {
            transaction: self,
            lease,
            confirmation,
        }))
    }

    fn revoke(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn rollback(&self) -> anyhow::Result<()> {
        self.revoke();
        let (lease, staging_path) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow!("transaction lock failed"))?;
            let lease = state.lease.take();
            state.activated = false;
            state.commit_receipt = None;
            (lease, state.staging_path.clone())
        };
        if let Some(lease) = lease {
            lease.rollback()?;
        }
        remove_staging_file(&staging_path)?;
        Ok(())
    }
}

fn remove_staging_file(path: &Path) -> anyhow::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

impl PhotoshopBootstrapBackend for SystemPhotoshopBootstrapBackend {
    fn attest(&self, request: &PhotoshopBootstrapRequest) -> anyhow::Result<String> {
        attest_request(request)
    }

    fn prepare(
        &self,
        request: &PhotoshopBootstrapRequest,
        nonce: &str,
        token: &str,
        websocket_url: &str,
    ) -> anyhow::Result<PreparedBootstrap> {
        let module_sha256 = attest_request(request)?;
        let plugin_root = fs::canonicalize(&request.plugin.installed_plugin_root)?;
        let config_path = plugin_root.join(CONFIG_NAME);
        let previous_config = match stable_file_bytes(&config_path, 64 * 1024) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).context("Photoshop bridge configuration is unavailable")
            }
        };
        let transient_config =
            bootstrap_config(websocket_url, token, &request.target, Some(nonce))?.into_bytes();
        let committed_config =
            bootstrap_config(websocket_url, token, &request.target, None)?.into_bytes();
        Ok(PreparedBootstrap {
            config_path: Some(config_path),
            previous_config,
            transient_config: Some(transient_config),
            committed_config: Some(committed_config),
            module_sha256,
            illustrator_receipt: None,
        })
    }

    fn begin_transaction(
        &self,
        prepared: PreparedBootstrap,
    ) -> anyhow::Result<Arc<dyn PhotoshopBootstrapTransaction>> {
        let path = prepared
            .config_path
            .context("prepared Photoshop configuration path is missing")?;
        let transient = prepared
            .transient_config
            .context("prepared Photoshop transient configuration is missing")?;
        let committed = prepared
            .committed_config
            .context("prepared Photoshop committed configuration is missing")?;
        let expected = FileReceipt::capture(&path)?;
        if expected.bytes() != prepared.previous_config.as_deref() {
            return Err(anyhow!(
                "Photoshop bridge configuration changed before transaction ownership"
            ));
        }
        let owner = self
            .config_owners
            .lock()
            .map_err(|_| anyhow!("Photoshop config owner lock failed"))?
            .entry(path.clone())
            .or_default()
            .clone();
        let lease = owner.begin(&path, &expected)?;
        let staging_path = path
            .parent()
            .context("Photoshop configuration has no parent")?
            .join(format!(".adobepy.{}.stage", Uuid::new_v4().simple()));
        let mut staging = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging_path)?;
        staging.write_all(&transient)?;
        staging.sync_all()?;
        drop(staging);
        let staged = match StagedArtifact::capture(lease.identity(), &staging_path) {
            Ok(staged) => staged,
            Err(error) => {
                let _ = remove_staging_file(&staging_path);
                let _ = lease.revoke();
                return Err(error);
            }
        };
        Ok(Arc::new(SystemBootstrapTransaction {
            module_sha256: prepared.module_sha256,
            illustrator_receipt: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            state: Mutex::new(SystemBootstrapTransactionState {
                lease: Some(Arc::new(lease)),
                staged,
                committed_config: committed,
                staging_path,
                activated: false,
                commit_receipt: None,
            }),
        }))
    }

    fn launch_owned(
        &self,
        target: &PhotoshopHostTarget,
        cancelled: Arc<AtomicBool>,
    ) -> anyhow::Result<LaunchedHostProcess> {
        validate_host_file(target)?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop launch ownership is revoked"));
        }
        let owned = self
            .host_owner
            .spawn_cancelable(
                Path::new(&target.executable_path),
                &self.launch_arguments,
                cancelled.clone(),
            )
            .map_err(anyhow::Error::from)?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let observed = loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err(anyhow!("Photoshop launch ownership is revoked"));
            }
            match observe_process(owned.identity().pid()) {
                Ok(observed) => break observed,
                Err(error) if Instant::now() < deadline => {
                    let _ = error;
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        };
        if !same_path(
            Path::new(&observed.executable_path),
            Path::new(&target.executable_path),
        ) {
            return Err(anyhow!(
                "the launched Photoshop process identity does not match the selected product"
            ));
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Photoshop launch ownership is revoked"));
        }
        Ok(LaunchedHostProcess::owned(observed, owned))
    }

    fn process_matches(&self, observed: &ObservedHostProcess) -> bool {
        observe_process(observed.pid).is_ok_and(|actual| actual == *observed)
    }

    fn executable_sha256(&self, path: &str) -> anyhow::Result<String> {
        digest_file(Path::new(path))
    }
}

impl PhotoshopBootstrapBackend for SystemIllustratorBootstrapBackend {
    fn attest(&self, request: &PhotoshopBootstrapRequest) -> anyhow::Result<String> {
        attest_illustrator_request(request)
    }

    fn prepare(
        &self,
        request: &PhotoshopBootstrapRequest,
        nonce: &str,
        token: &str,
        websocket_url: &str,
    ) -> anyhow::Result<PreparedBootstrap> {
        let illustrator_receipt = attest_illustrator_request_with_receipt(request)?;
        let module_sha256 = illustrator_receipt.module.sha256.clone();
        let plugin_root = fs::canonicalize(&request.plugin.installed_plugin_root)?;
        let config_path = plugin_root.join(CONFIG_NAME);
        let previous_config = match stable_file_bytes(&config_path, 64 * 1024) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).context("Illustrator bridge configuration is unavailable")
            }
        };
        let transient_config = illustrator_bootstrap_config(
            websocket_url,
            token,
            &request.target,
            &request.host.profile_id,
            Some(nonce),
        )?
        .into_bytes();
        let committed_config = illustrator_bootstrap_config(
            websocket_url,
            token,
            &request.target,
            &request.host.profile_id,
            None,
        )?
        .into_bytes();
        Ok(PreparedBootstrap {
            config_path: Some(config_path),
            previous_config,
            transient_config: Some(transient_config),
            committed_config: Some(committed_config),
            module_sha256,
            illustrator_receipt: Some(illustrator_receipt),
        })
    }

    fn begin_transaction(
        &self,
        prepared: PreparedBootstrap,
    ) -> anyhow::Result<Arc<dyn PhotoshopBootstrapTransaction>> {
        let path = prepared
            .config_path
            .context("prepared Illustrator configuration path is missing")?;
        let transient = prepared
            .transient_config
            .context("prepared Illustrator transient configuration is missing")?;
        let committed = prepared
            .committed_config
            .context("prepared Illustrator committed configuration is missing")?;
        let expected = FileReceipt::capture(&path)?;
        if expected.bytes() != prepared.previous_config.as_deref() {
            return Err(anyhow!(
                "Illustrator bridge configuration changed before transaction ownership"
            ));
        }
        let owner = self
            .config_owners
            .lock()
            .map_err(|_| anyhow!("Illustrator config owner lock failed"))?
            .entry(path.clone())
            .or_default()
            .clone();
        let lease = owner.begin(&path, &expected)?;
        let staging_path = path
            .parent()
            .context("Illustrator configuration has no parent")?
            .join(format!(".adobepy.{}.stage", Uuid::new_v4().simple()));
        let mut staging = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging_path)?;
        staging.write_all(&transient)?;
        staging.sync_all()?;
        drop(staging);
        let staged = match StagedArtifact::capture(lease.identity(), &staging_path) {
            Ok(staged) => staged,
            Err(error) => {
                let _ = remove_staging_file(&staging_path);
                let _ = lease.revoke();
                return Err(error);
            }
        };
        Ok(Arc::new(SystemBootstrapTransaction {
            module_sha256: prepared.module_sha256,
            illustrator_receipt: prepared.illustrator_receipt,
            cancelled: Arc::new(AtomicBool::new(false)),
            state: Mutex::new(SystemBootstrapTransactionState {
                lease: Some(Arc::new(lease)),
                staged,
                committed_config: committed,
                staging_path,
                activated: false,
                commit_receipt: None,
            }),
        }))
    }

    fn launch_owned(
        &self,
        target: &PhotoshopHostTarget,
        cancelled: Arc<AtomicBool>,
    ) -> anyhow::Result<LaunchedHostProcess> {
        validate_illustrator_host_file(target)?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Illustrator launch ownership is revoked"));
        }
        let owned = self
            .host_owner
            .spawn_cancelable(
                Path::new(&target.executable_path),
                &self.launch_arguments,
                cancelled.clone(),
            )
            .map_err(anyhow::Error::from)?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let observed = loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err(anyhow!("Illustrator launch ownership is revoked"));
            }
            match observe_process(owned.identity().pid()) {
                Ok(observed) => break observed,
                Err(error) if Instant::now() < deadline => {
                    let _ = error;
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        };
        if !same_path(
            Path::new(&observed.executable_path),
            Path::new(&target.executable_path),
        ) {
            return Err(anyhow!(
                "the launched Illustrator process identity does not match the selected product"
            ));
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Illustrator launch ownership is revoked"));
        }
        Ok(LaunchedHostProcess::owned(observed, owned))
    }

    fn process_matches(&self, observed: &ObservedHostProcess) -> bool {
        observe_process(observed.pid).is_ok_and(|actual| actual == *observed)
    }

    fn executable_sha256(&self, path: &str) -> anyhow::Result<String> {
        digest_file(Path::new(path))
    }

    fn attest_bounded(
        &self,
        request: &PhotoshopBootstrapRequest,
        deadline: &BlockingDeadline,
    ) -> anyhow::Result<String> {
        Ok(
            attest_illustrator_request_with_receipt_bounded(request, Some(deadline))?
                .module
                .sha256,
        )
    }

    fn capture_illustrator_receipt_bounded(
        &self,
        request: &PhotoshopBootstrapRequest,
        deadline: &BlockingDeadline,
    ) -> anyhow::Result<Option<IllustratorPluginReceipt>> {
        Ok(Some(attest_illustrator_request_with_receipt_bounded(
            request,
            Some(deadline),
        )?))
    }

    fn executable_sha256_bounded(
        &self,
        path: &str,
        deadline: &BlockingDeadline,
    ) -> anyhow::Result<String> {
        let bytes = stable_file_bytes_bounded(Path::new(path), MAX_HASH_BYTES, Some(deadline))?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

fn attest_illustrator_request(request: &PhotoshopBootstrapRequest) -> anyhow::Result<String> {
    Ok(attest_illustrator_request_with_receipt(request)?
        .module
        .sha256)
}

fn attest_illustrator_request_with_receipt(
    request: &PhotoshopBootstrapRequest,
) -> anyhow::Result<IllustratorPluginReceipt> {
    attest_illustrator_request_with_receipt_bounded(request, None)
}

fn attest_illustrator_request_with_receipt_bounded(
    request: &PhotoshopBootstrapRequest,
    deadline: Option<&BlockingDeadline>,
) -> anyhow::Result<IllustratorPluginReceipt> {
    deadline_checkpoint(deadline)?;
    if let Some(deadline) = deadline {
        validate_illustrator_host_file_bounded(&request.host, deadline)?;
    } else {
        validate_illustrator_host_file(&request.host)?;
    }
    let requested_root = Path::new(&request.plugin.installed_plugin_root);
    let root = capture_path_receipt_bounded(requested_root, true, deadline)
        .context("installed Illustrator bridge is unavailable")?;
    let plugin_root = root.canonical.clone();
    let requested_module = Path::new(&request.plugin.module_origin);
    let module_origin = fs::canonicalize(requested_module)
        .context("installed Illustrator bridge module is unavailable")?;
    if !same_path(&module_origin, &plugin_root.join("dist").join("main.js")) {
        return Err(anyhow!(
            "installed Illustrator bridge module identity is invalid"
        ));
    }
    let (manifest, manifest_receipt) = capture_exact_file_bounded(
        &plugin_root.join("CSXS").join("manifest.xml"),
        request.plugin.manifest_bytes,
        &request.plugin.manifest_sha256,
        1024 * 1024,
        deadline,
    )?;
    let (index, index_receipt) = capture_exact_file_bounded(
        &plugin_root.join("index.html"),
        request.plugin.index_bytes,
        &request.plugin.index_sha256,
        1024 * 1024,
        deadline,
    )?;
    let (_, module_receipt) = capture_exact_file_bounded(
        requested_module,
        request.plugin.module_bytes,
        &request.plugin.module_sha256,
        256 * 1024 * 1024,
        deadline,
    )?;
    if manifest != include_bytes!("../../../bridges/cep/illustrator/CSXS/manifest.xml")
        || index != include_bytes!("../../../bridges/cep/illustrator/index.html")
    {
        return Err(anyhow!("Illustrator bridge manifest identity is invalid"));
    }
    Ok(IllustratorPluginReceipt {
        root,
        manifest: manifest_receipt,
        index: index_receipt,
        module: module_receipt,
    })
}

fn recapture_illustrator_receipt(expected: &IllustratorPluginReceipt) -> anyhow::Result<()> {
    recapture_illustrator_receipt_bounded(expected, None)
}

fn recapture_illustrator_receipt_bounded(
    expected: &IllustratorPluginReceipt,
    deadline: Option<&BlockingDeadline>,
) -> anyhow::Result<()> {
    let root = capture_path_receipt_bounded(&expected.root.requested, true, deadline)?;
    let (_, manifest) = capture_exact_file_bounded(
        &expected.manifest.path.requested,
        expected.manifest.bytes,
        &expected.manifest.sha256,
        1024 * 1024,
        deadline,
    )?;
    let (_, index) = capture_exact_file_bounded(
        &expected.index.path.requested,
        expected.index.bytes,
        &expected.index.sha256,
        1024 * 1024,
        deadline,
    )?;
    let (_, module) = capture_exact_file_bounded(
        &expected.module.path.requested,
        expected.module.bytes,
        &expected.module.sha256,
        256 * 1024 * 1024,
        deadline,
    )?;
    if root != expected.root
        || manifest != expected.manifest
        || index != expected.index
        || module != expected.module
    {
        return Err(anyhow!(
            "Illustrator bridge identity changed after attestation"
        ));
    }
    Ok(())
}

fn capture_exact_file_bounded(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    maximum: u64,
    deadline: Option<&BlockingDeadline>,
) -> anyhow::Result<(Vec<u8>, IllustratorFileReceipt)> {
    let before = capture_path_receipt_bounded(path, false, deadline)?;
    let bytes =
        validate_exact_file_bounded(path, expected_bytes, expected_sha256, maximum, deadline)?;
    let after = capture_path_receipt_bounded(path, false, deadline)?;
    if before != after {
        return Err(anyhow!("file identity changed during attestation"));
    }
    Ok((
        bytes,
        IllustratorFileReceipt {
            path: after,
            bytes: expected_bytes,
            sha256: expected_sha256.to_owned(),
        },
    ))
}

fn capture_path_receipt_bounded(
    path: &Path,
    expect_directory: bool,
    deadline: Option<&BlockingDeadline>,
) -> std::io::Result<PathReceipt> {
    deadline_checkpoint(deadline)?;
    ensure_no_redirects(path)?;
    let canonical = fs::canonicalize(path)?;
    ensure_no_redirects(&canonical)?;
    let metadata = fs::metadata(path)?;
    if metadata.is_dir() != expect_directory || (!expect_directory && !metadata.is_file()) {
        return Err(std::io::Error::other("filesystem object type is invalid"));
    }
    if !expect_directory && filesystem_link_count(path, &metadata) != Some(1) {
        return Err(std::io::Error::other(
            "multi-link filesystem objects are not accepted",
        ));
    }
    let filesystem_identity = filesystem_identity(path, &metadata)
        .ok_or_else(|| std::io::Error::other("filesystem identity is unavailable"))?;
    deadline_checkpoint(deadline)?;
    Ok(PathReceipt {
        requested: path.to_path_buf(),
        canonical,
        filesystem_identity,
    })
}

fn deadline_checkpoint(deadline: Option<&BlockingDeadline>) -> std::io::Result<()> {
    deadline
        .map(BlockingDeadline::checkpoint)
        .transpose()
        .map(|_| ())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "operation timed out"))
}

#[cfg(windows)]
fn filesystem_identity(path: &Path, _metadata: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    handle_filesystem_identity(&file, &metadata)
}

#[cfg(windows)]
fn handle_filesystem_identity(file: &fs::File, _metadata: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;

    let information = windows_file_information(file.as_raw_handle())?;
    Some((
        u64::from(information.volume_serial_number),
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low),
    ))
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileTime {
    low: u32,
    high: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileInformation {
    file_attributes: u32,
    creation_time: WindowsFileTime,
    last_access_time: WindowsFileTime,
    last_write_time: WindowsFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
fn windows_file_information(
    handle: std::os::windows::io::RawHandle,
) -> Option<WindowsFileInformation> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information: *mut std::ffi::c_void,
        ) -> i32;
    }

    let mut information = std::mem::MaybeUninit::<WindowsFileInformation>::uninit();
    if unsafe {
        GetFileInformationByHandle(handle, information.as_mut_ptr().cast::<std::ffi::c_void>())
    } == 0
    {
        return None;
    }
    Some(unsafe { information.assume_init() })
}

#[cfg(windows)]
fn filesystem_link_count(path: &Path, _metadata: &fs::Metadata) -> Option<u64> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    windows_file_information(file.as_raw_handle())
        .map(|information| u64::from(information.number_of_links))
}

#[cfg(unix)]
fn filesystem_identity(_path: &Path, metadata: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(unix)]
fn handle_filesystem_identity(_file: &fs::File, metadata: &fs::Metadata) -> Option<(u64, u64)> {
    filesystem_identity(Path::new(""), metadata)
}

#[cfg(unix)]
fn filesystem_link_count(_path: &Path, metadata: &fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.nlink())
}

#[cfg(not(any(windows, unix)))]
fn filesystem_identity(_path: &Path, _metadata: &fs::Metadata) -> Option<(u64, u64)> {
    None
}

#[cfg(not(any(windows, unix)))]
fn handle_filesystem_identity(_file: &fs::File, _metadata: &fs::Metadata) -> Option<(u64, u64)> {
    None
}

#[cfg(not(any(windows, unix)))]
fn filesystem_link_count(_path: &Path, _metadata: &fs::Metadata) -> Option<u64> {
    None
}

fn validate_illustrator_host_file(target: &PhotoshopHostTarget) -> anyhow::Result<()> {
    let requested_path = Path::new(&target.executable_path);
    ensure_no_redirects(requested_path)?;
    let path = fs::canonicalize(requested_path)
        .context("selected Illustrator executable is unavailable")?;
    if !is_illustrator_product_path(&path)
        || validate_exact_file(
            &path,
            target.executable_bytes,
            &target.executable_sha256,
            MAX_HASH_BYTES,
        )
        .is_err()
    {
        return Err(anyhow!(
            "selected Illustrator executable identity is invalid"
        ));
    }
    Ok(())
}

fn validate_illustrator_host_file_bounded(
    target: &PhotoshopHostTarget,
    deadline: &BlockingDeadline,
) -> anyhow::Result<()> {
    deadline.checkpoint()?;
    let requested_path = Path::new(&target.executable_path);
    ensure_no_redirects(requested_path)?;
    let path = fs::canonicalize(requested_path)
        .context("selected Illustrator executable is unavailable")?;
    if !is_illustrator_product_path(&path)
        || validate_exact_file_bounded(
            &path,
            target.executable_bytes,
            &target.executable_sha256,
            MAX_HASH_BYTES,
            Some(deadline),
        )
        .is_err()
    {
        return Err(anyhow!(
            "selected Illustrator executable identity is invalid"
        ));
    }
    deadline.checkpoint()
}

fn is_illustrator_product_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let components = path
            .ancestors()
            .filter_map(|value| value.file_name().and_then(|name| name.to_str()))
            .take(5)
            .collect::<Vec<_>>();
        components.len() == 5
            && components[0].eq_ignore_ascii_case("Illustrator.exe")
            && components[1].eq_ignore_ascii_case("Windows")
            && components[2].eq_ignore_ascii_case("Contents")
            && components[3].eq_ignore_ascii_case("Support Files")
            && is_illustrator_install_dir(components[4])
    }
    #[cfg(target_os = "macos")]
    {
        let components = path
            .ancestors()
            .filter_map(|value| value.file_name().and_then(|name| name.to_str()))
            .take(5)
            .collect::<Vec<_>>();
        components.len() == 5
            && components[0] == "Adobe Illustrator"
            && components[1] == "MacOS"
            && components[2] == "Contents"
            && components[3] == "Adobe Illustrator.app"
            && is_illustrator_install_dir(components[4])
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = path;
        false
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn is_illustrator_install_dir(value: &str) -> bool {
    let Some(year) = value
        .to_ascii_lowercase()
        .strip_prefix("adobe illustrator ")
        .map(str::to_owned)
    else {
        return false;
    };
    year.len() == 4 && year.starts_with("20") && year.bytes().all(|byte| byte.is_ascii_digit())
}

fn attest_request(request: &PhotoshopBootstrapRequest) -> anyhow::Result<String> {
    validate_host_file(&request.host)?;
    let requested_root = Path::new(&request.plugin.installed_plugin_root);
    ensure_no_redirects(requested_root)?;
    let plugin_root =
        fs::canonicalize(requested_root).context("installed Photoshop bridge is unavailable")?;
    let requested_module = Path::new(&request.plugin.module_origin);
    ensure_no_redirects(requested_module)?;
    let module_origin = fs::canonicalize(requested_module)
        .context("installed Photoshop bridge module is unavailable")?;
    let expected_module = plugin_root.join("dist").join("main.js");
    if !same_path(&module_origin, &expected_module) {
        return Err(anyhow!(
            "installed Photoshop bridge module identity is invalid"
        ));
    }
    let manifest = validate_exact_file(
        &plugin_root.join("manifest.json"),
        request.plugin.manifest_bytes,
        &request.plugin.manifest_sha256,
        1024 * 1024,
    )?;
    validate_exact_file(
        &plugin_root.join("index.html"),
        request.plugin.index_bytes,
        &request.plugin.index_sha256,
        1024 * 1024,
    )?;
    validate_exact_file(
        &module_origin,
        request.plugin.module_bytes,
        &request.plugin.module_sha256,
        256 * 1024 * 1024,
    )?;
    validate_fixed_manifest(&manifest, &request.plugin.bridge_version)?;
    Ok(request.plugin.module_sha256.clone())
}

fn validate_host_file(target: &PhotoshopHostTarget) -> anyhow::Result<()> {
    let requested_path = Path::new(&target.executable_path);
    ensure_no_redirects(requested_path)?;
    let path =
        fs::canonicalize(requested_path).context("selected Photoshop executable is unavailable")?;
    if !is_photoshop_product_path(&path)
        || validate_exact_file(
            &path,
            target.executable_bytes,
            &target.executable_sha256,
            MAX_HASH_BYTES,
        )
        .is_err()
    {
        return Err(anyhow!("selected Photoshop executable identity is invalid"));
    }
    Ok(())
}

fn is_photoshop_product_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let file = path.file_name().and_then(|value| value.to_str());
        let parent = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str());
        file.is_some_and(|value| value.eq_ignore_ascii_case("Photoshop.exe"))
            && parent.is_some_and(|value| value.starts_with("Adobe Photoshop "))
    }
    #[cfg(target_os = "macos")]
    {
        let normalized = path.to_string_lossy();
        return path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("Adobe Photoshop "))
            && normalized.contains(".app/Contents/MacOS/");
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = path;
        false
    }
}

fn validate_fixed_manifest(raw: &[u8], expected_version: &str) -> anyhow::Result<()> {
    if raw.len() > 64 * 1024 {
        return Err(anyhow!("Photoshop bridge manifest is unbounded"));
    }
    let value: serde_json::Value = serde_json::from_slice(raw)?;
    if value
        .get("manifestVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(5)
        || value.get("id").and_then(serde_json::Value::as_str)
            != Some("com.adobepy.bridge.photoshop")
        || value.get("version").and_then(serde_json::Value::as_str) != Some(expected_version)
        || value
            .pointer("/host/app")
            .and_then(serde_json::Value::as_str)
            != Some("PS")
        || value
            .pointer("/host/data/loadEvent")
            .and_then(serde_json::Value::as_str)
            != Some("startup")
        || value.get("main").and_then(serde_json::Value::as_str) != Some("index.html")
    {
        return Err(anyhow!("Photoshop bridge manifest identity is invalid"));
    }
    Ok(())
}

fn bootstrap_config(
    websocket_url: &str,
    token: &str,
    target: &str,
    nonce: Option<&str>,
) -> anyhow::Result<String> {
    let url = serde_json::to_string(websocket_url)?;
    let token = serde_json::to_string(token)?;
    let target = serde_json::to_string(target)?;
    let nonce_assignment = match nonce {
        Some(value) => format!(
            "globalThis.__ADOBEPY_BOOTSTRAP_NONCE={};",
            serde_json::to_string(value)?
        ),
        None => "delete globalThis.__ADOBEPY_BOOTSTRAP_NONCE;".to_owned(),
    };
    Ok(format!(
        "(function(){{globalThis.__ADOBEPY_BROKER_URL={url};globalThis.__ADOBEPY_TOKEN={token};globalThis.__ADOBEPY_TARGET={target};{nonce_assignment}}}());\n"
    ))
}

fn illustrator_bootstrap_config(
    websocket_url: &str,
    token: &str,
    target: &str,
    profile_id: &str,
    nonce: Option<&str>,
) -> anyhow::Result<String> {
    let url = serde_json::to_string(websocket_url)?;
    let token = serde_json::to_string(token)?;
    let target = serde_json::to_string(target)?;
    let profile_id = serde_json::to_string(profile_id)?;
    let nonce_assignment = match nonce {
        Some(value) => format!(
            "globalThis.__ADOBEPY_BOOTSTRAP_NONCE={};",
            serde_json::to_string(value)?
        ),
        None => "delete globalThis.__ADOBEPY_BOOTSTRAP_NONCE;".to_owned(),
    };
    Ok(format!(
        "(function(){{globalThis.__ADOBEPY_BROKER_URL={url};globalThis.__ADOBEPY_TOKEN={token};globalThis.__ADOBEPY_TARGET={target};globalThis.__ADOBEPY_HOST_IDENTITY={{profileId:{profile_id}}};{nonce_assignment}}}());\n"
    ))
}
fn validate_exact_file(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    maximum: u64,
) -> anyhow::Result<Vec<u8>> {
    validate_exact_file_bounded(path, expected_bytes, expected_sha256, maximum, None)
}

fn validate_exact_file_bounded(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    maximum: u64,
    deadline: Option<&BlockingDeadline>,
) -> anyhow::Result<Vec<u8>> {
    if expected_bytes == 0 || expected_bytes > maximum || !is_sha256(expected_sha256) {
        return Err(anyhow!("file identity is invalid"));
    }
    let bytes = stable_file_bytes_bounded(path, maximum, deadline)?;
    if u64::try_from(bytes.len())? != expected_bytes
        || format!("{:x}", Sha256::digest(&bytes)) != expected_sha256
    {
        return Err(anyhow!("file identity does not match"));
    }
    Ok(bytes)
}

fn stable_file_bytes(path: &Path, maximum: u64) -> std::io::Result<Vec<u8>> {
    stable_file_bytes_bounded(path, maximum, None)
}

fn stable_file_bytes_bounded(
    path: &Path,
    maximum: u64,
    deadline: Option<&BlockingDeadline>,
) -> std::io::Result<Vec<u8>> {
    deadline_checkpoint(deadline)?;
    ensure_no_redirects(path)?;
    let mut file = fs::File::open(path)?;
    let before = file.metadata()?;
    let handle_identity = handle_filesystem_identity(&file, &before)
        .ok_or_else(|| std::io::Error::other("file handle identity is unavailable"))?;
    if !before.is_file() || before.len() == 0 || before.len() > maximum {
        return Err(std::io::Error::other("file is empty or unbounded"));
    }
    let capacity =
        usize::try_from(before.len()).map_err(|_| std::io::Error::other("file is too large"))?;
    let mut bytes = Vec::with_capacity(capacity);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        deadline_checkpoint(deadline)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > capacity {
            return Err(std::io::Error::other("file grew during attestation"));
        }
    }
    let handle_after = file.metadata()?;
    ensure_no_redirects(path)?;
    let path_after = fs::symlink_metadata(path)?;
    let path_after_handle = fs::File::open(path)?;
    let handle_identity_after = handle_filesystem_identity(&file, &handle_after)
        .ok_or_else(|| std::io::Error::other("file handle identity is unavailable"))?;
    let path_identity_after = filesystem_identity(path, &path_after)
        .ok_or_else(|| std::io::Error::other("file path identity is unavailable"))?;
    if before.len() != handle_after.len()
        || before.modified()? != handle_after.modified()?
        || before.len() != path_after.len()
        || before.modified()? != path_after.modified()?
        || path_after.file_type().is_symlink()
        || is_windows_reparse(&path_after)
        || !same_file_identity(&file, &path_after_handle)
            .map_err(|_| std::io::Error::other("file identity is unavailable"))?
        || handle_identity != handle_identity_after
        || handle_identity != path_identity_after
        || bytes.len() != capacity
    {
        return Err(std::io::Error::other("file changed during attestation"));
    }
    deadline_checkpoint(deadline)?;
    Ok(bytes)
}

fn ensure_no_redirects(path: &Path) -> std::io::Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(
            component,
            std::path::Component::Prefix(_) | std::path::Component::RootDir
        ) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)?;
        if metadata.file_type().is_symlink() || is_windows_reparse(&metadata) {
            return Err(std::io::Error::other(
                "redirected path identity is not allowed",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_windows_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_windows_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn digest_file(path: &Path) -> anyhow::Result<String> {
    let bytes = stable_file_bytes(path, MAX_HASH_BYTES)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = fs::canonicalize(left).ok();
    let right = fs::canonicalize(right).ok();
    match (left, right) {
        (Some(left), Some(right)) if cfg!(windows) => left
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy()),
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

#[cfg(windows)]
fn observe_process(pid: u32) -> anyhow::Result<ObservedHostProcess> {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn QueryFullProcessImageNameW(
            process: isize,
            flags: u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn GetProcessTimes(
            process: isize,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let result = (|| {
        let mut path = vec![0_u16; 32_768];
        let mut path_len = u32::try_from(path.len())?;
        if unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut path_len) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let creation_ticks = (u64::from(creation.high) << 32) | u64::from(creation.low);
        Ok(ObservedHostProcess {
            pid,
            process_start_identity: format!("windows:{creation_ticks}"),
            executable_path: String::from_utf16(&path[..usize::try_from(path_len)?])?,
        })
    })();
    unsafe {
        CloseHandle(handle);
    }
    result
}

#[cfg(target_os = "macos")]
fn observe_process(pid: u32) -> anyhow::Result<ObservedHostProcess> {
    #[repr(C)]
    struct ProcBsdInfo {
        flags: u32,
        status: u32,
        xstatus: u32,
        pid: u32,
        ppid: u32,
        uid: u32,
        gid: u32,
        ruid: u32,
        rgid: u32,
        svuid: u32,
        svgid: u32,
        reserved: u32,
        command: [u8; 16],
        name: [u8; 32],
        nfiles: u32,
        pgid: u32,
        pjobc: u32,
        controlling_tty: u32,
        foreground_pgid: u32,
        nice: i32,
        start_seconds: u64,
        start_microseconds: u64,
    }
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            size: i32,
        ) -> i32;
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
    }
    const PROC_PIDTBSDINFO: i32 = 3;
    let mut info: ProcBsdInfo = unsafe { std::mem::zeroed() };
    let size = i32::try_from(std::mem::size_of::<ProcBsdInfo>())?;
    let read = unsafe {
        proc_pidinfo(
            i32::try_from(pid)?,
            PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut ProcBsdInfo).cast(),
            size,
        )
    };
    let mut path = vec![0_u8; 4096];
    let path_len = unsafe {
        proc_pidpath(
            i32::try_from(pid)?,
            path.as_mut_ptr().cast(),
            u32::try_from(path.len())?,
        )
    };
    if read != size || info.start_seconds == 0 || path_len <= 0 {
        return Err(anyhow!("Photoshop process identity is unavailable"));
    }
    path.truncate(usize::try_from(path_len)?);
    Ok(ObservedHostProcess {
        pid,
        process_start_identity: format!(
            "macos:{}:{:06}",
            info.start_seconds, info.start_microseconds
        ),
        executable_path: String::from_utf8(path)?,
    })
}

#[cfg(not(any(windows, target_os = "macos")))]
fn observe_process(_pid: u32) -> anyhow::Result<ObservedHostProcess> {
    Err(anyhow!(
        "Photoshop bootstrap is supported only on Windows and macOS"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(windows, unix))]
    #[test]
    fn illustrator_file_receipts_reject_multi_link_objects() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "illustrator-multi-link-{}",
                Uuid::new_v4().simple()
            ));
        fs::create_dir_all(&root).unwrap();
        for name in ["manifest.xml", "index.html", "main.js"] {
            let path = root.join(name);
            let alias = root.join(format!("{name}.alias"));
            fs::write(&path, b"receipted CEP payload").unwrap();
            fs::hard_link(&path, &alias).unwrap();
            assert!(
                capture_path_receipt_bounded(&path, false, None).is_err(),
                "multi-link {name} must fail closed"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn illustrator_attestation_accepts_only_the_fixed_receipted_cep_tree() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("illustrator-bootstrap-{}", Uuid::new_v4().simple()));
        let host = root
            .join("Adobe Illustrator 2026")
            .join("Support Files")
            .join("Contents")
            .join("Windows")
            .join("Illustrator.exe");
        let plugin = root.join("com.adobepy.bridge.illustrator");
        fs::create_dir_all(host.parent().unwrap()).unwrap();
        fs::create_dir_all(plugin.join("CSXS")).unwrap();
        fs::create_dir_all(plugin.join("dist")).unwrap();
        let executable = b"FAKE SIGNED ILLUSTRATOR FIXTURE";
        let manifest = include_bytes!("../../../bridges/cep/illustrator/CSXS/manifest.xml");
        let index = include_bytes!("../../../bridges/cep/illustrator/index.html");
        let module = b"BOUNDED FAKE CEP MODULE";
        fs::write(&host, executable).unwrap();
        fs::write(plugin.join("CSXS").join("manifest.xml"), manifest).unwrap();
        fs::write(plugin.join("index.html"), index).unwrap();
        fs::write(plugin.join("dist").join("main.js"), module).unwrap();
        let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
        let mut request = PhotoshopBootstrapRequest {
            bootstrap_version: 1,
            target: "illustration".into(),
            timeout_ms: 1_000,
            host: PhotoshopHostTarget {
                executable_path: host.to_string_lossy().into_owned(),
                executable_bytes: executable.len() as u64,
                executable_sha256: hash(executable),
                host_version: "30.0.0".into(),
                profile_id: "illustrator-production".into(),
            },
            plugin: adobepy_protocol::PhotoshopPluginTarget {
                installed_plugin_root: plugin.to_string_lossy().into_owned(),
                module_origin: plugin
                    .join("dist")
                    .join("main.js")
                    .to_string_lossy()
                    .into_owned(),
                bridge_version: "0.1.0".into(),
                manifest_bytes: manifest.len() as u64,
                manifest_sha256: hash(manifest),
                index_bytes: index.len() as u64,
                index_sha256: hash(index),
                module_bytes: module.len() as u64,
                module_sha256: hash(module),
            },
        };
        let backend = SystemIllustratorBootstrapBackend::default();
        assert_eq!(backend.attest(&request).unwrap(), hash(module));
        for (path, alias_name) in [
            (plugin.join("CSXS").join("manifest.xml"), "manifest.alias"),
            (plugin.join("index.html"), "index.alias"),
            (plugin.join("dist").join("main.js"), "module.alias"),
        ] {
            let alias = root.join(alias_name);
            fs::hard_link(&path, &alias).unwrap();
            assert!(
                backend.attest(&request).is_err(),
                "multi-link CEP objects must fail closed"
            );
            fs::remove_file(alias).unwrap();
        }
        assert!(!plugin.join(CONFIG_NAME).exists());
        let shadow_host = root
            .join("Adobe Illustrator Shadow")
            .join("Support Files")
            .join("Contents")
            .join("Windows")
            .join("Illustrator.exe");
        fs::create_dir_all(shadow_host.parent().unwrap()).unwrap();
        fs::write(&shadow_host, executable).unwrap();
        let mut shadow_request = request.clone();
        shadow_request.host.executable_path = shadow_host.to_string_lossy().into_owned();
        assert!(backend.attest(&shadow_request).is_err());
        assert!(!plugin.join(CONFIG_NAME).exists());
        let prepared = backend
            .prepare(
                &request,
                &"1".repeat(64),
                "PRIVATE_TEST_TOKEN",
                "ws://127.0.0.1:47391/v1/bridge/illustrator/ws",
            )
            .unwrap();
        let transaction = backend.begin_transaction(prepared).unwrap();
        transaction.activate().unwrap();
        let transient = fs::read_to_string(plugin.join(CONFIG_NAME)).unwrap();
        assert!(transient.contains("illustrator-production"));
        assert!(transient.contains(&"1".repeat(64)));
        transaction.rollback().unwrap();
        assert!(!plugin.join(CONFIG_NAME).exists());

        let prepared = backend
            .prepare(
                &request,
                &"1".repeat(64),
                "PRIVATE_TEST_TOKEN",
                "ws://127.0.0.1:47391/v1/bridge/illustrator/ws",
            )
            .unwrap();
        let transaction = backend.begin_transaction(prepared).unwrap();
        let replaced_module = b"REPLACED FAKE CEP MODUL";
        assert_eq!(replaced_module.len(), module.len());
        fs::write(plugin.join("dist").join("main.js"), replaced_module).unwrap();
        assert!(
            transaction
                .validate_prepared_identity_bounded(&BlockingDeadline::new(Duration::from_secs(1)))
                .is_err(),
            "a module replaced after prepare must fail before nonce consumption"
        );
        transaction.rollback().unwrap();
        fs::write(plugin.join("dist").join("main.js"), module).unwrap();

        let prepared = backend
            .prepare(
                &request,
                &"1".repeat(64),
                "PRIVATE_TEST_TOKEN",
                "ws://127.0.0.1:47391/v1/bridge/illustrator/ws",
            )
            .unwrap();
        let transaction = backend.begin_transaction(prepared).unwrap();
        let replacement = plugin.join("dist").join("main.replacement.js");
        fs::write(&replacement, module).unwrap();
        fs::remove_file(plugin.join("dist").join("main.js")).unwrap();
        fs::rename(&replacement, plugin.join("dist").join("main.js")).unwrap();
        assert!(
            transaction
                .validate_prepared_identity_bounded(&BlockingDeadline::new(Duration::from_secs(1)))
                .is_err(),
            "same bytes at a different filesystem identity must fail closed"
        );
        transaction.rollback().unwrap();

        let prepared = backend
            .prepare(
                &request,
                &"1".repeat(64),
                "PRIVATE_TEST_TOKEN",
                "ws://127.0.0.1:47391/v1/bridge/illustrator/ws",
            )
            .unwrap();
        let transaction = backend.begin_transaction(prepared).unwrap();
        transaction.activate().unwrap();
        transaction.finalize_pending().unwrap();
        let replacement = plugin.join("dist").join("main.post-finalize.js");
        fs::write(&replacement, module).unwrap();
        fs::remove_file(plugin.join("dist").join("main.js")).unwrap();
        fs::rename(&replacement, plugin.join("dist").join("main.js")).unwrap();
        assert!(
            transaction.clone().prepare_commit_confirmation().is_err(),
            "same module bytes at a new filesystem identity after finalize must fail closed"
        );
        transaction.rollback().unwrap();

        let prepared = backend
            .prepare(
                &request,
                &"1".repeat(64),
                "PRIVATE_TEST_TOKEN",
                "ws://127.0.0.1:47391/v1/bridge/illustrator/ws",
            )
            .unwrap();
        let transaction = backend.begin_transaction(prepared).unwrap();
        transaction.activate().unwrap();
        transaction.finalize_pending().unwrap();
        let confirmation = transaction.clone().prepare_commit_confirmation().unwrap();
        let replacement = plugin.join("dist").join("main.pre-publication.js");
        fs::write(&replacement, module).unwrap();
        fs::remove_file(plugin.join("dist").join("main.js")).unwrap();
        fs::rename(&replacement, plugin.join("dist").join("main.js")).unwrap();
        assert!(
            confirmation.confirm().is_err(),
            "same module bytes at a new filesystem identity before publication must fail closed"
        );
        transaction.rollback().unwrap();

        let prepared = backend
            .prepare(
                &request,
                &"1".repeat(64),
                "PRIVATE_TEST_TOKEN",
                "ws://127.0.0.1:47391/v1/bridge/illustrator/ws",
            )
            .unwrap();
        let transaction = backend.begin_transaction(prepared).unwrap();
        transaction.activate().unwrap();
        transaction.finalize_pending().unwrap();
        let confirmation = transaction.clone().prepare_commit_confirmation().unwrap();
        let publication = confirmation.confirm().unwrap();
        let replacement = plugin.join("dist").join("main.at-publication.js");
        fs::write(&replacement, module).unwrap();
        fs::remove_file(plugin.join("dist").join("main.js")).unwrap();
        fs::rename(&replacement, plugin.join("dist").join("main.js")).unwrap();
        assert!(
            publication.publish().is_err(),
            "same module bytes at a new filesystem identity at publication must fail closed"
        );
        transaction.rollback().unwrap();
        assert!(
            !plugin.join(CONFIG_NAME).exists(),
            "failed publication must remain rollback-capable"
        );

        let prepared = backend
            .prepare(
                &request,
                &"1".repeat(64),
                "PRIVATE_TEST_TOKEN",
                "ws://127.0.0.1:47391/v1/bridge/illustrator/ws",
            )
            .unwrap();
        let transaction = backend.begin_transaction(prepared).unwrap();
        transaction.activate().unwrap();
        transaction.finalize_pending().unwrap();
        let confirmation = transaction.clone().prepare_commit_confirmation().unwrap();
        let publication = confirmation.confirm().unwrap();
        publication.publish().unwrap();
        let committed = fs::read_to_string(plugin.join(CONFIG_NAME)).unwrap();
        assert!(committed.contains("illustrator-production"));
        assert!(!committed.contains(&"1".repeat(64)));

        let foreign_manifest =
            b"<ExtensionManifest><ScriptPath>foreign.jsx</ScriptPath></ExtensionManifest>";
        fs::write(plugin.join("CSXS").join("manifest.xml"), foreign_manifest).unwrap();
        request.plugin.manifest_bytes = foreign_manifest.len() as u64;
        request.plugin.manifest_sha256 = hash(foreign_manifest);
        assert!(backend.attest(&request).is_err());
        assert_eq!(
            fs::read_to_string(plugin.join(CONFIG_NAME)).unwrap(),
            committed
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_config_replace_and_nonce_consumption_are_exact() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("photoshop-bootstrap-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&root).unwrap();
        let config = root.join(CONFIG_NAME);
        fs::write(&config, b"old-config").unwrap();

        let transient = bootstrap_config(
            "ws://127.0.0.1:47391/v1/bridge/photoshop/ws",
            "secret",
            "retouch",
            Some(&"a".repeat(64)),
        )
        .unwrap();
        let committed = bootstrap_config(
            "ws://127.0.0.1:47391/v1/bridge/photoshop/ws",
            "secret",
            "retouch",
            None,
        )
        .unwrap();
        assert!(transient.contains("__ADOBEPY_BOOTSTRAP_NONCE"));
        assert!(!committed.contains(&"a".repeat(64)));
        assert!(committed.contains("delete globalThis.__ADOBEPY_BOOTSTRAP_NONCE"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bootstrap_transaction_never_overwrites_a_foreign_config_change() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "photoshop-bootstrap-foreign-{}",
                Uuid::new_v4().simple()
            ));
        fs::create_dir_all(&root).unwrap();
        let config = root.join(CONFIG_NAME);
        fs::write(&config, b"prior-config").unwrap();
        let backend = SystemPhotoshopBootstrapBackend::default();
        let prepared = PreparedBootstrap {
            config_path: Some(config.clone()),
            previous_config: Some(b"prior-config".to_vec()),
            transient_config: Some(b"transient-config".to_vec()),
            committed_config: Some(b"committed-config".to_vec()),
            module_sha256: "a".repeat(64),
            illustrator_receipt: None,
        };
        let transaction = backend.begin_transaction(prepared).unwrap();
        transaction.activate().unwrap();

        fs::write(&config, b"operator-change").unwrap();
        assert!(transaction.finalize_pending().is_err());
        assert_eq!(fs::read(&config).unwrap(), b"operator-change");
        assert!(transaction.rollback().is_err());
        assert_eq!(fs::read(&config).unwrap(), b"operator-change");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_config_after_activation_is_not_recreated_by_rollback() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "photoshop-bootstrap-prepare-recovery-{}",
                Uuid::new_v4().simple()
            ));
        fs::create_dir_all(&root).unwrap();
        let config = root.join(CONFIG_NAME);
        fs::write(&config, b"prior-config").unwrap();
        let prepared = PreparedBootstrap {
            config_path: Some(config.clone()),
            previous_config: Some(b"prior-config".to_vec()),
            transient_config: Some(b"transient-config".to_vec()),
            committed_config: Some(b"committed-config".to_vec()),
            module_sha256: "a".repeat(64),
            illustrator_receipt: None,
        };
        let backend = SystemPhotoshopBootstrapBackend::default();
        let transaction = backend.begin_transaction(prepared).unwrap();
        transaction.activate().unwrap();
        fs::remove_file(&config).unwrap();

        assert!(transaction.rollback().is_err());
        assert!(!config.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn public_activation_rejects_a_swap_after_its_final_recapture() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "photoshop-bootstrap-public-swap-{}",
                Uuid::new_v4().simple()
            ));
        fs::create_dir_all(&root).unwrap();
        let config = root.join(CONFIG_NAME);
        fs::write(&config, b"prior-config").unwrap();
        let replacement = root.join("replacement.js");
        fs::write(&replacement, b"external-config").unwrap();
        let prepared = PreparedBootstrap {
            config_path: Some(config.clone()),
            previous_config: Some(b"prior-config".to_vec()),
            transient_config: Some(b"transient-config".to_vec()),
            committed_config: Some(b"committed-config".to_vec()),
            module_sha256: "a".repeat(64),
            illustrator_receipt: None,
        };
        let swap_path = config.clone();
        crate::bootstrap_transaction::set_before_activate_write(config.clone(), move || {
            fs::remove_file(&swap_path).unwrap();
            fs::rename(&replacement, &swap_path).unwrap();
        });

        let backend = SystemPhotoshopBootstrapBackend::default();
        let transaction = backend.begin_transaction(prepared).unwrap();
        assert!(transaction.activate().is_err());
        assert_eq!(fs::read(&config).unwrap(), b"external-config");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stuck_activation_io_does_not_hold_owner_or_block_transaction_rollback() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "photoshop-bootstrap-lock-free-recovery-{}",
                Uuid::new_v4().simple()
            ));
        fs::create_dir_all(&root).unwrap();
        let config = root.join(CONFIG_NAME);
        fs::write(&config, b"prior-config").unwrap();
        let prepared = PreparedBootstrap {
            config_path: Some(config.clone()),
            previous_config: Some(b"prior-config".to_vec()),
            transient_config: Some(b"transient-config".to_vec()),
            committed_config: Some(b"committed-config".to_vec()),
            module_sha256: "a".repeat(64),
            illustrator_receipt: None,
        };
        let backend = SystemPhotoshopBootstrapBackend::default();
        let transaction = backend.begin_transaction(prepared).unwrap();
        let owner = backend
            .config_owners
            .lock()
            .unwrap()
            .get(&config)
            .unwrap()
            .clone();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let (owner_unlocked_tx, owner_unlocked_rx) = std::sync::mpsc::channel();
        crate::bootstrap_transaction::set_before_activate_write(config.clone(), {
            let entered = entered.clone();
            let release = release.clone();
            move || {
                owner_unlocked_tx.send(owner.lock_available()).unwrap();
                entered.wait();
                release.wait();
            }
        });

        let activation = std::thread::spawn({
            let transaction = transaction.clone();
            move || transaction.activate()
        });
        entered.wait();
        let (rollback_tx, rollback_rx) = std::sync::mpsc::channel();
        let rollback = std::thread::spawn({
            let transaction = transaction.clone();
            move || rollback_tx.send(transaction.rollback()).unwrap()
        });
        let rollback_before_release = rollback_rx.recv_timeout(Duration::from_millis(100)).ok();
        release.wait();
        let activation_result = activation.join().unwrap();
        rollback.join().unwrap();

        assert!(
            owner_unlocked_rx.recv().unwrap(),
            "activation file I/O ran under ConfigOwnerState"
        );
        assert!(
            matches!(rollback_before_release, Some(Ok(()))),
            "stuck activation file I/O blocked the independent rollback lane"
        );
        assert!(activation_result.is_err());
        assert_eq!(fs::read(&config).unwrap(), b"prior-config");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "launched only by the owned-host integration regression"]
    fn owned_host_fixture() {
        std::thread::sleep(Duration::from_secs(10));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "launched only by the nested owned-host integration regression"]
    fn nested_owned_host_descendant_fixture() {
        std::thread::sleep(Duration::from_secs(10));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "launched only by the nested owned-host integration regression"]
    fn nested_owned_host_parent_fixture() {
        let mut descendant = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "photoshop_bootstrap::tests::nested_owned_host_descendant_fixture",
                "--nocapture",
            ])
            .spawn()
            .unwrap();
        let marker =
            std::env::temp_dir().join(format!("adobepy-owned-host-{}.ready", std::process::id()));
        fs::write(&marker, descendant.id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(10));
        let _ = descendant.kill();
        let _ = descendant.wait();
        let _ = fs::remove_file(marker);
    }

    #[cfg(windows)]
    fn terminate_test_process(pid: u32) {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
            fn TerminateProcess(process: isize, exit_code: u32) -> i32;
            fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
            fn CloseHandle(handle: isize) -> i32;
        }
        const PROCESS_TERMINATE: u32 = 0x0001;
        const SYNCHRONIZE: u32 = 0x0010_0000;
        let process = unsafe { OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid) };
        if process != 0 {
            unsafe {
                TerminateProcess(process, 1);
                WaitForSingleObject(process, 2000);
                CloseHandle(process);
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn public_system_launch_retains_and_reaps_the_original_process_owner() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("owned-public-host-{}", Uuid::new_v4().simple()))
            .join("Adobe Photoshop Test");
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("Photoshop.exe");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        let bytes = fs::metadata(&executable).unwrap().len();
        let sha256 = digest_file(&executable).unwrap();
        let backend = SystemPhotoshopBootstrapBackend::with_launch_arguments(vec![
            "--ignored".into(),
            "--exact".into(),
            "photoshop_bootstrap::tests::owned_host_fixture".into(),
            "--nocapture".into(),
        ]);
        let target = PhotoshopHostTarget {
            executable_path: executable.to_string_lossy().into_owned(),
            executable_bytes: bytes,
            executable_sha256: sha256,
            host_version: "test".into(),
            profile_id: "test".into(),
        };

        let launched = backend
            .launch_owned(&target, Arc::new(AtomicBool::new(false)))
            .unwrap();
        let observed = launched.observed.clone();
        assert!(backend.process_matches(&observed));
        launched
            .terminate_and_reap(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
        assert!(!backend.process_matches(&observed));
        assert!(
            backend
                .host_owner
                .quiesce(tokio::time::Instant::now() + Duration::from_secs(1))
                .await
        );

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn public_cancel_after_spawn_reaps_the_original_process_and_its_descendant() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("owned-public-cancel-{}", Uuid::new_v4().simple()))
            .join("Adobe Photoshop Test");
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("Photoshop.exe");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        let bytes = fs::metadata(&executable).unwrap().len();
        let sha256 = digest_file(&executable).unwrap();
        let backend = Arc::new(SystemPhotoshopBootstrapBackend::with_launch_arguments(
            vec![
                "--ignored".into(),
                "--exact".into(),
                "photoshop_bootstrap::tests::nested_owned_host_parent_fixture".into(),
                "--nocapture".into(),
            ],
        ));
        let target = PhotoshopHostTarget {
            executable_path: executable.to_string_lossy().into_owned(),
            executable_bytes: bytes,
            executable_sha256: sha256,
            host_version: "test".into(),
            profile_id: "test".into(),
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let hook_cancelled = cancelled.clone();
        let nested_pid = Arc::new(Mutex::new(None));
        let hook_nested_pid = nested_pid.clone();
        let nested_marker = Arc::new(Mutex::new(None));
        let hook_nested_marker = nested_marker.clone();
        crate::bootstrap_transaction::set_after_host_spawn(
            fs::canonicalize(&executable).unwrap(),
            move |parent_pid| {
                let marker =
                    std::env::temp_dir().join(format!("adobepy-owned-host-{parent_pid}.ready"));
                let deadline = Instant::now() + Duration::from_secs(3);
                while !marker.exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                let pid = fs::read_to_string(&marker)
                    .unwrap()
                    .trim()
                    .parse::<u32>()
                    .unwrap();
                *hook_nested_pid.lock().unwrap() = Some(pid);
                *hook_nested_marker.lock().unwrap() = Some(marker);
                hook_cancelled.store(true, Ordering::SeqCst);
            },
        );

        let launch_backend = backend.clone();
        let launch =
            tokio::task::spawn_blocking(move || launch_backend.launch_owned(&target, cancelled))
                .await
                .unwrap();
        let descendant_pid = nested_pid.lock().unwrap().unwrap();
        let quiesced = backend
            .host_owner
            .quiesce(tokio::time::Instant::now() + Duration::from_millis(500))
            .await;
        let descendant_was_alive = observe_process(descendant_pid).is_ok();
        if descendant_was_alive {
            terminate_test_process(descendant_pid);
        }
        if let Some(marker) = nested_marker.lock().unwrap().take() {
            let _ = fs::remove_file(marker);
        }
        let _ = fs::remove_dir_all(root.parent().unwrap());

        assert!(
            launch.is_err(),
            "cancellation did not reject the public launch"
        );
        assert!(quiesced, "post-spawn failure lost broker reap ownership");
        assert!(
            !descendant_was_alive,
            "a descendant escaped before Windows Job ownership was established"
        );
    }
}

use super::{is_windows_reparse, read_bounded_sync};
use anyhow::{anyhow, Context};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::HashMap;
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
#[cfg(test)]
use std::sync::LazyLock;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[cfg(test)]
type ActivateHook = Box<dyn FnOnce() + Send>;
#[cfg(test)]
static BEFORE_ACTIVATE_WRITE: LazyLock<Mutex<HashMap<PathBuf, ActivateHook>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(test)]
static AFTER_CONFIRMATION_PREFLIGHT: LazyLock<Mutex<HashMap<PathBuf, ActivateHook>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(test)]
static AFTER_RECEIPT_METADATA: LazyLock<Mutex<HashMap<PathBuf, ActivateHook>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
pub(crate) fn set_before_activate_write(path: PathBuf, intervene: impl FnOnce() + Send + 'static) {
    BEFORE_ACTIVATE_WRITE
        .lock()
        .unwrap()
        .insert(path, Box::new(intervene));
}

#[cfg(test)]
pub(crate) fn set_after_confirmation_preflight(
    path: PathBuf,
    intervene: impl FnOnce() + Send + 'static,
) {
    AFTER_CONFIRMATION_PREFLIGHT
        .lock()
        .unwrap()
        .insert(path, Box::new(intervene));
}

#[cfg(test)]
fn set_after_receipt_metadata(path: PathBuf, intervene: impl FnOnce() + Send + 'static) {
    AFTER_RECEIPT_METADATA
        .lock()
        .unwrap()
        .insert(path, Box::new(intervene));
}

const MAX_CONFIG_BYTES: u64 = 512 * 1024;
const CONFIG_PHASE_ACTIVE: u8 = 0;
const CONFIG_PHASE_PENDING_PUBLICATION: u8 = 1;
const CONFIG_PHASE_PUBLISHED: u8 = 2;
const CONFIG_PHASE_ROLLING_BACK: u8 = 3;
const CONFIG_PHASE_ACTIVATING: u8 = 4;
const CONFIG_PHASE_FINALIZING: u8 = 5;
const CONFIG_PHASE_CONFIRMING: u8 = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileReceipt {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
    sha256: Option<String>,
    identity: Option<FileIdentity>,
}

impl FileReceipt {
    pub fn capture(path: &Path) -> anyhow::Result<Self> {
        let path = absolute_lexical_path(path)?;
        ensure_no_redirects_to_parent(&path)?;
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    path,
                    bytes: None,
                    sha256: None,
                    identity: None,
                });
            }
            Err(error) => return Err(error.into()),
        };
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || is_windows_reparse(&metadata)
            || metadata.len() > MAX_CONFIG_BYTES
        {
            return Err(anyhow!(
                "configuration identity is not a bounded regular file"
            ));
        }
        #[cfg(test)]
        if let Some(hook) = AFTER_RECEIPT_METADATA.lock().unwrap().remove(&path) {
            hook();
        }
        let handle_identity = file_identity(&file)?;
        let path_handle = fs::File::open(&path)?;
        let path_identity = file_identity(&path_handle)?;
        if handle_identity != path_identity {
            return Err(anyhow!("configuration path changed before capture"));
        }
        let mut reader = file;
        let bytes = read_bounded_sync(&mut reader, MAX_CONFIG_BYTES)?;
        let handle_after = reader.metadata()?;
        ensure_no_redirects_to_parent(&path)?;
        let path_after = fs::symlink_metadata(&path)?;
        let path_after_handle = fs::File::open(&path)?;
        if file_identity(&reader)? != handle_identity
            || file_identity(&path_after_handle)? != handle_identity
            || !path_after.is_file()
            || path_after.file_type().is_symlink()
            || is_windows_reparse(&path_after)
            || handle_after.len() != u64::try_from(bytes.len())?
            || path_after.len() != u64::try_from(bytes.len())?
        {
            return Err(anyhow!("configuration changed during capture"));
        }
        Ok(Self {
            path,
            sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
            bytes: Some(bytes),
            identity: Some(handle_identity),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn sha256(&self) -> Option<&str> {
        self.sha256.as_deref()
    }

    pub fn bytes(&self) -> Option<&[u8]> {
        self.bytes.as_deref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileIdentity {
    primary: u64,
    secondary: u64,
}

#[cfg(unix)]
pub(super) fn file_identity(file: &fs::File) -> anyhow::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(FileIdentity {
        primary: metadata.dev(),
        secondary: metadata.ino(),
    })
}

#[cfg(windows)]
pub(super) fn file_identity(file: &fs::File) -> anyhow::Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct ByHandleFileInformation {
        attributes: u32,
        creation_time: FileTime,
        access_time: FileTime,
        write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }
    let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let information = unsafe { information.assume_init() };
    Ok(FileIdentity {
        primary: u64::from(information.volume_serial_number),
        secondary: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
    })
}

#[cfg(not(any(unix, windows)))]
pub(super) fn file_identity(file: &fs::File) -> anyhow::Result<FileIdentity> {
    let metadata = file.metadata()?;
    let modified = metadata.modified()?.duration_since(std::time::UNIX_EPOCH)?;
    Ok(FileIdentity {
        primary: metadata.len(),
        secondary: u64::try_from(modified.as_nanos()).unwrap_or(u64::MAX),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedArtifact {
    transaction: ConfigTransactionIdentity,
    staging_id: Uuid,
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

impl StagedArtifact {
    pub fn from_helper(response: super::HelperResponse) -> anyhow::Result<Self> {
        let super::HelperResponse::Staged {
            generation,
            transaction_id,
            staging_id,
            path,
            bytes,
            sha256,
        } = response
        else {
            return Err(anyhow!("helper response is not a staged artifact"));
        };
        let artifact = Self {
            transaction: ConfigTransactionIdentity {
                generation,
                transaction_id: Uuid::parse_str(&transaction_id)
                    .context("staged transaction identity is invalid")?,
            },
            staging_id: Uuid::parse_str(&staging_id)
                .context("staged artifact identity is invalid")?,
            path,
            bytes,
            sha256,
        };
        artifact.read_exact()?;
        Ok(artifact)
    }

    pub fn capture(transaction: ConfigTransactionIdentity, path: &Path) -> anyhow::Result<Self> {
        let receipt = FileReceipt::capture(path)?;
        let bytes = receipt
            .bytes
            .as_ref()
            .context("staged artifact is missing")?;
        Ok(Self {
            transaction,
            staging_id: Uuid::new_v4(),
            path: receipt.path,
            bytes: u64::try_from(bytes.len())?,
            sha256: receipt.sha256.context("staged artifact hash is missing")?,
        })
    }

    fn read_exact(&self) -> anyhow::Result<Vec<u8>> {
        let receipt = FileReceipt::capture(&self.path)?;
        let bytes = receipt.bytes.context("staged artifact is missing")?;
        if u64::try_from(bytes.len())? != self.bytes
            || receipt.sha256.as_deref() != Some(self.sha256.as_str())
        {
            return Err(anyhow!("staged artifact identity changed"));
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigTransactionIdentity {
    generation: u64,
    transaction_id: Uuid,
}

impl ConfigTransactionIdentity {
    pub fn generation(self) -> u64 {
        self.generation
    }

    pub(super) fn transaction_id(self) -> Uuid {
        self.transaction_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuiescenceAck {
    pub generation: u64,
}

/// Linear proof that the exact committed file was recaptured while rollback
/// ownership was still active. Dropping it leaves the lease rollback-capable.
#[derive(Debug)]
#[must_use = "a prepared commit confirmation must be consumed or rolled back"]
pub struct ConfigCommitConfirmation {
    transaction: ConfigTransactionIdentity,
    expected: FileReceipt,
}

/// Linear permission to publish a transaction whose exact committed identity
/// was recaptured at the confirmation instant. Publication is a non-blocking
/// compare-and-swap so callers never perform file I/O under async state locks.
#[derive(Debug)]
#[must_use = "a confirmed config transaction must be published or rolled back"]
pub struct ConfigPublicationPermit {
    transaction: ConfigTransactionIdentity,
    phase: Arc<AtomicU8>,
    valid: Arc<AtomicBool>,
}

impl ConfigPublicationPermit {
    pub fn publish(self) -> Result<QuiescenceAck, ConfigTransactionError> {
        self.phase
            .compare_exchange(
                CONFIG_PHASE_PENDING_PUBLICATION,
                CONFIG_PHASE_PUBLISHED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| ConfigTransactionError::Stale)?;
        self.valid.store(false, Ordering::SeqCst);
        Ok(QuiescenceAck {
            generation: self.transaction.generation,
        })
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigTransactionError {
    #[error("configuration transaction is stale")]
    Stale,
    #[error("configuration is owned by another transaction")]
    Busy,
    #[error("configuration identity changed")]
    IdentityChanged,
    #[error("configuration transaction I/O failed")]
    Io,
}

#[derive(Debug)]
struct ActiveConfigLease {
    generation: u64,
    transaction_id: Uuid,
    valid: Arc<AtomicBool>,
    phase: Arc<AtomicU8>,
    destination: PathBuf,
    expected: FileReceipt,
    attempted: Option<Vec<u8>>,
    written: Option<FileReceipt>,
}

#[derive(Debug, Default)]
struct ConfigOwnerState {
    active: Option<ActiveConfigLease>,
    pending_publication: Option<ActiveConfigLease>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigTransactionOwner {
    next_generation: Arc<AtomicU64>,
    state: Arc<Mutex<ConfigOwnerState>>,
}

impl ConfigTransactionOwner {
    #[cfg(test)]
    pub(crate) fn lock_available(&self) -> bool {
        self.state.try_lock().is_ok()
    }

    pub fn is_quiescent(&self) -> bool {
        self.state.lock().is_ok_and(|state| {
            lease_is_quiescent(state.active.as_ref())
                && lease_is_quiescent(state.pending_publication.as_ref())
        })
    }

    pub fn begin(
        &self,
        destination: &Path,
        expected: &FileReceipt,
    ) -> Result<ConfigLease, ConfigTransactionError> {
        let destination =
            absolute_lexical_path(destination).map_err(|_| ConfigTransactionError::Io)?;
        if destination != expected.path {
            return Err(ConfigTransactionError::IdentityChanged);
        }
        let previous_generation = self.next_generation.load(Ordering::SeqCst);
        let generation = previous_generation
            .checked_add(1)
            .ok_or(ConfigTransactionError::Io)?;
        let valid = Arc::new(AtomicBool::new(true));
        let phase = Arc::new(AtomicU8::new(CONFIG_PHASE_ACTIVE));
        let transaction_id = Uuid::new_v4();
        {
            let mut state = self.state.lock().map_err(|_| ConfigTransactionError::Io)?;
            if lease_is_busy(state.active.as_ref())
                || lease_is_busy(state.pending_publication.as_ref())
            {
                return Err(ConfigTransactionError::Busy);
            }
            state.active = None;
            state.pending_publication = None;
            state.active = Some(ActiveConfigLease {
                generation,
                transaction_id,
                valid: valid.clone(),
                phase: phase.clone(),
                destination: destination.clone(),
                expected: expected.clone(),
                attempted: None,
                written: None,
            });
        }
        let current = FileReceipt::capture(&destination).map_err(|_| ConfigTransactionError::Io)?;
        if &current != expected {
            let mut state = self.state.lock().map_err(|_| ConfigTransactionError::Io)?;
            if matches_lease(state.active.as_ref(), generation, transaction_id, &valid) {
                state.active = None;
            }
            valid.store(false, Ordering::SeqCst);
            return Err(ConfigTransactionError::IdentityChanged);
        }
        if self
            .next_generation
            .compare_exchange(
                previous_generation,
                generation,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            let mut state = self.state.lock().map_err(|_| ConfigTransactionError::Io)?;
            if matches_lease(state.active.as_ref(), generation, transaction_id, &valid) {
                state.active = None;
            }
            valid.store(false, Ordering::SeqCst);
            return Err(ConfigTransactionError::Io);
        }
        Ok(ConfigLease {
            owner: self.clone(),
            generation,
            transaction_id,
            valid,
            closed: AtomicBool::new(false),
        })
    }
}

#[derive(Debug)]
pub struct ConfigLease {
    owner: ConfigTransactionOwner,
    generation: u64,
    transaction_id: Uuid,
    valid: Arc<AtomicBool>,
    closed: AtomicBool,
}

impl ConfigLease {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn identity(&self) -> ConfigTransactionIdentity {
        ConfigTransactionIdentity {
            generation: self.generation,
            transaction_id: self.transaction_id,
        }
    }

    pub fn activate(&self, staged: &StagedArtifact) -> Result<FileReceipt, ConfigTransactionError> {
        self.activate_cancellable(staged, &AtomicBool::new(false))
    }

    pub fn activate_cancellable(
        &self,
        staged: &StagedArtifact,
        cancelled: &AtomicBool,
    ) -> Result<FileReceipt, ConfigTransactionError> {
        if staged.transaction != self.identity() || !self.valid.load(Ordering::SeqCst) {
            return Err(ConfigTransactionError::Stale);
        }
        let bytes = staged
            .read_exact()
            .map_err(|_| ConfigTransactionError::IdentityChanged)?;
        let (destination, expected) = {
            let mut state = self
                .owner
                .state
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            let active = matching_active(
                &mut state,
                self.generation,
                self.transaction_id,
                &self.valid,
            )?;
            active
                .phase
                .compare_exchange(
                    CONFIG_PHASE_ACTIVE,
                    CONFIG_PHASE_ACTIVATING,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .map_err(|_| ConfigTransactionError::Busy)?;
            active.attempted = Some(bytes.clone());
            (active.destination.clone(), active.expected.clone())
        };
        let current = FileReceipt::capture(&destination).map_err(|_| ConfigTransactionError::Io)?;
        if current != expected {
            return Err(ConfigTransactionError::IdentityChanged);
        }
        #[cfg(test)]
        {
            let mut hook = BEFORE_ACTIVATE_WRITE
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            if let Some(intervene) = hook.remove(&destination) {
                intervene();
            }
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(ConfigTransactionError::Stale);
        }
        let written = owned_config_write(&destination, &expected, &bytes)
            .map_err(|_| ConfigTransactionError::IdentityChanged)?;
        let mut state = self
            .owner
            .state
            .lock()
            .map_err(|_| ConfigTransactionError::Io)?;
        let active = matching_active(
            &mut state,
            self.generation,
            self.transaction_id,
            &self.valid,
        )?;
        if active.destination != destination
            || active.expected != expected
            || active.attempted.as_ref() != Some(&bytes)
            || active.phase.load(Ordering::SeqCst) != CONFIG_PHASE_ACTIVATING
        {
            return Err(ConfigTransactionError::Stale);
        }
        active.written = Some(written.clone());
        active.phase.store(CONFIG_PHASE_ACTIVE, Ordering::SeqCst);
        Ok(written)
    }

    pub fn finalize(&self, committed: &[u8]) -> Result<FileReceipt, ConfigTransactionError> {
        let receipt = self.prepare_commit_cancellable(committed, &AtomicBool::new(false))?;
        self.confirm_commit(&receipt)?;
        Ok(receipt)
    }

    pub fn prepare_commit_cancellable(
        &self,
        committed: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<FileReceipt, ConfigTransactionError> {
        if !self.valid.load(Ordering::SeqCst) {
            return Err(ConfigTransactionError::Stale);
        }
        let (destination, written) = {
            let mut state = self
                .owner
                .state
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            if state.pending_publication.is_some() {
                return Err(ConfigTransactionError::Busy);
            }
            let active = matching_active(
                &mut state,
                self.generation,
                self.transaction_id,
                &self.valid,
            )?;
            let written = active
                .written
                .as_ref()
                .ok_or(ConfigTransactionError::Stale)?;
            active
                .phase
                .compare_exchange(
                    CONFIG_PHASE_ACTIVE,
                    CONFIG_PHASE_FINALIZING,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .map_err(|_| ConfigTransactionError::Busy)?;
            active.attempted = Some(committed.to_vec());
            (active.destination.clone(), written.clone())
        };
        let current = FileReceipt::capture(&destination).map_err(|_| ConfigTransactionError::Io)?;
        if current != written {
            return Err(ConfigTransactionError::IdentityChanged);
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(ConfigTransactionError::Stale);
        }
        let receipt = owned_config_write(&destination, &written, committed)
            .map_err(|_| ConfigTransactionError::IdentityChanged)?;
        let mut state = self
            .owner
            .state
            .lock()
            .map_err(|_| ConfigTransactionError::Io)?;
        let active = matching_active(
            &mut state,
            self.generation,
            self.transaction_id,
            &self.valid,
        )?;
        if active.destination != destination
            || active.written.as_ref() != Some(&written)
            || active.attempted.as_deref() != Some(committed)
            || active.phase.load(Ordering::SeqCst) != CONFIG_PHASE_FINALIZING
        {
            return Err(ConfigTransactionError::Stale);
        }
        active.written = Some(receipt.clone());
        active.phase.store(CONFIG_PHASE_ACTIVE, Ordering::SeqCst);
        Ok(receipt)
    }

    pub fn confirm_commit(
        &self,
        expected: &FileReceipt,
    ) -> Result<QuiescenceAck, ConfigTransactionError> {
        let confirmation = self.prepare_commit_confirmation(expected)?;
        self.confirm_prevalidated(confirmation)?.publish()
    }

    pub fn prepare_commit_confirmation(
        &self,
        expected: &FileReceipt,
    ) -> Result<ConfigCommitConfirmation, ConfigTransactionError> {
        let mut state = self
            .owner
            .state
            .lock()
            .map_err(|_| ConfigTransactionError::Io)?;
        let active = matching_active(
            &mut state,
            self.generation,
            self.transaction_id,
            &self.valid,
        )?;
        if active.written.as_ref() != Some(expected)
            || active.phase.load(Ordering::SeqCst) != CONFIG_PHASE_ACTIVE
        {
            return Err(ConfigTransactionError::IdentityChanged);
        }
        #[cfg(test)]
        let destination = active.destination.clone();
        let confirmation = ConfigCommitConfirmation {
            transaction: self.identity(),
            expected: expected.clone(),
        };
        drop(state);
        #[cfg(test)]
        if let Some(intervene) = AFTER_CONFIRMATION_PREFLIGHT
            .lock()
            .map_err(|_| ConfigTransactionError::Io)?
            .remove(&destination)
        {
            intervene();
        }
        Ok(confirmation)
    }

    pub fn confirm_prevalidated(
        &self,
        confirmation: ConfigCommitConfirmation,
    ) -> Result<ConfigPublicationPermit, ConfigTransactionError> {
        if confirmation.transaction != self.identity() {
            return Err(ConfigTransactionError::Stale);
        }
        let (destination, phase) = {
            let mut state = self
                .owner
                .state
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            let active = matching_active(
                &mut state,
                self.generation,
                self.transaction_id,
                &self.valid,
            )?;
            if active.written.as_ref() != Some(&confirmation.expected) {
                return Err(ConfigTransactionError::IdentityChanged);
            }
            active
                .phase
                .compare_exchange(
                    CONFIG_PHASE_ACTIVE,
                    CONFIG_PHASE_CONFIRMING,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .map_err(|_| ConfigTransactionError::Stale)?;
            (active.destination.clone(), active.phase.clone())
        };
        let current = FileReceipt::capture(&destination)
            .map_err(|_| ConfigTransactionError::IdentityChanged)?;
        let mut state = self
            .owner
            .state
            .lock()
            .map_err(|_| ConfigTransactionError::Io)?;
        let active = matching_active(
            &mut state,
            self.generation,
            self.transaction_id,
            &self.valid,
        )?;
        if active.destination != destination
            || active.written.as_ref() != Some(&confirmation.expected)
            || current != confirmation.expected
        {
            return Err(ConfigTransactionError::IdentityChanged);
        }
        active
            .phase
            .compare_exchange(
                CONFIG_PHASE_CONFIRMING,
                CONFIG_PHASE_PENDING_PUBLICATION,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| ConfigTransactionError::Stale)?;
        {
            let pending = state.active.take().ok_or(ConfigTransactionError::Stale)?;
            state.pending_publication = Some(pending);
        }
        Ok(ConfigPublicationPermit {
            transaction: self.identity(),
            phase,
            valid: self.valid.clone(),
        })
    }

    pub fn rollback(&self) -> Result<QuiescenceAck, ConfigTransactionError> {
        let (pending, destination, expected, attempted, written) = {
            let mut state = self
                .owner
                .state
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            let pending = matches_lease(
                state.pending_publication.as_ref(),
                self.generation,
                self.transaction_id,
                &self.valid,
            );
            let active = if pending {
                state
                    .pending_publication
                    .as_mut()
                    .ok_or(ConfigTransactionError::Stale)?
            } else {
                matching_active(
                    &mut state,
                    self.generation,
                    self.transaction_id,
                    &self.valid,
                )?
            };
            let current_phase = active.phase.load(Ordering::SeqCst);
            if !matches!(
                current_phase,
                CONFIG_PHASE_ACTIVE
                    | CONFIG_PHASE_PENDING_PUBLICATION
                    | CONFIG_PHASE_ACTIVATING
                    | CONFIG_PHASE_FINALIZING
                    | CONFIG_PHASE_CONFIRMING
            ) {
                return Err(ConfigTransactionError::Stale);
            }
            active
                .phase
                .compare_exchange(
                    current_phase,
                    CONFIG_PHASE_ROLLING_BACK,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .map_err(|_| ConfigTransactionError::Stale)?;
            (
                pending,
                active.destination.clone(),
                active.expected.clone(),
                active.attempted.clone(),
                active.written.clone(),
            )
        };
        let current = FileReceipt::capture(&destination).map_err(|_| ConfigTransactionError::Io)?;
        if let Some(written) = written.as_ref() {
            if &current != written {
                return Err(ConfigTransactionError::IdentityChanged);
            }
            restore_expected(&destination, written, &expected)?;
        } else if let Some(attempted) = attempted.as_ref() {
            if current != expected {
                if current.path != destination
                    || current.identity != expected.identity
                    || current.bytes.as_deref() != Some(attempted)
                {
                    return Err(ConfigTransactionError::IdentityChanged);
                }
                restore_expected(&destination, &current, &expected)?;
            }
        }
        let acknowledgement = {
            let mut state = self
                .owner
                .state
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            let active = if pending {
                state
                    .pending_publication
                    .as_ref()
                    .ok_or(ConfigTransactionError::Stale)?
            } else {
                state.active.as_ref().ok_or(ConfigTransactionError::Stale)?
            };
            if active.generation != self.generation
                || active.transaction_id != self.transaction_id
                || !Arc::ptr_eq(&active.valid, &self.valid)
                || active.destination != destination
                || active.expected != expected
                || active.attempted != attempted
                || active.written != written
                || active.phase.load(Ordering::SeqCst) != CONFIG_PHASE_ROLLING_BACK
            {
                return Err(ConfigTransactionError::Stale);
            }
            if pending {
                state.pending_publication = None;
            } else {
                state.active = None;
            }
            QuiescenceAck {
                generation: self.generation,
            }
        };
        self.valid.store(false, Ordering::SeqCst);
        self.closed.store(true, Ordering::SeqCst);
        Ok(acknowledgement)
    }

    pub fn revoke(&self) -> Result<QuiescenceAck, ConfigTransactionError> {
        let mut state = self
            .owner
            .state
            .lock()
            .map_err(|_| ConfigTransactionError::Io)?;
        let active = matching_active(
            &mut state,
            self.generation,
            self.transaction_id,
            &self.valid,
        )?;
        if active.phase.load(Ordering::SeqCst) != CONFIG_PHASE_ACTIVE
            || active.written.is_some()
            || active.attempted.is_some()
        {
            return Err(ConfigTransactionError::Busy);
        }
        state.active = None;
        self.valid.store(false, Ordering::SeqCst);
        self.closed.store(true, Ordering::SeqCst);
        Ok(QuiescenceAck {
            generation: self.generation,
        })
    }
}

impl Drop for ConfigLease {
    fn drop(&mut self) {
        // Revocation is a single atomic store. Drop never performs file I/O,
        // waits for a worker, or tries to acquire the owner's mutex.
        if !self.closed.load(Ordering::SeqCst) {
            self.valid.store(false, Ordering::SeqCst);
        }
    }
}

fn matching_active<'a>(
    state: &'a mut ConfigOwnerState,
    generation: u64,
    transaction_id: Uuid,
    valid: &Arc<AtomicBool>,
) -> Result<&'a mut ActiveConfigLease, ConfigTransactionError> {
    if !valid.load(Ordering::SeqCst) {
        return Err(ConfigTransactionError::Stale);
    }
    state
        .active
        .as_mut()
        .filter(|active| {
            active.generation == generation
                && active.transaction_id == transaction_id
                && Arc::ptr_eq(&active.valid, valid)
                && active.valid.load(Ordering::SeqCst)
        })
        .ok_or(ConfigTransactionError::Stale)
}

fn matches_lease(
    lease: Option<&ActiveConfigLease>,
    generation: u64,
    transaction_id: Uuid,
    valid: &Arc<AtomicBool>,
) -> bool {
    valid.load(Ordering::SeqCst)
        && lease.is_some_and(|lease| {
            lease.generation == generation
                && lease.transaction_id == transaction_id
                && Arc::ptr_eq(&lease.valid, valid)
                && lease.valid.load(Ordering::SeqCst)
        })
}

fn lease_is_busy(lease: Option<&ActiveConfigLease>) -> bool {
    lease.is_some_and(|lease| {
        lease.phase.load(Ordering::SeqCst) != CONFIG_PHASE_PUBLISHED
            && (lease.valid.load(Ordering::SeqCst)
                || lease.attempted.is_some()
                || lease.written.is_some())
    })
}

fn lease_is_quiescent(lease: Option<&ActiveConfigLease>) -> bool {
    lease.is_none_or(|lease| {
        lease.phase.load(Ordering::SeqCst) == CONFIG_PHASE_PUBLISHED
            || (!lease.valid.load(Ordering::SeqCst)
                && lease.attempted.is_none()
                && lease.written.is_none())
    })
}

fn restore_expected(
    destination: &Path,
    written: &FileReceipt,
    expected: &FileReceipt,
) -> Result<(), ConfigTransactionError> {
    match expected.bytes.as_deref() {
        Some(bytes) => owned_config_write(destination, written, bytes)
            .map(|_| ())
            .map_err(|_| ConfigTransactionError::Io),
        None => remove_owned_config(destination, written).map_err(|_| ConfigTransactionError::Io),
    }
}

fn absolute_lexical_path(path: &Path) -> anyhow::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn ensure_no_redirects_to_parent(path: &Path) -> anyhow::Result<()> {
    let parent = path.parent().context("configuration path has no parent")?;
    let mut current = PathBuf::new();
    for component in parent.components() {
        current.push(component.as_os_str());
        if matches!(
            component,
            std::path::Component::Prefix(_) | std::path::Component::RootDir
        ) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || is_windows_reparse(&metadata)
        {
            return Err(anyhow!("configuration parent identity is redirected"));
        }
    }
    Ok(())
}

fn owned_config_write(
    path: &Path,
    expected: &FileReceipt,
    bytes: &[u8],
) -> anyhow::Result<FileReceipt> {
    if u64::try_from(bytes.len())? > MAX_CONFIG_BYTES {
        return Err(anyhow!("configuration exceeds its bound"));
    }
    ensure_no_redirects_to_parent(path)?;
    if expected.path != path {
        return Err(anyhow!("configuration ownership path changed"));
    }
    let mut file = match expected.identity.as_ref() {
        Some(expected_identity) => {
            let file = owned_open_options(false).open(path)?;
            if &file_identity(&file)? != expected_identity
                || FileReceipt::capture(path)? != *expected
            {
                return Err(anyhow!("configuration identity changed before write"));
            }
            file
        }
        None => {
            if FileReceipt::capture(path)? != *expected {
                return Err(anyhow!("configuration appeared before creation"));
            }
            owned_open_options(true).open(path)?
        }
    };
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    let owned_identity = file_identity(&file)?;
    let receipt = FileReceipt::capture(path)?;
    if receipt.identity.as_ref() != Some(&owned_identity) || receipt.bytes.as_deref() != Some(bytes)
    {
        return Err(anyhow!("configuration path changed during owned write"));
    }
    Ok(receipt)
}

fn remove_owned_config(path: &Path, expected: &FileReceipt) -> anyhow::Result<()> {
    let file = owned_open_options(false).open(path)?;
    if FileReceipt::capture(path)? != *expected
        || file_identity(&file)? != expected.identity.clone().context("missing identity")?
    {
        return Err(anyhow!("configuration identity changed before removal"));
    }
    remove_owned_config_platform(file, path)?;
    if FileReceipt::capture(path)?.identity.is_some() {
        return Err(anyhow!("configuration path remained after owned removal"));
    }
    Ok(())
}

#[cfg(windows)]
fn owned_open_options(create_new: bool) -> fs::OpenOptions {
    use std::os::windows::fs::OpenOptionsExt;
    const DELETE: u32 = 0x0001_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    let mut options = fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
        .share_mode(FILE_SHARE_READ)
        .create_new(create_new);
    options
}

#[cfg(not(windows))]
fn owned_open_options(create_new: bool) -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(create_new);
    options
}

#[cfg(windows)]
fn remove_owned_config_platform(file: fs::File, _path: &Path) -> anyhow::Result<()> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct FileDispositionInfo {
        delete_file: i32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            class: u32,
            information: *const FileDispositionInfo,
            size: u32,
        ) -> i32;
    }
    const FILE_DISPOSITION_INFO_CLASS: u32 = 4;
    let information = FileDispositionInfo { delete_file: 1 };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FILE_DISPOSITION_INFO_CLASS,
            &information,
            u32::try_from(std::mem::size_of::<FileDispositionInfo>())?,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    drop(file);
    Ok(())
}

#[cfg(not(windows))]
fn remove_owned_config_platform(file: fs::File, path: &Path) -> anyhow::Result<()> {
    // Unix cannot unlink by an open file descriptor. Rename the exact path
    // into a private sibling first, then delete only the owned identity.
    let quarantine = path
        .parent()
        .context("configuration path has no parent")?
        .join(format!(".adobepy.{}.owned", Uuid::new_v4().simple()));
    fs::rename(path, &quarantine)?;
    let quarantined = FileReceipt::capture(&quarantine)?;
    if quarantined.identity.as_ref() != Some(&file_identity(&file)?) {
        return Err(anyhow!(
            "configuration identity changed during owned removal"
        ));
    }
    fs::remove_file(&quarantine)?;
    drop(file);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_rejects_same_identity_growth_beyond_the_bound_after_metadata() {
        let root =
            std::env::temp_dir().join(format!("adobepy-config-growth-{}", Uuid::new_v4().simple()));
        fs::create_dir(&root).unwrap();
        let config = root.join("config.js");
        fs::write(&config, b"x").unwrap();
        let grow_path = config.clone();
        set_after_receipt_metadata(config.clone(), move || {
            let mut file = fs::OpenOptions::new().append(true).open(grow_path).unwrap();
            file.write_all(&vec![b'y'; (MAX_CONFIG_BYTES as usize) + 1])
                .unwrap();
            file.sync_all().unwrap();
        });

        let result = FileReceipt::capture(&config);
        let final_len = fs::metadata(&config).unwrap().len();
        fs::remove_dir_all(root).unwrap();

        assert!(final_len > MAX_CONFIG_BYTES);
        assert!(
            result.is_err(),
            "same-identity growth bypassed the configured receipt bound"
        );
    }

    #[test]
    fn activate_rejects_an_identity_swap_after_the_final_recapture() {
        let root = std::env::temp_dir().join(format!(
            "adobepy-config-recapture-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir(&root).unwrap();
        let config = root.join("config.js");
        fs::write(&config, b"old").unwrap();
        let owner = ConfigTransactionOwner::default();
        let expected = FileReceipt::capture(&config).unwrap();
        let lease = owner.begin(&config, &expected).unwrap();
        let staged_path = root.join("staged.js");
        fs::write(&staged_path, b"transient").unwrap();
        let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
        let replacement = root.join("replacement.js");
        fs::write(&replacement, b"external").unwrap();
        let swap_path = config.clone();
        set_before_activate_write(config.clone(), move || {
            fs::remove_file(&swap_path).unwrap();
            fs::rename(&replacement, &swap_path).unwrap();
        });

        assert_eq!(
            lease.activate(&staged).unwrap_err(),
            ConfigTransactionError::IdentityChanged
        );
        assert_eq!(fs::read(&config).unwrap(), b"external");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authoritative_confirmation_moves_active_ownership_to_pending_publication() {
        let root = std::env::temp_dir().join(format!(
            "adobepy-config-confirmation-state-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir(&root).unwrap();
        let config = root.join("config.js");
        fs::write(&config, b"old").unwrap();
        let owner = ConfigTransactionOwner::default();
        let expected = FileReceipt::capture(&config).unwrap();
        let lease = owner.begin(&config, &expected).unwrap();
        let staged_path = root.join("staged.js");
        fs::write(&staged_path, b"transient").unwrap();
        let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
        lease.activate(&staged).unwrap();
        let receipt = lease
            .prepare_commit_cancellable(b"committed", &AtomicBool::new(false))
            .unwrap();
        let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();

        let publication = lease.confirm_prevalidated(confirmation).unwrap();

        let state = owner.state.lock().unwrap();
        assert!(state.active.is_none());
        assert!(state.pending_publication.is_some());
        drop(state);
        drop(publication);
        lease.rollback().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

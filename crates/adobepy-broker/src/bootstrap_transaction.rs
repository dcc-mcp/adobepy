use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::fs;
use std::io::{BufReader as StdBufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once, Weak};
use std::time::Duration;
use tokio::io::BufReader as TokioBufReader;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{watch, Notify, Semaphore};
use uuid::Uuid;

const HELPER_PROTOCOL_VERSION: u32 = 1;
const MAX_HELPER_REQUEST_BYTES: usize = 512 * 1024;
const MAX_HELPER_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_HELPER_STDERR_BYTES: usize = 4096;
const HELPER_REAP_BUDGET: Duration = Duration::from_millis(150);
const SENSITIVE_PANIC_MESSAGE: &str = "sensitive bootstrap worker panicked";

#[cfg(windows)]
type PlatformProcessOwner = WindowsJob;
#[cfg(not(windows))]
type PlatformProcessOwner = ();

thread_local! {
    static SENSITIVE_PANIC_DEPTH: Cell<u32> = const { Cell::new(0) };
}

static INSTALL_PANIC_HOOK: Once = Once::new();

pub fn install_sensitive_panic_hook() {
    INSTALL_PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if SENSITIVE_PANIC_DEPTH.with(|depth| depth.get() > 0) {
                eprintln!("{SENSITIVE_PANIC_MESSAGE}");
            } else {
                previous(info);
            }
        }));
    });
}

pub(crate) struct SensitivePanicGuard;

impl SensitivePanicGuard {
    pub(crate) fn enter() -> Self {
        SENSITIVE_PANIC_DEPTH.with(|depth| depth.set(depth.get().saturating_add(1)));
        Self
    }
}

impl Drop for SensitivePanicGuard {
    fn drop(&mut self) {
        SENSITIVE_PANIC_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum HelperRequest {
    Sleep {
        millis: u64,
    },
    Stage {
        generation: u64,
        transaction_id: String,
        staging_id: String,
        bytes: Vec<u8>,
    },
    HashFile {
        path: PathBuf,
        maximum_bytes: u64,
    },
    PanicProbe,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HelperResponse {
    Completed,
    Staged {
        generation: u64,
        transaction_id: String,
        staging_id: String,
        path: PathBuf,
        bytes: u64,
        sha256: String,
    },
    Hashed {
        bytes: u64,
        sha256: String,
    },
    Failed {
        code: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HelperRequestEnvelope {
    protocol_version: u32,
    request_id: String,
    request: HelperRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HelperResponseEnvelope {
    protocol_version: u32,
    request_id: String,
    response: HelperResponse,
}

#[derive(Debug, Clone)]
pub struct HelperProgram {
    executable: PathBuf,
    arguments: Arc<[String]>,
    installed_sibling: bool,
}

impl HelperProgram {
    pub fn new(executable: PathBuf, arguments: Vec<String>) -> Self {
        Self {
            executable,
            arguments: arguments.into(),
            installed_sibling: false,
        }
    }

    pub fn installed_sibling() -> anyhow::Result<Self> {
        let current =
            std::env::current_exe().context("bootstrap helper executable is unavailable")?;
        let filename = if cfg!(windows) {
            "adobepy-bootstrap-helper.exe"
        } else {
            "adobepy-bootstrap-helper"
        };
        let mut program = Self::new(
            current
                .parent()
                .context("bootstrap helper executable has no parent")?
                .join(filename),
            Vec::new(),
        );
        program.installed_sibling = true;
        Ok(program)
    }

    fn resolved_executable(&self) -> anyhow::Result<PathBuf> {
        ensure_no_redirects(&self.executable)?;
        let metadata = fs::symlink_metadata(&self.executable)
            .context("bootstrap helper executable is unavailable")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || is_windows_reparse(&metadata)
        {
            return Err(anyhow!("bootstrap helper executable identity is invalid"));
        }
        let resolved = fs::canonicalize(&self.executable)
            .context("bootstrap helper executable identity is unavailable")?;
        if self.installed_sibling {
            let current = fs::canonicalize(std::env::current_exe()?)?;
            if resolved.parent() != current.parent() {
                return Err(anyhow!("bootstrap helper must be an installed sibling"));
            }
        }
        Ok(resolved)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HelperPoolError {
    #[error("bootstrap helper admission is full")]
    Overloaded,
    #[error("bootstrap helper request timed out")]
    TimedOut,
    #[error("bootstrap helper pool is shutting down")]
    ShuttingDown,
    #[error("bootstrap helper failed closed")]
    FailedClosed,
    #[error("bootstrap helper could not be reaped; the pool is fail-stopped")]
    QuiescenceFailed,
}

struct HelperPoolInner {
    program: HelperProgram,
    idle: Mutex<Vec<OwnedHelperProcess>>,
    admission: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
    closed: AtomicBool,
    poisoned: AtomicBool,
    handles: AtomicUsize,
    active: AtomicUsize,
    maximum_active: AtomicUsize,
    queued: AtomicUsize,
    running: AtomicUsize,
    maximum_running: AtomicUsize,
    preparing: AtomicUsize,
    spawning: AtomicUsize,
    owned_children: AtomicUsize,
    reaping: AtomicUsize,
    quiesced: Notify,
}

impl HelperPoolInner {
    fn is_quiescent(&self) -> bool {
        self.active.load(Ordering::SeqCst) == 0
            && self.queued.load(Ordering::SeqCst) == 0
            && self.running.load(Ordering::SeqCst) == 0
            && self.preparing.load(Ordering::SeqCst) == 0
            && self.spawning.load(Ordering::SeqCst) == 0
            && self.owned_children.load(Ordering::SeqCst) == 0
            && self.reaping.load(Ordering::SeqCst) == 0
    }
}

pub struct HelperProcessPool {
    inner: Arc<HelperPoolInner>,
}

impl HelperProcessPool {
    pub fn new(
        program: HelperProgram,
        capacity: usize,
        queue_capacity: usize,
    ) -> anyhow::Result<Self> {
        if capacity == 0 {
            return Err(anyhow!("bootstrap helper capacity must be positive"));
        }
        let admission_capacity = capacity
            .checked_add(queue_capacity)
            .context("bootstrap helper admission capacity overflow")?;
        let (shutdown, _) = watch::channel(false);
        let result = Self {
            inner: Arc::new(HelperPoolInner {
                program,
                idle: Mutex::new(Vec::with_capacity(capacity)),
                admission: Arc::new(Semaphore::new(admission_capacity)),
                workers: Arc::new(Semaphore::new(capacity)),
                shutdown,
                closed: AtomicBool::new(false),
                poisoned: AtomicBool::new(false),
                handles: AtomicUsize::new(1),
                active: AtomicUsize::new(0),
                maximum_active: AtomicUsize::new(0),
                queued: AtomicUsize::new(0),
                running: AtomicUsize::new(0),
                maximum_running: AtomicUsize::new(0),
                preparing: AtomicUsize::new(0),
                spawning: AtomicUsize::new(0),
                owned_children: AtomicUsize::new(0),
                reaping: AtomicUsize::new(0),
                quiesced: Notify::new(),
            }),
        };
        let mut helpers = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            helpers.push(spawn_owned_helper(result.inner.clone())?);
        }
        *result
            .inner
            .idle
            .lock()
            .map_err(|_| anyhow!("bootstrap helper owner lock is poisoned"))? = helpers;
        Ok(result)
    }

    pub async fn execute(
        &self,
        request: HelperRequest,
        deadline: tokio::time::Instant,
    ) -> Result<HelperResponse, HelperPoolError> {
        if self.inner.closed.load(Ordering::SeqCst) || self.inner.poisoned.load(Ordering::SeqCst) {
            return Err(HelperPoolError::ShuttingDown);
        }
        let admission = self
            .inner
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| HelperPoolError::Overloaded)?;
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        let inner = self.inner.clone();
        let mut shutdown = inner.shutdown.subscribe();
        let active = ActiveHelperGuard::new(inner.clone());
        let queued = CounterGuard::new(inner.clone(), CounterKind::Queued);
        tokio::spawn(async move {
            let _admission = admission;
            let _active = active;
            let worker = tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    let _ = changed;
                    let _ = result_tx.send(Err(HelperPoolError::ShuttingDown));
                    return;
                }
                _ = tokio::time::sleep_until(deadline) => {
                    let _ = result_tx.send(Err(HelperPoolError::TimedOut));
                    return;
                }
                permit = inner.workers.clone().acquire_owned() => {
                    match permit {
                        Ok(permit) => permit,
                        Err(_) => {
                            let _ = result_tx.send(Err(HelperPoolError::ShuttingDown));
                            return;
                        }
                    }
                }
            };
            drop(queued);
            let _worker = worker;
            let _running = RunningHelperGuard::new(inner.clone());
            let outcome = run_helper_process(inner.clone(), request, deadline, &mut shutdown).await;
            let _ = result_tx.send(outcome);
        });

        tokio::pin!(result_rx);
        tokio::select! {
            biased;
            result = &mut result_rx => {
                result.unwrap_or(Err(HelperPoolError::FailedClosed))
            }
            _ = tokio::time::sleep_until(deadline) => Err(HelperPoolError::TimedOut),
        }
    }

    pub async fn shutdown(&self, deadline: tokio::time::Instant) -> bool {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.admission.close();
        let _ = self.inner.shutdown.send(true);
        let idle = self
            .inner
            .idle
            .lock()
            .map(|mut idle| idle.drain(..).collect::<Vec<_>>())
            .unwrap_or_default();
        for process in idle {
            let inner = self.inner.clone();
            tokio::spawn(async move {
                let _ = terminate_helper(inner, process, HelperPoolError::ShuttingDown).await;
            });
        }
        loop {
            if self.inner.is_quiescent() {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            let notified = self.inner.quiesced.notified();
            if self.inner.is_quiescent() {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
    }

    pub fn snapshot(&self) -> HelperPoolSnapshot {
        HelperPoolSnapshot {
            active_jobs: self.inner.active.load(Ordering::SeqCst),
            maximum_active_jobs: self.inner.maximum_active.load(Ordering::SeqCst),
            queued_jobs: self.inner.queued.load(Ordering::SeqCst),
            running_helpers: self.inner.running.load(Ordering::SeqCst),
            maximum_running_helpers: self.inner.maximum_running.load(Ordering::SeqCst),
            preparing_helpers: self.inner.preparing.load(Ordering::SeqCst),
            spawning_helpers: self.inner.spawning.load(Ordering::SeqCst),
            owned_children: self.inner.owned_children.load(Ordering::SeqCst),
            reaping_children: self.inner.reaping.load(Ordering::SeqCst),
            poisoned: self.inner.poisoned.load(Ordering::SeqCst),
        }
    }
}

impl Clone for HelperProcessPool {
    fn clone(&self) -> Self {
        self.inner.handles.fetch_add(1, Ordering::SeqCst);
        Self {
            inner: self.inner.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelperPoolSnapshot {
    pub active_jobs: usize,
    pub maximum_active_jobs: usize,
    pub queued_jobs: usize,
    pub running_helpers: usize,
    pub maximum_running_helpers: usize,
    pub preparing_helpers: usize,
    pub spawning_helpers: usize,
    pub owned_children: usize,
    pub reaping_children: usize,
    pub poisoned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashReceipt {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone)]
pub struct BootstrapProbe {
    pool: HelperProcessPool,
}

impl BootstrapProbe {
    pub fn new(
        program: HelperProgram,
        capacity: usize,
        queue_capacity: usize,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            pool: HelperProcessPool::new(program, capacity, queue_capacity)?,
        })
    }

    pub fn installed(capacity: usize, queue_capacity: usize) -> anyhow::Result<Self> {
        Self::new(
            HelperProgram::installed_sibling()?,
            capacity,
            queue_capacity,
        )
    }

    pub async fn stage(
        &self,
        transaction: ConfigTransactionIdentity,
        bytes: Vec<u8>,
        deadline: tokio::time::Instant,
    ) -> Result<StagedArtifact, HelperPoolError> {
        let response = self
            .pool
            .execute(
                HelperRequest::Stage {
                    generation: transaction.generation(),
                    transaction_id: transaction.transaction_id().hyphenated().to_string(),
                    staging_id: Uuid::new_v4().hyphenated().to_string(),
                    bytes,
                },
                deadline,
            )
            .await?;
        StagedArtifact::from_helper(response).map_err(|_| HelperPoolError::FailedClosed)
    }

    pub async fn hash_file(
        &self,
        path: PathBuf,
        maximum_bytes: u64,
        deadline: tokio::time::Instant,
    ) -> Result<HashReceipt, HelperPoolError> {
        let response = self
            .pool
            .execute(
                HelperRequest::HashFile {
                    path,
                    maximum_bytes,
                },
                deadline,
            )
            .await?;
        let HelperResponse::Hashed { bytes, sha256 } = response else {
            return Err(HelperPoolError::FailedClosed);
        };
        Ok(HashReceipt { bytes, sha256 })
    }

    pub async fn shutdown(&self, deadline: tokio::time::Instant) -> bool {
        self.pool.shutdown(deadline).await
    }

    pub fn snapshot(&self) -> HelperPoolSnapshot {
        self.pool.snapshot()
    }
}

impl Drop for HelperProcessPool {
    fn drop(&mut self) {
        if self.inner.handles.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.inner.closed.store(true, Ordering::SeqCst);
            self.inner.admission.close();
            let _ = self.inner.shutdown.send(true);
        }
    }
}

struct ActiveHelperGuard {
    inner: Arc<HelperPoolInner>,
}

impl ActiveHelperGuard {
    fn new(inner: Arc<HelperPoolInner>) -> Self {
        let active = inner.active.fetch_add(1, Ordering::SeqCst) + 1;
        inner.maximum_active.fetch_max(active, Ordering::SeqCst);
        Self { inner }
    }
}

impl Drop for ActiveHelperGuard {
    fn drop(&mut self) {
        if self.inner.active.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.inner.quiesced.notify_waiters();
        }
    }
}

struct RunningHelperGuard {
    inner: Arc<HelperPoolInner>,
}

impl RunningHelperGuard {
    fn new(inner: Arc<HelperPoolInner>) -> Self {
        let running = inner.running.fetch_add(1, Ordering::SeqCst) + 1;
        inner.maximum_running.fetch_max(running, Ordering::SeqCst);
        Self { inner }
    }
}

impl Drop for RunningHelperGuard {
    fn drop(&mut self) {
        self.inner.running.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy)]
enum CounterKind {
    Queued,
    Preparing,
    Spawning,
    OwnedChild,
    Reaping,
}

struct CounterGuard {
    inner: Weak<HelperPoolInner>,
    kind: CounterKind,
}

impl CounterGuard {
    fn new(inner: Arc<HelperPoolInner>, kind: CounterKind) -> Self {
        counter(&inner, kind).fetch_add(1, Ordering::SeqCst);
        Self {
            inner: Arc::downgrade(&inner),
            kind,
        }
    }
}

impl Drop for CounterGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            counter(&inner, self.kind).fetch_sub(1, Ordering::SeqCst);
            inner.quiesced.notify_waiters();
        }
    }
}

fn counter(inner: &HelperPoolInner, kind: CounterKind) -> &AtomicUsize {
    match kind {
        CounterKind::Queued => &inner.queued,
        CounterKind::Preparing => &inner.preparing,
        CounterKind::Spawning => &inner.spawning,
        CounterKind::OwnedChild => &inner.owned_children,
        CounterKind::Reaping => &inner.reaping,
    }
}

fn spawn_owned_helper(inner: Arc<HelperPoolInner>) -> anyhow::Result<OwnedHelperProcess> {
    let _spawning = CounterGuard::new(inner.clone(), CounterKind::Spawning);
    let executable = inner.program.resolved_executable()?;
    let mut command = Command::new(executable);
    command
        .args(inner.program.arguments.iter())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_owned_process(&mut command);
    let mut child = command.spawn()?;
    let owned_child = CounterGuard::new(inner, CounterKind::OwnedChild);
    let child_pid = child.id().context("bootstrap helper PID is unavailable")?;
    #[cfg(windows)]
    let process_owner = Some(WindowsJob::assign(&child)?);
    #[cfg(not(windows))]
    let process_owner = Some(());
    let stdin = child
        .stdin
        .take()
        .context("bootstrap helper stdin is unavailable")?;
    let stdout = child
        .stdout
        .take()
        .context("bootstrap helper stdout is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("bootstrap helper stderr is unavailable")?;
    Ok(OwnedHelperProcess {
        child,
        child_pid,
        process_owner,
        stdin,
        stdout: TokioBufReader::new(stdout),
        stderr,
        _owned_child: owned_child,
    })
}

async fn run_helper_process(
    inner: Arc<HelperPoolInner>,
    request: HelperRequest,
    deadline: tokio::time::Instant,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<HelperResponse, HelperPoolError> {
    let preparing = CounterGuard::new(inner.clone(), CounterKind::Preparing);
    let request_id = Uuid::new_v4().hyphenated().to_string();
    let mut encoded = serde_json::to_vec(&HelperRequestEnvelope {
        protocol_version: HELPER_PROTOCOL_VERSION,
        request_id: request_id.clone(),
        request,
    })
    .map_err(|_| HelperPoolError::FailedClosed)?;
    if encoded.len() >= MAX_HELPER_REQUEST_BYTES {
        return Err(HelperPoolError::FailedClosed);
    }
    encoded.push(b'\n');
    let mut process = match inner
        .idle
        .lock()
        .map_err(|_| HelperPoolError::FailedClosed)?
        .pop()
    {
        Some(process) => process,
        None if inner.closed.load(Ordering::SeqCst) => return Err(HelperPoolError::ShuttingDown),
        None => return Err(HelperPoolError::FailedClosed),
    };
    drop(preparing);

    let write = async {
        process.stdin.write_all(&encoded).await?;
        process.stdin.flush().await
    };
    tokio::select! {
        biased;
        changed = shutdown.changed() => {
            let _ = changed;
            return terminate_helper(inner, process, HelperPoolError::ShuttingDown).await;
        }
        _ = tokio::time::sleep_until(deadline) => {
            return terminate_helper(inner, process, HelperPoolError::TimedOut).await;
        }
        result = write => {
            if result.is_err() {
                return terminate_helper(inner, process, HelperPoolError::FailedClosed).await;
            }
        }
    }

    let read = read_bounded_frame(&mut process.stdout, MAX_HELPER_RESPONSE_BYTES);
    let encoded_response = tokio::select! {
        biased;
        changed = shutdown.changed() => {
            let _ = changed;
            return terminate_helper(inner, process, HelperPoolError::ShuttingDown).await;
        }
        _ = tokio::time::sleep_until(deadline) => {
            return terminate_helper(inner, process, HelperPoolError::TimedOut).await;
        }
        result = read => match result {
            Ok(response) => response,
            Err(_) => return terminate_helper(inner, process, HelperPoolError::FailedClosed).await,
        }
    };
    let response: HelperResponseEnvelope = match serde_json::from_slice(&encoded_response) {
        Ok(response) => response,
        Err(_) => return terminate_helper(inner, process, HelperPoolError::FailedClosed).await,
    };
    if response.protocol_version != HELPER_PROTOCOL_VERSION || response.request_id != request_id {
        return terminate_helper(inner, process, HelperPoolError::FailedClosed).await;
    }
    {
        let mut idle = inner
            .idle
            .lock()
            .map_err(|_| HelperPoolError::FailedClosed)?;
        if inner.closed.load(Ordering::SeqCst) {
            drop(idle);
            return terminate_helper(inner, process, HelperPoolError::ShuttingDown).await;
        }
        idle.push(process);
    }
    Ok(response.response)
}

struct OwnedHelperProcess {
    child: Child,
    child_pid: u32,
    process_owner: Option<PlatformProcessOwner>,
    stdin: tokio::process::ChildStdin,
    stdout: TokioBufReader<tokio::process::ChildStdout>,
    stderr: tokio::process::ChildStderr,
    _owned_child: CounterGuard,
}

async fn terminate_helper(
    inner: Arc<HelperPoolInner>,
    process: OwnedHelperProcess,
    outcome: HelperPoolError,
) -> Result<HelperResponse, HelperPoolError> {
    if outcome != HelperPoolError::ShuttingDown {
        inner.poisoned.store(true, Ordering::SeqCst);
        inner.closed.store(true, Ordering::SeqCst);
        inner.admission.close();
        let _ = inner.shutdown.send(true);
    }
    let OwnedHelperProcess {
        mut child,
        child_pid,
        process_owner,
        stdin,
        stdout,
        stderr,
        _owned_child: owned_child,
    } = process;
    drop(stdin);
    let stdout_task = tokio::spawn(read_limited(stdout, MAX_HELPER_RESPONSE_BYTES));
    let stderr_task = tokio::spawn(read_limited(stderr, MAX_HELPER_STDERR_BYTES));
    let reaping = CounterGuard::new(inner.clone(), CounterKind::Reaping);
    let cleanup_deadline = tokio::time::Instant::now() + HELPER_REAP_BUDGET;
    if terminate_process_tree(&mut child, child_pid, process_owner).is_err() {
        inner.poisoned.store(true, Ordering::SeqCst);
        inner.closed.store(true, Ordering::SeqCst);
        inner.admission.close();
        let _ = inner.shutdown.send(true);
        let _ = child.start_kill();
        let ownership = FailStopReaperOwnership::claim(inner.clone());
        tokio::spawn(async move {
            let _owned_child = owned_child;
            let _reaping = reaping;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            // Tree termination was not proven, so this pool must remain
            // permanently non-quiescent even after the direct child exits.
            std::mem::forget(ownership);
        });
        return Err(HelperPoolError::QuiescenceFailed);
    }
    match tokio::time::timeout_at(cleanup_deadline, child.wait()).await {
        Ok(_) => {
            let _ = tokio::join!(
                tokio::time::timeout_at(cleanup_deadline, stdout_task),
                tokio::time::timeout_at(cleanup_deadline, stderr_task),
            );
            Err(outcome)
        }
        Err(_) => {
            inner.poisoned.store(true, Ordering::SeqCst);
            inner.closed.store(true, Ordering::SeqCst);
            inner.admission.close();
            let _ = inner.shutdown.send(true);
            let ownership = FailStopReaperOwnership::claim(inner.clone());
            tokio::spawn(async move {
                let _ownership = ownership;
                let _owned_child = owned_child;
                let _reaping = reaping;
                let _ = child.wait().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
            });
            Err(HelperPoolError::QuiescenceFailed)
        }
    }
}

struct FailStopReaperOwnership {
    inner: Arc<HelperPoolInner>,
}

impl FailStopReaperOwnership {
    fn claim(inner: Arc<HelperPoolInner>) -> Self {
        // Transfer one counted ownership unit to the fail-stop reaper. The
        // caller's ActiveHelperGuard drops immediately after this function,
        // leaving the pool non-quiescent until the original child is reaped.
        inner.active.fetch_add(1, Ordering::SeqCst);
        Self { inner }
    }
}

impl Drop for FailStopReaperOwnership {
    fn drop(&mut self) {
        if self.inner.active.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.inner.quiesced.notify_waiters();
        }
    }
}

async fn read_limited(reader: impl AsyncRead + Unpin, maximum: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(u64::try_from(maximum).unwrap_or(u64::MAX) + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bootstrap helper output exceeded its bound",
        ));
    }
    Ok(bytes)
}

async fn read_bounded_frame(
    reader: &mut TokioBufReader<tokio::process::ChildStdout>,
    maximum: usize,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "bootstrap helper closed before a complete response",
            ));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |position| position + 1);
        if bytes
            .len()
            .checked_add(take)
            .is_none_or(|length| length > maximum.saturating_add(1))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bootstrap helper response exceeded its bound",
            ));
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            bytes.pop();
            return Ok(bytes);
        }
    }
}

pub fn run_helper_stdio() -> anyhow::Result<()> {
    install_sensitive_panic_hook();
    let stdin = std::io::stdin();
    let mut reader = StdBufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();
    loop {
        let Some(encoded) = read_bounded_request_frame(&mut reader, MAX_HELPER_REQUEST_BYTES)?
        else {
            return Ok(());
        };
        let request: HelperRequestEnvelope =
            serde_json::from_slice(&encoded).context("bootstrap helper request is malformed")?;
        if request.protocol_version != HELPER_PROTOCOL_VERSION
            || Uuid::parse_str(&request.request_id).is_err()
        {
            return Err(anyhow!("bootstrap helper request identity is invalid"));
        }
        let request_id = request.request_id;
        let result = {
            let _guard = SensitivePanicGuard::enter();
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                execute_helper_request(request.request)
            }))
        };
        let response = match result {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => HelperResponse::Failed {
                code: "worker_failed".into(),
            },
            Err(_) => HelperResponse::Failed {
                code: "worker_panicked".into(),
            },
        };
        let encoded = serde_json::to_vec(&HelperResponseEnvelope {
            protocol_version: HELPER_PROTOCOL_VERSION,
            request_id,
            response,
        })?;
        writer.write_all(&encoded)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
}

fn read_bounded_request_frame(
    reader: &mut impl std::io::BufRead,
    maximum: usize,
) -> anyhow::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Ok(Some(bytes))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |position| position + 1);
        let next_length = bytes
            .len()
            .checked_add(take)
            .context("bootstrap helper request length overflow")?;
        let allowed = maximum.saturating_add(usize::from(newline.is_some()));
        if next_length > allowed {
            return Err(anyhow!("bootstrap helper request exceeded its bound"));
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ok(Some(bytes));
        }
    }
}

#[cfg(windows)]
fn configure_owned_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn configure_owned_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.as_std_mut().process_group(0);
}

#[cfg(not(any(windows, unix)))]
fn configure_owned_process(_command: &mut Command) {}

#[cfg(windows)]
fn is_windows_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_windows_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn execute_helper_request(request: HelperRequest) -> anyhow::Result<HelperResponse> {
    match request {
        HelperRequest::Sleep { millis } => {
            std::thread::sleep(Duration::from_millis(millis));
            Ok(HelperResponse::Completed)
        }
        HelperRequest::Stage {
            generation,
            transaction_id,
            staging_id,
            bytes,
        } => {
            let transaction_id = Uuid::parse_str(&transaction_id)
                .context("bootstrap transaction identity is invalid")?
                .hyphenated()
                .to_string();
            let staging_id = Uuid::parse_str(&staging_id)
                .context("bootstrap staging generation is invalid")?
                .hyphenated()
                .to_string();
            let root = std::env::temp_dir()
                .join("adobepy-bootstrap-staging")
                .join(&staging_id);
            fs::create_dir_all(&root)?;
            ensure_no_redirects(&root)?;
            let path = root.join("payload.bin");
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            let mut file = options.open(&path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            let captured = stable_file_bytes(&path, u64::try_from(bytes.len())?)?;
            if captured != bytes {
                return Err(anyhow!("bootstrap staging changed before receipt"));
            }
            Ok(HelperResponse::Staged {
                generation,
                transaction_id,
                staging_id,
                path,
                bytes: u64::try_from(bytes.len())?,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            })
        }
        HelperRequest::HashFile {
            path,
            maximum_bytes,
        } => {
            let bytes = stable_file_bytes(&path, maximum_bytes)?;
            Ok(HelperResponse::Hashed {
                bytes: u64::try_from(bytes.len())?,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            })
        }
        HelperRequest::PanicProbe => {
            panic!("PRIVATE_HOSTILE_BOOTSTRAP_TOKEN_C:/private/plugin.js")
        }
    }
}

fn stable_file_bytes(path: &Path, maximum_bytes: u64) -> anyhow::Result<Vec<u8>> {
    ensure_no_redirects(path)?;
    let mut file = fs::File::open(path)?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() > maximum_bytes {
        return Err(anyhow!(
            "bootstrap helper input is not a bounded regular file"
        ));
    }
    let identity = config::file_identity(&file)?;
    let mut bytes = Vec::with_capacity(usize::try_from(before.len())?);
    file.read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let path_file = fs::File::open(path)?;
    if config::file_identity(&file)? != identity
        || config::file_identity(&path_file)? != identity
        || before.len() != after.len()
        || u64::try_from(bytes.len())? != before.len()
    {
        return Err(anyhow!("bootstrap helper input changed while it was read"));
    }
    Ok(bytes)
}

fn ensure_no_redirects(path: &Path) -> anyhow::Result<()> {
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
            return Err(anyhow!("redirected bootstrap path identity is not allowed"));
        }
    }
    Ok(())
}

mod config;
mod host;

pub use config::*;
use host::terminate_process_tree;
#[cfg(windows)]
use host::WindowsJob;
pub use host::*;

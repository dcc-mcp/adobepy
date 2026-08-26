use super::{configure_owned_process, ensure_no_redirects, is_windows_reparse, QuiescenceAck};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::sync::{LazyLock, Mutex as TestMutex};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Notify;
use uuid::Uuid;

const HOST_PROCESS_CAPACITY: usize = 8;
const HOST_ADMISSION_CAPACITY: usize = 8;
const HOST_SUPERVISOR_POLL: Duration = Duration::from_millis(5);
const HOST_SPAWN_REPLY_BUDGET: Duration = Duration::from_secs(5);

#[cfg(test)]
type AfterHostSpawnHook = Box<dyn FnOnce(u32) + Send>;
#[cfg(test)]
static AFTER_HOST_SPAWN: LazyLock<TestMutex<HashMap<PathBuf, AfterHostSpawnHook>>> =
    LazyLock::new(|| TestMutex::new(HashMap::new()));

#[cfg(test)]
pub(crate) fn set_after_host_spawn(executable: PathBuf, hook: impl FnOnce(u32) + Send + 'static) {
    AFTER_HOST_SPAWN
        .lock()
        .unwrap()
        .insert(executable, Box::new(hook));
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostProcessIdentity {
    pid: u32,
    ownership_id: Uuid,
}

impl HostProcessIdentity {
    pub fn pid(&self) -> u32 {
        self.pid
    }
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum HostProcessError {
    #[error("host process could not be started")]
    Spawn,
    #[error("host process admission is full")]
    Overloaded,
    #[error("host process could not be terminated and reaped before the deadline")]
    QuiescenceFailed,
    #[error("host process ownership is stale")]
    Stale,
}

#[derive(Debug, Default)]
struct HostCompletion {
    completed: AtomicBool,
    notified: Notify,
}

impl HostCompletion {
    fn complete(&self) {
        self.completed.store(true, Ordering::SeqCst);
        self.notified.notify_waiters();
    }

    async fn wait_until(&self, deadline: tokio::time::Instant) -> bool {
        loop {
            if self.completed.load(Ordering::SeqCst) {
                return true;
            }
            let notified = self.notified.notified();
            if self.completed.load(Ordering::SeqCst) {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
    }
}

#[derive(Debug, Default)]
struct HostProcessBrokerInner {
    active: AtomicUsize,
    maximum_active: AtomicUsize,
    platform_process_owners: AtomicUsize,
    handles: AtomicUsize,
    closed: AtomicBool,
    terminate_all: AtomicBool,
    terminate: Mutex<HashSet<Uuid>>,
    quiesced: Notify,
}

impl HostProcessBrokerInner {
    fn request_termination(&self, ownership_id: Uuid) {
        self.terminate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(ownership_id);
    }

    fn take_termination(&self, ownership_id: Uuid) -> bool {
        self.terminate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&ownership_id)
    }

    fn register(&self) {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum_active.fetch_max(active, Ordering::SeqCst);
    }

    fn release(&self) {
        if self.active.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.quiesced.notify_waiters();
        }
    }
}

struct SpawnRequest {
    broker: Arc<HostProcessBrokerInner>,
    executable: PathBuf,
    arguments: Vec<String>,
    ownership_id: Uuid,
    cancelled: Option<Arc<AtomicBool>>,
    reply: mpsc::SyncSender<Result<SpawnedHost, HostProcessError>>,
}

struct SpawnedHost {
    pid: u32,
    completion: Arc<HostCompletion>,
}

struct ManagedHostProcess {
    broker: Arc<HostProcessBrokerInner>,
    child: Child,
    pid: u32,
    completion: Arc<HostCompletion>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
    terminating: bool,
}

enum ManagedHostSpawn {
    Ready(ManagedHostProcess),
    Failed(ManagedHostProcess),
}

impl ManagedHostProcess {
    fn terminate(&mut self) {
        if self.terminating {
            return;
        }
        self.terminating = true;
        #[cfg(windows)]
        let process_owner = self.take_job();
        #[cfg(not(windows))]
        let process_owner = Some(());
        let _ = terminate_process_tree(&mut self.child, self.pid, process_owner);
    }

    fn try_reap(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    #[cfg(windows)]
    fn take_job(&mut self) -> Option<WindowsJob> {
        let job = self.job.take();
        if job.is_some() {
            self.broker
                .platform_process_owners
                .fetch_sub(1, Ordering::SeqCst);
        }
        job
    }

    fn complete(mut self) {
        #[cfg(windows)]
        drop(self.take_job());
        let completion = self.completion.clone();
        let broker = self.broker.clone();
        drop(self);
        completion.complete();
        broker.release();
    }
}

#[derive(Debug)]
pub struct HostProcessBroker {
    inner: Arc<HostProcessBrokerInner>,
    spawn: SyncSender<SpawnRequest>,
}

pub type HostProcessOwner = HostProcessBroker;

impl Default for HostProcessBroker {
    fn default() -> Self {
        let inner = Arc::new(HostProcessBrokerInner {
            handles: AtomicUsize::new(1),
            ..HostProcessBrokerInner::default()
        });
        let (spawn, receiver) = mpsc::sync_channel(HOST_ADMISSION_CAPACITY);
        std::thread::Builder::new()
            .name("adobepy-host-supervisor".into())
            .spawn(move || run_host_supervisor(receiver))
            .expect("host process supervisor must start");
        Self { inner, spawn }
    }
}

impl HostProcessBroker {
    pub fn spawn(
        &self,
        executable: &Path,
        arguments: &[String],
    ) -> Result<OwnedHostProcess, HostProcessError> {
        self.spawn_inner(executable, arguments, None)
    }

    pub(crate) fn spawn_cancelable(
        &self,
        executable: &Path,
        arguments: &[String],
        cancelled: Arc<AtomicBool>,
    ) -> Result<OwnedHostProcess, HostProcessError> {
        self.spawn_inner(executable, arguments, Some(cancelled))
    }

    fn spawn_inner(
        &self,
        executable: &Path,
        arguments: &[String],
        cancelled: Option<Arc<AtomicBool>>,
    ) -> Result<OwnedHostProcess, HostProcessError> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(HostProcessError::Spawn);
        }
        ensure_no_redirects(executable).map_err(|_| HostProcessError::Spawn)?;
        let metadata = fs::symlink_metadata(executable).map_err(|_| HostProcessError::Spawn)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || is_windows_reparse(&metadata)
        {
            return Err(HostProcessError::Spawn);
        }
        let executable = fs::canonicalize(executable).map_err(|_| HostProcessError::Spawn)?;
        let ownership_id = Uuid::new_v4();
        let (reply, response) = mpsc::sync_channel(1);
        let request = SpawnRequest {
            broker: self.inner.clone(),
            executable,
            arguments: arguments.to_vec(),
            ownership_id,
            cancelled,
            reply,
        };
        self.spawn.try_send(request).map_err(|error| match error {
            TrySendError::Full(_) => HostProcessError::Overloaded,
            TrySendError::Disconnected(_) => HostProcessError::Spawn,
        })?;
        let spawned = response
            .recv_timeout(HOST_SPAWN_REPLY_BUDGET)
            .map_err(|_| HostProcessError::Spawn)??;
        Ok(OwnedHostProcess {
            broker: self.inner.clone(),
            identity: HostProcessIdentity {
                pid: spawned.pid,
                ownership_id,
            },
            completion: spawned.completion,
            owned: true,
        })
    }

    pub async fn quiesce(&self, deadline: tokio::time::Instant) -> bool {
        loop {
            if self.inner.active.load(Ordering::SeqCst) == 0 {
                return true;
            }
            let notified = self.inner.quiesced.notified();
            if self.inner.active.load(Ordering::SeqCst) == 0 {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
    }

    pub async fn shutdown(&self, deadline: tokio::time::Instant) -> bool {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.terminate_all.store(true, Ordering::SeqCst);
        self.quiesce(deadline).await
    }

    pub fn snapshot(&self) -> HostProcessSnapshot {
        HostProcessSnapshot {
            active_processes: self.inner.active.load(Ordering::SeqCst),
            maximum_active_processes: self.inner.maximum_active.load(Ordering::SeqCst),
            capacity: HOST_PROCESS_CAPACITY,
            closed: self.inner.closed.load(Ordering::SeqCst),
            platform_process_owners: self.inner.platform_process_owners.load(Ordering::SeqCst),
        }
    }
}

impl Clone for HostProcessBroker {
    fn clone(&self) -> Self {
        self.inner.handles.fetch_add(1, Ordering::SeqCst);
        Self {
            inner: self.inner.clone(),
            spawn: self.spawn.clone(),
        }
    }
}

impl Drop for HostProcessBroker {
    fn drop(&mut self) {
        if self.inner.handles.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.inner.closed.store(true, Ordering::SeqCst);
            self.inner.terminate_all.store(true, Ordering::SeqCst);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostProcessSnapshot {
    pub active_processes: usize,
    pub maximum_active_processes: usize,
    pub capacity: usize,
    pub closed: bool,
    pub platform_process_owners: usize,
}

#[must_use = "the original child ownership must be terminated and reaped explicitly"]
#[derive(Debug)]
pub struct OwnedHostProcess {
    broker: Arc<HostProcessBrokerInner>,
    identity: HostProcessIdentity,
    completion: Arc<HostCompletion>,
    owned: bool,
}

impl OwnedHostProcess {
    pub fn identity(&self) -> &HostProcessIdentity {
        &self.identity
    }

    pub fn matches(&self, identity: &HostProcessIdentity) -> bool {
        self.owned && self.identity == *identity
    }

    pub async fn terminate_and_reap(
        mut self,
        deadline: tokio::time::Instant,
    ) -> Result<QuiescenceAck, HostProcessError> {
        if !self.owned {
            return Err(HostProcessError::Stale);
        }
        self.owned = false;
        self.broker.request_termination(self.identity.ownership_id);
        if self.completion.wait_until(deadline).await {
            Ok(QuiescenceAck {
                generation: u64::from(self.identity.pid),
            })
        } else {
            Err(HostProcessError::QuiescenceFailed)
        }
    }
}

impl Drop for OwnedHostProcess {
    fn drop(&mut self) {
        if self.owned {
            self.owned = false;
            if !self.completion.completed.load(Ordering::SeqCst) {
                self.broker.request_termination(self.identity.ownership_id);
            }
        }
    }
}

fn run_host_supervisor(receiver: Receiver<SpawnRequest>) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("host supervisor runtime must start");
    let _entered = runtime.enter();
    let mut processes = HashMap::<Uuid, ManagedHostProcess>::new();
    let mut disconnected = false;
    loop {
        if !disconnected {
            match receiver.recv_timeout(HOST_SUPERVISOR_POLL) {
                Ok(request) => admit_host_process(request, &mut processes),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
            }
            loop {
                match receiver.try_recv() {
                    Ok(request) => admit_host_process(request, &mut processes),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        } else {
            std::thread::sleep(HOST_SUPERVISOR_POLL);
        }

        for (ownership_id, process) in &mut processes {
            if process.broker.take_termination(*ownership_id)
                || process.broker.terminate_all.load(Ordering::SeqCst)
                || disconnected
            {
                process.terminate();
            }
        }
        let reaped = processes
            .iter_mut()
            .filter_map(|(ownership_id, process)| process.try_reap().then_some(*ownership_id))
            .collect::<Vec<_>>();
        for ownership_id in reaped {
            if let Some(process) = processes.remove(&ownership_id) {
                process.complete();
            }
        }
        if disconnected && processes.is_empty() {
            return;
        }
    }
}

fn admit_host_process(request: SpawnRequest, processes: &mut HashMap<Uuid, ManagedHostProcess>) {
    if processes.len() >= HOST_PROCESS_CAPACITY {
        let _ = request.reply.send(Err(HostProcessError::Overloaded));
        return;
    }
    let SpawnRequest {
        broker,
        executable,
        arguments,
        ownership_id,
        cancelled,
        reply,
    } = request;
    if broker.closed.load(Ordering::SeqCst) {
        let _ = reply.send(Err(HostProcessError::Spawn));
        return;
    }
    match spawn_managed_host(broker.clone(), executable, arguments, cancelled) {
        Ok(ManagedHostSpawn::Ready(process)) => {
            let spawned = SpawnedHost {
                pid: process.pid,
                completion: process.completion.clone(),
            };
            #[cfg(windows)]
            if process.job.is_some() {
                broker
                    .platform_process_owners
                    .fetch_add(1, Ordering::SeqCst);
            }
            broker.register();
            processes.insert(ownership_id, process);
            if reply.send(Ok(spawned)).is_err() {
                if let Some(process) = processes.get_mut(&ownership_id) {
                    process.terminate();
                }
            }
        }
        Ok(ManagedHostSpawn::Failed(process)) => {
            broker.register();
            processes.insert(ownership_id, process);
            let _ = reply.send(Err(HostProcessError::Spawn));
        }
        Err(error) => {
            let _ = reply.send(Err(error));
        }
    }
}

fn spawn_managed_host(
    broker: Arc<HostProcessBrokerInner>,
    executable: PathBuf,
    arguments: Vec<String>,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<ManagedHostSpawn, HostProcessError> {
    #[cfg(test)]
    let hook_key = executable.clone();
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    configure_owned_process(&mut command);
    #[cfg(windows)]
    configure_suspended_host_process(&mut command);
    let mut child = command.spawn().map_err(|_| HostProcessError::Spawn)?;
    let pid = child.id().unwrap_or(0);
    let completion = Arc::new(HostCompletion::default());
    if pid == 0 {
        let _ = child.start_kill();
        return Ok(ManagedHostSpawn::Failed(ManagedHostProcess {
            broker,
            child,
            pid,
            completion,
            #[cfg(windows)]
            job: None,
            terminating: true,
        }));
    }
    #[cfg(windows)]
    let job = match WindowsJob::assign(&child) {
        Ok(job) => Some(job),
        Err(_) => {
            let _ = child.start_kill();
            return Ok(ManagedHostSpawn::Failed(ManagedHostProcess {
                broker,
                child,
                pid,
                completion,
                job: None,
                terminating: true,
            }));
        }
    };
    if cancelled
        .as_ref()
        .is_some_and(|cancelled| cancelled.load(Ordering::SeqCst))
    {
        #[cfg(windows)]
        drop(job);
        let _ = child.start_kill();
        return Ok(ManagedHostSpawn::Failed(ManagedHostProcess {
            broker,
            child,
            pid,
            completion,
            #[cfg(windows)]
            job: None,
            terminating: true,
        }));
    }
    #[cfg(windows)]
    if resume_suspended_process(&child).is_err() {
        drop(job);
        let _ = child.start_kill();
        return Ok(ManagedHostSpawn::Failed(ManagedHostProcess {
            broker,
            child,
            pid,
            completion,
            job: None,
            terminating: true,
        }));
    }
    #[cfg(test)]
    if let Some(hook) = AFTER_HOST_SPAWN.lock().unwrap().remove(&hook_key) {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| hook(pid))).is_err() {
            #[cfg(windows)]
            drop(job);
            let _ = child.start_kill();
            return Ok(ManagedHostSpawn::Failed(ManagedHostProcess {
                broker,
                child,
                pid,
                completion,
                #[cfg(windows)]
                job: None,
                terminating: true,
            }));
        }
    }
    Ok(ManagedHostSpawn::Ready(ManagedHostProcess {
        broker,
        child,
        pid,
        completion,
        #[cfg(windows)]
        job,
        terminating: false,
    }))
}

#[cfg(windows)]
fn configure_suspended_host_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command
        .as_std_mut()
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
}

#[cfg(windows)]
fn resume_suspended_process(child: &Child) -> std::io::Result<()> {
    #[repr(C)]
    struct ThreadEntry32 {
        size: u32,
        usage: u32,
        thread_id: u32,
        owner_process_id: u32,
        base_priority: i32,
        priority_delta: i32,
        flags: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> isize;
        fn Thread32First(snapshot: isize, entry: *mut ThreadEntry32) -> i32;
        fn Thread32Next(snapshot: isize, entry: *mut ThreadEntry32) -> i32;
        fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> isize;
        fn ResumeThread(thread: isize) -> u32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;
    const INVALID_HANDLE_VALUE: isize = -1;

    struct KernelHandle(isize);
    impl Drop for KernelHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let pid = child
        .id()
        .ok_or_else(|| std::io::Error::other("child process ID is unavailable"))?;
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let snapshot = KernelHandle(snapshot);
    let mut entry = ThreadEntry32 {
        size: u32::try_from(std::mem::size_of::<ThreadEntry32>()).unwrap(),
        usage: 0,
        thread_id: 0,
        owner_process_id: 0,
        base_priority: 0,
        priority_delta: 0,
        flags: 0,
    };
    if unsafe { Thread32First(snapshot.0, std::ptr::addr_of_mut!(entry)) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    loop {
        if entry.owner_process_id == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.thread_id) };
            if thread == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let thread = KernelHandle(thread);
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                return Err(std::io::Error::last_os_error());
            }
            return Ok(());
        }
        if unsafe { Thread32Next(snapshot.0, std::ptr::addr_of_mut!(entry)) } == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "suspended host primary thread is unavailable",
            ));
        }
    }
}

#[cfg(unix)]
pub(super) fn terminate_process_tree(
    child: &mut Child,
    pid: u32,
    _job: Option<()>,
) -> Result<(), HostProcessError> {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    let pid = i32::try_from(pid).map_err(|_| HostProcessError::Stale)?;
    if unsafe { kill(-pid, SIGKILL) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(3) {
            return Err(HostProcessError::QuiescenceFailed);
        }
    }
    let _ = child.start_kill();
    Ok(())
}

#[cfg(windows)]
pub(super) fn terminate_process_tree(
    child: &mut Child,
    _pid: u32,
    job: Option<WindowsJob>,
) -> Result<(), HostProcessError> {
    drop(job);
    let _ = child.start_kill();
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(super) fn terminate_process_tree(
    child: &mut Child,
    _pid: u32,
    _job: Option<()>,
) -> Result<(), HostProcessError> {
    child
        .start_kill()
        .map_err(|_| HostProcessError::QuiescenceFailed)
}

#[cfg(windows)]
pub(super) struct WindowsJob(isize);

#[cfg(windows)]
unsafe impl Send for WindowsJob {}

#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl std::fmt::Debug for WindowsJob {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("WindowsJob").finish_non_exhaustive()
    }
}

#[cfg(windows)]
impl WindowsJob {
    pub(super) fn assign(child: &Child) -> std::io::Result<Self> {
        #[repr(C)]
        struct BasicLimitInformation {
            per_process_user_time_limit: i64,
            per_job_user_time_limit: i64,
            limit_flags: u32,
            minimum_working_set_size: usize,
            maximum_working_set_size: usize,
            active_process_limit: u32,
            affinity: usize,
            priority_class: u32,
            scheduling_class: u32,
        }
        #[repr(C)]
        struct IoCounters {
            values: [u64; 6],
        }
        #[repr(C)]
        struct ExtendedLimitInformation {
            basic: BasicLimitInformation,
            io: IoCounters,
            process_memory_limit: usize,
            job_memory_limit: usize,
            peak_process_memory_used: usize,
            peak_job_memory_used: usize,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateJobObjectW(attributes: *mut std::ffi::c_void, name: *const u16) -> isize;
            fn SetInformationJobObject(
                job: isize,
                class: i32,
                information: *const std::ffi::c_void,
                length: u32,
            ) -> i32;
            fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
            fn CloseHandle(handle: isize) -> i32;
        }
        const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
        let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if job == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let information = ExtendedLimitInformation {
            basic: BasicLimitInformation {
                per_process_user_time_limit: 0,
                per_job_user_time_limit: 0,
                limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                minimum_working_set_size: 0,
                maximum_working_set_size: 0,
                active_process_limit: 0,
                affinity: 0,
                priority_class: 0,
                scheduling_class: 0,
            },
            io: IoCounters { values: [0; 6] },
            process_memory_limit: 0,
            job_memory_limit: 0,
            peak_process_memory_used: 0,
            peak_job_memory_used: 0,
        };
        let process = child
            .raw_handle()
            .ok_or_else(|| std::io::Error::other("child process handle is unavailable"))?
            as isize;
        if unsafe {
            SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                std::ptr::addr_of!(information).cast(),
                u32::try_from(std::mem::size_of::<ExtendedLimitInformation>()).unwrap(),
            )
        } == 0
            || unsafe { AssignProcessToJobObject(job, process) } == 0
        {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(job);
            }
            return Err(error);
        }
        Ok(Self(job))
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CloseHandle(handle: isize) -> i32;
        }
        unsafe {
            CloseHandle(self.0);
        }
    }
}

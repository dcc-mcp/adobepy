use super::{configure_owned_process, ensure_no_redirects, is_windows_reparse, QuiescenceAck};
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Notify;
use uuid::Uuid;

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

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum HostProcessError {
    #[error("host process could not be started")]
    Spawn,
    #[error("host process could not be terminated and reaped before the deadline")]
    QuiescenceFailed,
    #[error("host process ownership is stale")]
    Stale,
}

#[derive(Debug, Default)]
struct HostProcessBrokerInner {
    active: AtomicUsize,
    quiesced: Notify,
}

#[derive(Debug, Clone, Default)]
pub struct HostProcessBroker {
    inner: Arc<HostProcessBrokerInner>,
}

pub type HostProcessOwner = HostProcessBroker;

impl HostProcessBroker {
    pub fn spawn(
        &self,
        executable: &Path,
        arguments: &[String],
    ) -> Result<OwnedHostProcess, HostProcessError> {
        ensure_no_redirects(executable).map_err(|_| HostProcessError::Spawn)?;
        let metadata = fs::symlink_metadata(executable).map_err(|_| HostProcessError::Spawn)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || is_windows_reparse(&metadata)
        {
            return Err(HostProcessError::Spawn);
        }
        let executable = fs::canonicalize(executable).map_err(|_| HostProcessError::Spawn)?;
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        configure_owned_process(&mut command);
        let child = command.spawn().map_err(|_| HostProcessError::Spawn)?;
        let pid = child.id().ok_or(HostProcessError::Spawn)?;
        #[cfg(windows)]
        let job = WindowsJob::assign(&child).map_err(|_| HostProcessError::Spawn)?;
        self.inner.active.fetch_add(1, Ordering::SeqCst);
        Ok(OwnedHostProcess {
            broker: self.inner.clone(),
            child: Some(child),
            identity: HostProcessIdentity {
                pid,
                ownership_id: Uuid::new_v4(),
            },
            #[cfg(windows)]
            job: Some(job),
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
}

#[must_use = "the original child ownership must be terminated and reaped explicitly"]
#[derive(Debug)]
pub struct OwnedHostProcess {
    broker: Arc<HostProcessBrokerInner>,
    child: Option<Child>,
    identity: HostProcessIdentity,
    #[cfg(windows)]
    job: Option<WindowsJob>,
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
        let mut child = self.child.take().ok_or(HostProcessError::Stale)?;
        let process_owner = self.take_process_owner();
        terminate_process_tree(&mut child, self.identity.pid, process_owner)?;
        match tokio::time::timeout_at(deadline, child.wait()).await {
            Ok(Ok(_)) => {
                self.release_ownership();
                Ok(QuiescenceAck {
                    generation: u64::from(self.identity.pid),
                })
            }
            Ok(Err(_)) => {
                self.release_ownership();
                Err(HostProcessError::QuiescenceFailed)
            }
            Err(_) => {
                let ownership = HostReaperOwnership::transfer(&mut self);
                tokio::spawn(async move {
                    let _ownership = ownership;
                    let _ = child.wait().await;
                });
                Err(HostProcessError::QuiescenceFailed)
            }
        }
    }

    #[cfg(windows)]
    fn take_process_owner(&mut self) -> Option<WindowsJob> {
        self.job.take()
    }

    #[cfg(not(windows))]
    fn take_process_owner(&mut self) -> Option<()> {
        Some(())
    }

    fn release_ownership(&mut self) {
        if self.owned {
            self.owned = false;
            if self.broker.active.fetch_sub(1, Ordering::SeqCst) == 1 {
                self.broker.quiesced.notify_waiters();
            }
        }
    }
}

impl Drop for OwnedHostProcess {
    fn drop(&mut self) {
        if !self.owned {
            return;
        }
        if let Some(mut child) = self.child.take() {
            let process_owner = self.take_process_owner();
            let _ = terminate_process_tree(&mut child, self.identity.pid, process_owner);
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let ownership = HostReaperOwnership::transfer(self);
                handle.spawn(async move {
                    let _ownership = ownership;
                    let _ = child.wait().await;
                });
            }
        }
    }
}

struct HostReaperOwnership {
    broker: Arc<HostProcessBrokerInner>,
}

impl HostReaperOwnership {
    fn transfer(owner: &mut OwnedHostProcess) -> Self {
        owner.owned = false;
        Self {
            broker: owner.broker.clone(),
        }
    }
}

impl Drop for HostReaperOwnership {
    fn drop(&mut self) {
        if self.broker.active.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.broker.quiesced.notify_waiters();
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
    // Closing a KILL_ON_JOB_CLOSE handle is the bounded termination signal for
    // the whole tree. Avoid TerminateJobObject here because it can synchronously
    // wait on Windows under load and extend the public request deadline.
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

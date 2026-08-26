use super::is_windows_reparse;
use anyhow::{anyhow, Context};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const MAX_CONFIG_BYTES: u64 = 512 * 1024;

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
        let handle_identity = file_identity(&file)?;
        let path_handle = fs::File::open(&path)?;
        let path_identity = file_identity(&path_handle)?;
        if handle_identity != path_identity {
            return Err(anyhow!("configuration path changed before capture"));
        }
        let mut reader = file;
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len())?);
        reader.read_to_end(&mut bytes)?;
        let handle_after = reader.metadata()?;
        let path_after = fs::symlink_metadata(&path)?;
        let path_after_handle = fs::File::open(&path)?;
        if file_identity(&reader)? != handle_identity
            || file_identity(&path_after_handle)? != handle_identity
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
    pub generation: u64,
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

impl StagedArtifact {
    pub fn from_helper(response: super::HelperResponse) -> anyhow::Result<Self> {
        let super::HelperResponse::Staged {
            generation,
            path,
            bytes,
            sha256,
            ..
        } = response
        else {
            return Err(anyhow!("helper response is not a staged artifact"));
        };
        let artifact = Self {
            generation,
            path,
            bytes,
            sha256,
        };
        artifact.read_exact()?;
        Ok(artifact)
    }

    pub fn capture(generation: u64, path: &Path) -> anyhow::Result<Self> {
        let receipt = FileReceipt::capture(path)?;
        let bytes = receipt
            .bytes
            .as_ref()
            .context("staged artifact is missing")?;
        Ok(Self {
            generation,
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
pub struct QuiescenceAck {
    pub generation: u64,
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
    valid: Arc<AtomicBool>,
    destination: PathBuf,
    expected: FileReceipt,
    attempted: Option<Vec<u8>>,
    written: Option<FileReceipt>,
}

#[derive(Debug, Default)]
struct ConfigOwnerState {
    active: Option<ActiveConfigLease>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigTransactionOwner {
    next_generation: Arc<AtomicU64>,
    state: Arc<Mutex<ConfigOwnerState>>,
}

impl ConfigTransactionOwner {
    pub fn is_quiescent(&self) -> bool {
        self.state.lock().is_ok_and(|state| {
            state.active.as_ref().is_none_or(|active| {
                !active.valid.load(Ordering::SeqCst)
                    && active.attempted.is_none()
                    && active.written.is_none()
            })
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
        let mut state = self.state.lock().map_err(|_| ConfigTransactionError::Io)?;
        if let Some(active) = state.active.as_ref() {
            if active.valid.load(Ordering::SeqCst)
                || active.attempted.is_some()
                || active.written.is_some()
            {
                return Err(ConfigTransactionError::Busy);
            }
        }
        state.active = None;
        let current = FileReceipt::capture(&destination).map_err(|_| ConfigTransactionError::Io)?;
        if &current != expected {
            return Err(ConfigTransactionError::IdentityChanged);
        }
        let generation = self
            .next_generation
            .fetch_add(1, Ordering::SeqCst)
            .checked_add(1)
            .ok_or(ConfigTransactionError::Io)?;
        let valid = Arc::new(AtomicBool::new(true));
        state.active = Some(ActiveConfigLease {
            generation,
            valid: valid.clone(),
            destination: destination.clone(),
            expected: expected.clone(),
            attempted: None,
            written: None,
        });
        Ok(ConfigLease {
            owner: self.clone(),
            generation,
            valid,
            closed: false,
        })
    }
}

#[derive(Debug)]
pub struct ConfigLease {
    owner: ConfigTransactionOwner,
    generation: u64,
    valid: Arc<AtomicBool>,
    closed: bool,
}

impl ConfigLease {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn activate(
        &mut self,
        staged: &StagedArtifact,
    ) -> Result<FileReceipt, ConfigTransactionError> {
        if staged.generation != self.generation || !self.valid.load(Ordering::SeqCst) {
            return Err(ConfigTransactionError::Stale);
        }
        let bytes = staged
            .read_exact()
            .map_err(|_| ConfigTransactionError::IdentityChanged)?;
        let mut state = self
            .owner
            .state
            .lock()
            .map_err(|_| ConfigTransactionError::Io)?;
        let active = matching_active(&mut state, self.generation, &self.valid)?;
        let current =
            FileReceipt::capture(&active.destination).map_err(|_| ConfigTransactionError::Io)?;
        if current != active.expected {
            return Err(ConfigTransactionError::IdentityChanged);
        }
        active.attempted = Some(bytes.clone());
        let written = atomic_config_write(&active.destination, &bytes)
            .map_err(|_| ConfigTransactionError::IdentityChanged)?;
        active.written = Some(written.clone());
        Ok(written)
    }

    pub fn finalize(&mut self, committed: &[u8]) -> Result<FileReceipt, ConfigTransactionError> {
        if !self.valid.load(Ordering::SeqCst) {
            return Err(ConfigTransactionError::Stale);
        }
        let receipt = {
            let mut state = self
                .owner
                .state
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            let active = matching_active(&mut state, self.generation, &self.valid)?;
            let written = active
                .written
                .as_ref()
                .ok_or(ConfigTransactionError::Stale)?;
            let current = FileReceipt::capture(&active.destination)
                .map_err(|_| ConfigTransactionError::Io)?;
            if &current != written {
                return Err(ConfigTransactionError::IdentityChanged);
            }
            active.attempted = Some(committed.to_vec());
            let receipt = atomic_config_write(&active.destination, committed)
                .map_err(|_| ConfigTransactionError::IdentityChanged)?;
            state.active = None;
            receipt
        };
        self.valid.store(false, Ordering::SeqCst);
        self.closed = true;
        Ok(receipt)
    }

    pub fn rollback(mut self) -> Result<QuiescenceAck, ConfigTransactionError> {
        let acknowledgement = {
            let mut state = self
                .owner
                .state
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            let active = matching_active(&mut state, self.generation, &self.valid)?;
            if let Some(written) = active.written.as_ref() {
                let current = FileReceipt::capture(&active.destination)
                    .map_err(|_| ConfigTransactionError::Io)?;
                if &current != written {
                    return Err(ConfigTransactionError::IdentityChanged);
                }
                restore_expected(&active.destination, &active.expected)?;
            } else if active.attempted.is_some() {
                // An attempted mutation without an exact written receipt is
                // ambiguous. Never infer ownership from equal bytes alone.
                return Err(ConfigTransactionError::IdentityChanged);
            }
            state.active = None;
            QuiescenceAck {
                generation: self.generation,
            }
        };
        self.valid.store(false, Ordering::SeqCst);
        self.closed = true;
        Ok(acknowledgement)
    }

    pub fn revoke(mut self) -> Result<QuiescenceAck, ConfigTransactionError> {
        let mut state = self
            .owner
            .state
            .lock()
            .map_err(|_| ConfigTransactionError::Io)?;
        let active = matching_active(&mut state, self.generation, &self.valid)?;
        if active.written.is_some() || active.attempted.is_some() {
            return Err(ConfigTransactionError::Busy);
        }
        state.active = None;
        self.valid.store(false, Ordering::SeqCst);
        self.closed = true;
        Ok(QuiescenceAck {
            generation: self.generation,
        })
    }
}

impl Drop for ConfigLease {
    fn drop(&mut self) {
        // Revocation is a single atomic store. Drop never performs file I/O,
        // waits for a worker, or tries to acquire the owner's mutex.
        if !self.closed {
            self.valid.store(false, Ordering::SeqCst);
        }
    }
}

fn matching_active<'a>(
    state: &'a mut ConfigOwnerState,
    generation: u64,
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
                && Arc::ptr_eq(&active.valid, valid)
                && active.valid.load(Ordering::SeqCst)
        })
        .ok_or(ConfigTransactionError::Stale)
}

fn restore_expected(
    destination: &Path,
    expected: &FileReceipt,
) -> Result<(), ConfigTransactionError> {
    match expected.bytes.as_deref() {
        Some(bytes) => atomic_config_write(destination, bytes)
            .map(|_| ())
            .map_err(|_| ConfigTransactionError::Io),
        None => match fs::remove_file(destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ConfigTransactionError::Io),
        },
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

fn atomic_config_write(path: &Path, bytes: &[u8]) -> anyhow::Result<FileReceipt> {
    if u64::try_from(bytes.len())? > MAX_CONFIG_BYTES {
        return Err(anyhow!("configuration exceeds its bound"));
    }
    ensure_no_redirects_to_parent(path)?;
    let parent = path.parent().context("configuration path has no parent")?;
    let temporary = parent.join(format!(".adobepy.{}.tmp", Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    let mut file = options.write(true).create_new(true).open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    let temporary_identity = file_identity(&file)?;
    let result = atomic_config_replace(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    let receipt = FileReceipt::capture(path)?;
    if receipt.identity.as_ref() != Some(&temporary_identity)
        || receipt.bytes.as_deref() != Some(bytes)
    {
        return Err(anyhow!("configuration path changed during atomic replace"));
    }
    Ok(receipt)
}

#[cfg(windows)]
fn atomic_config_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_config_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

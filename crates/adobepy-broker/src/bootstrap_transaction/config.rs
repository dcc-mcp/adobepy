use super::is_windows_reparse;
use anyhow::{anyhow, Context};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
pub(crate) fn set_before_activate_write(path: PathBuf, intervene: impl FnOnce() + Send + 'static) {
    BEFORE_ACTIVATE_WRITE
        .lock()
        .unwrap()
        .insert(path, Box::new(intervene));
}

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
        let transaction_id = Uuid::new_v4();
        state.active = Some(ActiveConfigLease {
            generation,
            transaction_id,
            valid: valid.clone(),
            destination: destination.clone(),
            expected: expected.clone(),
            attempted: None,
            written: None,
        });
        Ok(ConfigLease {
            owner: self.clone(),
            generation,
            transaction_id,
            valid,
            closed: false,
        })
    }
}

#[derive(Debug)]
pub struct ConfigLease {
    owner: ConfigTransactionOwner,
    generation: u64,
    transaction_id: Uuid,
    valid: Arc<AtomicBool>,
    closed: bool,
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

    pub fn activate(
        &mut self,
        staged: &StagedArtifact,
    ) -> Result<FileReceipt, ConfigTransactionError> {
        self.activate_cancellable(staged, &AtomicBool::new(false))
    }

    pub fn activate_cancellable(
        &mut self,
        staged: &StagedArtifact,
        cancelled: &AtomicBool,
    ) -> Result<FileReceipt, ConfigTransactionError> {
        if staged.transaction != self.identity() || !self.valid.load(Ordering::SeqCst) {
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
        let active = matching_active(
            &mut state,
            self.generation,
            self.transaction_id,
            &self.valid,
        )?;
        let current =
            FileReceipt::capture(&active.destination).map_err(|_| ConfigTransactionError::Io)?;
        if current != active.expected {
            return Err(ConfigTransactionError::IdentityChanged);
        }
        #[cfg(test)]
        {
            let mut hook = BEFORE_ACTIVATE_WRITE
                .lock()
                .map_err(|_| ConfigTransactionError::Io)?;
            if let Some(intervene) = hook.remove(&active.destination) {
                intervene();
            }
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(ConfigTransactionError::Stale);
        }
        active.attempted = Some(bytes.clone());
        let written = owned_config_write(&active.destination, &active.expected, &bytes)
            .map_err(|_| ConfigTransactionError::IdentityChanged)?;
        active.written = Some(written.clone());
        Ok(written)
    }

    pub fn finalize(&mut self, committed: &[u8]) -> Result<FileReceipt, ConfigTransactionError> {
        let receipt = self.prepare_commit_cancellable(committed, &AtomicBool::new(false))?;
        self.confirm_commit(&receipt)?;
        Ok(receipt)
    }

    pub fn prepare_commit_cancellable(
        &mut self,
        committed: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<FileReceipt, ConfigTransactionError> {
        if !self.valid.load(Ordering::SeqCst) {
            return Err(ConfigTransactionError::Stale);
        }
        let receipt = {
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
            let written = active
                .written
                .as_ref()
                .ok_or(ConfigTransactionError::Stale)?;
            let current = FileReceipt::capture(&active.destination)
                .map_err(|_| ConfigTransactionError::Io)?;
            if &current != written {
                return Err(ConfigTransactionError::IdentityChanged);
            }
            if cancelled.load(Ordering::SeqCst) {
                return Err(ConfigTransactionError::Stale);
            }
            active.attempted = Some(committed.to_vec());
            let receipt = owned_config_write(&active.destination, written, committed)
                .map_err(|_| ConfigTransactionError::IdentityChanged)?;
            active.written = Some(receipt.clone());
            receipt
        };
        Ok(receipt)
    }

    pub fn confirm_commit(
        &mut self,
        expected: &FileReceipt,
    ) -> Result<QuiescenceAck, ConfigTransactionError> {
        let acknowledgement = {
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
                || FileReceipt::capture(&active.destination)
                    .map_err(|_| ConfigTransactionError::Io)?
                    != *expected
            {
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

    pub fn rollback(mut self) -> Result<QuiescenceAck, ConfigTransactionError> {
        let acknowledgement = {
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
            if let Some(written) = active.written.as_ref() {
                let current = FileReceipt::capture(&active.destination)
                    .map_err(|_| ConfigTransactionError::Io)?;
                if &current != written {
                    return Err(ConfigTransactionError::IdentityChanged);
                }
                restore_expected(&active.destination, written, &active.expected)?;
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
        let active = matching_active(
            &mut state,
            self.generation,
            self.transaction_id,
            &self.valid,
        )?;
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
        let mut lease = owner.begin(&config, &expected).unwrap();
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
}

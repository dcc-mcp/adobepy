use adobepy_protocol::{PhotoshopBootstrapRequest, PhotoshopHostTarget};
use anyhow::{anyhow, Context};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const MAX_HASH_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const CONFIG_NAME: &str = "adobepy.config.js";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObservedHostProcess {
    pub pid: u32,
    pub process_start_identity: String,
    pub executable_path: String,
}

#[derive(Debug)]
pub(crate) struct PreparedBootstrap {
    config_path: Option<PathBuf>,
    previous_config: Option<Vec<u8>>,
    transient_config: Option<Vec<u8>>,
    committed_config: Option<Vec<u8>>,
    pub module_sha256: String,
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
        }
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

    fn launch(&self, target: &PhotoshopHostTarget) -> anyhow::Result<ObservedHostProcess>;

    fn process_matches(&self, observed: &ObservedHostProcess) -> bool;

    fn rollback(&self, prepared: PreparedBootstrap) -> anyhow::Result<()>;

    fn finalize(&self, prepared: &PreparedBootstrap) -> anyhow::Result<()>;

    fn executable_sha256(&self, path: &str) -> anyhow::Result<String>;
}

#[derive(Debug, Default)]
pub(crate) struct SystemPhotoshopBootstrapBackend;

impl SystemPhotoshopBootstrapBackend {
    fn verify_prepared_configuration(
        &self,
        prepared: PreparedBootstrap,
    ) -> anyhow::Result<PreparedBootstrap> {
        let verification = prepared
            .config_path
            .as_deref()
            .zip(prepared.transient_config.as_deref())
            .context("prepared Photoshop configuration is incomplete")
            .and_then(|(path, transient)| exact_config_matches(path, transient));
        match verification {
            Ok(()) => Ok(prepared),
            Err(error) => match self.rollback(prepared) {
                Ok(()) => Err(error),
                Err(recovery) => Err(anyhow!(
                    "Photoshop bootstrap preparation failed and could not be recovered: {recovery}"
                )),
            },
        }
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
        match &previous_config {
            Some(bytes) => exact_config_matches(&config_path, bytes)?,
            None => match fs::symlink_metadata(&config_path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Ok(_) => {
                    return Err(anyhow!(
                        "Photoshop bridge configuration appeared during bootstrap"
                    ))
                }
                Err(error) => return Err(error.into()),
            },
        }
        atomic_write(&config_path, &transient_config)?;
        let prepared = PreparedBootstrap {
            config_path: Some(config_path),
            previous_config,
            transient_config: Some(transient_config),
            committed_config: Some(committed_config),
            module_sha256,
        };
        self.verify_prepared_configuration(prepared)
    }

    fn launch(&self, target: &PhotoshopHostTarget) -> anyhow::Result<ObservedHostProcess> {
        validate_host_file(target)?;
        let child = Command::new(&target.executable_path)
            .spawn()
            .context("the selected Photoshop process could not be launched")?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let observed = loop {
            match observe_process(child.id()) {
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
        Ok(observed)
    }

    fn process_matches(&self, observed: &ObservedHostProcess) -> bool {
        observe_process(observed.pid).is_ok_and(|actual| actual == *observed)
    }

    fn rollback(&self, prepared: PreparedBootstrap) -> anyhow::Result<()> {
        let Some(path) = prepared.config_path else {
            return Ok(());
        };
        let current = match stable_file_bytes(&path, 64 * 1024) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if current.as_ref().is_some_and(|bytes| {
            prepared.transient_config.as_ref() != Some(bytes)
                && prepared.committed_config.as_ref() != Some(bytes)
        }) {
            return Err(anyhow!(
                "Photoshop bridge configuration changed outside the bootstrap transaction"
            ));
        }
        match prepared.previous_config {
            Some(bytes) => {
                atomic_write(&path, &bytes)?;
                exact_config_matches(&path, &bytes)
            }
            None => {
                if current.is_some() {
                    match fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                }
                match fs::symlink_metadata(path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Ok(_) => Err(anyhow!(
                        "Photoshop bridge configuration rollback is incomplete"
                    )),
                    Err(error) => Err(error.into()),
                }
            }
        }
    }

    fn finalize(&self, prepared: &PreparedBootstrap) -> anyhow::Result<()> {
        match (
            &prepared.config_path,
            &prepared.transient_config,
            &prepared.committed_config,
        ) {
            (Some(path), Some(transient), Some(committed)) => {
                exact_config_matches(path, transient)?;
                atomic_write(path, committed)?;
                exact_config_matches(path, committed)
            }
            (None, None, None) => Ok(()),
            _ => Err(anyhow!("Photoshop bootstrap commit state is incomplete")),
        }
    }

    fn executable_sha256(&self, path: &str) -> anyhow::Result<String> {
        digest_file(Path::new(path))
    }
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

fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let parent = path.parent().context("configuration path has no parent")?;
    ensure_no_redirects(parent)?;
    match fs::symlink_metadata(path) {
        Ok(_) => ensure_no_redirects(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let temporary = parent.join(format!(".{CONFIG_NAME}.{}.tmp", Uuid::new_v4().simple()));
    fs::write(&temporary, bytes)?;
    match atomic_replace(&temporary, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error.into())
        }
    }
}

fn exact_config_matches(path: &Path, expected: &[u8]) -> anyhow::Result<()> {
    if stable_file_bytes(path, 64 * 1024)? != expected {
        return Err(anyhow!(
            "Photoshop bridge configuration changed outside the bootstrap transaction"
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
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
    const TRANSIENT_REPLACE_ERRORS: [i32; 3] = [5, 32, 33];
    const MAX_REPLACE_ATTEMPTS: usize = 20;

    for attempt in 0..MAX_REPLACE_ATTEMPTS {
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } != 0
        {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if attempt + 1 == MAX_REPLACE_ATTEMPTS
            || !error
                .raw_os_error()
                .is_some_and(|code| TRANSIENT_REPLACE_ERRORS.contains(&code))
        {
            return Err(error);
        }
        thread::sleep(Duration::from_millis(5));
    }
    unreachable!("bounded atomic replace loop always returns")
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn validate_exact_file(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    maximum: u64,
) -> anyhow::Result<Vec<u8>> {
    if expected_bytes == 0 || expected_bytes > maximum || !is_sha256(expected_sha256) {
        return Err(anyhow!("file identity is invalid"));
    }
    let bytes = stable_file_bytes(path, maximum)?;
    if u64::try_from(bytes.len())? != expected_bytes
        || format!("{:x}", Sha256::digest(&bytes)) != expected_sha256
    {
        return Err(anyhow!("file identity does not match"));
    }
    Ok(bytes)
}

fn stable_file_bytes(path: &Path, maximum: u64) -> std::io::Result<Vec<u8>> {
    ensure_no_redirects(path)?;
    let mut file = fs::File::open(path)?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() == 0 || before.len() > maximum {
        return Err(std::io::Error::other("file is empty or unbounded"));
    }
    let capacity =
        usize::try_from(before.len()).map_err(|_| std::io::Error::other("file is too large"))?;
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes)?;
    let handle_after = file.metadata()?;
    let path_after = fs::metadata(path)?;
    if before.len() != handle_after.len()
        || before.modified()? != handle_after.modified()?
        || before.len() != path_after.len()
        || before.modified()? != path_after.modified()?
        || bytes.len() != capacity
    {
        return Err(std::io::Error::other("file changed during attestation"));
    }
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

    #[test]
    fn atomic_config_replace_and_nonce_consumption_are_exact() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("photoshop-bootstrap-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&root).unwrap();
        let config = root.join(CONFIG_NAME);
        fs::write(&config, b"old-config").unwrap();

        atomic_write(&config, b"new-config").unwrap();
        assert_eq!(fs::read(&config).unwrap(), b"new-config");
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
        fs::write(&config, b"transient-config").unwrap();
        let backend = SystemPhotoshopBootstrapBackend;
        let prepared = PreparedBootstrap {
            config_path: Some(config.clone()),
            previous_config: Some(b"prior-config".to_vec()),
            transient_config: Some(b"transient-config".to_vec()),
            committed_config: Some(b"committed-config".to_vec()),
            module_sha256: "a".repeat(64),
        };

        fs::write(&config, b"operator-change").unwrap();
        assert!(backend.finalize(&prepared).is_err());
        assert_eq!(fs::read(&config).unwrap(), b"operator-change");
        assert!(backend.rollback(prepared).is_err());
        assert_eq!(fs::read(&config).unwrap(), b"operator-change");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepare_verification_failure_restores_the_prior_configuration() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "photoshop-bootstrap-prepare-recovery-{}",
                Uuid::new_v4().simple()
            ));
        fs::create_dir_all(&root).unwrap();
        let config = root.join(CONFIG_NAME);
        fs::write(&config, b"transient-config").unwrap();
        let prepared = PreparedBootstrap {
            config_path: Some(config.clone()),
            previous_config: Some(b"prior-config".to_vec()),
            transient_config: Some(b"transient-config".to_vec()),
            committed_config: Some(b"committed-config".to_vec()),
            module_sha256: "a".repeat(64),
        };
        fs::remove_file(&config).unwrap();

        let backend = SystemPhotoshopBootstrapBackend;
        assert!(backend.verify_prepared_configuration(prepared).is_err());
        assert_eq!(fs::read(&config).unwrap(), b"prior-config");

        fs::remove_dir_all(root).unwrap();
    }
}

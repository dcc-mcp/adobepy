//! Bake the adobepy product/release version into the broker binary.
//!
//! The broker reports its own runtime identity through the authenticated
//! `/v1/broker-identity` endpoint. Adapters compare that identity's
//! `runtimeVersion` against an owned install receipt, which records the
//! *product* release version (the release-please managed value in
//! `.release-please-manifest.json`, projected into `pyproject.toml`,
//! `package.json`, and the release `package-manifest.json`), not the Rust crate
//! version. The crates are intentionally pinned and are not release-managed, so
//! `CARGO_PKG_VERSION` must never be reported as the runtime version.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(|parent| parent.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest_dir.clone());

    let release_manifest = repo_root
        .join(".github")
        .join("release-please-manifest.json");
    let pyproject = repo_root.join("pyproject.toml");
    println!("cargo:rerun-if-changed={}", release_manifest.display());
    println!("cargo:rerun-if-changed={}", pyproject.display());

    let resolved = product_version(&release_manifest)
        .or_else(|| product_version_from_pyproject(&pyproject))
        .filter(|value| is_valid_product_version(value));

    let version = match resolved {
        Some(value) => value,
        None => {
            // A release broker is shipped to end users, and its reported
            // runtimeVersion is compared against an owned install receipt. A
            // build that cannot resolve the product version would otherwise fall
            // back to the pinned, non-release-managed crate version and thus
            // reintroduce the very identity_mismatch this script prevents. Fail
            // fast on release builds instead of silently emitting that value.
            let profile = env::var("PROFILE").unwrap_or_default();
            assert!(
                profile != "release",
                "ADOBEPY_PRODUCT_VERSION could not be resolved from \
                 .github/release-please-manifest.json or pyproject.toml; refusing to build a \
                 release broker that would report the crate version as its runtime identity"
            );
            let fallback = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_owned());
            println!(
                "cargo:warning=ADOBEPY_PRODUCT_VERSION could not be resolved from \
                 .github/release-please-manifest.json or pyproject.toml; falling back to the \
                 crate version {fallback} for this non-release build"
            );
            fallback
        }
    };

    println!("cargo:rustc-env=ADOBEPY_PRODUCT_VERSION={version}");
}

/// Read the release-please product version for the repository root package (`"."`).
fn product_version(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value
        .get(".")
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

/// Fall back to `pyproject.toml`'s `[project]` `version = "..."` line.
fn product_version_from_pyproject(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let mut in_project = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_project = trimmed == "[project]";
            continue;
        }
        if !in_project {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("version") else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = rest.trim().trim_matches('"').trim_matches('\'').trim();
        if !value.is_empty() {
            return Some(value.to_owned());
        }
    }
    None
}

/// Require a bounded, single-line, `major.minor.patch` product version with an
/// optional `-prerelease` / `+build` suffix (the core `major.minor.patch` must be
/// numeric). This keeps the reported value within the runtime identity
/// `is_bounded_text(_, 64)` constraint and comparable to an install receipt.
fn is_valid_product_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' || byte == b'+')
    {
        return false;
    }
    let core = value.split(['-', '+']).next().unwrap_or_default();
    let mut parts = core.split('.');
    let major = parts.next().unwrap_or_default();
    let minor = parts.next().unwrap_or_default();
    let patch = parts.next().unwrap_or_default();
    !major.is_empty()
        && !minor.is_empty()
        && !patch.is_empty()
        && major.bytes().all(|b| b.is_ascii_digit())
        && minor.bytes().all(|b| b.is_ascii_digit())
        && patch.bytes().all(|b| b.is_ascii_digit())
}

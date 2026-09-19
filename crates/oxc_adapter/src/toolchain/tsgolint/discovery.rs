//! Locating a tsgolint executable this adapter is allowed to speak protocol v2 to.

use std::path::{Path, PathBuf};

use super::TsgolintError;

pub const SUPPORTED_TSGOLINT_VERSION: &str = "7.0.2002";

pub(crate) fn find_tsgolint_executable(cwd: &Path) -> Result<PathBuf, TsgolintError> {
    #[cfg(windows)]
    const FILES: &[&str] = &["tsgolint.CMD", "tsgolint.exe"];
    #[cfg(not(windows))]
    const FILES: &[&str] = &["tsgolint"];

    if let Ok(configured) = std::env::var("OXLINT_TSGOLINT_PATH") {
        let path = PathBuf::from(&configured);
        if path.is_file() {
            return Ok(path);
        }
        if path.is_dir()
            && let Some(candidate) =
                FILES.iter().map(|name| path.join(name)).find(|candidate| candidate.is_file())
        {
            return Ok(candidate);
        }
        return Err(TsgolintError::ConfiguredPathInvalid { configured });
    }
    let mut directory = cwd.to_path_buf();
    loop {
        let node_modules = directory.join("node_modules");
        if let Some(package) = tsgolint_platform_package() {
            let native = node_modules
                .join("@oxlint-tsgolint")
                .join(package)
                .join(if cfg!(windows) { "tsgolint.exe" } else { "tsgolint" });
            if native.is_file() {
                return Ok(native);
            }
        }
        if let Some(candidate) = FILES
            .iter()
            .map(|name| node_modules.join(".bin").join(name))
            .find(|candidate| candidate.is_file())
        {
            return Ok(candidate);
        }
        if !directory.pop() {
            break;
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            if let Some(candidate) =
                FILES.iter().map(|name| directory.join(name)).find(|candidate| candidate.is_file())
            {
                return Ok(candidate);
            }
        }
    }
    Err(TsgolintError::NotInstalled)
}

fn tsgolint_platform_package() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

pub(crate) fn verify_tsgolint_version(executable: &Path) -> Result<(), TsgolintError> {
    let canonical = executable.canonicalize().unwrap_or_else(|_| executable.to_path_buf());
    for directory in canonical.ancestors().skip(1).take(6) {
        let manifest_path = directory.join("package.json");
        let Ok(source) = std::fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&source) else {
            continue;
        };
        let name = manifest.get("name").and_then(serde_json::Value::as_str);
        if !name
            .is_some_and(|name| name == "oxlint-tsgolint" || name.starts_with("@oxlint-tsgolint/"))
        {
            continue;
        }
        let version =
            manifest.get("version").and_then(serde_json::Value::as_str).ok_or_else(|| {
                TsgolintError::MetadataWithoutVersion { manifest: manifest_path.clone() }
            })?;
        if version == SUPPORTED_TSGOLINT_VERSION {
            return Ok(());
        }
        return Err(TsgolintError::UnsupportedVersion { version: version.to_string() });
    }
    if std::env::var("OXC_TSRX_TSGOLINT_VERSION")
        .is_ok_and(|version| version == SUPPORTED_TSGOLINT_VERSION)
    {
        return Ok(());
    }
    Err(TsgolintError::UnverifiableVersion { executable: executable.to_path_buf() })
}

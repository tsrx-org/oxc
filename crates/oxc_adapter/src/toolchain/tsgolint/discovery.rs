//! Locating a tsgolint executable this adapter is allowed to speak protocol v2 to.

use std::path::{Path, PathBuf};

use super::TsgolintError;

/// The oldest `oxlint-tsgolint` this adapter speaks protocol v2 to.
///
/// Every later 7.0 release is accepted too: their headless payload, frames, and source overlay are
/// unchanged, and current Oxlint releases require one of them, so a project that follows Oxlint
/// can share its tsgolint.
pub const SUPPORTED_TSGOLINT_VERSION: &str = "7.0.2002";

/// Set by the `@tsrx/oxc` launcher to the tsgolint the package itself depends on, so the version
/// it was released with is preferred over whatever a project's `node_modules/.bin` holds.
const BUNDLED_TSGOLINT_ENV: &str = "OXC_TSRX_BUNDLED_TSGOLINT";

/// Whether `version` is a 7.0 tsgolint at or after [`SUPPORTED_TSGOLINT_VERSION`].
pub(crate) fn is_supported_tsgolint_version(version: &str) -> bool {
    let patch = |version: &str| version.strip_prefix("7.0.")?.parse::<u32>().ok();
    patch(version)
        .zip(patch(SUPPORTED_TSGOLINT_VERSION))
        .is_some_and(|(found, minimum)| found >= minimum)
}

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
    if let Some(bundled) = std::env::var_os(BUNDLED_TSGOLINT_ENV).map(PathBuf::from)
        && bundled.is_file()
    {
        return Ok(bundled);
    }
    let mut directory = cwd.to_path_buf();
    loop {
        let node_modules = directory.join("node_modules");
        if let Some(package_name) = tsgolint_platform_package() {
            let native = node_modules
                .join("@oxlint-tsgolint")
                .join(package_name)
                .join(if cfg!(windows) { "tsgolint.exe" } else { "tsgolint" });
            if native.is_file() {
                return Ok(native);
            }
            // pnpm keeps the platform package beside `oxlint-tsgolint` in its store rather than in
            // the project's `node_modules`, and `.bin/tsgolint` is a shell shim with no manifest
            // above it to verify. The store directory the package links into has both.
            if let Ok(package) = node_modules.join("oxlint-tsgolint").canonicalize()
                && let Some(store) = package.parent()
            {
                let native = store
                    .join("@oxlint-tsgolint")
                    .join(package_name)
                    .join(if cfg!(windows) { "tsgolint.exe" } else { "tsgolint" });
                if native.is_file() {
                    return Ok(native);
                }
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
        if is_supported_tsgolint_version(version) {
            return Ok(());
        }
        return Err(TsgolintError::UnsupportedVersion { version: version.to_string() });
    }
    if std::env::var("OXC_TSRX_TSGOLINT_VERSION")
        .is_ok_and(|version| is_supported_tsgolint_version(&version))
    {
        return Ok(());
    }
    Err(TsgolintError::UnverifiableVersion { executable: executable.to_path_buf() })
}

#[cfg(test)]
mod tests {
    use super::is_supported_tsgolint_version;

    #[test]
    fn every_later_7_0_release_is_supported() {
        assert!(is_supported_tsgolint_version("7.0.2002"));
        assert!(is_supported_tsgolint_version("7.0.2004"));
        assert!(!is_supported_tsgolint_version("7.0.2001"));
        assert!(!is_supported_tsgolint_version("7.1.0"));
        assert!(!is_supported_tsgolint_version("8.0.2002"));
        assert!(!is_supported_tsgolint_version("7.0.2004-beta.1"));
    }
}

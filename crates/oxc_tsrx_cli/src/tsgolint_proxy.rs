//! Standing in for tsgolint under canonical Oxlint.
//!
//! The drop-in `oxlint` command lints ordinary files with canonical Oxlint, which runs its own
//! tsgolint. It points that Oxlint at this executable through `OXLINT_TSGOLINT_PATH` and names the
//! tsgolint Oxlint would have run in [`PROXY_TARGET_ENV`]. Oxlint then starts this process as
//! `<this> headless [flags]` and writes its payload to stdin; the payload gains a read-only overlay
//! for every `.tsrx` module its files reach (see [`tsrx_lint::overlay_imported_tsrx`]) and goes on
//! to the real tsgolint with the same arguments. The real tsgolint writes its answer straight to
//! Oxlint, and its exit status is this process's exit status.

use std::{
    ffi::OsString,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
};

/// The real tsgolint executable, or empty when none was found where the proxy was installed. Only
/// a process started with this set and `headless` as its first argument is a proxy, so the
/// variable leaking into any other invocation changes nothing.
pub(crate) const PROXY_TARGET_ENV: &str = "OXC_TSRX_TSGOLINT_PROXY";

/// Set when the tsgolint is to be found per payload rather than fixed. One Oxlint language server
/// serves every workspace root and looks a tsgolint up from each root's `node_modules/.bin`, so
/// the proxy looks it up from the directory of the files it is handed, the same way, and falls
/// back to [`PROXY_TARGET_ENV`] only when that finds none.
pub(crate) const PROXY_SEARCH_ENV: &str = "OXC_TSRX_TSGOLINT_PROXY_SEARCH";

/// The fallback tsgolint when this invocation is canonical Oxlint starting its tsgolint.
pub(crate) fn proxy_target(arguments: &[String]) -> Option<OsString> {
    if arguments.first().map(String::as_str) != Some("headless") {
        return None;
    }
    std::env::var_os(PROXY_TARGET_ENV)
}

#[cfg(windows)]
const TSGOLINT_FILES: &[&str] = &["tsgolint.CMD", "tsgolint.exe"];
#[cfg(not(windows))]
const TSGOLINT_FILES: &[&str] = &["tsgolint"];

/// The `node_modules/.bin` tsgolint nearest above `file`, the lookup Oxlint makes from a root.
fn nearest_tsgolint(file: &Path) -> Option<PathBuf> {
    file.ancestors().skip(1).find_map(|directory| {
        TSGOLINT_FILES
            .iter()
            .map(|name| directory.join("node_modules").join(".bin").join(name))
            .find(|candidate| candidate.is_file())
    })
}

/// The tsgolint to hand this payload to.
fn select_target(fallback: &OsString, first_file: Option<&Path>, search: bool) -> Option<PathBuf> {
    let searched = if search { first_file.and_then(nearest_tsgolint) } else { None };
    searched.or_else(|| (!fallback.is_empty()).then(|| PathBuf::from(fallback)))
}

#[expect(
    clippy::print_stderr,
    reason = "canonical Oxlint passes tsgolint's stderr through to the user, and this stands in for it"
)]
pub(crate) fn run(fallback: &OsString, arguments: &[String]) -> ExitCode {
    let mut payload = Vec::new();
    if let Err(error) = std::io::stdin().read_to_end(&mut payload) {
        eprintln!("oxc-tsrx: could not read the tsgolint payload: {error}");
        return ExitCode::FAILURE;
    }
    let overlaid = tsrx_lint::overlay_imported_tsrx(&payload);
    let search = std::env::var_os(PROXY_SEARCH_ENV).is_some_and(|value| !value.is_empty());
    let Some(target) = select_target(fallback, overlaid.first_file.as_deref(), search) else {
        eprintln!(
            "Failed to find tsgolint executable. You may need to add the `oxlint-tsgolint` package to your project?"
        );
        return ExitCode::FAILURE;
    };
    let payload = overlaid.payload.unwrap_or(payload);
    let mut child = match Command::new(&target)
        .args(arguments)
        .env_remove(PROXY_TARGET_ENV)
        .env_remove(PROXY_SEARCH_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("oxc-tsrx: failed to start tsgolint at {}: {error}", target.display());
            return ExitCode::FAILURE;
        }
    };
    if let Some(mut stdin) = child.stdin.take()
        && let Err(error) = stdin.write_all(&payload)
        && error.kind() != ErrorKind::BrokenPipe
    {
        eprintln!("oxc-tsrx: could not send the payload to tsgolint: {error}");
    }
    match child.wait() {
        Ok(status) => status.code().map_or(ExitCode::FAILURE, |code| {
            ExitCode::from(u8::try_from(code & 0xff).unwrap_or(1))
        }),
        Err(error) => {
            eprintln!("oxc-tsrx: failed to wait for tsgolint: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, fs, path::PathBuf};

    use super::{TSGOLINT_FILES, select_target};

    #[test]
    fn a_searched_tsgolint_is_the_one_nearest_the_payload_and_the_fallback_backs_it() {
        let root =
            std::env::temp_dir().join(format!("oxc-tsrx-proxy-target-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = root.join("a");
        let second = root.join("b");
        for project in [&first, &second] {
            fs::create_dir_all(project.join("src")).unwrap();
        }
        let bin = second.join("node_modules").join(".bin");
        fs::create_dir_all(&bin).unwrap();
        let own = bin.join(TSGOLINT_FILES[0]);
        fs::write(&own, "").unwrap();
        let fallback = OsString::from("/fallback/tsgolint");
        let in_second = second.join("src").join("main.ts");
        let in_first = first.join("src").join("main.ts");

        assert_eq!(select_target(&fallback, Some(&in_second), true), Some(own));
        assert_eq!(
            select_target(&fallback, Some(&in_first), true),
            Some(PathBuf::from("/fallback/tsgolint"))
        );
        // A fixed target, as the command line resolves it, is never searched past.
        assert_eq!(
            select_target(&fallback, Some(&in_second), false),
            Some(PathBuf::from("/fallback/tsgolint"))
        );
        assert_eq!(select_target(&OsString::new(), Some(&in_first), true), None);
        assert_eq!(select_target(&OsString::new(), None, true), None);
        fs::remove_dir_all(root).unwrap();
    }
}

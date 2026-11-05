//! Standing in for tsgolint under canonical Oxlint.
//!
//! The drop-in `oxlint` command lints ordinary files with canonical Oxlint, which runs its own
//! tsgolint. It points that Oxlint at this executable through `OXLINT_TSGOLINT_PATH` and names the
//! tsgolint Oxlint would have run in [`PROXY_TARGET_ENV`]. Oxlint then starts this process as
//! `<this> headless [flags]` and writes its payload to stdin; the payload gains a read-only overlay
//! for every `.tsrx` module its files import (see [`tsrx_lint::overlay_imported_tsrx`]) and goes on
//! to the real tsgolint with the same arguments. The real tsgolint writes its answer straight to
//! Oxlint, and its exit status is this process's exit status.

use std::{
    ffi::OsString,
    io::{ErrorKind, Read, Write},
    process::{Command, ExitCode, Stdio},
};

/// The real tsgolint executable. Only a process started with this set and `headless` as its first
/// argument is a proxy, so the variable leaking into any other invocation changes nothing.
pub(crate) const PROXY_TARGET_ENV: &str = "OXC_TSRX_TSGOLINT_PROXY";

/// The real tsgolint when this invocation is canonical Oxlint starting its tsgolint.
pub(crate) fn proxy_target(arguments: &[String]) -> Option<OsString> {
    if arguments.first().map(String::as_str) != Some("headless") {
        return None;
    }
    std::env::var_os(PROXY_TARGET_ENV).filter(|target| !target.is_empty())
}

#[expect(
    clippy::print_stderr,
    reason = "canonical Oxlint passes tsgolint's stderr through to the user, and this stands in for it"
)]
pub(crate) fn run(target: &OsString, arguments: &[String]) -> ExitCode {
    let mut payload = Vec::new();
    if let Err(error) = std::io::stdin().read_to_end(&mut payload) {
        eprintln!("oxc-tsrx: could not read the tsgolint payload: {error}");
        return ExitCode::FAILURE;
    }
    let payload = tsrx_lint::overlay_imported_tsrx(&payload).unwrap_or(payload);
    let mut child = match Command::new(target)
        .args(arguments)
        .env_remove(PROXY_TARGET_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "oxc-tsrx: failed to start tsgolint at {}: {error}",
                std::path::Path::new(target).display()
            );
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

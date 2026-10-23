//! Every way the type-aware lane can fail before it produces a diagnostic.

use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
    process::ExitStatus,
};

use super::SUPPORTED_TSGOLINT_VERSION;

/// Which length-prefixed part of a protocol frame ended before it was complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePart {
    Size,
    Kind,
    Payload,
}

impl fmt::Display for FramePart {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Size => "size",
            Self::Kind => "kind",
            Self::Payload => "payload",
        })
    }
}

/// Why locating, verifying, or speaking protocol v2 to tsgolint did not produce diagnostics.
///
/// Variants that quote tsgolint or `serde_json` keep the wording in a `detail` string for the same
/// reason [`ConfigError`](crate::ConfigError) does: this crate keeps foreign, revision-pinned error
/// types off its own surface. Process and stream failures keep their [`io::Error`], which is not
/// revision-pinned and which callers legitimately match on.
#[derive(Debug)]
pub enum TsgolintError {
    /// `OXLINT_TSGOLINT_PATH` is set but does not name an executable.
    ConfiguredPathInvalid { configured: String },
    /// No tsgolint was found in `node_modules`, on `PATH`, or via the environment.
    NotInstalled,
    /// The npm package next to the executable carries no `version` field.
    MetadataWithoutVersion { manifest: PathBuf },
    /// The installed tsgolint is older than, or a different line from, the protocol-v2 releases.
    UnsupportedVersion { version: String },
    /// A standalone binary's version could not be established at all.
    UnverifiableVersion { executable: PathBuf },
    /// The resolved rule set could not be grouped into protocol config groups.
    UngroupableRules { detail: String },
    /// One type-aware rule's options could not be serialized.
    UnserializableRule { rule: &'static str, detail: String },
    /// The child process could not be spawned.
    Spawn { executable: PathBuf, error: io::Error },
    /// The protocol payload could not be encoded.
    EncodePayload { detail: String },
    /// The spawned child exposed no stdin pipe.
    NoStdin,
    /// The spawned child exposed no stdout pipe.
    NoStdout,
    /// The in-memory sources could not be written to the child.
    TransferSources(io::Error),
    /// The first byte of a frame could not be read.
    ReadFrame(io::Error),
    /// A frame ended before the named part was complete.
    TruncatedFrame { part: FramePart, error: io::Error },
    /// A frame declares a payload larger than this target can address.
    FrameTooLarge,
    /// An error frame's payload is not the documented shape.
    InvalidErrorFrame { detail: String },
    /// A diagnostic frame's payload is not the documented shape.
    InvalidDiagnosticFrame { detail: String },
    /// The stream carried a frame type this protocol version does not define.
    UnsupportedFrameKind { kind: u8 },
    /// The child could not be reaped.
    Wait(io::Error),
    /// tsgolint reported a protocol-level failure of its own.
    Protocol { detail: String },
    /// tsgolint exited non-zero without reporting a protocol error.
    Exit { status: ExitStatus },
}

impl TsgolintError {
    pub(super) fn spawn(executable: &Path, error: io::Error) -> Self {
        Self::Spawn { executable: executable.to_path_buf(), error }
    }

    pub(super) fn truncated_frame(part: FramePart, error: io::Error) -> Self {
        Self::TruncatedFrame { part, error }
    }
}

impl fmt::Display for TsgolintError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConfiguredPathInvalid { configured } => write!(
                formatter,
                "OXLINT_TSGOLINT_PATH does not identify a tsgolint executable: {configured}"
            ),
            Self::NotInstalled => write!(
                formatter,
                "type-aware linting requires oxlint-tsgolint {SUPPORTED_TSGOLINT_VERSION} or a later 7.0 release; install it in this project or set OXLINT_TSGOLINT_PATH"
            ),
            Self::MetadataWithoutVersion { manifest } => write!(
                formatter,
                "tsgolint package metadata at {} has no version",
                manifest.display()
            ),
            Self::UnsupportedVersion { version } => write!(
                formatter,
                "unsupported tsgolint version {version}; OXC for TSRX requires oxlint-tsgolint {SUPPORTED_TSGOLINT_VERSION} or a later 7.0 release for protocol v2"
            ),
            Self::UnverifiableVersion { executable } => write!(
                formatter,
                "unable to verify tsgolint version for {}; use the oxlint-tsgolint npm package ({SUPPORTED_TSGOLINT_VERSION} or a later 7.0 release) or set OXC_TSRX_TSGOLINT_VERSION={SUPPORTED_TSGOLINT_VERSION} for a verified standalone binary",
                executable.display()
            ),
            Self::UngroupableRules { detail } => {
                write!(formatter, "unable to group type-aware rules: {detail}")
            }
            Self::UnserializableRule { rule, detail } => {
                write!(formatter, "unable to serialize type-aware rule {rule}: {detail}")
            }
            Self::Spawn { executable, error } => write!(
                formatter,
                "unable to start supported tsgolint at {}: {error}",
                executable.display()
            ),
            Self::EncodePayload { detail } => {
                write!(formatter, "unable to encode tsgolint protocol v2 payload: {detail}")
            }
            Self::NoStdin => formatter.write_str("tsgolint did not expose stdin"),
            Self::NoStdout => formatter.write_str("tsgolint did not expose stdout"),
            Self::TransferSources(error) => {
                write!(formatter, "unable to transfer in-memory TSRX sources: {error}")
            }
            Self::ReadFrame(error) => {
                write!(formatter, "unable to read tsgolint protocol frame: {error}")
            }
            Self::TruncatedFrame { part, error } => {
                write!(formatter, "truncated tsgolint frame {part}: {error}")
            }
            Self::FrameTooLarge => formatter.write_str("tsgolint frame exceeds addressable memory"),
            Self::InvalidErrorFrame { detail } => {
                write!(formatter, "invalid tsgolint error frame: {detail}")
            }
            Self::InvalidDiagnosticFrame { detail } => {
                write!(formatter, "invalid tsgolint diagnostic frame: {detail}")
            }
            Self::UnsupportedFrameKind { kind } => {
                write!(formatter, "unsupported tsgolint protocol frame type {kind}")
            }
            Self::Wait(error) => write!(formatter, "unable to wait for tsgolint: {error}"),
            Self::Protocol { detail } => write!(formatter, "tsgolint protocol error: {detail}"),
            Self::Exit { status } => write!(formatter, "tsgolint exited with {status}"),
        }
    }
}

impl Error for TsgolintError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Spawn { error, .. }
            | Self::TruncatedFrame { error, .. }
            | Self::TransferSources(error)
            | Self::ReadFrame(error)
            | Self::Wait(error) => Some(error),
            _ => None,
        }
    }
}

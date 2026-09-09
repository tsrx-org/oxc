//! The one error every native lint entry point returns.

use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
};

use oxc_adapter::{
    ConfigError, EngineDiagnostic, LintError as EngineLintError, SourceKindError, TypeLintError,
};
use tsrx_syntax::ProjectionError;

/// Why a native lint run produced no report.
///
/// [`Self::Projection`] is the one variant the filesystem lane turns into a diagnostic instead of
/// a command failure: it is a syntax error in the user's own TSRX file and it carries the
/// [`ProjectionError`] that positions it. Every other variant is a genuine tool failure, so the
/// batch stops. The in-memory lane keeps returning `Projection` as an error, because the editor
/// boundary in `oxc_tsrx_cli::lsp` renders it as its own LSP diagnostic.
#[derive(Debug)]
pub enum LintError {
    /// A source file could not be read.
    UnreadableSource { path: PathBuf, error: io::Error },
    /// A fixed source could not be written back.
    UnwritableSource { path: PathBuf, error: io::Error },
    /// [`LintSession::lint_text`](crate::LintSession::lint_text) was called on a fixing session.
    TextLintWithFixes,
    /// [`LintSession::code_actions`](crate::LintSession::code_actions) needs a fixing session.
    CodeActionsWithoutFixes,
    /// The authored path carries no extension this linter can project.
    SourceKind(SourceKindError),
    /// The TSRX source could not be scanned or projected.
    Projection(ProjectionError),
    /// The Oxlint configuration could not be compiled.
    Config(ConfigError),
    /// The syntax lane failed.
    Syntax(EngineLintError),
    /// The type-aware lane failed.
    TypeAware(TypeLintError),
    /// Canonical OXC refused the projected copy of one file. The diagnostics are the parser's
    /// own, already mapped back to authored offsets where the projection could, so a batch
    /// reports this file by name and position and goes on to the next one (tsrx-org/oxc#79).
    Unparsed(Box<UnparsedFile>),
}

/// What canonical OXC said about one file it could not parse, in authored coordinates.
#[derive(Debug)]
pub struct UnparsedFile {
    pub path: PathBuf,
    /// `OXC parse failed` or `OXC semantic analysis failed`: the engine error's own headline.
    pub headline: String,
    /// The joined engine text, for the one-line form.
    pub detail: String,
    pub diagnostics: Vec<EngineDiagnostic>,
}

impl LintError {
    pub(crate) fn unreadable(path: &Path, error: io::Error) -> Self {
        Self::UnreadableSource { path: path.to_path_buf(), error }
    }

    pub(crate) fn unwritable(path: &Path, error: io::Error) -> Self {
        Self::UnwritableSource { path: path.to_path_buf(), error }
    }
}

impl fmt::Display for LintError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnreadableSource { path, error } => {
                write!(formatter, "Unable to read {}: {error}", path.display())
            }
            Self::UnwritableSource { path, error } => {
                write!(formatter, "Unable to write {}: {error}", path.display())
            }
            Self::TextLintWithFixes => {
                formatter.write_str("LintSession::lint_text cannot apply filesystem fixes")
            }
            Self::CodeActionsWithoutFixes => {
                formatter.write_str("LintSession::code_actions requires a fix-enabled session")
            }
            Self::SourceKind(error) => error.fmt(formatter),
            Self::Projection(error) => error.fmt(formatter),
            Self::Config(error) => error.fmt(formatter),
            Self::Syntax(error) => error.fmt(formatter),
            Self::TypeAware(error) => error.fmt(formatter),
            Self::Unparsed(unparsed) => write!(
                formatter,
                "{}: {}: {}",
                unparsed.path.display(),
                unparsed.headline,
                unparsed.detail
            ),
        }
    }
}

impl Error for LintError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::UnreadableSource { error, .. } | Self::UnwritableSource { error, .. } => {
                Some(error)
            }
            Self::SourceKind(error) => Some(error),
            Self::Projection(error) => Some(error),
            Self::Config(error) => Some(error),
            Self::Syntax(error) => Some(error),
            Self::TypeAware(error) => Some(error),
            Self::TextLintWithFixes | Self::CodeActionsWithoutFixes | Self::Unparsed(_) => None,
        }
    }
}

impl From<SourceKindError> for LintError {
    fn from(error: SourceKindError) -> Self {
        Self::SourceKind(error)
    }
}

impl From<ProjectionError> for LintError {
    fn from(error: ProjectionError) -> Self {
        Self::Projection(error)
    }
}

impl From<ConfigError> for LintError {
    fn from(error: ConfigError) -> Self {
        Self::Config(error)
    }
}

impl From<EngineLintError> for LintError {
    fn from(error: EngineLintError) -> Self {
        Self::Syntax(error)
    }
}

impl From<TypeLintError> for LintError {
    fn from(error: TypeLintError) -> Self {
        Self::TypeAware(error)
    }
}

// `oxc_tsrx_cli` and `oxc_tsrx_benchmark` still funnel every failure into `Result<_, String>`,
// because their contract is the exact text they print and their exit codes. `?` at
// `oxc_tsrx_cli/src/lint.rs:67,76,89`, `oxc_tsrx_benchmark/src/in_process.rs:58,81` and
// `oxc_tsrx_benchmark/src/process.rs:215,221` needs this conversion, and it renders exactly
// `Display`, so the text those binaries print is unchanged.
impl From<LintError> for String {
    fn from(error: LintError) -> Self {
        error.to_string()
    }
}

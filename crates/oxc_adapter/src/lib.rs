//! The only revision-specific boundary between OXC for TSRX and canonical OXC crates.

use std::{error::Error, fmt, path::Path};

use oxc_span::SourceType;

#[cfg(feature = "parser")]
pub mod parser;

#[cfg(feature = "editor")]
pub mod editor;

#[cfg(any(feature = "parser", feature = "toolchain"))]
mod dynamic_tags;

#[cfg(any(feature = "parser", feature = "toolchain"))]
pub use dynamic_tags::DynamicTagError;

#[cfg(feature = "parser")]
pub(crate) use dynamic_tags::validate_dynamic_tags_with_synthetic_calls;

#[cfg(feature = "toolchain")]
pub(crate) use dynamic_tags::validate_dynamic_tags;

#[cfg(feature = "toolchain")]
mod toolchain;

#[cfg(feature = "toolchain")]
pub use toolchain::{
    ConfigError, EngineDiagnostic, EngineFix, EngineFormatResult, EngineSpan, EngineTimings,
    FormatEngineTimings, FormatError, FormatOptionError, FormatOptions, FormatRequest, FramePart,
    JsPluginFreeLintConfig, LintEngine, LintEngineOptions, LintError, LintRequest, LintResult,
    RuleFilter, RuleSeverity, SUPPORTED_TSGOLINT_VERSION, TsgolintError, TypeBatchDiagnostic,
    TypeBatchFile, TypeBatchResult, TypeLintError, TypeLintRequest, TypeLintResult, format, lint,
    lint_config_without_js_plugins, write_check_report_path,
};

pub const OXC_REVISION: &str = "5a6e37e5cf895143a5b34050c50109c46e2ae96a";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    JavaScript,
    JavaScriptReact,
    TypeScript,
    TypeScriptReact,
}

/// A path whose extension is outside the `.js`, `.jsx`, `.ts`, and `.tsx` families.
///
/// This is the only way [`SourceKind::from_path`] fails, so it is a struct rather than a
/// single-variant enum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceKindError {
    extension: Option<String>,
}

impl SourceKindError {
    /// The rejected extension, or `None` when the path carried none at all.
    #[must_use]
    pub fn extension(&self) -> Option<&str> {
        self.extension.as_deref()
    }
}

impl fmt::Display for SourceKindError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Unsupported source extension: {:?}", self.extension)
    }
}

impl Error for SourceKindError {}

impl SourceKind {
    /// Infers the canonical OXC source type from a standard JavaScript/TypeScript path.
    ///
    /// # Errors
    ///
    /// Returns [`SourceKindError`] for extensions outside `.js`, `.jsx`, `.ts`, and `.tsx`
    /// families.
    pub fn from_path(path: &Path) -> Result<Self, SourceKindError> {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("js" | "mjs" | "cjs") => Ok(Self::JavaScript),
            Some("jsx") => Ok(Self::JavaScriptReact),
            Some("ts" | "mts" | "cts") => Ok(Self::TypeScript),
            Some("tsx") => Ok(Self::TypeScriptReact),
            extension => Err(SourceKindError { extension: extension.map(ToString::to_string) }),
        }
    }

    pub(crate) fn source_type(self) -> SourceType {
        match self {
            Self::JavaScript => SourceType::unambiguous(),
            Self::JavaScriptReact => SourceType::jsx(),
            Self::TypeScript => SourceType::ts(),
            Self::TypeScriptReact => SourceType::tsx(),
        }
    }
}

/// Collision-free scaffold contract for validating TSRX dynamic names in an existing OXC AST.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DynamicTagContract<'a> {
    pub prefix: &'a str,
    pub count: u32,
    pub original_offsets: &'a [u32],
}

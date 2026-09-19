//! Lint, format, type-aware, and editor surfaces enabled by the default `toolchain` feature.

mod config;
mod diagnostics;
mod engine;
mod format;
mod session;
mod timings;
mod tsgolint;

pub use config::{ConfigError, JsPluginFreeLintConfig, lint_config_without_js_plugins};
pub use diagnostics::{EngineDiagnostic, EngineFix, EngineSpan};
pub use engine::{LintEngine, LintEngineOptions};
pub use format::{
    EngineFormatResult, FormatError, FormatOptionError, FormatOptions, FormatRequest,
    count_expanded_objects, format, write_check_report_path,
};
pub use session::{
    LintError, LintRequest, LintResult, TypeBatchDiagnostic, TypeBatchFile, TypeBatchResult,
    TypeLintError, TypeLintRequest, TypeLintResult, lint,
};
pub use timings::{EngineTimings, FormatEngineTimings};
pub use tsgolint::{FramePart, SUPPORTED_TSGOLINT_VERSION, TsgolintError};

// The three binary crates still funnel every failure into `Result<_, String>`, because their
// contract is the exact text they print to stderr and their exit codes. `?` at
// `oxc_tsrx_benchmark/src/main.rs:103` (`LintEngine::new`),
// `oxc_tsrx_benchmark/src/in_process.rs:39` (`LintEngine::lint`) and
// `oxc_tsrx_format_benchmark/src/in_process.rs:12` (`format`) needs these conversions. Each one
// renders exactly `Display`, so the text those binaries print is unchanged.
impl From<ConfigError> for String {
    fn from(error: ConfigError) -> Self {
        error.to_string()
    }
}

impl From<LintError> for String {
    fn from(error: LintError) -> Self {
        error.to_string()
    }
}

impl From<FormatError> for String {
    fn from(error: FormatError) -> Self {
        error.to_string()
    }
}

// `RuleSeverity` and `RuleFilter` are defined here rather than in a submodule because
// `tsrx_lint`'s own public API names `oxc_adapter::toolchain::RuleFilter`, and `rustdoc` records
// the *defining* module of a foreign type. Moving either one into `toolchain::<submodule>` rewrites
// four lines of `tsrx_lint`'s frozen public surface without changing a single signature. The frozen
// surface outranks the "mod.rs carries no logic" layout rule; `tests/architecture.rs` pins this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleSeverity {
    Allow,
    Warn,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleFilter {
    pub severity: RuleSeverity,
    pub name: String,
}

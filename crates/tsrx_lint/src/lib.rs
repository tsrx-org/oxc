//! Native lint orchestration and identity-only TSRX fix mapping.

mod error;
mod fixes;
mod imports;
mod pipeline;
mod proxy;
mod report;
mod session;
mod translate;

pub use error::{LintError, UnparsedFile};
pub use oxc_adapter::{RuleFilter as ConfigRuleFilter, RuleSeverity as ConfigRuleSeverity};
pub use proxy::{OverlaidPayload, overlay_imported_tsrx};
pub use report::{
    DiagnosticOutput, EditorFix, FileCounts, FixOutput, LabelOutput, Metadata, Output, SpanOutput,
    TimingOutput,
};
pub use session::LintSession;
pub use translate::{PluginLabel, PluginProjection};

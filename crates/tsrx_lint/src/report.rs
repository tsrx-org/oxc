//! The serialized shape the CLI, the editor, and the benchmarks all consume, and the aggregation
//! that folds a whole batch into one of them.

use std::collections::HashSet;
use std::path::Path;
use std::thread::{self, ThreadId};

use oxc_adapter::{EngineDiagnostic, OXC_REVISION};
use serde::Serialize;
use tsrx_syntax::ProjectionError;

use crate::{error::UnparsedFile, session::LintSession};

#[derive(Debug, Serialize)]
pub struct SpanOutput {
    pub offset: u32,
    pub length: u32,
}

#[derive(Debug, Serialize)]
pub struct LabelOutput {
    pub span: SpanOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticOutput {
    pub filename: String,
    pub rule: String,
    pub code: String,
    pub severity: String,
    pub message: String,
    pub labels: Vec<LabelOutput>,
}

/// One safe authored-source edit exposed to an editor without writing the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFix {
    pub title: String,
    pub rule: String,
    pub offset: u32,
    pub length: u32,
    pub replacement: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingOutput {
    pub config_ns: u64,
    pub scan_ns: u64,
    pub projection_ns: u64,
    pub parse_ns: u64,
    pub semantic_ns: u64,
    pub lint_ns: u64,
    pub type_aware_ns: u64,
}

#[derive(Debug, Default, Serialize)]
pub struct FileCounts {
    pub tsrx: u32,
    pub standard: u32,
}

#[derive(Debug, Default, Serialize)]
pub struct FixOutput {
    pub applied: u32,
    pub rejected: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub native: bool,
    pub engine: &'static str,
    pub oxc_revision: &'static str,
    pub mode: &'static str,
    pub config_loads: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    pub parse_count: u32,
    pub reparse_count: u32,
    pub files: FileCounts,
    pub timings: TimingOutput,
    pub projection_bytes: usize,
    pub diagnostics_suppressed: u32,
    pub fixes: FixOutput,
    pub type_aware: bool,
    pub type_check: bool,
    pub type_aware_files: u32,
    pub type_aware_processes: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Output {
    pub diagnostics: Vec<DiagnosticOutput>,
    pub number_of_files: u32,
    pub number_of_rules: usize,
    /// How many threads this run actually linted on.
    ///
    /// Canonical Oxlint closes a report with `Finished in <t> on <n> files with <r> rules using
    /// <threads> threads.`, and the tools that read Oxlint - Vite+ among them - want the whole
    /// pair of summary lines. A batch of nothing but `.tsrx` files never reaches canonical Oxlint
    /// at all, so this is the only half that can supply the number for it, and a report that
    /// invents one is the class of defect this field exists to remove.
    ///
    /// It is counted, never assumed. Every per-file output records the thread that produced it and
    /// [`aggregate_outputs`] counts the distinct ones, so the value follows the code: today the
    /// batch is walked sequentially and the answer is 1, and if that walk is ever parallelised the
    /// report says so without anyone remembering to update it here.
    pub threads_count: u32,
    /// The thread this output was produced on, folded into `threads_count` by
    /// [`aggregate_outputs`] and never serialized - the report carries the count, not the ids.
    #[serde(skip)]
    pub(crate) lint_thread: ThreadId,
    #[serde(rename = "oxcTsrx")]
    pub metadata: Metadata,
}

pub(crate) fn aggregate_outputs(session: &LintSession, outputs: Vec<Output>) -> Output {
    let mode = if outputs.len() == 1 { outputs[0].metadata.mode } else { "batch" };
    let mut diagnostics = Vec::new();
    let mut number_of_files = 0_u32;
    let mut parse_count = 0_u32;
    let mut reparse_count = 0_u32;
    let mut file_counts = FileCounts::default();
    let mut timings =
        TimingOutput { config_ns: session.engine.config_load_ns(), ..TimingOutput::default() };
    let mut projection_bytes = 0_usize;
    let mut diagnostics_suppressed = 0_u32;
    let mut fix_counts = FixOutput { applied: 0, rejected: 0 };
    let mut type_aware_files = 0_u32;
    let mut type_aware_processes = 0_u32;
    // Seeded with the folding thread so a batch that linted nothing still reports the one thread
    // that ran it, rather than the zero threads a summary line would then have to print.
    let mut lint_threads = HashSet::from([thread::current().id()]);
    for output in outputs {
        lint_threads.insert(output.lint_thread);
        number_of_files = number_of_files.saturating_add(output.number_of_files);
        parse_count = parse_count.saturating_add(output.metadata.parse_count);
        reparse_count = reparse_count.saturating_add(output.metadata.reparse_count);
        file_counts.tsrx = file_counts.tsrx.saturating_add(output.metadata.files.tsrx);
        file_counts.standard = file_counts.standard.saturating_add(output.metadata.files.standard);
        timings.scan_ns = timings.scan_ns.saturating_add(output.metadata.timings.scan_ns);
        timings.projection_ns =
            timings.projection_ns.saturating_add(output.metadata.timings.projection_ns);
        timings.parse_ns = timings.parse_ns.saturating_add(output.metadata.timings.parse_ns);
        timings.semantic_ns =
            timings.semantic_ns.saturating_add(output.metadata.timings.semantic_ns);
        timings.lint_ns = timings.lint_ns.saturating_add(output.metadata.timings.lint_ns);
        timings.type_aware_ns =
            timings.type_aware_ns.saturating_add(output.metadata.timings.type_aware_ns);
        projection_bytes = projection_bytes.saturating_add(output.metadata.projection_bytes);
        diagnostics_suppressed =
            diagnostics_suppressed.saturating_add(output.metadata.diagnostics_suppressed);
        fix_counts.applied = fix_counts.applied.saturating_add(output.metadata.fixes.applied);
        fix_counts.rejected = fix_counts.rejected.saturating_add(output.metadata.fixes.rejected);
        type_aware_files = type_aware_files.saturating_add(output.metadata.type_aware_files);
        type_aware_processes =
            type_aware_processes.saturating_add(output.metadata.type_aware_processes);
        diagnostics.extend(output.diagnostics);
    }
    Output {
        diagnostics,
        number_of_files,
        number_of_rules: session.engine.number_of_rules(),
        threads_count: u32::try_from(lint_threads.len()).unwrap_or(u32::MAX),
        lint_thread: thread::current().id(),
        metadata: Metadata {
            native: true,
            engine: "oxc_linter",
            oxc_revision: OXC_REVISION,
            mode,
            config_loads: session.engine.config_loads(),
            config_path: session
                .engine
                .config_path()
                .map(|path| path.to_string_lossy().into_owned()),
            parse_count,
            reparse_count,
            files: file_counts,
            timings,
            projection_bytes,
            diagnostics_suppressed,
            fixes: fix_counts,
            type_aware: session.engine.type_aware_enabled(),
            type_check: session.engine.type_check_enabled(),
            type_aware_files,
            type_aware_processes,
        },
    }
}

/// Build the one-diagnostic report that stands in for a TSRX file the scanner could not project.
///
/// The diagnostic carries the filename and, for the four offset-bearing failures, the authored
/// byte offset in `labels[0].span.offset`, which is the same shape every other diagnostic uses.
/// It carries no rule and no code because there is no rule to disable; the failure is the source
/// itself. The nine positionless failures get no label rather than a fabricated offset 0.
pub(crate) fn projection_failure_output(
    session: &LintSession,
    path: &Path,
    error: &ProjectionError,
) -> Output {
    let labels = error
        .byte_offset()
        .map(|offset| LabelOutput { span: SpanOutput { offset, length: 0 }, message: None })
        .into_iter()
        .collect();
    failure_shell(
        session,
        vec![DiagnosticOutput {
            filename: path.to_string_lossy().into_owned(),
            rule: String::new(),
            code: String::new(),
            severity: "error".to_string(),
            message: error.to_string(),
            labels,
        }],
    )
}

/// The one-file report shell shared by every failure that stands in for a lint result.
fn failure_shell(session: &LintSession, diagnostics: Vec<DiagnosticOutput>) -> Output {
    Output {
        diagnostics,
        number_of_files: 1,
        number_of_rules: session.engine.number_of_rules(),
        threads_count: 1,
        lint_thread: thread::current().id(),
        metadata: Metadata {
            native: true,
            engine: "oxc_linter",
            oxc_revision: OXC_REVISION,
            mode: "mapped_projection",
            config_loads: 0,
            config_path: None,
            parse_count: 0,
            reparse_count: 0,
            files: FileCounts { tsrx: 1, standard: 0 },
            timings: TimingOutput::default(),
            projection_bytes: 0,
            diagnostics_suppressed: 0,
            fixes: FixOutput::default(),
            type_aware: session.engine.type_aware_enabled(),
            type_check: session.engine.type_check_enabled(),
            type_aware_files: 0,
            type_aware_processes: 0,
        },
    }
}

/// The report for a file canonical OXC could not parse: one `error` per parser diagnostic,
/// named by file and positioned where the projection could map the parser's span back to the
/// authored source. Same rule-less, code-less shape as a projection failure, because the
/// failure is the source itself. When no span maps, the joined engine text stands alone so the
/// file is still named.
pub(crate) fn parse_failure_output(session: &LintSession, unparsed: &UnparsedFile) -> Output {
    let filename = unparsed.path.to_string_lossy().into_owned();
    let mut diagnostics = unparsed
        .diagnostics
        .iter()
        .map(|diagnostic| DiagnosticOutput {
            filename: filename.clone(),
            rule: String::new(),
            code: String::new(),
            severity: "error".to_string(),
            message: format!("{}: {}", unparsed.headline, diagnostic.message),
            labels: diagnostic
                .labels
                .iter()
                .map(|label| LabelOutput {
                    span: SpanOutput { offset: label.offset, length: label.length },
                    message: label.message.clone(),
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    if diagnostics.is_empty() {
        diagnostics.push(DiagnosticOutput {
            filename,
            rule: String::new(),
            code: String::new(),
            severity: "error".to_string(),
            message: format!("{}: {}", unparsed.headline, unparsed.detail),
            labels: Vec::new(),
        });
    }
    let mut output = failure_shell(session, diagnostics);
    output.metadata.parse_count = 1;
    output
}

pub(crate) fn map_diagnostics(
    path: &Path,
    diagnostics: Vec<EngineDiagnostic>,
    applied_rules: &[String],
) -> Vec<DiagnosticOutput> {
    let filename = path.to_string_lossy().into_owned();
    diagnostics
        .into_iter()
        .filter(|diagnostic| {
            !diagnostic
                .rule
                .as_ref()
                .is_some_and(|rule| applied_rules.iter().any(|applied| applied == rule))
        })
        .map(|diagnostic| DiagnosticOutput {
            filename: filename.clone(),
            rule: diagnostic.rule.clone().unwrap_or_else(|| "parse-error".to_string()),
            code: diagnostic_code(&diagnostic),
            severity: diagnostic.severity,
            message: diagnostic.message,
            labels: diagnostic
                .labels
                .into_iter()
                .map(|label| LabelOutput {
                    span: SpanOutput { offset: label.offset, length: label.length },
                    message: label.message,
                })
                .collect(),
        })
        .collect()
}

pub(crate) fn diagnostic_code(diagnostic: &EngineDiagnostic) -> String {
    if !diagnostic.code.is_empty() {
        return diagnostic.code.clone();
    }
    match (&diagnostic.plugin, &diagnostic.rule) {
        (Some(plugin), Some(rule)) => format!("{plugin}({rule})"),
        _ => "oxc".to_string(),
    }
}

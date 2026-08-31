mod indexed_source;
mod ordinary;
mod result_serializer;
mod tape_serializer;

use std::{borrow::Cow, error::Error, fmt};

use indexed_source::IndexedSource;
use miette::{Diagnostic, GraphicalReportHandler, GraphicalTheme, Labels, Related, SourceCode};
use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_diagnostics::{LabeledSpan, OxcDiagnostic, Severity};
use oxc_estree::ESTree;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use tsrx_tape_schema::{
    CommentTable, DiagnosticPhase, DiagnosticRecord, DiagnosticSeverity, DiagnosticTable, FlatTape,
    ModuleTable, RecordIndex, TapeBuildError,
};

use crate::{
    DynamicTagContract, DynamicTagError, SourceKind, validate_dynamic_tags_with_synthetic_calls,
};
pub use ordinary::{
    OrdinaryComment, OrdinaryDiagnostic, OrdinaryDiagnosticLabel, OrdinaryDynamicImport,
    OrdinaryExportExportName, OrdinaryExportImportName, OrdinaryExportLocalName,
    OrdinaryImportName, OrdinaryModule, OrdinaryNameKind, OrdinaryParseRequest,
    OrdinaryParseResult, OrdinarySpan, OrdinaryStaticExport, OrdinaryStaticExportEntry,
    OrdinaryStaticImport, OrdinaryStaticImportEntry, OrdinaryValueSpan, parse_ordinary,
};
use result_serializer::{
    append_diagnostics, serialize_comments, serialize_module, serialize_rejection_module_names,
};
use tape_serializer::FlatTapeSerializer;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectionMetadata {
    None,
    ModuleNames,
}

impl RejectionMetadata {
    const fn retains_module_names(self) -> bool {
        matches!(self, Self::ModuleNames)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ProjectedParseRecovery {
    #[default]
    None,
    Editor,
}

#[derive(Debug, Clone, Copy)]
pub struct ProjectedParseRequest<'a> {
    pub filename: &'a str,
    pub source: &'a str,
    pub source_type: Option<&'a str>,
    pub include_ts_fields: bool,
    pub ranges: bool,
    pub preserve_parens: Option<bool>,
    pub show_semantic_errors: bool,
    /// Retain OXC's partial Program when syntax diagnostics are present.
    pub recovery: ProjectedParseRecovery,
    /// Private metadata retained solely for rare UTF-16 rejection arbitration.
    pub rejection_metadata: RejectionMetadata,
    pub dynamic_tags: Option<DynamicTagContract<'a>>,
    pub synthetic_callee_spans: &'a [(u32, u32)],
}

#[derive(Debug)]
pub struct ProjectedParseResult {
    /// Number of public OXC parser invocations used to produce this result.
    pub parse_count: u32,
    pub program: Option<FlatTape>,
    pub module: Option<ModuleTable>,
    /// Raw module-name spans retained only to classify source-order grammar rejections.
    pub rejection_module_names: RejectionModuleNames,
    pub comments: CommentTable,
    pub errors: DiagnosticTable,
    /// Parser diagnostics intentionally omitted by the TSRX compatibility route.
    pub suppressed_diagnostics: u32,
    pub authored_grammar: Option<AuthoredGrammarFailure>,
    pub syntax_failed: bool,
    pub panicked: bool,
}

#[derive(Debug)]
pub struct AuthoredGrammarFailure {
    pub message: String,
    pub offset: u32,
}

#[derive(Debug)]
pub struct FailedTsrxMetadata {
    /// Number of public OXC parser invocations used to produce this metadata.
    pub parse_count: u32,
    pub comments: CommentTable,
    /// Grammar diagnostics retained only for rare UTF-16 rejection arbitration.
    pub errors: DiagnosticTable,
    /// Raw module-name spans retained only for rare UTF-16 rejection arbitration.
    pub rejection_module_names: RejectionModuleNames,
}

fn is_tsrx_compatible_grammar_diagnostic(source: &str, diagnostic: &OxcDiagnostic) -> bool {
    if diagnostic.code.scope.as_deref() != Some("TS") {
        return false;
    }
    if diagnostic.code.number.as_deref() == Some("1147") {
        return true;
    }
    if diagnostic.code.number.as_deref() != Some("18007") {
        return false;
    }

    // With `preserve_parens: false`, OXC drops this evidence before validating JSX and reports
    // TS18007 for an authored parenthesized sequence expression. The reference parser accepts the
    // expression, and OXC still constructs its correct SequenceExpression node.
    let bytes = source.as_bytes();
    diagnostic.labels.iter().any(|label| {
        let Ok(start) = usize::try_from(label.offset()) else {
            return false;
        };
        let Ok(length) = usize::try_from(label.len()) else {
            return false;
        };
        let Some(end) = start.checked_add(length) else {
            return false;
        };
        start.checked_sub(1).and_then(|index| bytes.get(index)) == Some(&b'(')
            && bytes.get(end) == Some(&b')')
    })
}

fn append_tsrx_grammar_diagnostics(
    output: &mut DiagnosticTable,
    source: &str,
    diagnostics: &[OxcDiagnostic],
) -> Result<(bool, u32), TapeBuildError> {
    let compatible =
        |diagnostic: &&OxcDiagnostic| is_tsrx_compatible_grammar_diagnostic(source, diagnostic);
    append_diagnostics(
        output,
        diagnostics.iter().filter(|diagnostic| !compatible(diagnostic)),
        DiagnosticPhase::Grammar,
    )?;
    let suppressed = u32::try_from(diagnostics.iter().filter(compatible).count())
        .map_err(|_| TapeBuildError::CapacityOverflow)?;
    let retained = diagnostics.len()
        != usize::try_from(suppressed).map_err(|_| TapeBuildError::CapacityOverflow)?;
    Ok((retained, suppressed))
}

/// Revision-neutral import/export name spans retained on a failed one-parse route.
///
/// This carrier intentionally owns no source text, parser nodes, or module requests.
#[doc(hidden)]
#[derive(Debug, Default)]
pub struct RejectionModuleNames {
    spans: Vec<tsrx_tape_schema::TapeSpan>,
}

impl RejectionModuleNames {
    /// Returns the retained import/export name spans.
    #[doc(hidden)]
    #[must_use]
    pub fn spans(&self) -> &[tsrx_tape_schema::TapeSpan] {
        &self.spans
    }

    /// Maps every retained span exactly once.
    #[doc(hidden)]
    pub fn try_map_spans<E>(
        &mut self,
        mut map: impl FnMut(tsrx_tape_schema::TapeSpan) -> Result<tsrx_tape_schema::TapeSpan, E>,
    ) -> Result<(), E> {
        for span in &mut self.spans {
            *span = map(*span)?;
        }
        Ok(())
    }

    fn push(&mut self, span: oxc_span::Span) {
        self.spans.push(tsrx_tape_schema::TapeSpan::new(span.start, span.end));
    }
}

#[derive(Debug, Default)]
struct PublicOxcParseCounter(u32);

impl PublicOxcParseCounter {
    fn invoke<T>(&mut self, parse: impl FnOnce() -> T) -> T {
        self.0 = self.0.saturating_add(1);
        parse()
    }

    const fn count(&self) -> u32 {
        self.0
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProjectedParseError {
    Tape(TapeBuildError),
    Invariant(String),
}

impl fmt::Display for ProjectedParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Tape(error) => error.fmt(formatter),
            Self::Invariant(message) => {
                write!(formatter, "projected OXC invariant failed: {message}")
            }
        }
    }
}

impl Error for ProjectedParseError {}

impl From<TapeBuildError> for ProjectedParseError {
    fn from(error: TapeBuildError) -> Self {
        Self::Tape(error)
    }
}

/// Parses one legal projected TSX source into an owned revision-neutral flat tape.
///
/// The OXC allocator, AST, parser return, and serializer borrow all die before this function
/// returns. Syntax diagnostics fail closed unless the request explicitly enables recovery.
///
/// # Errors
///
/// Returns [`TapeBuildError`] if the owned 32-bit tape cannot represent the parsed program.
pub fn parse_to_projected_tape(
    request: ProjectedParseRequest<'_>,
) -> Result<ProjectedParseResult, ProjectedParseError> {
    parse_to_projected_tape_with_retention(request, true)
}

/// Parses one projected source without serializing its successful module record.
///
/// This is private transport support for a consumer whose public result contains only Program and
/// diagnostics. Syntax-failure metadata and every parser/Program invariant remain unchanged.
#[doc(hidden)]
pub fn parse_to_projected_tape_program_only(
    request: ProjectedParseRequest<'_>,
) -> Result<ProjectedParseResult, ProjectedParseError> {
    parse_to_projected_tape_with_retention(request, false)
}

fn parse_to_projected_tape_with_retention(
    request: ProjectedParseRequest<'_>,
    retain_module: bool,
) -> Result<ProjectedParseResult, ProjectedParseError> {
    let allocator = Allocator::default();
    let mut parse_counter = PublicOxcParseCounter::default();
    let source_type = match request.source_type {
        Some("script") => SourceKind::TypeScriptReact.source_type().with_script(true),
        Some("module") => SourceKind::TypeScriptReact.source_type().with_module(true),
        Some("commonjs") => SourceKind::TypeScriptReact.source_type().with_commonjs(true),
        Some("unambiguous") | None => {
            SourceKind::TypeScriptReact.source_type().with_unambiguous(true)
        }
        Some(_) => SourceKind::TypeScriptReact.source_type(),
    };
    let parsed = parse_counter.invoke(|| {
        Parser::new(&allocator, request.source, source_type)
            .with_options(ParseOptions {
                preserve_parens: request.preserve_parens.unwrap_or(true),
                ..ParseOptions::default()
            })
            .parse()
    });
    let comments = serialize_comments(&parsed.program, request.source)?;
    let mut errors = DiagnosticTable::default();
    // The reference TSRX parser accepts two shapes for which OXC constructs the right AST but
    // additionally emits a TypeScript grammar diagnostic. Keep every other diagnostic fail-closed.
    let (has_retained_diagnostics, suppressed_diagnostics) =
        append_tsrx_grammar_diagnostics(&mut errors, request.source, &parsed.diagnostics)?;
    let syntax_failed = parsed.panicked || has_retained_diagnostics;
    if syntax_failed && (request.recovery != ProjectedParseRecovery::Editor || parsed.panicked) {
        let rejection_module_names = match request.rejection_metadata {
            RejectionMetadata::None => RejectionModuleNames::default(),
            RejectionMetadata::ModuleNames => {
                serialize_rejection_module_names(&parsed.module_record, request.source)
            }
        };
        return Ok(ProjectedParseResult {
            parse_count: parse_counter.count(),
            program: None,
            module: None,
            rejection_module_names,
            comments,
            errors,
            suppressed_diagnostics,
            authored_grammar: None,
            syntax_failed: true,
            panicked: parsed.panicked,
        });
    }
    if let Err(error) = validate_dynamic_tags_with_synthetic_calls(
        &parsed.program,
        request.dynamic_tags,
        request.synthetic_callee_spans,
    ) {
        return match error {
            DynamicTagError::AuthoredGrammar { offset, .. } => {
                let rejection_module_names = match request.rejection_metadata {
                    RejectionMetadata::None => RejectionModuleNames::default(),
                    RejectionMetadata::ModuleNames => {
                        serialize_rejection_module_names(&parsed.module_record, request.source)
                    }
                };
                Ok(ProjectedParseResult {
                    parse_count: parse_counter.count(),
                    program: None,
                    module: None,
                    rejection_module_names,
                    comments,
                    errors,
                    suppressed_diagnostics,
                    authored_grammar: Some(AuthoredGrammarFailure {
                        message: error.to_string(),
                        offset,
                    }),
                    syntax_failed: true,
                    panicked: false,
                })
            }
            // Every other variant describes an inconsistent scaffold contract, which is a
            // projector or adapter defect rather than anything the author wrote.
            _ => Err(ProjectedParseError::Invariant(error.to_string())),
        };
    }
    if request.show_semantic_errors && !syntax_failed {
        let semantic = SemanticBuilder::new_compiler().build(&parsed.program);
        append_diagnostics(&mut errors, semantic.diagnostics.iter(), DiagnosticPhase::Semantic)?;
    }
    let module = retain_module
        .then(|| serialize_module(&parsed.program, &parsed.module_record))
        .transpose()?;
    let program = serialize_program(&parsed.program, request.include_ts_fields, request.ranges)?;
    Ok(ProjectedParseResult {
        parse_count: parse_counter.count(),
        program: Some(program),
        module,
        // The complete public ModuleTable is authoritative on success. Raw rejection-only spans
        // would duplicate its names and scale with unrelated module records.
        rejection_module_names: RejectionModuleNames::default(),
        comments,
        errors,
        suppressed_diagnostics,
        authored_grammar: None,
        syntax_failed,
        panicked: parsed.panicked,
    })
}

/// Preserves metadata OXC lexed before a scanner-origin TSRX grammar failure.
///
/// This is the scanner-failure route's sole public-OXC parse. It copies comments while the
/// allocator and partial Program are alive and never serializes or returns a partial Program.
/// Partial module metadata is serialized only when explicitly requested by the rare UTF-16
/// rejection-arbitration path.
///
/// # Errors
///
/// Returns [`ProjectedParseError`] when an owned table exceeds its 32-bit limits or partial module
/// metadata violates the pinned adapter invariants.
pub fn parse_failed_tsrx_metadata(
    source: &str,
    rejection_metadata: RejectionMetadata,
) -> Result<FailedTsrxMetadata, ProjectedParseError> {
    let allocator = Allocator::default();
    let mut parse_counter = PublicOxcParseCounter::default();
    let parsed = parse_counter.invoke(|| {
        Parser::new(&allocator, source, SourceKind::TypeScriptReact.source_type()).parse()
    });
    let comments = serialize_comments(&parsed.program, source)?;
    let mut errors = DiagnosticTable::default();
    if rejection_metadata.retains_module_names() {
        append_diagnostics(&mut errors, parsed.diagnostics.iter(), DiagnosticPhase::Grammar)?;
    }
    let rejection_module_names = match rejection_metadata {
        RejectionMetadata::None => RejectionModuleNames::default(),
        RejectionMetadata::ModuleNames => {
            serialize_rejection_module_names(&parsed.module_record, source)
        }
    };
    Ok(FailedTsrxMetadata {
        parse_count: parse_counter.count(),
        comments,
        errors,
        rejection_module_names,
    })
}

/// Renders pinned-OXC codeframes after TSRX spans have been reconstructed into authored bytes.
///
/// OXC types and the borrowed indexed source remain inside this revision-local adapter call. The
/// result table retains only owned strings and revision-neutral records.
///
/// # Errors
///
/// Returns an invariant or 32-bit tape error for an invalid neutral diagnostic table.
pub fn render_diagnostic_codeframes(
    filename: &str,
    source: &str,
    diagnostics: &mut DiagnosticTable,
) -> Result<(), ProjectedParseError> {
    if diagnostics.is_empty() {
        return Ok(());
    }
    let indexed_source = IndexedSource::new(filename, source);
    // Pin the theme. `GraphicalReportHandler::new()` picks its theme from runtime
    // terminal detection, and `supports-color` treats CI as colour capable, so the
    // same source produced ANSI-escaped unicode under GitHub Actions and plain
    // ASCII locally. These codeframes are stored in the diagnostic table and travel
    // on to LSP and JSON consumers rather than to a terminal, so escape codes are
    // never wanted and the bytes must not depend on the environment.
    let handler = GraphicalReportHandler::new_themed(GraphicalTheme::none());
    for index in 0..diagnostics.len() {
        let record = diagnostics.records()[index];
        let diagnostic = rebuild_diagnostic(diagnostics, &record)?;
        let sourced = SourcedDiagnostic { diagnostic: &diagnostic, source: &indexed_source };
        let index = u32::try_from(index)
            .map(RecordIndex::new)
            .map_err(|_| TapeBuildError::CapacityOverflow)?;
        diagnostics
            .write_codeframe(index, |writer| handler.render_report(writer, &sourced))?
            .map_err(|_| {
                ProjectedParseError::Invariant("failed to render diagnostic codeframe".to_string())
            })?;
    }
    Ok(())
}

struct SourcedDiagnostic<'a> {
    diagnostic: &'a OxcDiagnostic,
    source: &'a IndexedSource<'a>,
}

impl fmt::Debug for SourcedDiagnostic<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.diagnostic.fmt(formatter)
    }
}

impl fmt::Display for SourcedDiagnostic<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self.diagnostic, formatter)
    }
}

impl Error for SourcedDiagnostic<'_> {}

impl Diagnostic for SourcedDiagnostic<'_> {
    fn code(&self) -> Option<Cow<'_, str>> {
        Diagnostic::code(self.diagnostic)
    }

    fn severity(&self) -> Option<miette::Severity> {
        Diagnostic::severity(self.diagnostic)
    }

    fn help(&self) -> Option<Cow<'_, str>> {
        Diagnostic::help(self.diagnostic)
    }

    fn note(&self) -> Option<Cow<'_, str>> {
        Diagnostic::note(self.diagnostic)
    }

    fn url(&self) -> Option<Cow<'_, str>> {
        Diagnostic::url(self.diagnostic)
    }

    fn source_code(&self) -> Option<&dyn SourceCode> {
        Some(self.source)
    }

    fn labels(&self) -> Labels {
        Diagnostic::labels(self.diagnostic)
    }

    fn related(&self) -> Related<'_> {
        Diagnostic::related(self.diagnostic)
    }

    fn diagnostic_source(&self) -> Option<&dyn Diagnostic> {
        Diagnostic::diagnostic_source(self.diagnostic)
    }
}

fn rebuild_diagnostic(
    table: &DiagnosticTable,
    record: &DiagnosticRecord,
) -> Result<OxcDiagnostic, ProjectedParseError> {
    let message = table.string(record.message).ok_or_else(|| {
        ProjectedParseError::Invariant("invalid diagnostic message range".to_string())
    })?;
    let labels = table.labels(record.labels).ok_or_else(|| {
        ProjectedParseError::Invariant("invalid diagnostic label range".to_string())
    })?;
    let labels = labels
        .iter()
        .map(|label| {
            let length = label.span.end.checked_sub(label.span.start).ok_or_else(|| {
                ProjectedParseError::Invariant("reversed diagnostic label".to_string())
            })?;
            let message = optional_diagnostic_string(table, label.message)?.map(str::to_owned);
            let span = (label.span.start, length);
            Ok(if label.primary {
                LabeledSpan::new_primary_with_span(message, span)
            } else {
                LabeledSpan::new_with_span(message, span)
            })
        })
        .collect::<Result<Vec<_>, ProjectedParseError>>()?;
    let mut diagnostic = OxcDiagnostic::error(message.to_owned())
        .with_severity(match record.severity {
            DiagnosticSeverity::Error => Severity::Error,
            DiagnosticSeverity::Warning => Severity::Warning,
            DiagnosticSeverity::Advice => Severity::Advice,
        })
        .with_labels(labels);
    if let Some(help) = optional_diagnostic_string(table, record.help)? {
        diagnostic = diagnostic.with_help(help.to_owned());
    }
    if let Some(note) = optional_diagnostic_string(table, record.note)? {
        diagnostic = diagnostic.with_note(note.to_owned());
    }
    if let Some(scope) = optional_diagnostic_string(table, record.code_scope)? {
        diagnostic = diagnostic.with_error_code_scope(scope.to_owned());
    }
    if let Some(number) = optional_diagnostic_string(table, record.code_number)? {
        diagnostic = diagnostic.with_error_code_num(number.to_owned());
    }
    if let Some(url) = optional_diagnostic_string(table, record.url)? {
        diagnostic = diagnostic.with_url(url.to_owned());
    }
    Ok(diagnostic)
}

fn optional_diagnostic_string(
    table: &DiagnosticTable,
    range: tsrx_tape_schema::OptionalStringRange,
) -> Result<Option<&str>, ProjectedParseError> {
    range.get().map_or(Ok(None), |range| {
        table.string(range).map(Some).ok_or_else(|| {
            ProjectedParseError::Invariant("invalid optional diagnostic string range".to_string())
        })
    })
}

fn serialize_program(
    program: &Program<'_>,
    include_ts_fields: bool,
    ranges: bool,
) -> Result<FlatTape, TapeBuildError> {
    let mut serializer = FlatTapeSerializer::new(
        program.source_text.len().saturating_mul(2),
        include_ts_fields,
        ranges,
    );
    program.serialize(&mut serializer);
    serializer.finish()
}

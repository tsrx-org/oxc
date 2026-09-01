//! The UTF-8 route: scan for TSRX syntax, then either hand the source straight to OXC or project
//! it, parse it, and reconstruct the authored tree from the result.

use oxc_adapter::{
    DynamicTagContract,
    parser::{
        ProjectedParseRecovery, ProjectedParseRequest, ProjectedParseResult, RejectionMetadata,
        RejectionModuleNames, parse_failed_tsrx_metadata, parse_to_projected_tape,
        parse_to_projected_tape_program_only, render_diagnostic_codeframes,
    },
};
use tsrx_syntax::{
    Overlay, OverlayView, PARSER_RECOVERY_DIAGNOSTIC, ProjectionView, project_for_parser,
    recover_for_parser, scan_for_parser,
};
use tsrx_tape_schema::{CommentTable, DiagnosticTable, FlatTape, ModuleTable, TapeSpan};

use crate::{
    TsrxParseError, TsrxParseOptions, TsrxParseRecovery, TsrxParseResult,
    grammar_result::{
        adapter_grammar_result, authored_grammar_result, grammar_result,
        grammar_result_with_rejection_module_names, projection_grammar_result,
    },
    lexical, projection,
    reconstruct::{finalize_reachable_spans, reconstruct_projected},
    recovery,
    results::{reconstruct_diagnostics, reconstruct_module},
    utf16_result::Utf16WorkObserver,
};

pub(super) fn parse_tsrx_utf8_source<W: Utf16WorkObserver>(
    source: &str,
    options: TsrxParseOptions<'_>,
    defer_compaction: bool,
    retain_rejection_module_names: bool,
    retain_module: bool,
    observer: &mut W,
) -> Result<TsrxParseResult, TsrxParseError> {
    let recovery_source = (options.recovery == TsrxParseRecovery::Editor)
        .then(|| recover_for_parser(source).map_err(TsrxParseError::from))
        .transpose()?
        .flatten();
    let Some(recovery_source) = recovery_source else {
        return parse_tsrx_utf8_source_once(
            source,
            options,
            defer_compaction,
            retain_rejection_module_names,
            retain_module,
            observer,
        );
    };
    let failure = grammar_result(
        source,
        options.filename,
        CommentTable::default(),
        PARSER_RECOVERY_DIAGNOSTIC,
        Some(TapeSpan::new(
            recovery_source.diagnostic_offset(),
            recovery_source.diagnostic_offset(),
        )),
    )?;
    let mut recovery_options = options;
    recovery_options.recovery = TsrxParseRecovery::None;
    recovery_options.show_semantic_errors = false;
    let Ok(recovered) = parse_tsrx_utf8_source_once(
        recovery_source.source(),
        recovery_options,
        defer_compaction,
        retain_rejection_module_names,
        retain_module,
        observer,
    ) else {
        return Ok(failure);
    };
    recovery::finish(recovered, failure, &recovery_source)
}

fn parse_tsrx_utf8_source_once<W: Utf16WorkObserver>(
    source: &str,
    options: TsrxParseOptions<'_>,
    defer_compaction: bool,
    retain_rejection_module_names: bool,
    retain_module: bool,
    observer: &mut W,
) -> Result<TsrxParseResult, TsrxParseError> {
    observer.record_scan();
    let overlay = match scan_for_parser(source) {
        Ok(overlay) => overlay,
        Err(error) => {
            return projection_grammar_result(
                source,
                options.filename,
                &error,
                retain_rejection_module_names,
            );
        }
    };
    let overlay_view = overlay.view();
    projection::validate_overlay(overlay_view)?;
    if overlay_view.tokens.is_empty()
        && overlay_view.dynamic_tags.is_empty()
        && overlay_view.style_blocks.is_empty()
        && overlay_view.parser_lazy_patterns.is_empty()
    {
        return parse_direct(
            source,
            options,
            retain_rejection_module_names,
            retain_module,
            observer,
        );
    }
    parse_projected(
        source,
        options,
        &overlay,
        defer_compaction,
        retain_rejection_module_names,
        retain_module,
        observer,
    )
}

fn parse_direct<W: Utf16WorkObserver>(
    source: &str,
    options: TsrxParseOptions<'_>,
    retain_rejection_module_names: bool,
    retain_module: bool,
    observer: &mut W,
) -> Result<TsrxParseResult, TsrxParseError> {
    let request = ProjectedParseRequest {
        filename: options.filename,
        source,
        source_type: options.source_type,
        include_ts_fields: options.include_ts_fields,
        ranges: options.ranges,
        preserve_parens: options.preserve_parens,
        show_semantic_errors: options.show_semantic_errors,
        recovery: if options.recovery == TsrxParseRecovery::Editor {
            ProjectedParseRecovery::Editor
        } else {
            ProjectedParseRecovery::None
        },
        rejection_metadata: rejection_metadata(retain_rejection_module_names),
        dynamic_tags: None,
        synthetic_callee_spans: &[],
    };
    let parsed = if retain_module {
        parse_to_projected_tape(request)
    } else {
        parse_to_projected_tape_program_only(request)
    }
    .map_err(TsrxParseError::from)?;
    if let Some(tape) = parsed.program.as_ref() {
        observer.record_tape(tape);
    }
    require_one_oxc_parse(parsed.parse_count)?;
    let mut errors = parsed.errors;
    let suppressed_diagnostics = parsed.suppressed_diagnostics;
    render_diagnostic_codeframes(options.filename, source, &mut errors)
        .map_err(TsrxParseError::from)?;
    if parsed.syntax_failed && parsed.program.is_none() {
        return TsrxParseResult::failed_with_rejection_module_names(
            parsed.comments,
            errors,
            suppressed_diagnostics,
            parsed.rejection_module_names,
        );
    }
    let program = parsed.program.ok_or(TsrxParseError::Unsupported("missing direct Program"))?;
    let module = if retain_module {
        Some(parsed.module.ok_or(TsrxParseError::Unsupported("missing direct module record"))?)
    } else {
        None
    };
    let build_result =
        if parsed.syntax_failed { TsrxParseResult::recovered } else { TsrxParseResult::complete };
    Ok(build_result(
        program,
        module,
        parsed.comments,
        errors,
        suppressed_diagnostics,
        false,
        parsed.rejection_module_names,
    ))
}

// Keeping the parse, authored-coordinate repair, and fail-closed exits together makes the exact
// one-OXC-parse invariant auditable; splitting this pipeline would obscure its ordered ownership.
#[expect(
    clippy::too_many_lines,
    reason = "the projected parse is one linear pipeline; splitting it would hide the stage order rather than clarify it"
)]
fn parse_projected<W: Utf16WorkObserver>(
    source: &str,
    options: TsrxParseOptions<'_>,
    overlay: &Overlay,
    defer_compaction: bool,
    retain_rejection_module_names: bool,
    retain_module: bool,
    observer: &mut W,
) -> Result<TsrxParseResult, TsrxParseError> {
    let overlay_view = overlay.view();
    let projected = project_for_parser(source, overlay).map_err(TsrxParseError::from)?;
    let projection_view = projected.view();
    observer.record_projection(
        projection_view.source.len(),
        std::mem::size_of_val(projection_view.segments),
    );
    if let Some(result) = projected_validation_failure(
        source,
        options.filename,
        projection_view,
        overlay_view,
        retain_rejection_module_names,
    )? {
        return Ok(result);
    }

    let dynamic_contract = projected.dynamic_contract().map(|(prefix, count, original_offsets)| {
        DynamicTagContract { prefix, count, original_offsets }
    });

    let request = ProjectedParseRequest {
        filename: options.filename,
        source: projection_view.source,
        source_type: options.source_type,
        include_ts_fields: options.include_ts_fields,
        ranges: options.ranges,
        preserve_parens: options.preserve_parens,
        show_semantic_errors: options.show_semantic_errors,
        recovery: if options.recovery == TsrxParseRecovery::Editor {
            ProjectedParseRecovery::Editor
        } else {
            ProjectedParseRecovery::None
        },
        rejection_metadata: rejection_metadata(retain_rejection_module_names),
        dynamic_tags: dynamic_contract,
        synthetic_callee_spans: projected.synthetic_callee_spans(),
    };
    let parsed = if retain_module {
        parse_to_projected_tape(request)
    } else {
        parse_to_projected_tape_program_only(request)
    }
    .map_err(TsrxParseError::from)?;
    if let Some(tape) = parsed.program.as_ref() {
        observer.record_tape(tape);
    }
    let ProjectedParseResult {
        parse_count,
        program,
        module,
        mut rejection_module_names,
        comments: projected_comments,
        errors: projected_errors,
        suppressed_diagnostics: parser_suppressed_diagnostics,
        authored_grammar,
        syntax_failed,
        panicked: _,
    } = parsed;
    require_one_oxc_parse(parse_count)?;
    rejection_module_names.try_map_spans(|span| {
        projection::map_affine_span(projection_view.segments, span).ok_or_else(|| {
            TsrxParseError::Adapter(
                "private rejection module name is outside authored projection".to_string(),
            )
        })
    })?;
    let (prefix, comments) = projection::reconstruct_comments(
        source,
        projection_view.source,
        projection_view.segments,
        projected_comments,
        overlay_view,
        projected.parser_marker_prefix(),
        !syntax_failed,
    )?;
    if let Some(failure) = authored_grammar {
        return adapter_grammar_result(
            source,
            options.filename,
            comments,
            &failure,
            rejection_module_names,
        );
    }
    let (mut errors, projection_suppressed_diagnostics) = reconstruct_diagnostics(
        projected_errors,
        projection_view.segments,
        options.recovery == TsrxParseRecovery::Editor,
    )?;
    let suppressed_diagnostics = parser_suppressed_diagnostics
        .checked_add(projection_suppressed_diagnostics)
        .ok_or(TsrxParseError::Unsupported("suppressed diagnostic count exceeds 4 GiB"))?;
    render_diagnostic_codeframes(options.filename, source, &mut errors)
        .map_err(TsrxParseError::from)?;
    if syntax_failed && program.is_none() {
        return TsrxParseResult::failed_with_rejection_module_names(
            comments,
            errors,
            suppressed_diagnostics,
            rejection_module_names,
        );
    }
    let prefix = prefix.ok_or(TsrxParseError::Unsupported("missing marker namespace"))?;
    let tape = program.ok_or(TsrxParseError::Unsupported("missing projected Program"))?;
    let projected_module = if retain_module {
        Some(module.ok_or(TsrxParseError::Unsupported("missing projected module record"))?)
    } else {
        None
    };
    ProjectedCompletion {
        source,
        filename: options.filename,
        overlay: overlay_view,
        projection: projection_view,
        prefix,
        tape,
        projected_module,
        comments,
        errors,
        suppressed_diagnostics,
        recovered: syntax_failed,
        defer_compaction,
        rejection_module_names,
    }
    .finish()
}

fn projected_validation_failure(
    source: &str,
    filename: &str,
    projection_view: ProjectionView<'_>,
    overlay_view: OverlayView<'_>,
    retain_rejection_module_names: bool,
) -> Result<Option<TsrxParseResult>, TsrxParseError> {
    match projection::validate_projection(source, projection_view, overlay_view) {
        Ok(()) => Ok(None),
        Err(TsrxParseError::AuthoredGrammar(message)) => {
            let metadata = parse_failed_tsrx_metadata(
                source,
                rejection_metadata(retain_rejection_module_names),
            )
            .map_err(TsrxParseError::from)?;
            require_one_oxc_parse(metadata.parse_count)?;
            grammar_result_with_rejection_module_names(
                source,
                filename,
                metadata.comments,
                &message,
                None,
                metadata.rejection_module_names,
            )
            .map(Some)
        }
        Err(error) => Err(error),
    }
}

struct ProjectedCompletion<'source, 'filename, 'overlay, 'projection> {
    source: &'source str,
    filename: &'filename str,
    overlay: OverlayView<'overlay>,
    projection: ProjectionView<'projection>,
    prefix: &'projection str,
    tape: FlatTape,
    projected_module: Option<ModuleTable>,
    comments: CommentTable,
    errors: DiagnosticTable,
    suppressed_diagnostics: u32,
    recovered: bool,
    defer_compaction: bool,
    rejection_module_names: RejectionModuleNames,
}

impl ProjectedCompletion<'_, '_, '_, '_> {
    fn finish(mut self) -> Result<TsrxParseResult, TsrxParseError> {
        let module = self
            .projected_module
            .map(|projected| reconstruct_module(projected, self.projection.segments, self.overlay))
            .transpose()?
            .map(|(module, _suppressed_module_records)| module);
        let authored_starts = match reconstruct_projected(
            &mut self.tape,
            self.source,
            self.overlay,
            self.projection.segments,
            self.prefix,
        ) {
            Ok(authored_starts) => authored_starts,
            Err(error) => {
                return authored_grammar_result(
                    self.source,
                    self.filename,
                    self.comments,
                    error,
                    self.rejection_module_names,
                );
            }
        };
        let finalization_index = match lexical::validate_authored_contexts(&mut self.tape) {
            Ok(index) => index,
            Err(error) => {
                return authored_grammar_result(
                    self.source,
                    self.filename,
                    self.comments,
                    error,
                    self.rejection_module_names,
                );
            }
        };
        finalize_reachable_spans(
            &mut self.tape,
            self.projection.segments,
            &authored_starts,
            &finalization_index,
        )?;
        if !self.defer_compaction {
            self.tape.compact_reachable()?;
        }
        let build_result =
            if self.recovered { TsrxParseResult::recovered } else { TsrxParseResult::complete };
        Ok(build_result(
            self.tape,
            module,
            self.comments,
            self.errors,
            self.suppressed_diagnostics,
            self.defer_compaction,
            self.rejection_module_names,
        ))
    }
}

pub(super) fn require_one_oxc_parse(parse_count: u32) -> Result<(), TsrxParseError> {
    if parse_count == 1 {
        Ok(())
    } else {
        Err(TsrxParseError::Adapter(format!(
            "TSRX route performed {parse_count} public OXC parses instead of exactly one"
        )))
    }
}

pub(super) const fn rejection_metadata(retain_module_names: bool) -> RejectionMetadata {
    if retain_module_names { RejectionMetadata::ModuleNames } else { RejectionMetadata::None }
}

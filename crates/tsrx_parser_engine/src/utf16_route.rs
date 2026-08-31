//! The UTF-16 route: bridge the caller's exact code units into a parseable UTF-8 source, run the
//! same pipeline, then repair the result back into those units.

use oxc_adapter::parser::{RejectionModuleNames, render_diagnostic_codeframes};
use tsrx_syntax::OpaqueSurrogateContext;
use tsrx_tape_schema::{
    CoordinateDomain, DiagnosticPhase, DiagnosticTable, ParseCompleteness, TapeSpan,
};

use crate::{
    TsrxParseError, TsrxParseOptions, TsrxParseResult, TsrxUtf16ParseRequest,
    grammar_result::grammar_result,
    pipeline::parse_tsrx_utf8_source,
    source_bridge::PreparedSource,
    utf16_result::{
        Utf16WorkObserver, finalize_utf16_result, forbidden_module_name_span,
        forbidden_rejection_module_name_span,
    },
};

#[derive(Debug, Clone, Copy)]
struct Utf16Rejection {
    span: TapeSpan,
    message: &'static str,
}

pub(super) fn parse_tsrx_utf16_with_options_and_observer<W: Utf16WorkObserver>(
    request: &TsrxUtf16ParseRequest<'_>,
    options: TsrxParseOptions<'_>,
    force_defer_compaction: bool,
    retain_module: bool,
    observer: &mut W,
) -> Result<TsrxParseResult, TsrxParseError> {
    let prepared = PreparedSource::new(request.source)?;
    observer.record_bridge(&prepared);
    let retain_rejection_module_names = prepared.has_context(OpaqueSurrogateContext::QuotedString);
    let mut result = parse_tsrx_utf8_source(
        prepared.source(),
        options,
        force_defer_compaction || !prepared.is_identity(),
        retain_rejection_module_names,
        retain_module,
        observer,
    )?;
    if prepared.rejected_fixup().is_some() && result.status == ParseCompleteness::Complete {
        return Err(TsrxParseError::Adapter(
            "active-surrogate poison marker survived a successful OXC parse".to_string(),
        ));
    }
    if let Some(rejection) = utf16_rejection_candidate(&result, &prepared)? {
        if let Some(errors) = earlier_grammar_diagnostic(
            &result.errors,
            rejection.span.start,
            options.filename,
            prepared.source(),
            Some(&prepared),
        )? {
            if result.status == ParseCompleteness::Complete {
                return Err(TsrxParseError::Adapter(
                    "complete parse retained an earlier grammar diagnostic".to_string(),
                ));
            }
            let discarded = result.errors.len().saturating_sub(1);
            result.errors = errors;
            result.suppressed_diagnostics = result
                .suppressed_diagnostics
                .saturating_add(u32::try_from(discarded).unwrap_or(u32::MAX));
        } else {
            result = grammar_result(
                prepared.source(),
                options.filename,
                std::mem::take(&mut result.comments),
                rejection.message,
                Some(rejection.span),
            )?;
        }
    }
    result.rejection_module_names = RejectionModuleNames::default();
    finalize_utf16_result(&mut result, &prepared, observer)?;
    result.coordinate_domain = CoordinateDomain::OriginalUtf16Units;
    Ok(result)
}

fn utf16_rejection_candidate(
    result: &TsrxParseResult,
    source: &PreparedSource<'_>,
) -> Result<Option<Utf16Rejection>, TsrxParseError> {
    let active = source
        .rejected_fixup()
        .map(|fixup| {
            let end = fixup
                .byte_start
                .checked_add(3)
                .ok_or(TsrxParseError::Unsupported("active-surrogate byte interval overflow"))?;
            Ok::<Utf16Rejection, TsrxParseError>(Utf16Rejection {
                span: TapeSpan::new(fixup.byte_start, end),
                message: "unexpected unpaired UTF-16 surrogate in active syntax",
            })
        })
        .transpose()?;
    let public_module = result
        .module
        .as_ref()
        .map(|module| forbidden_module_name_span(module, source))
        .transpose()?
        .flatten();
    let private_module =
        forbidden_rejection_module_name_span(result.rejection_module_names.spans(), source);
    let module = match (public_module, private_module) {
        (Some(public), Some(private)) => {
            Some(if (private.start, private.end) < (public.start, public.end) {
                private
            } else {
                public
            })
        }
        (Some(span), None) | (None, Some(span)) => Some(span),
        (None, None) => None,
    }
    .map(|span| Utf16Rejection {
        span,
        message: "An export name cannot include a lone surrogate.",
    });
    Ok(match (active, module) {
        (Some(active), Some(module)) => {
            Some(if (module.span.start, module.span.end) < (active.span.start, active.span.end) {
                module
            } else {
                active
            })
        }
        (Some(active), None) => Some(active),
        (None, Some(module)) => Some(module),
        (None, None) => None,
    })
}

fn earlier_grammar_diagnostic(
    table: &DiagnosticTable,
    candidate_start: u32,
    filename: &str,
    source: &str,
    source_bridge: Option<&PreparedSource<'_>>,
) -> Result<Option<DiagnosticTable>, TsrxParseError> {
    let mut selected = None;
    for (index, diagnostic) in table.records().iter().enumerate() {
        if diagnostic.phase != DiagnosticPhase::Grammar {
            continue;
        }
        let labels = table.labels(diagnostic.labels).ok_or_else(|| {
            TsrxParseError::Adapter("grammar diagnostic has an invalid label range".to_string())
        })?;
        let has_primary = labels.iter().any(|label| label.primary);
        let causal =
            labels.iter().filter(|label| !has_primary || label.primary).collect::<Vec<_>>();
        if causal.is_empty() {
            continue;
        }
        let mut causal_start = u32::MAX;
        let mut causal_end = 0_u32;
        let mut wholly_earlier = true;
        for label in causal {
            if label.span.start > label.span.end {
                return Err(TsrxParseError::Adapter(
                    "grammar diagnostic has a reversed causal label".to_string(),
                ));
            }
            causal_start = causal_start.min(label.span.start);
            causal_end = causal_end.max(label.span.end);
            // A poison-caused OXC diagnostic may point at the immediately preceding token.
            // Equality is therefore adjacency, not proof that the failure is independent.
            wholly_earlier &= label.span.end < candidate_start
                || (label.span.end == candidate_start
                    && source_bridge.is_some_and(|bridge| {
                        bridge.is_authored_collision_scalar(label.span.start, label.span.end)
                    }));
        }
        if wholly_earlier
            && selected.is_none_or(|(best_index, best_start, best_end)| {
                (causal_start, causal_end, index) < (best_start, best_end, best_index)
            })
        {
            selected = Some((index, causal_start, causal_end));
        }
    }
    let Some((index, _, _)) = selected else {
        return Ok(None);
    };
    let diagnostic = table.records()[index];
    let labels = table.labels(diagnostic.labels).ok_or_else(|| {
        TsrxParseError::Adapter("selected diagnostic has an invalid label range".to_string())
    })?;
    let mut retained = DiagnosticTable::default();
    let label_start = retained.begin_labels()?;
    for label in labels {
        let message = label
            .message
            .get()
            .map(|range| {
                table.string(range).ok_or_else(|| {
                    TsrxParseError::Adapter(
                        "selected diagnostic label has an invalid message".to_string(),
                    )
                })
            })
            .transpose()?;
        retained.push_labeled(label.span, message, label.primary)?;
    }
    let labels = retained.finish_labels(label_start, diagnostic.labels.length)?;
    let optional = |range: tsrx_tape_schema::OptionalStringRange| {
        range
            .get()
            .map(|range| {
                table.string(range).ok_or_else(|| {
                    TsrxParseError::Adapter(
                        "selected diagnostic has invalid optional text".to_string(),
                    )
                })
            })
            .transpose()
    };
    retained.push_diagnostic(
        diagnostic.phase,
        diagnostic.severity,
        table.string(diagnostic.message).ok_or_else(|| {
            TsrxParseError::Adapter("selected diagnostic has an invalid message".to_string())
        })?,
        labels,
        optional(diagnostic.help)?,
        optional(diagnostic.note)?,
        optional(diagnostic.code_scope)?,
        optional(diagnostic.code_number)?,
        optional(diagnostic.url)?,
        None,
    )?;
    render_diagnostic_codeframes(filename, source, &mut retained).map_err(TsrxParseError::from)?;
    Ok(Some(retained))
}

#[cfg(test)]
mod tests {
    use tsrx_tape_schema::DiagnosticSeverity;

    use super::*;
    use crate::{parse_tsrx_utf16, utf16_result::Utf16Work};

    fn parse_tsrx_utf16_with_options_measured(
        request: &TsrxUtf16ParseRequest<'_>,
        options: TsrxParseOptions<'_>,
    ) -> Result<(TsrxParseResult, Utf16Work), TsrxParseError> {
        let mut work = Utf16Work::default();
        let result =
            parse_tsrx_utf16_with_options_and_observer(request, options, false, true, &mut work)?;
        Ok((result, work))
    }

    fn grammar_table<const N: usize>(labels: [(TapeSpan, bool); N]) -> DiagnosticTable {
        let mut diagnostics = DiagnosticTable::new();
        let labels = diagnostics
            .append_labels(labels.into_iter().map(|(span, primary)| (span, None, primary)))
            .expect("labels");
        diagnostics
            .push_diagnostic(
                DiagnosticPhase::Grammar,
                DiagnosticSeverity::Error,
                "test grammar diagnostic",
                labels,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("diagnostic");
        diagnostics
    }

    #[test]
    fn a_secondary_label_before_the_candidate_cannot_override_a_later_primary_cause() {
        let diagnostics =
            grammar_table([(TapeSpan::new(1, 2), false), (TapeSpan::new(7, 8), true)]);

        assert!(
            earlier_grammar_diagnostic(&diagnostics, 5, "input.tsrx", "abcdefghij", None)
                .expect("arbitration")
                .is_none()
        );
    }

    #[test]
    fn a_later_secondary_context_does_not_hide_an_earlier_primary_cause() {
        let diagnostics =
            grammar_table([(TapeSpan::new(1, 2), true), (TapeSpan::new(7, 8), false)]);

        assert!(
            earlier_grammar_diagnostic(&diagnostics, 5, "input.tsrx", "abcdefghij", None)
                .expect("arbitration")
                .is_some()
        );
    }

    #[test]
    fn every_label_is_causal_when_oxc_marks_no_primary_label() {
        let wholly_earlier =
            grammar_table([(TapeSpan::new(1, 2), false), (TapeSpan::new(3, 4), false)]);
        assert!(
            earlier_grammar_diagnostic(&wholly_earlier, 5, "input.tsrx", "abcdefghij", None)
                .expect("earlier arbitration")
                .is_some()
        );

        let crosses_candidate =
            grammar_table([(TapeSpan::new(1, 2), false), (TapeSpan::new(5, 6), false)]);
        assert!(
            earlier_grammar_diagnostic(&crosses_candidate, 5, "input.tsrx", "abcdefghij", None,)
                .expect("crossing arbitration")
                .is_none()
        );
    }

    #[test]
    fn candidate_adjacency_is_allowed_only_for_an_exact_authored_collision_scalar() {
        let mut original = "const x=".encode_utf16().collect::<Vec<_>>();
        original.extend([0xffff, 0xd800]);
        original.extend(";".encode_utf16());
        let prepared = PreparedSource::new(&original).expect("prepared collision source");
        let candidate_start = prepared.rejected_fixup().expect("active rejection").byte_start;

        let exact = grammar_table([(TapeSpan::new(candidate_start - 3, candidate_start), false)]);
        assert!(
            earlier_grammar_diagnostic(
                &exact,
                candidate_start,
                "input.tsrx",
                prepared.source(),
                Some(&prepared),
            )
            .expect("exact adjacency")
            .is_some()
        );

        let overlapping =
            grammar_table([(TapeSpan::new(candidate_start - 4, candidate_start), false)]);
        assert!(
            earlier_grammar_diagnostic(
                &overlapping,
                candidate_start,
                "input.tsrx",
                prepared.source(),
                Some(&prepared),
            )
            .expect("overlapping adjacency")
            .is_none()
        );
    }

    #[test]
    fn public_utf16_results_clear_private_name_spans_and_debug_placeholder_text() {
        let template = r#"export { "a<U>" as x } from "m"; const b<U>=1;"#;
        let mut source = Vec::new();
        let mut remaining = template;
        while let Some(index) = remaining.find("<U>") {
            source.extend(remaining[..index].encode_utf16());
            source.push(0xd800);
            remaining = &remaining[index + 3..];
        }
        source.extend(remaining.encode_utf16());

        let result = parse_tsrx_utf16(&TsrxUtf16ParseRequest { source: &source })
            .expect("structured rejection");
        assert!(result.rejection_module_names.spans().is_empty());
        let debug = format!("{result:?}");
        assert!(!debug.contains('\u{e000}'));
        assert!(!debug.contains('\u{ffff}'));
    }

    #[test]
    fn complete_opaque_utf16_results_compact_unreachable_placeholder_storage() {
        let mut source = "const value=\"".encode_utf16().collect::<Vec<_>>();
        source.push(0xd800);
        source.extend("\";".encode_utf16());

        let result = parse_tsrx_utf16(&TsrxUtf16ParseRequest { source: &source })
            .expect("complete opaque result");
        assert_eq!(result.status, ParseCompleteness::Complete);
        assert!(!result.program().scalar_storage().contains('\u{e000}'));
        let debug = format!("{result:?}").to_ascii_lowercase();
        assert!(!debug.contains("e000"), "private placeholder leaked: {debug}");
    }

    #[test]
    fn measured_utf16_work_is_zero_beyond_the_owned_ascii_bridge() {
        let source = "const value=\"plain ASCII\";".encode_utf16().collect::<Vec<_>>();
        let (result, work) = parse_tsrx_utf16_with_options_measured(
            &TsrxUtf16ParseRequest { source: &source },
            TsrxParseOptions::default(),
        )
        .expect("measured ASCII parse");

        assert_eq!(result.status, ParseCompleteness::Complete);
        assert_eq!(work.bridge_observations, 1);
        assert_eq!(work.bridge.input_units, source.len());
        assert_eq!(work.bridge.utf8_bytes, source.len());
        assert_eq!(work.bridge.boundary_records, 0);
        assert_eq!(work.bridge.fixup_records, 0);
        assert_eq!(work.bridge.opaque_fixup_records, 0);
        assert_eq!(work.bridge.rejection_fixup_records, 0);
        assert_eq!(work.bridge.sanitized_bytes, 0);
        assert_eq!(work.restored_units(), 0);
        assert_eq!(work.restored_bytes(), 0);
        assert_eq!(work.program_compactions, 0);
    }

    #[test]
    fn measured_well_formed_utf16_never_enters_a_repair_lane() {
        let source = "const value=\"é😀\";".encode_utf16().collect::<Vec<_>>();
        let (result, work) = parse_tsrx_utf16_with_options_measured(
            &TsrxUtf16ParseRequest { source: &source },
            TsrxParseOptions::default(),
        )
        .expect("measured well-formed parse");

        assert_eq!(result.status, ParseCompleteness::Complete);
        assert_eq!(work.bridge_observations, 1);
        assert_eq!(work.bridge.boundary_records, 2);
        assert_eq!(work.bridge.fixup_records, 0);
        assert_eq!(work.bridge.opaque_fixup_records, 0);
        assert_eq!(work.bridge.rejection_fixup_records, 0);
        assert_eq!(work.bridge.sanitized_bytes, 0);
        assert_eq!(work.restored_units(), 0);
        assert_eq!(work.program_compactions, 0);
    }

    #[test]
    fn measured_active_rejection_counts_poison_without_value_repair() {
        let mut source = "const value=".encode_utf16().collect::<Vec<_>>();
        source.push(0xd800);
        source.extend(";".encode_utf16());
        let (result, work) = parse_tsrx_utf16_with_options_measured(
            &TsrxUtf16ParseRequest { source: &source },
            TsrxParseOptions::default(),
        )
        .expect("measured active rejection");

        assert_eq!(result.status, ParseCompleteness::Failed);
        assert_eq!(work.bridge_observations, 1);
        assert_eq!(work.bridge.fixup_records, 1);
        assert_eq!(work.bridge.opaque_fixup_records, 0);
        assert_eq!(work.bridge.rejection_fixup_records, 1);
        assert_eq!(work.bridge.sanitized_bytes, 3);
        assert_eq!(work.program_raw_units, 0);
        assert_eq!(work.program_semantic_units, 0);
        assert_eq!(work.module_units, 0);
        assert_eq!(work.comment_units, 0);
        assert!(work.codeframe_units > 0);
        assert_eq!(work.program_compactions, 0);
    }

    #[test]
    fn measured_utf16_work_accounts_for_every_current_repair_emission_lane() {
        let template = concat!(
            "import \"m<U>\";\n",
            "const string=\"s<U>\";\n",
            "const template=`t<U>`;\n",
            "/* c<U> */\n",
            "let duplicate;\n",
            "let duplicate;\n",
        );
        let mut source = Vec::new();
        let mut remaining = template;
        while let Some(index) = remaining.find("<U>") {
            source.extend(remaining[..index].encode_utf16());
            source.push(0xd800);
            remaining = &remaining[index + 3..];
        }
        source.extend(remaining.encode_utf16());

        let (result, work) = parse_tsrx_utf16_with_options_measured(
            &TsrxUtf16ParseRequest { source: &source },
            TsrxParseOptions {
                filename: "Work.tsrx",
                show_semantic_errors: true,
                ..TsrxParseOptions::default()
            },
        )
        .expect("measured all-lane parse");

        assert_eq!(result.status, ParseCompleteness::Complete);
        assert!(!result.errors.is_empty());
        assert_eq!(work.bridge_observations, 1);
        assert_eq!(work.bridge.input_units, source.len());
        assert_eq!(work.bridge.utf8_bytes, source.len() + 8);
        assert_eq!(work.bridge.boundary_records, 4);
        assert_eq!(work.bridge.fixup_records, 4);
        assert_eq!(work.bridge.opaque_fixup_records, 4);
        assert_eq!(work.bridge.rejection_fixup_records, 0);
        assert_eq!(work.bridge.sanitized_bytes, 12);
        assert_eq!(work.program_raw_units, 10);
        assert_eq!(work.program_semantic_units, 6);
        assert_eq!(work.module_units, 2);
        assert_eq!(work.comment_units, 4);
        let expected_codeframe_units = result
            .errors
            .records()
            .iter()
            .filter_map(|diagnostic| result.errors.optional_text(diagnostic.codeframe))
            .map(|codeframe| codeframe.to_utf16().len())
            .sum::<usize>();
        assert!(expected_codeframe_units > 0);
        assert_eq!(work.codeframe_units, expected_codeframe_units);
        assert_eq!(work.restored_units(), 10 + 6 + 2 + 4 + expected_codeframe_units);
        assert_eq!(work.restored_bytes(), work.restored_units() * 2);
        assert_eq!(work.program_compactions, 1);
    }

    fn dense_measured_source(records: usize) -> Vec<u16> {
        let mut source = Vec::new();
        for index in 0..records {
            let record = format!(
                "import \"m{index}<U>\"; const s{index}=\"s<U>\"; const t{index}=`t<U>`; /* c<U> */ let duplicate;\n"
            );
            let mut remaining = record.as_str();
            while let Some(marker) = remaining.find("<U>") {
                source.extend(remaining[..marker].encode_utf16());
                source.push(0xd800);
                remaining = &remaining[marker + 3..];
            }
            source.extend(remaining.encode_utf16());
        }
        source
    }

    fn assert_copy_work_scales_linearly(label: &str, counts: &[usize], units: &[usize]) {
        assert_eq!(counts.len(), units.len(), "{label} sample shape");
        for pair in units.windows(2) {
            assert!(
                pair[1] <= pair[0].saturating_mul(3),
                "{label} doubled superlinearly: {pair:?}"
            );
        }
        let first = units[0].saturating_mul(*counts.last().expect("last count"));
        let last = units.last().copied().expect("last units").saturating_mul(counts[0]);
        assert!(
            last <= first.saturating_mul(2),
            "{label} per-record copy work grew beyond 2x across the retained 8x range"
        );
    }

    #[cfg(debug_assertions)]
    const fn require_release_copy_campaign() {
        panic!("the retained copy campaign must run with --release");
    }

    #[cfg(not(debug_assertions))]
    const fn require_release_copy_campaign() {}

    #[test]
    #[ignore = "run explicitly in release mode for retained repair-copy evidence"]
    #[expect(
        clippy::print_stdout,
        reason = "the scaling campaign prints its measured lanes under `cargo test -- --nocapture`"
    )]
    fn release_repair_copy_campaign_is_linear_and_lane_complete() {
        require_release_copy_campaign();
        let counts = [16_usize, 32, 64, 128];
        let mut program_raw = Vec::new();
        let mut program_semantic = Vec::new();
        let mut module = Vec::new();
        let mut comment = Vec::new();
        let mut codeframe = Vec::new();
        let mut total = Vec::new();

        for count in counts {
            let source = dense_measured_source(count);
            let (result, work) = parse_tsrx_utf16_with_options_measured(
                &TsrxUtf16ParseRequest { source: &source },
                TsrxParseOptions {
                    filename: "CopyScaling.tsrx",
                    show_semantic_errors: true,
                    ..TsrxParseOptions::default()
                },
            )
            .expect("release copy-work parse");
            assert_eq!(result.status, ParseCompleteness::Complete);
            assert_eq!(work.bridge_observations, 1);
            assert_eq!(work.bridge.fixup_records, count * 4);
            assert_eq!(work.bridge.opaque_fixup_records, count * 4);
            assert_eq!(work.bridge.rejection_fixup_records, 0);
            assert_eq!(work.bridge.sanitized_bytes, count * 12);
            assert_eq!(work.comment_units, count * 4);
            assert_eq!(work.program_compactions, 1);
            assert!(work.program_raw_units > 0);
            assert!(work.program_semantic_units > 0);
            assert!(work.module_units > 0);
            let expected_codeframe_units = result
                .errors
                .records()
                .iter()
                .filter_map(|diagnostic| result.errors.optional_text(diagnostic.codeframe))
                .map(|codeframe| codeframe.to_utf16().len())
                .sum::<usize>();
            assert!(expected_codeframe_units > 0);
            assert_eq!(work.codeframe_units, expected_codeframe_units);
            assert_eq!(
                work.restored_units(),
                work.program_raw_units
                    + work.program_semantic_units
                    + work.module_units
                    + work.comment_units
                    + expected_codeframe_units
            );
            assert_eq!(work.restored_bytes(), work.restored_units() * 2);
            println!(
                "copy records={count} units={} utf8_bytes={} boundaries={} fixups={} substituted_bytes={} program_raw_units={} program_semantic_units={} module_units={} comment_units={} codeframe_units={} restored_units={} restored_bytes={}",
                work.bridge.input_units,
                work.bridge.utf8_bytes,
                work.bridge.boundary_records,
                work.bridge.fixup_records,
                work.bridge.sanitized_bytes,
                work.program_raw_units,
                work.program_semantic_units,
                work.module_units,
                work.comment_units,
                work.codeframe_units,
                work.restored_units(),
                work.restored_bytes(),
            );
            program_raw.push(work.program_raw_units);
            program_semantic.push(work.program_semantic_units);
            module.push(work.module_units);
            comment.push(work.comment_units);
            codeframe.push(work.codeframe_units);
            total.push(work.restored_units());
        }

        assert_copy_work_scales_linearly("program raw", &counts, &program_raw);
        assert_copy_work_scales_linearly("program semantic", &counts, &program_semantic);
        assert_copy_work_scales_linearly("module", &counts, &module);
        assert_copy_work_scales_linearly("comment", &counts, &comment);
        assert_copy_work_scales_linearly("codeframe", &counts, &codeframe);
        assert_copy_work_scales_linearly("total restored", &counts, &total);
    }
}

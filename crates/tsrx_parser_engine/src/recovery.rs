//! Mapping a parser-owned editor recovery candidate back to authored result coordinates.

use tsrx_syntax::ParserRecovery;
use tsrx_tape_schema::{DiagnosticPhase, DiagnosticTable, ParseCompleteness, TapeSpan};

use crate::{
    TsrxParseError, TsrxParseResult,
    pipeline::push_multiple_output_diagnostics,
    reconstruct::{MULTIPLE_OUTPUTS_MESSAGE, collect_multiple_output_diagnostics},
    utf16_result::{program_reachable_objects, try_map_program_spans},
};

pub(super) fn finish(
    mut recovered: TsrxParseResult,
    failure: TsrxParseResult,
    source: &ParserRecovery,
    authored_source: &str,
    filename: &str,
) -> Result<TsrxParseResult, TsrxParseError> {
    // A candidate is usable when the repaired source parsed completely, or when the only thing
    // keeping it from `Complete` is the recoverable multiple-output grammar diagnostic: that
    // tree is still the editor's best view, and its diagnostics are re-derived below in
    // authored coordinates instead of being dropped with the candidate.
    let usable = match recovered.status {
        ParseCompleteness::Complete => true,
        ParseCompleteness::Recovered => only_multiple_output_diagnostics(&recovered.errors),
        ParseCompleteness::Failed => false,
    };
    if !usable {
        return Ok(failure);
    }
    let mut program = recovered
        .program
        .take()
        .ok_or(TsrxParseError::Unsupported("recovery candidate has no Program"))?;
    let reachable = program_reachable_objects(&program)?;
    try_map_program_spans(&mut program, &reachable, |offset| {
        source
            .map_endpoint(offset)
            .ok_or(TsrxParseError::Unsupported("recovered offset has no authored boundary"))
    })?;
    if let Some(module) = recovered.module.as_mut() {
        module.try_map_spans(|span| map_span(source, span))?;
    }
    recovered.comments.try_map_spans(|span| map_span(source, span))?;
    recovered.rejection_module_names.try_map_spans(|span| map_span(source, span))?;

    let mut errors = failure.errors;
    if recovered.status == ParseCompleteness::Recovered {
        let multiple_outputs = collect_multiple_output_diagnostics(&program)?;
        push_multiple_output_diagnostics(
            &mut errors,
            &multiple_outputs,
            filename,
            authored_source,
        )?;
    }

    Ok(TsrxParseResult::recovered(
        program,
        recovered.module,
        recovered.comments,
        errors,
        failure.suppressed_diagnostics.saturating_add(recovered.suppressed_diagnostics),
        recovered.needs_compaction,
        std::mem::take(&mut recovered.rejection_module_names),
    ))
}

fn only_multiple_output_diagnostics(errors: &DiagnosticTable) -> bool {
    !errors.is_empty()
        && errors.records().iter().all(|record| {
            record.phase == DiagnosticPhase::Grammar
                && errors.string(record.message) == Some(MULTIPLE_OUTPUTS_MESSAGE)
        })
}

fn map_span(source: &ParserRecovery, span: TapeSpan) -> Result<TapeSpan, TsrxParseError> {
    let start = source
        .map_endpoint(span.start)
        .ok_or(TsrxParseError::Unsupported("recovered span start has no authored boundary"))?;
    let end = source
        .map_endpoint(span.end)
        .ok_or(TsrxParseError::Unsupported("recovered span end has no authored boundary"))?;
    Ok(TapeSpan::new(start, end))
}

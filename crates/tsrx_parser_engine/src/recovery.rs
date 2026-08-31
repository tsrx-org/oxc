//! Mapping a parser-owned editor recovery candidate back to authored result coordinates.

use tsrx_syntax::ParserRecovery;
use tsrx_tape_schema::{ParseCompleteness, TapeSpan};

use crate::{
    TsrxParseError, TsrxParseResult,
    utf16_result::{program_reachable_objects, try_map_program_spans},
};

pub(super) fn finish(
    mut recovered: TsrxParseResult,
    failure: TsrxParseResult,
    source: &ParserRecovery,
) -> Result<TsrxParseResult, TsrxParseError> {
    if recovered.status != ParseCompleteness::Complete {
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

    Ok(TsrxParseResult::recovered(
        program,
        recovered.module,
        recovered.comments,
        failure.errors,
        failure.suppressed_diagnostics.saturating_add(recovered.suppressed_diagnostics),
        recovered.needs_compaction,
        std::mem::take(&mut recovered.rejection_module_names),
    ))
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

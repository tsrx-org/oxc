//! Rewriting a projected OXC tape in place into the tree the author actually wrote.
//! `program` fixes the order the passes run in and `spans` closes them out, mapping every
//! reachable node back into authored coordinates.

use tsrx_syntax::ByteSpan;
use tsrx_tape_schema::{FlatTape, RecordIndex};

use crate::TsrxParseError;

mod access;
mod code_blocks;
mod control;
mod css;
mod dynamic_tags;
mod edits;
mod if_chain;
mod jsx_statements;
mod layout_text;
mod lazy_patterns;
mod loops;
mod objects;
mod program;
mod scaffold;
mod script;
mod shorthand_attributes;
mod spans;
mod style;
mod switch;
mod try_catch;

pub(super) use program::reconstruct_projected;
pub(super) use spans::finalize_reachable_spans;

use access::{
    field_value, has_type, is_jsx_child_type, list_field, object_field, object_type, scalar_u32,
};

pub(super) const MULTIPLE_OUTPUTS_MESSAGE: &str =
    "A code block renders a single node; wrap multiple nodes or text in a fragment '<>…</>'.";

#[derive(Debug, Clone, Copy)]
pub(super) struct RecoverableDiagnostic {
    pub(super) message: &'static str,
    pub(super) span: ByteSpan,
}

pub(super) fn collect_multiple_output_diagnostics(
    tape: &FlatTape,
) -> Result<Vec<RecoverableDiagnostic>, TsrxParseError> {
    let mut diagnostics = Vec::new();
    for raw in 0..tape.object_count() {
        let raw = u32::try_from(raw).map_err(|_| {
            TsrxParseError::ResourceExhausted("object index exceeds the 32-bit tape limit")
        })?;
        let object = RecordIndex::new(raw);
        match object_type(tape, object) {
            Some(r#""JSXCodeBlock""#) => {
                report_code_block_outputs(tape, object, &mut diagnostics)?;
            }
            Some(r#""JSXIfExpression""#) => {
                report_if_outputs(tape, object, &mut diagnostics)?;
            }
            Some(r#""JSXForExpression""#) => {
                report_for_outputs(tape, object, &mut diagnostics)?;
            }
            Some(r#""JSXTryExpression""#) => {
                report_try_outputs(tape, object, &mut diagnostics)?;
            }
            _ => {}
        }
    }
    Ok(diagnostics)
}

fn report_code_block_outputs(
    tape: &FlatTape,
    block: RecordIndex,
    diagnostics: &mut Vec<RecoverableDiagnostic>,
) -> Result<(), TsrxParseError> {
    let mut outputs = statement_list_outputs(tape, list_field(tape, block, "body")?)?;
    if let Some(render) = nullable_object(tape, block, "render")? {
        if is_jsx_child_type(tape, render) {
            outputs.push(render);
        }
    }
    push_later_outputs(tape, &outputs, diagnostics)?;
    Ok(())
}

fn report_if_outputs(
    tape: &FlatTape,
    if_node: RecordIndex,
    diagnostics: &mut Vec<RecoverableDiagnostic>,
) -> Result<(), TsrxParseError> {
    report_block_outputs(tape, object_field(tape, if_node, "consequent")?, diagnostics)?;
    let Some(alternate) = nullable_object(tape, if_node, "alternate")? else {
        return Ok(());
    };
    if has_type(tape, alternate, r#""BlockStatement""#) {
        report_block_outputs(tape, alternate, diagnostics)?;
    } else if has_type(tape, alternate, r#""IfStatement""#) {
        report_if_outputs(tape, alternate, diagnostics)?;
    }
    Ok(())
}

fn report_for_outputs(
    tape: &FlatTape,
    for_node: RecordIndex,
    diagnostics: &mut Vec<RecoverableDiagnostic>,
) -> Result<(), TsrxParseError> {
    report_block_outputs(tape, object_field(tape, for_node, "body")?, diagnostics)?;
    if let Some(empty) = nullable_object(tape, for_node, "empty")? {
        report_block_outputs(tape, empty, diagnostics)?;
    }
    Ok(())
}

fn report_try_outputs(
    tape: &FlatTape,
    try_node: RecordIndex,
    diagnostics: &mut Vec<RecoverableDiagnostic>,
) -> Result<(), TsrxParseError> {
    report_block_outputs(tape, object_field(tape, try_node, "block")?, diagnostics)?;
    if let Some(pending) = nullable_object(tape, try_node, "pending")? {
        report_block_outputs(tape, pending, diagnostics)?;
    }
    if let Some(handler) = nullable_object(tape, try_node, "handler")? {
        report_block_outputs(tape, object_field(tape, handler, "body")?, diagnostics)?;
    }
    Ok(())
}

fn report_block_outputs(
    tape: &FlatTape,
    block: RecordIndex,
    diagnostics: &mut Vec<RecoverableDiagnostic>,
) -> Result<(), TsrxParseError> {
    if !has_type(tape, block, r#""BlockStatement""#) {
        return Ok(());
    }
    let outputs = statement_list_outputs(tape, list_field(tape, block, "body")?)?;
    push_later_outputs(tape, &outputs, diagnostics)
}

fn statement_list_outputs(
    tape: &FlatTape,
    list: RecordIndex,
) -> Result<Vec<RecordIndex>, TsrxParseError> {
    let mut outputs = Vec::new();
    for value in tape.values(list) {
        let Some(object) = value.as_object() else {
            continue;
        };
        if is_jsx_child_type(tape, object) {
            outputs.push(object);
        }
    }
    Ok(outputs)
}

fn push_later_outputs(
    tape: &FlatTape,
    outputs: &[RecordIndex],
    diagnostics: &mut Vec<RecoverableDiagnostic>,
) -> Result<(), TsrxParseError> {
    for &output in outputs.iter().skip(1) {
        diagnostics.push(RecoverableDiagnostic {
            message: MULTIPLE_OUTPUTS_MESSAGE,
            span: ByteSpan::new(
                scalar_u32(tape, output, "start")?,
                scalar_u32(tape, output, "end")?,
            ),
        });
    }
    Ok(())
}

fn nullable_object(
    tape: &FlatTape,
    object: RecordIndex,
    name: &str,
) -> Result<Option<RecordIndex>, TsrxParseError> {
    let value = field_value(tape, object, name)?;
    if tape.scalar(value) == Some("null") {
        return Ok(None);
    }
    value
        .as_object()
        .map(Some)
        .ok_or(TsrxParseError::Unsupported("nullable ESTree field is not an object"))
}

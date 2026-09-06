#[expect(
    dead_code,
    reason = "the shared test-support module is compiled into every integration binary and each one uses a different part of it"
)]
mod support;

use support::{list_field, object_field, program_body, require_type, span};
use tsrx_parser_engine::{
    TsrxParseOptions, TsrxParseRecovery, TsrxParseRequest, TsrxParseResult, TsrxUtf16ParseRequest,
    parse_tsrx, parse_tsrx_utf16_with_options, parse_tsrx_with_options,
};
use tsrx_tape_schema::{Completeness, DiagnosticPhase, ParseCompleteness};

const MULTIPLE_OUTPUTS: &str =
    "A code block renders a single node; wrap multiple nodes or text in a fragment '<>…</>'.";
const RECOVERY_DIAGNOSTIC: &str = "incomplete TSRX editor snapshot";

fn diagnostic_messages(result: &TsrxParseResult) -> Vec<&str> {
    result
        .errors
        .records()
        .iter()
        .map(|record| result.errors.string(record.message).expect("diagnostic message"))
        .collect()
}

fn multiple_output_label(result: &TsrxParseResult) -> (u32, u32) {
    let record = result
        .errors
        .records()
        .iter()
        .find(|record| result.errors.string(record.message) == Some(MULTIPLE_OUTPUTS))
        .expect("multiple-outputs diagnostic");
    assert_eq!(record.phase, DiagnosticPhase::Grammar);
    let labels = result.errors.labels(record.labels).expect("labels");
    assert_eq!(labels.len(), 1);
    (labels[0].span.start, labels[0].span.end)
}

fn expect_span(source: &str, needle: &str) -> (u32, u32) {
    let start = source.find(needle).expect("needle in source");
    let start = u32::try_from(start).expect("fixture offset");
    (start, start + u32::try_from(needle.len()).expect("fixture length"))
}

fn recover(source: &str) -> TsrxParseResult {
    parse_tsrx_with_options(
        &TsrxParseRequest { source },
        TsrxParseOptions { recovery: TsrxParseRecovery::Editor, ..TsrxParseOptions::default() },
    )
    .expect("editor recovery should remain result-oriented")
}

fn assert_recovered(result: &TsrxParseResult, source: &str) {
    let source_len = u32::try_from(source.len()).expect("fixture length");
    assert_eq!(result.status, ParseCompleteness::Recovered, "{source}");
    assert!(!result.completeness.contains(Completeness::COMPLETE), "{source}");
    assert!(result.completeness.contains(Completeness::HAS_PROGRAM), "{source}");
    assert!(result.completeness.contains(Completeness::HAS_MODULE), "{source}");
    assert!(result.completeness.contains(Completeness::HAS_ERRORS), "{source}");
    assert!(result.module.is_some(), "{source}");
    assert!(!result.errors.is_empty(), "{source}");
    let tape = result.program.as_ref().expect("recovered Program");
    let root = tape.root().as_object().expect("Program root");
    assert_eq!(span(tape, root), (0, source_len), "{source}");
    for diagnostic in result.errors.records() {
        for label in result.errors.labels(diagnostic.labels).expect("diagnostic labels") {
            assert!(label.span.end <= source_len, "{source}");
        }
    }
}

#[test]
fn strict_parsing_remains_fail_closed_when_editor_recovery_is_available() {
    let source = "function View() @{ const value = ; <main /> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("syntax failures are result data");

    assert_eq!(result.status, ParseCompleteness::Failed);
    assert!(result.program.is_none());
    assert!(result.module.is_none());
    assert!(!result.errors.is_empty());
}

#[test]
fn editor_recovery_returns_oxc_partial_programs_for_direct_sources() {
    let source = "const value; const after = 1;";
    let result = recover(source);
    assert_recovered(&result, source);

    let tape = result.program.as_ref().expect("recovered Program");
    let body = program_body(tape);
    assert_eq!(body.len(), 2);
    for statement in body {
        require_type(tape, statement.as_object().expect("declaration"), "VariableDeclaration");
    }
}

#[test]
fn editor_recovery_reconstructs_tsrx_nodes_in_partial_programs() {
    let source = "function View() @{ const value; <main /> }";
    let result = recover(source);
    assert_recovered(&result, source);

    let tape = result.program.as_ref().expect("recovered Program");
    let function = program_body(tape)[0].as_object().expect("function");
    require_type(tape, function, "FunctionDeclaration");
    let block = object_field(tape, function, "body");
    require_type(tape, block, "JSXCodeBlock");
    let render = object_field(tape, block, "render");
    require_type(tape, render, "JSXElement");
}

#[test]
fn editor_recovery_does_not_rewrite_at_signs_inside_regex_literals() {
    let source = "const pattern = /@/;";
    let result = recover(source);

    assert_eq!(result.status, ParseCompleteness::Complete);
    assert!(result.completeness.contains(Completeness::COMPLETE));
    assert!(result.errors.is_empty());
}

#[test]
fn editor_recovery_still_fails_when_oxc_cannot_return_a_usable_program() {
    let source = "function View() @{ const value = ; <main /> }";
    let result = recover(source);

    assert_eq!(result.status, ParseCompleteness::Failed);
    assert!(result.program.is_none());
    assert!(result.module.is_none());
    assert!(!result.errors.is_empty());
}

#[test]
fn editor_recovery_completes_common_in_progress_tsrx_snapshots() {
    for source in [
        "export function View() @{",
        "export function View() @{ const value = ",
        "export function View() @{ @if (",
        "export function View() @{ @ }",
        "export function View() @{\n  <div>\n}",
        "export function View() @{\n  <div>",
    ] {
        if let Ok(strict) = parse_tsrx(&TsrxParseRequest { source }) {
            assert_eq!(strict.status, ParseCompleteness::Failed, "{source}");
        }

        let recovered = recover(source);
        assert_recovered(&recovered, source);
        assert!(!program_body(recovered.program.as_ref().expect("recovered Program")).is_empty());
        assert!(recovered.errors.records().iter().all(|diagnostic| {
            recovered
                .errors
                .string(diagnostic.message)
                .is_some_and(|message| !message.contains("synthetic diagnostic labels"))
        }));
    }
}

#[test]
fn editor_recovery_composes_repair_offsets_with_the_utf16_bridge() {
    let source = "export function View() @{ const \u{3c0} = 1;";
    let units = source.encode_utf16().collect::<Vec<_>>();
    let unit_len = u32::try_from(units.len()).expect("fixture length");
    let recovered = parse_tsrx_utf16_with_options(
        &TsrxUtf16ParseRequest { source: &units },
        TsrxParseOptions { recovery: TsrxParseRecovery::Editor, ..TsrxParseOptions::default() },
    )
    .expect("UTF-16 editor recovery");

    assert_eq!(recovered.status, ParseCompleteness::Recovered);
    let tape = recovered.program.as_ref().expect("recovered Program");
    let root = tape.root().as_object().expect("Program root");
    assert_eq!(span(tape, root), (0, unit_len));
    assert!(recovered.errors.records().iter().all(|diagnostic| {
        recovered
            .errors
            .labels(diagnostic.labels)
            .is_some_and(|labels| labels.iter().all(|label| label.span.end <= unit_len))
    }));
}

#[test]
fn snapshot_repair_keeps_a_multiple_output_tree_and_its_diagnostics() {
    // The unclosed `@{` is repaired by the editor snapshot recovery; the repaired source still
    // has two output nodes, which is the recoverable grammar error, not a reason to drop the
    // repaired tree and its diagnostic.
    let source = "export function View() @{\n  <style apply={a} />\n  <div />";
    assert_eq!(
        parse_tsrx(&TsrxParseRequest { source }).expect("strict").status,
        ParseCompleteness::Failed
    );

    let result = recover(source);
    assert_recovered(&result, source);
    assert_eq!(diagnostic_messages(&result), [RECOVERY_DIAGNOSTIC, MULTIPLE_OUTPUTS]);
    assert_eq!(multiple_output_label(&result), expect_span(source, "<div />"));

    let tape = result.program.as_ref().expect("recovered Program");
    let export = program_body(tape)[0].as_object().expect("export");
    let function = object_field(tape, export, "declaration");
    let block = object_field(tape, function, "body");
    require_type(tape, block, "JSXCodeBlock");
    let body = list_field(tape, block, "body");
    assert_eq!(body.len(), 1);
    let style = body[0].as_object().expect("style statement");
    require_type(tape, style, "JSXStyleElement");
    assert_eq!(span(tape, style), expect_span(source, "<style apply={a} />"));
    let render = object_field(tape, block, "render");
    require_type(tape, render, "JSXElement");
    assert_eq!(span(tape, render), expect_span(source, "<div />"));
}

#[test]
fn oxc_partial_recovery_keeps_the_multiple_output_diagnostic() {
    let source = "function View() @{ const value; <style apply={a} /> <main /> }";
    let result = recover(source);
    assert_recovered(&result, source);
    assert!(diagnostic_messages(&result).contains(&MULTIPLE_OUTPUTS));
    assert_eq!(multiple_output_label(&result), expect_span(source, "<main />"));

    let tape = result.program.as_ref().expect("recovered Program");
    let function = program_body(tape)[0].as_object().expect("function");
    let block = object_field(tape, function, "body");
    require_type(tape, block, "JSXCodeBlock");
    require_type(tape, object_field(tape, block, "render"), "JSXElement");
}

#[test]
fn multiple_outputs_are_recovered_under_every_recovery_option() {
    let source = "function View() @{ <style apply={a} /> <main /> }";
    for recovery in [TsrxParseRecovery::None, TsrxParseRecovery::Editor] {
        let result = parse_tsrx_with_options(
            &TsrxParseRequest { source },
            TsrxParseOptions { recovery, ..TsrxParseOptions::default() },
        )
        .expect("multiple outputs are result data");
        assert_eq!(result.status, ParseCompleteness::Recovered, "{recovery:?}");
        assert!(!result.completeness.contains(Completeness::COMPLETE), "{recovery:?}");
        assert!(result.completeness.contains(Completeness::HAS_PROGRAM), "{recovery:?}");
        assert_eq!(diagnostic_messages(&result), [MULTIPLE_OUTPUTS], "{recovery:?}");
        assert_eq!(multiple_output_label(&result), expect_span(source, "<main />"));
    }
}

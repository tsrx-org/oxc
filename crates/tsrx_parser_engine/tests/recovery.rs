#[expect(
    dead_code,
    reason = "the shared test-support module is compiled into every integration binary and each one uses a different part of it"
)]
mod support;

use support::{object_field, program_body, require_type, span};
use tsrx_parser_engine::{
    TsrxParseOptions, TsrxParseRecovery, TsrxParseRequest, TsrxParseResult, TsrxUtf16ParseRequest,
    parse_tsrx, parse_tsrx_utf16_with_options, parse_tsrx_with_options,
};
use tsrx_tape_schema::{Completeness, ParseCompleteness};

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

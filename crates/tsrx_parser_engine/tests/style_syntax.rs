//! Parser cases from the tsrx `style-syntax` table (tsrx-org/tsrx#46 / A1).

#[expect(
    dead_code,
    reason = "the shared test-support module is compiled into every integration binary and each one uses a different part of it"
)]
mod support;

use support::{
    assert_no_scaffold, field, list_field, object_field, one_object, optional_field, program_body,
    require_type, scalar_field, span,
};
use tsrx_parser_engine::{TsrxParseRequest, TsrxParseResult, parse_tsrx};
use tsrx_tape_schema::{
    Completeness, DiagnosticPhase, FlatTape, ParseCompleteness, RecordIndex, ValueRef,
};

const CSS: &str = ".a { color: red; }";
const MULTIPLE_OUTPUTS: &str =
    "A code block renders a single node; wrap multiple nodes or text in a fragment '<>…</>'.";

fn parse(source: &str) -> TsrxParseResult {
    parse_tsrx(&TsrxParseRequest { source }).unwrap_or_else(|error| {
        panic!("style-syntax fixture failed as an operational error: {error}")
    })
}

fn tape_of(result: &TsrxParseResult) -> &FlatTape {
    assert!(result.program.is_some(), "style-syntax fixture must keep a Program");
    result.program()
}

fn objects(values: &[ValueRef]) -> Vec<RecordIndex> {
    values.iter().map(|value| value.as_object().expect("list object")).collect()
}

fn component_block(tape: &FlatTape) -> RecordIndex {
    let function = one_object(&program_body(tape));
    require_type(tape, function, "FunctionDeclaration");
    let block = object_field(tape, function, "body");
    require_type(tape, block, "JSXCodeBlock");
    block
}

fn returned(tape: &FlatTape) -> RecordIndex {
    let function = one_object(&program_body(tape));
    let body = object_field(tape, function, "body");
    require_type(tape, body, "BlockStatement");
    let statement = one_object(&list_field(tape, body, "body"));
    require_type(tape, statement, "ReturnStatement");
    object_field(tape, statement, "argument")
}

fn exported_init(tape: &FlatTape) -> RecordIndex {
    let export = one_object(&program_body(tape));
    require_type(tape, export, "ExportNamedDeclaration");
    let declaration = object_field(tape, export, "declaration");
    let declarator = one_object(&list_field(tape, declaration, "declarations"));
    object_field(tape, declarator, "init")
}

fn code_block_body(tape: &FlatTape, block: RecordIndex) -> Vec<RecordIndex> {
    objects(&list_field(tape, block, "body"))
}

fn nullable_object(tape: &FlatTape, object: RecordIndex, name: &str) -> Option<RecordIndex> {
    let value = field(tape, object, name);
    if tape.scalar(value) == Some("null") {
        None
    } else {
        Some(value.as_object().expect("nullable object"))
    }
}

fn block_statements(tape: &FlatTape, block: RecordIndex) -> Vec<RecordIndex> {
    require_type(tape, block, "BlockStatement");
    objects(&list_field(tape, block, "body"))
}

fn json_string(value: &str) -> String {
    format!("\"{value}\"")
}

fn attribute_names(tape: &FlatTape, style: RecordIndex) -> Vec<String> {
    let opening = object_field(tape, style, "openingElement");
    list_field(tape, opening, "attributes")
        .into_iter()
        .map(|value| {
            let attribute = value.as_object().expect("JSXAttribute");
            let name = object_field(tape, attribute, "name");
            scalar_field(tape, name, "name").trim_matches('"').to_string()
        })
        .collect()
}

fn apply_expression_type(tape: &FlatTape, style: RecordIndex) -> Option<String> {
    let opening = object_field(tape, style, "openingElement");
    for value in list_field(tape, opening, "attributes") {
        let attribute = value.as_object().expect("JSXAttribute");
        let name = object_field(tape, attribute, "name");
        if scalar_field(tape, name, "name") != r#""apply""# {
            continue;
        }
        let container = object_field(tape, attribute, "value");
        require_type(tape, container, "JSXExpressionContainer");
        let expression = object_field(tape, container, "expression");
        return Some(scalar_field(tape, expression, "type").trim_matches('"').to_string());
    }
    None
}

fn assert_style_self(
    tape: &FlatTape,
    style: RecordIndex,
    attributes: &[&str],
    apply: Option<&str>,
) {
    require_type(tape, style, "JSXStyleElement");
    let opening = object_field(tape, style, "openingElement");
    assert_eq!(scalar_field(tape, opening, "selfClosing"), "true");
    assert_eq!(attribute_names(tape, style), attributes);
    assert_eq!(apply_expression_type(tape, style).as_deref(), apply);
    assert!(list_field(tape, style, "children").is_empty());
    assert_eq!(scalar_field(tape, style, "css"), "\"\"");
    assert_eq!(tape.scalar(field(tape, style, "closingElement")), Some("null"));
    let metadata = object_field(tape, style, "metadata");
    assert!(optional_field(tape, metadata, "styleScopeHash").is_none());
}

fn assert_style_body(
    tape: &FlatTape,
    style: RecordIndex,
    css: &str,
    attributes: &[&str],
    apply: Option<&str>,
) {
    require_type(tape, style, "JSXStyleElement");
    let opening = object_field(tape, style, "openingElement");
    assert_eq!(scalar_field(tape, opening, "selfClosing"), "false");
    assert_eq!(attribute_names(tape, style), attributes);
    assert_eq!(apply_expression_type(tape, style).as_deref(), apply);
    let stylesheet = one_object(&list_field(tape, style, "children"));
    require_type(tape, stylesheet, "StyleSheet");
    assert_eq!(scalar_field(tape, style, "css"), json_string(css));
    object_field(tape, style, "closingElement");
}

fn assert_element(tape: &FlatTape, element: RecordIndex, name: &str) {
    require_type(tape, element, "JSXElement");
    let opening = object_field(tape, element, "openingElement");
    let identifier = object_field(tape, opening, "name");
    assert_eq!(scalar_field(tape, identifier, "name"), json_string(name));
}

fn assert_style_host(tape: &FlatTape, element: RecordIndex, containers: usize) {
    assert_element(tape, element, "style");
    let children = objects(&list_field(tape, element, "children"));
    let expression_children = children
        .iter()
        .copied()
        .filter(|child| scalar_field(tape, *child, "type") == r#""JSXExpressionContainer""#)
        .collect::<Vec<_>>();
    assert_eq!(expression_children.len(), containers);
    assert!(optional_field(tape, element, "css").is_none());
}

fn assert_no_parser_errors(result: &TsrxParseResult) {
    assert_eq!(result.status, ParseCompleteness::Complete, "{:?}", result.errors);
    assert!(result.errors.is_empty(), "{:?}", result.errors);
}

fn assert_multiple_outputs(result: &TsrxParseResult, start: u32, end: u32) {
    assert!(result.program.is_some());
    assert!(result.completeness.contains(Completeness::HAS_PROGRAM));
    assert!(result.completeness.contains(Completeness::HAS_ERRORS));
    let error = result
        .errors
        .records()
        .iter()
        .find(|error| error.phase == DiagnosticPhase::Grammar)
        .expect("multiple-outputs grammar diagnostic");
    assert_eq!(result.errors.string(error.message), Some(MULTIPLE_OUTPUTS));
    let labels = result.errors.labels(error.labels).expect("grammar labels");
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0].span.start, start);
    assert_eq!(labels[0].span.end, end);
}

#[test]
fn self_closing_style_forms_keep_empty_css_and_attributes() {
    let cases: [(&str, &[&str], Option<&str>); 5] = [
        ("function App() @{ <><style /><div /></> }", &[], None),
        ("function App() @{ <><style apply={theme} /><div /></> }", &["apply"], Some("Identifier")),
        (
            "function App() @{ <><style apply={[a, b]} /><div /></> }",
            &["apply"],
            Some("ArrayExpression"),
        ),
        (
            "function App() @{ <><style apply={ns.dark} /><div /></> }",
            &["apply"],
            Some("MemberExpression"),
        ),
        (
            "function App() @{ <><style ref={r} apply={theme} /><div /></> }",
            &["ref", "apply"],
            Some("Identifier"),
        ),
    ];
    for (source, attributes, apply) in cases {
        let result = parse(source);
        assert_no_parser_errors(&result);
        let tape = tape_of(&result);
        let render = object_field(tape, component_block(tape), "render");
        let style = objects(&list_field(tape, render, "children"))[0];
        assert_style_self(tape, style, attributes, apply);
        assert_no_scaffold(tape);
    }
}

#[test]
fn bodied_style_forms_keep_sheet_css_and_apply() {
    let source = format!("function App() @{{ <><style apply={{t}}>{CSS}</style><div /></> }}");
    let result = parse(&source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let render = object_field(tape, component_block(tape), "render");
    let style = objects(&list_field(tape, render, "children"))[0];
    assert_style_body(tape, style, CSS, &["apply"], Some("Identifier"));
    assert_no_scaffold(tape);

    let source = format!("function App() {{ return <style>{CSS}</style>; }}");
    let result = parse(&source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    assert_style_body(tape, returned(tape), CSS, &[], None);
    assert_no_scaffold(tape);
}

#[test]
fn style_before_output_in_code_block_is_multiple_outputs() {
    let source = "function App() @{ const x = 1; <style apply={a} /> <div /> }";
    let result = parse(source);
    assert_multiple_outputs(&result, 51, 58);
    let tape = tape_of(&result);
    let block = component_block(tape);
    let body = code_block_body(tape, block);
    assert_eq!(body.len(), 2);
    require_type(tape, body[0], "VariableDeclaration");
    assert_style_self(tape, body[1], &["apply"], Some("Identifier"));
    assert_element(tape, object_field(tape, block, "render"), "div");
    assert_no_scaffold(tape);
}

#[test]
fn style_after_output_in_code_block_is_multiple_outputs() {
    let source = format!("function App() @{{ <div /> <style>{CSS}</style> }}");
    let result = parse(&source);
    assert_multiple_outputs(&result, 26, 59);
    let tape = tape_of(&result);
    let block = component_block(tape);
    let body = code_block_body(tape, block);
    assert_eq!(body.len(), 1);
    assert_element(tape, body[0], "div");
    assert_style_body(tape, object_field(tape, block, "render"), CSS, &[], None);
    assert_no_scaffold(tape);
}

#[test]
fn lone_style_in_code_block_parses_as_render() {
    let source = format!("function App() @{{ <style>{CSS}</style> }}");
    let result = parse(&source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let block = component_block(tape);
    assert!(code_block_body(tape, block).is_empty());
    assert_style_body(tape, object_field(tape, block, "render"), CSS, &[], None);
    assert_no_scaffold(tape);
}

#[test]
fn fragment_is_the_valid_code_block_form_for_style_and_output() {
    let source = "function App() @{ const x = 1; <><style apply={a} /><div /></> }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let block = component_block(tape);
    let body = code_block_body(tape, block);
    assert_eq!(body.len(), 1);
    require_type(tape, body[0], "VariableDeclaration");
    let render = object_field(tape, block, "render");
    require_type(tape, render, "JSXFragment");
    let children = objects(&list_field(tape, render, "children"));
    assert_style_self(tape, children[0], &["apply"], Some("Identifier"));
    assert_element(tape, children[1], "div");
    assert_no_scaffold(tape);
}

#[test]
fn nested_code_block_keeps_its_own_style_inside_a_fragment() {
    let source = "function App() @{ <><style apply={a} /><div>@{ <><style apply={b} /><span /></> }</div></> }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let render = object_field(tape, component_block(tape), "render");
    let children = objects(&list_field(tape, render, "children"));
    let div_children = objects(&list_field(tape, children[1], "children"));
    let nested = div_children[0];
    require_type(tape, nested, "JSXCodeBlock");
    assert!(code_block_body(tape, nested).is_empty());
    let nested_render = object_field(tape, nested, "render");
    require_type(tape, nested_render, "JSXFragment");
    let nested_children = objects(&list_field(tape, nested_render, "children"));
    assert_style_self(tape, nested_children[0], &["apply"], Some("Identifier"));
    assert_element(tape, nested_children[1], "span");
    assert_no_scaffold(tape);
}

#[test]
fn assigned_code_block_keeps_theme_in_setup_and_applying_fragment() {
    let source = format!(
        "const something = @{{\n\tconst theme = <style>{CSS}</style>;\n\t<>\n\t\t<style apply={{theme}}>{CSS}</style>\n\t\t<div />\n\t</>\n}};"
    );
    let result = parse(&source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let declaration = one_object(&program_body(tape));
    let declarator = one_object(&list_field(tape, declaration, "declarations"));
    let block = object_field(tape, declarator, "init");
    require_type(tape, block, "JSXCodeBlock");
    let body = code_block_body(tape, block);
    assert_eq!(body.len(), 1);
    require_type(tape, body[0], "VariableDeclaration");
    let render = object_field(tape, block, "render");
    require_type(tape, render, "JSXFragment");
    let children = objects(&list_field(tape, render, "children"));
    assert_style_body(tape, children[0], CSS, &["apply"], Some("Identifier"));
    assert_element(tape, children[1], "div");
    assert_no_scaffold(tape);
}

#[test]
fn style_beside_output_in_if_consequent_is_multiple_outputs() {
    let source = "function App() @{ @if (ok) { <style apply={a} /> <b /> } }";
    let result = parse(source);
    assert_multiple_outputs(&result, 49, 54);
    let tape = tape_of(&result);
    let if_node = object_field(tape, component_block(tape), "render");
    require_type(tape, if_node, "JSXIfExpression");
    let consequent = block_statements(tape, object_field(tape, if_node, "consequent"));
    assert_eq!(consequent.len(), 2);
    assert_style_self(tape, consequent[0], &["apply"], Some("Identifier"));
    assert_element(tape, consequent[1], "b");
    assert!(nullable_object(tape, if_node, "alternate").is_none());
    assert_no_scaffold(tape);
}

#[test]
fn lone_style_in_if_consequent_parses() {
    let source = "function App() @{ @if (ok) { <style apply={a} /> } }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let if_node = object_field(tape, component_block(tape), "render");
    let consequent = block_statements(tape, object_field(tape, if_node, "consequent"));
    assert_eq!(consequent.len(), 1);
    assert_style_self(tape, consequent[0], &["apply"], Some("Identifier"));
    assert_no_scaffold(tape);
}

#[test]
fn fragments_hold_style_and_output_inside_if_and_else() {
    let source = "function App() @{ @if (ok) { <><style apply={a} /><b /></> } @else { <><i /><style apply={c} /></> } }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let if_node = object_field(tape, component_block(tape), "render");
    let consequent = block_statements(tape, object_field(tape, if_node, "consequent"));
    require_type(tape, consequent[0], "JSXFragment");
    let consequent_children = objects(&list_field(tape, consequent[0], "children"));
    assert_style_self(tape, consequent_children[0], &["apply"], Some("Identifier"));
    assert_element(tape, consequent_children[1], "b");
    let alternate = block_statements(tape, object_field(tape, if_node, "alternate"));
    require_type(tape, alternate[0], "JSXFragment");
    let alternate_children = objects(&list_field(tape, alternate[0], "children"));
    assert_element(tape, alternate_children[0], "i");
    assert_style_self(tape, alternate_children[1], &["apply"], Some("Identifier"));
    assert_no_scaffold(tape);
}

#[test]
fn style_beside_output_in_for_body_is_multiple_outputs() {
    let source = "function App() @{ @for (const x of xs) { <style apply={a} /> <b>{x}</b> } }";
    let result = parse(source);
    assert_multiple_outputs(&result, 61, 71);
    let tape = tape_of(&result);
    let for_node = object_field(tape, component_block(tape), "render");
    require_type(tape, for_node, "JSXForExpression");
    let body = block_statements(tape, object_field(tape, for_node, "body"));
    assert_eq!(body.len(), 2);
    assert_style_self(tape, body[0], &["apply"], Some("Identifier"));
    assert_element(tape, body[1], "b");
    assert!(nullable_object(tape, for_node, "empty").is_none());
    assert_no_scaffold(tape);
}

#[test]
fn fragments_hold_style_and_output_inside_for_and_empty() {
    let source = "function App() @{ @for (const x of xs) { <><style apply={a} /><b>{x}</b></> } @empty { <><i /><style apply={c} /></> } }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let for_node = object_field(tape, component_block(tape), "render");
    let body = block_statements(tape, object_field(tape, for_node, "body"));
    let body_children = objects(&list_field(tape, body[0], "children"));
    assert_style_self(tape, body_children[0], &["apply"], Some("Identifier"));
    assert_element(tape, body_children[1], "b");
    let empty = block_statements(tape, object_field(tape, for_node, "empty"));
    let empty_children = objects(&list_field(tape, empty[0], "children"));
    assert_element(tape, empty_children[0], "i");
    assert_style_self(tape, empty_children[1], &["apply"], Some("Identifier"));
    assert_no_scaffold(tape);
}

#[test]
fn fragments_hold_style_and_output_inside_switch_cases() {
    let source = "function App() @{ @switch (k) { @case 1: { <><style apply={a} /><b /></> } @default: { <><i /><style apply={c} /></> } } }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let switch = object_field(tape, component_block(tape), "render");
    require_type(tape, switch, "JSXSwitchExpression");
    let cases = objects(&list_field(tape, switch, "cases"));
    assert_eq!(cases.len(), 2);
    require_type(tape, object_field(tape, cases[0], "test"), "Literal");
    assert_eq!(tape.scalar(field(tape, cases[1], "test")), Some("null"));
    let first = objects(&list_field(tape, cases[0], "consequent"));
    let first_children = objects(&list_field(tape, first[0], "children"));
    assert_style_self(tape, first_children[0], &["apply"], Some("Identifier"));
    assert_element(tape, first_children[1], "b");
    let default = objects(&list_field(tape, cases[1], "consequent"));
    let default_children = objects(&list_field(tape, default[0], "children"));
    assert_element(tape, default_children[0], "i");
    assert_style_self(tape, default_children[1], &["apply"], Some("Identifier"));
    assert_no_scaffold(tape);
}

#[test]
fn style_beside_output_in_try_block_is_multiple_outputs() {
    let source = "function App() @{ @try { <style apply={a} /> <b /> } @catch (e) { <i /> } }";
    let result = parse(source);
    assert_multiple_outputs(&result, 45, 50);
    let tape = tape_of(&result);
    let try_node = object_field(tape, component_block(tape), "render");
    require_type(tape, try_node, "JSXTryExpression");
    let block = block_statements(tape, object_field(tape, try_node, "block"));
    assert_style_self(tape, block[0], &["apply"], Some("Identifier"));
    assert_element(tape, block[1], "b");
    assert!(nullable_object(tape, try_node, "pending").is_none());
    let handler = object_field(tape, try_node, "handler");
    require_type(tape, handler, "CatchClause");
    let handler_body = block_statements(tape, object_field(tape, handler, "body"));
    assert_element(tape, handler_body[0], "i");
    assert_no_scaffold(tape);
}

#[test]
fn fragments_hold_style_and_output_inside_try_pending_and_catch() {
    let source = "function App() @{ @try { <><style apply={a} /><b /></> } @pending { <><style apply={p} /><u /></> } @catch (e) { <><i /><style apply={c} /></> } }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let try_node = object_field(tape, component_block(tape), "render");
    let block_children = objects(&list_field(
        tape,
        block_statements(tape, object_field(tape, try_node, "block"))[0],
        "children",
    ));
    assert_style_self(tape, block_children[0], &["apply"], Some("Identifier"));
    assert_element(tape, block_children[1], "b");
    let pending_children = objects(&list_field(
        tape,
        block_statements(tape, object_field(tape, try_node, "pending"))[0],
        "children",
    ));
    assert_style_self(tape, pending_children[0], &["apply"], Some("Identifier"));
    assert_element(tape, pending_children[1], "u");
    let handler = object_field(tape, try_node, "handler");
    let handler_children = objects(&list_field(
        tape,
        block_statements(tape, object_field(tape, handler, "body"))[0],
        "children",
    ));
    assert_element(tape, handler_children[0], "i");
    assert_style_self(tape, handler_children[1], &["apply"], Some("Identifier"));
    assert_no_scaffold(tape);
}

#[test]
fn sibling_style_blocks_live_in_fragment_children() {
    let source = format!(
        "function App() {{ return <><style apply={{a}} /><style>{CSS}</style><div /></>; }}"
    );
    let result = parse(&source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let fragment = returned(tape);
    require_type(tape, fragment, "JSXFragment");
    let children = objects(&list_field(tape, fragment, "children"));
    assert_style_self(tape, children[0], &["apply"], Some("Identifier"));
    assert_style_body(tape, children[1], CSS, &[], None);
    assert_element(tape, children[2], "div");
    assert_no_scaffold(tape);
}

#[test]
fn expression_child_style_is_an_ordinary_jsx_element() {
    let result = parse("function App() { return <style>{css}</style>; }");
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    assert_style_host(tape, returned(tape), 1);
    assert_no_scaffold(tape);

    let result = parse("function App() @{ <section><style>{css}</style><div /></section> }");
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let section = object_field(tape, component_block(tape), "render");
    assert_element(tape, section, "section");
    let children = objects(&list_field(tape, section, "children"));
    assert_style_host(tape, children[0], 1);
    assert_element(tape, children[1], "div");
    assert_no_scaffold(tape);

    let result = parse("function App() { return <section><style>\n\t{css}\n</style></section>; }");
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let section = returned(tape);
    let children = objects(&list_field(tape, section, "children"));
    assert_style_host(tape, children[0], 1);
    assert_no_scaffold(tape);

    let result = parse("function App() { return <style>{reset}{theme}</style>; }");
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    assert_style_host(tape, returned(tape), 2);
    assert_no_scaffold(tape);
}

#[test]
fn brace_inside_css_text_still_parses_as_a_bodied_style() {
    let result = parse("function App() @{ <><style>.a{color:red}</style><div /></> }");
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let render = object_field(tape, component_block(tape), "render");
    let style = objects(&list_field(tape, render, "children"))[0];
    assert_style_body(tape, style, ".a{color:red}", &[], None);
    assert_no_scaffold(tape);
}

#[test]
fn module_scope_style_forms_parse() {
    let result = parse("export const theme = <style apply={[a, b]} />;");
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    assert_style_self(tape, exported_init(tape), &["apply"], Some("ArrayExpression"));
    assert_no_scaffold(tape);

    let source = format!("<style>{CSS}</style>;\nexport function App() {{ return <div />; }}");
    let result = parse(&source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let first = program_body(tape)[0].as_object().expect("bare style");
    assert_style_body(tape, first, CSS, &[], None);
    assert_no_scaffold(tape);
}

#[test]
fn head_style_has_no_scope_hash_on_the_tape() {
    let result =
        parse("function App() { return <head><style>body { margin: 0; }</style></head>; }");
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let head = returned(tape);
    let style = objects(&list_field(tape, head, "children"))[0];
    assert_style_body(tape, style, "body { margin: 0; }", &[], None);
    let metadata = object_field(tape, style, "metadata");
    assert!(optional_field(tape, metadata, "styleScopeHash").is_none());
    assert_no_scaffold(tape);
}

#[test]
fn raw_style_in_a_switch_case_does_not_break_the_following_case() {
    let source = "function App() @{ @switch (k) { @case 1: { <style>.a{color:red}</style> } @case 2: { <div /> } } }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let switch = object_field(tape, component_block(tape), "render");
    require_type(tape, switch, "JSXSwitchExpression");
    let cases = objects(&list_field(tape, switch, "cases"));
    assert_eq!(cases.len(), 2);
    let first = objects(&list_field(tape, cases[0], "consequent"));
    assert_style_body(tape, first[0], ".a{color:red}", &[], None);
    let second = objects(&list_field(tape, cases[1], "consequent"));
    assert_element(tape, second[0], "div");
    assert_no_scaffold(tape);
}

#[test]
fn expression_child_style_does_not_steal_a_sibling_raw_style_owner() {
    let source = "function App() @{ <><style>{css}</style><style>.a{color:red}</style></> }";
    let result = parse(source);
    assert_no_parser_errors(&result);
    let tape = tape_of(&result);
    let render = object_field(tape, component_block(tape), "render");
    let children = objects(&list_field(tape, render, "children"));
    assert_style_host(tape, children[0], 1);
    assert_style_body(tape, children[1], ".a{color:red}", &[], None);
    assert_no_scaffold(tape);
}

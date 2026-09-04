mod support;

use std::fmt::Write as _;

use support::{
    assert_all_records_and_scalar_bytes_reachable, assert_empty_path, assert_failed,
    assert_no_scaffold, field, list_field, object_field, one_object, optional_field, program_body,
    require_type, scalar_field, span,
};
use tsrx_parser_engine::{TsrxParseRequest, parse_tsrx};
use tsrx_tape_schema::{FlatTape, RecordIndex};

fn field_names(tape: &FlatTape, object: RecordIndex) -> Vec<&str> {
    tape.fields(object).map(|record| tape.key(record)).collect()
}

fn initializer(tape: &FlatTape) -> RecordIndex {
    let declaration = one_object(&program_body(tape));
    let declarator = one_object(&list_field(tape, declaration, "declarations"));
    object_field(tape, declarator, "init")
}

fn ordinary_function_body(tape: &FlatTape) -> Vec<tsrx_tape_schema::ValueRef> {
    let function = one_object(&program_body(tape));
    let block = object_field(tape, function, "body");
    list_field(tape, block, "body")
}

fn count_type(tape: &FlatTape, expected: &str) -> usize {
    let encoded = format!(r#""{expected}""#);
    (0..tape.object_count())
        .filter(|raw| {
            let raw = u32::try_from(*raw).expect("object index fits u32");
            optional_field(tape, RecordIndex::new(raw), "type").and_then(|value| tape.scalar(value))
                == Some(encoded.as_str())
        })
        .count()
}

#[test]
fn reconstructs_paired_style_with_exact_canonical_raw_shape() {
    let source = r#"const x=<style media="screen" scoped>.a{color:red}</style>;"#;
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("paired raw style");
    let tape = result.program();
    let style = initializer(tape);
    let element_start = u32::try_from(source.find("<style").unwrap()).unwrap();
    let opening_end = u32::try_from(source.find(">.a").unwrap() + 1).unwrap();
    let closing_start = u32::try_from(source.find("</style>").unwrap()).unwrap();
    let element_end = closing_start + u32::try_from("</style>".len()).unwrap();

    require_type(tape, style, "JSXStyleElement");
    assert_eq!(span(tape, style), (element_start, element_end));
    assert_eq!(
        field_names(tape, style),
        ["type", "start", "end", "metadata", "children", "openingElement", "closingElement", "css",]
    );
    assert_empty_path(tape, style);
    let stylesheet = one_object(&list_field(tape, style, "children"));
    require_type(tape, stylesheet, "StyleSheet");
    assert_eq!(scalar_field(tape, style, "css"), r#"".a{color:red}""#);

    let opening = object_field(tape, style, "openingElement");
    require_type(tape, opening, "JSXOpeningElement");
    assert_eq!(span(tape, opening), (element_start, opening_end));
    assert_eq!(
        field_names(tape, opening),
        ["type", "start", "end", "attributes", "name", "selfClosing"]
    );
    assert_eq!(list_field(tape, opening, "attributes").len(), 2);
    assert_eq!(scalar_field(tape, opening, "selfClosing"), "false");
    let name = object_field(tape, opening, "name");
    require_type(tape, name, "JSXIdentifier");
    assert_eq!(scalar_field(tape, name, "name"), r#""style""#);

    let closing = object_field(tape, style, "closingElement");
    require_type(tape, closing, "JSXClosingElement");
    assert_eq!(span(tape, closing), (closing_start, element_end));
    assert_eq!(field_names(tape, closing), ["type", "start", "end", "name"]);
    assert_no_scaffold(tape);
}

#[test]
fn preserves_invalid_css_and_jsx_like_bytes_as_one_raw_scalar() {
    let source = concat!(
        "const x=<style>/* <Fake> @if(x){} */\n",
        ".a { content: \"x\\\\y\"; color: }</style>;",
    );
    let result = parse_tsrx(&TsrxParseRequest { source })
        .expect("canonical raw style must not parse or reject CSS");
    let tape = result.program();
    let style = initializer(tape);
    assert_eq!(
        scalar_field(tape, style, "css"),
        r#""/* <Fake> @if(x){} */\n.a { content: \"x\\\\y\"; color: }""#
    );
    let stylesheet = one_object(&list_field(tape, style, "children"));
    require_type(tape, stylesheet, "StyleSheet");
    assert_eq!(count_type(tape, "JSXElement"), 0);
    assert_eq!(count_type(tape, "JSXIfExpression"), 0);
    assert_no_scaffold(tape);
}

#[test]
fn distinguishes_empty_paired_self_closing_and_uppercase_style_elements() {
    let source = "const x=<style></style>;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("empty paired style");
    let tape = result.program();
    let style = initializer(tape);
    require_type(tape, style, "JSXStyleElement");
    assert_eq!(scalar_field(tape, style, "css"), "\"\"");
    let stylesheet = one_object(&list_field(tape, style, "children"));
    require_type(tape, stylesheet, "StyleSheet");
    object_field(tape, style, "closingElement");
    assert_no_scaffold(tape);

    let source = "const x=<style media=\"print\" scoped/>;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("self-closing style");
    let tape = result.program();
    let style = initializer(tape);
    require_type(tape, style, "JSXStyleElement");
    assert_eq!(
        field_names(tape, style),
        ["type", "start", "end", "metadata", "children", "openingElement", "closingElement", "css",]
    );
    assert!(list_field(tape, style, "children").is_empty());
    assert_eq!(tape.scalar(field(tape, style, "closingElement")), Some("null"));
    assert_eq!(scalar_field(tape, style, "css"), "\"\"");
    let opening = object_field(tape, style, "openingElement");
    assert_eq!(scalar_field(tape, opening, "selfClosing"), "true");
    assert_eq!(list_field(tape, opening, "attributes").len(), 2);
    assert_no_scaffold(tape);

    let source = "function View() @{ <Style>.a</Style> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("uppercase ordinary JSX");
    assert_eq!(count_type(result.program(), "JSXStyleElement"), 0);
    assert_eq!(count_type(result.program(), "JSXElement"), 1);
    assert_no_scaffold(result.program());
}

#[test]
fn exposes_css_rule_selector_ends_relative_to_the_style_payload() {
    let css = ".card { color:red }\n  .card h2, .title { color:blue }";
    let source = format!("const x=<style>{css}</style>;");
    let result = parse_tsrx(&TsrxParseRequest { source: &source }).expect("CSS topology");
    let tape = result.program();
    let style = initializer(tape);
    let stylesheet = one_object(&list_field(tape, style, "children"));
    require_type(tape, stylesheet, "StyleSheet");
    assert_eq!(span(tape, stylesheet), (0, 53));

    let rules = list_field(tape, stylesheet, "children");
    assert_eq!(rules.len(), 2);
    let selector_ends = rules
        .iter()
        .flat_map(|rule| {
            let rule = rule.as_object().expect("CSS Rule");
            require_type(tape, rule, "Rule");
            let prelude = object_field(tape, rule, "prelude");
            require_type(tape, prelude, "SelectorList");
            list_field(tape, prelude, "children")
                .into_iter()
                .map(|selector| span(tape, selector.as_object().expect("complex selector")).1)
        })
        .collect::<Vec<_>>();
    assert_eq!(selector_ends, [5, 30, 38]);
    assert_no_scaffold(tape);
}

#[test]
fn nested_style_attributes_keep_preorder_owners_and_independent_raw_payloads() {
    let source = "const x=<style child={<style>inner</style>}>outer</style>;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("nested style attribute");
    let tape = result.program();
    let outer = initializer(tape);
    require_type(tape, outer, "JSXStyleElement");
    assert_eq!(scalar_field(tape, outer, "css"), r#""outer""#);

    let opening = object_field(tape, outer, "openingElement");
    let attribute = one_object(&list_field(tape, opening, "attributes"));
    let container = object_field(tape, attribute, "value");
    require_type(tape, container, "JSXExpressionContainer");
    let inner = object_field(tape, container, "expression");
    require_type(tape, inner, "JSXStyleElement");
    assert_eq!(scalar_field(tape, inner, "css"), r#""inner""#);
    assert_eq!(count_type(tape, "JSXStyleElement"), 2);
    assert_no_scaffold(tape);

    let source = "const x=<style child={<style media=\"print\"/>}/>;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("nested self-closing styles");
    let tape = result.program();
    let outer = initializer(tape);
    let opening = object_field(tape, outer, "openingElement");
    let attribute = one_object(&list_field(tape, opening, "attributes"));
    let container = object_field(tape, attribute, "value");
    let inner = object_field(tape, container, "expression");
    for style in [outer, inner] {
        require_type(tape, style, "JSXStyleElement");
        assert_eq!(scalar_field(tape, style, "css"), "\"\"");
        assert!(list_field(tape, style, "children").is_empty());
    }
    assert_eq!(count_type(tape, "JSXStyleElement"), 2);
    assert_no_scaffold(tape);
}

#[test]
fn normalizes_bare_style_statements_and_semicolons_like_dynamic_elements() {
    let source = "function f(){<style>.x{}</style>}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("bare paired style");
    let body = ordinary_function_body(result.program());
    assert_eq!(body.len(), 1);
    require_type(
        result.program(),
        body[0].as_object().expect("bare style object"),
        "JSXStyleElement",
    );
    assert_no_scaffold(result.program());

    let source = "function f(){<style>.x{}</style>;}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("immediate style semicolon");
    let body = ordinary_function_body(result.program());
    assert_eq!(body.len(), 2);
    require_type(
        result.program(),
        body[0].as_object().expect("paired style object"),
        "JSXStyleElement",
    );
    require_type(result.program(), body[1].as_object().expect("empty statement"), "EmptyStatement");
    assert_no_scaffold(result.program());

    for source in
        ["function f(){<style>.x{}</style> ;}", "function f(){<style>.x{}</style> /* keep */ ;}"]
    {
        let result = parse_tsrx(&TsrxParseRequest { source }).unwrap_or_else(|error| {
            panic!("separated paired style failed for `{source}`: {error}")
        });
        let body = ordinary_function_body(result.program());
        assert_eq!(body.len(), 2, "{source}");
        require_type(
            result.program(),
            body[0].as_object().expect("paired style object"),
            "JSXStyleElement",
        );
        let semicolon = body[1].as_object().expect("empty statement");
        require_type(result.program(), semicolon, "EmptyStatement");
        let start = u32::try_from(source.rfind(';').expect("semicolon")).expect("u32 span");
        assert_eq!(span(result.program(), semicolon), (start, start + 1));
        assert_no_scaffold(result.program());
    }

    let source = "function f(){<style/> /* keep */ ;}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("separated style semicolon");
    let body = ordinary_function_body(result.program());
    assert_eq!(body.len(), 2);
    require_type(
        result.program(),
        body[0].as_object().expect("self-closing style object"),
        "JSXStyleElement",
    );
    let semicolon = body[1].as_object().expect("semicolon statement");
    require_type(result.program(), semicolon, "ExpressionStatement");
    let text = object_field(result.program(), semicolon, "expression");
    require_type(result.program(), text, "JSXText");
    assert_eq!(scalar_field(result.program(), text, "value"), r#"";""#);
    let start = u32::try_from(source.rfind(';').expect("semicolon")).expect("u32 span");
    assert_eq!(span(result.program(), semicolon), (start, start + 1));
    assert_eq!(span(result.program(), text), (start, start + 1));
    assert_no_scaffold(result.program());

    let source = "function f(){<style/>;<{Tag}/>;}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("mixed bare custom JSX");
    let body = ordinary_function_body(result.program());
    assert_eq!(body.len(), 4);
    for (index, expected) in ["JSXStyleElement", "EmptyStatement", "JSXElement", "EmptyStatement"]
        .into_iter()
        .enumerate()
    {
        require_type(result.program(), body[index].as_object().expect("body object"), expected);
    }
    assert_no_scaffold(result.program());
}

#[test]
fn composes_raw_styles_with_dynamic_tags_controls_and_expression_placements() {
    for source in [
        "function View() @{ <style>@if(x){<{Fake}/>} color:</style> }",
        "function View() @{ <main>@if(ok){<style>.a{color:red}</style>}</main> }",
        "const x=<main css={<style>.a{color:red}</style>}/>;",
        "const x=<{Outer} css={<style>.a{color:red}</style>}/>;",
        "const x=<{() => <style>.a{color:red}</style>}/>;",
        "const x=<><style>.a{color:red}</style><{Tag}/></>;",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("style composition failed for `{source}`: {error}"));
        assert_eq!(count_type(result.program(), "JSXStyleElement"), 1, "{source}");
        assert_no_scaffold(result.program());
    }
}

#[test]
fn rejects_malformed_style_boundaries_without_a_partial_program() {
    for source in [
        "const x=<style>.a{color:red};",
        "const x=<style>.a{color:red}</Style>;",
        "const x=<style>.a{color:red}</style >;",
        "const x=<style / >;",
    ] {
        assert_failed(source);
    }
}

#[test]
fn style_marker_collisions_and_wide_siblings_remain_ordered() {
    let source = "const x=<style>._t0_S0__{color:red}</style>;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("style marker collision");
    assert_eq!(
        scalar_field(result.program(), initializer(result.program()), "css"),
        r#""._t0_S0__{color:red}""#
    );
    assert_eq!(count_type(result.program(), "JSXExpressionContainer"), 0);
    assert_all_records_and_scalar_bytes_reachable(result.program());

    let mut source = String::from("const x=<>");
    for index in 0..256 {
        write!(source, "<style>.s{index}{{order:{index}}}</style>")
            .expect("writing to a String cannot fail");
    }
    source.push_str("</>;");
    let result = parse_tsrx(&TsrxParseRequest { source: &source }).expect("wide raw styles");
    assert_eq!(count_type(result.program(), "JSXStyleElement"), 256);
    assert_no_scaffold(result.program());
}

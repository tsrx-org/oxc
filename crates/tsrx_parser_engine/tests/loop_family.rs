#[expect(
    dead_code,
    reason = "the shared test-support module is compiled into every integration binary and each one uses a different part of it"
)]
mod support;

use support::{
    assert_empty_path, assert_no_scaffold, field, list_field, object_field, one_object,
    optional_field, program_body, require_type, scalar_field, span,
};
use tsrx_parser_engine::{TsrxParseOptions, TsrxParseRequest, parse_tsrx, parse_tsrx_with_options};
use tsrx_tape_schema::{FlatTape, RecordIndex};

fn assert_for_head(
    tape: &FlatTape,
    node: RecordIndex,
    expected_span: (u32, u32),
    statement_type: &str,
    body_span: (u32, u32),
    has_empty: bool,
) {
    require_type(tape, node, "JSXForExpression");
    assert_eq!(scalar_field(tape, node, "statementType"), format!(r#""{statement_type}""#));
    assert_eq!(span(tape, node), expected_span);
    let body = object_field(tape, node, "body");
    require_type(tape, body, "BlockStatement");
    assert_eq!(span(tape, body), body_span);
    assert_empty_path(tape, node);
    if !has_empty {
        assert_eq!(tape.scalar(field(tape, node, "empty")), Some("null"));
    }
}

fn variable_declarator_id(tape: &FlatTape, declaration: RecordIndex) -> RecordIndex {
    require_type(tape, declaration, "VariableDeclaration");
    let declarator = one_object(&list_field(tape, declaration, "declarations"));
    object_field(tape, declarator, "id")
}

#[test]
fn reconstructs_statement_for_of_as_an_expression_statement() {
    let source = "function run(){@for(const x of xs){use(x)}}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("statement @for-of");
    let tape = result.program();
    let function = one_object(&program_body(tape));
    let function_body = object_field(tape, function, "body");
    let statement = one_object(&list_field(tape, function_body, "body"));
    require_type(tape, statement, "ExpressionStatement");
    assert_eq!(span(tape, statement), (15, 42));
    let loop_node = object_field(tape, statement, "expression");
    assert_for_head(tape, loop_node, (15, 42), "ForOfStatement", (34, 42), false);

    assert_eq!(scalar_field(tape, loop_node, "await"), "false");
    let left = object_field(tape, loop_node, "left");
    assert_eq!(span(tape, left), (20, 27));
    assert_eq!(span(tape, variable_declarator_id(tape, left)), (26, 27));
    let right = object_field(tape, loop_node, "right");
    require_type(tape, right, "Identifier");
    assert_eq!(span(tape, right), (31, 33));
    assert_eq!(tape.scalar(field(tape, loop_node, "index")), Some("null"));
    assert!(optional_field(tape, loop_node, "key").is_none());
    assert_no_scaffold(tape);
}

#[test]
fn reconstructs_expression_for_of_directly_as_the_initializer() {
    let source = "const value=@for(const x of xs){x};";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("expression @for-of");
    let tape = result.program();
    let declaration = one_object(&program_body(tape));
    let declarator = one_object(&list_field(tape, declaration, "declarations"));
    let loop_node = object_field(tape, declarator, "init");
    assert_for_head(tape, loop_node, (12, 34), "ForOfStatement", (31, 34), false);
    assert_eq!(span(tape, object_field(tape, loop_node, "left")), (17, 24));
    assert_eq!(span(tape, object_field(tape, loop_node, "right")), (28, 30));
    assert_no_scaffold(tape);
}

#[test]
fn reconstructs_jsx_child_for_of_directly_in_children() {
    let source = "function View() @{<main>@for(const x of xs){<b>{x}</b>}</main>}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("JSX-child @for-of");
    let tape = result.program();
    let function = one_object(&program_body(tape));
    let code_block = object_field(tape, function, "body");
    let render = object_field(tape, code_block, "render");
    let loop_node = one_object(&list_field(tape, render, "children"));
    assert_for_head(tape, loop_node, (24, 55), "ForOfStatement", (43, 55), false);
    let body = object_field(tape, loop_node, "body");
    let child = one_object(&list_field(tape, body, "body"));
    require_type(tape, child, "JSXElement");
    assert_eq!(span(tape, child), (44, 54));
    assert_no_scaffold(tape);
}

#[test]
fn preserves_jsx_block_comments_inside_keyed_loop_bodies() {
    let source = concat!(
        "function ItemList({ items }) @{\n\t<ul>\n",
        "\t\t@for (const item of items; key item.id) {\n",
        "\t\t\t{\n\t\t\t\t/* distinct */\n\t\t\t}\n",
        "\t\t\t<li>x</li>\n\t\t}\n\t</ul>\n}",
    );
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("commented keyed @for");
    assert_no_scaffold(result.program());
}

#[test]
fn preserves_for_await_on_for_of_only() {
    let source = "const value=@for await(const x of xs){x};";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("@for await");
    let tape = result.program();
    let declaration = one_object(&program_body(tape));
    let declarator = one_object(&list_field(tape, declaration, "declarations"));
    let loop_node = object_field(tape, declarator, "init");
    assert_for_head(tape, loop_node, (12, 40), "ForOfStatement", (37, 40), false);
    assert_eq!(scalar_field(tape, loop_node, "await"), "true");
    assert_eq!(span(tape, object_field(tape, loop_node, "left")), (23, 30));
    assert_eq!(span(tape, object_field(tape, loop_node, "right")), (34, 36));
    assert_no_scaffold(tape);
}

#[test]
fn preserves_classic_for_fields_and_absent_for_of_fields() {
    let source = "function run(){@for(let i=0;i<3;i++){use(i)}}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("classic @for");
    let tape = result.program();
    let function = one_object(&program_body(tape));
    let function_body = object_field(tape, function, "body");
    let statement = one_object(&list_field(tape, function_body, "body"));
    let loop_node = object_field(tape, statement, "expression");
    assert_for_head(tape, loop_node, (15, 44), "ForStatement", (36, 44), false);
    assert_eq!(span(tape, object_field(tape, loop_node, "init")), (20, 27));
    assert_eq!(span(tape, object_field(tape, loop_node, "test")), (28, 31));
    assert_eq!(span(tape, object_field(tape, loop_node, "update")), (32, 35));
    for absent in ["await", "left", "right", "index", "key"] {
        assert!(optional_field(tape, loop_node, absent).is_none());
    }
    assert_no_scaffold(tape);
}

#[test]
fn preserves_for_in_fields_and_absent_for_of_metadata() {
    let source = "function run(){@for(const x in xs){use(x)}}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("@for-in");
    let tape = result.program();
    let function = one_object(&program_body(tape));
    let function_body = object_field(tape, function, "body");
    let statement = one_object(&list_field(tape, function_body, "body"));
    let loop_node = object_field(tape, statement, "expression");
    assert_for_head(tape, loop_node, (15, 42), "ForInStatement", (34, 42), false);
    assert_eq!(span(tape, object_field(tape, loop_node, "left")), (20, 27));
    assert_eq!(span(tape, object_field(tape, loop_node, "right")), (31, 33));
    for absent in ["await", "index", "key"] {
        assert!(optional_field(tape, loop_node, absent).is_none());
    }
    assert_no_scaffold(tape);
}

#[test]
fn reconstructs_index_key_and_empty_annotations_from_authored_nodes() {
    let source = concat!(
        "function View() @{<main>@for(const x of xs;index i;key x.id)",
        "{<b>{i}</b>}@empty{<i/>}</main>}"
    );
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("annotated @for");
    let tape = result.program();
    let function = one_object(&program_body(tape));
    let code_block = object_field(tape, function, "body");
    let render = object_field(tape, code_block, "render");
    let loop_node = one_object(&list_field(tape, render, "children"));
    assert_for_head(tape, loop_node, (24, 72), "ForOfStatement", (60, 72), true);
    assert_eq!(span(tape, object_field(tape, loop_node, "right")), (40, 42));

    let index = object_field(tape, loop_node, "index");
    require_type(tape, index, "Identifier");
    assert_eq!(span(tape, index), (49, 50));
    let key = object_field(tape, loop_node, "key");
    require_type(tape, key, "MemberExpression");
    assert_eq!(span(tape, key), (55, 59));

    let body = object_field(tape, loop_node, "body");
    let body_child = one_object(&list_field(tape, body, "body"));
    require_type(tape, body_child, "JSXElement");
    let empty = object_field(tape, loop_node, "empty");
    require_type(tape, empty, "BlockStatement");
    assert_eq!(span(tape, empty), (78, 84));
    assert_empty_path(tape, empty);
    let empty_child = one_object(&list_field(tape, empty, "body"));
    require_type(tape, empty_child, "JSXElement");
    assert_eq!(span(tape, empty_child), (79, 83));
    assert_no_scaffold(tape);
}

#[test]
fn composes_a_nested_if_inside_a_jsx_child_for() {
    let source =
        concat!("function View() @{<main>@for(const x of xs)", "{@if(x){<b/>}@else{<i/>}}</main>}");
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("nested @for and @if");
    let tape = result.program();
    let function = one_object(&program_body(tape));
    let code_block = object_field(tape, function, "body");
    let render = object_field(tape, code_block, "render");
    let loop_node = one_object(&list_field(tape, render, "children"));
    assert_for_head(tape, loop_node, (24, 68), "ForOfStatement", (43, 68), false);
    let body = object_field(tape, loop_node, "body");
    let if_node = one_object(&list_field(tape, body, "body"));
    require_type(tape, if_node, "JSXIfExpression");
    assert_eq!(span(tape, if_node), (44, 67));
    assert_no_scaffold(tape);
}

#[test]
fn reconstructs_an_expression_empty_clause_and_absent_key() {
    let source = "const value=@for(const x of xs;index i){x}@empty{none};";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("expression @for with empty");
    let tape = result.program();
    let declaration = one_object(&program_body(tape));
    let declarator = one_object(&list_field(tape, declaration, "declarations"));
    let loop_node = object_field(tape, declarator, "init");
    assert_for_head(tape, loop_node, (12, 42), "ForOfStatement", (39, 42), true);
    assert_eq!(span(tape, object_field(tape, loop_node, "index")), (37, 38));
    assert!(optional_field(tape, loop_node, "key").is_none());
    let empty = object_field(tape, loop_node, "empty");
    assert_eq!(span(tape, empty), (48, 54));
    let empty_value = one_object(&list_field(tape, empty, "body"));
    require_type(tape, empty_value, "ExpressionStatement");
    assert_no_scaffold(tape);
}

#[test]
fn promotes_a_terminal_statement_for_and_empty_to_code_block_render() {
    let source = "function View() @{ @for (const x of xs) { <p>{x}</p> } @empty { <i/> } }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("terminal statement @for");
    let tape = result.program();
    let function = one_object(&program_body(tape));
    let code_block = object_field(tape, function, "body");
    require_type(tape, code_block, "JSXCodeBlock");
    assert!(list_field(tape, code_block, "body").is_empty());
    let loop_node = object_field(tape, code_block, "render");
    assert_for_head(tape, loop_node, (19, 54), "ForOfStatement", (40, 54), true);
    let body = object_field(tape, loop_node, "body");
    let child = one_object(&list_field(tape, body, "body"));
    require_type(tape, child, "JSXElement");
    let empty = object_field(tape, loop_node, "empty");
    assert_eq!(span(tape, empty), (62, 70));
    let child = one_object(&list_field(tape, empty, "body"));
    require_type(tape, child, "JSXElement");
    assert_no_scaffold(tape);
}

#[test]
fn preserves_projection_header_ordinals_for_nested_annotated_loops() {
    let source = concat!(
        "function View() @{<main>@for(const x of xs;index i)",
        "{@for(const y of x.children;key y.id){<b>{y}</b>}}</main>}"
    );
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("nested annotated @for");
    let tape = result.program();
    let function = one_object(&program_body(tape));
    let code_block = object_field(tape, function, "body");
    let render = object_field(tape, code_block, "render");
    let outer = one_object(&list_field(tape, render, "children"));
    require_type(tape, outer, "JSXForExpression");
    assert_eq!(scalar_field(tape, object_field(tape, outer, "index"), "name"), r#""i""#);
    assert!(optional_field(tape, outer, "key").is_none());

    let outer_body = object_field(tape, outer, "body");
    let inner = one_object(&list_field(tape, outer_body, "body"));
    require_type(tape, inner, "JSXForExpression");
    assert_eq!(tape.scalar(field(tape, inner, "index")), Some("null"));
    let key = object_field(tape, inner, "key");
    require_type(tape, key, "MemberExpression");
    assert_eq!(scalar_field(tape, object_field(tape, key, "property"), "name"), r#""id""#);
    assert_no_scaffold(tape);
}

fn annotated_loop(tape: &FlatTape) -> RecordIndex {
    let function = one_object(&program_body(tape));
    let code_block = object_field(tape, function, "body");
    let render = object_field(tape, code_block, "render");
    let loop_node = one_object(&list_field(tape, render, "children"));
    require_type(tape, loop_node, "JSXForExpression");
    loop_node
}

fn header_value<'a>(
    tape: &'a FlatTape,
    loop_node: RecordIndex,
    name: &str,
) -> (&'a str, (u32, u32)) {
    let value = object_field(tape, loop_node, name);
    (scalar_field(tape, value, "type"), span(tape, value))
}

const PARENTHESIZED_HEADER: &str =
    "function View() @{<main>@for(const x of (a, xs);index (i);key (x.id)){<b>{x}</b>}</main>}";

#[test]
fn keeps_a_parenthesized_iterable_index_and_key_by_default() {
    // tsrx-org/oxc#151: with parentheses kept, each value is the ParenthesizedExpression the
    // author wrote, from its `(` to its `)`.
    let result = parse_tsrx(&TsrxParseRequest { source: PARENTHESIZED_HEADER })
        .expect("parenthesized @for header");
    let tape = result.program();
    let loop_node = annotated_loop(tape);
    let parenthesized = r#""ParenthesizedExpression""#;
    assert_eq!(header_value(tape, loop_node, "right"), (parenthesized, (40, 47)));
    assert_eq!(header_value(tape, loop_node, "index"), (parenthesized, (54, 57)));
    assert_eq!(header_value(tape, loop_node, "key"), (parenthesized, (62, 68)));
    assert_no_scaffold(tape);
}

#[test]
fn reads_a_parenthesized_iterable_index_and_key_inside_their_parentheses() {
    // tsrx-org/oxc#151: @tsrx/core drops the parentheses and spans the expression inside them.
    let result = parse_tsrx_with_options(
        &TsrxParseRequest { source: PARENTHESIZED_HEADER },
        TsrxParseOptions { preserve_parens: Some(false), ..TsrxParseOptions::default() },
    )
    .expect("parenthesized @for header");
    let tape = result.program();
    let loop_node = annotated_loop(tape);
    assert_eq!(header_value(tape, loop_node, "right"), (r#""SequenceExpression""#, (41, 46)));
    assert_eq!(header_value(tape, loop_node, "index"), (r#""Identifier""#, (55, 56)));
    assert_eq!(header_value(tape, loop_node, "key"), (r#""MemberExpression""#, (63, 67)));
    assert_no_scaffold(tape);
}

#[test]
fn reads_header_values_wrapped_in_comments_and_nested_parentheses() {
    let source = concat!(
        "function View() @{<main>@for(const x of /*c*/ ((xs)) /*d*/;key ( x // k\n))",
        "{<b>{x}</b>}</main>}"
    );
    let result = parse_tsrx_with_options(
        &TsrxParseRequest { source },
        TsrxParseOptions { preserve_parens: Some(false), ..TsrxParseOptions::default() },
    )
    .expect("commented @for header");
    let tape = result.program();
    let loop_node = annotated_loop(tape);
    assert_eq!(header_value(tape, loop_node, "right"), (r#""Identifier""#, (48, 50)));
    assert_eq!(header_value(tape, loop_node, "key"), (r#""Identifier""#, (65, 66)));
    assert_no_scaffold(tape);
}

#[test]
fn rejects_an_index_that_is_not_one_parenthesized_name() {
    for index in ["(i)(j)", "(i, j)", "((i)", "i + 1", "(i) + 1"] {
        let source =
            format!("function View() @{{<main>@for(const x of xs;index {index}){{x}}</main>}}");
        let result = parse_tsrx(&TsrxParseRequest { source: &source }).expect("scanned");
        assert_eq!(result.status, tsrx_tape_schema::ParseCompleteness::Failed, "{source}");
    }
}

#[test]
fn annotated_for_line_terminators_preserve_index_and_key_spans() {
    for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
        let source = format!(
            "const value = @for(const item of items;{newline}index{newline}i{newline};{newline}key{newline}item.id{newline}) {{ <div/> }};"
        );
        let units: Vec<u16> = source.encode_utf16().collect();
        let result =
            tsrx_parser_engine::parse_tsrx_utf16(&tsrx_parser_engine::TsrxUtf16ParseRequest {
                source: &units,
            })
            .unwrap();
        assert!(result.errors.is_empty(), "{source:?}: {:?}", result.errors);
        let tape = result.program();
        let declaration = one_object(&program_body(tape));
        let declarator = one_object(&list_field(tape, declaration, "declarations"));
        let node = object_field(tape, declarator, "init");
        require_type(tape, node, "JSXForExpression");
        let index = object_field(tape, node, "index");
        let key = object_field(tape, node, "key");
        require_type(tape, index, "Identifier");
        require_type(tape, key, "MemberExpression");
        let offset = |byte: usize| u32::try_from(source[..byte].encode_utf16().count()).unwrap();
        let index_start = source.find(&format!("{newline}i{newline};")).unwrap() + newline.len();
        let key_start = source.find("item.id").unwrap();
        assert_eq!(span(tape, index), (offset(index_start), offset(index_start + 1)));
        assert_eq!(span(tape, key), (offset(key_start), offset(key_start + 7)));
        assert_no_scaffold(tape);
    }
}

#[test]
fn destructured_for_index_accepts_every_line_terminator() {
    for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
        let source =
            format!("const value = @for({{id, label}} of items; {newline}index i) {{ <div/> }};");
        let units: Vec<u16> = source.encode_utf16().collect();
        let result =
            tsrx_parser_engine::parse_tsrx_utf16(&tsrx_parser_engine::TsrxUtf16ParseRequest {
                source: &units,
            })
            .unwrap();
        assert!(result.errors.is_empty(), "{source:?}: {:?}", result.errors);
        assert_no_scaffold(result.program());
    }
}

#[test]
fn header_of_line_terminators_preserve_engine_annotations() {
    for left in ["const item", "item", "{id}"] {
        for (before, after) in [("\n", " "), (" ", "\n"), ("\n", "\n")] {
            for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
                let before = before.replace('\n', newline);
                let after = after.replace('\n', newline);
                let source = format!(
                    "const value = @for({left}{before}of{after}items; index i; key id) {{ <div/> }};"
                );
                let units: Vec<u16> = source.encode_utf16().collect();
                let result = tsrx_parser_engine::parse_tsrx_utf16(
                    &tsrx_parser_engine::TsrxUtf16ParseRequest { source: &units },
                )
                .unwrap();
                assert!(result.errors.is_empty(), "{source:?}: {:?}", result.errors);
                let tape = result.program();
                let declaration = one_object(&program_body(tape));
                let declarator = one_object(&list_field(tape, declaration, "declarations"));
                let node = object_field(tape, declarator, "init");
                require_type(tape, node, "JSXForExpression");
                for (field_name, text) in [("right", "items"), ("index", "i"), ("key", "id")] {
                    let value = object_field(tape, node, field_name);
                    require_type(tape, value, "Identifier");
                    let start = match field_name {
                        "index" => source.find("index i").unwrap() + 6,
                        "key" => source.find("key id").unwrap() + 4,
                        _ => source.find("items").unwrap(),
                    };
                    let offset =
                        |byte: usize| u32::try_from(source[..byte].encode_utf16().count()).unwrap();
                    assert_eq!(span(tape, value), (offset(start), offset(start + text.len())));
                }
                assert_no_scaffold(tape);
            }
        }
    }
}

#[test]
fn header_keyword_suffixes_are_rejected_by_engine() {
    for left in ["const item", "item"] {
        for tail in [
            "key\\u0041.id",
            "key\\u0041",
            "index\\u0041",
            "index\\u{41} i",
            "keyA.id",
            "keyName",
            "indexA",
            "indexName",
        ] {
            let source = format!("const value = @for({left} of items; {tail}) {{ <div/> }};");
            let result = parse_tsrx(&TsrxParseRequest { source: &source }).unwrap();
            assert!(!result.errors.is_empty(), "{source:?}");
        }
    }
}

#[test]
fn parenthesized_for_annotations_accept_every_line_terminator() {
    for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
        for annotations in [
            "\nindex(i);\nkey(item.id)",
            "\nkey(item.id)",
            "\nindex/* note */(i);\nkey/* note */(item.id)",
        ] {
            let annotations = annotations.replace('\n', newline);
            let source =
                format!("const value = @for(const item of items;{annotations}) {{ <div/> }};");
            let units: Vec<u16> = source.encode_utf16().collect();
            let result =
                tsrx_parser_engine::parse_tsrx_utf16(&tsrx_parser_engine::TsrxUtf16ParseRequest {
                    source: &units,
                })
                .unwrap();
            assert!(result.errors.is_empty(), "{source:?}: {:?}", result.errors);
            assert_no_scaffold(result.program());
        }
    }
}

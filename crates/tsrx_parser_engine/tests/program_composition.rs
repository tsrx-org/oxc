#[expect(
    dead_code,
    reason = "the shared test-support module is compiled into every integration binary and each one uses a different part of it"
)]
mod support;

use std::fmt::Write as _;

use oxc_adapter::parser::{OrdinaryParseRequest, parse_ordinary};
use support::{
    assert_failed, assert_no_scaffold, field, list_field, object_field, program_body, require_type,
    scalar_field, span,
};
use tsrx_parser_engine::{TsrxParseOptions, TsrxParseRequest, parse_tsrx, parse_tsrx_with_options};
use tsrx_syntax::{project_for_parser, scan_for_parser};
use tsrx_tape_schema::{FlatTape, RecordIndex, ValueKind, ValueRef};

fn offset(value: usize) -> u32 {
    u32::try_from(value).expect("fixture offset fits u32")
}

fn field_names(tape: &FlatTape, object: RecordIndex) -> Vec<&str> {
    tape.fields(object).map(|record| tape.key(record)).collect()
}

fn write_value(tape: &FlatTape, value: ValueRef, output: &mut String) {
    match value.kind() {
        ValueKind::Missing => panic!("missing value in complete tape"),
        ValueKind::Scalar => {
            if let Some(value) = value.as_inline_u32() {
                write!(output, "{value}").expect("write inline u32");
            } else {
                output.push_str(tape.scalar(value).expect("scalar range"));
            }
        }
        ValueKind::Object => {
            output.push('{');
            for (index, record) in tape.fields(value.as_object().expect("object index")).enumerate()
            {
                if index != 0 {
                    output.push(',');
                }
                write!(output, "\"{}\":", tape.key(record)).expect("write String");
                write_value(tape, record.value, output);
            }
            output.push('}');
        }
        ValueKind::List => {
            output.push('[');
            for (index, item) in tape.values(value.as_list().expect("list index")).enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_value(tape, item, output);
            }
            output.push(']');
        }
    }
}

fn flat_json(tape: &FlatTape) -> String {
    let mut output = String::new();
    write_value(tape, tape.root(), &mut output);
    output
}

fn code_block(tape: &FlatTape, function: RecordIndex) -> RecordIndex {
    let block = object_field(tape, function, "body");
    require_type(tape, block, "JSXCodeBlock");
    block
}

fn rendered(tape: &FlatTape, block: RecordIndex) -> RecordIndex {
    field(tape, block, "render").as_object().expect("render object")
}

#[test]
fn plain_ascii_tsx_matches_the_public_oxc_tape_exactly() {
    let source = "import type { V } from './v'; export const plain: JSX.Element = <main />;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("plain TSRX source");
    let ordinary = parse_ordinary(OrdinaryParseRequest {
        filename: "plain.tsx",
        source,
        lang: None,
        source_type: None,
        ast_type: Some("js"),
        ranges: false,
        preserve_parens: None,
        show_semantic_errors: false,
    });
    assert!(ordinary.errors.is_empty());
    assert_eq!(
        ordinary.program_and_fixes,
        format!("{{\"node\":\n{}\n,\"fixes\":[]}}", flat_json(result.program()))
    );
    assert_no_scaffold(result.program());
}

#[test]
fn imports_and_exported_tsrx_functions_preserve_program_wrappers_and_order() {
    let source =
        "import { value } from './value'; export function View() @{ <main>{value}</main> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("module-shaped TSRX source");
    let body = program_body(result.program());
    assert_eq!(body.len(), 2);
    require_type(
        result.program(),
        body[0].as_object().expect("import declaration"),
        "ImportDeclaration",
    );
    let export = body[1].as_object().expect("export declaration");
    require_type(result.program(), export, "ExportNamedDeclaration");
    let function = object_field(result.program(), export, "declaration");
    require_type(result.program(), function, "FunctionDeclaration");
    let block = object_field(result.program(), function, "body");
    require_type(result.program(), block, "JSXCodeBlock");
    assert_eq!(
        span(result.program(), block),
        (offset(source.find("@{").expect("code block start")), offset(source.len()))
    );
    assert_no_scaffold(result.program());
}

#[test]
fn multiline_quoted_jsx_attributes_remain_authored_literals() {
    let source = "export function View() @{ <main class=\"one\n  two\">ok</main> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("multiline JSX attribute");
    let export = program_body(result.program())[0].as_object().expect("export declaration");
    let function = object_field(result.program(), export, "declaration");
    let element = rendered(result.program(), code_block(result.program(), function));
    let opening = object_field(result.program(), element, "openingElement");
    let attribute = list_field(result.program(), opening, "attributes")[0]
        .as_object()
        .expect("class attribute");
    let literal = object_field(result.program(), attribute, "value");
    assert_eq!(scalar_field(result.program(), literal, "value"), r#""one\n  two""#);
    assert_eq!(span(result.program(), literal), (38, 49));
    assert_no_scaffold(result.program());
}

#[test]
fn unbraced_jsx_element_attribute_values_preserve_authored_shape() {
    let source = "function Child(props: { content: unknown }) @{ <>{props.content}</> }\n\
        export function View() @{ <Child content=<view>Invalid</view> /> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("nested JSX attribute value");
    let export = program_body(result.program())[1].as_object().expect("export declaration");
    let function = object_field(result.program(), export, "declaration");
    let element = rendered(result.program(), code_block(result.program(), function));
    let opening = object_field(result.program(), element, "openingElement");
    let attribute = list_field(result.program(), opening, "attributes")[0]
        .as_object()
        .expect("content attribute");
    let value = object_field(result.program(), attribute, "value");
    require_type(result.program(), value, "JSXElement");
    let value_start = source.find("<view>").expect("nested element start");
    let value_end = value_start + "<view>Invalid</view>".len();
    assert_eq!(span(result.program(), value), (offset(value_start), offset(value_end)));
    assert_no_scaffold(result.program());
}

#[test]
fn jsx_shorthand_attributes_preserve_authored_shape_and_spans() {
    let source = "function Child(props: { label: string; count: number }) @{\n\
        <span>{props.label}</span>\n\
    }\n\
    function View() @{\n\
        const label = 'ready';\n\
        const count = 2;\n\
        <Child {label} {count} />\n\
    }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("JSX shorthand attributes");
    let function = program_body(result.program())[1].as_object().expect("view declaration");
    let element = rendered(result.program(), code_block(result.program(), function));
    let opening = object_field(result.program(), element, "openingElement");
    let attributes = list_field(result.program(), opening, "attributes");
    assert_eq!(attributes.len(), 2);

    for (attribute, identifier) in attributes.into_iter().zip(["label", "count"]) {
        let attribute = attribute.as_object().expect("shorthand attribute");
        require_type(result.program(), attribute, "JSXAttribute");
        assert_eq!(scalar_field(result.program(), attribute, "shorthand"), "true");
        assert_eq!(
            scalar_field(
                result.program(),
                object_field(result.program(), attribute, "name"),
                "name"
            ),
            format!(r#""{identifier}""#),
        );
        let spelling = format!("{{{identifier}}}");
        let start = source.find(&spelling).expect("authored shorthand");
        assert_eq!(
            span(result.program(), attribute),
            (offset(start), offset(start + spelling.len()))
        );
        assert_eq!(
            span(result.program(), object_field(result.program(), attribute, "value")),
            (offset(start), offset(start + spelling.len())),
        );
    }
    assert_no_scaffold(result.program());
}

#[test]
fn script_payloads_remain_raw_text_through_the_oxc_parse() {
    let source = r#"function View() @{ <script type="application/json">{"nested":{"enabled":true},"boundary":"</ScRiPt>"}</script> }"#;
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("raw script payload");
    let function = program_body(result.program())[0].as_object().expect("function declaration");
    let element = rendered(result.program(), code_block(result.program(), function));
    require_type(result.program(), element, "JSXElement");
    assert_eq!(
        scalar_field(result.program(), element, "content"),
        r#""{\"nested\":{\"enabled\":true},\"boundary\":\"</ScRiPt>\"}""#,
    );
    let children = list_field(result.program(), element, "children");
    assert_eq!(children.len(), 1);
    let text = children[0].as_object().expect("script text");
    require_type(result.program(), text, "JSXText");
    let content_start = source.find("{\"nested\"").expect("content start");
    let content_end = source.find("</script>").expect("closing script");
    assert_eq!(span(result.program(), text), (offset(content_start), offset(content_end)));
    assert_eq!(
        scalar_field(result.program(), text, "raw"),
        scalar_field(result.program(), element, "content")
    );
    assert_no_scaffold(result.program());
}

#[test]
fn interleaved_style_and_script_payloads_preserve_source_order() {
    for source in [
        r#"const x=<><script>{"a":1}</script><style>.a{color:red}</style></>;"#,
        r#"const x=<><style>.a{color:red}</style><script>{"a":1}</script></>;"#,
        r"const x=<><script>one</script><style>.a{}</style><script>two</script><style>.b{}</style></>;",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source }).expect("interleaved raw payloads");
        assert_no_scaffold(result.program());
    }
}

#[test]
fn lazy_destructuring_patterns_preserve_markers_in_declarations_and_for_headers() {
    let source = "function View(props: any) @{\n\
        const &{ first, last } = props.user;\n\
        let &[head, ...tail] = props.items;\n\
        <ul>@for (const &{ id, label } of props.items; index i; key id) {\n\
            <li>{label}</li>\n\
        }</ul>\n\
    }\n\
    function Param(&{ greeting, name }: any) @{ <p>{greeting + name}</p> }\n\
    function Catch() @{ @try { <A/> } @catch /* gap */ (&{ message }, reset) { <p>{message}</p> } }\n\
    function Ordinary() { try {} catch /* gap */ (&{ cause }) { console.log(cause); } }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("lazy destructuring patterns");
    let tape = result.program();
    let mut patterns = Vec::new();
    let mut declarators = Vec::new();
    for raw in 0..tape.object_count() {
        let object = RecordIndex::new(u32::try_from(raw).expect("object index"));
        if tape
            .field_index(object, "type")
            .and_then(|field| tape.field_value(field))
            .and_then(|value| tape.scalar(value))
            .is_some_and(|kind| matches!(kind, r#""ArrayPattern""# | r#""ObjectPattern""#))
            && tape.field_index(object, "lazy").is_some()
        {
            patterns.push(object);
        }
        if tape
            .field_index(object, "type")
            .and_then(|field| tape.field_value(field))
            .and_then(|value| tape.scalar(value))
            == Some(r#""VariableDeclarator""#)
        {
            declarators.push(object);
        }
    }
    assert_eq!(patterns.len(), 6);
    for pattern in patterns {
        assert_eq!(scalar_field(tape, pattern, "lazy"), "true");
        let (pattern_start, _) = span(tape, pattern);
        let declarator = declarators
            .iter()
            .copied()
            .find(|declarator| object_field(tape, *declarator, "id") == pattern);
        if let Some(declarator) = declarator {
            assert_eq!(span(tape, declarator).0 + 1, pattern_start);
        }
        assert_eq!(source.as_bytes()[usize::try_from(pattern_start - 1).expect("offset")], b'&');
    }
    assert_no_scaffold(tape);
}

#[test]
fn lazy_catch_bindings_accept_trivia_between_the_sigil_and_the_pattern() {
    let source = "function Block() { try {} catch (&/* gap */{ cause }) { report(cause); } }\n\
        function Line() { try {} catch (&// gap\n{ reason }) { report(reason); } }\n\
        function Clause() @{ @try { <A/> } @catch (&/* gap */{ message }, reset) { <p>{message}</p> } }";
    let overlay = scan_for_parser(source).expect("catch trivia overlay");
    let projection = project_for_parser(source, &overlay).expect("catch trivia projection");
    assert!(!projection.source().contains('&'));
    assert!(projection.source().contains("(/* gap */{ cause })"));
    assert!(projection.source().contains("(// gap\n{ reason })"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("lazy catch bindings with trivia");
    let tape = result.program();
    let patterns = (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                .is_some_and(|kind| matches!(kind, r#""ArrayPattern""# | r#""ObjectPattern""#))
                && tape.field_index(*object, "lazy").is_some()
        })
        .collect::<Vec<_>>();
    assert_eq!(patterns.len(), 3);
    for pattern in patterns {
        assert_eq!(scalar_field(tape, pattern, "lazy"), "true");
        let (pattern_start, _) = span(tape, pattern);
        let sigil = source[..usize::try_from(pattern_start).expect("offset")]
            .rfind('&')
            .expect("authored sigil");
        assert!(source[sigil + 1..usize::try_from(pattern_start).expect("offset")].contains("gap"));
    }
    assert_no_scaffold(tape);
}

#[test]
fn lazy_catch_bindings_reject_defaults_and_later_binding_slots() {
    // A catch binding never carries a default, so the lazy spelling fails exactly where the
    // ordinary one does rather than reconstructing into a shape the authored grammar rejects.
    assert_failed("function A() { try {} catch (&{ msg } = {}) { report(msg); } }");
    assert_failed("function B() { try {} catch ({ msg } = {}) { report(msg); } }");
    assert_failed("function C() { try {} catch (&[first] = []) { report(first); } }");
    assert_failed("function D() { try {} catch ([first] = []) { report(first); } }");
    assert_failed("function E() @{ @try { <A/> } @catch (&{ message } = {}, reset) { <p/> } }");
    // Only the first slot binds the caught value; the reset binding stays an identifier, so a
    // sigil in a later slot is never a lazy pattern.
    assert_failed("function F() { try {} catch (error, &{ message }) { report(message); } }");
    assert_failed("function G() @{ @try { <A/> } @catch (error, &{ message }) { <p/> } }");
}

#[test]
fn bare_lazy_loop_targets_bind_for_of_and_for_in_patterns() {
    let source = "async function Ordinary(props: any) {\n\
        for (&{ first, last } of props.pairs) { record(first, last); }\n\
        for (&[key] in props.table) { record(key); }\n\
        for await (& /* gap */ { chunk } of props.stream) { record(chunk); }\n\
        for (const &{ id } of props.items) { record(id); }\n\
    }\n\
    function View(props: any) @{\n\
        <ul>@for (&{ id, label } of props.items) {\n\
            <li>{label}</li>\n\
        }</ul>\n\
    }";
    let overlay = scan_for_parser(source).expect("bare loop target overlay");
    let projection = project_for_parser(source, &overlay).expect("bare loop target projection");
    assert!(!projection.source().contains('&'));
    assert!(projection.source().contains("for ({ first, last } of props.pairs)"));
    assert!(projection.source().contains("for ([key] in props.table)"));
    assert!(projection.source().contains("for await ( /* gap */ { chunk } of props.stream)"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("bare lazy loop targets");
    let tape = result.program();
    // Four bare targets and the declared counterpart, which still reaches the declaration lane.
    assert_eq!(lazy_pattern_count(tape), 5);

    let mut bare_targets = 0;
    for raw in 0..tape.object_count() {
        let object = RecordIndex::new(u32::try_from(raw).expect("object index"));
        let kind = tape
            .field_index(object, "type")
            .and_then(|field| tape.field_value(field))
            .and_then(|value| tape.scalar(value));
        // The TSRX `@for` keeps the same `left`; only its node type is rewritten.
        if !matches!(
            kind,
            Some(r#""ForOfStatement""# | r#""ForInStatement""# | r#""JSXForExpression""#)
        ) {
            continue;
        }
        let left = object_field(tape, object, "left");
        if tape.field_index(left, "lazy").is_none() {
            continue;
        }
        bare_targets += 1;
        assert_eq!(scalar_field(tape, left, "lazy"), "true");
        // The sigil belongs to no node: the pattern's authored span still opens at its delimiter,
        // with only trivia between the two.
        let (pattern_start, _) = span(tape, left);
        let pattern_start = usize::try_from(pattern_start).expect("offset");
        assert!(matches!(source.as_bytes()[pattern_start], b'{' | b'['));
        let sigil = source[..pattern_start].rfind('&').expect("authored sigil");
        // Only trivia separates the sigil from the pattern it marks.
        assert!(source[sigil + 1..pattern_start].replace("/* gap */", "").trim().is_empty());
    }
    assert_eq!(bare_targets, 4);
    assert_no_scaffold(tape);
}

#[test]
fn loop_headers_without_an_of_or_in_target_keep_their_bitwise_ampersands() {
    // The iterable is an ordinary expression, so `&` there stays a bitwise `and` however closely
    // it is written to an object literal.
    let source = "function Masks(props: any) @{\n\
        for (const value of props.flags & props.mask) { record(value); }\n\
        for (const bit of props.masks&{ length: 0 }) { record(bit); }\n\
        <p>{props.name}</p>\n\
    }";
    let overlay = scan_for_parser(source).expect("bitwise loop overlay");
    let projection = project_for_parser(source, &overlay).expect("bitwise loop projection");
    assert!(projection.source().contains("props.flags & props.mask"));
    assert!(projection.source().contains("props.masks&{ length: 0 }"));
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("bitwise loop headers");
    assert_eq!(lazy_pattern_count(result.program()), 0);

    // A C-style header has no assignment target at all, so the sigil is never admitted there and
    // the `&{ … }` that survives into the projection is the syntax error it always was.
    assert_failed("function A() { for (&{ bit }; index < 4; index += 1) { report(bit); } }");
    assert_failed("function B() @{ @for (&{ bit }; index < 4; index += 1) { <p/> } }");
}

#[test]
fn bare_lazy_loop_targets_bind_in_annotated_for_headers() {
    // An annotated `@for` rewrites its header clause by clause instead of copying it, so the sigil
    // is dropped out of the rewritten `left` even when it is the first byte of that clause.
    let source = "function Object(props: any) @{\n\
        <ol>@for (&{ id, label } of props.items; index i; key id) {\n\
            <li>{i}{label}</li>\n\
        }</ol>\n\
    }\n\
    function Array(props: any) @{\n\
        <ul>@for (&[head] of props.pairs; index j) {\n\
            <li>{j}{head}</li>\n\
        }</ul>\n\
    }";
    let overlay = scan_for_parser(source).expect("annotated loop target overlay");
    let projection =
        project_for_parser(source, &overlay).expect("annotated loop target projection");
    assert!(!projection.source().contains('&'));

    let result =
        parse_tsrx(&TsrxParseRequest { source }).expect("annotated bare lazy loop targets");
    let tape = result.program();
    assert_eq!(lazy_pattern_count(tape), 2);

    let mut bare_targets = 0;
    for raw in 0..tape.object_count() {
        let object = RecordIndex::new(u32::try_from(raw).expect("object index"));
        let kind = tape
            .field_index(object, "type")
            .and_then(|field| tape.field_value(field))
            .and_then(|value| tape.scalar(value));
        if kind != Some(r#""JSXForExpression""#) {
            continue;
        }
        let left = object_field(tape, object, "left");
        assert_eq!(scalar_field(tape, left, "lazy"), "true");
        bare_targets += 1;
        // The sigil belongs to no node: the pattern's authored span opens at its own delimiter.
        let (pattern_start, _) = span(tape, left);
        let pattern_start = usize::try_from(pattern_start).expect("offset");
        assert!(matches!(source.as_bytes()[pattern_start], b'{' | b'['));
        assert_eq!(source.as_bytes()[pattern_start - 1], b'&');
    }
    assert_eq!(bare_targets, 2);
    assert_no_scaffold(tape);
}

#[test]
fn lazy_arrow_parameters_preserve_patterns_types_defaults_and_async_arrows() {
    let source = "const View = (&{ name, title = name }: Props): string => title;\n\
        const select = async (prefix: string, /* gap */ &[first, ...rest]: Items = items) => [prefix, first, rest];\n\
        const nested = (&{ user: &{ id } }: Props) => id;\n\
        const bitwise = (value = source&{ value: 1 }) => value;";
    let overlay = scan_for_parser(source).expect("lazy arrow overlay");
    let projection = project_for_parser(source, &overlay).expect("lazy arrow projection");
    assert!(!projection.source().contains("(&{ name"));
    assert!(!projection.source().contains("/* gap */ &[first"));
    assert!(!projection.source().contains("&{ user:"));
    assert!(!projection.source().contains("user: &{ id"));
    assert!(projection.source().contains("source&{ value: 1 }"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("lazy arrow parameters");
    let tape = result.program();
    let patterns = (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                .is_some_and(|kind| matches!(kind, r#""ArrayPattern""# | r#""ObjectPattern""#))
                && tape.field_index(*object, "lazy").is_some()
        })
        .collect::<Vec<_>>();
    assert_eq!(patterns.len(), 4);
    for pattern in patterns {
        assert_eq!(scalar_field(tape, pattern, "lazy"), "true");
        let (pattern_start, _) = span(tape, pattern);
        assert_eq!(source.as_bytes()[usize::try_from(pattern_start - 1).expect("offset")], b'&');
    }
    assert_no_scaffold(tape);
}

#[test]
fn lazy_arrow_rest_parameters_and_nested_rest_patterns_keep_their_markers() {
    let source = "const gather = (head: string, ...&{ a, b }) => [head, a, b];\n\
        const nested = (&[first, ...&[second]]) => [first, second];";
    let overlay = scan_for_parser(source).expect("rest lazy arrow overlay");
    let projection = project_for_parser(source, &overlay).expect("rest lazy arrow projection");
    assert!(!projection.source().contains("...&{ a, b }"));
    assert!(!projection.source().contains("...&[second]"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("rest lazy arrow parameters");
    let tape = result.program();
    let patterns = (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                .is_some_and(|kind| matches!(kind, r#""ArrayPattern""# | r#""ObjectPattern""#))
                && tape.field_index(*object, "lazy").is_some()
        })
        .collect::<Vec<_>>();
    assert_eq!(patterns.len(), 3);
    for pattern in patterns {
        assert_eq!(scalar_field(tape, pattern, "lazy"), "true");
        let (pattern_start, _) = span(tape, pattern);
        assert_eq!(source.as_bytes()[usize::try_from(pattern_start - 1).expect("offset")], b'&');
    }
    assert_no_scaffold(tape);
}

#[test]
fn typed_non_arrow_parameter_lists_do_not_borrow_a_later_arrow() {
    let source = "const helpers = {\n\
        collect(&{ a }): void { report(a) }\n\
        }\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("non-arrow overlay");
    let projection = project_for_parser(source, &overlay).expect("non-arrow projection");
    assert!(projection.source().contains("collect(&{ a })"));
}

#[test]
fn lazy_arrow_lookahead_separates_generic_return_types_from_comparisons() {
    let source = "const sized = (&{ items }): Array<number> => items;\n\
        const helpers = {\n\
        compare(&{ a }): boolean { return a < 1 }\n\
        }\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("generic lookahead overlay");
    let projection = project_for_parser(source, &overlay).expect("generic lookahead projection");
    assert!(!projection.source().contains("(&{ items }"));
    assert!(projection.source().contains("compare(&{ a })"));

    let source = "const value = flag ? build(&{ a }) : count < limit;\n\
        const gate = a > b\n\
        const run = (v) => v;";
    let overlay = scan_for_parser(source).expect("comparison overlay");
    let projection = project_for_parser(source, &overlay).expect("comparison projection");
    assert!(projection.source().contains("build(&{ a })"));
}

#[test]
fn lazy_arrow_lookahead_keeps_object_and_template_literal_return_types_inside_the_annotation() {
    let source = "const shape = (&{ a }): { x: number } | string => a;\n\
        const label = (&{ kind }): `on${string}` | null => kind;\n\
        const tuple = (&{ b }): [{ y: 1 }, string][] => b;";
    let overlay = scan_for_parser(source).expect("type annotation overlay");
    let projection = project_for_parser(source, &overlay).expect("type annotation projection");
    assert!(!projection.source().contains("(&{ a }"));
    assert!(!projection.source().contains("(&{ kind }"));
    assert!(!projection.source().contains("(&{ b }"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("object type return annotations");
    let tape = result.program();
    let patterns = (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                == Some(r#""ObjectPattern""#)
                && tape.field_index(*object, "lazy").is_some()
        })
        .collect::<Vec<_>>();
    assert_eq!(patterns.len(), 3);
    for pattern in patterns {
        assert_eq!(scalar_field(tape, pattern, "lazy"), "true");
        let (pattern_start, _) = span(tape, pattern);
        assert_eq!(source.as_bytes()[usize::try_from(pattern_start - 1).expect("offset")], b'&');
    }
    assert_no_scaffold(tape);
}

#[test]
fn lazy_arrow_lookahead_reads_a_function_return_type_as_part_of_the_annotation() {
    let source = "const helpers = {\n\
        make(&{ a }): (x: number) => number { return (x) => x + a }\n\
        }\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("function type overlay");
    let projection = project_for_parser(source, &overlay).expect("function type projection");
    assert!(projection.source().contains("make(&{ a })"));

    let source = "const build = (&{ a }): (x: number) => number => (x) => x + a;\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("arrow function type overlay");
    let projection = project_for_parser(source, &overlay).expect("arrow function type projection");
    assert!(!projection.source().contains("(&{ a }"));
}

#[test]
fn lazy_arrow_lookahead_stops_at_a_parenthesised_function_type() {
    // `((x: number) => number)` carries its own arrow inside the parentheses, so the `=>` that
    // follows the annotation is the lazy arrow's and the parameter has to commit.
    let source = "const wrap = (&{ a }): ((x: number) => number) => (x) => x + a;\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("parenthesised function type overlay");
    let projection =
        project_for_parser(source, &overlay).expect("parenthesised function type projection");
    assert!(!projection.source().contains("(&{ a }"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("parenthesised function type");
    let tape = result.program();
    assert_eq!(lazy_pattern_count(tape), 1);
    assert_no_scaffold(tape);

    // The same annotation over a method keeps its `{ … }` body, so nothing may commit.
    let source = "const helpers = {\n\
        build(&{ a }): ((x: number) => number) { return (x) => x + a }\n\
        }\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("parenthesised method type overlay");
    let projection =
        project_for_parser(source, &overlay).expect("parenthesised method type projection");
    assert!(projection.source().contains("build(&{ a })"));

    // A parameter list whose own parameter is annotated with a function type is still a function
    // head, so its trailing `=>` belongs to the annotation rather than to the arrow.
    let source = "const helpers = {\n\
        chain(&{ a }): (step: (x: number) => number) => number { return (step) => step(a) }\n\
        }\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("nested function type overlay");
    let projection = project_for_parser(source, &overlay).expect("nested function type projection");
    assert!(projection.source().contains("chain(&{ a })"));

    // The completed function type still takes the postfix and union continuations that follow any
    // other type, and a constructor type's parameter list remains a function head.
    let source = "const union = (&{ a }): ((x: number) => number) | null => null;\n\
        const array = (&{ b }): ((x: number) => number)[] => [];\n\
        const made = (&{ c }): new (x: number) => number => c;";
    let overlay = scan_for_parser(source).expect("completed function type overlay");
    let projection =
        project_for_parser(source, &overlay).expect("completed function type projection");
    assert!(!projection.source().contains("(&{ a }"));
    assert!(!projection.source().contains("(&{ b }"));
    assert!(!projection.source().contains("(&{ c }"));
}

#[test]
fn optional_parameter_markers_in_a_function_type_do_not_open_a_conditional_type() {
    // `step?` is an untyped optional parameter, so the `:` that follows belongs to `next`'s
    // annotation. Reading the `?` as a conditional type would spend that `:` on a branch and let
    // the inner `=>` complete the type, which would misread the method's annotation as an arrow
    // and commit a marker that has no arrow to commit to.
    let source = "const helpers = {\n\
        chain(&{ a }): (step?, next: (x: number) => number) => number { return (s, n) => n(a) }\n\
        }\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("optional parameter method overlay");
    let projection =
        project_for_parser(source, &overlay).expect("optional parameter method projection");
    assert!(projection.source().contains("chain(&{ a })"));

    // The arrow counterpart ends the same annotation at the `=>` that really is the lazy arrow's,
    // so its marker still has to commit.
    let source = "const build = (&{ a }): (step?, next: (x: number) => number) => number =>\n\
        (s, n) => n(a);\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("optional parameter arrow overlay");
    let projection =
        project_for_parser(source, &overlay).expect("optional parameter arrow projection");
    assert!(!projection.source().contains("(&{ a }"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("optional parameter arrow");
    let tape = result.program();
    assert_eq!(lazy_pattern_count(tape), 1);
    assert_no_scaffold(tape);

    // An optional parameter closing the list directly reads the same way on both sides.
    let source = "const helpers = {\n\
        last(&{ a }): (step?) => number { return (s) => a }\n\
        }\n\
        const only = (&{ b }): (step?) => number => (s) => b;";
    let overlay = scan_for_parser(source).expect("trailing optional parameter overlay");
    let projection =
        project_for_parser(source, &overlay).expect("trailing optional parameter projection");
    assert!(projection.source().contains("last(&{ a })"));
    assert!(!projection.source().contains("(&{ b }"));

    // A `?` with a type after it still opens a conditional type, whose `:` spends the branch
    // rather than opening an annotation, so the `=>` inside completes the type and the `=>` that
    // follows the whole annotation is the arrow's.
    let source = "const pick = (&{ a }): (A extends B ? C : (x: T) => U) => a;\n\
        const helpers = {\n\
        pick(&{ b }): (A extends B ? C : (x: T) => U) { return b }\n\
        }\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("conditional type overlay");
    let projection = project_for_parser(source, &overlay).expect("conditional type projection");
    assert!(!projection.source().contains("(&{ a }"));
    assert!(projection.source().contains("pick(&{ b })"));
}

#[test]
fn parameter_type_intersections_are_not_queued_as_lazy_patterns() {
    let source = "const pick = (x: &{ a: number }) => x;\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("intersection annotation overlay");
    let projection =
        project_for_parser(source, &overlay).expect("intersection annotation projection");
    assert!(projection.source().contains("(x: &{ a: number })"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("intersection annotation");
    let tape = result.program();
    assert_eq!(lazy_pattern_count(tape), 0);
    assert_no_scaffold(tape);

    // The same holds for an intersection whose left member closed with `}`, and beside a
    // parameter that really does carry a lazy pattern.
    let source = "const mix = (&{ a }, x: { b: number }&{ c: string }) => [a, x];";
    let overlay = scan_for_parser(source).expect("mixed intersection overlay");
    let projection = project_for_parser(source, &overlay).expect("mixed intersection projection");
    assert!(!projection.source().contains("(&{ a }"));
    assert!(projection.source().contains("{ b: number }&{ c: string }"));

    // The rename form that made `:` an admitting predecessor still queues its pattern.
    let source = "const rename = ({ a: &{ b } }) => b;";
    let overlay = scan_for_parser(source).expect("rename overlay");
    let projection = project_for_parser(source, &overlay).expect("rename projection");
    assert!(!projection.source().contains("a: &{ b }"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("destructuring rename");
    let tape = result.program();
    assert_eq!(lazy_pattern_count(tape), 1);
    assert_no_scaffold(tape);
}

#[test]
fn lazy_arrow_lookahead_reads_an_import_type_return_annotation() {
    let source = "const load = (&{ a }): import(\"mod\").Shape => a;\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("import type overlay");
    let projection = project_for_parser(source, &overlay).expect("import type projection");
    assert!(!projection.source().contains("(&{ a }"));

    let result = parse_tsrx(&TsrxParseRequest { source }).expect("import type return annotation");
    let tape = result.program();
    assert_eq!(lazy_pattern_count(tape), 1);
    assert_no_scaffold(tape);

    // An import type over a method still leaves the `{ … }` body outside the annotation.
    let source = "const helpers = {\n\
        load(&{ a }): import(\"mod\").Shape { return a }\n\
        }\n\
        const run = (value) => value";
    let overlay = scan_for_parser(source).expect("import type method overlay");
    let projection = project_for_parser(source, &overlay).expect("import type method projection");
    assert!(projection.source().contains("load(&{ a })"));
}

fn lazy_pattern_count(tape: &FlatTape) -> usize {
    (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                .is_some_and(|kind| matches!(kind, r#""ArrayPattern""# | r#""ObjectPattern""#))
                && tape.field_index(*object, "lazy").is_some()
        })
        .count()
}

#[test]
fn rest_lazy_parameters_admit_trivia_between_the_spread_and_the_pattern() {
    let source = "const gather = (head: string, ... /* gap */ &{ a, b }) => [head, a, b];\n\
        const spread = (lead: string, ... // gap\n\
        &{ c }) => [lead, c];";
    let overlay = scan_for_parser(source).expect("spread trivia overlay");
    let projection = project_for_parser(source, &overlay).expect("spread trivia projection");
    assert!(!projection.source().contains("&{ a, b }"));
    assert!(!projection.source().contains("&{ c }"));

    let result =
        parse_tsrx(&TsrxParseRequest { source }).expect("rest lazy parameters with trivia");
    let tape = result.program();
    let patterns = (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                == Some(r#""ObjectPattern""#)
                && tape.field_index(*object, "lazy").is_some()
        })
        .collect::<Vec<_>>();
    assert_eq!(patterns.len(), 2);
    for pattern in patterns {
        assert_eq!(scalar_field(tape, pattern, "lazy"), "true");
        let (pattern_start, _) = span(tape, pattern);
        assert_eq!(source.as_bytes()[usize::try_from(pattern_start - 1).expect("offset")], b'&');
    }
    assert_no_scaffold(tape);
}

#[test]
fn lazy_arrow_parameters_compose_with_expression_code_blocks() {
    let source = "const View = (&{ name }: Props) => @{ <p>{name}</p> };\n\
        const view = @{ const render = (&{ id }) => id; <b>{render}</b> };";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("lazy arrows with code blocks");
    let tape = result.program();
    let patterns = (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                .is_some_and(|kind| matches!(kind, r#""ArrayPattern""# | r#""ObjectPattern""#))
                && tape.field_index(*object, "lazy").is_some()
        })
        .count();
    assert_eq!(patterns, 2);
    let blocks = (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                == Some(r#""JSXCodeBlock""#)
        })
        .count();
    assert_eq!(blocks, source.match_indices("@{").count());
    assert_no_scaffold(tape);
}

#[test]
fn standalone_lazy_assignment_statements_match_the_estree_shape_and_authored_spans() {
    let source = "&{ value, ...rest } = object;\n&[first, ...tail] = items;";
    let overlay = scan_for_parser(source).expect("standalone lazy assignment overlay");
    let projection = project_for_parser(source, &overlay).expect("standalone lazy projection");
    assert_eq!(
        projection.source(),
        "var { value, ...rest } = object;\nvar [first, ...tail] = items;"
    );
    let ordinary = parse_ordinary(OrdinaryParseRequest {
        filename: "standalone.tsx",
        source: projection.source(),
        lang: None,
        source_type: None,
        ast_type: Some("js"),
        ranges: false,
        preserve_parens: None,
        show_semantic_errors: false,
    });
    assert!(ordinary.errors.is_empty(), "{:?}", ordinary.errors);
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("standalone lazy assignments");
    assert_eq!(result.status, tsrx_tape_schema::ParseCompleteness::Complete, "{:?}", result.errors);
    let tape = result.program();
    let body = program_body(tape);
    assert_eq!(body.len(), 2);

    for (statement, sigil) in body.into_iter().zip(["&{", "&["]) {
        let statement = statement.as_object().expect("expression statement");
        require_type(tape, statement, "ExpressionStatement");
        let expression = object_field(tape, statement, "expression");
        require_type(tape, expression, "AssignmentExpression");
        assert_eq!(scalar_field(tape, expression, "operator"), r#""=""#);
        let pattern = object_field(tape, expression, "left");
        assert_eq!(scalar_field(tape, pattern, "lazy"), "true");

        let statement_start = source.find(sigil).expect("assignment sigil");
        let statement_end = source[statement_start..]
            .find(';')
            .map(|end| statement_start + end + 1)
            .expect("assignment terminator");
        assert_eq!(span(tape, statement), (offset(statement_start), offset(statement_end)));
        assert_eq!(span(tape, expression), (offset(statement_start), offset(statement_end - 1)));
        assert_eq!(
            span(tape, pattern).0,
            offset(statement_start + 1),
            "the pattern starts at the authored bracket"
        );
    }
    assert_no_scaffold(tape);
}

#[test]
fn standalone_lazy_assignments_work_in_every_statement_context_without_matching_expressions() {
    let source = "function View(source: any) @{\n\
        if (source) /* consequent */ &{ first } = source;\n\
        else /* alternate */ &[second] = source;\n\
        do /* body */ &{ third } = source; while (false);\n\
        switch (source.kind) { case 'ready': &{ fourth } = source; break; }\n\
        <p>{first}{second}{third}{fourth}</p>\n\
    }\n\
    const text = '&{ ignored } = source';\n\
    const bitwise = source &{ value: 1 };";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("statement-context assignments");
    assert_eq!(result.status, tsrx_tape_schema::ParseCompleteness::Complete);
    let tape = result.program();
    let assignments = (0..tape.object_count())
        .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
        .filter(|object| {
            tape.field_index(*object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                == Some(r#""AssignmentExpression""#)
                && tape
                    .field_index(*object, "left")
                    .and_then(|field| tape.field_value(field))
                    .and_then(ValueRef::as_object)
                    .is_some_and(|left| tape.field_index(left, "lazy").is_some())
        })
        .count();
    assert_eq!(assignments, 4);
    assert_no_scaffold(tape);
}

#[test]
fn standalone_lazy_assignment_defaults_match_the_javascript_parser_rejection() {
    assert_failed("&{ value = 1 } = source;");
}

#[test]
fn parenthesized_sequence_expressions_survive_jsx_validation_without_parent_nodes() {
    let source = "function Leaf(theme: () => string) @{ \
        <span>{((window as any).__renders.leaf++, theme())}</span> \
    }";
    let result = parse_tsrx_with_options(
        &TsrxParseRequest { source },
        TsrxParseOptions { preserve_parens: Some(false), ..TsrxParseOptions::default() },
    )
    .expect("parenthesized sequence expression");
    assert!(result.errors.is_empty());
    assert_eq!(result.suppressed_diagnostics, 1);

    let function = program_body(result.program())[0].as_object().expect("function declaration");
    let element = rendered(result.program(), code_block(result.program(), function));
    let children = list_field(result.program(), element, "children");
    let container = children[0].as_object().expect("JSX expression container");
    require_type(result.program(), container, "JSXExpressionContainer");
    require_type(
        result.program(),
        object_field(result.program(), container, "expression"),
        "SequenceExpression",
    );
    assert_no_scaffold(result.program());
}

#[test]
fn statement_blocks_and_postfix_non_null_assertions_preserve_following_jsx() {
    let source = "function View(value: number, enabled: boolean) @{\n\
        let label = '';\n\
        if (enabled) { label = 'on'; } else { label = 'off'; }\n\
        { const scoped = value; label += String(scoped); }\n\
        const half = value! / 2;\n\
        function cleanup(): void { label = ''; }\n\
        <main>{label + half}</main>\n\
    }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("statement-bearing setup");
    let function = program_body(result.program())[0].as_object().expect("function declaration");
    let element = rendered(result.program(), code_block(result.program(), function));
    require_type(result.program(), element, "JSXElement");
    assert_no_scaffold(result.program());
}

#[test]
fn typescript_generic_syntax_is_not_committed_as_jsx() {
    for source in [
        "type Props = Omit<Elements['mesh'], 'ref'>; function View() @{ <main/> }",
        "const useValue = <T extends Value,>(value: T): T => value; function View() @{ <main/> }",
        "const useValue = <T = Value,>(value: T): T => value; function View() @{ <main/> }",
        "interface Api { Subscribe: <TSelected = State>(props: Props<TSelected>) => Node; } function View() @{ <main/> }",
        "const identities = new WeakMap<object, number>(); function View() @{ <main/> }",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("generic TypeScript failed for `{source}`: {error}"));
        let program = result
            .program
            .as_ref()
            .unwrap_or_else(|| panic!("generic TypeScript produced no Program for `{source}`"));
        assert_no_scaffold(program);
    }
}

#[test]
fn multiple_tsrx_function_roots_reconstruct_independently_in_source_order() {
    let source = "const before=1; function A() @{ <a/> } function B() @{ <b/> } const after=2;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("multiple TSRX roots");
    let body = program_body(result.program());
    assert_eq!(body.len(), 4);
    for (value, expected) in body.iter().zip([
        "VariableDeclaration",
        "FunctionDeclaration",
        "FunctionDeclaration",
        "VariableDeclaration",
    ]) {
        require_type(result.program(), value.as_object().expect("Program body object"), expected);
    }
    for function in [
        body[1].as_object().expect("first function"),
        body[2].as_object().expect("second function"),
    ] {
        require_type(
            result.program(),
            object_field(result.program(), function, "body"),
            "JSXCodeBlock",
        );
    }
    assert_no_scaffold(result.program());
}

#[test]
fn named_default_and_anonymous_exports_preserve_exact_wrappers_and_spans() {
    let source = "import def, { x as y } from \"pkg\"; export function Named(p: P) @{ const a=1; <main>{p}</main> } export default function Default() @{ <style>.a{}</style> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("named/default module");
    let tape = result.program();
    let body = program_body(tape);
    assert_eq!(body.len(), 3);

    let import = body[0].as_object().expect("import");
    require_type(tape, import, "ImportDeclaration");
    assert_eq!(span(tape, import), (0, 34));

    let named = body[1].as_object().expect("named export");
    require_type(tape, named, "ExportNamedDeclaration");
    assert_eq!(span(tape, named), (35, 95));
    let named_function = object_field(tape, named, "declaration");
    require_type(tape, named_function, "FunctionDeclaration");
    assert_eq!(span(tape, named_function), (42, 95));
    assert_eq!(span(tape, code_block(tape, named_function)), (63, 95));

    let default = body[2].as_object().expect("default export");
    require_type(tape, default, "ExportDefaultDeclaration");
    assert_eq!(span(tape, default), (96, 154));
    let default_function = object_field(tape, default, "declaration");
    require_type(tape, default_function, "FunctionDeclaration");
    assert_eq!(span(tape, default_function), (111, 154));
    let default_block = code_block(tape, default_function);
    assert_eq!(span(tape, default_block), (130, 154));
    require_type(tape, rendered(tape, default_block), "JSXStyleElement");
    assert_no_scaffold(tape);

    let source = "export default function() @{ <main/> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("anonymous default function");
    let export = program_body(result.program())[0].as_object().expect("default export");
    let function = object_field(result.program(), export, "declaration");
    assert_eq!(result.program().scalar(field(result.program(), function, "id")), Some("null"));
    require_type(result.program(), code_block(result.program(), function), "JSXCodeBlock");
    assert_no_scaffold(result.program());
}

#[test]
fn ordinary_module_declaration_forms_keep_source_order_around_custom_roots() {
    let source = "import './setup'; import Default, { named as local } from './dep'; import * as ns from './ns'; export { local as renamed } from './dep2'; export * from './all'; export const before=Default; export /* keep */ function View() @{ <main>{ns}</main> } export { View, ns };";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("complete module forms");
    let tape = result.program();
    let body = program_body(tape);
    assert_eq!(body.len(), 8);
    for (value, expected) in body.iter().zip([
        "ImportDeclaration",
        "ImportDeclaration",
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ExportNamedDeclaration",
        "ExportNamedDeclaration",
        "ExportNamedDeclaration",
    ]) {
        require_type(tape, value.as_object().expect("module declaration"), expected);
    }
    let export = body[6].as_object().expect("function export");
    let function = object_field(tape, export, "declaration");
    require_type(tape, function, "FunctionDeclaration");
    assert_eq!(
        span(tape, export).0,
        offset(source.find("export /* keep */").expect("export start"))
    );
    assert_eq!(
        span(tape, function).0,
        offset(source.find("function View").expect("function start"))
    );
    let block = code_block(tape, function);
    assert_eq!(span(tape, block).0, offset(source.find("@{ <main>").expect("code-block start")));
    require_type(tape, rendered(tape, block), "JSXElement");
    assert_no_scaffold(tape);
}

#[test]
fn exports_inside_a_top_level_typescript_module_are_not_treated_as_nested_tsrx_modules() {
    let source = concat!(
        "module server { export function loadData() { return 'value'; } } ",
        "import { loadData } from 'server'; ",
        "export function App() @{ <main>{loadData()}</main> }",
    );
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("top-level TypeScript module");
    let body = program_body(result.program());
    assert_eq!(body.len(), 3);
    require_type(
        result.program(),
        body[0].as_object().expect("TS module declaration"),
        "TSModuleDeclaration",
    );
    require_type(
        result.program(),
        body[1].as_object().expect("import declaration"),
        "ImportDeclaration",
    );
    require_type(
        result.program(),
        body[2].as_object().expect("export declaration"),
        "ExportNamedDeclaration",
    );
}

#[test]
fn imports_inside_typescript_modules_preserve_the_reference_tsrx_ast() {
    let source = concat!(
        "import { value } from './domain.ts'; ",
        "module server { ",
        "import { commitOrder } from './server-domain.ts'; ",
        "export async function placeOrder(request: unknown) { return commitOrder(request); } ",
        "}",
    );
    let result = parse_tsrx_with_options(
        &TsrxParseRequest { source },
        TsrxParseOptions { source_type: Some("module"), ..TsrxParseOptions::default() },
    )
    .expect("TypeScript module import");
    assert!(result.errors.is_empty());
    assert_eq!(result.suppressed_diagnostics, 1);

    let declaration = program_body(result.program())[1].as_object().expect("module declaration");
    require_type(result.program(), declaration, "TSModuleDeclaration");
    let block = object_field(result.program(), declaration, "body");
    require_type(result.program(), block, "TSModuleBlock");
    let module_body = list_field(result.program(), block, "body");
    assert_eq!(module_body.len(), 2);
    let import = module_body[0].as_object().expect("nested import declaration");
    require_type(result.program(), import, "ImportDeclaration");
    assert_eq!(
        span(result.program(), import).0,
        offset(source.find("import { commitOrder }").expect("nested import"))
    );
    require_type(
        result.program(),
        module_body[1].as_object().expect("nested export declaration"),
        "ExportNamedDeclaration",
    );
    assert_no_scaffold(result.program());
}

#[test]
fn functions_methods_arrows_and_ordinary_blocks_interleave_without_cross_association() {
    let source = "const before=0; function A() @{ const x=1; <A/> } class C { m() @{ <M/> } } const mid=1; const F=() => @{ <F/> }; function ordinary(){return 2} function B() @{ <B/> } const after=3;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("mixed function owners");
    let tape = result.program();
    let body = program_body(tape);
    assert_eq!(body.len(), 8);
    assert_eq!(
        body.iter()
            .map(|value| scalar_field(tape, value.as_object().expect("body object"), "type"))
            .collect::<Vec<_>>(),
        [
            r#""VariableDeclaration""#,
            r#""FunctionDeclaration""#,
            r#""ClassDeclaration""#,
            r#""VariableDeclaration""#,
            r#""VariableDeclaration""#,
            r#""FunctionDeclaration""#,
            r#""FunctionDeclaration""#,
            r#""VariableDeclaration""#,
        ]
    );

    let a = body[1].as_object().expect("A");
    assert_eq!(span(tape, code_block(tape, a)), (29, 49));

    let class = body[2].as_object().expect("class");
    let class_body = object_field(tape, class, "body");
    let method = list_field(tape, class_body, "body")[0].as_object().expect("method");
    let method_function = object_field(tape, method, "value");
    assert_eq!(span(tape, code_block(tape, method_function)), (64, 73));

    let arrow_declaration = body[4].as_object().expect("arrow declaration");
    let arrow_declarator = list_field(tape, arrow_declaration, "declarations")[0]
        .as_object()
        .expect("arrow declarator");
    let arrow = object_field(tape, arrow_declarator, "init");
    require_type(tape, arrow, "ArrowFunctionExpression");
    assert_eq!(span(tape, code_block(tape, arrow)), (103, 112));

    let ordinary = body[5].as_object().expect("ordinary function");
    require_type(tape, object_field(tape, ordinary, "body"), "BlockStatement");
    let b = body[6].as_object().expect("B");
    assert_eq!(span(tape, code_block(tape, b)), (157, 166));
    assert_no_scaffold(tape);
}

#[test]
fn expression_position_code_blocks_match_the_javascript_parser_placements() {
    for source in [
        "@{ <A/> }",
        "if(ok) @{ <A/> }",
        "while(ok) @{ <A/> }",
        "do @{ <A/> }; while(ok);",
        "for(;;) @{ <A/> }",
        "label: @{ <A/> }",
        "const x=@{ <A/> };",
        "export default @{ <A/> };",
        "const F=()=>/* body */ @{ <A/> };",
        "function F() @{ return @{ <A/> }; }",
        "function F() @{ <A prop={@{ <B/> }}/> }",
        "function F() @{ <div>{@{ const value=1; <B>{value}</B> }}</div> }",
        "const outer=@{ const inner=@{<A/>}; <B>{inner}</B> };",
        "function F() @{ <main>@{ const inner=@{<A/>}; <B>{inner}</B> }</main> }",
        "function F() @{ @if(ok){ const inner=@{<A/>}; <B>{inner}</B> } }",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("expression code block failed for `{source}`: {error}"));
        assert_eq!(
            result.status,
            tsrx_tape_schema::ParseCompleteness::Complete,
            "expression code block should parse: {source}"
        );
        let tape = result.program();
        let blocks = (0..tape.object_count())
            .map(|raw| RecordIndex::new(u32::try_from(raw).expect("object index")))
            .filter(|object| {
                tape.field_index(*object, "type")
                    .and_then(|field| tape.field_value(field))
                    .and_then(|value| tape.scalar(value))
                    == Some(r#""JSXCodeBlock""#)
            })
            .collect::<Vec<_>>();
        assert_eq!(blocks.len(), source.match_indices("@{").count(), "{source}");
        for block in blocks {
            let (start, end) = span(tape, block);
            assert_eq!(&source[start as usize..start as usize + 2], "@{", "{source}");
            assert_eq!(&source[end as usize - 1..end as usize], "}", "{source}");
        }
        assert_no_scaffold(tape);
    }
}

#[test]
fn expression_code_blocks_keep_their_exact_parent_fields() {
    let source = concat!(
        "const init=@{<A/>};",
        "function F() @{ return @{<B/>}; }",
        "function G() @{ <C prop={@{<D/>}}>{@{<E/>}}</C> }",
        "export default @{<Z/>};",
    );
    let result =
        parse_tsrx(&TsrxParseRequest { source }).expect("expression code-block parent fields");
    let tape = result.program();
    let body = program_body(tape);

    let declaration = body[0].as_object().expect("init declaration");
    let declarator =
        list_field(tape, declaration, "declarations")[0].as_object().expect("init declarator");
    require_type(tape, object_field(tape, declarator, "init"), "JSXCodeBlock");

    let f = body[1].as_object().expect("F");
    let return_statement =
        list_field(tape, code_block(tape, f), "body")[0].as_object().expect("return statement");
    require_type(tape, return_statement, "ReturnStatement");
    require_type(tape, object_field(tape, return_statement, "argument"), "JSXCodeBlock");

    let g = body[2].as_object().expect("G");
    let element = rendered(tape, code_block(tape, g));
    let opening = object_field(tape, element, "openingElement");
    let attribute = list_field(tape, opening, "attributes")[0].as_object().expect("prop attribute");
    let attribute_container = object_field(tape, attribute, "value");
    require_type(tape, attribute_container, "JSXExpressionContainer");
    require_type(tape, object_field(tape, attribute_container, "expression"), "JSXCodeBlock");
    let child_container =
        list_field(tape, element, "children")[0].as_object().expect("expression child");
    require_type(tape, child_container, "JSXExpressionContainer");
    require_type(tape, object_field(tape, child_container, "expression"), "JSXCodeBlock");

    let default_export = body[3].as_object().expect("default export");
    require_type(tape, default_export, "ExportDefaultDeclaration");
    require_type(tape, object_field(tape, default_export, "declaration"), "JSXCodeBlock");
    assert_no_scaffold(tape);
}

#[test]
fn code_blocks_cannot_replace_javascript_try_blocks() {
    assert_failed("try @{ <A/> } catch {}");
}

#[test]
fn nested_code_blocks_follow_their_completed_owner_policies() {
    let source = "function Outer() @{ @{ <A/> } }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("terminal nested code block");
    let tape = result.program();
    let outer = program_body(tape)[0].as_object().expect("Outer");
    let outer_block = code_block(tape, outer);
    let inner = rendered(tape, outer_block);
    require_type(tape, inner, "JSXCodeBlock");
    assert_eq!(field_names(tape, inner), ["type", "start", "end", "body", "render", "metadata"]);
    assert_eq!(span(tape, outer_block), (17, 31));
    assert_eq!(span(tape, inner), (20, 29));
    require_type(tape, rendered(tape, inner), "JSXElement");
    assert!(list_field(tape, outer_block, "body").is_empty());
    assert_no_scaffold(tape);

    for (source, family, child_field) in [
        ("function Outer() @{ @if(ok){ @{<A/>} } }", "JSXIfExpression", "consequent"),
        ("function Outer() @{ @try{ @{<A/>} }@catch{<B/>} }", "JSXTryExpression", "block"),
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("direct nested block failed for `{source}`: {error}"));
        let tape = result.program();
        let outer = program_body(tape)[0].as_object().expect("Outer");
        let control = rendered(tape, code_block(tape, outer));
        require_type(tape, control, family);
        let control_block = object_field(tape, control, child_field);
        let child = list_field(tape, control_block, "body")[0]
            .as_object()
            .expect("direct nested code block");
        require_type(tape, child, "JSXCodeBlock");
        assert_no_scaffold(tape);
    }

    let source = "function Outer() @{ @for(const x of xs){ @{<A/>} } }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("for nested code block");
    let tape = result.program();
    let outer = program_body(tape)[0].as_object().expect("Outer");
    let control = rendered(tape, code_block(tape, outer));
    let control_block = object_field(tape, control, "body");
    let statement =
        list_field(tape, control_block, "body")[0].as_object().expect("wrapped nested code block");
    require_type(tape, statement, "ExpressionStatement");
    require_type(tape, object_field(tape, statement, "expression"), "JSXCodeBlock");
    assert_no_scaffold(tape);

    let source = "function Outer() @{ @switch(x){@default:{ @{<A/>} }} }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("switch nested code block");
    let tape = result.program();
    let outer = program_body(tape)[0].as_object().expect("Outer");
    let control = rendered(tape, code_block(tape, outer));
    let case = list_field(tape, control, "cases")[0].as_object().expect("default case");
    let statement =
        list_field(tape, case, "consequent")[0].as_object().expect("wrapped nested code block");
    require_type(tape, statement, "ExpressionStatement");
    require_type(tape, object_field(tape, statement, "expression"), "JSXCodeBlock");
    assert_no_scaffold(tape);
}

#[test]
fn jsx_child_and_ordinary_block_code_blocks_keep_their_distinct_topology() {
    let source = "function F() @{<main>@{<A/>}</main>}";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("JSX-child code block");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let element = rendered(tape, code_block(tape, function));
    let child = list_field(tape, element, "children")[0].as_object().expect("JSX child");
    require_type(tape, child, "JSXCodeBlock");
    assert_eq!(field_names(tape, child), ["type", "start", "end", "body", "render", "metadata"]);
    assert_eq!(span(tape, child), (21, 28));
    require_type(tape, rendered(tape, child), "JSXElement");
    assert_no_scaffold(tape);

    let source = "function F() @{ try { @{<A/>} } catch {} }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("ordinary try block");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let outer = code_block(tape, function);
    let try_statement = list_field(tape, outer, "body")[0].as_object().expect("try statement");
    require_type(tape, try_statement, "TryStatement");
    let try_block = object_field(tape, try_statement, "block");
    let statement = list_field(tape, try_block, "body")[0].as_object().expect("wrapped code block");
    require_type(tape, statement, "ExpressionStatement");
    require_type(tape, object_field(tape, statement, "expression"), "JSXCodeBlock");
    assert_no_scaffold(tape);
}

#[test]
fn jsx_child_code_blocks_preserve_statements_and_terminal_render() {
    let source = "function F() @{ <main>@{ const x=1; <A>{x}</A> }</main> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("full JSX-child code block");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let element = rendered(tape, code_block(tape, function));
    let child = list_field(tape, element, "children")[0].as_object().expect("JSX child code block");
    require_type(tape, child, "JSXCodeBlock");
    let start = offset(source.find("@{ const").expect("child start"));
    let end = offset(source.find(" }</main>").expect("child end") + 2);
    assert_eq!(span(tape, child), (start, end));
    let body = list_field(tape, child, "body");
    assert_eq!(body.len(), 1);
    require_type(tape, body[0].as_object().expect("child declaration"), "VariableDeclaration");
    require_type(tape, rendered(tape, child), "JSXElement");
    assert_no_scaffold(tape);

    let source = "function F() @{ <>@{ const x=1; <A/> }</> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("fragment child code block");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let fragment = rendered(tape, code_block(tape, function));
    require_type(tape, fragment, "JSXFragment");
    let child =
        list_field(tape, fragment, "children")[0].as_object().expect("fragment child code block");
    require_type(tape, child, "JSXCodeBlock");
    assert_eq!(list_field(tape, child, "body").len(), 1);
    require_type(tape, rendered(tape, child), "JSXElement");
    assert_no_scaffold(tape);

    let source = "function F() @{ <main>@{ const x=1; @{<A/>}; }</main> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("nested child render semicolon");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let element = rendered(tape, code_block(tape, function));
    let child =
        list_field(tape, element, "children")[0].as_object().expect("outer child code block");
    let body = list_field(tape, child, "body");
    assert_eq!(body.len(), 1);
    require_type(
        tape,
        body[0].as_object().expect("outer child declaration"),
        "VariableDeclaration",
    );
    let inner = rendered(tape, child);
    require_type(tape, inner, "JSXCodeBlock");
    require_type(tape, rendered(tape, inner), "JSXElement");
    assert_no_scaffold(tape);
}

#[test]
fn nested_code_block_semicolons_follow_direct_and_wrapped_oracle_topology() {
    let source = "function F() @{ @try{ @{<A/>}; }@pending{ @{<P/>}; }@catch(e){ @{<E/>}; } }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("direct semicolon ownership");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let control = rendered(tape, code_block(tape, function));
    let handler = object_field(tape, control, "handler");
    for block in [
        object_field(tape, control, "block"),
        object_field(tape, control, "pending"),
        object_field(tape, handler, "body"),
    ] {
        let body = list_field(tape, block, "body");
        assert_eq!(body.len(), 1, "direct semicolon must not survive");
        require_type(tape, body[0].as_object().expect("direct code block"), "JSXCodeBlock");
    }
    assert_no_scaffold(tape);

    let source = "function F() @{ { @{<A/>}; const after=1; } <F/> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("ordinary wrapped semicolon");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let outer = code_block(tape, function);
    let ordinary = list_field(tape, outer, "body")[0].as_object().expect("ordinary block");
    let ordinary_body = list_field(tape, ordinary, "body");
    assert_eq!(ordinary_body.len(), 2);
    let statement = ordinary_body[0].as_object().expect("wrapped statement");
    require_type(tape, statement, "ExpressionStatement");
    let statement_start = offset(source.find("@{<A/>").expect("statement start"));
    let statement_end = offset(source.find("}; const").expect("statement end") + 2);
    assert_eq!(span(tape, statement), (statement_start, statement_end));
    require_type(tape, object_field(tape, statement, "expression"), "JSXCodeBlock");
    require_type(
        tape,
        ordinary_body[1].as_object().expect("following declaration"),
        "VariableDeclaration",
    );
    assert_no_scaffold(tape);

    let source = "function F() @{ @for(const x of xs){ @{<A/>}; const after=1; } }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("for wrapped semicolon");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let control = rendered(tape, code_block(tape, function));
    let body = list_field(tape, object_field(tape, control, "body"), "body");
    assert_eq!(body.len(), 2);
    let statement = body[0].as_object().expect("for wrapped statement");
    require_type(tape, statement, "ExpressionStatement");
    require_type(tape, object_field(tape, statement, "expression"), "JSXCodeBlock");
    require_type(tape, body[1].as_object().expect("following declaration"), "VariableDeclaration");
    assert_no_scaffold(tape);
}

#[test]
fn direct_if_clause_semicolons_are_consumed_across_the_entire_chain() {
    let source = "function F() @{ @if(a){ @{<A/>}; }@else if(b){ @{<B/>}; }@else{ @{<C/>}; } }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("if-chain semicolons");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let root = rendered(tape, code_block(tape, function));
    let nested = object_field(tape, root, "alternate");
    let blocks = [
        object_field(tape, root, "consequent"),
        object_field(tape, nested, "consequent"),
        object_field(tape, nested, "alternate"),
    ];
    for block in blocks {
        let body = list_field(tape, block, "body");
        assert_eq!(body.len(), 1);
        require_type(tape, body[0].as_object().expect("direct if code block"), "JSXCodeBlock");
    }
    assert_no_scaffold(tape);
}

#[test]
fn commented_and_wide_wrapped_semicolons_rebuild_lists_once_in_order() {
    const COUNT: usize = 256;

    let source = "function F() @{ { @{<A/>} /* keep */ ; const after=1; } <F/> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("commented semicolon");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let ordinary = list_field(tape, code_block(tape, function), "body")[0]
        .as_object()
        .expect("ordinary block");
    let body = list_field(tape, ordinary, "body");
    assert_eq!(body.len(), 2);
    let statement = body[0].as_object().expect("wrapped statement");
    require_type(tape, statement, "ExpressionStatement");
    assert_eq!(
        span(tape, statement).1,
        offset(source.find("; const").expect("owned semicolon") + 1)
    );
    assert_no_scaffold(tape);

    let mut source = String::from("function F() @{ { ");
    for index in 0..COUNT {
        write!(&mut source, "@{{<X{index}/>}}; ").expect("write wide semicolon fixture");
    }
    source.push_str("} <F/> }");
    let result = parse_tsrx(&TsrxParseRequest { source: &source }).expect("wide semicolons");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let ordinary = list_field(tape, code_block(tape, function), "body")[0]
        .as_object()
        .expect("ordinary block");
    let body = list_field(tape, ordinary, "body");
    assert_eq!(body.len(), COUNT);
    for value in body {
        let statement = value.as_object().expect("wrapped statement");
        require_type(tape, statement, "ExpressionStatement");
        require_type(tape, object_field(tape, statement, "expression"), "JSXCodeBlock");
    }
    assert_no_scaffold(tape);
}

#[test]
fn module_declarations_inside_authored_code_blocks_fail_closed() {
    for source in [
        "function A() @{ export const x=1; <A/> }",
        "function A() @{ export default 1; <A/> }",
        "function A() @{ const x=1; export {x}; <A/> }",
        "const A=() => @{ import x from 'x'; <A/> };",
    ] {
        assert_failed(source);
    }
}

#[test]
fn direct_render_code_blocks_reject_following_clause_statements() {
    for source in [
        "function A() @{ @if(ok){ @{<A/>} const x=1; } }",
        "function A() @{ @try{ @{<A/>} const x=1; }@catch{<B/>} }",
    ] {
        assert_failed(source);
    }
}

#[test]
fn jsx_child_code_blocks_reject_capabilities_missing_from_the_authored_host() {
    for source in [
        "function F() @{ <main>@{ return 1; }</main> }",
        "function F() @{ <main>@{ yield 1; <A/> }</main> }",
        "function F() @{ <main>@{ await foo(); <A/> }</main> }",
        "function F() @{ <main>@{ super.x; <A/> }</main> }",
        "class A { m() @{ <main>@{ super(); <A/> }</main> } }",
        "function F() @{ <main>@{ break; <A/> }</main> }",
        "function F() @{ <main>@{ continue; <A/> }</main> }",
        "const n=<main>@{ new.target; <A/> }</main>;",
        "async function F() @{ <main>@{ yield 1; <A/> }</main> }",
        "function* F() @{ <main>@{ await foo(); <A/> }</main> }",
    ] {
        assert_failed(source);
    }
}

#[test]
fn jsx_child_code_blocks_inherit_valid_function_class_and_flow_contexts() {
    for source in [
        "async function F() @{ <main>@{ await foo(); <A/> }</main> }",
        "function* F() @{ <main>@{ yield 1; <A/> }</main> }",
        "async function* F() @{ <main>@{ await foo(); yield 1; <A/> }</main> }",
        "class A extends B { m() @{ <main>@{ super.x; <A/> }</main> } }",
        "class A extends B { constructor() @{ <main>@{ super(); <A/> }</main> } }",
        "function F() @{ <main>@{ new.target; <A/> }</main> }",
        "function F() @{ label: for(;;){ <main>@{ break label; continue label; <A/> }</main> } <F/> }",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("valid lexical context failed for `{source}`: {error}"));
        assert_no_scaffold(result.program());
    }

    let source = "const n=<main>@{ await foo(); <A/> }</main>;";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("top-level module await");
    let program = result.program().root().as_object().expect("Program");
    assert_eq!(scalar_field(result.program(), program, "sourceType"), r#""module""#);
    assert_no_scaffold(result.program());
}

#[test]
fn nested_code_block_return_and_control_boundaries_match_the_oracle() {
    for source in [
        "function F() @{ return 1; }",
        "function F() @{ <main>@{ for(;;){return 1} }</main> }",
        "function F() @{ <main>@{ @if(ok){return 1} }</main> }",
        "function F() @{ <main>@{ @for(const x of xs){return x} }</main> }",
    ] {
        parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("valid return boundary failed for `{source}`: {error}"));
    }
    for source in [
        "function F() @{ <main>@{ return 1; }</main> }",
        "function F() @{ <main>@{ if(ok){return 1} }</main> }",
        "function F() @{ <main>@{ @try{return 1}@catch{} }</main> }",
        "function F() @{ <main>@{ @switch(x){@default:{return 1}} }</main> }",
        "function F() @{ for(;;){ <main>@{ return 1; }</main> } <F/> }",
    ] {
        assert_failed(source);
    }
}

#[test]
fn nested_code_block_switch_and_label_flow_permissions_are_exact() {
    let valid =
        "function F() @{ switch(x){case 1:{ const n=<main>@{ break; <A/> }</main>; }} <F/> }";
    parse_tsrx(&TsrxParseRequest { source: valid }).expect("break inherited from switch");

    for source in [
        "function F() @{ switch(x){case 1:{ const n=<main>@{ continue; <A/> }</main>; }} <F/> }",
        "function F() @{ <main>@{ break missing; <A/> }</main> }",
        "function F() @{ label: @for(const x of xs){ <main>@{ continue label; <A/> }</main> } }",
    ] {
        assert_failed(source);
    }
}

#[test]
fn direct_custom_controls_inherit_only_the_authored_async_and_generator_host() {
    for source in [
        "async function F() @{ @if(ok){await foo(); <A/>} }",
        "function* F() @{ @if(ok){yield 1; <A/>} }",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("valid direct host failed for `{source}`: {error}"));
        assert_no_scaffold(result.program());
    }

    for source in [
        "function F() @{ @if(ok){await foo(); <A/>} }",
        "function F() @{ @if(ok){yield 1; <A/>} }",
        "function F() @{ yield; <A/> }",
        "function F() @{ await(x); <A/> }",
    ] {
        assert_failed(source);
    }
}

#[test]
fn authored_arrow_and_nested_function_boundaries_reset_lexical_capabilities() {
    for source in [
        "function F() @{ const g=async()=> @{ <main>@{ await foo(); <A/> }</main> }; <F/> }",
        "function F() @{ function* G() @{ <main>@{ yield 1; <A/> }</main> } <F/> }",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("valid nested host failed for `{source}`: {error}"));
        assert_no_scaffold(result.program());
    }

    for source in [
        "async function F() @{ const g=()=> @{ <main>@{ await foo(); <A/> }</main> }; <F/> }",
        "function* F() @{ const g=()=> @{ <main>@{ yield 1; <A/> }</main> }; <F/> }",
    ] {
        assert_failed(source);
    }
}

#[test]
fn class_method_field_and_static_block_capabilities_are_exact() {
    for source in [
        "class A { m() @{ <main>@{ super.x; <A/> }</main> } }",
        "class A extends B { m() @{ const g=()=> @{ <main>@{ super.x; <A/> }</main> }; <M/> } }",
        "class A extends B { x=<main>@{ super.x; new.target; <A/> }</main>; static { const x=<main>@{ super.x; new.target; <A/> }</main>; } }",
        "async function F() @{ class C { [<main>@{ await foo(); <A/> }</main>]() {} } <F/> }",
        "function* F() @{ class C { [<main>@{ yield 1; <A/> }</main>] = 1 } <F/> }",
        "function F() @{ class C { accessor [<main>@{ new.target; <A/> }</main>] = 1 } <F/> }",
        "class B{} class A extends B { m() @{ class C { [<main>@{ super.x; <A/> }</main>](){} } <A/> } }",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source }).unwrap_or_else(|error| {
            panic!("valid class capability failed for `{source}`: {error}")
        });
        assert_no_scaffold(result.program());
    }

    for source in [
        "class A { constructor() @{ <main>@{ super(); <A/> }</main> } }",
        "class A extends B { m() @{ <main>@{ super(); <A/> }</main> } }",
        "class A extends B { m() @{ function nested(){ const x=<main>@{ super.x; <A/> }</main>; } <M/> } }",
        "async function F() @{ class A { x=<main>@{ await foo(); <A/> }</main> } <F/> }",
        "function* F() @{ class A { static { const x=<main>@{ yield 1; <A/> }</main>; } } <F/> }",
        "class C { [<main>@{ new.target; <A/> }</main>](){} }",
        "class C { [<main>@{ super.x; <A/> }</main>] = 1 }",
    ] {
        assert_failed(source);
    }
}

#[test]
fn every_pinned_oxc_class_element_kind_is_accepted_around_custom_roots() {
    let source = "abstract class A { abstract m():void; abstract x:string; abstract accessor y:string; [key:string]:unknown; } function F() @{ <F/> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("pinned class-element manifest");
    assert_no_scaffold(result.program());
}

#[test]
fn custom_loop_switch_empty_and_label_flow_permissions_are_exact() {
    for source in [
        "function F() @{ <main>@{ @for(const x of xs){break; continue; <A/>}@empty{return 1} }</main> }",
        "function F() @{ <main>@{ @switch(x){@default:{break; <A/>}} }</main> }",
        "function F() @{ <main>@{ label: @for(const x of xs){ break label; <A/> } }</main> }",
        "function F() @{ a:b:for(;;){ <main>@{ continue a; continue b; <A/> }</main> } <F/> }",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("valid authored flow failed for `{source}`: {error}"));
        assert_no_scaffold(result.program());
    }

    for source in [
        "function F() @{ <main>@{ @for(const x of xs){<A/>}@empty{break} }</main> }",
        "function F() @{ <main>@{ @for(const x of xs){<A/>}@empty{continue} }</main> }",
        "function F() @{ <main>@{ @switch(x){@default:{continue; <A/>}} }</main> }",
    ] {
        assert_failed(source);
    }
}

#[test]
fn deep_stacked_labels_preserve_outer_and_inner_continue_targets() {
    const DEPTH: usize = 128;
    let mut source = String::from("function F() @{ ");
    for index in 0..DEPTH {
        write!(&mut source, "label{index}:").expect("write label");
    }
    write!(
        &mut source,
        "for(;;){{ <main>@{{ continue label0; continue label{}; <A/> }}</main> }} <F/> }}",
        DEPTH - 1
    )
    .expect("write labeled loop");

    let result = parse_tsrx(&TsrxParseRequest { source: &source })
        .expect("deep label chain retains standard-loop targets");
    assert_no_scaffold(result.program());
}

#[test]
fn contextual_keyword_property_names_remain_ordinary_names() {
    let source =
        "function F() @{ <main>@{ obj.await; obj.yield; const x={await:1,yield:2}; <A/> }</main> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("name-only keyword positions");
    assert_no_scaffold(result.program());
}

#[test]
fn every_completed_custom_family_composes_across_exported_roots() {
    let source = "export function A() @{ @if(ok){<a/>}@else{<b/>} } export function B() @{ @for(const x of xs){<c/>} } export function C() @{ @switch(x){@case 1:{<d/>}@default:{<e/>}} } export function D() @{ @try{<f/>}@pending{<g/>}@catch(error){<h/>} } export function E() @{ <{Tag}/> } export function F() @{ <style>.f{color:red}</style> }";
    let result = parse_tsrx(&TsrxParseRequest { source }).expect("all custom families");
    let tape = result.program();
    let body = program_body(tape);
    assert_eq!(body.len(), 6);
    for (value, expected) in body.iter().zip([
        "JSXIfExpression",
        "JSXForExpression",
        "JSXSwitchExpression",
        "JSXTryExpression",
        "JSXElement",
        "JSXStyleElement",
    ]) {
        let export = value.as_object().expect("named export");
        require_type(tape, export, "ExportNamedDeclaration");
        let function = object_field(tape, export, "declaration");
        let block = code_block(tape, function);
        require_type(tape, rendered(tape, block), expected);
    }
    assert_no_scaffold(tape);
}

#[test]
fn wide_program_roots_remain_independently_associated() {
    const COUNT: usize = 256;
    let mut source = String::new();
    for index in 0..COUNT {
        write!(&mut source, "function F{index}() @{{ <X{index}/> }} ").expect("write fixture");
    }
    let result = parse_tsrx(&TsrxParseRequest { source: &source }).expect("wide roots");
    let tape = result.program();
    let body = program_body(tape);
    assert_eq!(body.len(), COUNT);
    for (index, value) in body.into_iter().enumerate() {
        let function = value.as_object().expect("function");
        let id = object_field(tape, function, "id");
        assert_eq!(scalar_field(tape, id, "name"), format!(r#""F{index}""#));
        let block = code_block(tape, function);
        let (start, end) = span(tape, block);
        let start = usize::try_from(start).expect("start fits usize");
        let end = usize::try_from(end).expect("end fits usize");
        assert!(source[start..end].starts_with("@{"), "block {index} retains its authored start");
        require_type(tape, rendered(tape, block), "JSXElement");
    }
    assert_no_scaffold(tape);
}

#[test]
fn one_bad_custom_root_keeps_the_whole_module_fail_closed() {
    let source = "import './setup'; function Good() @{ <Good/> } function Bad() @{ @try{return 1}@catch{} } export { Good, Bad };";
    assert_failed(source);
}

#[test]
fn a_markup_line_after_a_semicolon_less_statement_starts_a_new_statement() {
    for source in [
        "function Counter() @{\n\tconst count = get()\n\n\t<button>\n\t\t{'Count: ' + count}\n\t</button>\n}\n",
        "function Counter() @{\n\tconst count = get();\n\n\t<button>\n\t\t{'Count: ' + count}\n\t</button>\n}\n",
        "function Counter() @{\n\tconst count = get()\n\t<button>{count}</button>\n}\n",
        "function Counter() @{\n\tconst count = 1\n\t<button>{count}</button>\n}\n",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("markup line after a statement: {error}"));
        assert!(result.errors.is_empty(), "diagnostics for `{source}`");
        let tape = result.program();
        let function = program_body(tape)[0].as_object().expect("Counter");
        let block = code_block(tape, function);
        let body = list_field(tape, block, "body");
        assert_eq!(body.len(), 1, "one setup statement in `{source}`");
        require_type(tape, body[0].as_object().expect("count"), "VariableDeclaration");
        require_type(tape, rendered(tape, block), "JSXElement");
        assert_no_scaffold(tape);
    }
}

#[test]
fn a_control_line_after_a_semicolon_less_statement_owns_its_markup_body() {
    for source in [
        "function D() @{\n\tconst d = get()\n\t@if (d) {\n\t\t<main>a</main>\n\t}\n}\n",
        "function D() @{\n\tconst d = get();\n\t@if (d) {\n\t\t<main>a</main>\n\t}\n}\n",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("control line after a statement: {error}"));
        assert!(result.errors.is_empty(), "diagnostics for `{source}`");
        let tape = result.program();
        let function = program_body(tape)[0].as_object().expect("D");
        let block = code_block(tape, function);
        let body = list_field(tape, block, "body");
        assert_eq!(body.len(), 1, "one setup statement in `{source}`");
        require_type(tape, body[0].as_object().expect("d"), "VariableDeclaration");
        require_type(tape, rendered(tape, block), "JSXIfExpression");
        assert_no_scaffold(tape);
    }
}

#[test]
fn a_line_leading_less_than_that_cannot_open_markup_stays_a_comparison() {
    for source in [
        "function View(a: number, b: number) @{\n\tconst wide = a < b\n\t<main>{wide}</main>\n}\n",
        "function View(a: number, b: number) @{\n\tconst wide = a\n\t\t< b\n\t<main>{wide}</main>\n}\n",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("line-leading comparison: {error}"));
        assert!(result.errors.is_empty(), "diagnostics for `{source}`");
        let tape = result.program();
        let function = program_body(tape)[0].as_object().expect("View");
        let block = code_block(tape, function);
        let declaration = list_field(tape, block, "body")[0].as_object().expect("wide");
        require_type(tape, declaration, "VariableDeclaration");
        let declarator =
            list_field(tape, declaration, "declarations")[0].as_object().expect("declarator");
        let init = object_field(tape, declarator, "init");
        require_type(tape, init, "BinaryExpression");
        assert_eq!(scalar_field(tape, init, "operator"), r#""<""#, "comparison in `{source}`");
        require_type(tape, rendered(tape, block), "JSXElement");
        assert_no_scaffold(tape);
    }
}

#[test]
fn line_leading_typescript_type_parameters_are_not_read_as_markup() {
    for source in [
        "const useValue =\n<T extends Value,>(value: T): T => value;\nfunction View() @{ <main/> }",
        "const useValue =\n<T = Value,>(value: T): T => value;\nfunction View() @{ <main/> }",
        "function View() @{\n\tconst seed = get()\n\tconst useValue =\n\t\t<T extends Value,>(value: T): T => value\n\t<main>{useValue(seed)}</main>\n}\n",
    ] {
        let result = parse_tsrx(&TsrxParseRequest { source })
            .unwrap_or_else(|error| panic!("line-leading type parameters: {error}"));
        assert!(result.errors.is_empty(), "diagnostics for `{source}`");
        assert_no_scaffold(result.program());
    }
}

#[test]
fn nested_markup_lines_record_their_boundaries_in_source_order() {
    let source = "function F() @{\n\tconst a = get()\n\t<main>@{\n\t\tconst b = get()\n\t\t<b>{a + b}</b>\n\t}</main>\n}\n";
    let result = parse_tsrx(&TsrxParseRequest { source })
        .unwrap_or_else(|error| panic!("nested markup lines: {error}"));
    assert!(result.errors.is_empty(), "diagnostics for `{source}`");
    let tape = result.program();
    let function = program_body(tape)[0].as_object().expect("F");
    let block = code_block(tape, function);
    assert_eq!(list_field(tape, block, "body").len(), 1);
    let element = rendered(tape, block);
    require_type(tape, element, "JSXElement");
    let child = list_field(tape, element, "children")[0].as_object().expect("child code block");
    require_type(tape, child, "JSXCodeBlock");
    assert_eq!(list_field(tape, child, "body").len(), 1);
    require_type(tape, rendered(tape, child), "JSXElement");
    assert_no_scaffold(tape);
}

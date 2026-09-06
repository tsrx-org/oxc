use std::{hint::black_box, time::Instant};

#[expect(
    dead_code,
    reason = "the shared test-support module is compiled into every integration binary and each one uses a different part of it"
)]
mod support;

use support::{field, object_field, scalar_field, span};
use tsrx_parser_engine::{
    TsrxParseOptions, TsrxParseRequest, TsrxUtf16ParseRequest, parse_tsrx, parse_tsrx_utf16,
    parse_tsrx_utf16_with_options,
};
use tsrx_tape_schema::{
    CoordinateDomain, DiagnosticTable, FlatTape, PackedTextRef, ParseCompleteness, RecordIndex,
    ValueKind, ValueRef,
};

const HIGH: u16 = 0xd800;
const LOW: u16 = 0xdc00;

fn parse_units(source: &[u16]) -> tsrx_parser_engine::TsrxParseResult {
    parse_tsrx_utf16(&TsrxUtf16ParseRequest { source }).expect("lossless UTF-16 parse result")
}

fn assert_failed_at(result: &tsrx_parser_engine::TsrxParseResult, expected: (u32, u32)) {
    assert_eq!(result.status, ParseCompleteness::Failed);
    assert!(result.program.is_none());
    assert!(result.module.is_none());
    let diagnostic = result.errors.records().first().expect("diagnostic");
    let labels = result.errors.labels(diagnostic.labels).expect("labels");
    assert_eq!(labels.len(), 1);
    assert_eq!((labels[0].span.start, labels[0].span.end), expected);
}

#[cfg(debug_assertions)]
const fn require_release_build() {
    panic!("the retained performance campaign must run with --release");
}

#[cfg(not(debug_assertions))]
const fn require_release_build() {}

fn measure_release_parse(source: &[u16], semantic: bool) -> u128 {
    let iterations = (300_000_usize / source.len()).max(3);
    let mut samples = Vec::with_capacity(5);
    for _ in 0..5 {
        let started = Instant::now();
        for _ in 0..iterations {
            let result = parse_tsrx_utf16_with_options(
                &TsrxUtf16ParseRequest { source: black_box(source) },
                TsrxParseOptions {
                    filename: "Scaling.tsrx",
                    show_semantic_errors: semantic,
                    ..TsrxParseOptions::default()
                },
            )
            .expect("release scaling parse");
            assert_eq!(result.status, ParseCompleteness::Complete);
            black_box(result.errors.len());
        }
        samples.push(started.elapsed().as_nanos() / iterations as u128);
    }
    samples.sort_unstable();
    samples[samples.len() / 2]
}

fn assert_linear_scaling(label: &str, counts: &[usize], medians: &[u128]) {
    assert_eq!(counts.len(), medians.len(), "{label} sample shape");
    for pair in medians.windows(2) {
        assert!(
            pair[1] <= pair[0].saturating_mul(3) + 20_000,
            "{label} doubling exceeded the broad linear ceiling: {pair:?}"
        );
    }
    let first_count = u128::try_from(counts[0]).expect("first record count");
    let last_count =
        u128::try_from(*counts.last().expect("last record count")).expect("last record count");
    let normalized_first = medians[0].saturating_mul(last_count);
    let normalized_last = medians.last().copied().expect("last median").saturating_mul(first_count);
    assert!(
        normalized_last <= normalized_first.saturating_mul(3) / 2 + 20_000,
        "{label} per-record cost grew beyond 1.5x across the retained 8x range"
    );
}

fn assert_no_private_markers_in_diagnostics(diagnostics: &DiagnosticTable) {
    let assert_clean = |text: PackedTextRef<'_>| {
        let units = text.to_utf16();
        assert!(!contains_units(&units, &[0xe000]));
        assert!(!contains_units(&units, &[0xffff]));
    };
    for diagnostic in diagnostics.records() {
        for range in [
            Some(diagnostic.message),
            diagnostic.help.get(),
            diagnostic.note.get(),
            diagnostic.code_scope.get(),
            diagnostic.code_number.get(),
            diagnostic.url.get(),
            diagnostic.codeframe.get(),
        ]
        .into_iter()
        .flatten()
        {
            assert_clean(diagnostics.text(range).expect("diagnostic text range"));
        }
        for label in diagnostics.labels(diagnostic.labels).expect("diagnostic label range") {
            if let Some(range) = label.message.get() {
                assert_clean(diagnostics.text(range).expect("label text range"));
            }
        }
    }
}

fn substitute_unit(template: &str, unit: u16) -> Vec<u16> {
    let mut output = Vec::with_capacity(template.len());
    let mut remaining = template;
    while let Some(index) = remaining.find("<U>") {
        output.extend(remaining[..index].encode_utf16());
        output.push(unit);
        remaining = &remaining[index + 3..];
    }
    output.extend(remaining.encode_utf16());
    output
}

fn substitute_units(template: &str, units: &[u16]) -> Vec<u16> {
    let mut output = Vec::with_capacity(template.len());
    let mut remaining = template;
    let mut units = units.iter().copied();
    while let Some(index) = remaining.find("<U>") {
        output.extend(remaining[..index].encode_utf16());
        output.push(units.next().expect("one unit per placeholder"));
        remaining = &remaining[index + 3..];
    }
    assert!(units.next().is_none(), "unused replacement units");
    output.extend(remaining.encode_utf16());
    output
}

fn all_objects(tape: &FlatTape) -> Vec<RecordIndex> {
    let mut seen_objects = vec![false; tape.object_count()];
    let mut seen_lists = vec![false; tape.list_count()];
    let mut pending = vec![tape.root()];
    let mut objects = Vec::new();
    while let Some(value) = pending.pop() {
        match value.kind() {
            ValueKind::Missing | ValueKind::Scalar => {}
            ValueKind::Object => {
                let object = value.as_object().expect("object reference");
                let index = object.into_raw() as usize;
                if std::mem::replace(&mut seen_objects[index], true) {
                    continue;
                }
                objects.push(object);
                pending.extend(tape.fields(object).map(|record| record.value));
            }
            ValueKind::List => {
                let list = value.as_list().expect("list reference");
                let index = list.into_raw() as usize;
                if std::mem::replace(&mut seen_lists[index], true) {
                    continue;
                }
                pending.extend(tape.values(list));
            }
        }
    }
    objects
}

fn object_at(tape: &FlatTape, kind: &str, expected_span: (u32, u32)) -> RecordIndex {
    let expected_kind = format!(r#""{kind}""#);
    all_objects(tape)
        .into_iter()
        .find(|&object| {
            tape.field_index(object, "type")
                .and_then(|field| tape.field_value(field))
                .and_then(|value| tape.scalar(value))
                == Some(expected_kind.as_str())
                && span(tape, object) == expected_span
        })
        .unwrap_or_else(|| panic!("missing {kind} at {expected_span:?}"))
}

fn text_units(text: PackedTextRef<'_>) -> Vec<u16> {
    text.to_utf16()
}

fn contains_units(haystack: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|window| window == needle)
}

fn utf16(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[test]
fn well_formed_unicode_uses_original_utf16_coordinates_and_values_everywhere() {
    let source = "/*😀*/ import x from \"m😀\";\r\nexport function Viéw() @{ <main title=\"é😀\">T😀</main> }";
    let units = source.encode_utf16().collect::<Vec<_>>();
    assert_eq!(units.len(), 85);
    assert_eq!(source.len(), 95);

    let result = parse_units(&units);
    assert_eq!(result.status, ParseCompleteness::Complete);
    assert_eq!(result.coordinate_domain, CoordinateDomain::OriginalUtf16Units);
    let tape = result.program();
    let program = tape.root().as_object().expect("Program");
    assert_eq!(span(tape, program), (0, 85));

    let comment = &result.comments.records()[0];
    assert_eq!(comment.span.start, 0);
    assert_eq!(comment.span.end, 6);
    assert_eq!(result.comments.value(comment), Some("😀"));

    let module = result.module.as_ref().expect("module table");
    let import = module.static_imports()[0];
    assert_eq!(import.span.start, 7);
    assert_eq!(import.span.end, 27);
    assert_eq!(import.module_request.span.start, 21);
    assert_eq!(import.module_request.span.end, 26);
    assert_eq!(module.value(import.module_request), Some("m😀"));

    let function = object_at(tape, "FunctionDeclaration", (36, 85));
    let identifier = object_field(tape, function, "id");
    assert_eq!(span(tape, identifier), (45, 49));
    assert_eq!(scalar_field(tape, identifier, "name"), r#""Viéw""#);

    let element = object_at(tape, "JSXElement", (55, 83));
    let opening = object_field(tape, element, "openingElement");
    let attributes = field(tape, opening, "attributes").as_list().expect("attributes list");
    let attribute =
        tape.values(attributes).next().and_then(ValueRef::as_object).expect("one attribute");
    assert_eq!(span(tape, attribute), (61, 72));
    let attribute_value = object_field(tape, attribute, "value");
    assert_eq!(span(tape, attribute_value), (67, 72));
    assert_eq!(scalar_field(tape, attribute_value, "value"), r#""é😀""#);

    let text = object_at(tape, "JSXText", (73, 76));
    assert_eq!(scalar_field(tape, text, "value"), r#""T😀""#);
    assert_eq!(scalar_field(tape, text, "raw"), r#""T😀""#);
}

#[test]
fn semantic_labels_and_codeframes_use_utf16_after_astral_and_crlf() {
    let source = "const lead=\"😀\";\r\nfunction View() @{ let x; let x; <main/> }";
    let units = source.encode_utf16().collect::<Vec<_>>();
    let result = parse_tsrx_utf16_with_options(
        &TsrxUtf16ParseRequest { source: &units },
        TsrxParseOptions {
            filename: "Semantic.tsrx",
            show_semantic_errors: true,
            ..TsrxParseOptions::default()
        },
    )
    .expect("Unicode semantic result");
    assert_eq!(result.coordinate_domain, CoordinateDomain::OriginalUtf16Units);
    let diagnostic = result
        .errors
        .records()
        .iter()
        .find(|record| {
            result.errors.string(record.message) == Some("Identifier `x` has already been declared")
        })
        .expect("duplicate binding diagnostic");
    for label in result.errors.labels(diagnostic.labels).expect("labels") {
        assert_eq!(&units[label.span.start as usize..label.span.end as usize], &[u16::from(b'x')]);
    }
    let codeframe =
        result.errors.optional_text(diagnostic.codeframe).expect("lossless codeframe").to_utf16();
    assert!(contains_units(&codeframe, &"const lead=\"😀\";".encode_utf16().collect::<Vec<_>>()));
    assert!(contains_units(
        &codeframe,
        &"function View() @{ let x; let x; <main/> }".encode_utf16().collect::<Vec<_>>()
    ));
    assert!(contains_units(&codeframe, &"Semantic.tsrx".encode_utf16().collect::<Vec<_>>()));
}

// One table-driven case per opaque surface. Splitting it would scatter the
// shared template and the surrogate pair it substitutes across several
// functions without making any of them clearer.
#[test]
fn lone_surrogates_round_trip_in_every_opaque_surface() {
    let template = "import X from \"m<U>\"; function View() @{ const s=\"q<U>\"; const t=`t<U>`; const r=/r<U>/u; /*c<U>*/ <main title=\"a<U>\">x<U><style>.x{content:\"s<U>\"}</style></main> }";
    for (unit, escape) in [(HIGH, "d800"), (LOW, "dc00")] {
        let source = substitute_unit(template, unit);
        assert_eq!(source.len(), 148);
        let result = parse_units(&source);
        assert_eq!(result.status, ParseCompleteness::Complete);
        assert_eq!(result.coordinate_domain, CoordinateDomain::OriginalUtf16Units);
        let tape = result.program();

        let module = result.module.as_ref().expect("module table");
        let import = module.static_imports()[0];
        assert_eq!(import.span, tsrx_tape_schema::TapeSpan::new(0, 19));
        assert_eq!(import.module_request.span, tsrx_tape_schema::TapeSpan::new(14, 18));
        assert_eq!(
            text_units(module.value_text(import.module_request).expect("lossless module value")),
            [u16::from(b'm'), unit]
        );

        let literal = object_at(tape, "Literal", (47, 51));
        assert_eq!(scalar_field(tape, literal, "value"), format!(r#""q\u{escape}""#));
        assert_eq!(scalar_field(tape, literal, "raw"), format!(r#""\"q\u{escape}\"""#));

        let template_element = object_at(tape, "TemplateElement", (62, 64));
        let template_value = object_field(tape, template_element, "value");
        let expected_template = format!(r#""t\u{escape}""#);
        assert_eq!(scalar_field(tape, template_value, "raw"), expected_template);
        assert_eq!(scalar_field(tape, template_value, "cooked"), expected_template);

        let regex = object_at(tape, "Literal", (75, 80));
        assert_eq!(scalar_field(tape, regex, "raw"), format!(r#""/r\u{escape}/u""#));
        let regex_fields = object_field(tape, regex, "regex");
        assert_eq!(scalar_field(tape, regex_fields, "pattern"), format!(r#""r\u{escape}""#));

        let comment = &result.comments.records()[0];
        assert_eq!(comment.span, tsrx_tape_schema::TapeSpan::new(82, 88));
        assert_eq!(
            text_units(result.comments.value_text(comment).expect("lossless comment")),
            [u16::from(b'c'), unit]
        );

        let attribute_value = object_at(tape, "Literal", (101, 105));
        assert_eq!(scalar_field(tape, attribute_value, "value"), format!(r#""a\u{escape}""#));
        let jsx_text = object_at(tape, "JSXText", (106, 108));
        assert_eq!(scalar_field(tape, jsx_text, "value"), format!(r#""x\u{escape}""#));
        assert_eq!(scalar_field(tape, jsx_text, "raw"), format!(r#""x\u{escape}""#));

        let style = object_at(tape, "JSXStyleElement", (108, 139));
        assert_eq!(scalar_field(tape, style, "css"), format!(r#"".x{{content:\"s\u{escape}\"}}""#));
        let style_children = field(tape, style, "children").as_list().expect("style children");
        let stylesheet = tape
            .values(style_children)
            .next()
            .and_then(ValueRef::as_object)
            .expect("CSS StyleSheet");
        assert_eq!(span(tape, stylesheet), (0, 16));
        let rules = field(tape, stylesheet, "children").as_list().expect("stylesheet rules");
        let rule = tape.values(rules).next().and_then(ValueRef::as_object).expect("CSS Rule");
        let prelude = object_field(tape, rule, "prelude");
        let selectors = field(tape, prelude, "children").as_list().expect("complex selectors");
        let selector =
            tape.values(selectors).next().and_then(ValueRef::as_object).expect("ComplexSelector");
        assert_eq!(span(tape, selector), (0, 2));
    }
}

#[test]
fn real_private_use_scalars_and_adjacent_pairs_cannot_consume_fixups() {
    let mut source = "const x=\"".encode_utf16().collect::<Vec<_>>();
    source.extend([0xe000, HIGH, HIGH, LOW, LOW, 0xe000]);
    source.extend("\";".encode_utf16());
    assert_eq!(source.len(), 17);

    let result = parse_units(&source);
    let literal = object_at(result.program(), "Literal", (8, 16));
    assert_eq!(
        scalar_field(result.program(), literal, "value"),
        format!("\"{}\\ud800𐀀\\udc00{}\"", '\u{e000}', '\u{e000}')
    );
}

#[test]
fn active_lone_surrogates_fail_at_the_exact_utf16_unit_without_a_program() {
    let cases = [
        "const value=<U>;",
        "function View() @{ const a<U>=1; <main/> }",
        "function View() @{ @if(<U>){<a/>} }",
        "function View() @{ <<U>/> }",
        "const value=<A></A<U>>;",
        "const value=<{tag}></{tag<U>}>;",
        "function View() @{ <main <U>/> }",
        "function View() @{ <main>{<U>}</main> }",
        "function View() @{ <{<U>}/> }",
        "function View() @{ const x=`${<U>}`; <a/> }",
        "function View() @{ const x=/a/<U>; <a/> }",
    ];
    for unit in [HIGH, LOW] {
        for template in cases {
            let marker = template.find("<U>").expect("surrogate marker");
            let offset =
                u32::try_from(template[..marker].encode_utf16().count()).expect("fixture offset");
            let source = substitute_unit(template, unit);
            let result = parse_units(&source);
            assert_eq!(result.status, ParseCompleteness::Failed, "{template}");
            assert_eq!(result.coordinate_domain, CoordinateDomain::OriginalUtf16Units);
            assert!(result.program.is_none());
            assert!(result.module.is_none());
            let diagnostic = &result.errors.records()[0];
            let message = result.errors.string(diagnostic.message).expect("message");
            let labels = result.errors.labels(diagnostic.labels).expect("labels");
            assert_eq!(labels.len(), 1);
            assert_eq!(labels[0].span.start, offset, "{template}: {message}");
            assert_eq!(labels[0].span.end, offset + 1, "{template}");
            let codeframe = result
                .errors
                .optional_text(diagnostic.codeframe)
                .expect("lossless failure codeframe")
                .to_utf16();
            assert!(contains_units(&codeframe, &[unit]), "{template}");
            assert!(!contains_units(&codeframe, &[0xe000]), "{template}");
            assert!(!contains_units(&codeframe, &[0xffff]), "{template}");
            assert_no_private_markers_in_diagnostics(&result.errors);
        }
    }
}

#[test]
fn authored_noncharacters_and_private_use_scalars_never_collide_with_tracked_fixups() {
    for unit in [HIGH, LOW] {
        let authored_first = "const first=\u{ffff}; const second=<U>;";
        let source = substitute_unit(authored_first, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(result.errors.string(diagnostic.message), Some("Invalid Character `\u{ffff}`"));
        let expected = u32::try_from(
            authored_first[..authored_first.find('\u{ffff}').expect("authored U+FFFF")]
                .encode_utf16()
                .count(),
        )
        .expect("fixture offset");
        assert_failed_at(&result, (expected, expected + 1));

        let poison_first = "const first=<U>; const second=\u{ffff};";
        let source = substitute_unit(poison_first, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("unexpected unpaired UTF-16 surrogate in active syntax")
        );
        let expected = u32::try_from(
            poison_first[..poison_first.find("<U>").expect("marker")].encode_utf16().count(),
        )
        .expect("fixture offset");
        assert_failed_at(&result, (expected, expected + 1));

        let adjacent_authored_first = "const x=\u{ffff}<U>;";
        let source = substitute_unit(adjacent_authored_first, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(result.errors.string(diagnostic.message), Some("Invalid Character `\u{ffff}`"));
        let expected = u32::try_from(
            adjacent_authored_first
                [..adjacent_authored_first.find('\u{ffff}').expect("authored U+FFFF")]
                .encode_utf16()
                .count(),
        )
        .expect("fixture offset");
        assert_failed_at(&result, (expected, expected + 1));

        let adjacent_poison_first = "const x=<U>\u{ffff};";
        let source = substitute_unit(adjacent_poison_first, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("unexpected unpaired UTF-16 surrogate in active syntax")
        );
        let marker = adjacent_poison_first.find("<U>").expect("marker");
        let expected = u32::try_from(adjacent_poison_first[..marker].encode_utf16().count())
            .expect("fixture offset");
        assert_failed_at(&result, (expected, expected + 1));

        let opaque_authored = "const opaque=\"\u{ffff}\"; const active=<U>;";
        let source = substitute_unit(opaque_authored, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("unexpected unpaired UTF-16 surrogate in active syntax")
        );
        let marker = opaque_authored.find("<U>").expect("marker");
        let expected = u32::try_from(opaque_authored[..marker].encode_utf16().count())
            .expect("fixture offset");
        assert_failed_at(&result, (expected, expected + 1));

        let pua_authored = "const authored=\u{e000}; const opaque=\"<U>\";";
        let source = substitute_unit(pua_authored, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(result.errors.string(diagnostic.message), Some("Invalid Character `\u{e000}`"));
        let expected = u32::try_from(
            pua_authored[..pua_authored.find('\u{e000}').expect("authored U+E000")]
                .encode_utf16()
                .count(),
        )
        .expect("fixture offset");
        assert_failed_at(&result, (expected, expected + 1));
    }
}

#[test]
fn authored_private_use_scalars_are_source_ordered_against_active_poison() {
    let authored_message = "Invalid Character `\u{e000}`";
    let rejection_message = "unexpected unpaired UTF-16 surrogate in active syntax";
    let cases = [
        ("const first=\u{e000}; const second=<U>;", authored_message, "\u{e000}"),
        ("const first=<U>; const second=\u{e000};", rejection_message, "<U>"),
        ("const x=\u{e000}<U>;", authored_message, "\u{e000}"),
        ("const x=<U>\u{e000};", rejection_message, "<U>"),
    ];

    for unit in [HIGH, LOW] {
        for (template, message, earliest) in cases {
            let source = substitute_unit(template, unit);
            let result = parse_units(&source);
            let diagnostic = result.errors.records()[0];
            assert_eq!(result.errors.string(diagnostic.message), Some(message));
            let expected = u32::try_from(
                template[..template.find(earliest).expect("earliest marker")]
                    .encode_utf16()
                    .count(),
            )
            .expect("fixture offset");
            assert_failed_at(&result, (expected, expected + 1));
        }
    }
}

#[test]
fn multiple_active_poison_markers_reject_the_first_unit_and_are_all_repaired_once() {
    let prefix = "const value=".encode_utf16().collect::<Vec<_>>();
    let suffix = ";".encode_utf16().collect::<Vec<_>>();
    let cases =
        [vec![HIGH, HIGH], vec![LOW, LOW], vec![LOW, HIGH], vec![HIGH, u16::from(b'+'), LOW]];
    for active in cases {
        let mut source = prefix.clone();
        source.extend(&active);
        source.extend(&suffix);
        let result = parse_units(&source);
        assert_eq!(result.status, ParseCompleteness::Failed);
        assert!(result.program.is_none());
        assert!(result.module.is_none());
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("unexpected unpaired UTF-16 surrogate in active syntax")
        );
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        let expected = u32::try_from(prefix.len()).expect("prefix length");
        assert_eq!((labels[0].span.start, labels[0].span.end), (expected, expected + 1));
        let codeframe = result
            .errors
            .optional_text(diagnostic.codeframe)
            .expect("lossless multiple-poison codeframe")
            .to_utf16();
        assert!(contains_units(&codeframe, &source));
        assert!(!contains_units(&codeframe, &[0xe000]));
        assert!(!contains_units(&codeframe, &[0xffff]));
        assert_no_private_markers_in_diagnostics(&result.errors);
    }
}

#[test]
fn ascii_utf16_entry_is_tape_identical_to_the_existing_zero_map_path() {
    let source = "/*c*/ function View() @{ @if(ok){<main/>}@else{<aside/>} }";
    let units = source.encode_utf16().collect::<Vec<_>>();
    let existing = parse_tsrx(&TsrxParseRequest { source }).expect("existing ASCII path");
    let bridged = parse_units(&units);

    assert_eq!(existing.coordinate_domain, CoordinateDomain::AuthoredUtf8Bytes);
    assert_eq!(bridged.coordinate_domain, CoordinateDomain::OriginalUtf16Units);
    assert_eq!(existing.program().scalar_storage(), bridged.program().scalar_storage());
    assert_eq!(existing.program().object_count(), bridged.program().object_count());
    assert_eq!(existing.program().field_count(), bridged.program().field_count());
    assert_eq!(existing.program().list_count(), bridged.program().list_count());
    assert_eq!(existing.program().list_value_count(), bridged.program().list_value_count());
    assert_eq!(existing.comments.string_storage(), bridged.comments.string_storage());
    assert_eq!(
        existing.module.as_ref().expect("existing module").string_storage(),
        bridged.module.as_ref().expect("bridged module").string_storage()
    );
}

#[test]
fn mixed_line_endings_empty_nodes_and_eof_map_exactly() {
    let source = "const p=\"😀\";\r\nconst t=``;\rconst x=<div>{}</div>;\n";
    let units = utf16(source);
    assert_eq!(units.len(), 50);

    let result = parse_units(&units);
    assert_eq!(result.status, ParseCompleteness::Complete);
    let tape = result.program();
    let program = tape.root().as_object().expect("Program");
    assert_eq!(span(tape, program), (0, 50));
    let literal = object_at(tape, "Literal", (8, 12));
    assert_eq!(scalar_field(tape, literal, "value"), r#""😀""#);
    let template = object_at(tape, "TemplateElement", (24, 24));
    assert_eq!(span(tape, template), (24, 24));
    let empty_expression = object_at(tape, "JSXEmptyExpression", (41, 41));
    assert_eq!(span(tape, empty_expression), (41, 41));
}

#[test]
fn backslash_adjacent_surrogates_preserve_cooked_and_raw_semantics() {
    for (unit, escape) in [(HIGH, "d800"), (LOW, "dc00")] {
        let string_source = substitute_unit(r#"const x="\<U>";"#, unit);
        let string_result = parse_units(&string_source);
        let literal = object_at(string_result.program(), "Literal", (8, 12));
        assert_eq!(
            scalar_field(string_result.program(), literal, "raw"),
            format!(r#""\"\\\u{escape}\"""#)
        );
        assert_eq!(
            scalar_field(string_result.program(), literal, "value"),
            format!(r#""\u{escape}""#)
        );

        let template_source = substitute_unit(r"const x=`\<U>`;", unit);
        let template_result = parse_units(&template_source);
        let element = object_at(template_result.program(), "TemplateElement", (9, 11));
        let value = object_field(template_result.program(), element, "value");
        assert_eq!(
            scalar_field(template_result.program(), value, "raw"),
            format!(r#""\\\u{escape}""#)
        );
        assert_eq!(
            scalar_field(template_result.program(), value, "cooked"),
            format!(r#""\u{escape}""#)
        );

        let regex_source = substitute_unit(r"const x=/\<U>/;", unit);
        let regex_result = parse_units(&regex_source);
        let literal = object_at(regex_result.program(), "Literal", (8, 12));
        assert_eq!(
            scalar_field(regex_result.program(), literal, "raw"),
            format!(r#""/\\\u{escape}/""#)
        );
        let regex = object_field(regex_result.program(), literal, "regex");
        assert_eq!(
            scalar_field(regex_result.program(), regex, "pattern"),
            format!(r#""\\\u{escape}""#)
        );
    }
}

#[test]
fn line_comments_and_later_diagnostics_use_original_units() {
    for unit in [HIGH, LOW] {
        let comment_source = substitute_unit("//a<U>b\r\nconst x=1;", unit);
        assert_eq!(comment_source.len(), 17);
        let result = parse_units(&comment_source);
        let comment = result.comments.records()[0];
        assert_eq!(comment.span, tsrx_tape_schema::TapeSpan::new(0, 5));
        assert_eq!(
            text_units(result.comments.value_text(&comment).expect("lossless line comment")),
            [u16::from(b'a'), unit, u16::from(b'b')]
        );
        let number = object_at(result.program(), "Literal", (15, 16));
        assert_eq!(scalar_field(result.program(), number, "raw"), r#""1""#);

        let broken = substitute_unit("const s=\"a<U>\";\r\nexport const broken = ;", unit);
        assert_eq!(broken.len(), 38);
        let failed = parse_units(&broken);
        assert_eq!(failed.status, ParseCompleteness::Failed);
        let diagnostic = &failed.errors.records()[0];
        let labels = failed.errors.labels(diagnostic.labels).expect("labels");
        assert!(labels.iter().all(|label| label.span.start <= 38 && label.span.end <= 38));
        assert!(labels.iter().any(|label| label.span.start == 37));
        let codeframe = failed
            .errors
            .optional_text(diagnostic.codeframe)
            .expect("lossless codeframe")
            .to_utf16();
        assert!(contains_units(&codeframe, &[u16::from(b'a'), unit]));
        assert!(!contains_units(&codeframe, &[0xe000]));
        assert!(!contains_units(&codeframe, &[0xffff]));
    }
}

#[test]
fn semantic_codeframes_keep_duplicate_crlf_lines_and_opaque_surrogates_distinct() {
    let template = "let duplicate=\"<U>\";\r\nlet duplicate=\"<U>\";";
    let identifier = "duplicate".encode_utf16().collect::<Vec<_>>();
    for unit in [HIGH, LOW] {
        let source = substitute_units(template, &[unit, unit]);
        let expected_starts = source
            .windows(identifier.len())
            .enumerate()
            .filter(|(_, value)| *value == identifier.as_slice())
            .map(|(offset, _)| u32::try_from(offset).expect("identifier offset"))
            .collect::<Vec<_>>();
        let result = parse_tsrx_utf16_with_options(
            &TsrxUtf16ParseRequest { source: &source },
            TsrxParseOptions {
                filename: "Duplicate.tsrx",
                show_semantic_errors: true,
                ..TsrxParseOptions::default()
            },
        )
        .expect("semantic duplicate result");
        assert_eq!(result.status, ParseCompleteness::Complete);
        let diagnostic = result.errors.records().first().expect("semantic diagnostic");
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!(
            labels.iter().map(|label| label.span.start).collect::<Vec<_>>(),
            expected_starts
        );
        let codeframe = result
            .errors
            .optional_text(diagnostic.codeframe)
            .expect("semantic codeframe")
            .to_utf16();
        assert_eq!(codeframe.iter().filter(|value| **value == unit).count(), 2);
        assert!(!contains_units(&codeframe, &[0xe000]));
        assert!(!contains_units(&codeframe, &[0xffff]));
        assert_no_private_markers_in_diagnostics(&result.errors);
    }
}

#[test]
fn codeframes_map_duplicate_clipped_and_tab_expanded_lines_by_identity() {
    for unit in [HIGH, LOW] {
        let duplicate = substitute_unit("const a<U>=1;\r\nconst a<U>=1;", unit);
        let result = parse_units(&duplicate);
        assert_eq!(result.status, ParseCompleteness::Failed);
        let diagnostic = &result.errors.records()[0];
        let codeframe = result
            .errors
            .optional_text(diagnostic.codeframe)
            .expect("duplicate-line codeframe")
            .to_utf16();
        assert!(contains_units(&codeframe, &[unit]));
        assert!(!contains_units(&codeframe, &[0xe000]));
        assert!(!contains_units(&codeframe, &[0xffff]));
        let first_line_end =
            duplicate.iter().position(|unit| *unit == u16::from(b'\r')).expect("first CRLF");
        assert!(contains_units(&codeframe, &duplicate[..first_line_end]));
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!((labels[0].span.start, labels[0].span.end), (7, 8));

        let identifier = "a".repeat(180);
        let template = format!("\tconst {identifier}<U>=1;");
        let long = substitute_unit(&template, unit);
        let result = parse_units(&long);
        assert_eq!(result.status, ParseCompleteness::Failed);
        let diagnostic = &result.errors.records()[0];
        let codeframe = result
            .errors
            .optional_text(diagnostic.codeframe)
            .expect("clipped tabbed codeframe")
            .to_utf16();
        assert!(contains_units(&codeframe, &[unit]));
        assert!(!contains_units(&codeframe, &[0xe000]));
        assert!(!contains_units(&codeframe, &[0xffff]));
        let marker = u32::try_from(template.find("<U>").expect("marker")).expect("marker offset");
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!((labels[0].span.start, labels[0].span.end), (marker, marker + 1));
    }
}

#[test]
fn earlier_structural_failure_wins_over_a_later_active_surrogate() {
    let template = "function View() @{ @else{} const a<U>=1; }";
    let expected = u32::try_from(template.find("@else").expect("@else offset")).unwrap();
    for unit in [HIGH, LOW] {
        let source = substitute_unit(template, unit);
        let result = parse_units(&source);
        assert_eq!(result.status, ParseCompleteness::Failed);
        let diagnostic = &result.errors.records()[0];
        let message = result.errors.string(diagnostic.message).expect("message");
        assert!(
            message.contains("owning TSRX control"),
            "unexpected earlier diagnostic: {message}"
        );
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!(labels[0].span.start, expected);
        assert_eq!(labels[0].span.end, expected + 1);
    }
}

#[test]
fn earlier_ordinary_javascript_failure_wins_over_a_later_active_surrogate() {
    let template = "function View() @{ const = ; const a<U>=1; <main/> }";
    for unit in [HIGH, LOW] {
        let source = substitute_unit(template, unit);
        let result = parse_units(&source);
        assert_eq!(result.status, ParseCompleteness::Failed);
        let diagnostic = &result.errors.records()[0];
        let message = result.errors.string(diagnostic.message).expect("message");
        assert!(!message.contains("unpaired UTF-16 surrogate"));
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!(labels[0].span.start, 25);
        assert!(labels[0].span.end >= 25);
        assert!(labels[0].span.end <= 26);
    }
}

#[test]
fn rejected_active_surrogate_codeframe_is_lossless_after_astral_and_tab() {
    for unit in [HIGH, LOW] {
        let source = substitute_unit("/*😀*/\tconst a<U>=1;", unit);
        let result = parse_units(&source);
        assert_eq!(result.status, ParseCompleteness::Failed);
        let diagnostic = &result.errors.records()[0];
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!((labels[0].span.start, labels[0].span.end), (14, 15));
        let codeframe = result
            .errors
            .optional_text(diagnostic.codeframe)
            .expect("lossless active-surrogate codeframe")
            .to_utf16();
        assert!(contains_units(&codeframe, &[unit]));
        assert!(!contains_units(&codeframe, &[0xe000]));
        assert!(!contains_units(&codeframe, &[0xffff]));
    }
}

#[test]
fn directive_value_repairs_lone_surrogates_without_consuming_authored_pua() {
    for (unit, escape) in [(HIGH, "d800"), (LOW, "dc00")] {
        let source = substitute_unit("\"a\u{e000}<U>\"; const x=1;", unit);
        let result = parse_units(&source);
        assert_eq!(result.status, ParseCompleteness::Complete);
        let statement = object_at(result.program(), "ExpressionStatement", (0, 6));
        assert_eq!(
            scalar_field(result.program(), statement, "directive"),
            format!("\"a{}\\u{escape}\"", '\u{e000}')
        );
        let literal = object_at(result.program(), "Literal", (0, 5));
        assert_eq!(
            scalar_field(result.program(), literal, "value"),
            format!("\"a{}\\u{escape}\"", '\u{e000}')
        );
    }
}

#[test]
fn tagged_template_null_cooked_value_remains_oxc_authoritative() {
    for (unit, escape) in [(HIGH, "d800"), (LOW, "dc00")] {
        let source = substitute_unit(r"const x=tag`\8<U>`;", unit);
        let result = parse_units(&source);
        let element = all_objects(result.program())
            .into_iter()
            .find(|object| {
                result
                    .program()
                    .field_index(*object, "type")
                    .and_then(|field| result.program().field_value(field))
                    .and_then(|value| result.program().scalar(value))
                    == Some(r#""TemplateElement""#)
            })
            .expect("tagged TemplateElement");
        let value = object_field(result.program(), element, "value");
        assert_eq!(scalar_field(result.program(), value, "cooked"), "null");
        assert_eq!(scalar_field(result.program(), value, "raw"), format!(r#""\\8\u{escape}""#));
    }
}

#[test]
fn jsx_entities_private_use_and_surrogate_fixups_remain_distinct() {
    for (unit, escape) in [(HIGH, "d800"), (LOW, "dc00")] {
        let source =
            substitute_unit(r#"const x=<main title="&#xE000;<U>">&#xE000;<U></main>;"#, unit);
        let result = parse_units(&source);
        let attribute = all_objects(result.program())
            .into_iter()
            .filter(|object| {
                result
                    .program()
                    .field_index(*object, "type")
                    .and_then(|field| result.program().field_value(field))
                    .and_then(|value| result.program().scalar(value))
                    == Some(r#""Literal""#)
            })
            .find(|object| scalar_field(result.program(), *object, "raw").contains("&#xE000;"))
            .expect("JSX attribute literal");
        assert_eq!(
            scalar_field(result.program(), attribute, "value"),
            format!(r#""&#xE000;\u{escape}""#)
        );
        let text = all_objects(result.program())
            .into_iter()
            .find(|object| {
                result
                    .program()
                    .field_index(*object, "type")
                    .and_then(|field| result.program().field_value(field))
                    .and_then(|value| result.program().scalar(value))
                    == Some(r#""JSXText""#)
            })
            .expect("JSXText");
        assert_eq!(
            scalar_field(result.program(), text, "value"),
            format!(r#""&#xE000;\u{escape}""#)
        );
        assert_eq!(scalar_field(result.program(), text, "raw"), format!(r#""&#xE000;\u{escape}""#));
    }
}

#[test]
fn style_payload_boundaries_ignore_quoted_greater_than_and_self_closing_attributes() {
    for unit in [HIGH, LOW] {
        let paired =
            substitute_unit(r#"const x=<style title="a><U>">.x{content:"<U>"}</style>;"#, unit);
        let result = parse_units(&paired);
        let style = all_objects(result.program())
            .into_iter()
            .find(|object| {
                result
                    .program()
                    .field_index(*object, "type")
                    .and_then(|field| result.program().field_value(field))
                    .and_then(|value| result.program().scalar(value))
                    == Some(r#""JSXStyleElement""#)
            })
            .expect("paired style");
        assert!(scalar_field(result.program(), style, "css").contains("\\ud"));

        let self_closing = substitute_unit(r#"const x=<style title="a><U>"/>;"#, unit);
        let result = parse_units(&self_closing);
        let style = all_objects(result.program())
            .into_iter()
            .find(|object| {
                result
                    .program()
                    .field_index(*object, "type")
                    .and_then(|field| result.program().field_value(field))
                    .and_then(|value| result.program().scalar(value))
                    == Some(r#""JSXStyleElement""#)
            })
            .expect("self-closing style");
        assert_eq!(scalar_field(result.program(), style, "css"), "\"\"");
    }
}

#[test]
fn quoted_import_and_export_names_reject_lone_surrogates() {
    let cases = [
        (r#"import { "a<U>" as x } from "m";"#, (9_u32, 13_u32)),
        (r#"export * as "a<U>" from "m";"#, (12_u32, 16_u32)),
        (r#"export { "a<U>" as "b" } from "m";"#, (9_u32, 13_u32)),
        (r#"export { "a" as "b<U>" } from "m";"#, (16_u32, 20_u32)),
    ];
    for unit in [HIGH, LOW] {
        for (template, expected_span) in cases {
            let source = substitute_unit(template, unit);
            let result = parse_units(&source);
            assert_eq!(result.status, ParseCompleteness::Failed, "{template}");
            assert!(result.program.is_none());
            assert!(result.module.is_none());
            let diagnostic = &result.errors.records()[0];
            assert_eq!(
                result.errors.string(diagnostic.message),
                Some("An export name cannot include a lone surrogate.")
            );
            let labels = result.errors.labels(diagnostic.labels).expect("labels");
            assert_eq!((labels[0].span.start, labels[0].span.end), expected_span, "{template}");
            let codeframe = result
                .errors
                .optional_text(diagnostic.codeframe)
                .expect("lossless module-name codeframe")
                .to_utf16();
            assert!(contains_units(&codeframe, &[unit]), "{template}");
            assert!(!contains_units(&codeframe, &[0xe000]), "{template}");
        }
    }
}

#[test]
fn module_name_active_noncharacter_and_grammar_rejections_follow_original_source_order() {
    for unit in [HIGH, LOW] {
        for prefixed_module_name in [
            r#"import { "a<U>" as x } from "m"; const b<U>=1;"#,
            r#"export * as "a<U>" from "m"; const b<U>=1;"#,
        ] {
            let source = substitute_units(prefixed_module_name, &[unit, unit]);
            let result = parse_units(&source);
            let diagnostic = result.errors.records()[0];
            assert_eq!(
                result.errors.string(diagnostic.message),
                Some("An export name cannot include a lone surrogate."),
                "{prefixed_module_name}"
            );
            let expected = u32::try_from(prefixed_module_name.find('"').expect("module name"))
                .expect("fixture offset");
            let labels = result.errors.labels(diagnostic.labels).expect("labels");
            assert_eq!(labels[0].span.start, expected, "{prefixed_module_name}");
        }

        let module_then_active = r#"export { "a<U>" as x } from "m"; const b<U>=1;"#;
        let source = substitute_units(module_then_active, &[unit, unit]);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("An export name cannot include a lone surrogate.")
        );
        let expected = u32::try_from(module_then_active.find('"').expect("module name"))
            .expect("fixture offset");
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!(labels[0].span.start, expected);

        let active_then_module = r#"const b<U>=1; export { "a<U>" as x } from "m";"#;
        let source = substitute_units(active_then_module, &[unit, unit]);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("unexpected unpaired UTF-16 surrogate in active syntax")
        );
        let marker = active_then_module.find("<U>").expect("active marker");
        let expected = u32::try_from(active_then_module[..marker].encode_utf16().count())
            .expect("fixture offset");
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!((labels[0].span.start, labels[0].span.end), (expected, expected + 1));

        let module_then_authored = r#"export { "a<U>" as x } from "m"; const b=￿;"#;
        let source = substitute_unit(module_then_authored, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("An export name cannot include a lone surrogate.")
        );

        let authored_then_module = r#"const b=￿; export { "a<U>" as x } from "m";"#;
        let source = substitute_unit(authored_then_module, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(result.errors.string(diagnostic.message), Some("Invalid Character `￿`"));

        let module_then_broken = r#"export { "a<U>" as x } from "m"; const broken = ;"#;
        let source = substitute_unit(module_then_broken, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("An export name cannot include a lone surrogate.")
        );

        let broken_then_module = r#"const broken = ; export { "a<U>" as x } from "m";"#;
        let source = substitute_unit(broken_then_module, unit);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        let message = result.errors.string(diagnostic.message).expect("message");
        assert_ne!(message, "An export name cannot include a lone surrogate.");
        assert_ne!(message, "unexpected unpaired UTF-16 surrogate in active syntax");

        let request_then_active = r#"import x from "m<U>"; const b<U>=1;"#;
        let source = substitute_units(request_then_active, &[unit, unit]);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("unexpected unpaired UTF-16 surrogate in active syntax"),
            "a module request must never be classified as an import/export name"
        );

        let two_module_names = r#"export { "a<U>" as "b<U>" } from "m";"#;
        let source = substitute_units(two_module_names, &[unit, unit]);
        let result = parse_units(&source);
        let diagnostic = result.errors.records()[0];
        assert_eq!(
            result.errors.string(diagnostic.message),
            Some("An export name cannot include a lone surrogate.")
        );
        let labels = result.errors.labels(diagnostic.labels).expect("labels");
        assert_eq!((labels[0].span.start, labels[0].span.end), (9, 13));
    }
}

#[test]
fn shared_module_requests_accept_and_repair_lone_surrogates_once() {
    for (unit, escape) in [(HIGH, "d800"), (LOW, "dc00")] {
        let source = substitute_unit(r#"export { "a" as "b", "c" as "d" } from "m<U>";"#, unit);
        let result = parse_units(&source);
        assert_eq!(result.status, ParseCompleteness::Complete);
        let module = result.module.as_ref().expect("module table");
        let export = module.static_exports()[0];
        let entries = module.static_export_entries(export.entries).expect("export entries");
        assert_eq!(entries.len(), 2);
        for entry in entries {
            let request = entry.module_request.get().expect("module request");
            assert_eq!(
                text_units(module.value_text(request).expect("request text")),
                [u16::from(b'm'), unit]
            );
        }
        assert!(result.program().scalar_storage().contains(&format!("\\u{escape}")));
    }
}

#[test]
#[ignore = "run explicitly in release mode for retained full-pipeline scaling evidence"]
#[expect(
    clippy::print_stdout,
    reason = "the scaling campaign prints its measured lanes under `cargo test -- --nocapture`"
)]
fn release_dense_module_and_diagnostic_scaling_campaign_is_linear() {
    require_release_build();

    let counts = [16_usize, 32, 64, 128];
    let mut module_medians = Vec::new();
    let mut diagnostic_medians = Vec::new();
    for count in counts {
        let mut modules = Vec::new();
        for index in 0..count {
            let statement = if index % 2 == 0 {
                format!("import \"m{index}<U>\";\n")
            } else {
                format!("export * from \"m{index}<U>\";\n")
            };
            modules.extend(substitute_unit(&statement, HIGH));
        }
        let module_median = measure_release_parse(&modules, false);
        let module_result = parse_units(&modules);
        let module = module_result.module.as_ref().expect("dense module table");
        assert_eq!(module.static_imports().len() + module.static_exports().len(), count);
        println!(
            "full_pipeline lane=modules records={count} units={} median_ns={module_median}",
            modules.len()
        );
        module_medians.push(module_median);

        let mut diagnostics = Vec::new();
        for index in 0..count {
            diagnostics
                .extend(substitute_unit(&format!("const s{index}=\"<U>\"; let duplicate;\n"), LOW));
        }
        let diagnostic_median = measure_release_parse(&diagnostics, true);
        let diagnostic_result = parse_tsrx_utf16_with_options(
            &TsrxUtf16ParseRequest { source: &diagnostics },
            TsrxParseOptions {
                filename: "Scaling.tsrx",
                show_semantic_errors: true,
                ..TsrxParseOptions::default()
            },
        )
        .expect("dense diagnostic result");
        assert!(diagnostic_result.errors.len() >= count.saturating_sub(1));
        println!(
            "full_pipeline lane=diagnostics records={count} units={} errors={} median_ns={diagnostic_median}",
            diagnostics.len(),
            diagnostic_result.errors.len()
        );
        diagnostic_medians.push(diagnostic_median);
    }
    assert_linear_scaling("module", &counts, &module_medians);
    assert_linear_scaling("diagnostic", &counts, &diagnostic_medians);
}

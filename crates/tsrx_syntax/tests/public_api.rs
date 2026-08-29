use std::fmt::Write as _;

use tsrx_syntax::{
    ProjectionError, StructuralKind, lift_formatted, project, project_for_format, project_for_lint,
    project_for_types, scan, scan_for_parser,
};

#[test]
fn equal_width_projection_masks_only_structural_sigils() {
    let source = "function View() @{ @if (ready) {} @else {} }";
    let overlay = scan(source).unwrap();
    assert_eq!(
        overlay.tokens().iter().map(|token| token.kind).collect::<Vec<_>>(),
        [StructuralKind::FunctionBody, StructuralKind::If, StructuralKind::Else]
    );
    let projected = project(source, &overlay).unwrap();
    assert_eq!(projected, "function View()  {  if (ready) {}  else {} }");
    assert_eq!(projected.len(), source.len());
}

#[test]
fn protects_lexical_at_text_and_scans_interpolated_code() {
    let source = concat!(
        "import x from '@scope/pkg';\n",
        "const a = /@if\\s+\\//gu;\n",
        "const b = `@else ${(() => { @if (ready) {} })()}`;\n",
        "// @if (comment) {}\n",
        "function View() @{\n",
        "  <p title={`@if ${value}`}>@if is literal text</p>;\n",
        "}\n",
    );
    let overlay = scan(source).unwrap();
    assert_eq!(overlay.tokens().len(), 2);
}

#[test]
fn recognizes_direct_jsx_and_expression_control_families() {
    let source = concat!(
        "function View() @{<main>@if(ok){<b/>}@else{<i/>}",
        "@for(const x of xs;index i;key x.id){<p>{i}</p>}@empty{<em/>}</main>}\n",
        "const result=@for await(const x of xs){x};\n",
    );
    let overlay = scan(source).unwrap();
    assert_eq!(overlay.control_count(), 3);
    assert_eq!(
        overlay.tokens().iter().map(|token| token.kind).collect::<Vec<_>>(),
        [
            StructuralKind::FunctionBody,
            StructuralKind::If,
            StructuralKind::Else,
            StructuralKind::For,
            StructuralKind::Empty,
            StructuralKind::For,
        ]
    );
}

#[test]
fn recognizes_switch_and_source_order_try_in_every_control_context() {
    let source = concat!(
        "function View() @{<main>@switch(value){@case 0:{@try{<b/>}@pending{<i/>}",
        "@catch(error:Error,reset:()=>void){<button onClick={reset}>{error.message}</button>}}",
        "@default:{<em/>}}</main>}\n",
        "const assigned=@switch(value){@case 1:{<b/>}};\n",
        "function run(){@try{work()}@catch{recover()};return consume(@try{work()}@pending{wait()});}\n",
    );
    let overlay = scan(source).unwrap();
    assert_eq!(overlay.control_count(), 5);
}

#[test]
fn recognizes_dynamic_tags_and_raw_style_without_scanning_css_as_jsx() {
    let source = concat!(
        "function View({tag}:{tag:string}) @{<main>",
        "<{tag} class=\"card\">@if(ok){<b/>}</{ tag }>",
        "<style>/* <Fake> @if(x) {} */ .card { color: red; }</style>",
        "</main>}"
    );
    let overlay = scan(source).unwrap();
    assert_eq!(overlay.control_count(), 1);
    let projection = project_for_format(source, &overlay).unwrap();
    assert!(projection.source().contains("D0"));
    assert!(!projection.source().contains("<Fake>"));
    assert!(projection.source().contains("Z0_={null}"));
    assert!(projection.source().contains("S0__*/ null"));
}

#[test]
fn type_projection_preserves_loop_bindings_and_identity_fix_boundaries() {
    let source = concat!(
        "type Item={id:string;save():Promise<void>};",
        "declare const items:Item[];",
        "function View() @{<main>@for(const item of items;index i;key item.id){",
        "@if(i>=0){item.save();<span>{item.id}</span>}}@empty{<i/>}</main>}"
    );
    let overlay = scan(source).unwrap();
    let projection = project_for_types(source, &overlay).unwrap();
    assert!(projection.source().contains("for(const item of items)"));
    assert!(projection.source().contains("let i = 0;"));
    assert!(projection.source().contains("void (item.id);"));
    assert!(projection.source().contains("if (false) return null as any;"));

    let projected_start = u32::try_from(projection.source().find("item.save()").unwrap()).unwrap();
    let authored_start = u32::try_from(source.find("item.save()").unwrap()).unwrap();
    assert_eq!(
        projection.map_range(projected_start..projected_start + 11),
        Some(authored_start..authored_start + 11)
    );
    assert_eq!(
        projection.map_fix_range(projected_start..projected_start + 11),
        Some(authored_start..authored_start + 11)
    );
    let wrapper = u32::try_from(projection.source().find("W0_").unwrap()).unwrap();
    assert!(projection.map_fix_range(wrapper..wrapper + 3).is_none());
}

/// An annotated `@for` rewrites its header clause by clause, and the type lane rewrites it a
/// second, different way. Both have to spend the lazy sigil: the shared action queue skips every
/// lazy pattern the header already passed, so a `&` the type lane copies verbatim is a `&` nothing
/// downstream will ever rewrite, and the projection lands on TypeScript that cannot parse.
#[test]
fn type_projection_rewrites_lazy_sigils_in_annotated_for_headers() {
    let source = concat!(
        "declare const items:{id:string;label:string}[];",
        "function View() @{<ol>@for(&{id, label} of items;index i;key id){",
        "<li>{i}{label}</li>}</ol>}"
    );
    let overlay = scan_for_parser(source).unwrap();
    let projection = project_for_types(source, &overlay).unwrap();

    assert!(!projection.source().contains('&'), "{}", projection.source());
    assert!(!projection.source().contains("const &"), "{}", projection.source());
    assert!(projection.source().contains(" of items)"), "{}", projection.source());
    assert!(projection.source().contains("let i = 0;"), "{}", projection.source());

    // The pattern's own bindings survive the rewrite, so type checking still sees them.
    assert!(projection.source().contains("label"), "{}", projection.source());

    // Rewriting the sigil must not shear the mapping: `label` inside the body still points at the
    // authored `label` it came from, not at an offset shifted by the marker comment.
    let projected = u32::try_from(projection.source().rfind("label").unwrap()).unwrap();
    let authored = u32::try_from(source.rfind("label").unwrap()).unwrap();
    assert_eq!(
        projection.map_range(projected..projected + 5),
        Some(authored..authored + 5),
        "{}",
        projection.source()
    );

    // An array pattern reaches the same rewrite through a different sigil position, and an
    // `index`-only header exercises it without a `key` clause following.
    let array = concat!(
        "declare const pairs:string[][];",
        "function View() @{<ul>@for(&[head] of pairs;index j){<li>{j}{head}</li>}</ul>}"
    );
    let array_projection = project_for_types(array, &scan_for_parser(array).unwrap()).unwrap();
    assert!(!array_projection.source().contains('&'), "{}", array_projection.source());
    assert!(
        array_projection.source().contains("[head] of pairs)"),
        "{}",
        array_projection.source()
    );

    // A header with no lazy sigil is untouched by the rewrite, so the marker only ever appears
    // where the author wrote an ampersand.
    let plain = concat!(
        "declare const items:{id:string}[];",
        "function View() @{<ol>@for(const item of items;index i){<li>{i}{item.id}</li>}</ol>}"
    );
    let plain_projection = project_for_types(plain, &scan_for_parser(plain).unwrap()).unwrap();
    assert!(plain_projection.source().contains("for(const item of items)"));
    assert!(!plain_projection.source().contains("Y0__"), "{}", plain_projection.source());
}

#[test]
fn type_projection_keeps_unannotated_for_headers_verbatim() {
    let source = concat!(
        "type Row={cell:string};",
        "declare const rows:Row[];",
        "declare const pairs:[string,string][];",
        "function View() @{<main>",
        "@for (const {cell} of rows) {<span>{cell}</span>}",
        "@for (const [first,second] of pairs) {<b>{first}{second}</b>}",
        "@for (const row of rows) {<i>{row.cell}</i>}",
        "</main>}"
    );
    let overlay = scan(source).unwrap();
    let projection = project_for_types(source, &overlay).unwrap();
    assert!(projection.source().contains("for (const {cell} of rows)"));
    assert!(projection.source().contains("for (const [first,second] of pairs)"));
    assert!(projection.source().contains("for (const row of rows)"));
    // An unannotated header carries no scaffold, so no header helper is declared for it.
    assert!(!projection.source().contains("H0_"));

    for needle in ["cell", "second", "row.cell"] {
        let projected_start = u32::try_from(projection.source().rfind(needle).unwrap()).unwrap();
        let authored_start = u32::try_from(source.rfind(needle).unwrap()).unwrap();
        let width = u32::try_from(needle.len()).unwrap();
        assert_eq!(
            projection.map_range(projected_start..projected_start + width),
            Some(authored_start..authored_start + width),
            "{needle} maps back to its authored bytes"
        );
    }
}

#[test]
fn type_projection_declares_bare_lazy_targets_but_leaves_assignment_targets_alone() {
    let source = concat!(
        "declare const items:{id:string;label:string}[];",
        "declare let cell:string;",
        "declare const rows:string[];",
        "function View() @{<ol>",
        "@for (&{id, label} of items) {<li>{label}</li>}",
        "@for ([cell] of rows.map(row=>[row])) {<li>{cell}</li>}",
        "</ol>}"
    );
    let overlay = scan_for_parser(source).unwrap();
    let projection = project_for_types(source, &overlay).unwrap();
    let projected = projection.source();
    assert!(!projected.contains('&'), "{projected}");

    // The sigil stands in for the declaration keyword, so the type lane has to write one.
    let lazy = header_target(projected, " of items)");
    assert!(lazy.starts_with("const "), "{lazy}");
    assert!(lazy.contains("{id, label}"), "{lazy}");

    // A plain assignment target already declares nothing, and declaring it would change what the
    // authored loop means.
    let assignment = header_target(projected, " of rows.map(");
    assert!(!assignment.contains("const"), "{assignment}");
    assert!(assignment.contains("[cell]"), "{assignment}");
}

/// Returns the projected `@for` target between its `for (` and the given ` of ...` tail.
fn header_target<'a>(projected: &'a str, tail: &str) -> &'a str {
    let end = projected.find(tail).expect("projected loop tail");
    let start = projected[..end].rfind("for (").expect("projected loop head") + "for (".len();
    &projected[start..end]
}

#[test]
fn type_projection_mixes_annotated_and_unannotated_for_headers() {
    let source = concat!(
        "type Row={cell:string};",
        "declare const rows:Row[];",
        "function View() @{<main>",
        "@for (const {cell} of rows) {<span>{cell}</span>}",
        "@for(const row of rows;index i;key row.cell){<i>{i}{row.cell}</i>}",
        "</main>}"
    );
    let overlay = scan(source).unwrap();
    let projection = project_for_types(source, &overlay).unwrap();
    assert!(projection.source().contains("for (const {cell} of rows)"));
    // The annotated header keeps today's rewrite: bindings hoisted into the body.
    assert!(projection.source().contains("for(const row of rows)"));
    assert!(projection.source().contains("let i = 0;"));
    assert!(projection.source().contains("void (row.cell);"));
}

#[test]
fn dynamic_tag_expression_is_affine_but_style_payload_is_synthetic() {
    let source = "function View({tag}:{tag:string}) @{<{tag}><style>.x{color:red}</style></{tag}>}";
    let overlay = scan(source).unwrap();
    let projection = project_for_lint(source, &overlay).unwrap();
    assert!(!projection.source().contains(".x{color:red}"));
    let projected_tag = projection.source().rfind("tag").unwrap();
    let mapped = projection
        .map_range(
            u32::try_from(projected_tag).unwrap()
                ..u32::try_from(projected_tag + "tag".len()).unwrap(),
        )
        .unwrap();
    assert_eq!(mapped.start as usize, source.find("<{tag}").unwrap() + 2);
}

#[test]
fn paired_dynamic_names_map_labels_but_not_one_sided_fixes() {
    for (source, fixable) in
        [("function View() @{ <{tag} /> }", true), ("function View() @{ <{tag}></{tag}> }", false)]
    {
        let projection = project_for_lint(source, &scan(source).unwrap()).unwrap();
        let marker = projection.source().find("A0_={tag").unwrap();
        let start = u32::try_from(marker + "A0_={".len()).unwrap();
        let range = start..start + 3;
        assert!(projection.map_range(range.clone()).is_some(), "{source}");
        assert_eq!(projection.map_fix_range(range).is_some(), fixable, "{source}");
    }
}

#[test]
fn rejects_malformed_dynamic_tag_shapes() {
    for source in [
        "function View() @{ <{} /> }",
        "function View() @{ <{tag}>Hi</{other}> }",
        "function View() @{ <{tag}>Hi }",
    ] {
        assert!(
            matches!(
                scan(source),
                Err(ProjectionError::MalformedSyntax { .. }
                    | ProjectionError::UnterminatedSyntax { .. })
            ),
            "{source}"
        );
    }
}

#[test]
fn dynamic_identity_matches_authoritative_trivia_and_outer_parentheses() {
    for source in [
        "function View() @{ <{/*a*/ Tag /*b*/}></{Tag}> }",
        "function View() @{ <{((Tag))}></{Tag}> }",
        "function View() @{ <{ obj }></{obj}> }",
        "function View() @{ <{ok ? Tag : /a*/}></{ok ? Tag : /a*/}> }",
        "function View() @{ <{Tag // open\n}></{Tag // close\n}> }",
        "function View() @{ <{Tag}></{Tag} /* close */> }",
    ] {
        assert!(scan(source).is_ok(), "{source}");
    }
    assert!(
        matches!(
            scan("function View() @{ <{obj . tag}></{obj.tag}> }"),
            Err(ProjectionError::MalformedSyntax { .. })
        ),
        "internal authored whitespace remains part of dynamic closing identity"
    );
}

#[test]
fn embedded_tokens_remain_in_source_order_inside_dynamic_attributes() {
    let source = concat!(
        "function View() @{",
        "<{Outer} child={<{Inner} />} styles={<style>.x{color:red}</style>} />",
        "}"
    );
    let overlay = scan(source).unwrap();
    assert_eq!(overlay.dynamic_tag_count(), 2);
    assert_eq!(overlay.style_block_count(), 1);
    let projection = project_for_format(source, &overlay).unwrap();
    let lifted = lift_formatted(projection.source(), source, &projection).unwrap();
    assert_eq!(lifted, source);
}

#[test]
fn deeply_parenthesized_dynamic_identity_scans_in_one_pass() {
    let depth = 8_192;
    let opening = format!("{}Tag{}", "(".repeat(depth), ")".repeat(depth));
    let source = format!("function View() @{{ <{{{opening}}}></{{Tag}}> }}");
    assert!(scan(&source).is_ok());
}

#[test]
fn rejects_malformed_switch_and_try_clause_shapes() {
    for source in [
        "function View() @{ @case 0: {} }",
        "function View() @{ @default: {} }",
        "function View() @{ @pending {} }",
        "function View() @{ @catch (error) {} }",
        "function View() @{ @switch (x) { @case 0 {} } }",
        "function View() @{ @switch (x) { @default: {} @default: {} } }",
        "function View() @{ @switch (x) { case 0: {} } }",
        "function View() @{ @try {} }",
        "function View() @{ @try {} @catch {} @pending {} }",
        "function View() @{ @try {} @pending {} @pending {} }",
        "function View() @{ @try {} @catch {} @catch {} }",
        "function View() @{ @try {} @catch () {} }",
        "function View() @{ @try {} @catch (error,) {} }",
        "function View() @{ @try {} @catch (error, reset, extra) {} }",
        "function View() @{ @try {} @catch (error, { reset }) {} }",
    ] {
        assert!(matches!(scan(source), Err(ProjectionError::MalformedSyntax { .. })), "{source}");
    }
}

#[test]
fn switch_case_headers_keep_nested_colons_out_of_the_clause_delimiter() {
    let source = concat!(
        "function View() @{<main>@switch(value){",
        "@case flag ? one : two:{<b/>}",
        "@case ({kind:'ready'}).kind:{<i/>}",
        "@default:{<em/>}}</main>}"
    );
    let projection = project_for_format(source, &scan(source).unwrap()).unwrap();
    let lifted = lift_formatted(projection.source(), source, &projection).unwrap();
    assert_eq!(scan(&lifted).unwrap().control_count(), 1);
}

#[test]
fn projection_maps_only_copied_authored_ranges() {
    let source = "function View() @{<main>@if(ok){debugger;}@else{var value=1;}</main>}";
    let overlay = scan(source).unwrap();
    let projection = project_for_lint(source, &overlay).unwrap();
    let debugger = projection.source().find("debugger;").unwrap();
    let mapped = projection
        .map_range(
            u32::try_from(debugger).unwrap()..u32::try_from(debugger + "debugger;".len()).unwrap(),
        )
        .unwrap();
    assert_eq!(mapped.start as usize, source.find("debugger;").unwrap());
    let wrapper = projection.source().find("W0").unwrap();
    assert!(
        projection
            .map_range(u32::try_from(wrapper).unwrap()..u32::try_from(wrapper + 1).unwrap())
            .is_none()
    );
}

#[test]
fn unformatted_projection_round_trips_through_checked_lift() {
    let source = concat!(
        "function View() @{<main>@if(ok){<b/>}@else{<i/>}",
        "@for(const x of xs;index i;key x.id){<p>{i}</p>}@empty{<em/>}</main>}"
    );
    let projection = project_for_format(source, &scan(source).unwrap()).unwrap();
    let lifted = lift_formatted(projection.source(), source, &projection).unwrap();
    assert!(!lifted.contains("_t0_"));
    assert_eq!(scan(&lifted).unwrap().control_count(), 2);
}

#[test]
fn parser_only_scaffolds_round_trip_through_the_format_projection() {
    for source in [
        "const value = @{ const ready = true; ready };\n",
        "const view = <main>@{ const ready = true; <p>{ready}</p> }</main>;\n",
        "const view = <Card {label} />;\n",
        "const &{ value = 1, ...rest } = source;\n",
        "&[first, ...rest] = source;\n",
        "const rows = <List>{items.map((&{ id, label }) => <p>{id}{label}</p>)}</List>;\n",
        "const view = <main>@{ const &{ value } = source; <p {value} /> }</main>;\n",
        "const view = <script>if (ready) console.log(\"raw\");</script>;\n",
    ] {
        let projection =
            project_for_format(source, &tsrx_syntax::scan_for_parser(source).unwrap()).unwrap();
        let lifted = lift_formatted(projection.source(), source, &projection)
            .unwrap_or_else(|error| panic!("failed to lift {source:?}: {error}"));
        assert_eq!(lifted, source);
    }
}

#[test]
fn lint_projection_maps_authored_parser_leaves_but_not_scaffolding() {
    let source = concat!(
        "const value = @{ console.log(input); input };\n",
        "const &{ label } = props;\n",
        "const view = <Card {label} />;\n",
        "const raw = <script>console.log('opaque');</script>;\n",
    );
    let projection = project_for_lint(source, &scan(source).unwrap()).unwrap();
    for needle in ["console.log(input)", "{ label }", "{label}"] {
        let projected = projection.source().find(needle).unwrap();
        let authored = source.find(needle).unwrap();
        let mapped = projection
            .map_range(
                u32::try_from(projected).unwrap()..u32::try_from(projected + needle.len()).unwrap(),
            )
            .unwrap();
        assert_eq!(
            mapped,
            u32::try_from(authored).unwrap()..u32::try_from(authored + needle.len()).unwrap(),
            "{needle}"
        );
    }
    let generated = projection.source().find("_t0_").unwrap();
    assert!(
        projection
            .map_range(
                u32::try_from(generated).unwrap()..u32::try_from(generated + "_t0_".len()).unwrap()
            )
            .is_none()
    );
    assert!(!projection.source().contains("console.log('opaque')"));
}

#[test]
fn checked_lift_rejects_changed_parser_scaffold_identity() {
    let source = concat!(
        "const value = @{ input };\n",
        "const &{ label } = props;\n",
        "const view = <Card {label}><script>raw()</script></Card>;\n",
    );
    let projection =
        project_for_format(source, &tsrx_syntax::scan_for_parser(source).unwrap()).unwrap();
    for changed in [
        projection.source().replacen("_t0_X0P__", "_t0_X9P__", 1),
        projection.source().replacen("_t0_Y0__", "_t0_Y9__", 1),
        projection.source().replacen("_t0_V0_", "_t0_V9_", 1),
        projection.source().replacen("_t0_L0__", "_t0_L9__", 1),
    ] {
        assert!(lift_formatted(&changed, source, &projection).is_err(), "{changed}");
    }
}

#[test]
fn switch_try_projection_round_trips_and_checks_method_identity() {
    let source = concat!(
        "function View() @{<main>@switch(value){@case 0:{@try{<b/>}",
        "@pending{<i/>}@catch(error,reset){<button onClick={reset}>{error}</button>}}",
        "@default:{<em/>}}</main>}"
    );
    let projection = project_for_format(source, &scan(source).unwrap()).unwrap();
    assert!(projection.source().contains("_t0_T1_"));
    assert!(projection.source().contains("_t0_C1_"));
    let lifted = lift_formatted(projection.source(), source, &projection).unwrap();
    assert!(!lifted.contains("_t0_"));
    assert_eq!(scan(&lifted).unwrap().control_count(), 2);

    let tampered = projection.source().replace("_t0_C1_", "_t0_X1_");
    assert!(matches!(
        lift_formatted(&tampered, source, &projection),
        Err(ProjectionError::MarkerResidual | ProjectionError::ScaffoldMismatch { .. })
    ));
}

#[test]
fn stale_same_length_overlay_is_rejected() {
    let first = "function View() @{ var one = 1; }";
    let second = "function View() @{ var two = 2; }";
    assert_eq!(first.len(), second.len());
    let overlay = scan(first).unwrap();
    assert!(matches!(
        project_for_lint(second, &overlay),
        Err(ProjectionError::SourceChanged { .. })
    ));
}

#[test]
fn rejects_orphan_clauses_and_invalid_index_annotation() {
    for source in [
        "function View() @{ @else {} }",
        "function View() @{ @empty {} }",
        "function View() @{ @for(const x of xs;index x.value){} }",
    ] {
        assert!(matches!(scan(source), Err(ProjectionError::MalformedSyntax { .. })));
    }
}

#[test]
fn repeated_generics_do_not_get_swallowed_as_jsx() {
    let mut source = String::from("function View() @{\n");
    for _ in 0..256 {
        source.push_str("const value = state<Conversation[]>([]);\n");
    }
    source.push_str("<Style data-index={1} />;\n}\n");
    let overlay = scan(&source).unwrap();
    assert_eq!(overlay.tokens().len(), 1);
}

#[test]
fn distinguishes_regex_after_a_block_from_division_after_an_object() {
    let source = concat!(
        "function setup() {}\n",
        "/@if/.test(value);\n",
        "const ratio = { value: 1 } / 2;\n",
        "export function View() @{<Style />}\n",
    );
    let overlay = scan(source).unwrap();
    assert_eq!(overlay.tokens().len(), 1);
    assert_eq!(overlay.tokens()[0].kind, StructuralKind::FunctionBody);
}

#[test]
fn deeply_nested_delimiters_spill_without_changing_the_overlay() {
    let opening = "(".repeat(32);
    let closing = ")".repeat(32);
    let source = format!("function View() @{{ const value = {opening}1{closing}; }}");
    let overlay = scan(&source).unwrap();
    assert_eq!(overlay.tokens().len(), 1);
    assert_eq!(overlay.tokens()[0].kind, StructuralKind::FunctionBody);
}

#[test]
fn multi_digit_scaffold_ordinals_remain_unambiguous() {
    let mut source = String::new();
    for index in 0..12 {
        writeln!(
                source,
                "function View{index}() @{{<main>@for(const row of rows;index i;key row.id){{<p>{{i}}</p>}}@empty{{<i/>}}</main>}}"
            )
            .unwrap();
    }
    let projection = project_for_format(&source, &scan(&source).unwrap()).unwrap();
    let lifted = lift_formatted(projection.source(), &source, &projection).unwrap();
    assert_eq!(scan(&lifted).unwrap().control_count(), 12);
}

#[test]
fn multi_digit_try_scaffolds_use_a_collision_free_namespace() {
    let mut source = String::from("const _t0_ = 'authored';\n");
    for index in 0..12 {
        writeln!(
                source,
                "function TryView{index}() @{{<main>@try{{<b/>}}@pending{{<i/>}}@catch(error,reset){{<button onClick={{reset}}>{{error}}</button>}}</main>}}"
            )
            .unwrap();
    }
    let projection = project_for_format(&source, &scan(&source).unwrap()).unwrap();
    assert!(projection.source().contains("_t1_T10_"));
    let lifted = lift_formatted(projection.source(), &source, &projection).unwrap();
    assert_eq!(scan(&lifted).unwrap().control_count(), 12);
}

#[test]
fn deeply_nested_try_scaffolds_lift_in_source_order() {
    let mut source = String::from("function View() @{<main>");
    for _ in 0..24 {
        source.push_str("@try{");
    }
    source.push_str("<b/>");
    for _ in 0..24 {
        source.push_str("}@catch{}");
    }
    source.push_str("</main>}");
    let projection = project_for_format(&source, &scan(&source).unwrap()).unwrap();
    let lifted = lift_formatted(projection.source(), &source, &projection).unwrap();
    assert_eq!(scan(&lifted).unwrap().control_count(), 24);
}

#[test]
fn nested_annotated_headers_project_in_source_order() {
    let source = concat!(
        "function View() @{<main>",
        "@for(const row of rows;index outer;key row.id){<section>",
        "@for(const item of row.items;index inner;key item.id){<p>{inner}</p>}",
        "@empty{<i/>}</section>}@empty{<b/>}</main>}"
    );
    let projection = project_for_format(source, &scan(source).unwrap()).unwrap();
    let lifted = lift_formatted(projection.source(), source, &projection).unwrap();
    assert_eq!(scan(&lifted).unwrap().control_count(), 2);
    assert!(lifted.find("index outer").unwrap() < lifted.find("index inner").unwrap());
}

#[test]
fn checked_lift_rejects_changed_wrapper_identity() {
    let source = "function View() @{<main>@if(ok){<b/>}@else{<i/>}</main>}";
    let projection = project_for_format(source, &scan(source).unwrap()).unwrap();
    let changed = projection.source().replacen("_t0_M0_", "_t0_M9_", 1);
    assert!(matches!(
        lift_formatted(&changed, source, &projection),
        Err(ProjectionError::ScaffoldMismatch { .. })
    ));
}

/// The parser lane backs format and lint, so a decorator whose name merely starts with a control
/// keyword has to stay an identifier there too. Escaped continuations are the sharp edge: `\` is
/// not an identifier byte, so a boundary check that only reads raw bytes sees `@for` in
/// `@for\u{03c0}` and then rejects the file for a missing `(`.
#[test]
fn unicode_identifier_suffixes_do_not_form_tsrx_controls_on_the_parser_lane() {
    const KEYWORDS: [&str; 11] = [
        "if", "else", "for", "empty", "switch", "case", "default", "try", "pending", "catch",
        "await",
    ];
    const SUFFIXES: [(&str, &str); 14] = [
        ("raw pi", "\u{03c0}"),
        ("escaped pi", "\\u03c0"),
        ("raw combining mark", "\u{0301}"),
        ("escaped combining mark", "\\u0301"),
        ("raw ZWNJ", "\u{200c}"),
        ("escaped ZWNJ", "\\u200c"),
        ("raw ZWJ", "\u{200d}"),
        ("escaped ZWJ", "\\u200d"),
        ("escaped digit", "\\u0030"),
        ("escaped underscore", "\\u005f"),
        ("escaped dollar", "\\u0024"),
        ("raw astral identifier", "\u{1D49C}"),
        ("escaped astral identifier", r"\u{1D49C}"),
        ("long braced escape with leading zeroes", r"\u{000003c0}"),
    ];

    for keyword in KEYWORDS {
        for (case, suffix) in SUFFIXES {
            let source = format!("@{keyword}{suffix}\nclass Decorated {{ method() {{}} }}\n");
            let overlay = scan_for_parser(&source)
                .unwrap_or_else(|error| panic!("{case} after @{keyword}: {error}"));
            assert!(overlay.tokens().is_empty(), "{case} after @{keyword}");
        }
    }

    for suffix in ["\u{03c0}", "\\u03c0", "\u{200d}", r"\u{1D49C}"] {
        let source = format!("function View() @{{<main>@if{suffix} is JSX text</main>}}");
        let overlay =
            scan_for_parser(&source).unwrap_or_else(|error| panic!("JSX text {suffix}: {error}"));
        assert_eq!(
            overlay.tokens().iter().map(|token| token.kind).collect::<Vec<_>>(),
            [StructuralKind::FunctionBody],
            "JSX text {suffix}"
        );
    }
}

#[test]
fn unicode_identifier_suffixes_do_not_form_tsrx_controls() {
    const KEYWORDS: [&str; 11] = [
        "if", "else", "for", "empty", "switch", "case", "default", "try", "pending", "catch",
        "await",
    ];
    const SUFFIXES: [(&str, &str); 14] = [
        ("raw pi", "π"),
        ("escaped pi", r"\u03c0"),
        ("raw combining mark", "\u{0301}"),
        ("escaped combining mark", r"\u0301"),
        ("raw ZWNJ", "\u{200c}"),
        ("escaped ZWNJ", r"\u200c"),
        ("raw ZWJ", "\u{200d}"),
        ("escaped ZWJ", r"\u200d"),
        ("escaped digit", r"\u0030"),
        ("escaped underscore", r"\u005f"),
        ("escaped dollar", r"\u0024"),
        ("raw astral identifier", "𝒜"),
        ("escaped astral identifier", r"\u{1D49C}"),
        ("long braced escape with leading zeroes", r"\u{000003c0}"),
    ];

    for keyword in KEYWORDS {
        for (case, suffix) in SUFFIXES {
            let source = format!("@{keyword}{suffix} class Decorated {{}}");
            let overlay =
                scan(&source).unwrap_or_else(|error| panic!("{case} after @{keyword}: {error}"));
            assert!(overlay.tokens().is_empty(), "{case} after @{keyword}");
        }
    }

    for suffix in ["π", r"\u03c0", "\u{200d}", r"\u{1D49C}"] {
        let source = format!("function View() @{{<main>@if{suffix} is JSX text</main>}}");
        let overlay = scan(&source).unwrap_or_else(|error| panic!("JSX text {suffix}: {error}"));
        assert_eq!(
            overlay.tokens().iter().map(|token| token.kind).collect::<Vec<_>>(),
            [StructuralKind::FunctionBody],
            "JSX text {suffix}"
        );
    }
}

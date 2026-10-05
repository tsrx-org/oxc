use tsrx_syntax::{project_for_parser, scan_for_parser};

#[test]
fn line_terminators_separate_setup_from_markup_without_changing_authored_bytes() {
    for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
        for setup in ["const a = 1", "a()", "const a = 1 // 🚀", "const a = 1 /* 🚀 */"] {
            for tag in ["<div/>", "<{Tag}/>"] {
                let source =
                    format!("function F() @{{{newline}{setup}{newline} \t{tag}{newline}}}");
                let overlay = scan_for_parser(&source).unwrap();
                let projection = project_for_parser(&source, &overlay).unwrap();
                assert!(projection.source().contains(";<"), "missing boundary: {source:?}");
                for segment in projection.view().segments {
                    let start = segment.original_start as usize;
                    let len = (segment.projected.end - segment.projected.start) as usize;
                    assert_eq!(
                        &projection.source()
                            [segment.projected.start as usize..segment.projected.end as usize],
                        &source[start..start + len]
                    );
                }
            }
        }
    }
}

#[test]
fn line_terminators_in_directive_trivia_end_line_comments() {
    for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
        let source = format!("function F() @{{ @if // comment{newline} (ok) {{ <div/> }} }}");
        let overlay = scan_for_parser(&source).unwrap();
        project_for_parser(&source, &overlay).unwrap();
    }
}

#[test]
fn unicode_terminators_do_not_rewrite_literals_or_create_expression_boundaries() {
    for newline in ["\u{2028}", "\u{2029}"] {
        for expression in [
            format!("const a = 'x{newline}y';"),
            format!("const a = `x{newline}y`;"),
            format!("const a = 1{newline}< 2;"),
            format!("const a = ({newline}<div/>);"),
            format!("const a ={newline}<div/>;"),
            format!("const a = f<{newline}T>();"),
        ] {
            let overlay = scan_for_parser(&expression).unwrap();
            let projection = project_for_parser(&expression, &overlay).unwrap();
            assert_eq!(projection.source(), expression);
        }
    }
}

#[test]
fn controls_after_assignment_preserve_line_terminator_semantics() {
    let template = "function F() @{ const v =\n@if (c) { <a/> } @else { <b/> };\n<p/> }";
    let baseline_overlay = scan_for_parser(template).unwrap();
    let baseline = project_for_parser(template, &baseline_overlay).unwrap();
    for newline in ["\n", "\r\n", "\u{2028}", "\u{2029}"] {
        let source = template.replace('\n', newline);
        let overlay = scan_for_parser(&source).unwrap();
        let projection = project_for_parser(&source, &overlay).unwrap();
        assert_eq!(projection.source().replace(newline, "\n"), baseline.source(), "{source:?}");
    }
}

#[test]
fn controls_after_return_preserve_line_terminator_semantics() {
    let template = "function F() @{ return\n@if (c) { <a/> } @else { <b/> };\n<p/> }";
    let baseline_overlay = scan_for_parser(template).unwrap();
    let baseline = project_for_parser(template, &baseline_overlay).unwrap();
    for newline in ["\n", "\r\n", "\u{2028}", "\u{2029}"] {
        let source = template.replace('\n', newline);
        let overlay = scan_for_parser(&source).unwrap();
        let projection = project_for_parser(&source, &overlay).unwrap();
        assert_eq!(projection.source().replace(newline, "\n"), baseline.source(), "{source:?}");
    }
}

#[test]
fn controls_after_operators_preserve_line_terminator_semantics() {
    let template = "function F() @{ const v = true &&\n@if (c) { <a/> } @else { <b/> };\n<p/> }";
    let baseline_overlay = scan_for_parser(template).unwrap();
    let baseline = project_for_parser(template, &baseline_overlay).unwrap();
    for newline in ["\n", "\r\n", "\u{2028}", "\u{2029}"] {
        let source = template.replace('\n', newline);
        let overlay = scan_for_parser(&source).unwrap();
        let projection = project_for_parser(&source, &overlay).unwrap();
        assert_eq!(projection.source().replace(newline, "\n"), baseline.source(), "{source:?}");
    }
}

#[test]
fn controls_after_comment_preserve_line_terminator_semantics() {
    let template = "function F() @{ x =\n// note\n@if (c) { <a/> } @else { <b/> };\n<p/> }";
    let baseline_overlay = scan_for_parser(template).unwrap();
    let baseline = project_for_parser(template, &baseline_overlay).unwrap();
    for newline in ["\n", "\r\n", "\u{2028}", "\u{2029}"] {
        let source = template.replace('\n', newline);
        let overlay = scan_for_parser(&source).unwrap();
        let projection = project_for_parser(&source, &overlay).unwrap();
        assert_eq!(projection.source().replace(newline, "\n"), baseline.source(), "{source:?}");
    }
}

#[test]
fn statement_controls_preserve_line_terminator_semantics() {
    for template in
        ["function F() @{ const v = 1\n@if (c) { <a/> } }", "function F() @{\n@if (c) { <a/> } }"]
    {
        let baseline_overlay = scan_for_parser(template).unwrap();
        let baseline = project_for_parser(template, &baseline_overlay).unwrap();
        for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
            let source = template.replace('\n', newline);
            let overlay = scan_for_parser(&source).unwrap();
            let projection = project_for_parser(&source, &overlay).unwrap();
            assert_eq!(projection.source().replace(newline, "\n"), baseline.source(), "{source:?}");
        }
    }
}

#[test]
fn jsx_openings_and_attributes_accept_every_line_terminator() {
    for template in [
        "const node = <div\n/>;",
        "const node = <div\ntitle\n=\n\"🚀\"\nother={value}\n/>;",
        "const node = <{Tag}\ntitle\n=\n\"🚀\"\nother={value}\n/>;",
        "const node = <div /* note */\n title=\"x\"/>;",
        "const node = <{Tag} // note\n title=\"x\"/>;",
        "const node = <div></div\n>;",
        "const node = <{Tag}></{Tag}\n>;",
    ] {
        let baseline_overlay = scan_for_parser(template).unwrap();
        let baseline = project_for_parser(template, &baseline_overlay).unwrap();
        for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
            let source = template.replace('\n', newline);
            let overlay =
                scan_for_parser(&source).unwrap_or_else(|error| panic!("{source:?}: {error:?}"));
            assert_eq!(overlay.tokens().len(), baseline_overlay.tokens().len(), "{source:?}");
            let projection = project_for_parser(&source, &overlay).unwrap();
            assert_eq!(projection.source().replace(newline, "\n"), baseline.source(), "{source:?}");
            for segment in projection.view().segments {
                let start = segment.original_start as usize;
                let len = (segment.projected.end - segment.projected.start) as usize;
                assert_eq!(
                    &projection.source()
                        [segment.projected.start as usize..segment.projected.end as usize],
                    &source[start..start + len],
                );
            }
        }
    }
}

#[test]
fn blocks_after_line_terminators_do_not_gain_markup_boundaries() {
    for template in [
        "function F() @{ const a = 1;\n{ b() }\n<div/> }",
        "function F() @{ const a = 1;\n{ b() }\n<{Tag}/> }",
        "function F() @{ if (x) { b() }\n<div/> }",
    ] {
        let baseline_overlay = scan_for_parser(template).unwrap();
        let baseline = project_for_parser(template, &baseline_overlay).unwrap();
        for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
            let source = template.replace('\n', newline);
            let overlay = scan_for_parser(&source).unwrap();
            let projection = project_for_parser(&source, &overlay).unwrap();
            assert_eq!(projection.source().replace(newline, "\n"), baseline.source(), "{source:?}");
        }
    }
}

#[test]
fn unicode_line_terminators_remain_authored_jsx_content() {
    for newline in ["\u{2028}", "\u{2029}"] {
        for source in [
            format!("const node = <div>before{newline}after</div>;"),
            format!("const node = <div title=\"before{newline}after\"/>;"),
        ] {
            let overlay = scan_for_parser(&source).unwrap();
            let projection = project_for_parser(&source, &overlay).unwrap();
            assert_eq!(projection.source(), source);
        }
    }
}

#[test]
fn raw_script_closing_tags_keep_html_whitespace_rules() {
    for newline in ["\u{2028}", "\u{2029}"] {
        let source =
            format!("const node = <script>before{newline}</script{newline}>after</script>;");
        let overlay = scan_for_parser(&source).unwrap();
        let content = overlay.view().script_blocks[0].content;
        assert_eq!(
            &source[content.start as usize..content.end as usize],
            format!("before{newline}</script{newline}>after")
        );
        let projection = tsrx_syntax::project_for_format(&source, &overlay).unwrap();
        assert_eq!(
            tsrx_syntax::lift_formatted(projection.source(), &source, &projection).unwrap(),
            source
        );
    }
}

#[test]
fn annotated_for_headers_preserve_line_terminator_parity() {
    for template in [
        "function F() @{ @for(const item of items;\nindex i;\nkey item.id) { <div/> } }",
        "function F() @{ @for(const item of items; index\ni\n; key\nitem.id\n) { <div/> } }",
        "function F() @{ @for(const item of items;\nindex(i);\nkey(item.id)) { <div/> } }",
        "function F() @{ @for(const item of items;\nkey(item.id)) { <div/> } }",
        "function F() @{ @for(const item of items;\nindex/* note */(i);\nkey/* note */(item.id)) { <div/> } }",
    ] {
        let overlay = scan_for_parser(template).unwrap();
        let baseline = project_for_parser(template, &overlay).unwrap();
        for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
            let source = template.replace('\n', newline);
            let overlay = scan_for_parser(&source).unwrap();
            let projection = project_for_parser(&source, &overlay).unwrap();
            assert_eq!(projection.source().replace(newline, "\n"), baseline.source(), "{source:?}");
            for segment in projection.view().segments {
                let start = segment.original_start as usize;
                let len = (segment.projected.end - segment.projected.start) as usize;
                assert_eq!(
                    &projection.source()
                        [segment.projected.start as usize..segment.projected.end as usize],
                    &source[start..start + len]
                );
            }
        }
    }
}

#[test]
fn markup_guards_lift_without_changing_line_terminator_bytes() {
    for template in [
        "function F() @{ const o = 1\n<div/> }",
        "function F() @{ const a = 1\n<div\ntitle=\"x\"\n/> }",
    ] {
        for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
            let source = template.replace('\n', newline);
            let overlay = scan_for_parser(&source).unwrap();
            let projection = tsrx_syntax::project_for_format(&source, &overlay).unwrap();
            assert_eq!(
                tsrx_syntax::lift_formatted(projection.source(), &source, &projection).unwrap(),
                source
            );
        }
    }
}

#[test]
fn shorthand_after_line_terminators_needs_no_synthetic_space() {
    for tag in ["div", "{Tag}"] {
        for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
            let source = format!("const node = <{tag}{newline}{{short}}/>;");
            let overlay = scan_for_parser(&source).unwrap();
            let parser = project_for_parser(&source, &overlay).unwrap();
            assert!(!parser.source().contains(&format!("{newline} ")), "{:?}", parser.source());
            let projection = tsrx_syntax::project_for_format(&source, &overlay).unwrap();
            assert_eq!(
                tsrx_syntax::lift_formatted(projection.source(), &source, &projection).unwrap(),
                source
            );
        }
    }
}

#[test]
fn header_of_line_terminators_preserve_projection() {
    for left in ["const item", "item", "const {id}", "{id}", "const [id]"] {
        for (before, after) in [("\n", " "), (" ", "\n"), ("\n", "\n")] {
            let template = format!(
                "function F() @{{ @for({left}{before}of{after}items; index i; key id) {{ <div/> }} }}"
            );
            let overlay = scan_for_parser(&template).unwrap();
            let baseline = project_for_parser(&template, &overlay).unwrap();
            assert!(baseline.source().contains("_t0_H0_"));
            for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
                let source = template.replace('\n', newline);
                let overlay = scan_for_parser(&source).unwrap();
                let projection = project_for_parser(&source, &overlay).unwrap();
                assert_eq!(
                    projection.source().replace(newline, "\n"),
                    baseline.source(),
                    "{source:?}"
                );
                for segment in projection.view().segments {
                    let start = segment.original_start as usize;
                    let len = (segment.projected.end - segment.projected.start) as usize;
                    assert_eq!(
                        &projection.source()
                            [segment.projected.start as usize..segment.projected.end as usize],
                        &source[start..start + len]
                    );
                }
            }
        }
    }
}

#[test]
fn header_keyword_suffixes_remain_unannotated() {
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
            let source = format!("function F() @{{ @for({left} of items; {tail}) {{ <div/> }} }}");
            let overlay = scan_for_parser(&source).unwrap();
            let projection = project_for_parser(&source, &overlay).unwrap();
            assert!(!projection.source().contains("_t0_H0_"), "{source:?}");
            assert!(
                projection.source().contains(&format!("{left} of items; {tail}")),
                "{source:?}"
            );
        }
    }
}

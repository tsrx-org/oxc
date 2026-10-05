//! A control-flow expression that starts or ends a larger expression (tsrx-org/oxc#149), as
//! `@tsrx/core` 0.5.2 reads it.

use tsrx_syntax::{ProjectionError, project_for_parser, scan_for_parser};

#[test]
fn the_wrapper_of_an_expression_control_stands_for_the_controls_ends() {
    let source = "const a = @if (x) { 1 } || 2;\nconst b = @for (const y of z) { y }";
    let overlay = scan_for_parser(source).unwrap();
    let projection = project_for_parser(source, &overlay).unwrap();
    let projected = projection.source();
    let anchors = projection.anchors();
    // Each wrapper has an empty anchor where it starts, for the `@`, and one where it ends, for
    // the `}`. The second wrapper ends the projection, as the control ends the file.
    let if_start = source.find("@if").unwrap();
    let if_end = source.find(" ||").unwrap();
    let for_start = source.find("@for").unwrap();
    let expected = [if_start, if_end, for_start, source.len()];
    assert_eq!(anchors.len(), expected.len());
    for (anchor, original) in anchors.iter().zip(expected) {
        assert!(anchor.projected.is_empty());
        assert_eq!(anchor.original as usize, original);
    }
    assert_eq!(&projected[anchors[1].projected.end as usize..][..5], " || 2");
    assert_eq!(anchors[3].projected.end as usize, projected.len());
}

#[test]
fn a_statement_or_jsx_child_control_has_no_wrapper_anchor() {
    let source = "function App() @{\n\t@if (x) {\n\t\t<p>{y}</p>\n\t}\n\t<div>@for (const z of w) {\n\t\t<i />\n\t}</div>\n}";
    let overlay = scan_for_parser(source).unwrap();
    assert!(project_for_parser(source, &overlay).unwrap().anchors().is_empty());
}

#[test]
fn an_expression_control_takes_no_subscript() {
    for tail in [".length", "()", "[0]", "?.x", "`t`", "!", "\n.length", "\n(1)", " /* c */ .x"] {
        let source = format!("const a = @if (x) {{ 1 }}{tail};");
        let error = scan_for_parser(&source).unwrap_err();
        let offset = source.rfind(tail.trim_start().trim_start_matches("/* c */ ")).unwrap();
        assert_eq!(
            error,
            ProjectionError::MalformedSyntax {
                offset: u32::try_from(offset).unwrap(),
                expected: "an operator or the end of the expression after a control-flow expression",
            },
            "{source}"
        );
    }
    // An operator, a number, a `!` on the next line, and a parenthesized control are read.
    for source in [
        "const a = @if (x) { 1 } != 2;",
        "const a = @if (x) { 1 } ? .5 : 1;",
        "const a = @if (x) { 1 }\n!b;",
        "const a = (@if (x) { 1 }).length;",
        "function App() @{\n\t@if (x) {\n\t\t<p />\n\t}\n\t(y);\n}",
    ] {
        scan_for_parser(source).unwrap_or_else(|error| panic!("{source}: {error}"));
    }
}

#[test]
fn a_not_expression_after_a_line_break_is_not_a_control_subscript() {
    for newline in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
        for trivia in
            [newline.to_string(), format!(" /* note{newline} */ "), format!(" // note{newline} ")]
        {
            let source = format!("const a = @if (x) {{ 1 }}{trivia}!b;");
            let overlay =
                scan_for_parser(&source).unwrap_or_else(|error| panic!("{source:?}: {error}"));
            project_for_parser(&source, &overlay).unwrap();
        }
    }
    for trivia in ["", " ", " /* 🚀 */ "] {
        let source = format!("const a = @if (x) {{ 1 }}{trivia}!b;");
        assert!(matches!(scan_for_parser(&source), Err(ProjectionError::MalformedSyntax { .. })));
    }
}

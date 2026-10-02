use oxc_diagnostics::OxcDiagnostic;

/// Whether OXC reported a TypeScript grammar diagnostic for a shape the reference TSRX parser
/// accepts, where OXC still builds the right AST.
pub(crate) fn is_tsrx_compatible_grammar_diagnostic(
    source: &str,
    diagnostic: &OxcDiagnostic,
) -> bool {
    if diagnostic.code.scope.as_deref() != Some("TS") {
        return false;
    }
    if diagnostic.code.number.as_deref() == Some("1147") {
        return true;
    }
    if diagnostic.code.number.as_deref() != Some("18007") {
        return false;
    }

    // With `preserve_parens: false`, OXC drops this evidence before validating JSX and reports
    // TS18007 for an authored parenthesized sequence expression. The reference parser accepts the
    // expression, and OXC still constructs its correct SequenceExpression node.
    let bytes = source.as_bytes();
    diagnostic.labels.iter().any(|label| {
        let Ok(start) = usize::try_from(label.offset()) else {
            return false;
        };
        let Ok(length) = usize::try_from(label.len()) else {
            return false;
        };
        let Some(end) = start.checked_add(length) else {
            return false;
        };
        start.checked_sub(1).and_then(|index| bytes.get(index)) == Some(&b'(')
            && bytes.get(end) == Some(&b')')
    })
}

//! Oxfmt's ASI guard in front of markup, and why the lift removes it.
//!
//! Under `semi: false` Oxfmt prints a `;` in front of any statement whose first token could
//! otherwise continue the line above: `(`, `[`, a template literal, and `<`. In JavaScript the
//! last one is a real hazard, `const x = f()` followed by `<div>` on the next line is a
//! comparison, and the projection writes exactly that `;` so the legal-TSX copy reads the
//! statement boundary TSRX read. TSRX itself has no hazard there: a committed markup opening that
//! leads its line begins a statement, which is the rule `scan_region` applies through
//! `line_leading_markup_starts_a_statement`. Printing the guard back into `.tsrx` therefore
//! trades one trailing `;` per ordinary statement for one leading `;` per markup statement,
//! and a no-semicolon house style can never produce clean source (tsrx-org/oxc#64).
//!
//! The pass is deliberately narrow. A `;` is removed only when all of the following hold:
//!
//! - the scan of the lifted text admitted the `<` right after it as a markup opening at
//!   statement position, so a `;` that is JSX text before a child element, or sits inside a
//!   string, template, or comment, is never a candidate;
//! - the `;` is the first non-blank byte on its line, which is the only shape Oxfmt prints;
//! - with the `;` gone, the line-leading rule would admit the opening on its own.
//!
//! Every other guard, and everything under `semi: true`, is left byte for byte. The lift's
//! structural fingerprint check runs on the result as before.

use crate::{
    diagnostics::ProjectionError,
    model::Overlay,
    parser_scanner::{Scanner, admits_line_leading_markup},
};

/// Removes the ASI guards described above and returns the text with the overlay of its final
/// form, so the caller's fingerprint check sees exactly what the caller returns.
pub(super) fn lift_markup_guards(lifted: String) -> Result<(String, Overlay), ProjectionError> {
    let (overlay, openings) = Scanner::new_for_parser(&lifted).finish_with_markup_statements()?;
    let bytes = lifted.as_bytes();
    let mut guards = Vec::new();
    for opening in openings {
        let opening = opening as usize;
        let Some(semicolon) = opening.checked_sub(1) else { continue };
        if bytes[semicolon] != b';' {
            continue;
        }
        let line_start =
            bytes[..semicolon].iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
        if !bytes[line_start..semicolon].iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        // The line as it would read without the guard, behind a terminator so the opening leads
        // its line the way the rule requires. Nothing before that terminator matters to the rule:
        // a line-leading markup opening never continues the line above it.
        let candidate = format!("\n{}{}", &lifted[line_start..semicolon], &lifted[opening..]);
        if admits_line_leading_markup(&candidate, 1 + semicolon - line_start) {
            guards.push(semicolon);
        }
    }
    if guards.is_empty() {
        return Ok((lifted, overlay));
    }
    let mut output = String::with_capacity(lifted.len());
    let mut copied = 0usize;
    for semicolon in guards {
        output.push_str(&lifted[copied..semicolon]);
        copied = semicolon + 1;
    }
    output.push_str(&lifted[copied..]);
    let rescanned = Scanner::new_for_parser(&output).finish()?;
    Ok((output, rescanned))
}

mod case_expressions;
mod embedded;
mod guards;
mod parser;
mod scaffold;
mod text;
mod text_comments;
mod tokens;
mod writer;

use crate::diagnostics::ProjectionError;

use super::{format::FormatProjection, marker::structural_fingerprint};
use case_expressions::lift_case_expressions;
use embedded::lift_embedded;
use guards::lift_markup_guards;
use parser::lift_parser_scaffolds;
use scaffold::lift_scaffolds;
use text_comments::lift_text_comments;
use tokens::lift_tokens;

const MISSING_POSITION: usize = usize::MAX;

/// Writes each `>` in JSX text back. `@tsrx/core` reads one there as text, where TSX rejects it,
/// so the projection wrote a private-use character the source never holds in its place, and Oxfmt
/// kept it as a word of the text. Oxfmt neither drops nor copies text, so each one comes back once.
fn lift_text_gts(lifted: String, projection: &FormatProjection) -> Result<String, ProjectionError> {
    if projection.text_gts == 0 {
        return Ok(lifted);
    }
    if lifted.matches(projection.gt_stand_in).count() != projection.text_gts {
        return Err(ProjectionError::MarkerResidual);
    }
    Ok(lifted.replace(projection.gt_stand_in, ">"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ScaffoldSpan {
    start: usize,
    end: usize,
}

impl ScaffoldSpan {
    const MISSING: Self = Self { start: MISSING_POSITION, end: MISSING_POSITION };

    const fn is_missing(self) -> bool {
        self.start == MISSING_POSITION
    }
}

/// Lifts canonical Oxfmt output back into TSRX after validating every synthetic scaffold.
///
/// # Errors
///
/// Returns an error if Oxfmt changed or duplicated scaffolding, or if the lifted structure no
/// longer matches the source overlay.
pub fn lift_formatted(
    formatted: &str,
    original_source: &str,
    projection: &FormatProjection,
) -> Result<String, ProjectionError> {
    let lifted = lift_parser_scaffolds(formatted, projection)?;
    let lifted = lift_scaffolds(&lifted, projection)?;
    let lifted = if projection.dynamics.is_empty()
        && projection.dynamic_comments.is_empty()
        && projection.styles.is_empty()
        && projection.scripts.is_empty()
    {
        lifted
    } else {
        lift_embedded(&lifted, original_source, projection)?
    };
    let lifted = if projection.case_expressions == 0 {
        lifted
    } else {
        lift_case_expressions(lifted, projection)?
    };
    // Before the token lift, which reads every `/*` marker in the namespace as a token marker.
    let lifted = if projection.text_comments.is_empty() {
        lifted
    } else {
        lift_text_comments(&lifted, projection)?
    };
    let lifted = lift_text_gts(lifted, projection)?;
    let lifted = lift_tokens(&lifted, projection)?;
    if lifted.contains(&projection.prefix) {
        return Err(ProjectionError::MarkerResidual);
    }
    let (lifted, rescanned) = lift_markup_guards(lifted)?;
    if structural_fingerprint(&rescanned) != projection.shape_fingerprint {
        return Err(ProjectionError::StructuralMismatch);
    }
    Ok(lifted)
}

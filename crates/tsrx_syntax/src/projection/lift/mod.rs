mod embedded;
mod parser;
mod scaffold;
mod text;
mod tokens;
mod writer;

use crate::{diagnostics::ProjectionError, parser_scanner::Scanner};

use super::{format::FormatProjection, marker::structural_fingerprint};
use embedded::lift_embedded;
use parser::lift_parser_scaffolds;
use scaffold::lift_scaffolds;
use tokens::lift_tokens;

const MISSING_POSITION: usize = usize::MAX;

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
    let lifted = lift_tokens(&lifted, projection)?;
    if lifted.contains(&projection.prefix) {
        return Err(ProjectionError::MarkerResidual);
    }
    let rescanned = Scanner::new_for_parser(&lifted).finish()?;
    if structural_fingerprint(&rescanned) != projection.shape_fingerprint {
        return Err(ProjectionError::StructuralMismatch);
    }
    Ok(lifted)
}

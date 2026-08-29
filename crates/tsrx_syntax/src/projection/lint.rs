use crate::{diagnostics::ProjectionError, model::Overlay};

use super::{
    builder::build_projection, mapping::MappedProjection, marker::validate_overlay_source,
    parser_overlay,
};

/// Performs the legacy equal-width projection used by standard-syntax control baselines.
///
/// Expanded JSX-child and expression controls require [`project_for_lint`] or
/// [`crate::project_for_format`].
///
/// # Errors
///
/// Returns an error when `overlay` was produced from different source bytes.
pub fn project(source: &str, overlay: &Overlay) -> Result<String, ProjectionError> {
    validate_overlay_source(source, overlay)?;
    if let Some(token) = overlay.embedded_tokens.first() {
        return Err(ProjectionError::UnsupportedSyntax {
            offset: token.span.start,
            construct: "embedded syntax in the legacy equal-width projection",
        });
    }
    let mut bytes = source.as_bytes().to_vec();
    for token in &overlay.tokens {
        bytes[token.span.start as usize] = b' ';
    }
    String::from_utf8(bytes).map_err(|_| ProjectionError::SourceChanged { offset: 0 })
}

/// Builds a legal-TSX projection with explicit affine source-map segments.
///
/// A base [`crate::scan`] overlay is upgraded to the richer parser/tooling
/// overlay for compatibility. Hot paths should pass [`crate::scan_for_parser`]
/// output to avoid a second scan.
///
/// # Errors
///
/// Returns an error for a stale overlay or a projection scaffold collision.
pub fn project_for_lint(
    source: &str,
    overlay: &Overlay,
) -> Result<MappedProjection, ProjectionError> {
    let overlay = parser_overlay(source, overlay)?;
    Ok(build_projection(source, overlay.as_ref(), true)?.mapped)
}

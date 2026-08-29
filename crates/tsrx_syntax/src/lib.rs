//! Lossless, allocation-light TSRX recognition and legal-TSX projection.

mod diagnostics;
mod model;
mod parser_projection;
mod parser_scanner;
mod projection;
mod projection_view;
mod scanner;

pub use diagnostics::ProjectionError;
pub use model::{
    ByteSpan, ClauseRole, ControlContext, ControlKind, EmbeddedKind, ForHeader, NONE_INDEX,
    Overlay, OverlayClause, OverlayDynamicTag, OverlayEmbedded, OverlayNode, OverlayStyleBlock,
    OverlayToken, OverlayView, PARSER_EXPRESSION_CODE_BLOCK_PREFIX, ParserCodeBlock,
    ParserCodeBlockKind, ParserDynamicKind, ParserDynamicToken, ParserLazyPattern,
    ParserShorthandAttribute, ScriptBlock, StructuralKind, StructuralToken,
};
pub use parser_projection::{MappedProjection as ParserProjection, project_for_parser};
pub use parser_scanner::OpaqueSurrogateContext;
pub use projection::{
    FormatProjection, MappedProjection, TypeProjection, lift_formatted, project,
    project_for_format, project_for_lint, project_for_types,
};
pub use projection_view::{ProjectionSegment, ProjectionView};

use scanner::Scanner;

/// Full result of the WTF-8 lexical proof, including any earlier authored grammar failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wtf8SurrogateClassification {
    pub contexts: Vec<Option<OpaqueSurrogateContext>>,
    pub earlier_error: Option<ProjectionError>,
}

/// Classifies pre-recorded three-byte WTF-8 lone-surrogate positions without passing them to OXC.
#[must_use]
pub fn classify_wtf8_surrogates(
    source: &[u8],
    byte_offsets: &[u32],
) -> Vec<Option<OpaqueSurrogateContext>> {
    parser_scanner::Scanner::new_for_surrogate_classification(source, byte_offsets)
        .classify_surrogates()
}

/// Classifies WTF-8 surrogate probes while retaining an earlier structural scanner failure.
#[must_use]
pub fn classify_wtf8_surrogates_detailed(
    source: &[u8],
    byte_offsets: &[u32],
) -> Wtf8SurrogateClassification {
    let (contexts, earlier_error) =
        parser_scanner::Scanner::new_for_surrogate_classification(source, byte_offsets)
            .classify_surrogates_detailed();
    Wtf8SurrogateClassification { contexts, earlier_error }
}

/// Performs one byte-oriented structural scan and returns a compact overlay over `source`.
///
/// # Errors
///
/// Returns an error for malformed or unsupported TSRX, unterminated lexical constructs, and
/// sources beyond OXC's 32-bit span limit.
pub fn scan(source: &str) -> Result<Overlay, ProjectionError> {
    Scanner::new(source).finish()
}

/// Performs the parser/tooling scan, including nested dynamic names, JSX code blocks,
/// shorthand attributes, lazy patterns, and raw script regions.
///
/// # Errors
///
/// Returns the same malformed, unsupported, unterminated, and size failures as [`scan`].
pub fn scan_for_parser(source: &str) -> Result<Overlay, ProjectionError> {
    parser_scanner::Scanner::new_for_parser(source).finish()
}

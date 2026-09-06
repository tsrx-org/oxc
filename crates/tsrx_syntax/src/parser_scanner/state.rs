//! The scanner's own state: the flat vectors an overlay is assembled from, and the two entry
//! points that fill them, one for the parser lane and one for surrogate classification.

use std::cell::RefCell;

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, Clause, DynamicTag, EmbeddedToken, NONE, Overlay, ParserCodeBlock,
        ParserDynamicToken, ParserLazyPattern, ParserShorthandAttribute, ScriptBlock,
        StructuralToken, StyleBlock, SyntaxNode,
    },
};

use super::stack::TinyStack;
use super::surrogates::SurrogateProbes;

pub(crate) struct Scanner<'a> {
    pub(super) bytes: &'a [u8],
    pub(super) tokens: Vec<StructuralToken>,
    pub(super) nodes: Vec<SyntaxNode>,
    pub(super) clauses: Vec<Clause>,
    pub(super) embedded_tokens: Vec<EmbeddedToken>,
    pub(super) parser_dynamic_tokens: Vec<ParserDynamicToken>,
    pub(super) parser_code_blocks: Vec<ParserCodeBlock>,
    pub(super) parser_shorthand_attributes: Vec<ParserShorthandAttribute>,
    pub(super) parser_lazy_patterns: Vec<ParserLazyPattern>,
    pub(super) dynamic_tags: Vec<DynamicTag>,
    pub(super) dynamic_comments: Vec<ByteSpan>,
    pub(super) style_blocks: Vec<StyleBlock>,
    pub(super) script_blocks: Vec<ScriptBlock>,
    pub(super) statement_boundaries: Vec<u32>,
    /// Offsets of every markup opening scanned at statement position, in ascending order: the
    /// `<` that `scan_region` admitted where a statement may begin rather than inside an
    /// expression or as a JSX child. The formatter lift consults this list before dropping an
    /// ASI guard Oxfmt printed in front of one.
    pub(super) markup_statements: Vec<u32>,
    pub(super) first_root: u32,
    pub(super) last_root: u32,
    pub(super) parents: Vec<u32>,
    pub(super) parser_dynamic_parents: TinyStack<u32, 8>,
    pub(super) surrogate_probes: Option<Box<RefCell<SurrogateProbes>>>,
}
impl<'a> Scanner<'a> {
    fn new_bytes(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            tokens: Vec::with_capacity(bytes.len().div_ceil(384)),
            nodes: Vec::with_capacity(bytes.len().div_ceil(1024)),
            clauses: Vec::with_capacity(bytes.len().div_ceil(512)),
            // Dynamic tags and raw styles are sparse. Keep the common zero-syntax path free of
            // avoidable heap allocations; the flat vectors grow after the first commit.
            embedded_tokens: Vec::new(),
            parser_dynamic_tokens: Vec::new(),
            parser_code_blocks: Vec::new(),
            parser_shorthand_attributes: Vec::new(),
            parser_lazy_patterns: Vec::new(),
            dynamic_tags: Vec::new(),
            dynamic_comments: Vec::new(),
            style_blocks: Vec::new(),
            script_blocks: Vec::new(),
            statement_boundaries: Vec::new(),
            markup_statements: Vec::new(),
            first_root: NONE,
            last_root: NONE,
            parents: Vec::with_capacity(8),
            parser_dynamic_parents: TinyStack::new(),
            surrogate_probes: None,
        }
    }

    pub(crate) fn new_for_parser(source: &'a str) -> Self {
        Self::new_bytes(source.as_bytes())
    }

    pub(crate) fn new_for_surrogate_classification(source: &'a [u8], offsets: &[u32]) -> Self {
        let mut scanner = Self::new_bytes(source);
        if !offsets.is_empty() {
            scanner.surrogate_probes = Some(Box::new(RefCell::new(SurrogateProbes::new(offsets))));
        }
        scanner
    }

    pub(crate) fn finish(mut self) -> Result<Overlay, ProjectionError> {
        let source_len = to_u32(self.bytes.len())?;
        self.scan_region(0, None)?;
        Ok(self.into_overlay(source_len))
    }

    /// [`Self::finish`], also handing back the statement-position markup openings the scan
    /// admitted. The overlay itself does not carry them: they are a fact about one scan of one
    /// text, consumed by the formatter lift and nothing else.
    pub(crate) fn finish_with_markup_statements(
        mut self,
    ) -> Result<(Overlay, Vec<u32>), ProjectionError> {
        let source_len = to_u32(self.bytes.len())?;
        self.scan_region(0, None)?;
        let markup_statements = std::mem::take(&mut self.markup_statements);
        Ok((self.into_overlay(source_len), markup_statements))
    }
}

/// True when the `<` at `index` opens a markup statement on the strength of the line-leading
/// rule alone: it leads its line, it is a committed markup opening, and it is not a TypeScript
/// type-parameter form. This is exactly the admission `scan_region` makes when nothing before
/// the opening lets JSX start, so the formatter lift can ask it before removing the `;` Oxfmt
/// printed there.
pub(crate) fn admits_line_leading_markup(source: &str, index: usize) -> bool {
    let scanner = Scanner::new_for_parser(source);
    scanner.line_leading_markup_starts_a_statement(index)
        && scanner.looks_like_jsx_start(index)
        && !scanner.looks_like_typescript_type_parameters(index)
}

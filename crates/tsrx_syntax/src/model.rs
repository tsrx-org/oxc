use std::ops::Range;

/// Missing index sentinel for every flat overlay chain.
pub const NONE_INDEX: u32 = u32::MAX;
pub(crate) const NONE: u32 = NONE_INDEX;

/// A byte range in the original UTF-8 source.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ByteSpan {
    pub start: u32,
    pub end: u32,
}

impl ByteSpan {
    #[must_use]
    pub const fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start == self.end
    }

    #[must_use]
    pub const fn intersects(self, start: u32, end: u32) -> bool {
        if start == end {
            return self.start <= start && start <= self.end;
        }
        self.start < end && start < self.end
    }
}

/// Structural spellings retained by the compact overlay.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StructuralKind {
    FunctionBody,
    If,
    Else,
    For,
    Empty,
    Switch,
    Case,
    Default,
    Try,
    Pending,
    Catch,
}

impl StructuralKind {
    pub(crate) const fn projected_token(self) -> &'static str {
        match self {
            Self::FunctionBody => "{",
            Self::If | Self::Empty => "if",
            Self::Else => "else",
            Self::For => "for",
            Self::Switch => "switch",
            Self::Case => "case",
            Self::Default => "default",
            Self::Try | Self::Pending | Self::Catch => "",
        }
    }
}

/// One authored `@` byte. The payload stays in the original source.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StructuralToken {
    pub kind: StructuralKind,
    pub span: ByteSpan,
    pub owner: u32,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlKind {
    If,
    For,
    Switch,
    Try,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlContext {
    Statement,
    Expression,
    JsxChild,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClauseRole {
    If,
    ElseIf,
    Else,
    For,
    Empty,
    Case,
    Default,
    Try,
    Pending,
    Catch,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddedKind {
    DynamicOpen,
    DynamicClose,
    StyleContent,
    ScriptContent,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParserDynamicKind {
    OpenStart,
    OpenEnd,
    CloseStart,
    CloseEnd,
}

/// One source-ordered boundary used only by the parser projection.
///
/// Splitting a dynamic name around its authored expression allows nested TSRX syntax to be
/// projected without overlapping replacement spans.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParserDynamicToken {
    pub kind: ParserDynamicKind,
    pub offset: u32,
    pub owner: u32,
}

/// How one statement-bearing `@{ ... }` must be wrapped for the parser projection.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParserCodeBlockKind {
    /// The authored braces become a JSX expression container around the parser scaffold.
    JsxChild,
    /// The authored braces become the parser scaffold function's body.
    Expression,
}

/// Generated expression prefix shared by projection and module-result reconstruction.
pub const PARSER_EXPRESSION_CODE_BLOCK_PREFIX: &str = "void async function*()";

/// One statement-bearing `@{ ... }` boundary used only by the parser projection.
///
/// The ordinary structural token keeps its one-byte `@` span. This sparse side table records
/// the matching authored braces and their placement so the parser projection can surround the
/// block with legal, authenticated TSX without rescanning the source.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParserCodeBlock {
    pub token: u32,
    pub body: ByteSpan,
    pub kind: ParserCodeBlockKind,
}

/// One TSRX shorthand JSX attribute such as `{value}`.
///
/// The parser projection duplicates the identifier into the legal TSX spelling
/// `value={value}`; reconstruction uses these authored spans to restore the shorthand flag and
/// the attribute's original range.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParserShorthandAttribute {
    pub span: ByteSpan,
    pub identifier: ByteSpan,
}

/// One lazy destructuring marker before an array/object pattern.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParserLazyPattern {
    pub ampersand: u32,
    pub pattern_start: u32,
    /// `true` for a standalone `&{...} = value;` / `&[...] = value;` statement.
    pub standalone: bool,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbeddedToken {
    pub kind: EmbeddedKind,
    pub span: ByteSpan,
    pub owner: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DynamicTag {
    pub opening: ByteSpan,
    /// Paired closing tag, or an empty span at the full element end for a self-closing tag.
    pub closing: ByteSpan,
    pub expression: ByteSpan,
    pub closing_expression: ByteSpan,
    /// Exclusive preorder boundary for dynamic tags nested inside this element.
    pub subtree_end: u32,
    pub first_closing_comment: u32,
    pub closing_comment_count: u32,
    pub self_closing: bool,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StyleBlock {
    /// Complete authored JSX style element, including its opening and optional closing tag.
    pub element: ByteSpan,
    /// Exact authored bytes between the opening and closing tags. Empty at `element.end` for a
    /// self-closing style element.
    pub content: ByteSpan,
    pub self_closing: bool,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptBlock {
    /// Complete authored JSX script element, including its opening and closing tag.
    pub element: ByteSpan,
    /// Exact authored raw-text bytes between the opening and closing tags.
    pub content: ByteSpan,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ForHeader {
    pub left: ByteSpan,
    pub right: ByteSpan,
    pub index: ByteSpan,
    pub key: ByteSpan,
    pub annotated: bool,
    pub r#await: bool,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clause {
    pub role: ClauseRole,
    pub keyword: ByteSpan,
    pub header: ByteSpan,
    pub body: ByteSpan,
    pub for_header: ForHeader,
    pub bindings: u8,
    pub next: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyntaxNode {
    pub kind: ControlKind,
    pub context: ControlContext,
    pub span: ByteSpan,
    pub parent: u32,
    pub first_child: u32,
    pub last_child: u32,
    pub next_sibling: u32,
    pub first_clause: u32,
    pub last_clause: u32,
}

pub type OverlayToken = StructuralToken;
pub type OverlayNode = SyntaxNode;
pub type OverlayClause = Clause;
pub type OverlayEmbedded = EmbeddedToken;
pub type OverlayDynamicTag = DynamicTag;
pub type OverlayStyleBlock = StyleBlock;

/// Allocation-free borrowed access to the scanner's existing flat storage.
#[derive(Debug, Clone, Copy)]
pub struct OverlayView<'a> {
    pub source_len: u32,
    pub tokens: &'a [OverlayToken],
    pub nodes: &'a [OverlayNode],
    pub clauses: &'a [OverlayClause],
    pub embedded: &'a [OverlayEmbedded],
    pub parser_dynamic: &'a [ParserDynamicToken],
    pub parser_code_blocks: &'a [ParserCodeBlock],
    pub parser_shorthand_attributes: &'a [ParserShorthandAttribute],
    pub parser_lazy_patterns: &'a [ParserLazyPattern],
    pub dynamic_tags: &'a [OverlayDynamicTag],
    pub dynamic_comments: &'a [ByteSpan],
    pub style_blocks: &'a [OverlayStyleBlock],
    pub script_blocks: &'a [ScriptBlock],
    pub first_root: u32,
}

/// Compact lossless overlay over the original source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlay {
    pub(crate) source_len: u32,
    pub(crate) source_fingerprint: u128,
    pub(crate) parser_metadata: bool,
    pub(crate) tokens: Vec<StructuralToken>,
    pub(crate) nodes: Vec<SyntaxNode>,
    pub(crate) clauses: Vec<Clause>,
    pub(crate) embedded_tokens: Vec<EmbeddedToken>,
    pub(crate) parser_dynamic_tokens: Vec<ParserDynamicToken>,
    pub(crate) parser_code_blocks: Vec<ParserCodeBlock>,
    pub(crate) parser_shorthand_attributes: Vec<ParserShorthandAttribute>,
    pub(crate) parser_lazy_patterns: Vec<ParserLazyPattern>,
    pub(crate) dynamic_tags: Vec<DynamicTag>,
    pub(crate) dynamic_comments: Vec<ByteSpan>,
    pub(crate) style_blocks: Vec<StyleBlock>,
    pub(crate) script_blocks: Vec<ScriptBlock>,
    /// Offsets of markup openings that begin a statement only because they lead their line, in
    /// ascending order. Each one needs a projected `;` so the legal-TSX lane reads the same
    /// statement boundary the TSRX scanner did.
    pub(crate) statement_boundaries: Vec<u32>,
    pub(crate) first_root: u32,
    pub(crate) last_root: u32,
}

impl Overlay {
    pub(crate) const fn has_parser_metadata(&self) -> bool {
        self.parser_metadata
    }

    /// Borrows every reconstruction-relevant flat table without allocating another graph.
    #[must_use]
    pub fn view(&self) -> OverlayView<'_> {
        OverlayView {
            source_len: self.source_len,
            tokens: &self.tokens,
            nodes: &self.nodes,
            clauses: &self.clauses,
            embedded: &self.embedded_tokens,
            parser_dynamic: &self.parser_dynamic_tokens,
            parser_code_blocks: &self.parser_code_blocks,
            parser_shorthand_attributes: &self.parser_shorthand_attributes,
            parser_lazy_patterns: &self.parser_lazy_patterns,
            dynamic_tags: &self.dynamic_tags,
            dynamic_comments: &self.dynamic_comments,
            style_blocks: &self.style_blocks,
            script_blocks: &self.script_blocks,
            first_root: self.first_root,
        }
    }

    #[must_use]
    pub fn tokens(&self) -> &[StructuralToken] {
        &self.tokens
    }

    #[must_use]
    pub const fn source_len(&self) -> u32 {
        self.source_len
    }

    #[must_use]
    pub fn control_count(&self) -> usize {
        self.nodes.len()
    }

    #[must_use]
    pub fn dynamic_tag_count(&self) -> usize {
        self.dynamic_tags.len()
    }

    #[must_use]
    pub fn style_block_count(&self) -> usize {
        self.style_blocks.len()
    }

    /// Returns true only when an edit stays wholly in unchanged authored syntax.
    #[must_use]
    #[expect(
        clippy::suspicious_operation_groupings,
        reason = "the range is checked for well-formedness and then against the source length; the suggested `self.end` does not exist"
    )]
    pub fn is_identity_range(&self, range: Range<u32>) -> bool {
        range.start <= range.end
            && range.end <= self.source_len
            && self.tokens.iter().all(|token| !token.span.intersects(range.start, range.end))
            && self
                .embedded_tokens
                .iter()
                .all(|token| !token.span.intersects(range.start, range.end))
    }
}

#[cfg(all(test, target_pointer_width = "64"))]
mod layout_tests {
    use std::mem::size_of;

    use super::{
        ByteSpan, Clause, DynamicTag, EmbeddedToken, ForHeader, StructuralToken, StyleBlock,
        SyntaxNode,
    };

    #[test]
    fn hot_record_layouts_remain_compact() {
        assert_eq!(size_of::<ByteSpan>(), 8);
        assert_eq!(size_of::<StructuralToken>(), 16);
        assert_eq!(size_of::<EmbeddedToken>(), 16);
        assert_eq!(size_of::<DynamicTag>(), 48);
        assert_eq!(size_of::<StyleBlock>(), 20);
        assert_eq!(size_of::<ForHeader>(), 36);
        assert_eq!(size_of::<Clause>(), 72);
        assert_eq!(size_of::<SyntaxNode>(), 36);
    }
}

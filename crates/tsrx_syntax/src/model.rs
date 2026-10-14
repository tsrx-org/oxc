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

/// What the parser projection writes for a `>` in JSX text.
///
/// TSX rejects a `>` there and `@tsrx/core` reads it as text. The stand-in is one byte, so the
/// text keeps its length, TSX reads it as text, and it can never join the text around it into a
/// projection marker. The parser puts the `>` back into the text's `value` and `raw` from the
/// authored source.
pub const PARSER_JSX_TEXT_GT_STAND_IN: &str = "-";

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

/// What every projection writes in place of a shorthand attribute's name that is a reserved
/// word, such as `{class}` or `{this}`, where the lane would otherwise write the name itself.
///
/// `@tsrx/core` reads any identifier name there as an `Identifier`, `{this}` and `{class}`
/// included, but TSX reads a reserved word in an expression container as a keyword or rejects it.
/// `undefined` is an identifier reference TSX reads anywhere, and the parser writes the authored
/// name back.
pub const SHORTHAND_RESERVED_NAME_STAND_IN: &str = "undefined";

/// Whether a shorthand attribute's authored name is a reserved word, which no lane can write as
/// an identifier reference in an expression container.
#[must_use]
pub fn shorthand_name_is_reserved(name: &[u8]) -> bool {
    matches!(
        name,
        b"await"
            | b"break"
            | b"case"
            | b"catch"
            | b"class"
            | b"const"
            | b"continue"
            | b"debugger"
            | b"default"
            | b"delete"
            | b"do"
            | b"else"
            | b"export"
            | b"extends"
            | b"false"
            | b"finally"
            | b"for"
            | b"function"
            | b"if"
            | b"implements"
            | b"import"
            | b"in"
            | b"instanceof"
            | b"let"
            | b"new"
            | b"null"
            | b"package"
            | b"private"
            | b"protected"
            | b"public"
            | b"return"
            | b"static"
            | b"super"
            | b"switch"
            | b"this"
            | b"throw"
            | b"true"
            | b"try"
            | b"typeof"
            | b"var"
            | b"void"
            | b"while"
            | b"with"
            | b"yield"
    )
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

/// A JSX element that a `}` closes before its closing tag.
///
/// `@tsrx/core` 0.5 reads a JavaScript comment in JSX text as a comment, so a comment can swallow
/// an element's closing tag (`<p>// c</p>`). Core then ends the element at the `}` that closes the
/// enclosing template or function and reports `Unclosed tag`. The parser projection writes the
/// missing closing tag in front of that `}` (`offset`), and the parse reports the error.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImplicitClose {
    /// The authored `}` the element ends at.
    pub offset: u32,
    /// The element's authored tag name; empty for a fragment.
    pub name: ByteSpan,
}

impl ImplicitClose {
    /// `@tsrx/core`'s message for the element this closes.
    #[must_use]
    pub fn message(self, source: &str) -> String {
        unclosed_tag_message(
            source.get(self.name.start as usize..self.name.end as usize).unwrap_or_default(),
        )
    }
}

/// `@tsrx/core`'s `Unclosed tag` message for the tag written `name` (empty for a fragment).
#[must_use]
pub fn unclosed_tag_message(name: &str) -> String {
    format!("Unclosed tag '<{name}>'. Expected '</{name}>' before end of template.")
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
    pub dynamic_tags: &'a [OverlayDynamicTag],
    pub dynamic_comments: &'a [ByteSpan],
    pub style_blocks: &'a [OverlayStyleBlock],
    pub script_blocks: &'a [ScriptBlock],
    /// JavaScript comments in JSX text, in source order. They are comments, not text.
    pub jsx_text_comments: &'a [ByteSpan],
    /// Offsets of each `>` in JSX text, in source order. They are text.
    pub jsx_text_gts: &'a [u32],
    /// Elements a `}` closed before their closing tag, innermost first at each offset.
    pub implicit_closes: &'a [ImplicitClose],
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
    pub(crate) dynamic_tags: Vec<DynamicTag>,
    pub(crate) dynamic_comments: Vec<ByteSpan>,
    pub(crate) style_blocks: Vec<StyleBlock>,
    pub(crate) script_blocks: Vec<ScriptBlock>,
    /// Offsets of markup openings that begin a statement only because they lead their line, in
    /// ascending order. Each one needs a projected `;` so the legal-TSX lane reads the same
    /// statement boundary the TSRX scanner did.
    pub(crate) statement_boundaries: Vec<u32>,
    /// JavaScript comments in JSX text (`//` after whitespace or at the start of a text run, to
    /// the line break; `/* ... */` anywhere), in source order. Every projection writes each one
    /// in braces, the `{/* ... */}` child TSX reads as a comment.
    pub(crate) jsx_text_comments: Vec<ByteSpan>,
    /// Offsets of each `>` in JSX text, in source order. `@tsrx/core` reads a `>` there as text,
    /// where TSX rejects it, so every projection writes a stand-in for each one that TSX reads as
    /// text, and each lane puts the `>` back.
    pub(crate) jsx_text_gts: Vec<u32>,
    /// Each `{ … }` that begins a consequent directly in an `@case` or `@default` body, in source
    /// order. `@tsrx/core` reads one as a template expression container, not a block statement.
    pub(crate) case_expressions: Vec<ByteSpan>,
    pub(crate) implicit_closes: Vec<ImplicitClose>,
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
            dynamic_tags: &self.dynamic_tags,
            dynamic_comments: &self.dynamic_comments,
            style_blocks: &self.style_blocks,
            script_blocks: &self.script_blocks,
            jsx_text_comments: &self.jsx_text_comments,
            jsx_text_gts: &self.jsx_text_gts,
            implicit_closes: &self.implicit_closes,
            first_root: self.first_root,
        }
    }

    /// JavaScript comments in JSX text, in source order.
    #[must_use]
    pub fn jsx_text_comments(&self) -> &[ByteSpan] {
        &self.jsx_text_comments
    }

    /// Offsets of each `>` in JSX text, in source order.
    #[must_use]
    pub fn jsx_text_gts(&self) -> &[u32] {
        &self.jsx_text_gts
    }

    /// Expression containers that begin a consequent of an `@case` or `@default` body.
    #[must_use]
    pub fn case_expressions(&self) -> &[ByteSpan] {
        &self.case_expressions
    }

    /// Elements a `}` closed before their closing tag.
    #[must_use]
    pub fn implicit_closes(&self) -> &[ImplicitClose] {
        &self.implicit_closes
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

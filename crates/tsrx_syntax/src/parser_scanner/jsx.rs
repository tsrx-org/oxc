//! JSX elements, and the commitment rule that decides when a `<` genuinely opens one.

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, ControlContext, DynamicTag, EmbeddedKind, EmbeddedToken, ImplicitClose, NONE,
        ParserCodeBlock, ParserCodeBlockKind, ParserDynamicKind, ParserDynamicToken,
        ParserShorthandAttribute, ScriptBlock, StructuralKind, StyleBlock,
    },
};

use super::Scanner;
use super::dynamic::contains_collision_scalar;
use super::lexical::identifier_continue_width;
use super::lexical::unsupported_at_construct;
use super::lexical::{is_identifier_continue, is_identifier_start, unicode_identifier_start};
use super::surrogates::OpaqueSurrogateContext;

/// What a shorthand attribute's `{` is missing when no identifier name follows it.
const SHORTHAND_ATTRIBUTE_NAME: &str = "a shorthand attribute's name or a spread `...`";
/// What a shorthand attribute's name is missing when anything but `}` follows it.
const SHORTHAND_ATTRIBUTE_CLOSE: &str = "`}` after a shorthand attribute's name";
/// What a `\u` escape in a shorthand attribute's name has to spell (`@tsrx/core`'s TS1127).
const IDENTIFIER_ESCAPE: &str = "a Unicode escape that spells an identifier character";
/// What follows a `\` in an identifier name (TS1127).
const IDENTIFIER_ESCAPE_U: &str = "`u` after `\\` in an identifier name";
/// What a `\u` escape holds (TS1125).
const IDENTIFIER_ESCAPE_HEX: &str = "hexadecimal digits in a Unicode escape";
/// The range an escaped code point lies in (TS1198).
const IDENTIFIER_ESCAPE_BOUNDS: &str = "a Unicode escape no greater than 0x10FFFF";

/// Whether an escaped character can start an identifier (`first`) or continue one, by the rule
/// the scanner reads a written one: an ASCII identifier byte, a Unicode identifier start
/// (`Other_ID_Start` included), or after the start any other scalar but whitespace, control
/// characters, and the symbol blocks no `ID_Continue` scalar is in, so combining marks continue
/// a name. OXC, which the name reaches as written, holds a continue scalar to `ID_Continue`
/// exactly; the refusals here only make core's usual escapes fail where core fails them.
fn escaped_identifier_character(character: char, first: bool) -> bool {
    if character.is_ascii() {
        let byte = character as u8;
        return is_identifier_start(byte) || (!first && is_identifier_continue(byte));
    }
    if unicode_identifier_start(character) {
        return true;
    }
    if first || character.is_whitespace() || character.is_control() {
        return false;
    }
    match u32::from(character) {
        // General punctuation to miscellaneous symbols and arrows: only these continue a name.
        0x2000..=0x2BFF => {
            character.is_alphanumeric()
                || matches!(u32::from(character), 0x200C | 0x200D | 0x203F | 0x2040 | 0x2054)
                || (0x20D0..=0x20F0).contains(&u32::from(character))
        }
        // Mahjong tiles to symbols and pictographs extended-A: emoji, never a name.
        0x1_F000..=0x1_FAFF => false,
        _ => true,
    }
}

impl Scanner<'_> {
    #[expect(
        clippy::too_many_lines,
        reason = "a byte-level scanner state machine whose arms only make sense read in source order"
    )]
    pub(super) fn scan_jsx_element(&mut self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let fragment = self.bytes.get(index) == Some(&b'>');
        let dynamic = self.bytes.get(index) == Some(&b'{');
        let name_start = index;
        let name_end;
        let mut dynamic_identity = ByteSpan::default();
        let mut dynamic_owner = None;
        let mut dynamic_embedded = false;
        if fragment {
            name_end = name_start;
            index += 1;
        } else if dynamic {
            let owner = to_u32(self.dynamic_tags.len())?;
            let initial_subtree_end =
                owner.checked_add(1).ok_or(ProjectionError::SourceTooLarge)?;
            let parser_nested = !self.parser_dynamic_parents.is_empty();
            let embedded_slot = if parser_nested {
                None
            } else {
                let slot = self.embedded_tokens.len();
                self.embedded_tokens.push(EmbeddedToken {
                    kind: EmbeddedKind::DynamicOpen,
                    span: ByteSpan::default(),
                    owner,
                });
                Some(slot)
            };
            self.dynamic_tags.push(DynamicTag {
                opening: ByteSpan::default(),
                closing: ByteSpan::default(),
                expression: ByteSpan::default(),
                closing_expression: ByteSpan::default(),
                subtree_end: initial_subtree_end,
                first_closing_comment: NONE,
                closing_comment_count: 0,
                self_closing: false,
            });
            self.parser_dynamic_tokens.push(ParserDynamicToken {
                kind: ParserDynamicKind::OpenStart,
                offset: to_u32(start)?,
                owner,
            });
            let nested_start = self.dynamic_tags.len();
            self.parser_dynamic_parents.push(owner);
            let result = self.scan_expression_region(index + 1, Some(b'}'));
            let nested_end = self.dynamic_tags.len();
            if self.parser_dynamic_parents.pop() != Some(owner) {
                return Err(ProjectionError::StructuralMismatch);
            }
            let end = result?;
            let expression = ByteSpan::new(to_u32(index + 1)?, to_u32(end - 1)?);
            let identity =
                self.validate_dynamic_expression(expression, nested_start, nested_end)?;
            let opening = ByteSpan::new(to_u32(start)?, to_u32(end)?);
            self.parser_dynamic_tokens.push(ParserDynamicToken {
                kind: ParserDynamicKind::OpenEnd,
                offset: expression.end,
                owner,
            });
            let tag = &mut self.dynamic_tags[owner as usize];
            tag.opening = opening;
            tag.expression = expression;
            if let Some(slot) = embedded_slot {
                self.embedded_tokens[slot].span = opening;
            }
            dynamic_identity = identity;
            name_end = name_start;
            index = end;
            dynamic_embedded = !parser_nested;
            dynamic_owner = Some(owner);
        } else {
            index = self.skip_jsx_name(index);
            name_end = index;
            if name_end == name_start {
                return Err(ProjectionError::UnsupportedSyntax {
                    offset: to_u32(start)?,
                    construct: "ambiguous `<` expression",
                });
            }
            // Type arguments, `<List<string> />`, go to OXC as written, which gives them to the
            // opening element as its `typeArguments`, as `@tsrx/core` does.
            if self.bytes.get(index) == Some(&b'<') {
                index =
                    self.type_list_end(index + 1).ok_or(ProjectionError::UnterminatedSyntax {
                        offset: to_u32(start)?,
                        construct: "JSX opening tag",
                    })?;
            }
        }

        // The tag as written, for `@tsrx/core`'s `Unclosed tag` message: the name, empty for a
        // fragment, or a dynamic tag's braced expression.
        let display_name =
            ByteSpan::new(to_u32(name_start)?, to_u32(if dynamic { index } else { name_end })?);
        let style = !fragment && !dynamic && self.bytes[name_start..name_end] == *b"style";
        let script = !fragment && !dynamic && self.bytes[name_start..name_end] == *b"script";
        // Parser owners are preorder identities. Reserve before scanning attributes because a JSX
        // expression attribute can itself contain another style element.
        let parser_style_owner = if style {
            let owner = to_u32(self.style_blocks.len())?;
            self.style_blocks.push(StyleBlock {
                element: ByteSpan::new(0, 0),
                content: ByteSpan::new(0, 0),
                self_closing: false,
            });
            Some(owner)
        } else {
            None
        };
        let mut self_closing = false;
        let mut expecting_attribute_value = false;
        if !fragment {
            loop {
                let Some(&byte) = self.bytes.get(index) else {
                    return Err(ProjectionError::UnterminatedSyntax {
                        offset: to_u32(start)?,
                        construct: "JSX opening tag",
                    });
                };
                match byte {
                    b'<' if expecting_attribute_value => {
                        index = self.scan_jsx_element(index)?;
                        expecting_attribute_value = false;
                    }
                    b'\'' | b'"' => {
                        index = self.skip_jsx_quote(index, byte)?;
                        expecting_attribute_value = false;
                    }
                    // In attribute position a `{` opens a spread, `{...props}`, or a shorthand
                    // attribute, `{name}`, which `@tsrx/core` reads as `name={name}` in every JSX.
                    b'{' if !expecting_attribute_value => {
                        let inner = self.skip_trivia(index + 1)?;
                        if self.bytes.get(inner..inner + 3) == Some(b"...") {
                            index = self.scan_expression_region(index + 1, Some(b'}'))?;
                        } else {
                            let (identifier, end) = self.shorthand_attribute_name(inner)?;
                            self.parser_shorthand_attributes.push(ParserShorthandAttribute {
                                span: ByteSpan::new(to_u32(index)?, to_u32(end)?),
                                identifier,
                            });
                            index = end;
                        }
                    }
                    b'{' => {
                        index = self.scan_expression_region(index + 1, Some(b'}'))?;
                        expecting_attribute_value = false;
                    }
                    b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                        index = self.skip_block_comment(index)?;
                    }
                    b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                        index = self.skip_line_comment(index + 2);
                    }
                    b'/' if self.bytes.get(index + 1) == Some(&b'>') => {
                        self_closing = true;
                        index += 2;
                        break;
                    }
                    b'>' => {
                        index += 1;
                        break;
                    }
                    _ if super::lexical::trivia_whitespace_len(self.bytes, index) != 0 => {
                        index += super::lexical::trivia_whitespace_len(self.bytes, index);
                    }
                    _ if self.identifier_start_width(index).is_some() => {
                        expecting_attribute_value = false;
                        index = self.skip_jsx_name(index);
                        while super::lexical::trivia_whitespace_len(self.bytes, index) != 0 {
                            index += super::lexical::trivia_whitespace_len(self.bytes, index);
                        }
                        if self.bytes.get(index) == Some(&b'=') {
                            index += 1;
                            expecting_attribute_value = true;
                        }
                    }
                    _ => {
                        return Err(ProjectionError::MalformedSyntax {
                            offset: to_u32(index)?,
                            expected: "a JSX attribute, `>`, or `/>`",
                        });
                    }
                }
            }
        }

        if let Some(owner) = dynamic_owner {
            self.dynamic_tags[owner as usize].self_closing = self_closing;
        }

        if self_closing {
            if let Some(owner) = dynamic_owner {
                let element_end = to_u32(index)?;
                let subtree_end = to_u32(self.dynamic_tags.len())?;
                let tag = &mut self.dynamic_tags[owner as usize];
                tag.closing = ByteSpan::new(element_end, element_end);
                tag.subtree_end = subtree_end;
            }
            if let Some(owner) = parser_style_owner {
                let element_end = to_u32(index)?;
                self.style_blocks[owner as usize] = StyleBlock {
                    element: ByteSpan::new(to_u32(start)?, element_end),
                    content: ByteSpan::new(element_end, element_end),
                    self_closing: true,
                };
            }
            return Ok(index);
        }

        // `<style>{expr}</style>` is ordinary JSX: the first non-whitespace child is `{`.
        let raw_style = style && !first_non_whitespace_is_open_brace(self.bytes, index);
        if style
            && !raw_style
            && let Some(owner) = parser_style_owner
        {
            self.abandon_reserved_style(owner)?;
        }

        if raw_style {
            let Some(relative_close) = find_bytes(&self.bytes[index..], b"</style>") else {
                return Err(ProjectionError::UnterminatedSyntax {
                    offset: to_u32(start)?,
                    construct: "inline `<style>` block",
                });
            };
            let close_start = index + relative_close;
            self.mark_surrogates(index, close_start, OpaqueSurrogateContext::RawStyle);
            let content = ByteSpan::new(to_u32(index)?, to_u32(close_start)?);
            let record = StyleBlock {
                element: ByteSpan::new(to_u32(start)?, to_u32(close_start + "</style>".len())?),
                content,
                self_closing: false,
            };
            let owner = parser_style_owner.ok_or(ProjectionError::StructuralMismatch)?;
            self.style_blocks[owner as usize] = record;
            self.embedded_tokens.push(EmbeddedToken {
                kind: EmbeddedKind::StyleContent,
                span: content,
                owner,
            });
            return Ok(close_start + "</style>".len());
        }

        if script {
            let Some((close_start, close_end)) = find_script_body_end(self.bytes, index) else {
                return Err(ProjectionError::UnterminatedSyntax {
                    offset: to_u32(start)?,
                    construct: "inline `<script>` block",
                });
            };
            self.mark_surrogates(index, close_start, OpaqueSurrogateContext::JsxText);
            let content = ByteSpan::new(to_u32(index)?, to_u32(close_start)?);
            let owner = to_u32(self.script_blocks.len())?;
            self.script_blocks.push(ScriptBlock {
                element: ByteSpan::new(to_u32(start)?, to_u32(close_end)?),
                content,
            });
            self.embedded_tokens.push(EmbeddedToken {
                kind: EmbeddedKind::ScriptContent,
                span: content,
                owner,
            });
            return Ok(close_end);
        }

        // The text run in progress began after the opening tag or the last child; a `//` that
        // starts it is a comment.
        let mut run_start = index;
        // A comment in this element's text may swallow its closing tag. `@tsrx/core` then ends the
        // element at the next `}` (which always ends it there), or at the end of the source.
        let mut has_comment = false;
        loop {
            let Some(&byte) = self.bytes.get(index) else {
                if has_comment {
                    return Err(self.unclosed_tag(index, display_name)?);
                }
                return Err(ProjectionError::UnterminatedSyntax {
                    offset: to_u32(start)?,
                    construct: "JSX element",
                });
            };
            match byte {
                b'<' if self.bytes.get(index + 1) == Some(&b'/') => {
                    let close_start = index;
                    index += 2;
                    let closing_dynamic = self.bytes.get(index) == Some(&b'{');
                    let (
                        closing_name_start,
                        closing_name_end,
                        closing_expression,
                        closing_identity,
                    ) = if closing_dynamic {
                        let (expression, end, identity) = if dynamic {
                            let owner = dynamic_owner.ok_or(ProjectionError::StructuralMismatch)?;
                            self.parser_dynamic_tokens.push(ParserDynamicToken {
                                kind: ParserDynamicKind::CloseStart,
                                offset: to_u32(close_start)?,
                                owner,
                            });
                            let nested_start = self.dynamic_tags.len();
                            self.parser_dynamic_parents.push(owner);
                            let result = self.scan_expression_region(index + 1, Some(b'}'));
                            let nested_end = self.dynamic_tags.len();
                            if self.parser_dynamic_parents.pop() != Some(owner) {
                                return Err(ProjectionError::StructuralMismatch);
                            }
                            let end = result?;
                            let expression = ByteSpan::new(to_u32(index + 1)?, to_u32(end - 1)?);
                            self.parser_dynamic_tokens.push(ParserDynamicToken {
                                kind: ParserDynamicKind::CloseEnd,
                                offset: expression.end,
                                owner,
                            });
                            let identity = self.validate_dynamic_expression(
                                expression,
                                nested_start,
                                nested_end,
                            )?;
                            (expression, end, identity)
                        } else {
                            let (expression, end) = self.scan_dynamic_expression(index)?;
                            let identity = self.validate_dynamic_expression(expression, 0, 0)?;
                            (expression, end, identity)
                        };
                        index = end;
                        (index, index, expression, identity)
                    } else {
                        let closing_name_start = index;
                        index = self.skip_jsx_name(index);
                        (closing_name_start, index, ByteSpan::default(), ByteSpan::default())
                    };
                    index = self.skip_jsx_tag_trivia(index)?;
                    if self.bytes.get(index) != Some(&b'>') {
                        return Err(ProjectionError::UnterminatedSyntax {
                            offset: to_u32(start)?,
                            construct: "JSX closing tag",
                        });
                    }
                    let opening_collision = if dynamic {
                        self.span_contains_collision_scalar(dynamic_identity)
                    } else {
                        contains_collision_scalar(&self.bytes[name_start..name_end])
                    };
                    let closing_collision = if closing_dynamic {
                        self.span_contains_collision_scalar(closing_expression)
                    } else {
                        contains_collision_scalar(&self.bytes[closing_name_start..closing_name_end])
                    };
                    if fragment {
                        if (closing_dynamic || closing_name_start != closing_name_end)
                            && !closing_collision
                        {
                            return Err(ProjectionError::MalformedSyntax {
                                offset: to_u32(close_start)?,
                                expected: "a fragment closing tag `</>`",
                            });
                        }
                    } else if dynamic {
                        let owner = dynamic_owner.ok_or(ProjectionError::StructuralMismatch)?;
                        if (!closing_dynamic
                            || !self.same_dynamic_identity(dynamic_identity, closing_identity))
                            && !opening_collision
                            && !closing_collision
                        {
                            return Err(ProjectionError::MalformedSyntax {
                                offset: to_u32(close_start)?,
                                expected: "a matching dynamic JSX closing tag",
                            });
                        }
                        let first_closing_comment = to_u32(self.dynamic_comments.len())?;
                        self.collect_dynamic_edge_comments(closing_expression, closing_identity)?;
                        let closing_comment_count = to_u32(self.dynamic_comments.len())?
                            .checked_sub(first_closing_comment)
                            .ok_or(ProjectionError::StructuralMismatch)?;
                        let tag = &mut self.dynamic_tags[owner as usize];
                        tag.closing = ByteSpan::new(to_u32(close_start)?, to_u32(index + 1)?);
                        tag.closing_expression = closing_expression;
                        tag.first_closing_comment = first_closing_comment;
                        tag.closing_comment_count = closing_comment_count;
                        if dynamic_embedded {
                            self.embedded_tokens.push(EmbeddedToken {
                                kind: EmbeddedKind::DynamicClose,
                                span: tag.closing,
                                owner,
                            });
                        }
                    } else if (closing_dynamic
                        || self.bytes[name_start..name_end]
                            != self.bytes[closing_name_start..closing_name_end])
                        && !opening_collision
                        && !closing_collision
                    {
                        return Err(ProjectionError::MalformedSyntax {
                            offset: to_u32(close_start)?,
                            expected: "a matching JSX closing tag",
                        });
                    }
                    if let Some(owner) = dynamic_owner {
                        self.dynamic_tags[owner as usize].subtree_end =
                            to_u32(self.dynamic_tags.len())?;
                    }
                    return Ok(index + 1);
                }
                b'<' if self.looks_like_jsx_start(index) => {
                    let implicit_closes = self.implicit_closes.len();
                    index = self.scan_jsx_element(index)?;
                    // A child a `}` closed early leaves this element open at the same `}`.
                    has_comment |= self.implicit_closes.len() > implicit_closes
                        && self.bytes.get(index) == Some(&b'}');
                    run_start = index;
                }
                b'{' => {
                    index = self.scan_expression_region(index + 1, Some(b'}'))?;
                    run_start = index;
                }
                b'@' if self.keyword_at(index, b"if") && self.control_has_header(index, b"if") => {
                    index = self.parse_if(index, ControlContext::JsxChild)?;
                    run_start = index;
                }
                b'@' if self.keyword_at(index, b"for")
                    && self.control_has_header(index, b"for") =>
                {
                    index = self.parse_for(index, ControlContext::JsxChild)?;
                    run_start = index;
                }
                b'@' if self.keyword_at(index, b"switch")
                    && self.control_has_header(index, b"switch") =>
                {
                    index = self.parse_switch(index, ControlContext::JsxChild)?;
                    run_start = index;
                }
                b'@' if self.keyword_at(index, b"try") && self.control_has_body(index, b"try") => {
                    index = self.parse_try(index, ControlContext::JsxChild)?;
                    run_start = index;
                }
                b'@' if self.bytes.get(index + 1) == Some(&b'{') => {
                    index = self.scan_parser_code_block(index, ParserCodeBlockKind::JsxChild)?;
                    run_start = index;
                }
                // A branch keyword no control owns here, `@else` or `@catch` in `<code>@else</code>`
                // or `me@else.com`, is text to `@tsrx/core`, as any other `@` in JSX text is.
                b'@' => {
                    if jsx_text_looks_structural(self.bytes, index)
                        && let Some(construct) = unsupported_at_construct(self.bytes, index)
                    {
                        return Err(ProjectionError::UnsupportedSyntax {
                            offset: to_u32(index)?,
                            construct,
                        });
                    }
                    index += 1;
                }
                // `@tsrx/core` 0.5 reads JavaScript comments in JSX text as comments, before it
                // looks for tags or braces, so a comment can hold a `<`, `{`, `}`, or a whole tag.
                // With no `*/`, a block comment runs to the end of the source.
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    let body_end = find_bytes(&self.bytes[index + 2..], b"*/")
                        .map_or(self.bytes.len(), |relative| index + 2 + relative);
                    let end = (body_end + 2).min(self.bytes.len());
                    self.mark_surrogates(index + 2, body_end, OpaqueSurrogateContext::Comment);
                    self.jsx_text_comments.push(ByteSpan::new(to_u32(index)?, to_u32(end)?));
                    has_comment = true;
                    index = end;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'/')
                    && (index == run_start
                        || matches!(self.bytes[index - 1], b' ' | b'\t' | b'\n' | b'\r')) =>
                {
                    let end = self.skip_line_comment(index + 2);
                    self.jsx_text_comments.push(ByteSpan::new(to_u32(index)?, to_u32(end)?));
                    has_comment = true;
                    index = end;
                }
                b'}' if has_comment => {
                    if dynamic {
                        // No projection can restore a dynamic closing tag it never saw.
                        return Err(self.unclosed_tag(index, display_name)?);
                    }
                    self.implicit_closes
                        .push(ImplicitClose { offset: to_u32(index)?, name: display_name });
                    return Ok(index);
                }
                // `@tsrx/core` reads a `>` in JSX text as text, where TSX rejects it.
                b'>' => {
                    self.jsx_text_gts.push(to_u32(index)?);
                    index += 1;
                }
                _ => {
                    self.mark_surrogates(index, index + 1, OpaqueSurrogateContext::JsxText);
                    index += 1;
                }
            }
        }
    }

    fn unclosed_tag(
        &self,
        offset: usize,
        display_name: ByteSpan,
    ) -> Result<ProjectionError, ProjectionError> {
        let name = std::str::from_utf8(
            &self.bytes[display_name.start as usize..display_name.end as usize],
        )
        .map_err(|_| ProjectionError::SourceChanged { offset: display_name.start })?;
        Ok(ProjectionError::UnclosedTag { offset: to_u32(offset)?, name: name.to_owned() })
    }

    fn skip_jsx_tag_trivia(&self, mut index: usize) -> Result<usize, ProjectionError> {
        loop {
            while super::lexical::trivia_whitespace_len(self.bytes, index) != 0 {
                index += super::lexical::trivia_whitespace_len(self.bytes, index);
            }
            if self.bytes.get(index..index + 2) == Some(b"/*") {
                index = self.skip_block_comment(index)?;
            } else if self.bytes.get(index..index + 2) == Some(b"//") {
                index = self.skip_line_comment(index + 2);
            } else {
                return Ok(index);
            }
        }
    }

    pub(super) fn scan_parser_code_block(
        &mut self,
        start: usize,
        kind: ParserCodeBlockKind,
    ) -> Result<usize, ProjectionError> {
        let token = to_u32(self.tokens.len())?;
        self.push_token(StructuralKind::FunctionBody, start)?;
        let manifest = self.parser_code_blocks.len();
        let body_start = to_u32(start + 1)?;
        self.parser_code_blocks.push(ParserCodeBlock {
            token,
            body: ByteSpan::new(body_start, body_start),
            kind,
        });
        let end = self.scan_region(start + 2, Some(b'}'))?;
        self.parser_code_blocks[manifest].body.end = to_u32(end)?;
        Ok(end)
    }

    /// Octane starts a new statement when a line begins with a committed markup opening, even
    /// though the previous line left its statement unterminated. This is a TSRX boundary rather
    /// than JavaScript ASI — `<` can continue a JavaScript expression — so it is narrowed to the
    /// openings `committed_jsx_opening` already recognises as markup, and the caller keeps
    /// excluding the TypeScript type-parameter forms.
    pub(super) fn line_leading_markup_starts_a_statement(&self, index: usize) -> bool {
        self.at_line_start(index) && self.committed_jsx_opening(index)
    }

    /// True when only non-terminator whitespace separates `index` from the preceding line
    /// terminator. A comment before the cursor on the same line is not whitespace, so it keeps the
    /// cursor inside the line it was written on.
    pub(super) fn at_line_start(&self, index: usize) -> bool {
        let mut cursor = index;
        while cursor > 0 {
            if cursor >= 3 && super::lexical::line_terminator_len(self.bytes, cursor - 3) == 3 {
                return true;
            }
            match self.bytes[cursor - 1] {
                b'\n' | b'\r' => return true,
                byte if byte.is_ascii_whitespace() => cursor -= 1,
                _ => return false,
            }
        }
        false
    }

    pub(super) fn committed_jsx_opening(&self, start: usize) -> bool {
        if self.bytes.get(start + 1) == Some(&b'{') {
            return true;
        }
        if self.bytes.get(start + 1) == Some(&b'>') {
            return true;
        }
        let mut index = start + 1;
        if self.identifier_start_width(index).is_none() {
            return false;
        }
        index = self.skip_jsx_name(index);
        // A tag's type arguments, `<List<string> />`, sit between its name and what commits it.
        if self.bytes.get(index) == Some(&b'<') {
            let Some(end) = self.type_list_end(index + 1) else {
                return false;
            };
            index = end;
        }
        self.bytes.get(index).is_some_and(|byte| {
            super::lexical::trivia_whitespace_len(self.bytes, index) != 0
                || *byte == b'>'
                || (*byte == b'/' && self.bytes.get(index + 1) == Some(&b'*'))
                || (*byte == b'/' && self.bytes.get(index + 1) == Some(&b'>'))
        })
    }

    fn abandon_reserved_style(&mut self, owner: u32) -> Result<(), ProjectionError> {
        let index = usize::try_from(owner).map_err(|_| ProjectionError::StructuralMismatch)?;
        if index >= self.style_blocks.len() {
            return Err(ProjectionError::StructuralMismatch);
        }
        self.style_blocks.remove(index);
        for token in &mut self.embedded_tokens {
            if token.kind == EmbeddedKind::StyleContent && token.owner > owner {
                token.owner =
                    token.owner.checked_sub(1).ok_or(ProjectionError::StructuralMismatch)?;
            }
        }
        Ok(())
    }

    /// Reads a shorthand attribute's name at `start`, past the trivia after its `{`, and the trivia
    /// up to its `}`. Returns the name's span and the offset after the `}`.
    ///
    /// `@tsrx/core` takes any identifier name, a reserved word or one with `\u` escapes included,
    /// except `enum`, `interface`, and `type`, escaped or not. Anything else is its `Unexpected
    /// token` (TS1012) at the name, an escape that is no identifier character its `Invalid Unicode
    /// escape` (TS1127), and a name followed by anything but trivia and `}` its `'}' expected`
    /// (TS1005) where the `}` should be. An escaped keyword, `{\u0063lass}`, goes to OXC as written,
    /// which rejects it at the name as core does.
    fn shorthand_attribute_name(&self, start: usize) -> Result<(ByteSpan, usize), ProjectionError> {
        let (end, name) = self.read_identifier_name(start)?;
        if end == start || matches!(name.as_str(), "enum" | "interface" | "type") {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(start)?,
                expected: SHORTHAND_ATTRIBUTE_NAME,
            });
        }
        let close = self.skip_trivia(end)?;
        if self.bytes.get(close) != Some(&b'}') {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(close)?,
                expected: SHORTHAND_ATTRIBUTE_CLOSE,
            });
        }
        Ok((ByteSpan::new(to_u32(start)?, to_u32(end)?), close + 1))
    }

    /// Reads an identifier name at `start`, decoding any `\u` escapes in it. Returns where it ends
    /// and the name it spells, or fails at an escape that spells no identifier character there.
    fn read_identifier_name(&self, start: usize) -> Result<(usize, String), ProjectionError> {
        let mut index = start;
        let mut name = String::new();
        loop {
            let first = index == start;
            let width = if first {
                self.identifier_start_width(index)
            } else {
                self.identifier_continue_width(index)
            };
            if let Some(width) = width {
                let offset = to_u32(index)?;
                name.push_str(
                    std::str::from_utf8(&self.bytes[index..index + width])
                        .map_err(|_| ProjectionError::SourceChanged { offset })?,
                );
                index += width;
                continue;
            }
            if self.bytes.get(index) != Some(&b'\\') {
                return Ok((index, name));
            }
            let malformed = |offset: usize, expected: &'static str| {
                to_u32(offset).map(|offset| ProjectionError::MalformedSyntax { offset, expected })
            };
            if self.bytes.get(index + 1) != Some(&b'u') {
                return Err(malformed(index + 1, IDENTIFIER_ESCAPE_U)?);
            }
            let digits = index + 2;
            let (value, end) = if self.bytes.get(digits) == Some(&b'{') {
                let hex_start = digits + 1;
                let length = self.bytes[hex_start..]
                    .iter()
                    .position(|byte| !byte.is_ascii_hexdigit())
                    .unwrap_or(self.bytes.len() - hex_start);
                if length == 0 || self.bytes.get(hex_start + length) != Some(&b'}') {
                    return Err(malformed(hex_start, IDENTIFIER_ESCAPE_HEX)?);
                }
                let value = std::str::from_utf8(&self.bytes[hex_start..hex_start + length])
                    .ok()
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .filter(|value| *value <= 0x0010_FFFF);
                let Some(value) = value else {
                    return Err(malformed(hex_start, IDENTIFIER_ESCAPE_BOUNDS)?);
                };
                (value, hex_start + length + 1)
            } else {
                let value = self
                    .bytes
                    .get(digits..digits + 4)
                    .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))
                    .and_then(|hex| std::str::from_utf8(hex).ok())
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok());
                let Some(value) = value else {
                    return Err(malformed(digits, IDENTIFIER_ESCAPE_HEX)?);
                };
                (value, digits + 4)
            };
            let character = char::from_u32(value)
                .filter(|character| escaped_identifier_character(*character, first))
                .ok_or(malformed(index, IDENTIFIER_ESCAPE)?)?;
            name.push(character);
            index = end;
        }
    }

    fn skip_jsx_name(&self, mut index: usize) -> usize {
        loop {
            if super::lexical::trivia_whitespace_len(self.bytes, index) != 0 {
                return index;
            }
            if let Some(width) = self.identifier_continue_width(index) {
                index += width;
            } else if self.bytes.get(index).is_some_and(|byte| matches!(byte, b'.' | b':' | b'-')) {
                index += 1;
            } else {
                return index;
            }
        }
    }

    pub(super) fn looks_like_jsx_start(&self, index: usize) -> bool {
        self.identifier_start_width(index + 1).is_some()
            || self.bytes.get(index + 1).is_some_and(|byte| matches!(byte, b'>' | b'{'))
    }
}

fn first_non_whitespace_is_open_brace(bytes: &[u8], start: usize) -> bool {
    let mut index = start;
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    bytes.get(index) == Some(&b'{')
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// Finds where a raw `<script>` body ends, as HTML ends it: at the first `</script` written in
/// lowercase and followed by optional HTML whitespace (tab, LF, FF, CR, space) and `>`. Returns the
/// closing tag's `[start, end)`, which includes that whitespace. Any other `</script` in the body
/// (another letter case, `</scripts>`, `</script/>`) stays body text; the compat facade reports
/// it as `@tsrx/core` does.
fn find_script_body_end(bytes: &[u8], content_start: usize) -> Option<(usize, usize)> {
    const OPEN: &[u8] = b"</script";
    let mut cursor = content_start;
    while let Some(relative) = find_bytes(bytes.get(cursor..)?, OPEN) {
        let close_start = cursor + relative;
        let mut index = close_start + OPEN.len();
        while bytes.get(index).copied().is_some_and(is_html_whitespace) {
            index += 1;
        }
        if bytes.get(index) == Some(&b'>') {
            return Some((close_start, index + 1));
        }
        cursor = close_start + OPEN.len();
    }
    None
}

/// HTML's whitespace: tab, line feed, form feed, carriage return, and space.
const fn is_html_whitespace(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | 0x0c | b'\r' | b' ')
}

fn jsx_text_looks_structural(bytes: &[u8], index: usize) -> bool {
    [b"if".as_slice(), b"for", b"switch", b"try"].iter().any(|keyword| {
        let end = index + 1 + keyword.len();
        if bytes.get(index + 1..end) != Some(*keyword)
            || identifier_continue_width(bytes, end).is_some()
        {
            return false;
        }
        bytes[end..].iter().find(|byte| !byte.is_ascii_whitespace()).copied() == Some(b'(')
            || (*keyword == b"try"
                && bytes[end..].iter().find(|byte| !byte.is_ascii_whitespace()).copied()
                    == Some(b'{'))
    })
}

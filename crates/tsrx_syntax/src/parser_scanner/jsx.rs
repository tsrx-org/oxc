//! JSX elements, and the commitment rule that decides when a `<` genuinely opens one.

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, ControlContext, DynamicTag, EmbeddedKind, EmbeddedToken, NONE, ParserCodeBlock,
        ParserCodeBlockKind, ParserDynamicKind, ParserDynamicToken, ParserShorthandAttribute,
        ScriptBlock, StructuralKind, StyleBlock,
    },
};

use super::Scanner;
use super::dynamic::contains_collision_scalar;
use super::lexical::identifier_continue_width;
use super::lexical::unsupported_at_construct;
use super::surrogates::OpaqueSurrogateContext;

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
        }

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
                    b'{' => {
                        let shorthand_start = index;
                        index = self.scan_expression_region(index + 1, Some(b'}'))?;
                        if !expecting_attribute_value
                            && let Some(identifier) =
                                self.jsx_shorthand_identifier(shorthand_start, index)
                        {
                            self.parser_shorthand_attributes.push(ParserShorthandAttribute {
                                span: ByteSpan::new(to_u32(shorthand_start)?, to_u32(index)?),
                                identifier,
                            });
                        }
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
                    byte if byte.is_ascii_whitespace() => index += 1,
                    _ if self.identifier_start_width(index).is_some() => {
                        expecting_attribute_value = false;
                        index = self.skip_jsx_name(index);
                        while self.bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                            index += 1;
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

        if style {
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
            let Some(relative_close) = find_bytes(&self.bytes[index..], b"</script>") else {
                return Err(ProjectionError::UnterminatedSyntax {
                    offset: to_u32(start)?,
                    construct: "inline `<script>` block",
                });
            };
            let close_start = index + relative_close;
            self.mark_surrogates(index, close_start, OpaqueSurrogateContext::JsxText);
            let content = ByteSpan::new(to_u32(index)?, to_u32(close_start)?);
            let owner = to_u32(self.script_blocks.len())?;
            self.script_blocks.push(ScriptBlock {
                element: ByteSpan::new(to_u32(start)?, to_u32(close_start + "</script>".len())?),
                content,
            });
            self.embedded_tokens.push(EmbeddedToken {
                kind: EmbeddedKind::ScriptContent,
                span: content,
                owner,
            });
            return Ok(close_start + "</script>".len());
        }

        loop {
            let Some(&byte) = self.bytes.get(index) else {
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
                    index = self.scan_jsx_element(index)?;
                }
                b'{' => index = self.scan_expression_region(index + 1, Some(b'}'))?,
                b'@' if self.keyword_at(index, b"if") && self.control_has_header(index, b"if") => {
                    index = self.parse_if(index, ControlContext::JsxChild)?;
                }
                b'@' if self.keyword_at(index, b"for")
                    && self.control_has_header(index, b"for") =>
                {
                    index = self.parse_for(index, ControlContext::JsxChild)?;
                }
                b'@' if self.keyword_at(index, b"switch")
                    && self.control_has_header(index, b"switch") =>
                {
                    index = self.parse_switch(index, ControlContext::JsxChild)?;
                }
                b'@' if self.keyword_at(index, b"try") && self.control_has_body(index, b"try") => {
                    index = self.parse_try(index, ControlContext::JsxChild)?;
                }
                b'@' if self.bytes.get(index + 1) == Some(&b'{') => {
                    index = self.scan_parser_code_block(index, ParserCodeBlockKind::JsxChild)?;
                }
                b'@' => {
                    if self.keyword_at(index, b"else")
                        || self.keyword_at(index, b"empty")
                        || self.keyword_at(index, b"case")
                        || self.keyword_at(index, b"default")
                        || self.keyword_at(index, b"pending")
                        || self.keyword_at(index, b"catch")
                    {
                        return Err(ProjectionError::MalformedSyntax {
                            offset: to_u32(index)?,
                            expected: "an owning TSRX control",
                        });
                    }
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
                _ => {
                    self.mark_surrogates(index, index + 1, OpaqueSurrogateContext::JsxText);
                    index += 1;
                }
            }
        }
    }

    fn skip_jsx_tag_trivia(&self, mut index: usize) -> Result<usize, ProjectionError> {
        loop {
            while self.bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                index += 1;
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
        self.bytes.get(index).is_some_and(|byte| {
            byte.is_ascii_whitespace()
                || *byte == b'>'
                || (*byte == b'/' && self.bytes.get(index + 1) == Some(&b'*'))
                || (*byte == b'/' && self.bytes.get(index + 1) == Some(&b'>'))
        })
    }

    fn jsx_shorthand_identifier(&self, start: usize, end: usize) -> Option<ByteSpan> {
        let identifier_start = start.checked_add(1)?;
        let identifier_end = end.checked_sub(1)?;
        if self.bytes.get(start) != Some(&b'{')
            || self.bytes.get(identifier_end) != Some(&b'}')
            || self.identifier_start_width(identifier_start).is_none()
            || self.skip_identifier(identifier_start) != identifier_end
        {
            return None;
        }
        Some(ByteSpan::new(
            u32::try_from(identifier_start).ok()?,
            u32::try_from(identifier_end).ok()?,
        ))
    }

    fn skip_jsx_name(&self, mut index: usize) -> usize {
        loop {
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

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|window| window == needle)
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

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, ControlContext, DynamicTag, EmbeddedKind, EmbeddedToken, NONE, StructuralKind,
        StyleBlock,
    },
};

use super::{
    Scanner,
    lexical::{find_bytes, jsx_text_looks_structural, unsupported_at_construct},
};

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
        if fragment {
            name_end = name_start;
            index += 1;
        } else if dynamic {
            let (expression, end) = self.scan_dynamic_expression(index)?;
            let identity = self.validate_dynamic_expression(expression)?;
            dynamic_identity = identity;
            name_end = name_start;
            index = end;
            let owner = to_u32(self.dynamic_tags.len())?;
            self.dynamic_tags.push(DynamicTag {
                opening: ByteSpan::new(to_u32(start)?, to_u32(end)?),
                closing: ByteSpan::default(),
                expression,
                closing_expression: ByteSpan::default(),
                subtree_end: owner.checked_add(1).ok_or(ProjectionError::SourceTooLarge)?,
                first_closing_comment: NONE,
                closing_comment_count: 0,
                self_closing: false,
            });
            self.embedded_tokens.push(EmbeddedToken {
                kind: EmbeddedKind::DynamicOpen,
                span: ByteSpan::new(to_u32(start)?, to_u32(end)?),
                owner,
            });
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
                        index = self.scan_region(index + 1, Some(b'}'))?;
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
            if self_closing {
                let end = to_u32(index)?;
                self.dynamic_tags[owner as usize].closing = ByteSpan::new(end, end);
            }
        }

        if self_closing {
            return Ok(index);
        }

        // `<style>{expr}</style>` is ordinary JSX: the first non-whitespace child is `{`.
        if style && !first_non_whitespace_is_open_brace(self.bytes, index) {
            let Some(relative_close) = find_bytes(&self.bytes[index..], b"</style>") else {
                return Err(ProjectionError::UnterminatedSyntax {
                    offset: to_u32(start)?,
                    construct: "inline `<style>` block",
                });
            };
            let close_start = index + relative_close;
            let owner = to_u32(self.style_blocks.len())?;
            let content = ByteSpan::new(to_u32(index)?, to_u32(close_start)?);
            self.style_blocks.push(StyleBlock {
                element: ByteSpan::new(to_u32(start)?, to_u32(close_start + "</style>".len())?),
                content,
                self_closing: false,
            });
            self.embedded_tokens.push(EmbeddedToken {
                kind: EmbeddedKind::StyleContent,
                span: content,
                owner,
            });
            return Ok(close_start + "</style>".len());
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
                        let (expression, end) = self.scan_dynamic_expression(index)?;
                        let identity = self.validate_dynamic_expression(expression)?;
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
                    if fragment {
                        if closing_dynamic || closing_name_start != closing_name_end {
                            return Err(ProjectionError::MalformedSyntax {
                                offset: to_u32(close_start)?,
                                expected: "a fragment closing tag `</>`",
                            });
                        }
                    } else if dynamic {
                        let owner = dynamic_owner.ok_or(ProjectionError::StructuralMismatch)?;
                        if !closing_dynamic
                            || !self.same_dynamic_identity(dynamic_identity, closing_identity)
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
                        self.embedded_tokens.push(EmbeddedToken {
                            kind: EmbeddedKind::DynamicClose,
                            span: ByteSpan::new(to_u32(close_start)?, to_u32(index + 1)?),
                            owner,
                        });
                    } else if closing_dynamic
                        || self.bytes[name_start..name_end]
                            != self.bytes[closing_name_start..closing_name_end]
                    {
                        return Err(ProjectionError::MalformedSyntax {
                            offset: to_u32(close_start)?,
                            expected: "a matching JSX closing tag",
                        });
                    }
                    return Ok(index + 1);
                }
                b'<' if self.looks_like_jsx_start(index) => {
                    index = self.scan_jsx_element(index)?;
                }
                b'{' => index = self.scan_region(index + 1, Some(b'}'))?,
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
                    self.push_token(StructuralKind::FunctionBody, index)?;
                    index += 1;
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
                _ => index += 1,
            }
        }
    }

    fn scan_dynamic_expression(&self, open: usize) -> Result<(ByteSpan, usize), ProjectionError> {
        if self.bytes.get(open) != Some(&b'{') {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(open)?,
                expected: "a dynamic JSX tag expression",
            });
        }
        let mut index = open + 1;
        let mut braces = 1usize;
        let mut can_start_expression = true;
        while index < self.bytes.len() {
            match self.bytes[index] {
                b'\'' | b'"' => {
                    index = self.skip_quote(index, self.bytes[index])?;
                    can_start_expression = false;
                }
                b'`' => {
                    index = self.skip_template_raw(index, self.bytes.len())?;
                    can_start_expression = false;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                    index = self.skip_line_comment(index + 2);
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    index = self.skip_block_comment(index)?;
                }
                b'/' if can_start_expression => {
                    index = self.skip_regex(index)?;
                    can_start_expression = false;
                }
                b'{' => {
                    braces += 1;
                    index += 1;
                    can_start_expression = true;
                }
                b'}' => {
                    braces -= 1;
                    if braces == 0 {
                        return Ok((ByteSpan::new(to_u32(open + 1)?, to_u32(index)?), index + 1));
                    }
                    index += 1;
                    can_start_expression = false;
                }
                _ if self.identifier_start_width(index).is_some() => {
                    index = self.skip_identifier(index);
                    can_start_expression = false;
                }
                byte if byte.is_ascii_digit() => {
                    index = self.skip_number(index);
                    can_start_expression = false;
                }
                b')' | b']' => {
                    index += 1;
                    can_start_expression = false;
                }
                b'.' if self.bytes.get(index + 1) != Some(&b'.') => {
                    index += 1;
                    can_start_expression = false;
                }
                _ => {
                    index += 1;
                    can_start_expression = true;
                }
            }
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(open)?,
            construct: "dynamic JSX tag expression",
        })
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

    fn validate_dynamic_expression(&self, span: ByteSpan) -> Result<ByteSpan, ProjectionError> {
        let identity = self.dynamic_identity_range(span)?;
        if identity.is_empty() {
            return Err(ProjectionError::MalformedSyntax {
                offset: span.start,
                expected: "a valid dynamic JSX tag expression",
            });
        }
        Ok(identity)
    }

    fn same_dynamic_identity(&self, opening: ByteSpan, closing: ByteSpan) -> bool {
        self.bytes[opening.start as usize..opening.end as usize]
            == self.bytes[closing.start as usize..closing.end as usize]
    }

    fn dynamic_identity_range(&self, span: ByteSpan) -> Result<ByteSpan, ProjectionError> {
        let mut index = span.start as usize;
        let end = span.end as usize;
        let mut can_start_expression = true;
        let mut first_start = None;
        let mut last_end = span.start as usize;
        let mut previous_end = span.start as usize;
        let mut in_leading_prefix = true;
        let mut leading_unclosed = 0usize;
        let mut other_depth = 0usize;
        let mut trailing_outer_closures = 0usize;
        let mut trailing_inner_end = span.start as usize;
        while let Some((token_start, token_end)) =
            self.next_dynamic_identity_token(&mut index, end, &mut can_start_expression)?
        {
            first_start.get_or_insert(token_start);
            let byte = self.bytes[token_start];
            let leading_open = in_leading_prefix && byte == b'(';
            if leading_open {
                leading_unclosed += 1;
                trailing_outer_closures = 0;
            } else {
                in_leading_prefix = false;
                let closes_leading = if byte == b'(' {
                    other_depth += 1;
                    false
                } else if byte == b')' && other_depth > 0 {
                    other_depth -= 1;
                    false
                } else if byte == b')' && leading_unclosed > 0 {
                    leading_unclosed -= 1;
                    true
                } else {
                    false
                };
                if closes_leading {
                    if trailing_outer_closures == 0 {
                        trailing_inner_end = previous_end;
                    }
                    trailing_outer_closures += 1;
                } else {
                    trailing_outer_closures = 0;
                }
            }
            previous_end = token_end;
            last_end = token_end;
        }
        let Some(first_start) = first_start else {
            return Ok(ByteSpan::new(span.start, span.start));
        };
        if trailing_outer_closures == 0 {
            return Ok(ByteSpan::new(to_u32(first_start)?, to_u32(last_end)?));
        }

        let mut normalized_start = first_start;
        let mut prefix_index = span.start as usize;
        let mut prefix_can_start_expression = true;
        for _ in 0..trailing_outer_closures {
            let Some((token_start, _)) = self.next_dynamic_identity_token(
                &mut prefix_index,
                end,
                &mut prefix_can_start_expression,
            )?
            else {
                return Err(ProjectionError::StructuralMismatch);
            };
            if self.bytes[token_start] != b'(' {
                return Err(ProjectionError::StructuralMismatch);
            }
        }
        if let Some((token_start, _)) = self.next_dynamic_identity_token(
            &mut prefix_index,
            end,
            &mut prefix_can_start_expression,
        )? {
            normalized_start = token_start;
        }
        if normalized_start > trailing_inner_end {
            normalized_start = trailing_inner_end;
        }
        Ok(ByteSpan::new(to_u32(normalized_start)?, to_u32(trailing_inner_end)?))
    }

    fn next_dynamic_identity_token(
        &self,
        index: &mut usize,
        end: usize,
        can_start_expression: &mut bool,
    ) -> Result<Option<(usize, usize)>, ProjectionError> {
        while *index < end {
            if self.bytes[*index].is_ascii_whitespace() {
                *index += 1;
                continue;
            }
            if self.bytes.get(*index..*index + 2) == Some(b"//") {
                *index = self.skip_line_comment(*index + 2).min(end);
                continue;
            }
            if self.bytes.get(*index..*index + 2) == Some(b"/*") {
                *index = self.skip_block_comment(*index)?.min(end);
                continue;
            }
            let token_start = *index;
            match self.bytes[*index] {
                b'\'' | b'"' => {
                    *index = self.skip_quote(*index, self.bytes[*index])?.min(end);
                    *can_start_expression = false;
                }
                b'`' => {
                    *index = self.skip_template_raw(*index, end)?;
                    *can_start_expression = false;
                }
                b'/' if *can_start_expression => {
                    *index = self.skip_regex(*index)?.min(end);
                    *can_start_expression = false;
                }
                b'(' => {
                    *index += 1;
                    *can_start_expression = true;
                }
                b')' => {
                    *index += 1;
                    *can_start_expression = false;
                }
                _ if self.identifier_start_width(*index).is_some() => {
                    *index = self.skip_identifier(*index);
                    *can_start_expression = matches!(
                        &self.bytes[token_start..*index],
                        b"return"
                            | b"throw"
                            | b"case"
                            | b"delete"
                            | b"void"
                            | b"typeof"
                            | b"new"
                            | b"yield"
                            | b"await"
                            | b"in"
                            | b"of"
                            | b"instanceof"
                    );
                }
                byte if byte.is_ascii_digit() => {
                    *index = self.skip_number(*index);
                    *can_start_expression = false;
                }
                b']' | b'}' | b'.' => {
                    *index += 1;
                    *can_start_expression = false;
                }
                _ => {
                    *index += 1;
                    *can_start_expression = true;
                }
            }
            return Ok(Some((token_start, *index)));
        }
        Ok(None)
    }

    fn collect_dynamic_edge_comments(
        &mut self,
        expression: ByteSpan,
        identity: ByteSpan,
    ) -> Result<(), ProjectionError> {
        if identity.start < expression.start || identity.end > expression.end {
            return Err(ProjectionError::StructuralMismatch);
        }
        self.collect_dynamic_comments_in(expression.start as usize, identity.start as usize)?;
        self.collect_dynamic_comments_in(identity.end as usize, expression.end as usize)
    }

    fn collect_dynamic_comments_in(
        &mut self,
        mut index: usize,
        end: usize,
    ) -> Result<(), ProjectionError> {
        while index < end {
            if self.bytes.get(index..index + 2) == Some(b"//") {
                let comment_end = self.skip_line_comment(index + 2).min(end);
                self.dynamic_comments.push(ByteSpan::new(to_u32(index)?, to_u32(comment_end)?));
                index = comment_end;
            } else if self.bytes.get(index..index + 2) == Some(b"/*") {
                let comment_end = self.skip_block_comment(index)?;
                if comment_end > end {
                    return Err(ProjectionError::StructuralMismatch);
                }
                self.dynamic_comments.push(ByteSpan::new(to_u32(index)?, to_u32(comment_end)?));
                index = comment_end;
            } else {
                index += 1;
            }
        }
        Ok(())
    }
}

fn first_non_whitespace_is_open_brace(bytes: &[u8], start: usize) -> bool {
    let mut index = start;
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    bytes.get(index) == Some(&b'{')
}

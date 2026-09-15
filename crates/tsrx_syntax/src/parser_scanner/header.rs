//! Splitting a control header into clauses, which is where the authored grammar is really
//! decided: the `for` form, the `case` label, the optional catch binding.

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{ByteSpan, ClauseRole, ForHeader},
};

use super::Scanner;
use super::lexical::trim_ascii_end;
use super::stack::TinyStack;

impl Scanner<'_> {
    pub(super) fn parse_parenthesized(
        &mut self,
        start: usize,
    ) -> Result<(ByteSpan, usize), ProjectionError> {
        if self.bytes.get(start) != Some(&b'(') {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(start)?,
                expected: "`(`",
            });
        }
        let end = self.scan_region(start + 1, Some(b')'))?;
        Ok((ByteSpan::new(to_u32(start)?, to_u32(end)?), end))
    }

    pub(super) fn parse_body(
        &mut self,
        node: u32,
        start: usize,
    ) -> Result<ByteSpan, ProjectionError> {
        if self.bytes.get(start) != Some(&b'{') {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(start)?,
                expected: "a braced control-flow body",
            });
        }
        debug_assert_eq!(self.parents.last().copied(), Some(node));
        let end = self.scan_region(start + 1, Some(b'}'))?;
        Ok(ByteSpan::new(to_u32(start)?, to_u32(end)?))
    }

    pub(super) fn parse_case_header(
        &self,
        start: usize,
    ) -> Result<(ByteSpan, usize), ProjectionError> {
        let mut index = start;
        let mut delimiters = TinyStack::<u8, 16>::new();
        let mut can_start_expression = true;
        let mut ternaries = 0usize;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            match byte {
                b'\'' | b'"' => {
                    index = self.skip_quote(index, byte)?;
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
                b'(' | b'[' | b'{' => {
                    delimiters.push(match byte {
                        b'(' => b')',
                        b'[' => b']',
                        _ => b'}',
                    });
                    index += 1;
                    can_start_expression = true;
                }
                b')' | b']' | b'}' => {
                    if delimiters.last() == Some(byte) {
                        delimiters.pop();
                        index += 1;
                        can_start_expression = false;
                    } else {
                        break;
                    }
                }
                b'?' if delimiters.is_empty()
                    && self.bytes.get(index + 1) != Some(&b'.')
                    && self.bytes.get(index + 1) != Some(&b'?') =>
                {
                    ternaries = ternaries.saturating_add(1);
                    index += 1;
                    can_start_expression = true;
                }
                b':' if delimiters.is_empty() && ternaries > 0 => {
                    ternaries -= 1;
                    index += 1;
                    can_start_expression = true;
                }
                b':' if delimiters.is_empty() => {
                    let end = trim_ascii_end(self.bytes, start, index);
                    if end == start {
                        return Err(ProjectionError::MalformedSyntax {
                            offset: to_u32(start)?,
                            expected: "a case expression before `:`",
                        });
                    }
                    return Ok((ByteSpan::new(to_u32(start)?, to_u32(end)?), index));
                }
                _ if self.identifier_start_width(index).is_some() => {
                    index = self.skip_identifier(index);
                    can_start_expression = false;
                }
                byte if byte.is_ascii_whitespace() => index += 1,
                _ => {
                    can_start_expression = matches!(
                        byte,
                        b'=' | b',' | b':' | b'?' | b'!' | b'+' | b'-' | b'*' | b'%' | b'&' | b'|'
                    );
                    index += 1;
                }
            }
        }
        Err(ProjectionError::MalformedSyntax {
            offset: to_u32(index.min(self.bytes.len()))?,
            expected: "`:` after an `@case` expression",
        })
    }

    pub(super) fn catch_binding_count(&self, header: ByteSpan) -> Result<u8, ProjectionError> {
        let inner_start = header.start as usize + 1;
        let inner_end = header.end as usize - 1;
        let commas = self.top_level_separators(inner_start, inner_end, b',')?;
        if commas.len() > 1 {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(commas[1])?,
                expected: "at most error and reset bindings in `@catch`",
            });
        }
        let first_start = self.skip_ascii_whitespace(inner_start, inner_end);
        let first_end =
            trim_ascii_end(self.bytes, first_start, commas.first().copied().unwrap_or(inner_end));
        if first_start == first_end {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(first_start)?,
                expected: "an error binding in `@catch (...)`",
            });
        }
        let Some(&comma) = commas.first() else {
            return Ok(1);
        };
        let reset_start = self.skip_ascii_whitespace(comma + 1, inner_end);
        let reset_end = trim_ascii_end(self.bytes, reset_start, inner_end);
        if reset_start == reset_end || self.identifier_start_width(reset_start).is_none() {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(reset_start)?,
                expected: "a reset identifier after the catch error binding",
            });
        }
        let identifier_end = self.skip_identifier(reset_start);
        let remainder = self.skip_ascii_whitespace(identifier_end, reset_end);
        if remainder < reset_end
            && (self.bytes[remainder] != b':'
                || self.skip_ascii_whitespace(remainder + 1, reset_end) == reset_end)
        {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(remainder)?,
                expected: "a reset identifier with an optional type annotation",
            });
        }
        Ok(2)
    }

    pub(super) fn analyze_for_header(
        &self,
        header: ByteSpan,
    ) -> Result<ForHeader, ProjectionError> {
        let inner_start = header.start as usize + 1;
        let inner_end = header.end as usize - 1;
        let semicolons = self.top_level_separators(inner_start, inner_end, b';')?;
        let Some(&first) = semicolons.first() else {
            return Ok(ForHeader::default());
        };
        let Some(of) = self.find_top_level_keyword(inner_start, first, b"of")? else {
            return Ok(ForHeader::default());
        };
        let first_value = self.skip_ascii_whitespace(first + 1, inner_end);
        if !self.bare_keyword_at(first_value, b"index")
            && !self.bare_keyword_at(first_value, b"key")
        {
            return Ok(ForHeader::default());
        }

        let base_end = trim_ascii_end(self.bytes, inner_start, first);
        let left_end = trim_ascii_end(self.bytes, inner_start, of);
        let right_start = self.skip_ascii_whitespace(of + 2, base_end);
        let right_end = trim_ascii_end(self.bytes, right_start, base_end);
        if left_end <= inner_start || right_end <= right_start {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(of)?,
                expected: "a complete `for ... of ...` header",
            });
        }

        let mut for_header = ForHeader {
            left: ByteSpan::new(to_u32(inner_start)?, to_u32(left_end)?),
            right: ByteSpan::new(to_u32(right_start)?, to_u32(right_end)?),
            annotated: true,
            ..ForHeader::default()
        };
        for (position, &semi) in semicolons.iter().enumerate() {
            let segment_end = semicolons.get(position + 1).copied().unwrap_or(inner_end);
            let keyword_start = self.skip_ascii_whitespace(semi + 1, segment_end);
            let (kind, keyword_len) = if self.bare_keyword_at(keyword_start, b"index") {
                (ClauseRole::For, 5)
            } else if self.bare_keyword_at(keyword_start, b"key") {
                (ClauseRole::Empty, 3)
            } else {
                return Err(ProjectionError::MalformedSyntax {
                    offset: to_u32(keyword_start)?,
                    expected: "`index` or `key` annotation",
                });
            };
            let value_start = self.skip_ascii_whitespace(keyword_start + keyword_len, segment_end);
            let value_end = trim_ascii_end(self.bytes, value_start, segment_end);
            if value_start == value_end {
                return Err(ProjectionError::MalformedSyntax {
                    offset: to_u32(value_start)?,
                    expected: "an annotation value",
                });
            }
            let span = ByteSpan::new(to_u32(value_start)?, to_u32(value_end)?);
            if matches!(kind, ClauseRole::For)
                && (self.identifier_start_width(value_start).is_none()
                    || self.skip_identifier(value_start) != value_end)
            {
                return Err(ProjectionError::MalformedSyntax {
                    offset: to_u32(value_start)?,
                    expected: "an identifier after `index`",
                });
            }
            match kind {
                ClauseRole::For if for_header.index.is_empty() && for_header.key.is_empty() => {
                    for_header.index = span;
                }
                ClauseRole::Empty if for_header.key.is_empty() => for_header.key = span,
                ClauseRole::For => {
                    return Err(ProjectionError::MalformedSyntax {
                        offset: to_u32(keyword_start)?,
                        expected: "one `index` annotation before `key`",
                    });
                }
                ClauseRole::Empty => {
                    return Err(ProjectionError::MalformedSyntax {
                        offset: to_u32(keyword_start)?,
                        expected: "one `key` annotation",
                    });
                }
                _ => unreachable!(),
            }
        }
        Ok(for_header)
    }

    fn top_level_separators(
        &self,
        mut index: usize,
        end: usize,
        separator: u8,
    ) -> Result<Vec<usize>, ProjectionError> {
        let mut delimiters = TinyStack::<u8, 16>::new();
        let mut separators = Vec::new();
        let mut can_start_expression = true;
        while index < end {
            match self.bytes[index] {
                b'\'' | b'"' => {
                    index = self.skip_quote(index, self.bytes[index])?;
                    can_start_expression = false;
                }
                b'`' => index = self.skip_template_raw(index, end)?,
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
                b'(' | b'[' | b'{' => {
                    delimiters.push(self.bytes[index]);
                    index += 1;
                    can_start_expression = true;
                }
                b')' | b']' | b'}' => {
                    delimiters.pop();
                    index += 1;
                    can_start_expression = false;
                }
                byte if byte == separator && delimiters.is_empty() => {
                    separators.push(index);
                    index += 1;
                    can_start_expression = true;
                }
                _ if self.identifier_start_width(index).is_some() => {
                    index = self.skip_identifier(index);
                    can_start_expression = false;
                }
                _ => {
                    can_start_expression = matches!(
                        self.bytes[index],
                        b'=' | b',' | b':' | b'?' | b'!' | b'+' | b'-' | b'*' | b'%' | b'&' | b'|'
                    );
                    index += 1;
                }
            }
        }
        Ok(separators)
    }

    fn find_top_level_keyword(
        &self,
        mut index: usize,
        end: usize,
        keyword: &[u8],
    ) -> Result<Option<usize>, ProjectionError> {
        let mut delimiters = TinyStack::<u8, 16>::new();
        while index < end {
            match self.bytes[index] {
                b'\'' | b'"' => index = self.skip_quote(index, self.bytes[index])?,
                b'`' => index = self.skip_template_raw(index, end)?,
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                    index = self.skip_line_comment(index + 2);
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    index = self.skip_block_comment(index)?;
                }
                b'(' | b'[' | b'{' => {
                    delimiters.push(self.bytes[index]);
                    index += 1;
                }
                b')' | b']' | b'}' => {
                    delimiters.pop();
                    index += 1;
                }
                _ if delimiters.is_empty() && self.identifier_start_width(index).is_some() => {
                    let word_end = self.skip_identifier(index);
                    if &self.bytes[index..word_end] == keyword {
                        return Ok(Some(index));
                    }
                    index = word_end;
                }
                _ => index += 1,
            }
        }
        Ok(None)
    }
}

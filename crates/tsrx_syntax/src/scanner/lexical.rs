use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::ControlContext,
};

use super::Scanner;

/// Last bytes of the tokens that cannot end an expression, so a TSRX control written after one is
/// continuing that expression however the source is laid out. `>` covers both `=>` and the close of
/// a markup element, and `/` covers both division and the close of a regular expression, which is
/// why neither of those shapes changes context under the line-leading rule.
const OPERAND_BYTES: &[u8] = b"=([,?:.+-*/%&|^!~<>";

/// Keywords that demand an operand. A line-leading control after one of these is still part of the
/// expression the keyword opened, even though ASI would end some of them.
const OPERAND_KEYWORDS: &[&[u8]] = &[
    b"await",
    b"case",
    b"default",
    b"delete",
    b"extends",
    b"in",
    b"instanceof",
    b"new",
    b"of",
    b"return",
    b"typeof",
    b"void",
    b"yield",
];

impl Scanner<'_> {
    pub(super) fn scan_template(&mut self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut escaped = false;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
                index += 1;
            } else if byte == b'\\' {
                escaped = true;
                index += 1;
            } else if byte == b'`' {
                return Ok(index + 1);
            } else if byte == b'$' && self.bytes.get(index + 1) == Some(&b'{') {
                index = self.scan_region(index + 2, Some(b'}'))?;
            } else {
                index += 1;
            }
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "template literal",
        })
    }

    pub(super) fn skip_template_raw(
        &self,
        start: usize,
        end: usize,
    ) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut escaped = false;
        let mut braces = 0usize;
        while index < end {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'`' && braces == 0 {
                return Ok(index + 1);
            } else if byte == b'$' && self.bytes.get(index + 1) == Some(&b'{') {
                braces += 1;
                index += 1;
            } else if byte == b'}' && braces > 0 {
                braces -= 1;
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "template literal",
        })
    }

    pub(super) fn control_has_header(&self, start: usize, keyword: &[u8]) -> bool {
        let mut index = Self::after_keyword(start, keyword);
        index = self.skip_ascii_whitespace(index, self.bytes.len());
        if keyword == b"for" && self.bare_keyword_at(index, b"await") {
            index = self
                .skip_ascii_whitespace(Self::after_bare_keyword(index, b"await"), self.bytes.len());
        }
        self.bytes.get(index) == Some(&b'(')
    }

    pub(super) fn control_has_body(&self, start: usize, keyword: &[u8]) -> bool {
        self.skip_trivia(Self::after_keyword(start, keyword))
            .is_ok_and(|index| self.bytes.get(index) == Some(&b'{'))
    }

    pub(super) fn code_context(&self, start: usize) -> ControlContext {
        let mut index = start;
        loop {
            while index > 0 && self.bytes[index - 1].is_ascii_whitespace() {
                index -= 1;
            }
            if index >= 2 && self.bytes.get(index - 2..index) == Some(b"*/") {
                let Some(comment_start) =
                    self.bytes[..index - 2].windows(2).rposition(|window| window == b"/*")
                else {
                    break;
                };
                index = comment_start;
                continue;
            }
            let line_start = self.bytes[..index]
                .iter()
                .rposition(|byte| matches!(byte, b'\n' | b'\r'))
                .map_or(0, |position| position + 1);
            let line = &self.bytes[line_start..index];
            let first =
                line.iter().position(|byte| !byte.is_ascii_whitespace()).unwrap_or(line.len());
            if line.get(first..first + 2) == Some(b"//") {
                index = line_start;
                continue;
            }
            break;
        }
        if index == 0
            || matches!(self.bytes[index - 1], b'{' | b'}' | b';')
            || self.line_leading_control_starts_a_statement(start, index)
        {
            ControlContext::Statement
        } else {
            ControlContext::Expression
        }
    }

    /// Octane starts a new statement when a line begins with a TSRX control, even though the
    /// previous line left its statement unterminated — the same boundary
    /// `line_leading_markup_starts_a_statement` gives a line-leading markup opening. `start` is the
    /// control's `@`; `previous` is one past the last non-trivia byte before it, as `code_context`
    /// computed it. The control only continues the preceding expression when the token before it
    /// demands an operand, so everything else on a fresh line opens a statement.
    fn line_leading_control_starts_a_statement(&self, start: usize, previous: usize) -> bool {
        self.at_line_start(start) && !self.token_demands_an_operand(previous)
    }

    /// True when the token ending at `index` cannot end an expression, so whatever follows it has
    /// to continue that expression rather than start a statement. Deliberately a deny-list: an
    /// unrecognised token leaves the control where a line break already put it.
    fn token_demands_an_operand(&self, index: usize) -> bool {
        let Some(&last) = index.checked_sub(1).and_then(|last| self.bytes.get(last)) else {
            return false;
        };
        if OPERAND_BYTES.contains(&last) {
            return true;
        }
        let mut word_start = index;
        while word_start > 0 && self.bytes[word_start - 1].is_ascii_alphabetic() {
            word_start -= 1;
        }
        word_start < index
            && !identifier_continue_before(self.bytes, word_start)
            && OPERAND_KEYWORDS.contains(&&self.bytes[word_start..index])
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
    fn at_line_start(&self, index: usize) -> bool {
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

    pub(super) fn keyword_at(&self, index: usize, keyword: &[u8]) -> bool {
        let end = index + 1 + keyword.len();
        self.bytes.get(index) == Some(&b'@')
            && self.bytes.get(index + 1..end) == Some(keyword)
            && keyword_boundary(&self.bytes[end..])
    }

    pub(super) fn bare_keyword_at(&self, index: usize, keyword: &[u8]) -> bool {
        let end = index + keyword.len();
        self.bytes.get(index..end) == Some(keyword)
            && keyword_boundary(&self.bytes[end..])
            && !identifier_continue_before(self.bytes, index)
    }

    pub(super) const fn after_keyword(index: usize, keyword: &[u8]) -> usize {
        index + 1 + keyword.len()
    }

    pub(super) const fn after_bare_keyword(index: usize, keyword: &[u8]) -> usize {
        index + keyword.len()
    }

    pub(super) fn skip_trivia(&self, mut index: usize) -> Result<usize, ProjectionError> {
        loop {
            while self.bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                index += 1;
            }
            if self.bytes.get(index..index + 2) == Some(b"//") {
                index = self.skip_line_comment(index + 2);
            } else if self.bytes.get(index..index + 2) == Some(b"/*") {
                index = self.skip_block_comment(index)?;
            } else {
                return Ok(index);
            }
        }
    }

    pub(super) fn skip_ascii_whitespace(&self, mut index: usize, end: usize) -> usize {
        while index < end && self.bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        index
    }

    pub(super) fn skip_quote(&self, start: usize, quote: u8) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut escaped = false;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                return Ok(index + 1);
            } else if matches!(byte, b'\n' | b'\r') {
                break;
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "quoted string",
        })
    }

    /// JSX quoted attribute values may contain literal line terminators. JavaScript strings may
    /// not, so keep this separate from `skip_quote` rather than weakening the ordinary lexical
    /// boundary used everywhere else in the scanner.
    pub(super) fn skip_jsx_quote(&self, start: usize, quote: u8) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut escaped = false;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                return Ok(index + 1);
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "quoted JSX attribute",
        })
    }

    pub(super) fn skip_line_comment(&self, mut index: usize) -> usize {
        while index < self.bytes.len() && !matches!(self.bytes[index], b'\n' | b'\r') {
            index += 1;
        }
        index
    }

    pub(super) fn skip_block_comment(&self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 2;
        while index + 1 < self.bytes.len() {
            if self.bytes[index..index + 2] == *b"*/" {
                return Ok(index + 2);
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "block comment",
        })
    }

    pub(super) fn skip_regex(&self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut escaped = false;
        let mut in_class = false;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'[' {
                in_class = true;
            } else if byte == b']' {
                in_class = false;
            } else if byte == b'/' && !in_class {
                index += 1;
                while let Some(width) = self.identifier_continue_width(index) {
                    index += width;
                }
                return Ok(index);
            } else if matches!(byte, b'\n' | b'\r') {
                break;
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "regular expression literal",
        })
    }

    pub(super) fn skip_number(&self, mut index: usize) -> usize {
        while self
            .bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.'))
        {
            index += 1;
        }
        index
    }

    #[inline]
    pub(super) fn identifier_start_width(&self, index: usize) -> Option<usize> {
        identifier_start_width(self.bytes, index)
    }

    #[inline]
    pub(super) fn identifier_continue_width(&self, index: usize) -> Option<usize> {
        identifier_continue_width(self.bytes, index)
    }

    pub(super) fn skip_identifier(&self, mut index: usize) -> usize {
        let Some(width) = self.identifier_start_width(index) else {
            return index;
        };
        index += width;
        while let Some(width) = self.identifier_continue_width(index) {
            index += width;
        }
        index
    }

    pub(super) fn skip_jsx_name(&self, mut index: usize) -> usize {
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

    /// Returns true for TypeScript type arguments and generic-arrow parameter lists that begin
    /// where an expression could otherwise begin with JSX. This is deliberately a narrow
    /// disambiguation: ordinary JSX remains committed by `committed_jsx_opening`, while the forms
    /// TypeScript requires to disambiguate generic arrows (`extends`, a default, or a trailing
    /// comma) are left for OXC.
    pub(super) fn looks_like_typescript_type_parameters(&self, start: usize) -> bool {
        if start > 0
            && self.bytes.get(start - 1).is_some_and(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$' | b']' | b')')
            })
        {
            return true;
        }

        let name_start = start + 1;
        if self.identifier_start_width(name_start).is_none() {
            return false;
        }
        let name_end = self.skip_identifier(name_start);
        let marker = self.skip_ascii_whitespace(name_end, self.bytes.len());
        if !matches!(self.bytes.get(marker), Some(b',' | b'='))
            && !self.bare_keyword_at(marker, b"extends")
        {
            return false;
        }

        self.type_parameter_list_precedes_parameters(name_end)
    }

    fn type_parameter_list_precedes_parameters(&self, mut index: usize) -> bool {
        let mut depth = 1_u32;
        while let Some(&byte) = self.bytes.get(index) {
            match byte {
                b'\'' | b'"' => {
                    let Ok(end) = self.skip_quote(index, byte) else {
                        return false;
                    };
                    index = end;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    let Ok(end) = self.skip_block_comment(index) else {
                        return false;
                    };
                    index = end;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                    index = self.skip_line_comment(index + 2);
                }
                b'<' => {
                    depth = depth.saturating_add(1);
                    index += 1;
                }
                b'>' if self.bytes.get(index.wrapping_sub(1)) != Some(&b'=') => {
                    depth -= 1;
                    index += 1;
                    if depth == 0 {
                        return self
                            .skip_trivia(index)
                            .is_ok_and(|next| self.bytes.get(next) == Some(&b'('));
                    }
                }
                _ => index += 1,
            }
        }
        false
    }
}

#[inline]
fn identifier_start_width(bytes: &[u8], index: usize) -> Option<usize> {
    let byte = *bytes.get(index)?;
    if is_identifier_start(byte) {
        return Some(1);
    }
    if byte.is_ascii() {
        return None;
    }
    let (character, width) = decode_non_ascii_utf8(bytes, index)?;
    unicode_id_start::is_id_start_unicode(character).then_some(width)
}

#[inline]
fn identifier_continue_width(bytes: &[u8], index: usize) -> Option<usize> {
    let byte = *bytes.get(index)?;
    if is_identifier_continue(byte) {
        return Some(1);
    }
    if byte.is_ascii() {
        return None;
    }
    let (character, width) = decode_non_ascii_utf8(bytes, index)?;
    (unicode_id_start::is_id_continue_unicode(character)
        || matches!(character, '\u{200C}' | '\u{200D}'))
    .then_some(width)
}

fn identifier_continue_before(bytes: &[u8], index: usize) -> bool {
    let Some(mut start) = index.checked_sub(1) else {
        return false;
    };
    if bytes[start].is_ascii() {
        return is_identifier_continue(bytes[start]);
    }
    let lower_bound = index.saturating_sub(4);
    while start > lower_bound && bytes[start] & 0b1100_0000 == 0b1000_0000 {
        start -= 1;
    }
    identifier_continue_width(bytes, start).is_some_and(|width| start + width == index)
}

#[inline]
fn decode_non_ascii_utf8(bytes: &[u8], index: usize) -> Option<(char, usize)> {
    let width = match *bytes.get(index)? {
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return None,
    };
    let end = index.checked_add(width)?;
    let encoded = bytes.get(index..end)?;
    let character = std::str::from_utf8(encoded).ok()?.chars().next()?;
    Some((character, width))
}

pub(super) fn trim_ascii_end(bytes: &[u8], start: usize, mut end: usize) -> usize {
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    end
}

pub(super) fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

pub(super) fn previous_significant_byte(bytes: &[u8], before: usize) -> Option<u8> {
    bytes[..before].iter().rfind(|byte| !byte.is_ascii_whitespace()).copied()
}

pub(super) fn unsupported_at_construct(bytes: &[u8], index: usize) -> Option<&'static str> {
    const UNSUPPORTED: [(&[u8], &str); 1] = [(b"await", "@await control flow")];
    UNSUPPORTED.iter().find_map(|(keyword, construct)| {
        let end = index + 1 + keyword.len();
        (bytes.get(index + 1..end) == Some(*keyword) && keyword_boundary(&bytes[end..]))
            .then_some(*construct)
    })
}

pub(super) fn jsx_text_looks_structural(bytes: &[u8], index: usize) -> bool {
    [b"if".as_slice(), b"for", b"switch", b"try"].iter().any(|keyword| {
        let end = index + 1 + keyword.len();
        if bytes.get(index + 1..end) != Some(*keyword) || !keyword_boundary(&bytes[end..]) {
            return false;
        }
        bytes[end..].iter().find(|byte| !byte.is_ascii_whitespace()).copied() == Some(b'(')
            || (*keyword == b"try"
                && bytes[end..].iter().find(|byte| !byte.is_ascii_whitespace()).copied()
                    == Some(b'{'))
    })
}

#[inline]
fn keyword_boundary(suffix: &[u8]) -> bool {
    let Some(&first) = suffix.first() else {
        return true;
    };
    if first.is_ascii() && first != b'\\' {
        return !is_identifier_continue(first);
    }
    !is_identifier_continue_slow(suffix)
}

#[cold]
#[inline(never)]
fn is_identifier_continue_slow(suffix: &[u8]) -> bool {
    let Some(&first) = suffix.first() else {
        return false;
    };
    let character = if first == b'\\' {
        if suffix.get(1) != Some(&b'u') {
            return false;
        }
        let code_point = if suffix.get(2) == Some(&b'{') {
            let mut index = 3;
            let mut value = 0_u32;
            let mut has_digit = false;
            loop {
                let Some(&byte) = suffix.get(index) else {
                    return false;
                };
                if byte == b'}' {
                    if !has_digit {
                        return false;
                    }
                    break value;
                }
                let digit = match byte {
                    b'0'..=b'9' => u32::from(byte - b'0'),
                    b'a'..=b'f' => u32::from(byte - b'a' + 10),
                    b'A'..=b'F' => u32::from(byte - b'A' + 10),
                    _ => return false,
                };
                has_digit = true;
                let Some(next) = value.checked_mul(16).and_then(|value| value.checked_add(digit))
                else {
                    return false;
                };
                if next > 0x10_FFFF {
                    return false;
                }
                value = next;
                index += 1;
            }
        } else {
            let Some(digits) = suffix.get(2..6) else {
                return false;
            };
            let mut value = 0_u32;
            for &byte in digits {
                let digit = match byte {
                    b'0'..=b'9' => u32::from(byte - b'0'),
                    b'a'..=b'f' => u32::from(byte - b'a' + 10),
                    b'A'..=b'F' => u32::from(byte - b'A' + 10),
                    _ => return false,
                };
                value = value * 16 + digit;
            }
            value
        };
        let Some(character) = char::from_u32(code_point) else {
            return false;
        };
        character
    } else {
        let width = match first {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return false,
        };
        let Some(encoded) = suffix.get(..width) else {
            return false;
        };
        let Ok(value) = std::str::from_utf8(encoded) else {
            return false;
        };
        let Some(character) = value.chars().next() else {
            return false;
        };
        character
    };

    if character.is_ascii() {
        is_identifier_continue(character as u8)
    } else {
        unicode_id_start::is_id_continue_unicode(character)
            || matches!(character, '\u{200C}' | '\u{200D}')
    }
}

pub(crate) const fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$')
}

pub(crate) const fn is_identifier_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

#[cfg(test)]
mod tests {
    use super::{Scanner, keyword_boundary};

    #[test]
    fn malformed_escapes_and_non_identifier_scalars_remain_boundaries() {
        for suffix in [
            b"(".as_slice(),
            b"\\u{}",
            b"\\u{110000}",
            b"\\u{2d}",
            b"\\u002d",
            b"\\uD800",
            b"\\x70",
            b"\\u{xyz}",
            b"\\u{3c0",
            b"\\u03c",
            b"\\uD835\\uDC9C",
            "🙂".as_bytes(),
            "\u{200b}".as_bytes(),
            b"\xFF",
        ] {
            assert!(keyword_boundary(suffix), "{suffix:?}");
        }
        assert!(!keyword_boundary(br"\u{000000000000000000000000000000000000000000000003c0}"));
    }

    #[test]
    fn bare_keyword_right_boundaries_share_unicode_semantics() {
        for source in ["ifπ", r"if\u03c0", "if\u{0301}", r"if\u{1D49C}"] {
            assert!(!Scanner::new(source).bare_keyword_at(0, b"if"), "{source}");
        }
        assert!(Scanner::new("if (").bare_keyword_at(0, b"if"));
    }
}

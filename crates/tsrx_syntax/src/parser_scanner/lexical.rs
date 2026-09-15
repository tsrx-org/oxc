//! Skipping the JavaScript token forms whose interiors must not be searched for TSRX syntax:
//! strings, templates, regexes, comments, numbers, and identifiers.

use crate::diagnostics::{ProjectionError, to_u32};

use super::Scanner;
use super::surrogates::OpaqueSurrogateContext;

impl Scanner<'_> {
    pub(super) fn scan_template(&mut self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut raw_start = index;
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
                self.mark_surrogates(raw_start, index, OpaqueSurrogateContext::TemplateRaw);
                return Ok(index + 1);
            } else if byte == b'$' && self.bytes.get(index + 1) == Some(&b'{') {
                self.mark_surrogates(raw_start, index, OpaqueSurrogateContext::TemplateRaw);
                index = self.scan_expression_region(index + 2, Some(b'}'))?;
                raw_start = index;
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
        let mut raw_start = index;
        let mut escaped = false;
        let mut braces = 0usize;
        while index < end {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'`' && braces == 0 {
                self.mark_surrogates(raw_start, index, OpaqueSurrogateContext::TemplateRaw);
                return Ok(index + 1);
            } else if byte == b'$' && self.bytes.get(index + 1) == Some(&b'{') {
                if braces == 0 {
                    self.mark_surrogates(raw_start, index, OpaqueSurrogateContext::TemplateRaw);
                }
                braces += 1;
                index += 1;
            } else if byte == b'}' && braces > 0 {
                braces -= 1;
                if braces == 0 {
                    raw_start = index + 1;
                }
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "template literal",
        })
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
                self.mark_surrogates(start + 1, index, OpaqueSurrogateContext::QuotedString);
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
                self.mark_surrogates(start + 1, index, OpaqueSurrogateContext::QuotedString);
                return Ok(index + 1);
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "quoted JSX attribute",
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
                self.mark_surrogates(start + 1, index, OpaqueSurrogateContext::RegexBody);
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

    pub(super) fn skip_line_comment(&self, mut index: usize) -> usize {
        let start = index;
        while index < self.bytes.len() && !matches!(self.bytes[index], b'\n' | b'\r') {
            index += 1;
        }
        self.mark_surrogates(start, index, OpaqueSurrogateContext::Comment);
        index
    }

    pub(super) fn skip_block_comment(&self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 2;
        while index + 1 < self.bytes.len() {
            if self.bytes[index..index + 2] == *b"*/" {
                self.mark_surrogates(start + 2, index, OpaqueSurrogateContext::Comment);
                return Ok(index + 2);
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "block comment",
        })
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

    pub(super) fn keyword_at(&self, index: usize, keyword: &[u8]) -> bool {
        let end = index + 1 + keyword.len();
        self.bytes.get(index) == Some(&b'@')
            && self.bytes.get(index + 1..end) == Some(keyword)
            && keyword_boundary(self.bytes, end)
    }

    pub(super) fn bare_keyword_at(&self, index: usize, keyword: &[u8]) -> bool {
        let end = index + keyword.len();
        self.bytes.get(index..end) == Some(keyword)
            && keyword_boundary(self.bytes, end)
            && !identifier_continue_before(self.bytes, index)
    }

    pub(super) const fn after_keyword(index: usize, keyword: &[u8]) -> usize {
        index + 1 + keyword.len()
    }

    pub(super) const fn after_bare_keyword(index: usize, keyword: &[u8]) -> usize {
        index + keyword.len()
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

    /// Octane starts a new statement when a line begins with a TSRX control, even though the
    /// previous line left its statement unterminated — the same boundary
    /// `line_leading_markup_starts_a_statement` gives a line-leading markup opening. `start` is the
    /// control's `@`; `previous` is one past the last non-trivia byte before it, as `code_context`
    /// computed it. The control only continues the preceding expression when the token before it
    /// demands an operand, so everything else on a fresh line opens a statement.
    pub(super) fn line_leading_control_starts_a_statement(
        &self,
        start: usize,
        previous: usize,
    ) -> bool {
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
}

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

pub(super) fn trim_ascii_end(bytes: &[u8], start: usize, mut end: usize) -> usize {
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    end
}

pub(super) fn previous_significant_byte(bytes: &[u8], before: usize) -> Option<u8> {
    bytes[..before].iter().rfind(|byte| !byte.is_ascii_whitespace()).copied()
}

pub(super) fn unsupported_at_construct(bytes: &[u8], index: usize) -> Option<&'static str> {
    const UNSUPPORTED: [(&[u8], &str); 1] = [(b"await", "@await control flow")];
    UNSUPPORTED.iter().find_map(|(keyword, construct)| {
        let end = index + 1 + keyword.len();
        (bytes.get(index + 1..end) == Some(*keyword) && keyword_boundary(bytes, end))
            .then_some(*construct)
    })
}

#[inline]
pub(super) fn identifier_start_width(bytes: &[u8], index: usize) -> Option<usize> {
    let byte = *bytes.get(index)?;
    if is_identifier_start(byte) {
        return Some(1);
    }
    if byte.is_ascii() {
        return None;
    }
    let (character, width) = decode_non_ascii_utf8(bytes, index)?;
    (unicode_identifier_start(character) || matches!(character, '\u{e000}' | '\u{ffff}'))
        .then_some(width)
}

/// The structural scanner only needs to preserve expression state, not validate identifiers.
/// After a proven start, consuming a complete non-ASCII scalar is deliberately conservative: all
/// ECMAScript `ID_Continue` scalars are covered without a generated Unicode table, while invalid
/// UTF-8 (including raw WTF-8 surrogate triples) remains active and unconsumed.
#[inline]
pub(super) fn identifier_continue_width(bytes: &[u8], index: usize) -> Option<usize> {
    let byte = *bytes.get(index)?;
    if is_identifier_continue(byte) {
        return Some(1);
    }
    if byte.is_ascii() {
        return None;
    }
    decode_non_ascii_utf8(bytes, index).map(|(_, width)| width)
}

/// Reports whether a keyword ending at `index` actually ends there.
///
/// `identifier_continue_width` answers that for raw bytes, but `\` is neither an identifier byte
/// nor the start of a UTF-8 scalar, so on its own it reads a trailing `\u` escape as a boundary
/// and turns the decorator `@for\u{03c0}` into the `@for` keyword — which then demands the `(` of a
/// loop header. The base scanner decodes the escape for exactly this reason, and the parser lane
/// has to agree with it, or format and lint reject a decorator the parser accepts.
#[inline]
fn keyword_boundary(bytes: &[u8], index: usize) -> bool {
    if identifier_continue_width(bytes, index).is_some() {
        return false;
    }
    bytes.get(index) != Some(&b'\\') || !escaped_identifier_continue(&bytes[index..])
}

/// Reports whether a leading `\uXXXX` or `\u{...}` escape names a scalar that continues an
/// identifier. Classification deliberately mirrors `identifier_continue_width`'s raw-byte answer
/// rather than the stricter `ID_Continue` table, so an escape and the character it spells always
/// land on the same side of a keyword boundary. A malformed, incomplete, or out-of-range escape is
/// not an identifier continuation, which leaves the keyword ending where it looked like it ended.
#[cold]
#[inline(never)]
fn escaped_identifier_continue(suffix: &[u8]) -> bool {
    let Some(character) = decode_unicode_escape(suffix).and_then(char::from_u32) else {
        return false;
    };
    if character.is_ascii() { is_identifier_continue(character as u8) } else { true }
}

/// Decodes the code point of a leading `\uXXXX` or `\u{...}` escape, without validating that it is
/// a scalar value; lone surrogates fall out at the `char::from_u32` that follows.
fn decode_unicode_escape(suffix: &[u8]) -> Option<u32> {
    if suffix.first() != Some(&b'\\') || suffix.get(1) != Some(&b'u') {
        return None;
    }
    if suffix.get(2) != Some(&b'{') {
        return suffix
            .get(2..6)?
            .iter()
            .try_fold(0_u32, |value, &byte| Some(value * 16 + hex_digit(byte)?));
    }
    let mut value = 0_u32;
    let mut has_digit = false;
    for &byte in suffix.get(3..)? {
        if byte == b'}' {
            return has_digit.then_some(value);
        }
        value = value.checked_mul(16)?.checked_add(hex_digit(byte)?)?;
        if value > 0x10_FFFF {
            return None;
        }
        has_digit = true;
    }
    None
}

const fn hex_digit(byte: u8) -> Option<u32> {
    match byte {
        b'0'..=b'9' => Some((byte - b'0') as u32),
        b'a'..=b'f' => Some((byte - b'a' + 10) as u32),
        b'A'..=b'F' => Some((byte - b'A' + 10) as u32),
        _ => None,
    }
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

#[inline]
fn unicode_identifier_start(character: char) -> bool {
    character.is_alphabetic()
        || matches!(
            character,
            '\u{1885}' | '\u{1886}' | '\u{2118}' | '\u{212E}' | '\u{309B}' | '\u{309C}'
        )
}

pub(crate) const fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$')
}

pub(crate) const fn is_identifier_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

#[cfg(test)]
mod tests {
    use super::{super::Scanner, keyword_boundary, unsupported_at_construct};

    fn boundary(suffix: &[u8]) -> bool {
        let mut bytes = b"if".to_vec();
        bytes.extend_from_slice(suffix);
        keyword_boundary(&bytes, 2)
    }

    #[test]
    fn malformed_escapes_and_non_identifier_scalars_remain_boundaries() {
        for suffix in [
            b"(".as_slice(),
            b"",
            b"\\u{}",
            b"\\u{110000}",
            b"\\u{2d}",
            b"\\u002d",
            b"\\x70",
            b"\\u{xyz}",
            b"\\u{3c0",
            b"\\u03c",
            b"\\",
            b"\\n",
        ] {
            assert!(boundary(suffix), "{suffix:?}");
        }
    }

    #[test]
    fn escaped_identifier_continuations_are_not_boundaries() {
        for suffix in [
            b"\\u03c0".as_slice(),
            b"\\u0301",
            b"\\u200c",
            b"\\u200d",
            b"\\u0030",
            b"\\u005f",
            b"\\u0024",
            b"\\u{1D49C}",
            b"\\u{000003c0}",
        ] {
            assert!(!boundary(suffix), "{suffix:?}");
        }
    }

    /// The escape and the character it spells have to land on the same side of the boundary, so
    /// the parser lane keeps `identifier_continue_width`'s conservative reading of a lone
    /// surrogate: `\uD800` decodes to no scalar and ends the keyword, exactly as the raw bytes do.
    #[test]
    fn lone_surrogate_escapes_end_the_keyword() {
        assert!(boundary(b"\\uD800"));
    }

    #[test]
    fn keyword_checks_reject_escaped_identifier_suffixes() {
        for source in ["@for\\u03c0", "@for\u{03c0}", r"@try\u{1D49C}", "@try\u{1D49C}"] {
            assert!(!Scanner::new_for_parser(source).keyword_at(0, b"for"), "{source}");
            assert!(!Scanner::new_for_parser(source).keyword_at(0, b"try"), "{source}");
        }
        assert!(Scanner::new_for_parser("@for (").keyword_at(0, b"for"));

        for source in ["is\\u03c0", "is\u{03c0}"] {
            assert!(!Scanner::new_for_parser(source).bare_keyword_at(0, b"is"), "{source}");
        }
        assert!(Scanner::new_for_parser("is string").bare_keyword_at(0, b"is"));
    }

    /// `@await` is refused by name, so its boundary has to agree with every other keyword's:
    /// `@awaitπ` is a decorator, not an unsupported control.
    #[test]
    fn unsupported_construct_detection_shares_the_keyword_boundary() {
        for source in ["@await\\u03c0", "@await\u{03c0}", r"@await\u{1D49C}"] {
            assert!(unsupported_at_construct(source.as_bytes(), 0).is_none(), "{source}");
        }
        assert_eq!(unsupported_at_construct(b"@await (", 0), Some("@await control flow"));
    }
}

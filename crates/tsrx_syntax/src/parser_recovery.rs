//! Bounded, authored-coordinate source repair for the parser's opt-in editor lane.

use crate::{ProjectionError, scan_for_parser};

pub const PARSER_RECOVERY_DIAGNOSTIC: &str = "incomplete TSRX editor snapshot";

#[derive(Debug)]
pub struct ParserRecovery {
    text: String,
    boundaries: Vec<u32>,
    diagnostic_offset: u32,
}

impl ParserRecovery {
    fn new(source: &str) -> Result<Self, ProjectionError> {
        let source_len =
            u32::try_from(source.len()).map_err(|_| ProjectionError::SourceTooLarge)?;
        Ok(Self {
            text: source.to_string(),
            boundaries: (0..=source_len).collect(),
            diagnostic_offset: source_len,
        })
    }

    #[must_use]
    pub fn source(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub const fn diagnostic_offset(&self) -> u32 {
        self.diagnostic_offset
    }

    #[must_use]
    pub fn map_endpoint(&self, offset: u32) -> Option<u32> {
        self.boundaries.get(usize::try_from(offset).ok()?).copied()
    }

    fn replace(&mut self, start: usize, end: usize, replacement: &str) -> Option<()> {
        if start > end
            || !self.text.is_char_boundary(start)
            || !self.text.is_char_boundary(end)
            || end > self.text.len()
        {
            return None;
        }
        let original_start = *self.boundaries.get(start)?;
        let original_end = *self.boundaries.get(end)?;
        let old_length = end - start;
        let replacement_boundaries = if replacement.len() == old_length {
            self.boundaries[start..=end].to_vec()
        } else {
            let mut boundaries = vec![original_start; replacement.len() + 1];
            *boundaries.last_mut()? = original_end;
            boundaries
        };
        self.text.replace_range(start..end, replacement);
        self.boundaries.splice(start..=end, replacement_boundaries);
        self.diagnostic_offset = self.diagnostic_offset.min(original_start);
        Some(())
    }

    fn insert(&mut self, at: usize, text: &str) -> Option<()> {
        self.replace(at, at, text)
    }
}

/// Builds one legal parser candidate for an incomplete editor snapshot.
///
/// The strict scanner remains unchanged. Unsupported constructs return `None`; accepted repairs
/// preserve an exact endpoint map back to the source handed to this function.
#[doc(hidden)]
pub fn recover_for_parser(source: &str) -> Result<Option<ParserRecovery>, ProjectionError> {
    let mut recovered = ParserRecovery::new(source)?;
    let Some(mut changed) = blank_bare_at_tokens(&mut recovered) else {
        return Ok(None);
    };

    for _ in 0..16 {
        match scan_for_parser(recovered.source()) {
            Ok(_) => break,
            Err(ProjectionError::UnterminatedSyntax { offset, construct: "JSX element" }) => {
                if !close_unterminated_jsx(&mut recovered, offset) {
                    return Ok(None);
                }
                changed = true;
            }
            Err(
                ProjectionError::UnterminatedSyntax { offset, .. }
                | ProjectionError::MalformedSyntax { offset, .. },
            ) => {
                if !blank_incomplete_control(&mut recovered, offset) {
                    return Ok(None);
                }
                changed = true;
            }
            Err(_) => return Ok(None),
        }
    }
    if scan_for_parser(recovered.source()).is_err() {
        return Ok(None);
    }
    let Some(completed_tail) = complete_tail(&mut recovered) else {
        return Ok(None);
    };
    changed |= completed_tail;
    Ok(changed.then_some(recovered))
}

fn blank_bare_at_tokens(source: &mut ParserRecovery) -> Option<bool> {
    let mut offsets = Vec::new();
    let bytes = source.text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => index = skip_quoted(bytes, index, bytes[index]),
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index = skip_line_comment(bytes, index + 2);
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2);
            }
            b'@' => {
                let next = bytes.get(index + 1).copied();
                if !matches!(next, Some(b'{' | b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_')) {
                    offsets.push(index);
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    for offset in offsets.into_iter().rev() {
        source.replace(offset, offset + 1, " ")?;
    }
    Some(source.diagnostic_offset != u32::try_from(source.text.len()).unwrap_or(u32::MAX))
}

fn blank_incomplete_control(source: &mut ParserRecovery, failure_offset: u32) -> bool {
    let limit = usize::try_from(failure_offset).unwrap_or(usize::MAX).min(source.text.len());
    let Some(start) = last_control_start(&source.text, limit) else {
        return false;
    };
    let replacement = " ".repeat(source.text.len() - start);
    source.replace(start, source.text.len(), &replacement).is_some()
}

fn close_unterminated_jsx(source: &mut ParserRecovery, opening_offset: u32) -> bool {
    let Ok(start) = usize::try_from(opening_offset) else {
        return false;
    };
    let bytes = source.text.as_bytes();
    if bytes.get(start) != Some(&b'<') {
        return false;
    }
    let mut end = start + 1;
    while bytes.get(end).is_some_and(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'$')
    }) {
        end += 1;
    }
    if end == start + 1 {
        return false;
    }
    let name = source.text[start + 1..end].to_string();
    let insertion =
        source.text[start..].rfind('}').map_or(source.text.len(), |relative| start + relative);
    source.insert(insertion, &format!("</{name}>")).is_some()
}

fn complete_tail(source: &mut ParserRecovery) -> Option<bool> {
    let bytes = source.text.as_bytes();
    let mut stack = Vec::new();
    let mut index = 0;
    let mut last_significant = None;
    while index < bytes.len() {
        match bytes[index] {
            byte @ (b'\'' | b'"' | b'`') => {
                index = skip_quoted(bytes, index, byte);
                last_significant = Some(byte);
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index = skip_line_comment(bytes, index + 2);
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2);
            }
            byte @ (b'(' | b'[' | b'{') => {
                stack.push(match byte {
                    b'(' => b')',
                    b'[' => b']',
                    b'{' => b'}',
                    _ => unreachable!(),
                });
                last_significant = Some(byte);
                index += 1;
            }
            byte @ (b')' | b']' | b'}') => {
                if stack.last() == Some(&byte) {
                    stack.pop();
                }
                last_significant = Some(byte);
                index += 1;
            }
            byte if byte.is_ascii_whitespace() => index += 1,
            byte => {
                last_significant = Some(byte);
                index += 1;
            }
        }
    }
    let mut suffix = String::new();
    if matches!(
        last_significant,
        Some(b'=' | b'.' | b'+' | b'-' | b'*' | b'/' | b'%' | b'?' | b':' | b',')
    ) {
        suffix.push_str(" undefined");
    }
    suffix.extend(stack.into_iter().rev().map(char::from));
    if suffix.is_empty() {
        return Some(false);
    }
    source.insert(source.text.len(), &suffix)?;
    Some(true)
}

fn last_control_start(source: &str, limit: usize) -> Option<usize> {
    ["@if", "@for", "@switch", "@try"]
        .into_iter()
        .filter_map(|keyword| source[..limit].rfind(keyword))
        .max()
}

fn skip_quoted(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut index = start + 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index = (index + 2).min(bytes.len());
        } else if bytes[index] == quote {
            return index + 1;
        } else {
            index += 1;
        }
    }
    bytes.len()
}

fn skip_line_comment(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
        index += 1;
    }
    index
}

fn skip_block_comment(bytes: &[u8], mut index: usize) -> usize {
    while index + 1 < bytes.len() {
        if bytes[index..index + 2] == *b"*/" {
            return index + 2;
        }
        index += 1;
    }
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::recover_for_parser;

    #[test]
    fn parser_recovery_returns_one_mapped_candidate_without_changing_strict_scanning() {
        for source in [
            "export function View() @{",
            "export function View() @{ const value = ",
            "export function View() @{ @if (",
            "export function View() @{ @ }",
            "export function View() @{\n  <div>\n}",
        ] {
            let recovered = recover_for_parser(source)
                .expect("bounded recovery")
                .expect("recoverable snapshot");
            let recovered_len = u32::try_from(recovered.source().len()).expect("fixture length");
            let source_len = u32::try_from(source.len()).expect("fixture length");
            assert_ne!(recovered.source(), source);
            assert_eq!(recovered.map_endpoint(recovered_len), Some(source_len));
            assert!(crate::scan_for_parser(recovered.source()).is_ok());
        }
    }
}

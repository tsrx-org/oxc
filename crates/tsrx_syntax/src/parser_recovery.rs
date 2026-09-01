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
    let Some(mut changed) = blank_active_bare_at_tokens(&mut recovered) else {
        return Ok(None);
    };

    for _ in 0..16 {
        match scan_for_parser(recovered.source()) {
            Ok(_) => {
                let Some(blanked_at) = blank_active_bare_at_tokens(&mut recovered) else {
                    return Ok(None);
                };
                if blanked_at {
                    changed = true;
                    continue;
                }
                let Some(completed_tail) = complete_delimited_tail(&mut recovered) else {
                    return Ok(None);
                };
                changed |= completed_tail;
                break;
            }
            Err(ProjectionError::UnterminatedSyntax { offset, construct: "JSX element" }) => {
                if !close_unterminated_jsx(&mut recovered, offset) {
                    return Ok(None);
                }
                changed = true;
            }
            Err(ProjectionError::UnterminatedSyntax {
                construct: "delimited expression", ..
            }) => {
                let Some(completed_tail) = complete_delimited_tail(&mut recovered) else {
                    return Ok(None);
                };
                if !completed_tail {
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
    Ok(changed.then_some(recovered))
}

fn blank_active_bare_at_tokens(source: &mut ParserRecovery) -> Option<bool> {
    let bytes = source.text.as_bytes();
    let offsets = bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| {
            let next = bytes.get(index + 1).copied();
            (*byte == b'@'
                && !matches!(next, Some(b'{' | b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_')))
            .then(|| u32::try_from(index).ok())
            .flatten()
        })
        .collect::<Vec<_>>();
    let classification = crate::classify_wtf8_surrogates_detailed(source.text.as_bytes(), &offsets);
    if classification.earlier_error.is_some() {
        return Some(false);
    }
    let active = offsets
        .into_iter()
        .zip(classification.contexts)
        .filter_map(|(offset, context)| context.is_none().then_some(offset))
        .collect::<Vec<_>>();
    let changed = !active.is_empty();
    for offset in active.into_iter().rev() {
        let offset = usize::try_from(offset).ok()?;
        source.replace(offset, offset + 1, " ")?;
    }
    Some(changed)
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

fn complete_expression_tail(source: &mut ParserRecovery) -> Option<bool> {
    if !source.text.trim_end().ends_with('=') {
        return Some(false);
    }
    source.insert(source.text.len(), " undefined")?;
    Some(true)
}

fn complete_delimited_tail(source: &mut ParserRecovery) -> Option<bool> {
    let mut changed = complete_expression_tail(source)?;
    let delimiters = source
        .text
        .as_bytes()
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| {
            matches!(*byte, b'(' | b'[' | b'{' | b')' | b']' | b'}')
                .then(|| u32::try_from(index).ok().map(|offset| (offset, *byte)))
                .flatten()
        })
        .collect::<Vec<_>>();
    let offsets = delimiters.iter().map(|(offset, _)| *offset).collect::<Vec<_>>();
    let classification = crate::classify_wtf8_surrogates_detailed(source.text.as_bytes(), &offsets);
    let mut stack = Vec::new();
    for ((_, byte), context) in delimiters.into_iter().zip(classification.contexts) {
        if context.is_some() {
            continue;
        }
        match byte {
            b'(' | b'[' | b'{' => {
                stack.push(match byte {
                    b'(' => b')',
                    b'[' => b']',
                    b'{' => b'}',
                    _ => unreachable!(),
                });
            }
            b')' | b']' | b'}' => {
                if stack.last() == Some(&byte) {
                    stack.pop();
                }
            }
            _ => unreachable!(),
        }
    }
    let suffix = stack.into_iter().rev().map(char::from).collect::<String>();
    if suffix.is_empty() {
        return Some(changed);
    }
    source.insert(source.text.len(), &suffix)?;
    changed = true;
    Some(changed)
}

fn last_control_start(source: &str, limit: usize) -> Option<usize> {
    ["@if", "@for", "@switch", "@try"]
        .into_iter()
        .filter_map(|keyword| source[..limit].rfind(keyword))
        .max()
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
            "export function View() @{\n  <div>",
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

    #[test]
    fn parser_recovery_blanks_only_lexically_active_bare_at_tokens() {
        for source in [
            "const value = /@/;",
            "const value = /[{}()]/;",
            "const value = '@';",
            "const value = `@`;",
            "const value = 1; // @",
        ] {
            assert!(recover_for_parser(source).expect("bounded recovery").is_none(), "{source}");
        }

        let source = "export function View() @{ const value = /@/; @ }";
        let recovered =
            recover_for_parser(source).expect("bounded recovery").expect("recoverable active `@`");
        assert!(recovered.source().contains("/@/"));
        assert!(recovered.source().contains(";   }"));
    }
}

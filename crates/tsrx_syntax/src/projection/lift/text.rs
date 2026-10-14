use std::ops::Range;

use crate::diagnostics::ProjectionError;

pub(super) fn parse_decimal(bytes: &[u8], mut index: usize) -> Option<(u32, usize)> {
    let start = index;
    let mut value = 0u32;
    while let Some(byte @ b'0'..=b'9') = bytes.get(index) {
        value = value.checked_mul(10)?.checked_add(u32::from(*byte - b'0'))?;
        index += 1;
    }
    (index > start).then_some((value, index))
}

pub(super) fn expect_byte_after_whitespace(
    source: &str,
    cursor: usize,
    expected: u8,
    index: usize,
) -> Result<usize, ProjectionError> {
    let position = skip_ascii_whitespace(source, cursor);
    if source.as_bytes().get(position) != Some(&expected) {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    Ok(position + 1)
}

pub(super) fn expect_word_after_whitespace(
    source: &str,
    cursor: usize,
    expected: &[u8],
    index: usize,
) -> Result<usize, ProjectionError> {
    let position = skip_ascii_whitespace(source, cursor);
    let end = position.saturating_add(expected.len());
    if source.as_bytes().get(position..end) != Some(expected)
        || source
            .as_bytes()
            .get(end)
            .is_some_and(|byte| crate::scanner::is_identifier_continue(*byte))
    {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    Ok(end)
}

pub(super) fn trimmed_content_range(
    source: &str,
    mut start: usize,
    mut end: usize,
) -> Result<Range<usize>, ProjectionError> {
    while start < end && source.as_bytes()[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && source.as_bytes()[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    if start == end {
        return Err(ProjectionError::StructuralMismatch);
    }
    Ok(start..end)
}

pub(super) fn scaffold_call_end(
    source: &str,
    after_end_name: usize,
    index: usize,
) -> Result<usize, ProjectionError> {
    let mut cursor = skip_ascii_whitespace(source, after_end_name);
    if source.as_bytes().get(cursor) == Some(&b',') {
        cursor = skip_ascii_whitespace(source, cursor + 1);
    }
    if source.as_bytes().get(cursor) != Some(&b')') {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    Ok(cursor + 1)
}

pub(super) fn previous_non_whitespace(source: &str, before: usize) -> Option<usize> {
    source.as_bytes()[..before].iter().rposition(|byte| !byte.is_ascii_whitespace())
}

pub(super) fn skip_ascii_whitespace(source: &str, mut index: usize) -> usize {
    while source.as_bytes().get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

pub(super) fn line_indent(source: &str, position: usize) -> usize {
    let line_start = source.as_bytes()[..position]
        .iter()
        .rposition(|byte| matches!(byte, b'\n' | b'\r'))
        .map_or(0, |index| index + 1);
    source.as_bytes()[line_start..position]
        .iter()
        .take_while(|byte| byte.is_ascii_whitespace() && **byte != b'\n' && **byte != b'\r')
        .count()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum TextState {
    Code,
    Single,
    Double,
    Template,
    LineComment,
    BlockComment,
}

pub(super) fn token_at(source: &str, start: usize, token: &str) -> bool {
    source.as_bytes().get(start..start + token.len()) == Some(token.as_bytes())
        && (token == "{"
            || source
                .as_bytes()
                .get(start + token.len())
                .is_none_or(|byte| !crate::scanner::is_identifier_continue(*byte)))
}

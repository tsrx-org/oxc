use crate::{diagnostics::ProjectionError, model::ParserCodeBlockKind};

use super::{
    super::format::FormatProjection,
    ScaffoldSpan,
    text::{
        expect_byte_after_whitespace, expect_word_after_whitespace, previous_non_whitespace,
        skip_ascii_whitespace,
    },
};

pub(super) fn lift_parser_scaffolds(
    formatted: &str,
    projection: &FormatProjection,
) -> Result<String, ProjectionError> {
    if projection.parser_code_blocks.is_empty()
        && projection.parser_shorthand_attributes.is_empty()
        && projection.parser_lazy_patterns.is_empty()
    {
        return Ok(formatted.to_string());
    }

    let mut lifted = formatted.to_string();
    for index in (0..projection.parser_code_blocks.len()).rev() {
        lifted = lift_code_block(&lifted, projection, index)?;
    }
    for index in (0..projection.parser_shorthand_attributes.len()).rev() {
        lifted = lift_shorthand(&lifted, projection, index)?;
    }
    for index in (0..projection.parser_lazy_patterns.len()).rev() {
        lifted = lift_lazy_pattern(&lifted, projection, index)?;
    }
    Ok(lifted)
}

fn lift_code_block(
    source: &str,
    projection: &FormatProjection,
    index: usize,
) -> Result<String, ProjectionError> {
    let block = projection
        .parser_code_blocks
        .get(index)
        .ok_or(ProjectionError::ScaffoldMismatch { index })?;
    let prefix = &projection.prefix;
    let prefix_marker = unique_marker(source, &format!("/*{prefix}X{index}P__*/"), index)?;
    let start_marker = unique_marker(source, &format!("/*{prefix}X{index}S__*/"), index)?;
    let close_marker = unique_marker(source, &format!("/*{prefix}X{index}C__*/"), index)?;
    let end_marker = unique_marker(source, &format!("/*{prefix}X{index}E__*/"), index)?;
    let token_marker = unique_marker(source, &format!("/*{prefix}{}*/", block.token), index)?;

    let mut cursor = prefix_marker.end;
    let (replace_start, parenthesized) = match block.kind {
        ParserCodeBlockKind::JsxChild => {
            let open = previous_non_whitespace(source, prefix_marker.start)
                .filter(|position| source.as_bytes()[*position] == b'{')
                .ok_or(ProjectionError::ScaffoldMismatch { index })?;
            let candidate = skip_ascii_whitespace(source, cursor);
            let parenthesized = source.as_bytes().get(candidate) == Some(&b'(');
            if parenthesized {
                cursor = candidate + 1;
            }
            (open, parenthesized)
        }
        ParserCodeBlockKind::Expression => {
            cursor = expect_word_after_whitespace(source, cursor, b"void", index)?;
            (prefix_marker.start, false)
        }
    };
    cursor = expect_word_after_whitespace(source, cursor, b"async", index)?;
    cursor = expect_word_after_whitespace(source, cursor, b"function", index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'*', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'(', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b')', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'{', index)?;
    cursor = expect_span_after_whitespace(source, cursor, token_marker, index)?;
    let _ = expect_span_after_whitespace(source, cursor, start_marker, index)?;

    if !(start_marker.end <= close_marker.start && close_marker.end <= end_marker.start) {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    cursor = expect_byte_after_whitespace(source, close_marker.end, b'}', index)?;
    if parenthesized {
        cursor = expect_byte_after_whitespace(source, cursor, b')', index)?;
    }
    let semicolon = skip_ascii_whitespace(source, cursor);
    let preserve_semicolon = source.as_bytes().get(semicolon) == Some(&b';');
    if preserve_semicolon {
        cursor = semicolon + 1;
    }
    cursor = expect_span_after_whitespace(source, cursor, end_marker, index)?;
    let replace_end = if block.kind == ParserCodeBlockKind::JsxChild {
        expect_byte_after_whitespace(source, cursor, b'}', index)?
    } else {
        cursor
    };

    let mut replacement = String::with_capacity(
        token_marker
            .end
            .saturating_sub(token_marker.start)
            .saturating_add(close_marker.start.saturating_sub(start_marker.end))
            .saturating_add(2),
    );
    replacement.push_str(&source[token_marker.start..token_marker.end]);
    replacement.push('{');
    replacement.push_str(&source[start_marker.end..close_marker.start]);
    replacement.push('}');
    if preserve_semicolon {
        replacement.push(';');
    }
    replace_range(source, replace_start, replace_end, &replacement, index)
}

fn lift_shorthand(
    source: &str,
    projection: &FormatProjection,
    index: usize,
) -> Result<String, ProjectionError> {
    let marker = unique_marker(source, &format!("{}V{index}_", projection.prefix), index)?;
    let end = expect_byte_after_whitespace(source, marker.end, b'=', index)?;
    let expression = skip_ascii_whitespace(source, end);
    if source.as_bytes().get(expression) != Some(&b'{') {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    replace_range(source, marker.start, end, "", index)
}

fn lift_lazy_pattern(
    source: &str,
    projection: &FormatProjection,
    index: usize,
) -> Result<String, ProjectionError> {
    let pattern = projection
        .parser_lazy_patterns
        .get(index)
        .ok_or(ProjectionError::ScaffoldMismatch { index })?;
    let marker = unique_marker(source, &format!("/*{}Y{index}__*/", projection.prefix), index)?;
    let pattern_start = skip_ascii_whitespace(source, marker.end);
    if !matches!(source.as_bytes().get(pattern_start), Some(b'{' | b'[')) {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    let replace_start = if pattern.standalone {
        let var_end = previous_non_whitespace(source, marker.start)
            .ok_or(ProjectionError::ScaffoldMismatch { index })?
            .saturating_add(1);
        let var_start = var_end.saturating_sub(3);
        if source.as_bytes().get(var_start..var_end) != Some(b"var")
            || var_start > 0 && source.as_bytes()[var_start - 1].is_ascii_alphanumeric()
        {
            return Err(ProjectionError::ScaffoldMismatch { index });
        }
        var_start
    } else {
        marker.start
    };
    replace_range(source, replace_start, pattern_start, "&", index)
}

fn unique_marker(
    source: &str,
    needle: &str,
    index: usize,
) -> Result<ScaffoldSpan, ProjectionError> {
    let start = source.find(needle).ok_or(ProjectionError::ScaffoldMismatch { index })?;
    if source[start + needle.len()..].contains(needle) {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    Ok(ScaffoldSpan { start, end: start + needle.len() })
}

fn expect_span_after_whitespace(
    source: &str,
    cursor: usize,
    expected: ScaffoldSpan,
    index: usize,
) -> Result<usize, ProjectionError> {
    if skip_ascii_whitespace(source, cursor) != expected.start {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    Ok(expected.end)
}

fn replace_range(
    source: &str,
    start: usize,
    end: usize,
    replacement: &str,
    index: usize,
) -> Result<String, ProjectionError> {
    if start > end || end > source.len() {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    let mut output = String::with_capacity(
        source.len().saturating_sub(end - start).saturating_add(replacement.len()),
    );
    output.push_str(&source[..start]);
    output.push_str(replacement);
    output.push_str(&source[end..]);
    Ok(output)
}

use crate::{diagnostics::ProjectionError, scanner::dynamic_expression_token_range};

use super::{
    super::format::FormatProjection,
    ScaffoldSpan,
    text::{
        expect_byte_after_whitespace, expect_word_after_whitespace, parse_decimal,
        skip_ascii_whitespace, trimmed_content_range,
    },
};

pub(super) fn lift_embedded(
    source: &str,
    original_source: &str,
    projection: &FormatProjection,
) -> Result<String, ProjectionError> {
    let bytes = source.as_bytes();
    let dynamic_open = format!("<{}D", projection.prefix);
    let dynamic_close = format!("</{}D", projection.prefix);
    let style_marker = format!("{{/*{}S", projection.prefix);
    let script_marker = format!("{{/*{}L", projection.prefix);
    let mut expressions = vec![ScaffoldSpan::MISSING; projection.dynamics.len()];
    let mut opened = vec![false; projection.dynamics.len()];
    let mut closed = vec![false; projection.dynamics.len()];
    let mut styles: Vec<bool> = projection.styles.iter().map(|style| style.self_closing).collect();
    let mut scripts = vec![false; projection.scripts.len()];
    let restored_bytes = projection
        .styles
        .iter()
        .map(|manifest| (manifest.payload.end - manifest.payload.start) as usize)
        .chain(
            projection
                .scripts
                .iter()
                .map(|manifest| (manifest.payload.end - manifest.payload.start) as usize),
        )
        .fold(0usize, usize::saturating_add);
    let mut output = String::with_capacity(source.len().saturating_add(restored_bytes));
    let mut copied = 0usize;
    let mut cursor = 0usize;
    while cursor < source.len() {
        if source[cursor..].starts_with(&dynamic_close) {
            let digits_start = cursor + dynamic_close.len();
            let (ordinal, digits_end) =
                parse_decimal(bytes, digits_start).ok_or(ProjectionError::MarkerResidual)?;
            let index = ordinal as usize;
            let manifest = projection.dynamics.get(index).ok_or(ProjectionError::MarkerResidual)?;
            if manifest.self_closing || closed[index] || expressions[index].is_missing() {
                return Err(ProjectionError::ScaffoldMismatch { index });
            }
            let end = expect_byte_after_whitespace(source, digits_end, b'>', index)?;
            output.push_str(&source[copied..cursor]);
            output.push_str("</{");
            let expression = expressions[index];
            output.push_str(without_edge_comments(&source[expression.start..expression.end]));
            output.push_str("}>");
            copied = end;
            cursor = end;
            closed[index] = true;
            continue;
        }

        if source[cursor..].starts_with(&dynamic_open) {
            let digits_start = cursor + dynamic_open.len();
            let (ordinal, digits_end) =
                parse_decimal(bytes, digits_start).ok_or(ProjectionError::MarkerResidual)?;
            let index = ordinal as usize;
            if projection.dynamics.get(index).is_none() || opened[index] {
                return Err(ProjectionError::ScaffoldMismatch { index });
            }
            let attribute_start = skip_ascii_whitespace(source, digits_end);
            let attribute = format!("{}A{ordinal}_", projection.prefix);
            let attribute_end = attribute_start.saturating_add(attribute.len());
            if source.as_bytes().get(attribute_start..attribute_end) != Some(attribute.as_bytes()) {
                return Err(ProjectionError::ScaffoldMismatch { index });
            }
            let mut expression_open =
                expect_byte_after_whitespace(source, attribute_end, b'=', index)?;
            expression_open = skip_ascii_whitespace(source, expression_open);
            if source.as_bytes().get(expression_open) != Some(&b'{') {
                return Err(ProjectionError::ScaffoldMismatch { index });
            }
            let sentinel = format!("{}Z{ordinal}_", projection.prefix);
            let sentinel_start = source[expression_open + 1..]
                .find(&sentinel)
                .map(|relative| expression_open + 1 + relative)
                .ok_or(ProjectionError::ScaffoldMismatch { index })?;
            let expression_close = source
                .as_bytes()
                .get(..sentinel_start)
                .ok_or(ProjectionError::ScaffoldMismatch { index })?
                .iter()
                .rposition(|byte| !byte.is_ascii_whitespace())
                .filter(|position| source.as_bytes()[*position] == b'}')
                .ok_or(ProjectionError::ScaffoldMismatch { index })?;
            let expression = trimmed_content_range(source, expression_open + 1, expression_close)?;
            let mut sentinel_end =
                expect_byte_after_whitespace(source, sentinel_start + sentinel.len(), b'=', index)?;
            sentinel_end = expect_byte_after_whitespace(source, sentinel_end, b'{', index)?;
            sentinel_end = expect_word_after_whitespace(source, sentinel_end, b"null", index)?;
            sentinel_end = expect_byte_after_whitespace(source, sentinel_end, b'}', index)?;
            output.push_str(&source[copied..cursor]);
            output.push_str("<{");
            output.push_str(&source[expression.clone()]);
            // A trailing `//` comment needs the line break the engine printed after it, or it
            // comments out the `}`.
            if ends_in_line_comment(&source[expression.clone()]) {
                let gap = &source[expression.end..expression_close];
                output.push_str(if gap.contains(['\n', '\r']) { gap } else { "\n" });
            }
            output.push('}');
            copied = sentinel_end;
            cursor = copied;
            expressions[index] = ScaffoldSpan { start: expression.start, end: expression.end };
            opened[index] = true;
            continue;
        }

        if source[cursor..].starts_with(&style_marker) {
            let digits_start = cursor + style_marker.len();
            let (ordinal, digits_end) =
                parse_decimal(bytes, digits_start).ok_or(ProjectionError::MarkerResidual)?;
            let index = ordinal as usize;
            let manifest = projection.styles.get(index).ok_or(ProjectionError::MarkerResidual)?;
            if styles[index] || source.as_bytes().get(digits_end..digits_end + 4) != Some(b"__*/") {
                return Err(ProjectionError::ScaffoldMismatch { index });
            }
            let mut end = expect_word_after_whitespace(source, digits_end + 4, b"null", index)?;
            end = expect_byte_after_whitespace(source, end, b'}', index)?;
            let payload = original_source
                .get(manifest.payload.start as usize..manifest.payload.end as usize)
                .ok_or(ProjectionError::StructuralMismatch)?;
            output.push_str(&source[copied..cursor]);
            push_raw_payload(&mut output, payload);
            let end = skip_whitespace_before_close(source, end);
            copied = end;
            cursor = end;
            styles[index] = true;
            continue;
        }
        if source[cursor..].starts_with(&script_marker) {
            let digits_start = cursor + script_marker.len();
            let (ordinal, digits_end) =
                parse_decimal(bytes, digits_start).ok_or(ProjectionError::MarkerResidual)?;
            let index = ordinal as usize;
            let manifest = projection.scripts.get(index).ok_or(ProjectionError::MarkerResidual)?;
            if scripts[index] || source.as_bytes().get(digits_end..digits_end + 4) != Some(b"__*/")
            {
                return Err(ProjectionError::ScaffoldMismatch { index });
            }
            let mut end = expect_word_after_whitespace(source, digits_end + 4, b"null", index)?;
            end = expect_byte_after_whitespace(source, end, b'}', index)?;
            let payload = original_source
                .get(manifest.payload.start as usize..manifest.payload.end as usize)
                .ok_or(ProjectionError::StructuralMismatch)?;
            output.push_str(&source[copied..cursor]);
            push_raw_payload(&mut output, payload);
            let end = skip_whitespace_before_close(source, end);
            copied = end;
            cursor = end;
            scripts[index] = true;
            continue;
        }
        cursor += source[cursor..].chars().next().map_or(1, char::len_utf8);
    }
    output.push_str(&source[copied..]);

    for (index, manifest) in projection.dynamics.iter().enumerate() {
        if !opened[index] || (!manifest.self_closing && !closed[index]) {
            return Err(ProjectionError::ScaffoldMismatch { index });
        }
    }
    if styles.iter().any(|seen| !seen) {
        let index = styles.iter().position(|seen| !seen).unwrap_or(0);
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    if scripts.iter().any(|seen| !seen) {
        let index = scripts.iter().position(|seen| !seen).unwrap_or(0);
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    Ok(output)
}

fn push_raw_payload(output: &mut String, payload: &str) {
    let trimmed = output.trim_end_matches(|c: char| c.is_ascii_whitespace()).len();
    if output[..trimmed].ends_with('>') {
        output.truncate(trimmed); // the marker is the only child, so this break is Oxfmt layout, not payload
    }
    output.push_str(payload);
}

fn skip_whitespace_before_close(source: &str, end: usize) -> usize {
    let next = skip_ascii_whitespace(source, end);
    if source[next..].starts_with("</") { next } else { end }
}

/// The dynamic tag expression without its leading and trailing comments, which stay in the
/// opening tag only: copied into the closing tag, the next pass moves them into the children.
fn without_edge_comments(expression: &str) -> &str {
    &expression[dynamic_expression_token_range(expression)]
}

/// Whether the trimmed `expression` ends inside a `//` comment, which would comment out the `}`
/// written straight after it.
fn ends_in_line_comment(expression: &str) -> bool {
    let bytes = expression.as_bytes();
    let mut index = dynamic_expression_token_range(expression).end;
    let mut in_line_comment = false;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
        } else if bytes[index..].starts_with(b"//") {
            index = expression[index..].find(['\n', '\r']).map_or(bytes.len(), |at| index + at);
            in_line_comment = index == bytes.len();
        } else if bytes[index..].starts_with(b"/*") {
            index = expression[index + 2..].find("*/").map_or(bytes.len(), |at| index + at + 4);
            in_line_comment = false;
        } else {
            return false;
        }
    }
    in_line_comment
}

#[cfg(test)]
mod tests {
    use super::{ends_in_line_comment, without_edge_comments};

    #[test]
    fn only_a_trailing_line_comment_needs_a_line_break_before_the_brace() {
        for (expression, expected) in [
            ("Comp // c", true),
            ("Comp /* a */ // c", true),
            ("Comp // c\n/* d */", false),
            ("Comp /* // c */", false),
            ("tags[\"//\"]", false),
            ("pick(/\\//)", false),
            ("// c\nComp", false),
        ] {
            assert_eq!(ends_in_line_comment(expression), expected, "{expression:?}");
        }
    }

    #[test]
    fn edge_comments_come_off_whole_and_inner_text_stays() {
        // Bugbot on tsrx-org/oxc#198: a `/*` inside a trailing comment cut the closing tag at it,
        // and a trailing `//` copied into `</{…}>` would comment out the `}>`.
        for (expression, expected) in [
            ("Comp /* c */", "Comp"),
            ("/* c */ Comp", "Comp"),
            ("Comp /* a /* b */", "Comp"),
            ("Comp // c\n", "Comp"),
            ("// c\nComp // d", "Comp"),
            ("a /* x */.b", "a /* x */.b"),
            ("tags['/*'] /* c */", "tags['/*']"),
            // Bugbot on tsrx-org/oxc#198: a regex body is not a comment.
            ("(/a\\/*b/.test(x) ? A : B) /* c */", "(/a\\/*b/.test(x) ? A : B)"),
            ("pick(x, /[//]/g) // c\n", "pick(x, /[//]/g)"),
            ("a / b / c /* c */", "a / b / c"),
            // A regex after a keyword, and a backtick inside a template substitution.
            ("pick(typeof /\\//) /* c */", "pick(typeof /\\//)"),
            ("tags[`${\"`\"}`] /* c */", "tags[`${\"`\"}`]"),
            ("tags[\"//\"] // c\n", "tags[\"//\"]"),
        ] {
            assert_eq!(without_edge_comments(expression), expected, "{expression:?}");
        }
    }
}

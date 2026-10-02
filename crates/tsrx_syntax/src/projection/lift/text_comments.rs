//! Taking the braces back off the comments in JSX text. `@tsrx/core` 0.5 reads a JavaScript
//! comment in JSX text as a comment, as TSX reads `{/* ... */}`, so the formatter projection wrote
//! each one in braces with a marker after its opener, and Oxfmt formatted it like any other
//! comment child. The lift writes the comment back without the braces or the marker.

use crate::diagnostics::ProjectionError;

use super::{
    super::format::{FormatProjection, Gap},
    text::parse_decimal,
};

/// Oxfmt's spelling of a significant JSX space at a line break.
const SPACER: &str = "{\" \"}";

pub(super) fn lift_text_comments(
    source: &str,
    projection: &FormatProjection,
) -> Result<String, ProjectionError> {
    let bytes = source.as_bytes();
    let needle = format!("{}Y", projection.prefix);
    let line_break = match source.find(['\n', '\r']) {
        Some(index) if source[index..].starts_with("\r\n") => "\r\n",
        Some(index) if bytes[index] == b'\r' => "\r",
        _ => "\n",
    };
    let mut output = String::with_capacity(source.len());
    let (mut copied, mut next) = (0, 0);
    while let Some(relative) = source[copied..].find(&needle) {
        let marker = copied + relative;
        let mismatch = ProjectionError::ScaffoldMismatch { index: next };
        let (ordinal, digits_end) =
            parse_decimal(bytes, marker + needle.len()).ok_or(ProjectionError::MarkerResidual)?;
        let opener = marker.checked_sub(2).ok_or_else(|| mismatch.clone())?;
        let line = &bytes[opener..marker] == b"//";
        if ordinal as usize != next
            || bytes.get(digits_end..digits_end + 2) != Some(b"__")
            || !(line || &bytes[opener..marker] == b"/*")
        {
            return Err(mismatch);
        }
        let body = digits_end + 2;
        let end = if line {
            source[body..].find(['\n', '\r']).map_or(source.len(), |relative| body + relative)
        } else {
            source[body..].find("*/").ok_or_else(|| mismatch.clone())? + body + 2
        };
        let open = source[..opener].trim_end().len();
        let close = source.len() - source[end..].trim_start().len();
        if open <= copied || bytes[open - 1] != b'{' || bytes.get(close) != Some(&b'}') {
            return Err(mismatch);
        }
        let indent = line_indentation(source, open - 1);
        let [before, after] =
            *projection.text_comments.get(next).ok_or_else(|| mismatch.clone())?;
        // Where Oxfmt broke a line the author didn't, the comment goes back onto its line: the
        // whitespace it dropped, and a spacer `{" "}` it wrote, are layout and a space.
        let prefix = &source[copied..open - 1];
        let kept = prefix.trim_end();
        match (before, prefix[kept.len()..].contains(['\n', '\r'])) {
            (Gap::Glued, true) => output.push_str(kept),
            // A spacer on its own line stays: a space at the start of a line is layout.
            (Gap::Spaced, true)
                if kept.strip_suffix(SPACER).is_some_and(|stem| {
                    !stem.trim_end_matches([' ', '\t']).ends_with(['\n', '\r'])
                }) =>
            {
                output.push_str(&kept[..kept.len() - SPACER.len()]);
                output.push(' ');
            }
            _ => output.push_str(prefix),
        }
        // A `//` is a comment after whitespace or a tag, and runs to the end of its line.
        if line && !output.ends_with(|c: char| c.is_ascii_whitespace() || c == '>' || c == '}') {
            output.push_str(line_break);
            output.push_str(indent);
        }
        output.push_str(&source[opener..marker]);
        output.push_str(&source[body..end]);
        if line && !source[close + 1..].trim_start_matches([' ', '\t']).starts_with(['\n', '\r']) {
            output.push_str(line_break);
            output.push_str(indent);
        }
        copied = close + 1;
        // A line break the author wrote after a block comment, which Oxfmt dropped, is layout.
        if !line
            && after == Gap::Layout
            && source[copied..].starts_with(|c: char| !c.is_ascii_whitespace())
        {
            output.push_str(line_break);
            output.push_str(indent);
        }
        next += 1;
    }
    if next != projection.text_comments.len() {
        return Err(ProjectionError::ScaffoldMismatch { index: next });
    }
    output.push_str(&source[copied..]);
    Ok(output)
}

fn line_indentation(source: &str, position: usize) -> &str {
    let line_start = source[..position].rfind(['\n', '\r']).map_or(0, |index| index + 1);
    let line = &source[line_start..position];
    &line[..line.len() - line.trim_start_matches([' ', '\t']).len()]
}

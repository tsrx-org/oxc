use crate::diagnostics::ProjectionError;

use super::{
    super::format::FormatProjection,
    text::{line_indent, trimmed_content_range},
    writer::LiftWriter,
};

/// Takes each `@case` and `@default` expression container out of the marked element the
/// projection wrote it in, with the `;` on either side, and dedents it by the level Oxfmt
/// indented it inside that element. Inner containers carry higher ordinals, so lifting from the
/// last one keeps every outer element's offsets valid until its own turn.
pub(super) fn lift_case_expressions(
    lifted: String,
    projection: &FormatProjection,
) -> Result<String, ProjectionError> {
    let mut lifted = lifted;
    for index in (0..projection.case_expressions).rev() {
        let open = format!("<{}Q{index}>", projection.prefix);
        let close = format!("</{}Q{index}>", projection.prefix);
        let open_start = find_once(&lifted, &open, index)?;
        let close_start = find_once(&lifted, &close, index)?;
        let open_end = open_start + open.len();
        if close_start < open_end {
            return Err(ProjectionError::MarkerReordered { index });
        }
        let content = trimmed_content_range(&lifted, open_end, close_start)?;
        let bytes = lifted.as_bytes();
        if bytes[content.start] != b'{' || bytes[content.end - 1] != b'}' {
            return Err(ProjectionError::ScaffoldMismatch { index });
        }
        // Oxfmt's ASI guard under `semi: false`, which leads its line.
        let guard = open_start.checked_sub(1).filter(|&semicolon| {
            bytes[semicolon] == b';'
                && bytes[..semicolon]
                    .iter()
                    .rev()
                    .take_while(|byte| !matches!(byte, b'\n' | b'\r'))
                    .all(u8::is_ascii_whitespace)
        });
        let replace_start = guard.unwrap_or(open_start);
        let mut replace_end = close_start + close.len();
        if bytes.get(replace_end) == Some(&b';') {
            replace_end += 1;
        }
        let dedent = if bytes[open_end..content.start].contains(&b'\n') {
            line_indent(&lifted, content.start).saturating_sub(line_indent(&lifted, open_start))
        } else {
            0
        };
        let mut writer = LiftWriter::new(content.len());
        writer.write(&lifted[content.clone()], dedent);
        let expression = writer.finish()?;
        lifted.replace_range(replace_start..replace_end, &expression);
    }
    Ok(lifted)
}

fn find_once(source: &str, marker: &str, index: usize) -> Result<usize, ProjectionError> {
    let start = source.find(marker).ok_or(ProjectionError::MarkerMissing { index })?;
    if source[start + marker.len()..].contains(marker) {
        return Err(ProjectionError::MarkerDuplicated { index });
    }
    Ok(start)
}

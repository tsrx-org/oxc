//! Proving a projection is the authored source plus an enumerated set of generated gaps, and
//! nothing else.

use tsrx_syntax::{
    ByteSpan, NONE_INDEX, OverlayView, ParserDynamicKind, ProjectionView, StructuralKind,
};

use crate::TsrxParseError;

use super::text::slice;

pub(crate) fn validate_projection(
    source: &str,
    view: ProjectionView<'_>,
    overlay: OverlayView<'_>,
) -> Result<(), TsrxParseError> {
    if view.segments.is_empty() {
        return Err(TsrxParseError::Unsupported("projection has no affine source"));
    }
    let source_len = u32::try_from(source.len())
        .map_err(|_| TsrxParseError::Unsupported("source above 4 GiB"))?;
    let projected_len = u32::try_from(view.source.len())
        .map_err(|_| TsrxParseError::Unsupported("projection above 4 GiB"))?;
    let allowed_gaps = build_allowed_gaps(source, overlay, source_len)?;
    let mut gap_index = 0_usize;
    let mut original_cursor = 0_u32;
    let mut projected_cursor = 0_u32;
    for segment in view.segments {
        let length = segment
            .projected
            .end
            .checked_sub(segment.projected.start)
            .ok_or(TsrxParseError::Unsupported("reversed projection segment"))?;
        let original_end = segment
            .original_start
            .checked_add(length)
            .ok_or(TsrxParseError::Unsupported("projection span overflow"))?;
        if segment.projected.start < projected_cursor
            || segment.projected.end > projected_len
            || segment.original_start < original_cursor
            || original_end > source_len
            || !segment.fixable
            || !consume_allowed_gap(
                original_cursor,
                segment.original_start,
                &allowed_gaps,
                &mut gap_index,
            )
        {
            return Err(TsrxParseError::Unsupported("non-canonical affine projection map"));
        }
        let projected = slice(view.source, segment.projected.start, segment.projected.end)?;
        let authored = slice(source, segment.original_start, original_end)?;
        if projected != authored {
            return Err(TsrxParseError::Unsupported(
                "affine projection bytes differ from authored source",
            ));
        }
        projected_cursor = segment.projected.end;
        original_cursor = original_end;
    }
    if !consume_allowed_gap(original_cursor, source_len, &allowed_gaps, &mut gap_index)
        || gap_index != allowed_gaps.len()
    {
        return Err(TsrxParseError::Unsupported(
            "projection omitted non-structural authored bytes",
        ));
    }
    Ok(())
}

#[expect(
    clippy::too_many_lines,
    reason = "one pass that walks the overlay and the authored source in lockstep"
)]
fn build_allowed_gaps(
    source: &str,
    overlay: OverlayView<'_>,
    source_len: u32,
) -> Result<Vec<ByteSpan>, TsrxParseError> {
    let mut token_gaps = Vec::with_capacity(overlay.tokens.len());
    for token in overlay.tokens {
        let omitted_length = match token.kind {
            StructuralKind::Try => 4,
            StructuralKind::Empty | StructuralKind::Catch => 6,
            StructuralKind::Pending => 8,
            _ => 1,
        };
        let end = token
            .span
            .start
            .checked_add(omitted_length)
            .ok_or(TsrxParseError::Unsupported("structural token span overflow"))?;
        if token.span.start >= end || end > source_len {
            return Err(TsrxParseError::Unsupported("invalid structural token gap"));
        }
        token_gaps.push(ByteSpan::new(token.span.start, end));
    }
    for pattern in overlay.parser_lazy_patterns {
        if pattern.ampersand >= pattern.pattern_start || pattern.pattern_start > source_len {
            return Err(TsrxParseError::Unsupported("invalid lazy pattern gap"));
        }
        token_gaps.push(ByteSpan::new(pattern.ampersand, pattern.ampersand.saturating_add(1)));
    }
    token_gaps.sort_unstable_by_key(|gap| gap.start);
    let mut header_gaps = Vec::with_capacity(overlay.clauses.len().saturating_mul(2));
    for node in overlay.nodes {
        let mut clause_index = node.first_clause;
        while clause_index != NONE_INDEX {
            let clause = usize::try_from(clause_index)
                .ok()
                .and_then(|index| overlay.clauses.get(index))
                .ok_or(TsrxParseError::Unsupported("header gap has no owning clause"))?;
            let header = clause.for_header;
            if header.annotated {
                let mut cursor = clause.header.start;
                for span in [header.left, header.right, header.index, header.key] {
                    if span.is_empty() {
                        continue;
                    }
                    if span.start < cursor || clause.header.end < span.end {
                        return Err(TsrxParseError::Unsupported(
                            "annotated for values are out of source order",
                        ));
                    }
                    if cursor < span.start {
                        header_gaps.push(ByteSpan::new(cursor, span.start));
                    }
                    cursor = span.end;
                }
                if cursor < clause.header.end {
                    header_gaps.push(ByteSpan::new(cursor, clause.header.end));
                }
            }
            clause_index = clause.next;
        }
    }
    let mut dynamic_gaps = Vec::with_capacity(overlay.parser_dynamic.len());
    for token in overlay.parser_dynamic {
        add_parser_dynamic_gap(source, source_len, overlay, *token, &mut dynamic_gaps)?;
    }

    // Embedded payload tokens are emitted in source order across both languages. Preserve that
    // shared order: collecting style and script gaps in separate passes would group by language
    // and make a valid script-before-style module appear to contain overlapping gaps.
    let mut embedded_gaps =
        Vec::with_capacity(overlay.style_blocks.len().saturating_add(overlay.script_blocks.len()));
    for token in overlay.embedded {
        let content = match token.kind {
            tsrx_syntax::EmbeddedKind::StyleContent => {
                let style = usize::try_from(token.owner)
                    .ok()
                    .and_then(|index| overlay.style_blocks.get(index))
                    .ok_or(TsrxParseError::Unsupported("style gap has no owner"))?;
                validate_style_source(source, source_len, *style)?;
                if style.content != token.span {
                    return Err(TsrxParseError::Unsupported(
                        "style gap differs from its payload token",
                    ));
                }
                style.content
            }
            tsrx_syntax::EmbeddedKind::ScriptContent => {
                let script = usize::try_from(token.owner)
                    .ok()
                    .and_then(|index| overlay.script_blocks.get(index))
                    .ok_or(TsrxParseError::Unsupported("script gap has no owner"))?;
                if script.content != token.span
                    || script.element.end > source_len
                    || source
                        .as_bytes()
                        .get(script.element.start as usize..script.element.start as usize + 7)
                        != Some(b"<script")
                    || source
                        .as_bytes()
                        .get(script.content.end as usize..script.element.end as usize)
                        != Some(b"</script>")
                {
                    return Err(TsrxParseError::Unsupported(
                        "script gap differs from its payload token",
                    ));
                }
                script.content
            }
            tsrx_syntax::EmbeddedKind::DynamicOpen | tsrx_syntax::EmbeddedKind::DynamicClose => {
                continue;
            }
        };
        if !content.is_empty() {
            embedded_gaps.push(content);
        }
    }
    for style in overlay.style_blocks.iter().filter(|style| style.self_closing) {
        validate_style_source(source, source_len, *style)?;
    }

    let streams = [
        token_gaps.as_slice(),
        header_gaps.as_slice(),
        dynamic_gaps.as_slice(),
        embedded_gaps.as_slice(),
    ];
    let mut cursors = [0_usize; 4];
    let total = streams.iter().map(|stream| stream.len()).sum();
    let mut merged = Vec::with_capacity(total);
    loop {
        let mut selected = None;
        for (stream_index, stream) in streams.iter().enumerate() {
            let Some(gap) = stream.get(cursors[stream_index]) else {
                continue;
            };
            if selected.is_none_or(|(_, current): (usize, ByteSpan)| gap.start < current.start) {
                selected = Some((stream_index, *gap));
            }
        }
        let Some((stream_index, gap)) = selected else {
            break;
        };
        cursors[stream_index] += 1;
        push_merged_gap(&mut merged, gap)?;
    }
    Ok(merged)
}

fn validate_style_source(
    source: &str,
    source_len: u32,
    style: tsrx_syntax::OverlayStyleBlock,
) -> Result<(), TsrxParseError> {
    if style.element.end > source_len || style.content.end > source_len {
        return Err(TsrxParseError::Unsupported("style span lies outside authored source"));
    }
    let opening_end = if style.self_closing { style.element.end } else { style.content.start };
    let opening = slice(source, style.element.start, opening_end)?;
    let boundary = opening.as_bytes().get("<style".len()).copied();
    if !opening.starts_with("<style")
        || !boundary.is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
        || if style.self_closing {
            !opening.ends_with("/>")
        } else {
            !opening.ends_with('>')
                || slice(source, style.content.end, style.element.end)? != "</style>"
        }
    {
        return Err(TsrxParseError::Unsupported("style source boundary is not canonical"));
    }
    Ok(())
}

fn push_merged_gap(merged: &mut Vec<ByteSpan>, gap: ByteSpan) -> Result<(), TsrxParseError> {
    if let Some(previous) = merged.last_mut() {
        if gap.start < previous.end {
            return Err(TsrxParseError::Unsupported("overlapping structural projection gaps"));
        }
        if gap.start == previous.end {
            previous.end = gap.end;
            return Ok(());
        }
    }
    merged.push(gap);
    Ok(())
}

fn add_parser_dynamic_gap(
    source: &str,
    source_len: u32,
    overlay: OverlayView<'_>,
    token: tsrx_syntax::ParserDynamicToken,
    gaps: &mut Vec<ByteSpan>,
) -> Result<(), TsrxParseError> {
    let tag = usize::try_from(token.owner)
        .ok()
        .and_then(|index| overlay.dynamic_tags.get(index))
        .ok_or(TsrxParseError::Unsupported("parser dynamic gap has no owner"))?;
    let (gap, expected) = match token.kind {
        ParserDynamicKind::OpenStart => {
            (ByteSpan::new(tag.opening.start, tag.expression.start), b"<{".as_slice())
        }
        ParserDynamicKind::OpenEnd => {
            (ByteSpan::new(tag.expression.end, tag.opening.end), b"}".as_slice())
        }
        ParserDynamicKind::CloseStart => {
            (ByteSpan::new(tag.closing.start, tag.closing_expression.start), b"</{".as_slice())
        }
        ParserDynamicKind::CloseEnd => {
            let gap = ByteSpan::new(tag.closing_expression.end, tag.closing.end);
            if gap.start >= gap.end || gap.end > source_len {
                return Err(TsrxParseError::Unsupported("invalid parser dynamic closing gap"));
            }
            let suffix = source.as_bytes().get(gap.start as usize..gap.end as usize).ok_or(
                TsrxParseError::Unsupported("parser dynamic closing gap lies outside source"),
            )?;
            if suffix.first() != Some(&b'}')
                || suffix.last() != Some(&b'>')
                || !suffix[1..suffix.len() - 1].iter().all(u8::is_ascii_whitespace)
            {
                return Err(TsrxParseError::AuthoredGrammar(
                    "parser dynamic closing suffix is malformed".to_string(),
                ));
            }
            gaps.push(gap);
            return Ok(());
        }
    };
    if gap.start >= gap.end
        || gap.end > source_len
        || source.as_bytes().get(gap.start as usize..gap.end as usize) != Some(expected)
    {
        return Err(TsrxParseError::Unsupported("parser dynamic boundary gap is malformed"));
    }
    gaps.push(gap);
    Ok(())
}

fn consume_allowed_gap(start: u32, end: u32, allowed: &[ByteSpan], index: &mut usize) -> bool {
    let mut cursor = start;
    while cursor < end {
        let Some(gap) = allowed.get(*index) else {
            return false;
        };
        if gap.start != cursor || gap.end <= cursor || gap.end > end {
            return false;
        }
        cursor = gap.end;
        *index += 1;
    }
    cursor == end
}

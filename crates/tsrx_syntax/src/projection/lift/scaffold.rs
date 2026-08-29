use crate::{
    diagnostics::ProjectionError,
    model::{ControlContext, NONE, StructuralKind},
};

use super::{
    super::format::{FormatProjection, HeaderManifest, TryManifest, WrapperManifest},
    ScaffoldSpan,
    text::{
        expect_byte_after_whitespace, expect_word_after_whitespace, line_indent, parse_decimal,
        previous_non_whitespace, scaffold_call_end, skip_ascii_whitespace, trimmed_content_range,
    },
    writer::LiftWriter,
};

#[derive(Clone, Copy)]
struct IndexedWrapper {
    wrapper: ScaffoldSpan,
    method: ScaffoldSpan,
    start_marker: ScaffoldSpan,
    end_marker: ScaffoldSpan,
    end_sentinel: ScaffoldSpan,
}

impl Default for IndexedWrapper {
    fn default() -> Self {
        Self {
            wrapper: ScaffoldSpan::MISSING,
            method: ScaffoldSpan::MISSING,
            start_marker: ScaffoldSpan::MISSING,
            end_marker: ScaffoldSpan::MISSING,
            end_sentinel: ScaffoldSpan::MISSING,
        }
    }
}

#[derive(Clone, Copy)]
struct IndexedHeader {
    helper: ScaffoldSpan,
    right_start: ScaffoldSpan,
    right_end: ScaffoldSpan,
    index_helper: ScaffoldSpan,
    index_start: ScaffoldSpan,
    index_end: ScaffoldSpan,
    key_helper: ScaffoldSpan,
    key_start: ScaffoldSpan,
    key_end: ScaffoldSpan,
    end_sentinel: ScaffoldSpan,
}

#[derive(Clone, Copy)]
struct IndexedTry {
    call: ScaffoldSpan,
    body_method: ScaffoldSpan,
    pending_method: ScaffoldSpan,
    catch_method: ScaffoldSpan,
    end_sentinel: ScaffoldSpan,
    try_marker: ScaffoldSpan,
    pending_marker: ScaffoldSpan,
    catch_marker: ScaffoldSpan,
}

struct IndexedScaffolds {
    wrappers: Vec<IndexedWrapper>,
    headers: Vec<IndexedHeader>,
    tries: Vec<IndexedTry>,
}

impl Default for IndexedTry {
    fn default() -> Self {
        Self {
            call: ScaffoldSpan::MISSING,
            body_method: ScaffoldSpan::MISSING,
            pending_method: ScaffoldSpan::MISSING,
            catch_method: ScaffoldSpan::MISSING,
            end_sentinel: ScaffoldSpan::MISSING,
            try_marker: ScaffoldSpan::MISSING,
            pending_marker: ScaffoldSpan::MISSING,
            catch_marker: ScaffoldSpan::MISSING,
        }
    }
}

#[derive(Clone, Copy)]
enum WrapperReplacement {
    Empty,
    Try,
}

impl WrapperReplacement {
    const fn text(self) -> &'static str {
        match self {
            Self::Empty => "",
            Self::Try => "@try ",
        }
    }
}

impl Default for IndexedHeader {
    fn default() -> Self {
        Self {
            helper: ScaffoldSpan::MISSING,
            right_start: ScaffoldSpan::MISSING,
            right_end: ScaffoldSpan::MISSING,
            index_helper: ScaffoldSpan::MISSING,
            index_start: ScaffoldSpan::MISSING,
            index_end: ScaffoldSpan::MISSING,
            key_helper: ScaffoldSpan::MISSING,
            key_start: ScaffoldSpan::MISSING,
            key_end: ScaffoldSpan::MISSING,
            end_sentinel: ScaffoldSpan::MISSING,
        }
    }
}

#[derive(Clone, Copy)]
struct WrapperEdit {
    index: usize,
    replace_start: usize,
    content_start: usize,
    content_end: usize,
    replace_end: usize,
    dedent: usize,
    replacement: WrapperReplacement,
}

#[derive(Clone, Copy)]
enum EditReplacement {
    Empty,
    Index,
    Key,
    Pending,
    Catch,
}

impl EditReplacement {
    const fn text(self) -> &'static str {
        match self {
            Self::Empty => "",
            Self::Index => "; index ",
            Self::Key => "; key ",
            Self::Pending => " @pending ",
            Self::Catch => " @catch ",
        }
    }
}

#[derive(Clone, Copy)]
struct ScaffoldEdit {
    index: usize,
    start: usize,
    end: usize,
    replacement: EditReplacement,
}

pub(super) fn lift_scaffolds(
    formatted: &str,
    projection: &FormatProjection,
) -> Result<String, ProjectionError> {
    if projection.wrappers.is_empty()
        && projection.headers.is_empty()
        && projection.tries.is_empty()
    {
        return Ok(formatted.to_string());
    }
    let indexed = index_scaffolds(formatted, projection)?;
    let regular_wrappers = projection
        .wrappers
        .iter()
        .copied()
        .zip(indexed.wrappers)
        .map(|(manifest, positions)| wrapper_edit(formatted, manifest, positions))
        .collect::<Result<Vec<_>, _>>()?;
    let try_wrappers = projection
        .tries
        .iter()
        .copied()
        .zip(indexed.tries.iter().copied())
        .map(|(manifest, positions)| try_wrapper_edit(formatted, manifest, positions))
        .collect::<Result<Vec<_>, _>>()?;
    let wrappers = merge_wrappers(regular_wrappers, try_wrappers);

    let mut header_edits = Vec::with_capacity(projection.headers.len().saturating_mul(4));
    for (manifest, positions) in projection.headers.iter().copied().zip(indexed.headers) {
        append_header_edits(formatted, manifest, positions, &mut header_edits)?;
    }
    let mut try_edits = Vec::with_capacity(projection.tries.len().saturating_mul(2));
    for (token_index, token) in projection.tokens.iter().copied().enumerate() {
        if !matches!(token.kind, StructuralKind::Pending | StructuralKind::Catch) {
            continue;
        }
        let slot = try_slot(projection, token.owner)?;
        let manifest = projection.tries[slot];
        let positions = indexed.tries[slot];
        try_edits.push(try_clause_edit(formatted, token_index, token.kind, manifest, positions)?);
    }
    let edits = merge_edits(header_edits, try_edits);
    render_scaffolds(formatted, &wrappers, &edits)
}

#[expect(
    clippy::too_many_lines,
    reason = "one indexing pass over every scaffold kind the lift can emit"
)]
fn index_scaffolds(
    source: &str,
    projection: &FormatProjection,
) -> Result<IndexedScaffolds, ProjectionError> {
    let mut wrappers = vec![IndexedWrapper::default(); projection.wrappers.len()];
    let mut headers = vec![IndexedHeader::default(); projection.headers.len()];
    let mut tries = vec![IndexedTry::default(); projection.tries.len()];
    let bytes = source.as_bytes();
    let mut cursor = 0usize;
    while let Some(relative) = source[cursor..].find(&projection.prefix) {
        let prefix_start = cursor + relative;
        let suffix_start = prefix_start + projection.prefix.len();
        let Some(&kind) = bytes.get(suffix_start) else {
            return Err(ProjectionError::MarkerResidual);
        };
        match kind {
            b'0'..=b'9' => {
                let (token_index, span) =
                    parse_token_marker_occurrence(bytes, prefix_start, suffix_start)
                        .ok_or(ProjectionError::MarkerResidual)?;
                let token = *projection
                    .tokens
                    .get(token_index as usize)
                    .ok_or(ProjectionError::MarkerResidual)?;
                if matches!(
                    token.kind,
                    StructuralKind::Try | StructuralKind::Pending | StructuralKind::Catch
                ) {
                    let slot = try_slot(projection, token.owner)?;
                    let target = match token.kind {
                        StructuralKind::Try => &mut tries[slot].try_marker,
                        StructuralKind::Pending => &mut tries[slot].pending_marker,
                        StructuralKind::Catch => &mut tries[slot].catch_marker,
                        _ => unreachable!(),
                    };
                    set_scaffold_span(target, span, token_index as usize)?;
                }
            }
            b'W' | b'M' | b'E' => {
                let (node, span) =
                    parse_identifier_occurrence(bytes, prefix_start, suffix_start + 1)
                        .ok_or(ProjectionError::MarkerResidual)?;
                let slot = wrapper_slot(projection, node)?;
                let target = match kind {
                    b'W' => &mut wrappers[slot].wrapper,
                    b'M' => &mut wrappers[slot].method,
                    b'E' => &mut wrappers[slot].end_sentinel,
                    _ => unreachable!(),
                };
                set_scaffold_span(target, span, node as usize)?;
            }
            b'N' => {
                let (node, side, span) =
                    parse_marker_occurrence(bytes, prefix_start, suffix_start + 1)
                        .ok_or(ProjectionError::MarkerResidual)?;
                let slot = wrapper_slot(projection, node)?;
                let target = match side {
                    b'S' => &mut wrappers[slot].start_marker,
                    b'E' => &mut wrappers[slot].end_marker,
                    _ => return Err(ProjectionError::MarkerResidual),
                };
                set_scaffold_span(target, span, node as usize)?;
            }
            b'H' if bytes.get(suffix_start + 1) == Some(&b'E') => {
                let (ordinal, span) =
                    parse_identifier_occurrence(bytes, prefix_start, suffix_start + 2)
                        .ok_or(ProjectionError::MarkerResidual)?;
                let positions = header_positions_mut(&mut headers, ordinal)?;
                set_scaffold_span(&mut positions.end_sentinel, span, ordinal as usize)?;
            }
            b'H' => {
                let (ordinal, span) =
                    parse_identifier_occurrence(bytes, prefix_start, suffix_start + 1)
                        .ok_or(ProjectionError::MarkerResidual)?;
                set_scaffold_span(
                    &mut header_positions_mut(&mut headers, ordinal)?.helper,
                    span,
                    ordinal as usize,
                )?;
            }
            b'I' if bytes.get(suffix_start + 1) == Some(&b'H') => {
                let (ordinal, span) =
                    parse_identifier_occurrence(bytes, prefix_start, suffix_start + 2)
                        .ok_or(ProjectionError::MarkerResidual)?;
                set_scaffold_span(
                    &mut header_positions_mut(&mut headers, ordinal)?.index_helper,
                    span,
                    ordinal as usize,
                )?;
            }
            b'K' if bytes.get(suffix_start + 1) == Some(&b'H') => {
                let (ordinal, span) =
                    parse_identifier_occurrence(bytes, prefix_start, suffix_start + 2)
                        .ok_or(ProjectionError::MarkerResidual)?;
                set_scaffold_span(
                    &mut header_positions_mut(&mut headers, ordinal)?.key_helper,
                    span,
                    ordinal as usize,
                )?;
            }
            b'R' | b'I' | b'K' => {
                let (ordinal, side, span) =
                    parse_marker_occurrence(bytes, prefix_start, suffix_start + 1)
                        .ok_or(ProjectionError::MarkerResidual)?;
                let positions = header_positions_mut(&mut headers, ordinal)?;
                let target = match (kind, side) {
                    (b'R', b'S') => &mut positions.right_start,
                    (b'R', b'E') => &mut positions.right_end,
                    (b'I', b'S') => &mut positions.index_start,
                    (b'I', b'E') => &mut positions.index_end,
                    (b'K', b'S') => &mut positions.key_start,
                    (b'K', b'E') => &mut positions.key_end,
                    _ => return Err(ProjectionError::MarkerResidual),
                };
                set_scaffold_span(target, span, ordinal as usize)?;
            }
            b'T' if bytes.get(suffix_start + 1) == Some(&b'E') => {
                let (node, span) =
                    parse_identifier_occurrence(bytes, prefix_start, suffix_start + 2)
                        .ok_or(ProjectionError::MarkerResidual)?;
                let slot = try_slot(projection, node)?;
                set_scaffold_span(&mut tries[slot].end_sentinel, span, node as usize)?;
            }
            b'T' | b'B' | b'P' | b'C' => {
                let (node, span) =
                    parse_identifier_occurrence(bytes, prefix_start, suffix_start + 1)
                        .ok_or(ProjectionError::MarkerResidual)?;
                let slot = try_slot(projection, node)?;
                let target = match kind {
                    b'T' => &mut tries[slot].call,
                    b'B' => &mut tries[slot].body_method,
                    b'P' => &mut tries[slot].pending_method,
                    b'C' => &mut tries[slot].catch_method,
                    _ => unreachable!(),
                };
                set_scaffold_span(target, span, node as usize)?;
            }
            b'D' | b'A' | b'Z' | b'Q' | b'S' | b'L' => {}
            _ => return Err(ProjectionError::MarkerResidual),
        }
        cursor = suffix_start + 1;
    }

    for (manifest, positions) in projection.wrappers.iter().copied().zip(&wrappers) {
        if positions.wrapper.is_missing()
            || positions.method.is_missing()
            || positions.start_marker.is_missing()
            || positions.end_marker.is_missing()
            || positions.end_sentinel.is_missing()
        {
            return Err(ProjectionError::ScaffoldMismatch { index: manifest.node as usize });
        }
    }
    for (manifest, positions) in projection.headers.iter().copied().zip(&headers) {
        let index_positions = [positions.index_helper, positions.index_start, positions.index_end];
        let key_positions = [positions.key_helper, positions.key_start, positions.key_end];
        let index_positions_valid = if manifest.has_index {
            index_positions.iter().all(|span| !span.is_missing())
        } else {
            index_positions.iter().all(|span| span.is_missing())
        };
        let key_positions_valid = if manifest.has_key {
            key_positions.iter().all(|span| !span.is_missing())
        } else {
            key_positions.iter().all(|span| span.is_missing())
        };
        if positions.helper.is_missing()
            || positions.right_start.is_missing()
            || positions.right_end.is_missing()
            || positions.end_sentinel.is_missing()
            || !index_positions_valid
            || !key_positions_valid
        {
            return Err(ProjectionError::ScaffoldMismatch { index: manifest.ordinal as usize });
        }
    }
    for (manifest, positions) in projection.tries.iter().copied().zip(&tries) {
        let pending_valid = if manifest.has_pending() {
            !positions.pending_method.is_missing() && !positions.pending_marker.is_missing()
        } else {
            positions.pending_method.is_missing() && positions.pending_marker.is_missing()
        };
        let catch_valid = if manifest.has_catch() {
            !positions.catch_method.is_missing() && !positions.catch_marker.is_missing()
        } else {
            positions.catch_method.is_missing() && positions.catch_marker.is_missing()
        };
        if positions.call.is_missing()
            || positions.body_method.is_missing()
            || positions.end_sentinel.is_missing()
            || positions.try_marker.is_missing()
            || !pending_valid
            || !catch_valid
        {
            return Err(ProjectionError::ScaffoldMismatch { index: manifest.node as usize });
        }
    }
    Ok(IndexedScaffolds { wrappers, headers, tries })
}

fn wrapper_slot(projection: &FormatProjection, node: u32) -> Result<usize, ProjectionError> {
    projection
        .wrappers
        .binary_search_by_key(&node, |wrapper| wrapper.node)
        .map_err(|_| ProjectionError::ScaffoldMismatch { index: node as usize })
}

fn try_slot(projection: &FormatProjection, node: u32) -> Result<usize, ProjectionError> {
    let slot = *projection
        .try_slots
        .get(node as usize)
        .ok_or(ProjectionError::ScaffoldMismatch { index: node as usize })?;
    if slot == NONE {
        return Err(ProjectionError::ScaffoldMismatch { index: node as usize });
    }
    Ok(slot as usize)
}

fn header_positions_mut(
    headers: &mut [IndexedHeader],
    ordinal: u32,
) -> Result<&mut IndexedHeader, ProjectionError> {
    headers
        .get_mut(ordinal as usize)
        .ok_or(ProjectionError::ScaffoldMismatch { index: ordinal as usize })
}

fn set_scaffold_span(
    target: &mut ScaffoldSpan,
    value: ScaffoldSpan,
    index: usize,
) -> Result<(), ProjectionError> {
    if !target.is_missing() {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    *target = value;
    Ok(())
}

fn parse_identifier_occurrence(
    bytes: &[u8],
    prefix_start: usize,
    digits_start: usize,
) -> Option<(u32, ScaffoldSpan)> {
    let (ordinal, digits_end) = parse_decimal(bytes, digits_start)?;
    (bytes.get(digits_end) == Some(&b'_'))
        .then_some((ordinal, ScaffoldSpan { start: prefix_start, end: digits_end + 1 }))
}

fn parse_token_marker_occurrence(
    bytes: &[u8],
    prefix_start: usize,
    digits_start: usize,
) -> Option<(u32, ScaffoldSpan)> {
    let (ordinal, digits_end) = parse_decimal(bytes, digits_start)?;
    if prefix_start < 2
        || bytes.get(prefix_start - 2..prefix_start) != Some(b"/*")
        || bytes.get(digits_end..digits_end + 2) != Some(b"*/")
    {
        return None;
    }
    Some((ordinal, ScaffoldSpan { start: prefix_start - 2, end: digits_end + 2 }))
}

fn parse_marker_occurrence(
    bytes: &[u8],
    prefix_start: usize,
    digits_start: usize,
) -> Option<(u32, u8, ScaffoldSpan)> {
    let (ordinal, digits_end) = parse_decimal(bytes, digits_start)?;
    let side = *bytes.get(digits_end)?;
    if !matches!(side, b'S' | b'E')
        || bytes.get(digits_end + 1..digits_end + 5) != Some(b"__*/")
        || prefix_start < 2
        || bytes.get(prefix_start - 2..prefix_start) != Some(b"/*")
    {
        return None;
    }
    Some((ordinal, side, ScaffoldSpan { start: prefix_start - 2, end: digits_end + 5 }))
}

// A projected `@for` header is one helper call wrapping up to two more:
// `_H0_(right, _IH0_(index), _KH0_(key), _HE0_)`. Canonical Oxfmt breaks any call
// whose arguments do not fit the print width, and a broken call gets a trailing
// comma after its last argument. That happens to the two inner calls exactly when
// the header sits deep enough to run long, which is why a wide `key` expression or
// a header nested a couple of element levels inside a `@try` arm reached this code
// with a comma between the key expression and the inner `)`. Every other scaffold
// close here already tolerates that comma through `scaffold_call_end`; the two
// inner header calls are read with it for the same reason.
fn append_header_edits(
    source: &str,
    manifest: HeaderManifest,
    positions: IndexedHeader,
    edits: &mut Vec<ScaffoldEdit>,
) -> Result<(), ProjectionError> {
    let index = manifest.ordinal as usize;
    let mut cursor = expect_byte_after_whitespace(source, positions.helper.end, b'(', index)?;
    let _ = expect_span_after_whitespace(source, cursor, positions.right_start, index)?;
    let right =
        trimmed_content_range(source, positions.right_start.end, positions.right_end.start)?;
    cursor = positions.right_end.end;

    let annotation_index = if manifest.has_index {
        cursor = expect_byte_after_whitespace(source, cursor, b',', index)?;
        cursor = expect_span_after_whitespace(source, cursor, positions.index_helper, index)?;
        cursor = expect_byte_after_whitespace(source, cursor, b'(', index)?;
        let _ = expect_span_after_whitespace(source, cursor, positions.index_start, index)?;
        let content =
            trimmed_content_range(source, positions.index_start.end, positions.index_end.start)?;
        cursor = scaffold_call_end(source, positions.index_end.end, index)?;
        Some(content)
    } else {
        None
    };
    let key = if manifest.has_key {
        cursor = expect_byte_after_whitespace(source, cursor, b',', index)?;
        cursor = expect_span_after_whitespace(source, cursor, positions.key_helper, index)?;
        cursor = expect_byte_after_whitespace(source, cursor, b'(', index)?;
        let _ = expect_span_after_whitespace(source, cursor, positions.key_start, index)?;
        let content =
            trimmed_content_range(source, positions.key_start.end, positions.key_end.start)?;
        cursor = scaffold_call_end(source, positions.key_end.end, index)?;
        Some(content)
    } else {
        None
    };
    cursor = expect_byte_after_whitespace(source, cursor, b',', index)?;
    let _ = expect_span_after_whitespace(source, cursor, positions.end_sentinel, index)?;
    let call_end = scaffold_call_end(source, positions.end_sentinel.end, index)?;

    edits.push(ScaffoldEdit {
        index,
        start: positions.helper.start,
        end: right.start,
        replacement: EditReplacement::Empty,
    });
    let mut previous_end = right.end;
    if let Some(annotation_index) = annotation_index {
        edits.push(ScaffoldEdit {
            index,
            start: previous_end,
            end: annotation_index.start,
            replacement: EditReplacement::Index,
        });
        previous_end = annotation_index.end;
    }
    if let Some(key) = key {
        edits.push(ScaffoldEdit {
            index,
            start: previous_end,
            end: key.start,
            replacement: EditReplacement::Key,
        });
        previous_end = key.end;
    }
    edits.push(ScaffoldEdit {
        index,
        start: previous_end,
        end: call_end,
        replacement: EditReplacement::Empty,
    });
    Ok(())
}

fn try_wrapper_edit(
    source: &str,
    manifest: TryManifest,
    positions: IndexedTry,
) -> Result<WrapperEdit, ProjectionError> {
    let index = manifest.node as usize;
    let mut cursor =
        expect_span_after_whitespace(source, positions.try_marker.end, positions.call, index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'(', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'{', index)?;
    cursor = expect_word_after_whitespace(source, cursor, b"async", index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'*', index)?;
    cursor = expect_span_after_whitespace(source, cursor, positions.body_method, index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'(', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b')', index)?;
    let content_start = skip_ascii_whitespace(source, cursor);
    if source.as_bytes().get(content_start) != Some(&b'{') {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }

    let separator = previous_non_whitespace(source, positions.end_sentinel.start)
        .filter(|position| source.as_bytes()[*position] == b',')
        .ok_or(ProjectionError::ScaffoldMismatch { index })?;
    let object_close = previous_non_whitespace(source, separator)
        .filter(|position| source.as_bytes()[*position] == b'}')
        .ok_or(ProjectionError::ScaffoldMismatch { index })?;
    let before_object = previous_non_whitespace(source, object_close)
        .ok_or(ProjectionError::ScaffoldMismatch { index })?;
    let body_close = if source.as_bytes()[before_object] == b',' {
        previous_non_whitespace(source, before_object)
            .filter(|position| source.as_bytes()[*position] == b'}')
            .ok_or(ProjectionError::ScaffoldMismatch { index })?
    } else if source.as_bytes()[before_object] == b'}' {
        before_object
    } else {
        return Err(ProjectionError::ScaffoldMismatch { index });
    };
    let content_end = body_close + 1;
    let call_end = scaffold_call_end(source, positions.end_sentinel.end, index)?;
    let semicolon = skip_ascii_whitespace(source, call_end);
    let replace_end = if !(manifest.context == ControlContext::Statement
        && manifest.authored_semicolon())
        && source.as_bytes().get(semicolon) == Some(&b';')
    {
        semicolon + 1
    } else {
        call_end
    };
    if !(positions.try_marker.start < content_start
        && content_start <= content_end
        && content_end < replace_end)
    {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    Ok(WrapperEdit {
        index,
        replace_start: positions.try_marker.start,
        content_start,
        content_end,
        replace_end,
        dedent: line_indent(source, content_start)
            .saturating_sub(line_indent(source, positions.call.start)),
        replacement: WrapperReplacement::Try,
    })
}

fn try_clause_edit(
    source: &str,
    token_index: usize,
    kind: StructuralKind,
    manifest: TryManifest,
    positions: IndexedTry,
) -> Result<ScaffoldEdit, ProjectionError> {
    let (marker, method, replacement, has_header) = match kind {
        StructuralKind::Pending => {
            (positions.pending_marker, positions.pending_method, EditReplacement::Pending, false)
        }
        StructuralKind::Catch => (
            positions.catch_marker,
            positions.catch_method,
            EditReplacement::Catch,
            manifest.catch_has_header(),
        ),
        _ => return Err(ProjectionError::StructuralMismatch),
    };
    let comma = previous_non_whitespace(source, marker.start)
        .filter(|position| source.as_bytes()[*position] == b',')
        .ok_or(ProjectionError::ScaffoldMismatch { index: token_index })?;
    let previous_body_close = previous_non_whitespace(source, comma)
        .filter(|position| source.as_bytes()[*position] == b'}')
        .ok_or(ProjectionError::ScaffoldMismatch { index: token_index })?;
    let mut cursor = expect_word_after_whitespace(source, marker.end, b"async", token_index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'*', token_index)?;
    cursor = expect_span_after_whitespace(source, cursor, method, token_index)?;
    let end = if has_header {
        if source.as_bytes().get(skip_ascii_whitespace(source, cursor)) != Some(&b'(') {
            return Err(ProjectionError::ScaffoldMismatch { index: token_index });
        }
        cursor
    } else {
        cursor = expect_byte_after_whitespace(source, cursor, b'(', token_index)?;
        cursor = expect_byte_after_whitespace(source, cursor, b')', token_index)?;
        let body_start = skip_ascii_whitespace(source, cursor);
        if source.as_bytes().get(body_start) != Some(&b'{') {
            return Err(ProjectionError::ScaffoldMismatch { index: token_index });
        }
        body_start
    };
    Ok(ScaffoldEdit { index: token_index, start: previous_body_close + 1, end, replacement })
}

fn merge_wrappers(left: Vec<WrapperEdit>, right: Vec<WrapperEdit>) -> Vec<WrapperEdit> {
    let mut output = Vec::with_capacity(left.len() + right.len());
    let mut left = left.into_iter().peekable();
    let mut right = right.into_iter().peekable();
    while left.peek().is_some() || right.peek().is_some() {
        let take_left = match (left.peek(), right.peek()) {
            (Some(left), Some(right)) => left.replace_start <= right.replace_start,
            (Some(_), None) => true,
            _ => false,
        };
        output.push(if take_left {
            left.next().expect("peeked wrapper exists")
        } else {
            right.next().expect("peeked wrapper exists")
        });
    }
    output
}

fn merge_edits(left: Vec<ScaffoldEdit>, right: Vec<ScaffoldEdit>) -> Vec<ScaffoldEdit> {
    let mut output = Vec::with_capacity(left.len() + right.len());
    let mut left = left.into_iter().peekable();
    let mut right = right.into_iter().peekable();
    while left.peek().is_some() || right.peek().is_some() {
        let take_left = match (left.peek(), right.peek()) {
            (Some(left), Some(right)) => left.start <= right.start,
            (Some(_), None) => true,
            _ => false,
        };
        output.push(if take_left {
            left.next().expect("peeked edit exists")
        } else {
            right.next().expect("peeked edit exists")
        });
    }
    output
}

fn wrapper_edit(
    source: &str,
    manifest: WrapperManifest,
    positions: IndexedWrapper,
) -> Result<WrapperEdit, ProjectionError> {
    let index = manifest.node as usize;
    let mut cursor = expect_byte_after_whitespace(source, positions.wrapper.end, b'(', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'{', index)?;
    cursor = expect_word_after_whitespace(source, cursor, b"async", index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'*', index)?;
    cursor = expect_span_after_whitespace(source, cursor, positions.method, index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'(', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b')', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b'{', index)?;
    let _ = expect_span_after_whitespace(source, cursor, positions.start_marker, index)?;
    let content_start = skip_ascii_whitespace(source, positions.start_marker.end);
    let content_end =
        trim_ascii_whitespace_end(source.as_bytes(), content_start, positions.end_marker.start);
    if content_start > content_end {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }

    cursor = positions.end_marker.end;
    cursor = expect_byte_after_whitespace(source, cursor, b'}', index)?;
    let trailing_method_comma = skip_ascii_whitespace(source, cursor);
    if source.as_bytes().get(trailing_method_comma) == Some(&b',') {
        cursor = trailing_method_comma + 1;
    }
    cursor = expect_byte_after_whitespace(source, cursor, b'}', index)?;
    cursor = expect_byte_after_whitespace(source, cursor, b',', index)?;
    let _ = expect_span_after_whitespace(source, cursor, positions.end_sentinel, index)?;
    let call_end = scaffold_call_end(source, positions.end_sentinel.end, index)?;
    let (replace_start, replace_end) = if manifest.context == ControlContext::JsxChild {
        let open = previous_non_whitespace(source, positions.wrapper.start)
            .filter(|position| source.as_bytes()[*position] == b'{')
            .ok_or(ProjectionError::ScaffoldMismatch { index })?;
        let close = skip_ascii_whitespace(source, call_end);
        if source.as_bytes().get(close) != Some(&b'}') {
            return Err(ProjectionError::ScaffoldMismatch { index });
        }
        (open, close + 1)
    } else {
        (positions.wrapper.start, call_end)
    };
    if !(replace_start <= positions.wrapper.start
        && positions.wrapper.start < content_start
        && content_start <= content_end
        && content_end < replace_end)
    {
        return Err(ProjectionError::ScaffoldMismatch { index });
    }
    Ok(WrapperEdit {
        index,
        replace_start,
        content_start,
        content_end,
        replace_end,
        dedent: line_indent(source, content_start)
            .saturating_sub(line_indent(source, positions.wrapper.start)),
        replacement: WrapperReplacement::Empty,
    })
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

fn trim_ascii_whitespace_end(bytes: &[u8], start: usize, mut end: usize) -> usize {
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    end
}

fn render_scaffolds(
    source: &str,
    wrappers: &[WrapperEdit],
    edits: &[ScaffoldEdit],
) -> Result<String, ProjectionError> {
    let mut writer = LiftWriter::new(source.len());
    let mut active: Vec<usize> = Vec::with_capacity(8);
    let mut active_dedent = 0usize;
    let mut wrapper_cursor = 0usize;
    let mut edit_cursor = 0usize;
    let mut source_cursor = 0usize;

    loop {
        let next_wrapper = wrappers.get(wrapper_cursor);
        let next_edit = edits.get(edit_cursor);
        if next_wrapper.is_some_and(|wrapper| wrapper.replace_start < source_cursor) {
            return Err(ProjectionError::ScaffoldMismatch {
                index: next_wrapper.map_or(0, |wrapper| wrapper.index),
            });
        }
        if next_edit.is_some_and(|edit| edit.start < source_cursor) {
            return Err(ProjectionError::ScaffoldMismatch {
                index: next_edit.map_or(0, |edit| edit.index),
            });
        }

        let next_wrapper_start = next_wrapper.map_or(usize::MAX, |wrapper| wrapper.replace_start);
        let next_edit_start = next_edit.map_or(usize::MAX, |edit| edit.start);
        let next_start = next_wrapper_start.min(next_edit_start);
        let next_end = active.last().map_or(usize::MAX, |&index| wrappers[index].content_end);

        if !active.is_empty() && next_end <= next_start {
            if source_cursor > next_end {
                return Err(ProjectionError::StructuralMismatch);
            }
            writer.write(&source[source_cursor..next_end], active_dedent);
            let wrapper_index = active.pop().ok_or(ProjectionError::StructuralMismatch)?;
            let wrapper = wrappers[wrapper_index];
            source_cursor = wrapper.replace_end;
            active_dedent = active_dedent
                .checked_sub(wrapper.dedent)
                .ok_or(ProjectionError::StructuralMismatch)?;
            continue;
        }

        if next_start == usize::MAX {
            if !active.is_empty() {
                return Err(ProjectionError::StructuralMismatch);
            }
            writer.write(&source[source_cursor..], active_dedent);
            break;
        }

        if next_edit_start <= next_wrapper_start {
            let edit = *next_edit.ok_or(ProjectionError::StructuralMismatch)?;
            if edit.start > edit.end
                || active.last().is_some_and(|&index| edit.end > wrappers[index].content_end)
            {
                return Err(ProjectionError::ScaffoldMismatch { index: edit.index });
            }
            writer.write(&source[source_cursor..edit.start], active_dedent);
            writer.write(edit.replacement.text(), active_dedent);
            source_cursor = edit.end;
            edit_cursor += 1;
        } else {
            let wrapper = *next_wrapper.ok_or(ProjectionError::StructuralMismatch)?;
            if wrapper.replace_start > wrapper.content_start
                || wrapper.content_start > wrapper.content_end
                || wrapper.content_end > wrapper.replace_end
                || active
                    .last()
                    .is_some_and(|&index| wrapper.replace_end > wrappers[index].content_end)
            {
                return Err(ProjectionError::ScaffoldMismatch { index: wrapper.index });
            }
            writer.write(&source[source_cursor..wrapper.replace_start], active_dedent);
            writer.write(wrapper.replacement.text(), active_dedent);
            source_cursor = wrapper.content_start;
            active_dedent =
                active_dedent.checked_add(wrapper.dedent).ok_or(ProjectionError::SourceTooLarge)?;
            active.push(wrapper_cursor);
            wrapper_cursor += 1;
        }
    }
    writer.finish()
}

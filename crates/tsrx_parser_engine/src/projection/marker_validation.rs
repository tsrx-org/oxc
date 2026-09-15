//! Tallying the markers actually present in the projected comments against the ones the overlay
//! demands, so a missing or duplicated marker is caught before reconstruction starts.

use tsrx_syntax::{
    ClauseRole, ControlContext, ControlKind, NONE_INDEX, OverlayView, ParserCodeBlockKind,
    ProjectionSegment, StructuralKind,
};
use tsrx_tape_schema::CommentRecord;

use crate::TsrxParseError;

use super::{
    mapping::{project_authored_end, project_authored_start},
    marker::{
        HeaderPart, MarkerBoundary, MarkerKind, expected_header_markers, header_marker_bit,
        parse_decimal, parse_marker,
    },
    text::slice,
};

pub(super) struct MarkerValidation {
    token_markers: Vec<bool>,
    style_markers: Vec<bool>,
    script_markers: Vec<bool>,
    wrapper_starts: Vec<bool>,
    wrapper_ends: Vec<bool>,
    header_markers: Vec<u8>,
    annotated_clauses: Vec<usize>,
}

impl MarkerValidation {
    pub(super) fn new(overlay: OverlayView<'_>) -> Result<Self, TsrxParseError> {
        let annotated_clauses = ordered_annotated_clauses(overlay)?;
        Ok(Self {
            token_markers: vec![false; overlay.tokens.len()],
            style_markers: vec![false; overlay.style_blocks.len()],
            script_markers: vec![false; overlay.script_blocks.len()],
            wrapper_starts: vec![false; overlay.nodes.len()],
            wrapper_ends: vec![false; overlay.nodes.len()],
            header_markers: vec![0_u8; annotated_clauses.len()],
            annotated_clauses,
        })
    }

    pub(super) fn record(
        &mut self,
        marker: MarkerKind,
        comment: &CommentRecord,
        authored: &str,
        projected: &str,
        segments: &[ProjectionSegment],
        overlay: OverlayView<'_>,
    ) -> Result<(), TsrxParseError> {
        match marker {
            MarkerKind::Token(index) => {
                self.record_token(index, comment, authored, projected, segments, overlay)
            }
            MarkerKind::Style(index) => {
                self.record_style(index, comment, projected, segments, overlay)
            }
            MarkerKind::Script(index) => {
                self.record_script(index, comment, projected, segments, overlay)
            }
            MarkerKind::WrapperStart(index) => self.record_wrapper(index, true, overlay),
            MarkerKind::WrapperEnd(index) => self.record_wrapper(index, false, overlay),
            MarkerKind::Header { ordinal, part, boundary } => {
                self.record_header(ordinal, part, boundary, comment, segments, overlay)
            }
        }
    }

    fn record_style(
        &mut self,
        raw: u32,
        comment: &CommentRecord,
        projected: &str,
        segments: &[ProjectionSegment],
        overlay: OverlayView<'_>,
    ) -> Result<(), TsrxParseError> {
        let index = usize::try_from(raw)
            .map_err(|_| TsrxParseError::Unsupported("style marker index overflow"))?;
        let style = overlay
            .style_blocks
            .get(index)
            .ok_or(TsrxParseError::Unsupported("unknown style marker"))?;
        if style.self_closing {
            return Err(TsrxParseError::Unsupported("self-closing style has a payload marker"));
        }
        let scaffold_start = project_authored_end(segments, style.content.start)
            .ok_or(TsrxParseError::Unsupported("unmapped style marker start"))?;
        let scaffold_end = project_authored_start(segments, style.content.end)
            .ok_or(TsrxParseError::Unsupported("unmapped style marker end"))?;
        let positioned = comment.span.start == scaffold_start.saturating_add(1)
            && slice(projected, scaffold_start, comment.span.start)? == "{"
            && slice(projected, comment.span.end, scaffold_end)? == " null}";
        let seen = self
            .style_markers
            .get_mut(index)
            .ok_or(TsrxParseError::Unsupported("unknown style marker"))?;
        if std::mem::replace(seen, true) || !positioned {
            return Err(TsrxParseError::Unsupported("duplicated or displaced style marker"));
        }
        Ok(())
    }

    fn record_token(
        &mut self,
        raw: u32,
        comment: &CommentRecord,
        authored: &str,
        projected: &str,
        segments: &[ProjectionSegment],
        overlay: OverlayView<'_>,
    ) -> Result<(), TsrxParseError> {
        let index = usize::try_from(raw)
            .map_err(|_| TsrxParseError::Unsupported("marker index overflow"))?;
        let token =
            overlay.tokens.get(index).ok_or(TsrxParseError::Unsupported("unknown token marker"))?;
        let positioned = match token.kind {
            StructuralKind::Empty => {
                let body_start = empty_clause_for_owner(overlay, token.owner)?.body.start;
                let projected_body = project_authored_start(segments, body_start)
                    .ok_or(TsrxParseError::Unsupported("unmapped empty marker"))?;
                let trivia_start = token.span.start.saturating_add(6);
                let trivia = slice(authored, trivia_start, body_start)?;
                comment.span.end <= projected_body
                    && slice(projected, comment.span.end, projected_body)?
                        .strip_prefix("if (false)")
                        == Some(trivia)
            }
            StructuralKind::Try | StructuralKind::Pending | StructuralKind::Catch => {
                try_marker_positioned(*token, comment, authored, projected, segments, overlay)?
            }
            StructuralKind::FunctionBody => {
                let projected_start = project_authored_start(segments, token.span.end)
                    .ok_or(TsrxParseError::Unsupported("unmapped code-block marker"))?;
                if let Ok(block) =
                    overlay.parser_code_blocks.binary_search_by_key(&(raw), |block| block.token)
                {
                    match overlay.parser_code_blocks[block].kind {
                        ParserCodeBlockKind::JsxChild => {
                            let text = slice(projected, comment.span.start, comment.span.end)?;
                            let (marker_prefix, _) = parse_marker(text).ok_or(
                                TsrxParseError::Unsupported("invalid JSX code-block marker"),
                            )?;
                            let expected = format!("{{(async function*{marker_prefix}J{raw}_(){{");
                            slice(projected, projected_start, comment.span.start)? == expected
                        }
                        ParserCodeBlockKind::Expression => {
                            comment.span.start == projected_start.saturating_add(1)
                                && slice(projected, projected_start, comment.span.start)? == "{"
                        }
                    }
                } else {
                    comment.span.start == projected_start.saturating_add(1)
                        && slice(projected, projected_start, comment.span.start)? == "{"
                }
            }
            _ => {
                let projected_start = project_authored_start(segments, token.span.end)
                    .ok_or(TsrxParseError::Unsupported("unmapped token marker"))?;
                comment.span.end == projected_start
            }
        };
        if self.token_markers[index] || !positioned {
            return Err(TsrxParseError::Unsupported("duplicated or displaced token marker"));
        }
        self.token_markers[index] = true;
        Ok(())
    }

    fn record_script(
        &mut self,
        raw: u32,
        comment: &CommentRecord,
        projected: &str,
        segments: &[ProjectionSegment],
        overlay: OverlayView<'_>,
    ) -> Result<(), TsrxParseError> {
        let index = usize::try_from(raw)
            .map_err(|_| TsrxParseError::Unsupported("script marker index overflow"))?;
        let script = overlay
            .script_blocks
            .get(index)
            .ok_or(TsrxParseError::Unsupported("unknown script marker"))?;
        let scaffold_start = project_authored_end(segments, script.content.start)
            .ok_or(TsrxParseError::Unsupported("unmapped script marker start"))?;
        let scaffold_end = project_authored_start(segments, script.content.end)
            .ok_or(TsrxParseError::Unsupported("unmapped script marker end"))?;
        let positioned = comment.span.start == scaffold_start.saturating_add(1)
            && slice(projected, scaffold_start, comment.span.start)? == "{"
            && slice(projected, comment.span.end, scaffold_end)? == " null}";
        let seen = self
            .script_markers
            .get_mut(index)
            .ok_or(TsrxParseError::Unsupported("unknown script marker"))?;
        if std::mem::replace(seen, true) || !positioned {
            return Err(TsrxParseError::Unsupported("duplicated or displaced script marker"));
        }
        Ok(())
    }

    fn record_wrapper(
        &mut self,
        raw: u32,
        start: bool,
        overlay: OverlayView<'_>,
    ) -> Result<(), TsrxParseError> {
        let index = usize::try_from(raw)
            .map_err(|_| TsrxParseError::Unsupported("wrapper index overflow"))?;
        let node = overlay
            .nodes
            .get(index)
            .ok_or(TsrxParseError::Unsupported("unknown wrapper marker"))?;
        if node.context == ControlContext::Statement {
            return Err(TsrxParseError::Unsupported("statement control has a synthetic wrapper"));
        }
        let seen =
            if start { &mut self.wrapper_starts[index] } else { &mut self.wrapper_ends[index] };
        if *seen {
            return Err(TsrxParseError::Unsupported("duplicated wrapper marker"));
        }
        *seen = true;
        Ok(())
    }

    fn record_header(
        &mut self,
        ordinal: u32,
        part: HeaderPart,
        boundary: MarkerBoundary,
        comment: &CommentRecord,
        segments: &[ProjectionSegment],
        overlay: OverlayView<'_>,
    ) -> Result<(), TsrxParseError> {
        let index = usize::try_from(ordinal)
            .map_err(|_| TsrxParseError::Unsupported("header index overflow"))?;
        let clause = self
            .annotated_clauses
            .get(index)
            .and_then(|clause| overlay.clauses.get(*clause))
            .ok_or(TsrxParseError::Unsupported("unknown header marker"))?;
        let authored_span = match part {
            HeaderPart::Right => clause.for_header.right,
            HeaderPart::Index => clause.for_header.index,
            HeaderPart::Key => clause.for_header.key,
        };
        if authored_span.is_empty() {
            return Err(TsrxParseError::Unsupported("marker for absent header value"));
        }
        let projected_start = project_authored_start(segments, authored_span.start)
            .ok_or(TsrxParseError::Unsupported("unmapped header marker"))?;
        let projected_end = project_authored_end(segments, authored_span.end)
            .ok_or(TsrxParseError::Unsupported("unmapped header marker"))?;
        let positioned = match boundary {
            MarkerBoundary::Start => comment.span.end == projected_start,
            MarkerBoundary::End => comment.span.start == projected_end,
        };
        let bit = header_marker_bit(part, boundary);
        let seen = self
            .header_markers
            .get_mut(index)
            .ok_or(TsrxParseError::Unsupported("unknown header marker"))?;
        if !positioned || *seen & bit != 0 {
            return Err(TsrxParseError::Unsupported("duplicated or displaced header marker"));
        }
        *seen |= bit;
        Ok(())
    }

    pub(super) fn is_complete(&self, overlay: OverlayView<'_>) -> bool {
        self.token_markers.iter().all(|seen| *seen)
            && self
                .style_markers
                .iter()
                .zip(overlay.style_blocks)
                .all(|(seen, style)| *seen != style.self_closing)
            && self.script_markers.iter().all(|seen| *seen)
            && overlay.nodes.iter().enumerate().all(|(index, node)| {
                let expected = node.context != ControlContext::Statement;
                self.wrapper_starts[index] == expected && self.wrapper_ends[index] == expected
            })
            && self
                .annotated_clauses
                .iter()
                .filter_map(|index| overlay.clauses.get(*index))
                .zip(self.header_markers.iter().copied())
                .all(|(clause, seen)| seen == expected_header_markers(clause.for_header))
    }
}

fn try_marker_positioned(
    token: tsrx_syntax::OverlayToken,
    comment: &CommentRecord,
    authored: &str,
    projected: &str,
    segments: &[ProjectionSegment],
    overlay: OverlayView<'_>,
) -> Result<bool, TsrxParseError> {
    let clause = try_clause_for_token(overlay, token)?;
    let projected_body = project_authored_start(segments, clause.body.start)
        .ok_or(TsrxParseError::Unsupported("unmapped try-family marker"))?;
    if comment.span.end > projected_body {
        return Ok(false);
    }
    let marker = slice(projected, comment.span.start, comment.span.end)?;
    let prefix = parse_marker(marker)
        .map(|(prefix, _)| prefix)
        .ok_or(TsrxParseError::Unsupported("invalid try-family marker"))?;
    let keyword_length = match token.kind {
        StructuralKind::Try => 4,
        StructuralKind::Pending => 8,
        StructuralKind::Catch => 6,
        _ => return Ok(false),
    };
    let trivia_start = token
        .span
        .start
        .checked_add(keyword_length)
        .ok_or(TsrxParseError::Unsupported("try-family token overflow"))?;
    let authored_tail = slice(authored, trivia_start, clause.body.start)?;
    let projected_tail = slice(projected, comment.span.end, projected_body)?;
    let scaffold_matches = match token.kind {
        StructuralKind::Try => {
            strip_scaffold_name(projected_tail, prefix, 'T', token.owner)
                .and_then(|tail| tail.strip_prefix("({async *"))
                .and_then(|tail| strip_scaffold_name(tail, prefix, 'B', token.owner))
                .and_then(|tail| tail.strip_prefix("()"))
                == Some(authored_tail)
        }
        StructuralKind::Pending => {
            synthetic_comma_precedes(projected, comment.span.start)?
                && projected_tail
                    .strip_prefix("async *")
                    .and_then(|tail| strip_scaffold_name(tail, prefix, 'P', token.owner))
                    .and_then(|tail| tail.strip_prefix("()"))
                    == Some(authored_tail)
        }
        StructuralKind::Catch => {
            let tail = projected_tail
                .strip_prefix("async *")
                .and_then(|tail| strip_scaffold_name(tail, prefix, 'C', token.owner));
            let tail = if clause.header.is_empty() {
                tail.and_then(|tail| tail.strip_prefix("()"))
            } else {
                tail
            };
            let authored_tail = slice(authored, trivia_start, clause.body.start)?;
            synthetic_comma_precedes(projected, comment.span.start)? && tail == Some(authored_tail)
        }
        _ => false,
    };
    Ok(scaffold_matches)
}

fn strip_scaffold_name<'a>(
    value: &'a str,
    prefix: &str,
    marker: char,
    owner: u32,
) -> Option<&'a str> {
    let tail = value.strip_prefix(prefix)?.strip_prefix(marker)?;
    let digit_end = tail.bytes().take_while(u8::is_ascii_digit).count();
    if parse_decimal(tail.get(..digit_end)?) != Some(owner) {
        return None;
    }
    tail.get(digit_end..)?.strip_prefix('_')
}

fn synthetic_comma_precedes(projected: &str, point: u32) -> Result<bool, TsrxParseError> {
    let start = point
        .checked_sub(1)
        .ok_or(TsrxParseError::Unsupported("try-family marker at projection start"))?;
    Ok(slice(projected, start, point)? == ",")
}

fn try_clause_for_token(
    overlay: OverlayView<'_>,
    token: tsrx_syntax::OverlayToken,
) -> Result<tsrx_syntax::OverlayClause, TsrxParseError> {
    let expected_role = match token.kind {
        StructuralKind::Try => ClauseRole::Try,
        StructuralKind::Pending => ClauseRole::Pending,
        StructuralKind::Catch => ClauseRole::Catch,
        _ => {
            return Err(TsrxParseError::Unsupported("non-try token requested a try clause"));
        }
    };
    let node = usize::try_from(token.owner)
        .ok()
        .and_then(|index| overlay.nodes.get(index))
        .filter(|node| node.kind == ControlKind::Try)
        .ok_or(TsrxParseError::Unsupported("try-family token has no try owner"))?;
    let mut clause_index = node.first_clause;
    let mut found = None;
    while clause_index != NONE_INDEX {
        let clause = usize::try_from(clause_index)
            .ok()
            .and_then(|index| overlay.clauses.get(index))
            .ok_or(TsrxParseError::Unsupported("invalid try clause index"))?;
        if clause.role == expected_role && found.replace(*clause).is_some() {
            return Err(TsrxParseError::Unsupported("duplicated try-family clause role"));
        }
        clause_index = clause.next;
    }
    found
        .filter(|clause| clause.keyword == token.span)
        .ok_or(TsrxParseError::Unsupported("try-family token does not match its clause"))
}

fn ordered_annotated_clauses(overlay: OverlayView<'_>) -> Result<Vec<usize>, TsrxParseError> {
    let mut ordered = Vec::new();
    for node in overlay.nodes {
        let mut clause_index = node.first_clause;
        while clause_index != NONE_INDEX {
            let index = usize::try_from(clause_index)
                .map_err(|_| TsrxParseError::Unsupported("invalid clause index"))?;
            let clause = overlay
                .clauses
                .get(index)
                .ok_or(TsrxParseError::Unsupported("invalid clause index"))?;
            if clause.for_header.annotated {
                ordered.push(index);
            }
            clause_index = clause.next;
        }
    }
    Ok(ordered)
}

fn empty_clause_for_owner(
    overlay: OverlayView<'_>,
    owner: u32,
) -> Result<tsrx_syntax::OverlayClause, TsrxParseError> {
    let node = usize::try_from(owner)
        .ok()
        .and_then(|index| overlay.nodes.get(index))
        .ok_or(TsrxParseError::Unsupported("empty token has no owner"))?;
    let first = usize::try_from(node.first_clause)
        .ok()
        .and_then(|index| overlay.clauses.get(index))
        .ok_or(TsrxParseError::Unsupported("empty token owner has no clause"))?;
    usize::try_from(first.next)
        .ok()
        .and_then(|index| overlay.clauses.get(index))
        .copied()
        .filter(|clause| clause.role == ClauseRole::Empty)
        .ok_or(TsrxParseError::Unsupported("empty token has no empty clause"))
}

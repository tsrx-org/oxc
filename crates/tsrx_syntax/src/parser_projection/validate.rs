//! What this lane refuses. Some code-block and dynamic-tag arrangements scan cleanly yet cannot
//! be projected into TSX a single OXC parse would accept.

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{Overlay, ParserDynamicKind, StructuralKind},
};

pub(super) fn validate_projection_lane(overlay: &Overlay) -> Result<(), ProjectionError> {
    validate_parser_code_blocks(overlay)?;
    validate_parser_shorthand_attributes(overlay)?;
    validate_parser_dynamic_boundaries(overlay)
}

fn validate_parser_shorthand_attributes(overlay: &Overlay) -> Result<(), ProjectionError> {
    let mut previous_end = None;
    for attribute in &overlay.parser_shorthand_attributes {
        if attribute.span.start.saturating_add(1) != attribute.identifier.start
            || attribute.identifier.end.saturating_add(1) != attribute.span.end
            || attribute.span.end > overlay.source_len
            || previous_end.is_some_and(|end| end > attribute.span.start)
        {
            return Err(ProjectionError::StructuralMismatch);
        }
        previous_end = Some(attribute.span.end);
    }
    Ok(())
}

fn validate_parser_code_blocks(overlay: &Overlay) -> Result<(), ProjectionError> {
    let mut previous_token = None;
    for block in &overlay.parser_code_blocks {
        let token =
            overlay.tokens.get(block.token as usize).ok_or(ProjectionError::StructuralMismatch)?;
        if token.kind != StructuralKind::FunctionBody
            || block.body.start != token.span.end
            || block.body.end <= block.body.start
            || block.body.end > overlay.source_len
            || previous_token.is_some_and(|previous| previous >= block.token)
        {
            return Err(ProjectionError::StructuralMismatch);
        }
        previous_token = Some(block.token);
    }
    Ok(())
}

fn validate_parser_dynamic_boundaries(overlay: &Overlay) -> Result<(), ProjectionError> {
    if overlay.dynamic_tags.is_empty() {
        return if overlay.parser_dynamic_tokens.is_empty() {
            Ok(())
        } else {
            Err(ProjectionError::StructuralMismatch)
        };
    }
    if overlay.parser_dynamic_tokens.is_empty() {
        return Err(ProjectionError::StructuralMismatch);
    }

    let tag_count = to_u32(overlay.dynamic_tags.len())?;
    let mut next_owner = 0_u32;
    let mut previous_offset = None;
    let mut stack = Vec::<(u32, u8)>::with_capacity(overlay.dynamic_tags.len().min(16));

    validate_dynamic_subtree_bounds(overlay, tag_count, &mut stack)?;

    for token in &overlay.parser_dynamic_tokens {
        if previous_offset.is_some_and(|offset| token.offset < offset) {
            return Err(ProjectionError::StructuralMismatch);
        }
        previous_offset = Some(token.offset);
        let tag = overlay
            .dynamic_tags
            .get(token.owner as usize)
            .ok_or(ProjectionError::StructuralMismatch)?;
        match token.kind {
            ParserDynamicKind::OpenStart => {
                if token.owner != next_owner
                    || token.offset != tag.opening.start
                    || tag.subtree_end <= token.owner
                    || tag.subtree_end > tag_count
                {
                    return Err(ProjectionError::StructuralMismatch);
                }
                stack.push((token.owner, 1));
                next_owner = next_owner.checked_add(1).ok_or(ProjectionError::SourceTooLarge)?;
            }
            ParserDynamicKind::OpenEnd => {
                if stack.last() != Some(&(token.owner, 1)) || token.offset != tag.expression.end {
                    return Err(ProjectionError::StructuralMismatch);
                }
                if tag.self_closing {
                    stack.pop();
                } else if let Some((_, phase)) = stack.last_mut() {
                    *phase = 2;
                }
            }
            ParserDynamicKind::CloseStart => {
                if tag.self_closing
                    || stack.last() != Some(&(token.owner, 2))
                    || token.offset != tag.closing.start
                {
                    return Err(ProjectionError::StructuralMismatch);
                }
                if let Some((_, phase)) = stack.last_mut() {
                    *phase = 3;
                }
            }
            ParserDynamicKind::CloseEnd => {
                if tag.self_closing
                    || stack.last() != Some(&(token.owner, 3))
                    || token.offset != tag.closing_expression.end
                {
                    return Err(ProjectionError::StructuralMismatch);
                }
                stack.pop();
            }
        }
    }
    if next_owner == tag_count && stack.is_empty() {
        Ok(())
    } else {
        Err(ProjectionError::StructuralMismatch)
    }
}

fn validate_dynamic_subtree_bounds(
    overlay: &Overlay,
    tag_count: u32,
    stack: &mut Vec<(u32, u8)>,
) -> Result<(), ProjectionError> {
    // Dynamic owners are assigned in opening-source preorder. Validate every exclusive subtree
    // bound from the authored element ranges before using those bounds as identity-scan jumps.
    // The caller reuses this stack allocation for boundary-event phases.
    let mut previous_opening = None;
    for (index, tag) in overlay.dynamic_tags.iter().enumerate() {
        let owner = to_u32(index)?;
        let full_end = tag.closing.end;
        if previous_opening.is_some_and(|start| tag.opening.start <= start)
            || tag.opening.start >= full_end
            || tag.self_closing != tag.closing.is_empty()
            || (tag.self_closing && tag.closing.end <= tag.opening.end)
            || tag.subtree_end <= owner
            || tag.subtree_end > tag_count
        {
            return Err(ProjectionError::StructuralMismatch);
        }
        previous_opening = Some(tag.opening.start);

        while stack.last().is_some_and(|&(active, _)| {
            let active = &overlay.dynamic_tags[active as usize];
            let active_end = active.closing.end;
            tag.opening.start >= active_end
        }) {
            let (completed, _) = stack.pop().ok_or(ProjectionError::StructuralMismatch)?;
            if overlay.dynamic_tags[completed as usize].subtree_end != owner {
                return Err(ProjectionError::StructuralMismatch);
            }
        }

        if stack.last().is_some_and(|&(parent, _)| {
            let parent = &overlay.dynamic_tags[parent as usize];
            let parent_end = parent.closing.end;
            full_end > parent_end
        }) {
            return Err(ProjectionError::StructuralMismatch);
        }
        stack.push((owner, 0));
    }
    while let Some((completed, _)) = stack.pop() {
        if overlay.dynamic_tags[completed as usize].subtree_end != tag_count {
            return Err(ProjectionError::StructuralMismatch);
        }
    }
    Ok(())
}

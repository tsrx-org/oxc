//! The projection expressed as an edit stream. Each kind of rewrite is derived from the overlay
//! on its own, then all of them are merged back into one source-ordered pass.

use super::builder::Builder;
use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{ClauseRole, ControlContext, ControlKind, NONE, Overlay},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    TryEnd(u32),
    ParserCodeBlockEnd(u32),
    WrapperEnd(u32),
    WrapperStart(u32),
    Token(u32),
    Header { clause: u32, ordinal: u32 },
    Embedded(u32),
    ParserDynamic(u32),
    ParserShorthand(u32),
    StatementBoundary(u32),
}

impl Action {
    pub(super) fn key(self, overlay: &Overlay) -> (u32, u8) {
        match self {
            Self::TryEnd(node) => (overlay.nodes[node as usize].span.end, 0),
            Self::ParserCodeBlockEnd(block) => {
                (overlay.parser_code_blocks[block as usize].body.end.saturating_sub(1), 0)
            }
            Self::WrapperEnd(node) => (overlay.nodes[node as usize].span.end, 1),
            Self::WrapperStart(node) => (overlay.nodes[node as usize].span.start, 2),
            Self::Token(token) => (overlay.tokens[token as usize].span.start, 3),
            Self::Header { clause, .. } => (overlay.clauses[clause as usize].header.start, 3),
            Self::Embedded(token) => (overlay.embedded_tokens[token as usize].span.start, 3),
            Self::ParserDynamic(token) => (overlay.parser_dynamic_tokens[token as usize].offset, 2),
            Self::ParserShorthand(attribute) => {
                (overlay.parser_shorthand_attributes[attribute as usize].span.start, 2)
            }
            // The boundary precedes everything else written at the same markup opening, including
            // a dynamic tag's rewritten `<`.
            Self::StatementBoundary(boundary) => {
                (overlay.statement_boundaries[boundary as usize], 0)
            }
        }
    }
}

pub(super) fn build_wrapper_actions(overlay: &Overlay) -> Result<Vec<Action>, ProjectionError> {
    let mut actions = Vec::with_capacity(overlay.nodes.len().saturating_mul(2));
    let mut active = Vec::with_capacity(8);
    for (index, node) in overlay.nodes.iter().enumerate() {
        while active
            .last()
            .is_some_and(|&active: &u32| overlay.nodes[active as usize].span.end <= node.span.start)
        {
            let active = active.pop().ok_or(ProjectionError::StructuralMismatch)?;
            actions.push(Action::WrapperEnd(active));
        }
        if node.context != ControlContext::Statement {
            let node_index = to_u32(index)?;
            if active
                .last()
                .is_some_and(|&active| node.span.end > overlay.nodes[active as usize].span.end)
            {
                return Err(ProjectionError::StructuralMismatch);
            }
            actions.push(Action::WrapperStart(node_index));
            active.push(node_index);
        }
    }
    while let Some(active) = active.pop() {
        actions.push(Action::WrapperEnd(active));
    }
    Ok(actions)
}

pub(super) fn build_header_actions(overlay: &Overlay) -> Result<Vec<Action>, ProjectionError> {
    let mut actions = Vec::new();
    // Ordinals name the scaffold callees the parser reads back, so they count annotated headers in
    // source order rather than indexing the clause table.
    let mut ordinal = 0_u32;
    for node in &overlay.nodes {
        let mut clause_index = node.first_clause;
        while clause_index != NONE {
            let clause = overlay.clauses[clause_index as usize];
            if clause.for_header.annotated {
                actions.push(Action::Header { clause: clause_index, ordinal });
                ordinal = ordinal.checked_add(1).ok_or(ProjectionError::SourceTooLarge)?;
            }
            clause_index = clause.next;
        }
    }
    Ok(actions)
}

pub(super) fn build_try_actions(overlay: &Overlay) -> Result<Vec<Action>, ProjectionError> {
    let mut actions = Vec::new();
    let mut active = Vec::with_capacity(8);
    for (index, node) in overlay.nodes.iter().enumerate() {
        while active.last().is_some_and(|&node_index: &u32| {
            overlay.nodes[node_index as usize].span.end <= node.span.start
        }) {
            actions.push(Action::TryEnd(active.pop().ok_or(ProjectionError::StructuralMismatch)?));
        }
        if node.kind != ControlKind::Try {
            continue;
        }
        let node_index = to_u32(index)?;
        // A `@try` with neither a `@pending` nor a `@catch` clause has no scaffold to close, so it
        // is a stale overlay rather than a projectable node.
        let mut has_settled_clause = false;
        let mut clause_index = node.first_clause;
        while clause_index != NONE {
            let clause = overlay.clauses[clause_index as usize];
            has_settled_clause |= matches!(clause.role, ClauseRole::Pending | ClauseRole::Catch);
            clause_index = clause.next;
        }
        if !has_settled_clause {
            return Err(ProjectionError::StructuralMismatch);
        }
        active.push(node_index);
    }
    while let Some(node) = active.pop() {
        actions.push(Action::TryEnd(node));
    }
    Ok(actions)
}

pub(super) fn project_actions(
    builder: &mut Builder<'_>,
    overlay: &Overlay,
    wrapper_actions: &[Action],
    try_end_actions: &[Action],
    parser_code_block_end_actions: &[Action],
    header_actions: &[Action],
) -> Result<(), ProjectionError> {
    let mut wrapper_cursor = 0usize;
    let mut try_end_cursor = 0usize;
    let mut parser_code_block_end_cursor = 0usize;
    let mut token_cursor = 0usize;
    let mut header_cursor = 0usize;
    let mut embedded_cursor = 0usize;
    let mut parser_dynamic_cursor = 0usize;
    let mut parser_shorthand_cursor = 0usize;
    let mut statement_boundary_cursor = 0usize;
    loop {
        let wrapper = wrapper_actions.get(wrapper_cursor).copied();
        let try_end = try_end_actions.get(try_end_cursor).copied();
        let parser_code_block_end =
            parser_code_block_end_actions.get(parser_code_block_end_cursor).copied();
        let token = (token_cursor < overlay.tokens.len())
            .then(|| to_u32(token_cursor).map(Action::Token))
            .transpose()?;
        let header = header_actions.get(header_cursor).copied();
        let embedded = (embedded_cursor < overlay.embedded_tokens.len())
            .then(|| to_u32(embedded_cursor).map(Action::Embedded))
            .transpose()?;
        let parser_dynamic = (parser_dynamic_cursor < overlay.parser_dynamic_tokens.len())
            .then(|| to_u32(parser_dynamic_cursor).map(Action::ParserDynamic))
            .transpose()?;
        let parser_shorthand = (parser_shorthand_cursor
            < overlay.parser_shorthand_attributes.len())
        .then(|| to_u32(parser_shorthand_cursor).map(Action::ParserShorthand))
        .transpose()?;
        let statement_boundary = (statement_boundary_cursor < overlay.statement_boundaries.len())
            .then(|| to_u32(statement_boundary_cursor).map(Action::StatementBoundary))
            .transpose()?;
        let Some(action) = [
            wrapper,
            try_end,
            parser_code_block_end,
            token,
            header,
            embedded,
            parser_dynamic,
            parser_shorthand,
            statement_boundary,
        ]
        .into_iter()
        .flatten()
        .min_by_key(|action| action.key(overlay)) else {
            break;
        };
        match action {
            Action::TryEnd(node) => {
                try_end_cursor += 1;
                builder.try_end(node)?;
            }
            Action::ParserCodeBlockEnd(block) => {
                parser_code_block_end_cursor += 1;
                builder.parser_code_block_end(block)?;
            }
            Action::WrapperEnd(node) => {
                wrapper_cursor += 1;
                builder.wrapper_end(node)?;
            }
            Action::WrapperStart(node) => {
                wrapper_cursor += 1;
                builder.wrapper_start(node)?;
            }
            Action::Token(token) => {
                token_cursor += 1;
                builder.token(token)?;
            }
            Action::Header { clause, ordinal } => {
                header_cursor += 1;
                builder.header(clause, ordinal)?;
            }
            Action::Embedded(token) => {
                embedded_cursor += 1;
                builder.embedded(token)?;
            }
            Action::ParserDynamic(token) => {
                parser_dynamic_cursor += 1;
                builder.parser_dynamic(token)?;
            }
            Action::ParserShorthand(attribute) => {
                parser_shorthand_cursor += 1;
                builder.parser_shorthand(attribute)?;
            }
            Action::StatementBoundary(boundary) => {
                statement_boundary_cursor += 1;
                builder.statement_boundary(boundary)?;
            }
        }
    }
    Ok(())
}

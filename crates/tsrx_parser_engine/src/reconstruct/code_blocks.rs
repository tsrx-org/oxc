//! Authored `@{ ... }` bodies in both statement and JSX-child position, and the policy that
//! decides whether a projected semicolon belongs to the block or to the list around it.

use tsrx_syntax::{
    ByteSpan, ControlKind, OverlayView, ParserCodeBlockKind, ProjectionSegment, StructuralKind,
};
use tsrx_tape_schema::{FlatTape, RecordIndex, ValueRef};

use crate::{
    TsrxParseError,
    projection::{map_endpoint, project_authored_start},
    tape_index::{ParentIndex, ParentSlot},
};

use super::{
    access::{
        field_value, has_type, index_of, index_of_overlay, is_jsx_child_type, list_field,
        object_field, object_type, require_type, scalar_field, scalar_u32,
        unwrap_parenthesized_expression,
    },
    edits::{
        ListEntryRemoval, append_empty_metadata, append_node_head, create_expression_statement,
        order_span_fields_before, replace_type,
    },
    objects::{find_optional_start, find_unique_start},
    scaffold::scaffold_name_matches,
    spans::{AuthoredStart, record_authored_span},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectedCodeBlockKind {
    Block,
    Expression,
    JsxContainer,
}

#[derive(Debug, Clone, Copy)]
enum CodeBlockPlacement {
    DirectField,
    DirectList { slot: ParentSlot, policy: DirectListPolicy },
    Wrap(ParentSlot),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DirectListPolicy {
    None,
    CodeBlockBody,
    TemplateClause,
}

#[derive(Debug, Clone, Copy)]
struct ProjectedCodeBlock {
    object: RecordIndex,
    body_owner: RecordIndex,
    kind: ProjectedCodeBlockKind,
    authored_start: u32,
    replacement: Option<ParentSlot>,
    wrapper: Option<RecordIndex>,
}

pub(super) struct CodeBlockPlans {
    blocks: Vec<ProjectedCodeBlock>,
    pub(super) direct_list_policies: Vec<DirectListPolicy>,
}

pub(super) fn collect_code_block_plans(
    tape: &FlatTape,
    overlay: OverlayView<'_>,
    segments: &[ProjectionSegment],
    blocks: &[(u32, RecordIndex)],
    jsx_containers: &[(u32, RecordIndex)],
    parents: &ParentIndex,
    prefix: &str,
) -> Result<CodeBlockPlans, TsrxParseError> {
    let count =
        overlay.tokens.iter().filter(|token| token.kind == StructuralKind::FunctionBody).count();
    let mut plans = Vec::with_capacity(count);
    let mut seen = vec![false; tape.object_count()];
    let mut direct_list_policies = vec![DirectListPolicy::None; tape.object_count()];
    for (token_index, token) in overlay
        .tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| token.kind == StructuralKind::FunctionBody)
    {
        let token_index = u32::try_from(token_index)
            .map_err(|_| TsrxParseError::Unsupported("code-block token index overflow"))?;
        let projected_start = project_authored_start(segments, token.span.end)
            .ok_or(TsrxParseError::Unsupported("code block is outside affine source"))?;
        let block = find_optional_start(blocks, projected_start, "code block")?;
        let container =
            find_optional_start(jsx_containers, projected_start, "JSX-child code block")?;
        let parser_kind = overlay
            .parser_code_blocks
            .binary_search_by_key(&token_index, |block| block.token)
            .ok()
            .map(|index| overlay.parser_code_blocks[index].kind);
        let (object, kind) = match (parser_kind, block, container) {
            (Some(ParserCodeBlockKind::Expression), Some(object), None) => {
                (object, ProjectedCodeBlockKind::Expression)
            }
            (Some(ParserCodeBlockKind::JsxChild), None, Some(object)) => {
                (object, ProjectedCodeBlockKind::JsxContainer)
            }
            (None, Some(object), None) => (object, ProjectedCodeBlockKind::Block),
            (Some(_), _, _) => {
                return Err(TsrxParseError::Unsupported(
                    "projected parser code block has an unexpected owner",
                ));
            }
            (None, Some(_), Some(_)) => {
                return Err(TsrxParseError::Unsupported("ambiguous projected code block"));
            }
            (None, None, Some(_)) => {
                return Err(TsrxParseError::Unsupported("unregistered JSX code-block projection"));
            }
            (None, None, None) => {
                return Err(TsrxParseError::Unsupported("code block has no projected owner"));
            }
        };
        let (body_owner, replacement, wrapper) = match kind {
            ProjectedCodeBlockKind::JsxContainer => {
                validate_jsx_child_container(tape, parents, object)?;
                (validate_jsx_code_block_wrapper(tape, object, prefix, token_index)?, None, None)
            }
            ProjectedCodeBlockKind::Expression => {
                let (replacement, wrapper) =
                    validate_expression_code_block_wrapper(tape, parents, object)?;
                (object, Some(replacement), Some(wrapper))
            }
            ProjectedCodeBlockKind::Block => (object, None, None),
        };
        let index = index_of(object)?;
        let duplicate = seen
            .get_mut(index)
            .ok_or(TsrxParseError::Unsupported("code block owner is outside object table"))?;
        if std::mem::replace(duplicate, true) {
            return Err(TsrxParseError::Unsupported("duplicate projected code block owner"));
        }
        let body_owner_index = index_of(body_owner)?;
        if direct_list_policies[body_owner_index] != DirectListPolicy::None {
            return Err(TsrxParseError::Unsupported("duplicate projected code-block body owner"));
        }
        direct_list_policies[body_owner_index] = DirectListPolicy::CodeBlockBody;
        plans.push(ProjectedCodeBlock {
            object,
            body_owner,
            kind,
            authored_start: token.span.start,
            replacement,
            wrapper,
        });
    }
    Ok(CodeBlockPlans { blocks: plans, direct_list_policies })
}

pub(super) fn mark_direct_custom_clause_blocks(
    direct_list_policies: &mut [DirectListPolicy],
    overlay: OverlayView<'_>,
    segments: &[ProjectionSegment],
    blocks: &[(u32, RecordIndex)],
) -> Result<(), TsrxParseError> {
    for node in
        overlay.nodes.iter().filter(|node| matches!(node.kind, ControlKind::If | ControlKind::Try))
    {
        let mut clause = node.first_clause;
        while clause != tsrx_syntax::NONE_INDEX {
            let current = overlay
                .clauses
                .get(index_of_overlay(clause)?)
                .ok_or(TsrxParseError::Unsupported("custom clause is outside overlay table"))?;
            let projected_start = project_authored_start(segments, current.body.start).ok_or(
                TsrxParseError::Unsupported("custom clause body is outside affine source"),
            )?;
            let block = find_unique_start(blocks, projected_start, "custom clause block")?;
            let marker = direct_list_policies.get_mut(index_of(block)?).ok_or(
                TsrxParseError::Unsupported("custom clause block is outside object table"),
            )?;
            if *marker != DirectListPolicy::None {
                return Err(TsrxParseError::Unsupported(
                    "custom clause has an ambiguous code-block owner policy",
                ));
            }
            *marker = DirectListPolicy::TemplateClause;
            clause = current.next;
        }
    }
    Ok(())
}

pub(super) fn reconstruct_code_blocks(
    tape: &mut FlatTape,
    authored: &str,
    segments: &[ProjectionSegment],
    plans: &CodeBlockPlans,
    parents: &ParentIndex,
    starts: &mut Vec<AuthoredStart>,
    removals: &mut Vec<ListEntryRemoval>,
) -> Result<(), TsrxParseError> {
    for code_block in plans.blocks.iter().rev().copied() {
        match code_block.kind {
            ProjectedCodeBlockKind::Block => reconstruct_block_code_block(
                tape,
                authored,
                segments,
                code_block,
                &plans.direct_list_policies,
                parents,
                starts,
                removals,
            )?,
            ProjectedCodeBlockKind::Expression => {
                reconstruct_expression_code_block(
                    tape,
                    segments,
                    code_block,
                    &plans.direct_list_policies,
                    parents,
                    starts,
                )?;
            }
            ProjectedCodeBlockKind::JsxContainer => {
                reconstruct_jsx_child_code_block(tape, segments, code_block, starts)?;
            }
        }
    }
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "the reconstruction context is threaded down explicitly; a parameter struct would relocate these fields, not remove them"
)]
fn reconstruct_block_code_block(
    tape: &mut FlatTape,
    authored: &str,
    segments: &[ProjectionSegment],
    code_block: ProjectedCodeBlock,
    direct_list_policies: &[DirectListPolicy],
    parents: &ParentIndex,
    starts: &mut Vec<AuthoredStart>,
    removals: &mut Vec<ListEntryRemoval>,
) -> Result<(), TsrxParseError> {
    let block = code_block.object;
    require_type(tape, block, r#""BlockStatement""#)?;
    let placement = block_code_block_placement(tape, parents, block, direct_list_policies)?;
    let projected_end = scalar_u32(tape, block, "end")?;
    let authored_end = map_endpoint(segments, projected_end, false)
        .ok_or(TsrxParseError::Unsupported("code block end is outside affine source"))?;
    let body = list_field(tape, block, "body")?;
    let semicolon_end = prepare_code_block_placement(
        tape,
        authored,
        segments,
        authored_end,
        placement,
        parents,
        removals,
    )?;
    let render = take_code_block_render(tape, body)?;
    replace_type(tape, block, r#""JSXCodeBlock""#)?;
    order_span_fields_before(tape, block, "body")?;
    tape.append_field(block, "render", render)?;
    append_empty_metadata(tape, block)?;
    starts.push(AuthoredStart { object: block, start: code_block.authored_start, end: None });
    if let CodeBlockPlacement::Wrap(slot) = placement {
        let statement = create_expression_statement(tape, block)?;
        ParentIndex::replace(tape, slot, ValueRef::object(statement))?;
        starts.push(AuthoredStart {
            object: statement,
            start: code_block.authored_start,
            end: semicolon_end,
        });
    }
    Ok(())
}

fn reconstruct_expression_code_block(
    tape: &mut FlatTape,
    segments: &[ProjectionSegment],
    code_block: ProjectedCodeBlock,
    direct_list_policies: &[DirectListPolicy],
    parents: &ParentIndex,
    starts: &mut Vec<AuthoredStart>,
) -> Result<(), TsrxParseError> {
    let block = code_block.object;
    require_type(tape, block, r#""BlockStatement""#)?;
    let wrapper = code_block
        .wrapper
        .ok_or(TsrxParseError::Unsupported("expression code block has no scaffold wrapper"))?;
    let projected_start = scalar_u32(tape, wrapper, "start")?;
    let mut ancestor = parents.parent_container(ValueRef::object(wrapper));
    while let Some(object) = ancestor.and_then(ValueRef::as_object) {
        let Some(start) = tape
            .field_index(object, "start")
            .and_then(|field| tape.field_value(field))
            .and_then(|value| tape.scalar_u32(value))
        else {
            break;
        };
        if start != projected_start {
            break;
        }
        starts.push(AuthoredStart { object, start: code_block.authored_start, end: None });
        ancestor = parents.parent_container(ValueRef::object(object));
    }
    let projected_end = scalar_u32(tape, block, "end")?;
    let authored_end = map_endpoint(segments, projected_end, false)
        .ok_or(TsrxParseError::Unsupported("expression code-block end is outside affine source"))?;
    let body = list_field(tape, block, "body")?;
    let render = take_code_block_render(tape, body)?;
    replace_type(tape, block, r#""JSXCodeBlock""#)?;
    order_span_fields_before(tape, block, "body")?;
    tape.append_field(block, "render", render)?;
    append_empty_metadata(tape, block)?;
    let span = ByteSpan::new(code_block.authored_start, authored_end);
    let replacement = code_block.replacement.ok_or(TsrxParseError::Unsupported(
        "expression code block has no scaffold replacement slot",
    ))?;
    let replacement = expression_code_block_replacement(
        tape,
        parents,
        wrapper,
        replacement,
        direct_list_policies,
    )?;
    ParentIndex::replace(tape, replacement, ValueRef::object(block))?;
    record_authored_span(starts, block, span);
    Ok(())
}

fn expression_code_block_replacement(
    tape: &FlatTape,
    parents: &ParentIndex,
    wrapper: RecordIndex,
    expression_slot: ParentSlot,
    direct_list_policies: &[DirectListPolicy],
) -> Result<ParentSlot, TsrxParseError> {
    let Some(statement) =
        parents.parent_container(ValueRef::object(wrapper)).and_then(ValueRef::as_object)
    else {
        return Ok(expression_slot);
    };
    if !has_type(tape, statement, r#""ExpressionStatement""#)
        || tape.field_index(statement, "expression").and_then(|field| tape.field_value(field))
            != Some(ValueRef::object(wrapper))
    {
        return Ok(expression_slot);
    }
    let Some(statement_slot @ ParentSlot::ListValue(_)) =
        parents.parent_slot(ValueRef::object(statement))
    else {
        return Ok(expression_slot);
    };
    let Some(list) =
        parents.parent_container(ValueRef::object(statement)).and_then(ValueRef::as_list)
    else {
        return Ok(expression_slot);
    };
    let Some(owner) = parents.parent_container(ValueRef::list(list)).and_then(ValueRef::as_object)
    else {
        return Ok(expression_slot);
    };
    let policy =
        direct_list_policies.get(index_of(owner)?).copied().unwrap_or(DirectListPolicy::None);
    Ok(if policy == DirectListPolicy::None { expression_slot } else { statement_slot })
}

fn reconstruct_jsx_child_code_block(
    tape: &mut FlatTape,
    segments: &[ProjectionSegment],
    code_block: ProjectedCodeBlock,
    starts: &mut Vec<AuthoredStart>,
) -> Result<(), TsrxParseError> {
    let container = code_block.object;
    require_type(tape, container, r#""JSXExpressionContainer""#)?;
    let body = list_field(tape, code_block.body_owner, "body")?;
    let render = take_code_block_render(tape, body)?;
    let projected_end = scalar_u32(tape, container, "end")?;
    let authored_end = map_endpoint(segments, projected_end, false)
        .ok_or(TsrxParseError::Unsupported("JSX-child code block end is outside affine source"))?;
    let span = ByteSpan::new(code_block.authored_start, authored_end);
    tape.clear_fields(container)?;
    append_node_head(tape, container, r#""JSXCodeBlock""#, span)?;
    tape.append_field(container, "body", ValueRef::list(body))?;
    tape.append_field(container, "render", render)?;
    append_empty_metadata(tape, container)?;
    record_authored_span(starts, container, span);
    Ok(())
}

fn validate_jsx_code_block_wrapper(
    tape: &FlatTape,
    container: RecordIndex,
    prefix: &str,
    token: u32,
) -> Result<RecordIndex, TsrxParseError> {
    let grouped = object_field(tape, container, "expression")?;
    let function = unwrap_parenthesized_expression(tape, grouped)?;
    validate_code_block_wrapper_function(tape, function, prefix, token)
}

fn validate_expression_code_block_wrapper(
    tape: &FlatTape,
    parents: &ParentIndex,
    block: RecordIndex,
) -> Result<(ParentSlot, RecordIndex), TsrxParseError> {
    let function =
        parents.parent_container(ValueRef::object(block)).and_then(ValueRef::as_object).ok_or(
            TsrxParseError::Unsupported("expression code-block body has no scaffold function"),
        )?;
    if validate_expression_code_block_function(tape, function)? != block {
        return Err(TsrxParseError::Unsupported(
            "expression code-block scaffold owns a different body",
        ));
    }
    let wrapper =
        parents.parent_container(ValueRef::object(function)).and_then(ValueRef::as_object).ok_or(
            TsrxParseError::Unsupported("expression code-block function has no scaffold wrapper"),
        )?;
    require_type(tape, wrapper, r#""UnaryExpression""#)?;
    if scalar_field(tape, wrapper, "operator")? != r#""void""#
        || object_field(tape, wrapper, "argument")? != function
    {
        return Err(TsrxParseError::Unsupported(
            "expression code-block unary scaffold does not match",
        ));
    }
    let replacement = parents.parent_slot(ValueRef::object(wrapper)).ok_or(
        TsrxParseError::Unsupported("expression code-block scaffold has no replacement slot"),
    )?;
    Ok((replacement, wrapper))
}

fn validate_expression_code_block_function(
    tape: &FlatTape,
    function: RecordIndex,
) -> Result<RecordIndex, TsrxParseError> {
    require_type(tape, function, r#""FunctionExpression""#)?;
    if scalar_field(tape, function, "generator")? != "true"
        || scalar_field(tape, function, "async")? != "true"
        || scalar_field(tape, function, "id")? != "null"
        || tape.values(list_field(tape, function, "params")?).next().is_some()
    {
        return Err(TsrxParseError::Unsupported(
            "expression code-block wrapper is not an anonymous parameterless async generator",
        ));
    }
    let body = object_field(tape, function, "body")?;
    require_type(tape, body, r#""BlockStatement""#)?;
    Ok(body)
}

fn validate_code_block_wrapper_function(
    tape: &FlatTape,
    function: RecordIndex,
    prefix: &str,
    token: u32,
) -> Result<RecordIndex, TsrxParseError> {
    require_type(tape, function, r#""FunctionExpression""#)?;
    if scalar_field(tape, function, "generator")? != "true"
        || scalar_field(tape, function, "async")? != "true"
        || tape.values(list_field(tape, function, "params")?).next().is_some()
    {
        return Err(TsrxParseError::Unsupported(
            "JSX code-block wrapper is not a parameterless async generator",
        ));
    }
    let id = object_field(tape, function, "id")?;
    require_type(tape, id, r#""Identifier""#)?;
    let token = usize::try_from(token)
        .map_err(|_| TsrxParseError::Unsupported("JSX code-block token index overflow"))?;
    if !scaffold_name_matches(scalar_field(tape, id, "name")?, prefix, 'J', token) {
        return Err(TsrxParseError::Unsupported("unknown JSX code-block wrapper identity"));
    }
    let body = object_field(tape, function, "body")?;
    require_type(tape, body, r#""BlockStatement""#)?;
    Ok(body)
}

fn take_code_block_render(
    tape: &mut FlatTape,
    body: RecordIndex,
) -> Result<ValueRef, TsrxParseError> {
    let items: Vec<(RecordIndex, ValueRef)> = tape.values_indexed(body).collect();
    let mut output_indexes = Vec::new();
    let mut seen_output = false;
    let mut trailing_semicolon = false;
    for (index, (_entry, value)) in items.iter().copied().enumerate() {
        if render_expression(tape, value)?.is_some() {
            output_indexes.push(index);
            seen_output = true;
            trailing_semicolon = false;
            continue;
        }
        if !seen_output {
            continue;
        }
        if !trailing_semicolon && is_dynamic_semicolon(tape, value) {
            trailing_semicolon = true;
            continue;
        }
        return Err(TsrxParseError::AuthoredGrammar(
            "render expression precedes another statement".to_string(),
        ));
    }
    let Some(&last_output) = output_indexes.last() else {
        return tape.push_scalar("null").map_err(Into::into);
    };
    for &index in &output_indexes {
        if index == last_output {
            continue;
        }
        let (entry, value) = items[index];
        if let Some(expression) = expression_statement_jsx_child(tape, value)? {
            tape.set_list_value(entry, expression)?;
        }
    }
    if trailing_semicolon {
        tape.pop_list_value(body)?;
    }
    let render_value = tape.pop_list_value(body)?;
    render_expression(tape, render_value)?
        .ok_or(TsrxParseError::Unsupported("code block render is not a JSX child"))
}

fn expression_statement_jsx_child(
    tape: &FlatTape,
    statement: ValueRef,
) -> Result<Option<ValueRef>, TsrxParseError> {
    let Some(statement) = statement.as_object() else {
        return Ok(None);
    };
    if !has_type(tape, statement, r#""ExpressionStatement""#) {
        return Ok(None);
    }
    let expression = field_value(tape, statement, "expression")?;
    let Some(object) = expression.as_object() else {
        return Ok(None);
    };
    Ok(is_jsx_child_type(tape, object).then_some(expression))
}

fn block_code_block_placement(
    tape: &FlatTape,
    parents: &ParentIndex,
    block: RecordIndex,
    direct_list_policies: &[DirectListPolicy],
) -> Result<CodeBlockPlacement, TsrxParseError> {
    let slot = parents
        .parent_slot(ValueRef::object(block))
        .ok_or(TsrxParseError::Unsupported("projected code block has no parent"))?;
    let ParentSlot::Field(_) = slot else {
        let list = parents
            .parent_container(ValueRef::object(block))
            .and_then(ValueRef::as_list)
            .ok_or(TsrxParseError::Unsupported("projected code block has no parent list"))?;
        let owner = parents
            .parent_container(ValueRef::list(list))
            .and_then(ValueRef::as_object)
            .ok_or(TsrxParseError::Unsupported("projected code block list has no owner"))?;
        let policy =
            direct_list_policies.get(index_of(owner)?).copied().unwrap_or(DirectListPolicy::None);
        if policy != DirectListPolicy::None {
            return Ok(CodeBlockPlacement::DirectList { slot, policy });
        }
        if matches!(object_type(tape, owner), Some(r#""BlockStatement""# | r#""SwitchCase""#)) {
            return Ok(CodeBlockPlacement::Wrap(slot));
        }
        return Err(TsrxParseError::AuthoredGrammar(
            "code block is outside an implemented statement-list placement".to_string(),
        ));
    };
    let parent = parents
        .parent_container(ValueRef::object(block))
        .and_then(ValueRef::as_object)
        .ok_or(TsrxParseError::Unsupported("projected code block has no object parent"))?;
    let body_owns_block =
        tape.field_index(parent, "body").and_then(|field| tape.field_value(field))
            == Some(ValueRef::object(block));
    if body_owns_block
        && matches!(
            object_type(tape, parent),
            Some(
                r#""FunctionDeclaration""#
                    | r#""FunctionExpression""#
                    | r#""ArrowFunctionExpression""#
            )
        )
    {
        return Ok(CodeBlockPlacement::DirectField);
    }
    Err(TsrxParseError::AuthoredGrammar(
        "code block is outside an implemented expression placement".to_string(),
    ))
}

fn validate_jsx_child_container(
    tape: &FlatTape,
    parents: &ParentIndex,
    container: RecordIndex,
) -> Result<(), TsrxParseError> {
    let Some(ParentSlot::ListValue(_)) = parents.parent_slot(ValueRef::object(container)) else {
        return Err(TsrxParseError::Unsupported("code block JSX container is not a child"));
    };
    let list = parents
        .parent_container(ValueRef::object(container))
        .and_then(ValueRef::as_list)
        .ok_or(TsrxParseError::Unsupported("code block JSX container has no child list"))?;
    let owner = parents
        .parent_container(ValueRef::list(list))
        .and_then(ValueRef::as_object)
        .ok_or(TsrxParseError::Unsupported("code block JSX child list has no owner"))?;
    if !matches!(object_type(tape, owner), Some(r#""JSXElement""# | r#""JSXFragment""#))
        || tape.field_index(owner, "children").and_then(|field| tape.field_value(field))
            != Some(ValueRef::list(list))
    {
        return Err(TsrxParseError::Unsupported(
            "code block JSX container is outside authored children",
        ));
    }
    Ok(())
}

fn prepare_code_block_placement(
    tape: &FlatTape,
    authored: &str,
    segments: &[ProjectionSegment],
    authored_end: u32,
    placement: CodeBlockPlacement,
    parents: &ParentIndex,
    removals: &mut Vec<ListEntryRemoval>,
) -> Result<Option<u32>, TsrxParseError> {
    let (slot, policy) = match placement {
        CodeBlockPlacement::DirectField
        | CodeBlockPlacement::DirectList { policy: DirectListPolicy::CodeBlockBody, .. } => {
            return Ok(None);
        }
        CodeBlockPlacement::DirectList { slot, policy } => (slot, Some(policy)),
        CodeBlockPlacement::Wrap(slot) => (slot, None),
    };
    let semicolon = code_block_statement_boundary(authored, authored_end)?;
    let ParentSlot::ListValue(block_entry) = slot else {
        return Err(TsrxParseError::Unsupported(
            "code-block statement placement is not a list entry",
        ));
    };
    let mut after = tape
        .list_value_next(block_entry)
        .ok_or(TsrxParseError::Unsupported("code-block list entry is invalid"))?;
    if let Some(span) = semicolon {
        let (removal, next) = validate_semicolon_entry(tape, segments, parents, block_entry, span)?;
        removals.push(removal);
        after = next;
    }
    if policy == Some(DirectListPolicy::TemplateClause) && !after.is_none() {
        return Err(TsrxParseError::Unsupported(
            "direct code-block render precedes another clause statement",
        ));
    }
    Ok((policy.is_none()).then(|| semicolon.map(|span| span.end)).flatten())
}

fn validate_semicolon_entry(
    tape: &FlatTape,
    segments: &[ProjectionSegment],
    parents: &ParentIndex,
    block_entry: RecordIndex,
    authored: ByteSpan,
) -> Result<(ListEntryRemoval, RecordIndex), TsrxParseError> {
    let block = tape
        .list_value(block_entry)
        .and_then(ValueRef::as_object)
        .ok_or(TsrxParseError::Unsupported("code-block list entry is not an object"))?;
    let list = parents
        .parent_container(ValueRef::object(block))
        .and_then(ValueRef::as_list)
        .ok_or(TsrxParseError::Unsupported("code-block has no parent statement list"))?;
    let entry = tape.list_value_next(block_entry).filter(|entry| !entry.is_none()).ok_or(
        TsrxParseError::Unsupported("authored code-block semicolon has no projected statement"),
    )?;
    let statement = tape
        .list_value(entry)
        .and_then(ValueRef::as_object)
        .ok_or(TsrxParseError::Unsupported("authored code-block semicolon is not a statement"))?;
    require_type(tape, statement, r#""EmptyStatement""#)?;
    let projected_start = scalar_u32(tape, statement, "start")?;
    let projected_end = scalar_u32(tape, statement, "end")?;
    if map_endpoint(segments, projected_start, true) != Some(authored.start)
        || map_endpoint(segments, projected_end, false) != Some(authored.end)
    {
        return Err(TsrxParseError::Unsupported(
            "projected code-block semicolon differs from authored source",
        ));
    }
    let next = tape
        .list_value_next(entry)
        .ok_or(TsrxParseError::Unsupported("semicolon list entry is invalid"))?;
    Ok((ListEntryRemoval { list, entry }, next))
}

fn code_block_statement_boundary(
    authored: &str,
    authored_end: u32,
) -> Result<Option<ByteSpan>, TsrxParseError> {
    let mut index = usize::try_from(authored_end)
        .map_err(|_| TsrxParseError::Unsupported("code block end exceeds host usize"))?;
    let bytes = authored.as_bytes();
    let mut line_break = false;
    while let Some(byte) = bytes.get(index).copied() {
        match byte {
            b' ' | b'\t' | 0x0b | 0x0c => index += 1,
            b'\r' | b'\n' => {
                line_break = true;
                index += 1;
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index += 2;
                while let Some(byte) = bytes.get(index).copied() {
                    if matches!(byte, b'\r' | b'\n') {
                        break;
                    }
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                let Some(relative_end) = authored[index + 2..].find("*/") else {
                    return Err(TsrxParseError::Unsupported(
                        "unterminated trivia after code block",
                    ));
                };
                let end = index + 2 + relative_end + 2;
                line_break |=
                    authored[index..end].bytes().any(|byte| matches!(byte, b'\r' | b'\n'));
                index = end;
            }
            _ => break,
        }
    }
    if bytes.get(index) == Some(&b';') {
        let start = u32::try_from(index)
            .map_err(|_| TsrxParseError::Unsupported("semicolon start exceeds u32"))?;
        return Ok(Some(ByteSpan::new(start, start + 1)));
    }
    if index == authored.len() || bytes.get(index) == Some(&b'}') || line_break {
        Ok(None)
    } else {
        Err(TsrxParseError::AuthoredGrammar(
            "code block expression requires an authored statement boundary".to_string(),
        ))
    }
}

fn render_expression(
    tape: &FlatTape,
    statement: ValueRef,
) -> Result<Option<ValueRef>, TsrxParseError> {
    let Some(statement) = statement.as_object() else {
        return Ok(None);
    };
    if is_jsx_child_type(tape, statement) {
        return Ok(Some(ValueRef::object(statement)));
    }
    if !has_type(tape, statement, r#""ExpressionStatement""#) {
        return Ok(None);
    }
    let expression = field_value(tape, statement, "expression")?;
    let Some(object) = expression.as_object() else {
        return Ok(None);
    };
    Ok(is_jsx_child_type(tape, object).then_some(expression))
}

fn is_dynamic_semicolon(tape: &FlatTape, statement: ValueRef) -> bool {
    let Some(statement) = statement.as_object() else {
        return false;
    };
    if has_type(tape, statement, r#""EmptyStatement""#) {
        return true;
    }
    if !has_type(tape, statement, r#""ExpressionStatement""#) {
        return false;
    }
    let Some(text) = tape
        .field_index(statement, "expression")
        .and_then(|field| tape.field_value(field))
        .and_then(ValueRef::as_object)
        .filter(|text| has_type(tape, *text, r#""JSXText""#))
    else {
        return false;
    };
    scalar_field(tape, text, "value") == Ok(r#"";""#)
        && scalar_field(tape, text, "raw") == Ok(r#"";""#)
}

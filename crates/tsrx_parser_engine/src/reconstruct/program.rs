//! The single entry point, and the order the passes have to run in.
//! Indexing comes first because every later pass finds its node by projected start, and list
//! removals are batched to the very end so no pass invalidates another pass's indices.

use tsrx_syntax::{OverlayView, ProjectionSegment, StructuralKind};
use tsrx_tape_schema::{FlatTape, RecordIndex, ValueRef};

use crate::{
    TsrxParseError,
    projection::map_endpoint,
    tape_index::{ParentIndex, ParentSlot},
};

use super::{
    access::{has_type, list_field, require_type, scalar_u32},
    code_blocks::{
        collect_code_block_plans, mark_direct_custom_clause_blocks, reconstruct_code_blocks,
    },
    control::normalize_control_body_lists,
    dynamic_tags::reconstruct_dynamic_tags,
    if_chain::IfReconstructor,
    layout_text::normalize_template_layout_text,
    loops::{LoopReconstructor, build_header_ordinals},
    objects::ProjectedObjectIndex,
    script::reconstruct_script_elements,
    shorthand_attributes::reconstruct_shorthand_attributes,
    spans::AuthoredStart,
    style::reconstruct_style_elements,
    switch::SwitchReconstructor,
    try_catch::{TryReconstructor, collect_try_helpers},
};

#[expect(
    clippy::too_many_lines,
    reason = "the reconstruction order is a single dependency-sensitive pass over shared indexes"
)]
pub(crate) fn reconstruct_projected(
    tape: &mut FlatTape,
    authored: &str,
    overlay: OverlayView<'_>,
    segments: &[ProjectionSegment],
    prefix: &str,
) -> Result<Vec<AuthoredStart>, TsrxParseError> {
    let program = validate_program_shape(tape)?;
    let mut object_index = ProjectedObjectIndex::new();
    let parents =
        ParentIndex::build(tape, |object, kind, start| object_index.record(object, kind, start))?;
    object_index.sort();
    validate_module_declaration_placement(tape, &parents, program, &object_index.module_objects)?;
    let mut code_blocks = collect_code_block_plans(
        tape,
        overlay,
        segments,
        &object_index.block_objects,
        &object_index.jsx_containers,
        &parents,
        prefix,
    )?;
    mark_direct_custom_clause_blocks(
        &mut code_blocks.direct_list_policies,
        overlay,
        segments,
        &object_index.block_objects,
    )?;
    let header_ordinals = build_header_ordinals(overlay)?;
    let try_objects = collect_try_helpers(tape, &object_index.call_objects, overlay, prefix)?;
    let starts = initial_authored_starts(program, authored, overlay)?;
    let mut reconstructor = IfReconstructor {
        overlay,
        segments,
        prefix,
        if_objects: &object_index.if_objects,
        parents: &parents,
        starts,
        body_lists: Vec::with_capacity(overlay.clauses.len()),
    };

    reconstructor.reconstruct_all(tape)?;
    let mut starts = reconstructor.starts;
    let mut body_lists = reconstructor.body_lists;
    {
        let mut loops = LoopReconstructor {
            overlay,
            segments,
            prefix,
            loop_objects: &object_index.loop_objects,
            block_objects: &object_index.block_objects,
            header_ordinals: &header_ordinals,
            parents: &parents,
            starts: &mut starts,
            body_lists: &mut body_lists,
        };
        loops.reconstruct_all(tape)?;
    }
    {
        let mut switches = SwitchReconstructor {
            overlay,
            segments,
            prefix,
            switch_objects: &object_index.switch_objects,
            parents: &parents,
            starts: &mut starts,
            body_lists: &mut body_lists,
        };
        switches.reconstruct_all(tape)?;
    }
    {
        let mut tries = TryReconstructor {
            authored,
            overlay,
            segments,
            prefix,
            try_objects: &try_objects,
            parents: &parents,
            starts: &mut starts,
            body_lists: &mut body_lists,
        };
        tries.reconstruct_all(tape)?;
    }
    reconstruct_style_elements(tape, authored, overlay, segments, &parents, &mut starts)?;
    reconstruct_dynamic_tags(tape, authored, overlay, segments, prefix, &parents, &mut starts)?;
    reconstruct_shorthand_attributes(
        tape,
        overlay,
        segments,
        prefix,
        &object_index.jsx_attributes,
        &mut starts,
    )?;
    normalize_control_body_lists(tape, &body_lists)?;
    let mut list_removals = Vec::new();
    collect_synthetic_empty_statements(tape, segments, &parents, &mut list_removals)?;
    reconstruct_code_blocks(
        tape,
        authored,
        segments,
        &code_blocks,
        &parents,
        &mut starts,
        &mut list_removals,
    )?;
    normalize_template_layout_text(tape, &object_index.layout_containers, &mut list_removals)?;
    tape.remove_list_values(
        &list_removals.iter().map(|removal| (removal.list, removal.entry)).collect::<Vec<_>>(),
    )?;
    reconstruct_script_elements(
        tape,
        authored,
        overlay,
        segments,
        &object_index.jsx_opening_elements,
        &parents,
        &mut starts,
    )?;
    Ok(starts)
}

fn collect_synthetic_empty_statements(
    tape: &FlatTape,
    segments: &[ProjectionSegment],
    parents: &ParentIndex,
    removals: &mut Vec<super::edits::ListEntryRemoval>,
) -> Result<(), TsrxParseError> {
    for raw in 0..tape.object_count() {
        let raw = u32::try_from(raw).map_err(|_| {
            TsrxParseError::ResourceExhausted("object index exceeds the 32-bit tape limit")
        })?;
        let object = RecordIndex::new(raw);
        if !has_type(tape, object, r#""EmptyStatement""#) {
            continue;
        }
        let start = scalar_u32(tape, object, "start")?;
        let end = scalar_u32(tape, object, "end")?;
        if map_endpoint(segments, start, true).is_some()
            || map_endpoint(segments, end, false).is_some()
        {
            continue;
        }
        let Some(ParentSlot::ListValue(entry)) = parents.parent_slot(ValueRef::object(object))
        else {
            continue;
        };
        let Some(list) =
            parents.parent_container(ValueRef::object(object)).and_then(ValueRef::as_list)
        else {
            continue;
        };
        removals.push(super::edits::ListEntryRemoval { list, entry });
    }
    Ok(())
}

fn validate_program_shape(tape: &FlatTape) -> Result<RecordIndex, TsrxParseError> {
    let program = tape
        .root()
        .as_object()
        .ok_or(TsrxParseError::Unsupported("projected root is not a Program"))?;
    require_type(tape, program, r#""Program""#)?;
    let _ = list_field(tape, program, "body")?;
    Ok(program)
}

fn validate_module_declaration_placement(
    tape: &FlatTape,
    parents: &ParentIndex,
    program: RecordIndex,
    module_objects: &[RecordIndex],
) -> Result<(), TsrxParseError> {
    let program_body = list_field(tape, program, "body")?;
    for &object in module_objects {
        let direct_program_member =
            matches!(parents.parent_slot(ValueRef::object(object)), Some(ParentSlot::ListValue(_)))
                && parents.parent_container(ValueRef::object(object))
                    == Some(ValueRef::list(program_body));
        let typescript_module_member = parents
            .parent_container(ValueRef::object(object))
            .and_then(ValueRef::as_list)
            .and_then(|list| parents.parent_container(ValueRef::list(list)))
            .and_then(ValueRef::as_object)
            .is_some_and(|owner| has_type(tape, owner, r#""TSModuleBlock""#));
        if !direct_program_member && !typescript_module_member {
            return Err(TsrxParseError::AuthoredGrammar(
                "module declaration is nested inside authored TSRX".to_string(),
            ));
        }
    }
    Ok(())
}

fn initial_authored_starts(
    program: RecordIndex,
    authored: &str,
    overlay: OverlayView<'_>,
) -> Result<Vec<AuthoredStart>, TsrxParseError> {
    let code_blocks =
        overlay.tokens.iter().filter(|token| token.kind == StructuralKind::FunctionBody).count();
    let capacity = overlay
        .nodes
        .len()
        .saturating_mul(2)
        .saturating_add(overlay.style_blocks.len().saturating_mul(3))
        .saturating_add(overlay.parser_shorthand_attributes.len())
        .saturating_add(overlay.script_blocks.len())
        .saturating_add(code_blocks.saturating_mul(2))
        .saturating_add(1);
    let mut starts = Vec::with_capacity(capacity);
    starts.push(AuthoredStart {
        object: program,
        start: 0,
        end: Some(
            u32::try_from(authored.len())
                .map_err(|_| TsrxParseError::Unsupported("authored Program exceeds 4 GiB"))?,
        ),
    });
    Ok(starts)
}

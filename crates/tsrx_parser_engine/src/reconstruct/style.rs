//! Raw `<style>` elements: pairing each projected JSX element with the scanner-owned authored
//! block it came from, then rebuilding its opening, closing, and payload nodes.

use tsrx_syntax::{ByteSpan, OverlayView, ProjectionSegment};
use tsrx_tape_schema::{FlatTape, ListValueInsertion, RecordIndex, ValueRef};

use crate::{
    TsrxParseError,
    projection::{map_endpoint, project_authored_end, project_authored_start},
    tape_index::ParentIndex,
};

use super::{
    access::{
        exact_one_value, field_value, has_type, list_field, object_field, require_type,
        scalar_field, scalar_u32,
    },
    css::build_style_children,
    edits::{append_empty_metadata, append_node_head, require_empty_metadata},
    jsx_statements::normalize_custom_jsx_statement,
    spans::{AuthoredStart, record_authored_span, require_mapped_object_span, slice_authored},
};

#[derive(Debug, Clone, Copy)]
struct ProjectedStyle {
    element: RecordIndex,
    opening: RecordIndex,
}

pub(super) fn reconstruct_style_elements(
    tape: &mut FlatTape,
    authored: &str,
    overlay: OverlayView<'_>,
    segments: &[ProjectionSegment],
    parents: &ParentIndex,
    starts: &mut Vec<AuthoredStart>,
) -> Result<(), TsrxParseError> {
    if overlay.style_blocks.is_empty() {
        return Ok(());
    }
    let styles = collect_projected_styles(tape, overlay, segments, parents)?;
    let mut semicolons = Vec::new();
    for index in (0..overlay.style_blocks.len()).rev() {
        reconstruct_style_element(
            tape,
            authored,
            overlay.style_blocks[index],
            styles[index],
            segments,
            parents,
            starts,
            &mut semicolons,
        )?;
    }
    tape.insert_list_values_after(&semicolons)?;
    Ok(())
}

/// Matches ordinary OXC JSX style elements to scanner owners in one flat object-table pass.
/// The compact span stack accounts for nested attribute expressions without a sort, binary
/// search, source rescan, or per-style AST walk.
fn collect_projected_styles(
    tape: &FlatTape,
    overlay: OverlayView<'_>,
    segments: &[ProjectionSegment],
    parents: &ParentIndex,
) -> Result<Vec<ProjectedStyle>, TsrxParseError> {
    // OXC finishes an opening record after serializing its attributes. A nested style used inside
    // an attribute is therefore observed before its owning style, while ordinary siblings remain
    // in source order. Derive that exact postorder from scanner preorder in one flat pass.
    let expected_order = style_opening_postorder(overlay)?;
    let mut styles = vec![None; overlay.style_blocks.len()];
    let mut next = 0_usize;
    for raw in 0..tape.object_count() {
        let raw = u32::try_from(raw)
            .map_err(|_| TsrxParseError::Unsupported("object table above 4 GiB"))?;
        let opening = RecordIndex::new(raw);
        if !has_type(tape, opening, r#""JSXOpeningElement""#) {
            continue;
        }
        let Some(name) = tape
            .field_index(opening, "name")
            .and_then(|field| tape.field_value(field))
            .and_then(ValueRef::as_object)
            .filter(|name| has_type(tape, *name, r#""JSXIdentifier""#))
        else {
            continue;
        };
        if scalar_field(tape, name, "name")? != r#""style""# {
            continue;
        }
        let start = map_endpoint(segments, scalar_u32(tape, opening, "start")?, true).ok_or(
            TsrxParseError::Unsupported("projected style start is outside authored source"),
        )?;
        // `<style>{expr}</style>` stays an ordinary JSXElement. Skip those openings so they
        // do not steal a reserved raw-style owner.
        let Some(&owner) = expected_order.get(next) else {
            continue;
        };
        let expected = overlay
            .style_blocks
            .get(owner)
            .ok_or(TsrxParseError::Unsupported("unknown authored style owner"))?;
        if start != expected.element.start {
            continue;
        }
        let element = parents
            .parent_container(ValueRef::object(opening))
            .and_then(ValueRef::as_object)
            .ok_or(TsrxParseError::Unsupported("style opening has no JSX element parent"))?;
        require_type(tape, element, r#""JSXElement""#)?;
        if field_value(tape, element, "openingElement")? != ValueRef::object(opening) {
            return Err(TsrxParseError::Unsupported(
                "style opening is not owned by its JSX element",
            ));
        }
        if styles[owner].replace(ProjectedStyle { element, opening }).is_some() {
            return Err(TsrxParseError::Unsupported("projected style owner is duplicated"));
        }
        next += 1;
    }
    if next != overlay.style_blocks.len() {
        return Err(TsrxParseError::Unsupported("projected style element set is incomplete"));
    }
    styles
        .into_iter()
        .map(|style| style.ok_or(TsrxParseError::Unsupported("projected style owner is missing")))
        .collect()
}

fn style_opening_postorder(overlay: OverlayView<'_>) -> Result<Vec<usize>, TsrxParseError> {
    let mut order = Vec::with_capacity(overlay.style_blocks.len());
    let mut stack = Vec::<usize>::with_capacity(4);
    for (index, style) in overlay.style_blocks.iter().enumerate() {
        while stack
            .last()
            .is_some_and(|owner| overlay.style_blocks[*owner].element.end <= style.element.start)
        {
            order.push(stack.pop().expect("the style stack has a last owner"));
        }
        if stack
            .last()
            .is_some_and(|owner| style.element.end > overlay.style_blocks[*owner].content.start)
        {
            return Err(TsrxParseError::Unsupported("style opening preorder has crossing spans"));
        }
        stack.push(index);
    }
    while let Some(owner) = stack.pop() {
        order.push(owner);
    }
    Ok(order)
}

#[expect(
    clippy::too_many_arguments,
    reason = "the reconstruction context is threaded down explicitly; a parameter struct would relocate these fields, not remove them"
)]
fn reconstruct_style_element(
    tape: &mut FlatTape,
    authored: &str,
    style: tsrx_syntax::OverlayStyleBlock,
    projected: ProjectedStyle,
    segments: &[ProjectionSegment],
    parents: &ParentIndex,
    starts: &mut Vec<AuthoredStart>,
    semicolons: &mut Vec<ListValueInsertion>,
) -> Result<(), TsrxParseError> {
    let opening_span = ByteSpan::new(
        style.element.start,
        if style.self_closing { style.element.end } else { style.content.start },
    );
    require_mapped_object_span(tape, projected.element, style.element, segments)?;
    require_mapped_object_span(tape, projected.opening, opening_span, segments)?;

    let attributes = list_field(tape, projected.opening, "attributes")?;
    let opening_name = object_field(tape, projected.opening, "name")?;
    require_static_style_name(tape, opening_name)?;
    let projected_self_closing = scalar_field(tape, projected.opening, "selfClosing")?;
    if projected_self_closing != if style.self_closing { "true" } else { "false" } {
        return Err(TsrxParseError::Unsupported(
            "projected style self-closing flag disagrees with overlay",
        ));
    }
    let opening_name_end = style
        .element
        .start
        .checked_add(6)
        .ok_or(TsrxParseError::Unsupported("style name span overflow"))?;
    require_mapped_object_span(
        tape,
        opening_name,
        ByteSpan::new(style.element.start.saturating_add(1), opening_name_end),
        segments,
    )?;

    append_empty_metadata(tape, projected.element)?;
    let metadata = object_field(tape, projected.element, "metadata")?;
    require_empty_metadata(tape, metadata)?;
    let children = list_field(tape, projected.element, "children")?;
    let closing_value = field_value(tape, projected.element, "closingElement")?;

    let (closing, css) = if style.self_closing {
        if tape.scalar(closing_value) != Some("null") || tape.values(children).next().is_some() {
            return Err(TsrxParseError::Unsupported(
                "self-closing style has projected closing content",
            ));
        }
        (None, "")
    } else {
        let (closing, closing_name, closing_span, css) = consume_paired_style_scaffold(
            tape,
            authored,
            style,
            children,
            closing_value,
            segments,
        )?;
        (Some((closing, closing_name, closing_span)), css)
    };
    let children =
        if style.self_closing { children } else { build_style_children(tape, css, starts)? };

    rebuild_style_opening(
        tape,
        projected.opening,
        opening_span,
        attributes,
        opening_name,
        style.self_closing,
        starts,
    )?;
    let closing = if let Some((closing, name, span)) = closing {
        rebuild_style_closing(tape, closing, span, name, starts)?;
        Some(closing)
    } else {
        None
    };
    rebuild_style_element_node(
        tape,
        projected.element,
        style.element,
        metadata,
        children,
        projected.opening,
        closing,
        css,
        starts,
    )?;
    normalize_custom_jsx_statement(
        tape,
        authored,
        projected.element,
        style.element,
        segments,
        parents,
        starts,
        semicolons,
        style.self_closing,
    )?;
    Ok(())
}

fn consume_paired_style_scaffold<'a>(
    tape: &mut FlatTape,
    authored: &'a str,
    style: tsrx_syntax::OverlayStyleBlock,
    children: RecordIndex,
    closing_value: ValueRef,
    segments: &[ProjectionSegment],
) -> Result<(RecordIndex, RecordIndex, ByteSpan, &'a str), TsrxParseError> {
    let closing = closing_value
        .as_object()
        .ok_or(TsrxParseError::Unsupported("paired style has no projected closing element"))?;
    require_type(tape, closing, r#""JSXClosingElement""#)?;
    let closing_span = ByteSpan::new(style.content.end, style.element.end);
    require_mapped_object_span(tape, closing, closing_span, segments)?;
    let closing_name = object_field(tape, closing, "name")?;
    require_static_style_name(tape, closing_name)?;
    let closing_name_start = style
        .content
        .end
        .checked_add(2)
        .ok_or(TsrxParseError::Unsupported("style closing name overflow"))?;
    let closing_name_end = style
        .element
        .end
        .checked_sub(1)
        .ok_or(TsrxParseError::Unsupported("style closing name underflow"))?;
    require_mapped_object_span(
        tape,
        closing_name,
        ByteSpan::new(closing_name_start, closing_name_end),
        segments,
    )?;

    let helper = exact_one_value(tape, children)?
        .as_object()
        .ok_or(TsrxParseError::Unsupported("style payload scaffold is not an object"))?;
    require_type(tape, helper, r#""JSXExpressionContainer""#)?;
    let scaffold_start = project_authored_end(segments, style.content.start)
        .ok_or(TsrxParseError::Unsupported("style scaffold start is unmapped"))?;
    let scaffold_end = project_authored_start(segments, style.content.end)
        .ok_or(TsrxParseError::Unsupported("style scaffold end is unmapped"))?;
    if scalar_u32(tape, helper, "start")? != scaffold_start
        || scalar_u32(tape, helper, "end")? != scaffold_end
    {
        return Err(TsrxParseError::Unsupported("style payload scaffold span is displaced"));
    }
    let sentinel = object_field(tape, helper, "expression")?;
    require_type(tape, sentinel, r#""Literal""#)?;
    if tape.scalar(field_value(tape, sentinel, "value")?) != Some("null") {
        return Err(TsrxParseError::Unsupported("style payload sentinel is not null"));
    }
    if tape.pop_list_value(children)? != ValueRef::object(helper) {
        return Err(TsrxParseError::Unsupported("style payload scaffold is not the sole child"));
    }
    Ok((closing, closing_name, closing_span, slice_authored(authored, style.content)?))
}

fn require_static_style_name(tape: &FlatTape, name: RecordIndex) -> Result<(), TsrxParseError> {
    require_type(tape, name, r#""JSXIdentifier""#)?;
    if scalar_field(tape, name, "name")? != r#""style""# {
        return Err(TsrxParseError::Unsupported("projected style name is not lowercase style"));
    }
    Ok(())
}

fn rebuild_style_opening(
    tape: &mut FlatTape,
    opening: RecordIndex,
    span: ByteSpan,
    attributes: RecordIndex,
    name: RecordIndex,
    self_closing: bool,
    starts: &mut Vec<AuthoredStart>,
) -> Result<(), TsrxParseError> {
    tape.clear_fields(opening)?;
    append_node_head(tape, opening, r#""JSXOpeningElement""#, span)?;
    tape.append_field(opening, "attributes", ValueRef::list(attributes))?;
    tape.append_field(opening, "name", ValueRef::object(name))?;
    let self_closing = tape.push_scalar(if self_closing { "true" } else { "false" })?;
    tape.append_field(opening, "selfClosing", self_closing)?;
    record_authored_span(starts, opening, span);
    Ok(())
}

fn rebuild_style_closing(
    tape: &mut FlatTape,
    closing: RecordIndex,
    span: ByteSpan,
    name: RecordIndex,
    starts: &mut Vec<AuthoredStart>,
) -> Result<(), TsrxParseError> {
    tape.clear_fields(closing)?;
    append_node_head(tape, closing, r#""JSXClosingElement""#, span)?;
    tape.append_field(closing, "name", ValueRef::object(name))?;
    record_authored_span(starts, closing, span);
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "the reconstruction context is threaded down explicitly; a parameter struct would relocate these fields, not remove them"
)]
fn rebuild_style_element_node(
    tape: &mut FlatTape,
    element: RecordIndex,
    span: ByteSpan,
    metadata: RecordIndex,
    children: RecordIndex,
    opening: RecordIndex,
    closing: Option<RecordIndex>,
    css: &str,
    starts: &mut Vec<AuthoredStart>,
) -> Result<(), TsrxParseError> {
    tape.clear_fields(element)?;
    append_node_head(tape, element, r#""JSXStyleElement""#, span)?;
    tape.append_field(element, "metadata", ValueRef::object(metadata))?;
    tape.append_field(element, "children", ValueRef::list(children))?;
    tape.append_field(element, "openingElement", ValueRef::object(opening))?;
    let closing = if let Some(closing) = closing {
        ValueRef::object(closing)
    } else {
        tape.push_scalar("null")?
    };
    tape.append_field(element, "closingElement", closing)?;
    let css = tape.push_json_string_scalar(css)?;
    tape.append_field(element, "css", css)?;
    record_authored_span(starts, element, span);
    Ok(())
}

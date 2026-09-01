//! Which tape objects the public Program can still reach, so span mapping and compaction never
//! spend work on storage that is already orphaned.

use tsrx_tape_schema::{FlatTape, ValueKind, ValueRef};

use crate::{TsrxParseError, source_bridge::PreparedSource};

use super::tape_fields::{object_type, record_index};

pub(crate) fn program_reachable_objects(tape: &FlatTape) -> Result<Vec<bool>, TsrxParseError> {
    let mut objects = vec![false; tape.object_count()];
    let mut lists = vec![false; tape.list_count()];
    let mut pending = vec![tape.root()];
    while let Some(value) = pending.pop() {
        match value.kind() {
            ValueKind::Missing | ValueKind::Scalar => {}
            ValueKind::Object => {
                let object = value.as_object().ok_or_else(|| {
                    TsrxParseError::Adapter("invalid reachable object reference".to_string())
                })?;
                let index = usize::try_from(object.into_raw()).map_err(|_| {
                    TsrxParseError::Unsupported("reachable object index exceeds usize")
                })?;
                let seen = objects.get_mut(index).ok_or_else(|| {
                    TsrxParseError::Adapter("reachable object is outside table".to_string())
                })?;
                if std::mem::replace(seen, true) {
                    continue;
                }
                pending.extend(tape.fields(object).map(|field| field.value));
            }
            ValueKind::List => {
                let list = value.as_list().ok_or_else(|| {
                    TsrxParseError::Adapter("invalid reachable list reference".to_string())
                })?;
                let index = usize::try_from(list.into_raw()).map_err(|_| {
                    TsrxParseError::Unsupported("reachable list index exceeds usize")
                })?;
                let seen = lists.get_mut(index).ok_or_else(|| {
                    TsrxParseError::Adapter("reachable list is outside table".to_string())
                })?;
                if std::mem::replace(seen, true) {
                    continue;
                }
                pending.extend(tape.values(list));
            }
        }
    }
    Ok(objects)
}

pub(super) fn map_program_spans(
    tape: &mut FlatTape,
    source: &PreparedSource<'_>,
    reachable_objects: &[bool],
) -> Result<(), TsrxParseError> {
    try_map_program_spans(tape, reachable_objects, |byte_offset| {
        source.map_endpoint(byte_offset).ok_or_else(|| {
            TsrxParseError::Adapter(format!(
                "coordinate {byte_offset} is not an exact UTF-8 boundary"
            ))
        })
    })
}

pub(crate) fn try_map_program_spans(
    tape: &mut FlatTape,
    reachable_objects: &[bool],
    mut map_endpoint: impl FnMut(u32) -> Result<u32, TsrxParseError>,
) -> Result<(), TsrxParseError> {
    // CSS parser coordinates are relative to the `<style>` payload, not the authored module.
    // Keep the complete StyleSheet-owned graph out of source-global UTF-16 remapping, matching
    // @tsrx/core's coordinate contract while every surrounding JS/TSRX node is still mapped.
    let css_local_objects = css_local_objects(tape, reachable_objects)?;
    let mut field_updates = Vec::new();
    let mut list_updates = Vec::new();
    for raw in 0..tape.object_count() {
        if !reachable_objects.get(raw).copied().unwrap_or(false)
            || css_local_objects.get(raw).copied().unwrap_or(false)
        {
            continue;
        }
        let object = record_index(raw)?;
        for (field_index, field) in tape.fields_indexed(object) {
            match tape.key(field) {
                "start" | "end" => {
                    let byte_offset = tape.scalar_u32(field.value).ok_or_else(|| {
                        TsrxParseError::Adapter("coordinate field is not u32".to_string())
                    })?;
                    field_updates.push((field_index, map_endpoint(byte_offset)?));
                }
                "range" => {
                    let list = field.value.as_list().ok_or_else(|| {
                        TsrxParseError::Adapter("range field is not a list".to_string())
                    })?;
                    for (entry, value) in tape.values_indexed(list) {
                        let byte_offset = tape.scalar_u32(value).ok_or_else(|| {
                            TsrxParseError::Adapter("range endpoint is not u32".to_string())
                        })?;
                        list_updates.push((entry, map_endpoint(byte_offset)?));
                    }
                }
                _ => {}
            }
        }
    }
    for (field, offset) in field_updates {
        let value = tape.push_u32_scalar(offset)?;
        tape.set_field_value(field, value)?;
    }
    for (entry, offset) in list_updates {
        let value = tape.push_u32_scalar(offset)?;
        tape.set_list_value(entry, value)?;
    }
    Ok(())
}

fn css_local_objects(
    tape: &FlatTape,
    reachable_objects: &[bool],
) -> Result<Vec<bool>, TsrxParseError> {
    let mut pending = Vec::new();
    for raw in 0..tape.object_count() {
        if reachable_objects.get(raw).copied().unwrap_or(false) {
            let object = record_index(raw)?;
            if object_type(tape, object) == Some(r#""StyleSheet""#) {
                pending.push(ValueRef::object(object));
            }
        }
    }
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    let mut objects = vec![false; tape.object_count()];
    let mut lists = vec![false; tape.list_count()];
    while let Some(value) = pending.pop() {
        match value.kind() {
            ValueKind::Missing | ValueKind::Scalar => {}
            ValueKind::Object => {
                let object = value.as_object().ok_or_else(|| {
                    TsrxParseError::Adapter("invalid CSS object reference".to_string())
                })?;
                let index = usize::try_from(object.into_raw())
                    .map_err(|_| TsrxParseError::Unsupported("CSS object index exceeds usize"))?;
                let seen = objects.get_mut(index).ok_or_else(|| {
                    TsrxParseError::Adapter("CSS object is outside table".to_string())
                })?;
                if std::mem::replace(seen, true) {
                    continue;
                }
                pending.extend(tape.fields(object).map(|field| field.value));
            }
            ValueKind::List => {
                let list = value.as_list().ok_or_else(|| {
                    TsrxParseError::Adapter("invalid CSS list reference".to_string())
                })?;
                let index = usize::try_from(list.into_raw())
                    .map_err(|_| TsrxParseError::Unsupported("CSS list index exceeds usize"))?;
                let seen = lists.get_mut(index).ok_or_else(|| {
                    TsrxParseError::Adapter("CSS list is outside table".to_string())
                })?;
                if std::mem::replace(seen, true) {
                    continue;
                }
                pending.extend(tape.values(list));
            }
        }
    }
    Ok(objects)
}

use tsrx_syntax::{
    OverlayView, PARSER_EXPRESSION_CODE_BLOCK_PREFIX, ParserCodeBlockKind, ProjectionSegment,
};
use tsrx_tape_schema::{
    DiagnosticTable, DynamicImportRecord, ExportExportNameKind, ExportImportNameKind,
    ExportLocalNameKind, ImportNameKind, ListRange, ModuleNameRecord, ModuleTable,
    OptionalStringRange, OptionalTapeSpan, OptionalValueSpanRecord, StaticExportEntryRecord,
    StaticExportRecord, StaticImportEntryRecord, StaticImportRecord, StringRange, TapeSpan,
    ValueSpanRecord,
};

use crate::{
    TsrxParseError,
    projection::{map_affine_span, map_endpoint, project_authored_start},
};

#[derive(Debug, Default)]
struct MappingState {
    mapped: usize,
    unmapped: usize,
}

impl MappingState {
    fn record(&mut self, mapped: bool) {
        if mapped {
            self.mapped += 1;
        } else {
            self.unmapped += 1;
        }
    }

    fn retain(&self, mixed: &'static str) -> Result<bool, TsrxParseError> {
        match (self.mapped, self.unmapped) {
            (0, 0) => Err(TsrxParseError::Unsupported(
                "projected result record has no coordinate evidence",
            )),
            (0, _) => Ok(false),
            (_, 0) => Ok(true),
            _ => Err(TsrxParseError::Unsupported(mixed)),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct MappedValueSpan {
    value: StringRange,
    span: TapeSpan,
}

#[derive(Debug, Clone, Copy)]
struct MappedName<K> {
    kind: K,
    name: OptionalStringRange,
    span: Option<TapeSpan>,
}

#[derive(Debug, Clone, Copy)]
struct MappedImportEntry {
    import_name: MappedName<ImportNameKind>,
    local_name: Option<MappedValueSpan>,
    is_type: bool,
}

#[derive(Debug, Clone, Copy)]
struct MappedExportEntry {
    span: Option<TapeSpan>,
    module_request: Option<MappedValueSpan>,
    import_name: MappedName<ExportImportNameKind>,
    export_name: MappedName<ExportExportNameKind>,
    local_name: MappedName<ExportLocalNameKind>,
    is_type: bool,
}

pub(super) fn reconstruct_module(
    mut projected: ModuleTable,
    segments: &[ProjectionSegment],
    overlay: OverlayView<'_>,
) -> Result<(ModuleTable, u32), TsrxParseError> {
    // Parser projection never introduces a top-level module-syntax form. Preserve OXC's flag
    // independently of entry arrays because TypeScript `export =` and `export as namespace`
    // intentionally set it without emitting a static-export record.
    let has_module_syntax = projected.has_module_syntax();
    let projected_strings = projected.take_string_storage()?;
    let mut authored = ModuleTable::default();
    let suppressed_static_imports =
        reconstruct_static_imports(&mut projected, &projected_strings, segments, &mut authored)?;
    let suppressed_static_exports = reconstruct_static_exports(
        &mut projected,
        &projected_strings,
        segments,
        overlay,
        &mut authored,
    )?;
    drop(projected_strings);
    let suppressed_dynamic_imports =
        reconstruct_dynamic_imports(&mut projected, segments, &mut authored)?;
    let suppressed_import_metas =
        reconstruct_import_metas(&mut projected, segments, &mut authored)?;
    let suppressed = suppressed_static_imports
        + suppressed_static_exports
        + suppressed_dynamic_imports
        + suppressed_import_metas;
    debug_assert!(projected.is_storage_released());
    drop(projected);

    authored.set_has_module_syntax(has_module_syntax);
    Ok((
        authored,
        u32::try_from(suppressed).map_err(|_| {
            TsrxParseError::Unsupported("suppressed module-record count exceeds 4 GiB")
        })?,
    ))
}

fn reconstruct_static_imports(
    projected: &mut ModuleTable,
    projected_strings: &str,
    segments: &[ProjectionSegment],
    authored: &mut ModuleTable,
) -> Result<usize, TsrxParseError> {
    let mut suppressed = 0;
    let (records, entries) = projected.take_static_imports();
    for record in records {
        let entries = range_slice(&entries, record.entries)
            .ok_or(TsrxParseError::Unsupported("projected static-import entry range is invalid"))?;
        let mut state = MappingState::default();
        let span = mapped_module_span(segments, record.span, &mut state);
        let module_request = mapped_value(segments, record.module_request, &mut state);
        for entry in entries {
            let _ = mapped_import_entry(segments, *entry, &mut state);
        }
        if !state.retain("mixed authored and synthetic static-import record")? {
            suppressed += 1;
            continue;
        }
        let span = span
            .ok_or(TsrxParseError::Unsupported("authored static import has no statement span"))?;
        let module_request = module_request
            .ok_or(TsrxParseError::Unsupported("authored static import has no module request"))?;
        let entry_start = authored.begin_static_import_entries()?;
        for entry in entries {
            let mut entry_state = MappingState::default();
            let entry = mapped_import_entry(segments, *entry, &mut entry_state);
            ensure_retained(
                &entry_state,
                "authored static-import mapping changed between validation and emission",
            )?;
            let entry = copy_import_entry(projected_strings, authored, entry)?;
            authored.push_static_import_entry(entry)?;
        }
        let entries = authored.finish_static_import_entries(entry_start, record.entries.length)?;
        let module_request = copy_value(projected_strings, authored, module_request)?;
        authored.push_static_import(StaticImportRecord { span, module_request, entries })?;
    }
    Ok(suppressed)
}

fn reconstruct_static_exports(
    projected: &mut ModuleTable,
    projected_strings: &str,
    segments: &[ProjectionSegment],
    overlay: OverlayView<'_>,
    authored: &mut ModuleTable,
) -> Result<usize, TsrxParseError> {
    let mut suppressed = 0;
    let (records, entries) = projected.take_static_exports();
    for record in records {
        let entries = range_slice(&entries, record.entries)
            .ok_or(TsrxParseError::Unsupported("projected static-export entry range is invalid"))?;
        let mut state = MappingState::default();
        let span = mapped_module_span(segments, record.span, &mut state);
        for entry in entries {
            let override_span = default_expression_code_block_span(*entry, segments, overlay);
            let _ = mapped_export_entry(segments, *entry, override_span, &mut state);
        }
        if !state.retain("mixed authored and synthetic static-export record")? {
            suppressed += 1;
            continue;
        }
        let span = span
            .ok_or(TsrxParseError::Unsupported("authored static export has no statement span"))?;
        let mut module_request_cache = None;
        let entry_start = authored.begin_static_export_entries()?;
        for entry in entries {
            let mut entry_state = MappingState::default();
            let override_span = default_expression_code_block_span(*entry, segments, overlay);
            let entry = mapped_export_entry(segments, *entry, override_span, &mut entry_state);
            ensure_retained(
                &entry_state,
                "authored static-export mapping changed between validation and emission",
            )?;
            let entry =
                copy_export_entry(projected_strings, authored, entry, &mut module_request_cache)?;
            authored.push_static_export_entry(entry)?;
        }
        let entries = authored.finish_static_export_entries(entry_start, record.entries.length)?;
        authored.push_static_export(StaticExportRecord { span, entries })?;
    }
    Ok(suppressed)
}

fn reconstruct_dynamic_imports(
    projected: &mut ModuleTable,
    segments: &[ProjectionSegment],
    authored: &mut ModuleTable,
) -> Result<usize, TsrxParseError> {
    let mut suppressed = 0;
    for record in projected.take_dynamic_imports() {
        let mut state = MappingState::default();
        let span = mapped_span(segments, record.span, &mut state);
        let module_request = mapped_span(segments, record.module_request, &mut state);
        if !state.retain("mixed authored and synthetic dynamic-import record")? {
            suppressed += 1;
            continue;
        }
        authored.push_dynamic_import(DynamicImportRecord {
            span: span.ok_or(TsrxParseError::Unsupported(
                "authored dynamic import has no expression span",
            ))?,
            module_request: module_request.ok_or(TsrxParseError::Unsupported(
                "authored dynamic import has no request span",
            ))?,
        })?;
    }
    Ok(suppressed)
}

fn reconstruct_import_metas(
    projected: &mut ModuleTable,
    segments: &[ProjectionSegment],
    authored: &mut ModuleTable,
) -> Result<usize, TsrxParseError> {
    let mut suppressed = 0;
    for span in projected.take_import_metas() {
        let mut state = MappingState::default();
        let mapped = mapped_span(segments, span, &mut state);
        if !state.retain("mixed authored and synthetic import-meta record")? {
            suppressed += 1;
            continue;
        }
        authored.push_import_meta(
            mapped.ok_or(TsrxParseError::Unsupported("authored import.meta has no span"))?,
        )?;
    }
    Ok(suppressed)
}

pub(super) fn reconstruct_diagnostics(
    mut projected: DiagnosticTable,
    segments: &[ProjectionSegment],
    recover_mixed_labels: bool,
) -> Result<(DiagnosticTable, u32), TsrxParseError> {
    let mut authored = DiagnosticTable::default();
    let mut suppressed = 0_usize;
    let (records, labels) = projected.take_records_and_labels();
    let projected_strings = projected.take_string_storage()?;
    debug_assert!(projected.is_storage_released());
    drop(projected);
    for record in records {
        let labels = range_slice(&labels, record.labels)
            .ok_or(TsrxParseError::Unsupported("projected diagnostic label range is invalid"))?;
        if labels.is_empty() {
            let label_start = authored.begin_labels()?;
            let labels = authored.finish_labels(label_start, record.labels.length)?;
            copy_diagnostic(&projected_strings, &mut authored, record, labels)?;
            continue;
        }
        let mut state = MappingState::default();
        for label in labels {
            let _ = mapped_span(segments, label.span, &mut state);
        }
        let retain = match state.retain("mixed authored and synthetic diagnostic labels") {
            Ok(retain) => retain,
            Err(_) if recover_mixed_labels && state.mapped > 0 => true,
            Err(error) => return Err(error),
        };
        if !retain {
            suppressed += 1;
            continue;
        }
        let label_start = authored.begin_labels()?;
        let mut mapped_labels = 0;
        for label in labels {
            let Some(span) = map_affine_span(segments, label.span) else {
                if recover_mixed_labels {
                    continue;
                }
                return Err(TsrxParseError::Unsupported(
                    "authored diagnostic mapping changed between validation and emission",
                ));
            };
            authored.push_labeled(
                span,
                optional_string(&projected_strings, label.message)?,
                label.primary,
            )?;
            mapped_labels += 1;
        }
        let labels = authored.finish_labels(label_start, mapped_labels)?;
        copy_diagnostic(&projected_strings, &mut authored, record, labels)?;
    }
    drop(labels);
    drop(projected_strings);
    Ok((
        authored,
        u32::try_from(suppressed).map_err(|_| {
            TsrxParseError::Unsupported("suppressed diagnostic count exceeds 4 GiB")
        })?,
    ))
}

fn copy_diagnostic(
    projected_strings: &str,
    authored: &mut DiagnosticTable,
    record: tsrx_tape_schema::DiagnosticRecord,
    labels: ListRange,
) -> Result<(), TsrxParseError> {
    authored.push_diagnostic(
        record.phase,
        record.severity,
        required_string(projected_strings, record.message)?,
        labels,
        optional_string(projected_strings, record.help)?,
        optional_string(projected_strings, record.note)?,
        optional_string(projected_strings, record.code_scope)?,
        optional_string(projected_strings, record.code_number)?,
        optional_string(projected_strings, record.url)?,
        None,
    )?;
    Ok(())
}

fn range_slice<T>(records: &[T], range: ListRange) -> Option<&[T]> {
    let start = usize::try_from(range.start).ok()?;
    let length = usize::try_from(range.length).ok()?;
    records.get(start..start.checked_add(length)?)
}

fn mapped_value(
    segments: &[ProjectionSegment],
    value: ValueSpanRecord,
    state: &mut MappingState,
) -> Option<MappedValueSpan> {
    mapped_span(segments, value.span, state)
        .map(|span| MappedValueSpan { value: value.value, span })
}

fn mapped_name<K: Copy>(
    segments: &[ProjectionSegment],
    name: ModuleNameRecord<K>,
    state: &mut MappingState,
) -> MappedName<K> {
    MappedName {
        kind: name.kind,
        name: name.name,
        span: name.span.get().and_then(|span| mapped_span(segments, span, state)),
    }
}

fn mapped_import_entry(
    segments: &[ProjectionSegment],
    entry: StaticImportEntryRecord,
    state: &mut MappingState,
) -> MappedImportEntry {
    MappedImportEntry {
        import_name: mapped_name(segments, entry.import_name, state),
        local_name: mapped_value(segments, entry.local_name, state),
        is_type: entry.is_type,
    }
}

fn default_expression_code_block_span(
    entry: StaticExportEntryRecord,
    segments: &[ProjectionSegment],
    overlay: OverlayView<'_>,
) -> Option<TapeSpan> {
    if entry.export_name.kind != ExportExportNameKind::Default {
        return None;
    }
    overlay.parser_code_blocks.iter().find_map(|block| {
        if block.kind != ParserCodeBlockKind::Expression {
            return None;
        }
        let projected_body_start = project_authored_start(segments, block.body.start)?;
        let projected_wrapper_start = projected_body_start
            .checked_sub(u32::try_from(PARSER_EXPRESSION_CODE_BLOCK_PREFIX.len()).ok()?)?;
        if entry.span.start != projected_wrapper_start {
            return None;
        }
        let token = overlay.tokens.get(block.token as usize)?;
        let authored_end = map_endpoint(segments, entry.span.end, false)?;
        Some(TapeSpan::new(token.span.start, authored_end))
    })
}

fn mapped_export_entry(
    segments: &[ProjectionSegment],
    entry: StaticExportEntryRecord,
    override_span: Option<TapeSpan>,
    state: &mut MappingState,
) -> MappedExportEntry {
    let span = if let Some(span) = override_span {
        state.record(true);
        Some(span)
    } else {
        mapped_module_span(segments, entry.span, state)
    };
    MappedExportEntry {
        span,
        module_request: entry
            .module_request
            .get()
            .and_then(|value| mapped_value(segments, value, state)),
        import_name: mapped_name(segments, entry.import_name, state),
        export_name: mapped_name(segments, entry.export_name, state),
        local_name: mapped_name(segments, entry.local_name, state),
        is_type: entry.is_type,
    }
}

fn ensure_retained(state: &MappingState, changed: &'static str) -> Result<(), TsrxParseError> {
    if state.retain(changed)? { Ok(()) } else { Err(TsrxParseError::Unsupported(changed)) }
}

fn mapped_span(
    segments: &[ProjectionSegment],
    span: TapeSpan,
    state: &mut MappingState,
) -> Option<TapeSpan> {
    let mapped = map_affine_span(segments, span);
    state.record(mapped.is_some());
    mapped
}

fn mapped_module_span(
    segments: &[ProjectionSegment],
    span: TapeSpan,
    state: &mut MappingState,
) -> Option<TapeSpan> {
    let mapped = if span.start == span.end {
        map_affine_span(segments, span)
    } else {
        map_endpoint(segments, span.start, true)
            .zip(map_endpoint(segments, span.end, false))
            .filter(|(start, end)| start <= end)
            .map(|(start, end)| TapeSpan::new(start, end))
    };
    state.record(mapped.is_some());
    mapped
}

fn copy_import_entry(
    projected_strings: &str,
    authored: &mut ModuleTable,
    entry: MappedImportEntry,
) -> Result<StaticImportEntryRecord, TsrxParseError> {
    Ok(StaticImportEntryRecord {
        import_name: copy_name(projected_strings, authored, entry.import_name)?,
        local_name: copy_value(
            projected_strings,
            authored,
            entry.local_name.ok_or(TsrxParseError::Unsupported(
                "authored static-import entry has no local span",
            ))?,
        )?,
        is_type: entry.is_type,
    })
}

fn copy_export_entry(
    projected_strings: &str,
    authored: &mut ModuleTable,
    entry: MappedExportEntry,
    module_request_cache: &mut Option<(StringRange, StringRange)>,
) -> Result<StaticExportEntryRecord, TsrxParseError> {
    let module_request = entry.module_request.map_or_else(
        || Ok(OptionalValueSpanRecord::NONE),
        |value| {
            copy_shared_value(projected_strings, authored, value, module_request_cache)
                .map(OptionalValueSpanRecord::some)
        },
    )?;
    Ok(StaticExportEntryRecord {
        span: entry
            .span
            .ok_or(TsrxParseError::Unsupported("authored static-export entry has no span"))?,
        module_request,
        import_name: copy_name(projected_strings, authored, entry.import_name)?,
        export_name: copy_name(projected_strings, authored, entry.export_name)?,
        local_name: copy_name(projected_strings, authored, entry.local_name)?,
        is_type: entry.is_type,
    })
}

fn copy_shared_value(
    projected_strings: &str,
    authored: &mut ModuleTable,
    value: MappedValueSpan,
    cache: &mut Option<(StringRange, StringRange)>,
) -> Result<ValueSpanRecord, TsrxParseError> {
    let packed = match *cache {
        Some((source, authored)) if source == value.value => authored,
        _ => {
            let packed =
                authored.push_string(packed_string(projected_strings, value.value).ok_or(
                    TsrxParseError::Unsupported("projected shared module string range is invalid"),
                )?)?;
            *cache = Some((value.value, packed));
            packed
        }
    };
    Ok(ValueSpanRecord { value: packed, span: value.span })
}

fn copy_value(
    projected_strings: &str,
    authored: &mut ModuleTable,
    value: MappedValueSpan,
) -> Result<ValueSpanRecord, TsrxParseError> {
    let string = packed_string(projected_strings, value.value)
        .ok_or(TsrxParseError::Unsupported("projected module string range is invalid"))?;
    Ok(ValueSpanRecord { value: authored.push_string(string)?, span: value.span })
}

fn copy_name<K: Copy>(
    projected_strings: &str,
    authored: &mut ModuleTable,
    name: MappedName<K>,
) -> Result<ModuleNameRecord<K>, TsrxParseError> {
    let packed = match name.name.get() {
        Some(range) => OptionalStringRange::some(
            authored
                .push_string(packed_string(projected_strings, range).ok_or(
                    TsrxParseError::Unsupported("projected module-name range is invalid"),
                )?)?,
        ),
        None => OptionalStringRange::NONE,
    };
    Ok(ModuleNameRecord {
        kind: name.kind,
        name: packed,
        span: name.span.map_or(OptionalTapeSpan::NONE, OptionalTapeSpan::some),
    })
}

fn required_string(storage: &str, range: StringRange) -> Result<&str, TsrxParseError> {
    packed_string(storage, range)
        .ok_or(TsrxParseError::Unsupported("projected diagnostic string range is invalid"))
}

fn optional_string(
    storage: &str,
    range: OptionalStringRange,
) -> Result<Option<&str>, TsrxParseError> {
    range.get().map_or(Ok(None), |range| {
        packed_string(storage, range).map(Some).ok_or(TsrxParseError::Unsupported(
            "projected optional diagnostic string range is invalid",
        ))
    })
}

fn packed_string(storage: &str, range: StringRange) -> Option<&str> {
    let start = usize::try_from(range.start).ok()?;
    let length = usize::try_from(range.length).ok()?;
    storage.get(start..start.checked_add(length)?)
}

#[cfg(test)]
mod tests {
    use tsrx_syntax::{ByteSpan, ProjectionSegment, scan_for_parser};
    use tsrx_tape_schema::{
        DiagnosticPhase, DiagnosticSeverity, DiagnosticTable, DynamicImportRecord, ModuleTable,
        TapeSpan,
    };

    use super::{reconstruct_diagnostics, reconstruct_module};

    fn authored_segment() -> [ProjectionSegment; 1] {
        [ProjectionSegment { projected: ByteSpan::new(0, 10), original_start: 100, fixable: true }]
    }

    #[test]
    fn synthetic_result_records_are_suppressed_and_mixed_records_fail_closed() {
        let segments = authored_segment();
        let overlay = scan_for_parser("").expect("empty overlay");
        let mut synthetic = ModuleTable::new();
        synthetic
            .push_dynamic_import(DynamicImportRecord::new(
                TapeSpan::new(20, 30),
                TapeSpan::new(22, 25),
            ))
            .expect("synthetic dynamic import");
        synthetic.push_import_meta(TapeSpan::new(31, 42)).expect("synthetic import.meta");
        let (authored, suppressed) = reconstruct_module(synthetic, &segments, overlay.view())
            .expect("synthetic suppression");
        assert_eq!(suppressed, 2);
        assert!(authored.dynamic_imports().is_empty());
        assert!(authored.import_metas().is_empty());
        assert!(!authored.has_module_syntax());

        let mut mixed = ModuleTable::new();
        mixed
            .push_dynamic_import(DynamicImportRecord::new(
                TapeSpan::new(1, 5),
                TapeSpan::new(20, 22),
            ))
            .expect("mixed dynamic import");
        assert!(reconstruct_module(mixed, &segments, overlay.view()).is_err());
    }

    #[test]
    fn coordinate_free_diagnostics_survive_while_synthetic_and_mixed_labels_do_not() {
        let segments = authored_segment();
        let mut coordinate_free = DiagnosticTable::new();
        let labels = coordinate_free.append_labels(std::iter::empty()).expect("empty label range");
        coordinate_free
            .push_diagnostic(
                DiagnosticPhase::Grammar,
                DiagnosticSeverity::Warning,
                "coordinate free",
                labels,
                Some("help"),
                Some("note"),
                Some("scope"),
                Some("number"),
                Some("https://example.invalid"),
                None,
            )
            .expect("coordinate-free diagnostic");
        let (authored, suppressed) = reconstruct_diagnostics(coordinate_free, &segments, false)
            .expect("coordinate-free diagnostic survives");
        assert_eq!(suppressed, 0);
        let record = &authored.records()[0];
        assert_eq!(authored.string(record.message), Some("coordinate free"));
        assert_eq!(authored.optional_string(record.help), Some("help"));
        assert_eq!(authored.optional_string(record.note), Some("note"));
        assert_eq!(authored.optional_string(record.code_scope), Some("scope"));
        assert_eq!(authored.optional_string(record.code_number), Some("number"));
        assert_eq!(authored.optional_string(record.url), Some("https://example.invalid"));

        let mut synthetic = DiagnosticTable::new();
        let labels = synthetic
            .append_labels([(TapeSpan::new(20, 21), None, true)])
            .expect("synthetic labels");
        synthetic
            .push_diagnostic(
                DiagnosticPhase::Grammar,
                DiagnosticSeverity::Error,
                "synthetic",
                labels,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("synthetic diagnostic");
        let (authored, suppressed) =
            reconstruct_diagnostics(synthetic, &segments, false).expect("synthetic suppression");
        assert!(authored.is_empty());
        assert_eq!(suppressed, 1);

        let mut mixed = DiagnosticTable::new();
        let labels = mixed
            .append_labels([
                (TapeSpan::new(1, 2), None, true),
                (TapeSpan::new(20, 21), None, false),
            ])
            .expect("mixed labels");
        mixed
            .push_diagnostic(
                DiagnosticPhase::Grammar,
                DiagnosticSeverity::Error,
                "mixed",
                labels,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("mixed diagnostic");
        assert!(reconstruct_diagnostics(mixed, &segments, false).is_err());
    }

    #[test]
    fn diagnostics_crossing_projection_gaps_or_empty_boundaries_are_never_relocated() {
        let segments = [
            ProjectionSegment {
                projected: ByteSpan::new(0, 5),
                original_start: 100,
                fixable: true,
            },
            ProjectionSegment {
                projected: ByteSpan::new(10, 15),
                original_start: 200,
                fixable: true,
            },
        ];
        for span in [TapeSpan::new(3, 12), TapeSpan::new(5, 5)] {
            let mut projected = DiagnosticTable::new();
            let labels = projected.append_labels([(span, None, true)]).expect("projected labels");
            projected
                .push_diagnostic(
                    DiagnosticPhase::Grammar,
                    DiagnosticSeverity::Error,
                    "non-affine",
                    labels,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("projected diagnostic");
            let (authored, suppressed) = reconstruct_diagnostics(projected, &segments, false)
                .expect("non-affine diagnostics are suppressed exactly");
            assert!(authored.is_empty());
            assert_eq!(suppressed, 1);
        }
    }
}

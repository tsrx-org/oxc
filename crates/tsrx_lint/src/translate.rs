//! Moving diagnostics out of projected coordinates back onto the author's source, and dropping
//! the ones that landed in generated scaffolding the author never wrote.

use oxc_adapter::EngineDiagnostic;
use tsrx_syntax::{MappedProjection, TypeProjection, project_for_lint, scan_for_parser};

/// One diagnostic label range, in bytes.
///
/// The JavaScript plugin lane hands Oxlint's own label spans across this type so the projection
/// itself is never serialized out of this crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PluginLabel {
    pub offset: u32,
    pub length: u32,
}

/// One authored TSRX source's legal-TSX projection, exposed for the JavaScript plugin lane.
///
/// The published Oxlint binary hosts a user's JavaScript rules over [`PluginProjection::source`],
/// then its diagnostics come back through [`PluginProjection::map_labels`]. Only byte ranges cross
/// the process boundary: [`MappedProjection`] carries segments, dynamic offsets, and synthetic
/// spans whose rejection rules live here and stay here.
#[derive(Debug)]
pub struct PluginProjection {
    projection: MappedProjection,
}

impl PluginProjection {
    /// Scan and project one authored TSRX source.
    ///
    /// # Errors
    ///
    /// Returns the scanner's or projector's own message for a TSRX source that cannot be
    /// projected. The native lane reports that failure as the file's own diagnostic already, so
    /// the plugin lane simply contributes nothing for such a file.
    pub fn new(source: &str) -> Result<Self, String> {
        let overlay = scan_for_parser(source).map_err(|error| error.to_string())?;
        let projection = project_for_lint(source, &overlay).map_err(|error| error.to_string())?;
        Ok(Self { projection })
    }

    /// The legal TSX the published Oxlint binary lints.
    #[must_use]
    pub fn source(&self) -> &str {
        self.projection.source()
    }

    /// Map one diagnostic's label spans from projection bytes to authored bytes.
    ///
    /// `None` means the diagnostic must be dropped, under exactly the rule the native lane already
    /// applies to canonical OXC's own diagnostics.
    #[must_use]
    pub fn map_labels(&self, labels: &[PluginLabel]) -> Option<Vec<PluginLabel>> {
        map_projection_labels(&self.projection, labels)
    }

    /// Map one label that runs to the end of everything this projection copied.
    ///
    /// A rule that reports on the whole `Program` gets the span OXC gave that node in the
    /// projection: it starts at the first token, after any leading trivia, and runs to the end of
    /// the source Oxlint linted. That range crosses every marker and synthetic wrapper the
    /// projection inserted, so [`Self::map_labels`] can never place it inside one authored segment
    /// and drops it. Such a report used to fire at the top of an ordinary `.tsx` and vanish
    /// without a trace on the byte-identical `.tsrx`.
    ///
    /// The answer is `first authored byte the label covers .. authored_length`: the report really
    /// does cover the authored source from there to the end of the file, so nothing is invented.
    /// `None` when the label does not reach the end of the authored region, or when it starts
    /// after the last byte this projection copied. Both of those are genuinely projection-only
    /// reports, and they stay dropped.
    #[must_use]
    pub fn map_whole_file_label(
        &self,
        label: PluginLabel,
        authored_length: u32,
    ) -> Option<PluginLabel> {
        let segments = self.projection.view().segments;
        let authored_end = segments.iter().map(|segment| segment.projected.end).max()?;
        if label.offset.saturating_add(label.length) < authored_end {
            return None;
        }
        // The authored byte the label starts covering: the affine image of its own start when
        // that start is inside copied text, and otherwise the first copied byte after it.
        let start = segments
            .iter()
            .filter_map(|segment| {
                if label.offset < segment.projected.start {
                    Some(segment.original_start)
                } else if label.offset < segment.projected.end {
                    Some(segment.original_start + (label.offset - segment.projected.start))
                } else {
                    None
                }
            })
            .min()?;
        (start <= authored_length)
            .then_some(PluginLabel { offset: start, length: authored_length - start })
    }
}

/// The single rejection rule for projection-to-authored label mapping.
///
/// A diagnostic survives only when it carries at least one label and every one of those labels
/// lies inside an authored range. A label that landed on projection-only text (an inserted marker,
/// a synthetic wrapper) has no authored position to report, and a diagnostic reported at a
/// position the user did not write is worse than no diagnostic at all.
///
/// [`translate_diagnostics`] and [`PluginProjection::map_labels`] both go through this function so
/// the native rules and the JavaScript plugin lane can never drift apart on it.
fn map_projection_labels(
    projection: &MappedProjection,
    labels: &[PluginLabel],
) -> Option<Vec<PluginLabel>> {
    if labels.is_empty() {
        return None;
    }
    let mut mapped = Vec::with_capacity(labels.len());
    for label in labels {
        let range = label.offset..label.offset.saturating_add(label.length);
        let authored = projection.map_range(range)?;
        mapped.push(PluginLabel { offset: authored.start, length: authored.end - authored.start });
    }
    Some(mapped)
}

#[derive(Default)]
pub(crate) struct TranslatedDiagnostics {
    pub(crate) diagnostics: Vec<EngineDiagnostic>,
    pub(crate) suppressed: u32,
    pub(crate) rejected_fixes: u32,
}

pub(crate) fn translate_diagnostics(
    diagnostics: Vec<EngineDiagnostic>,
    projection: Option<&MappedProjection>,
) -> TranslatedDiagnostics {
    let Some(projection) = projection else {
        return TranslatedDiagnostics { diagnostics, ..TranslatedDiagnostics::default() };
    };
    let mut translated = TranslatedDiagnostics::default();
    for mut diagnostic in diagnostics {
        let ranges = diagnostic
            .labels
            .iter()
            .map(|label| PluginLabel { offset: label.offset, length: label.length })
            .collect::<Vec<_>>();
        let Some(mapped) = map_projection_labels(projection, &ranges) else {
            translated.suppressed += 1;
            translated.rejected_fixes += u32::try_from(diagnostic.fixes.len()).unwrap_or(u32::MAX);
            continue;
        };
        for (label, authored) in diagnostic.labels.iter_mut().zip(&mapped) {
            label.offset = authored.offset;
            label.length = authored.length;
        }
        if diagnostic.rule.as_deref() == Some("require-yield")
            && diagnostic.labels.iter().any(|label| {
                projection.is_synthetic_generator_range(
                    label.offset..label.offset.saturating_add(label.length),
                )
            })
        {
            translated.suppressed = translated.suppressed.saturating_add(1);
            translated.rejected_fixes = translated
                .rejected_fixes
                .saturating_add(u32::try_from(diagnostic.fixes.len()).unwrap_or(u32::MAX));
            continue;
        }
        diagnostic.fixes = diagnostic
            .fixes
            .into_iter()
            .filter_map(|mut fix| {
                let range = fix.offset..fix.offset.saturating_add(fix.length);
                let Some(mapped) = projection.map_fix_range(range) else {
                    translated.rejected_fixes += 1;
                    return None;
                };
                fix.offset = mapped.start;
                fix.length = mapped.end - mapped.start;
                Some(fix)
            })
            .collect();
        translated.diagnostics.push(diagnostic);
    }
    translated
}

pub(crate) fn translate_type_diagnostics(
    diagnostics: Vec<EngineDiagnostic>,
    projection: Option<&TypeProjection>,
) -> TranslatedDiagnostics {
    let Some(projection) = projection else {
        return TranslatedDiagnostics { diagnostics, ..TranslatedDiagnostics::default() };
    };
    let mut translated = TranslatedDiagnostics::default();
    for mut diagnostic in diagnostics {
        if diagnostic.labels.is_empty() {
            translated.suppressed = translated.suppressed.saturating_add(1);
            translated.rejected_fixes = translated
                .rejected_fixes
                .saturating_add(u32::try_from(diagnostic.fixes.len()).unwrap_or(u32::MAX));
            continue;
        }
        let mut labels = Vec::with_capacity(diagnostic.labels.len());
        for mut label in diagnostic.labels {
            let range = label.offset..label.offset.saturating_add(label.length);
            let Some(mapped) = projection.map_range(range) else {
                labels.clear();
                break;
            };
            label.offset = mapped.start;
            label.length = mapped.end - mapped.start;
            labels.push(label);
        }
        if labels.is_empty() {
            translated.suppressed = translated.suppressed.saturating_add(1);
            translated.rejected_fixes = translated
                .rejected_fixes
                .saturating_add(u32::try_from(diagnostic.fixes.len()).unwrap_or(u32::MAX));
            continue;
        }
        diagnostic.labels = labels;
        diagnostic.fixes = diagnostic
            .fixes
            .into_iter()
            .filter_map(|mut fix| {
                let range = fix.offset..fix.offset.saturating_add(fix.length);
                let Some(mapped) = projection.map_fix_range(range) else {
                    translated.rejected_fixes = translated.rejected_fixes.saturating_add(1);
                    return None;
                };
                fix.offset = mapped.start;
                fix.length = mapped.end - mapped.start;
                Some(fix)
            })
            .collect();
        translated.diagnostics.push(diagnostic);
    }
    translated
}

#[cfg(test)]
mod tests {
    use tsrx_syntax::{project_for_lint, scan};

    use super::{PluginLabel, PluginProjection};

    #[test]
    fn plugin_projection_maps_labels_and_rejects_projection_only_text() {
        let source = "function View() @{ var banned = 1; <p>{banned}</p>; }";
        let projection = PluginProjection::new(source).unwrap();
        // The published Oxlint binary lints this text, so a plugin's byte offsets are offsets into
        // it rather than into what the user wrote.
        let projected = u32::try_from(projection.source().find("banned").unwrap()).unwrap();
        let authored = u32::try_from(source.find("banned").unwrap()).unwrap();
        assert_eq!(
            projection.map_labels(&[PluginLabel { offset: projected, length: 6 }]),
            Some(vec![PluginLabel { offset: authored, length: 6 }])
        );

        // A diagnostic with no label has no authored position at all.
        assert_eq!(projection.map_labels(&[]), None);

        // A label on text the projection inserted is dropped whole, and one unmappable label
        // rejects the entire diagnostic rather than reporting a subset at the wrong place.
        let marker = u32::try_from(projection.source().find("/*").unwrap()).unwrap();
        assert_eq!(projection.map_labels(&[PluginLabel { offset: marker, length: 1 }]), None);
        assert_eq!(
            projection.map_labels(&[
                PluginLabel { offset: projected, length: 6 },
                PluginLabel { offset: marker, length: 1 },
            ]),
            None
        );
    }

    /// A whole-file report survives leading trivia, which is what a `Program` node always has to
    /// step over. The offsets here are the ones OXC gives that node: it starts at the first token,
    /// not at byte zero, so a check written as `offset == 0` silently dropped every one of these.
    #[test]
    fn plugin_projection_maps_a_whole_file_label_through_leading_trivia() {
        for prefix in
            ["", "\n", "// leading comment\n", "/* leading block */\n", "// @ts-nocheck\n"]
        {
            let source =
                format!("{prefix}function View() @{{ var banned = 1; <p>{{banned}}</p>; }}\n");
            let projection = PluginProjection::new(&source).unwrap();
            let authored_length = u32::try_from(source.len()).unwrap();
            let projected_length = u32::try_from(projection.source().len()).unwrap();
            // Exactly the span a rule reporting on `Program` carries: first token to end of file.
            let program_start =
                u32::try_from(projection.source().find("function").unwrap()).unwrap();
            let label =
                PluginLabel { offset: program_start, length: projected_length - program_start };
            // The all-or-nothing mapping cannot place it: it crosses the inserted markers.
            assert_eq!(projection.map_labels(&[label]), None, "{prefix:?}");

            let mapped = projection
                .map_whole_file_label(label, authored_length)
                .unwrap_or_else(|| panic!("a whole-file report was dropped after {prefix:?}"));
            let authored_start = u32::try_from(source.find("function").unwrap()).unwrap();
            assert_eq!(mapped.offset, authored_start, "{prefix:?}");
            assert_eq!(mapped.offset + mapped.length, authored_length, "{prefix:?}");
        }
    }

    /// The widening must not turn a report on inserted text into a report on the user's code.
    #[test]
    fn plugin_projection_still_drops_a_projection_only_label() {
        let source = "function View() @{ var banned = 1; <p>{banned}</p>; }";
        let projection = PluginProjection::new(source).unwrap();
        let authored_length = u32::try_from(source.len()).unwrap();
        let marker = u32::try_from(projection.source().find("/*").unwrap()).unwrap();
        let label = PluginLabel { offset: marker, length: 4 };
        assert_eq!(projection.map_labels(&[label]), None);
        // It covers no authored byte and does not reach the end of the copied region, so it has no
        // authored position and stays dropped rather than being reported at an invented one.
        assert_eq!(projection.map_whole_file_label(label, authored_length), None);
    }

    #[test]
    fn plugin_projection_rejects_an_unprojectable_source() {
        let error = PluginProjection::new("export function Broken() @{\n  <main>\n}\n")
            .expect_err("an unprojectable TSRX source has no legal TSX to lint");
        assert!(error.contains("unterminated"), "{error}");
    }

    #[test]
    fn fix_mapping_is_identity_only() {
        let source = "function View() @{ var value = 1; }";
        let overlay = scan(source).unwrap();
        let projection = project_for_lint(source, &overlay).unwrap();
        let projected_var = u32::try_from(projection.source().find("var").unwrap()).unwrap();
        let original_var = u32::try_from(source.find("var").unwrap()).unwrap();
        assert_eq!(
            projection.map_range(projected_var..projected_var + 3),
            Some(original_var..original_var + 3)
        );
        let marker = u32::try_from(projection.source().find("/*").unwrap()).unwrap();
        assert!(projection.map_range(marker..marker + 1).is_none());
    }
}

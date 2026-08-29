//! Applying safe fixes, and shaping those same fixes for an editor that will apply them itself.

use std::{cmp::Reverse, collections::HashSet, fs, path::Path};

use oxc_adapter::{DynamicTagContract, EngineDiagnostic, LintRequest, SourceKind};
use tsrx_syntax::{MappedProjection, project_for_lint, scan_for_parser};

use crate::{
    error::LintError,
    pipeline::PreparedSource,
    report::{EditorFix, diagnostic_code},
    session::LintSession,
};

#[derive(Default)]
pub(crate) struct AppliedFixes {
    pub(crate) applied: u32,
    pub(crate) rejected: u32,
    pub(crate) reparse_count: u32,
    pub(crate) rules: Vec<String>,
}

pub(crate) fn apply_safe_fixes(
    session: &LintSession,
    path: &Path,
    source: &str,
    prepared: &PreparedSource,
    diagnostics: &[EngineDiagnostic],
    rejected_fixes: u32,
) -> Result<AppliedFixes, LintError> {
    let mut result = AppliedFixes { rejected: rejected_fixes, ..AppliedFixes::default() };
    let mut edits = Vec::new();
    for diagnostic in diagnostics {
        for fix in &diagnostic.fixes {
            let range = fix.offset..fix.offset.saturating_add(fix.length);
            if !fix.safe || range.end as usize > source.len() {
                result.rejected += 1;
                continue;
            }
            edits.push((range, fix.replacement.clone(), diagnostic.rule.clone()));
        }
    }
    edits.sort_unstable_by_key(|edit| Reverse(edit.0.start));
    let mut fixed = source.to_string();
    let mut previous_start = u32::MAX;
    for (range, replacement, rule) in edits {
        if range.end > previous_start {
            result.rejected += 1;
            continue;
        }
        fixed.replace_range(range.start as usize..range.end as usize, &replacement);
        previous_start = range.start;
        result.applied += 1;
        result.rules.extend(rule);
    }
    if result.applied > 0 {
        validate_fixed(session, path, &fixed, prepared.is_tsrx, prepared.source_kind)?;
        result.reparse_count = 1;
        fs::write(path, fixed).map_err(|error| LintError::unwritable(path, error))?;
    }
    Ok(result)
}

pub(crate) fn collect_editor_fixes(
    session: &LintSession,
    path: &Path,
    source: &str,
    prepared: &PreparedSource,
    diagnostics: &[EngineDiagnostic],
) -> Vec<EditorFix> {
    let mut fixes = Vec::new();
    let mut seen = HashSet::new();
    for diagnostic in diagnostics {
        let rule = diagnostic.rule.clone().unwrap_or_else(|| diagnostic_code(diagnostic));
        for fix in &diagnostic.fixes {
            let end = fix.offset.saturating_add(fix.length);
            if !fix.safe || end as usize > source.len() {
                continue;
            }
            let identity = (fix.offset, fix.length, fix.replacement.clone());
            if !seen.insert(identity) {
                continue;
            }
            let mut candidate = source.to_string();
            candidate.replace_range(fix.offset as usize..end as usize, &fix.replacement);
            if validate_fixed(session, path, &candidate, prepared.is_tsrx, prepared.source_kind)
                .is_err()
            {
                continue;
            }
            fixes.push(EditorFix {
                title: format!("Fix {rule}"),
                rule: rule.clone(),
                offset: fix.offset,
                length: fix.length,
                replacement: fix.replacement.clone(),
            });
        }
    }
    fixes
}

fn validate_fixed(
    session: &LintSession,
    path: &Path,
    fixed: &str,
    is_tsrx: bool,
    source_kind: SourceKind,
) -> Result<(), LintError> {
    let projection =
        if is_tsrx { Some(project_for_lint(fixed, &scan_for_parser(fixed)?)?) } else { None };
    let parse_source = projection.as_ref().map_or(fixed, MappedProjection::source);
    session.engine.lint(&LintRequest {
        path,
        original_source: fixed,
        parse_source,
        source_kind,
        rules: &[],
        collect_fixes: session.fix,
        dynamic_tags: projection.as_ref().and_then(|projection| {
            projection.dynamic_contract().map(|(prefix, count, original_offsets)| {
                DynamicTagContract { prefix, count, original_offsets }
            })
        }),
    })?;
    Ok(())
}

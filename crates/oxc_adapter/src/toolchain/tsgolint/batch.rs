//! Turning TSRX projections into one protocol-v2 payload, and its answers back into diagnostics.

use std::{
    borrow::Cow,
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use oxc_linter::{AllowWarnDeny, DisableDirectives};
use oxc_span::Span;
use rustc_hash::FxHashMap;

use super::TsgolintError;
use super::protocol::{ProtocolConfigGroup, ProtocolDiagnostic, ProtocolPayload, ProtocolRule};
use super::tsconfig::{ProjectedFile, tsconfig_overrides};
use crate::toolchain::{
    EngineDiagnostic, EngineFix, EngineSpan, LintEngine, TypeBatchDiagnostic, TypeBatchFile,
};

pub(crate) struct PreparedTypeBatch<'a> {
    pub(crate) payload: ProtocolPayload<'a>,
    pub(super) severities: FxHashMap<PathBuf, FxHashMap<&'static str, AllowWarnDeny>>,
    pub(super) directives: FxHashMap<PathBuf, &'a DisableDirectives>,
}

pub(crate) fn prepare_type_batch<'a>(
    engine: &LintEngine,
    files: &'a [TypeBatchFile<'a>],
) -> Result<PreparedTypeBatch<'a>, TsgolintError> {
    let mut groups = BTreeMap::<String, ProtocolConfigGroup>::new();
    let mut source_overrides: FxHashMap<String, Cow<'a, str>> = FxHashMap::default();
    let mut severities = FxHashMap::default();
    let mut directives = FxHashMap::default();
    for file in files {
        let virtual_path = file.virtual_path.to_string_lossy().into_owned();
        source_overrides.insert(virtual_path.clone(), Cow::Borrowed(file.projected_source));
        let (rules, file_severities) = resolved_protocol_rules(engine, file.authored_path)?;
        if !rules.is_empty() || engine.type_check_enabled() {
            let signature = serde_json::to_string(&rules)
                .map_err(|error| TsgolintError::UngroupableRules { detail: error.to_string() })?;
            groups
                .entry(signature)
                .or_insert_with(|| ProtocolConfigGroup {
                    rules: rules.clone(),
                    file_paths: Vec::new(),
                })
                .file_paths
                .push(virtual_path);
        }
        severities.insert(file.virtual_path.to_path_buf(), file_severities);
        if let Some(disable_directives) = file.disable_directives {
            directives.insert(file.virtual_path.to_path_buf(), disable_directives);
        }
    }
    if !groups.is_empty() {
        let projected = files
            .iter()
            .map(|file| ProjectedFile {
                authored: file.authored_path,
                virtual_path: file.virtual_path,
            })
            .collect::<Vec<_>>();
        for (config, source) in tsconfig_overrides(&engine.cwd, engine.tsconfig(), &projected)? {
            source_overrides.insert(config, Cow::Owned(source));
        }
    }
    Ok(PreparedTypeBatch {
        payload: ProtocolPayload {
            version: 2,
            configs: groups.into_values().collect(),
            source_overrides,
            report_syntactic: engine.type_check_enabled(),
            report_semantic: engine.type_check_enabled(),
        },
        severities,
        directives,
    })
}

fn resolved_protocol_rules(
    engine: &LintEngine,
    authored_path: &Path,
) -> Result<(Vec<ProtocolRule>, FxHashMap<&'static str, AllowWarnDeny>), TsgolintError> {
    let resolved = engine.config_store.resolve(authored_path);
    let mut rules = Vec::new();
    let mut severities = FxHashMap::default();
    for (rule, severity) in resolved.rules.iter() {
        if !severity.is_warn_deny() || !rule.is_tsgolint_rule() {
            continue;
        }
        let options = match rule.to_configuration() {
            Some(Ok(options)) => Some(options),
            Some(Err(error)) => {
                return Err(TsgolintError::UnserializableRule {
                    rule: rule.name(),
                    detail: error.to_string(),
                });
            }
            None => None,
        };
        rules.push(ProtocolRule { name: rule.name(), options });
        severities.insert(rule.name(), *severity);
    }
    rules.sort_by(|left, right| {
        left.name.cmp(right.name).then_with(|| {
            serde_json::to_string(&left.options)
                .unwrap_or_default()
                .cmp(&serde_json::to_string(&right.options).unwrap_or_default())
        })
    });
    Ok((rules, severities))
}

pub(super) fn protocol_diagnostic(
    message: ProtocolDiagnostic,
    severities: &FxHashMap<PathBuf, FxHashMap<&'static str, AllowWarnDeny>>,
    directives: &FxHashMap<PathBuf, &DisableDirectives>,
) -> Option<TypeBatchDiagnostic> {
    let virtual_path = message.file_path.map(PathBuf::from);
    if message.kind == 0 {
        let rule = message.rule?;
        let severity = virtual_path
            .as_ref()
            .and_then(|path| severities.get(path))
            .and_then(|rules| rules.get(rule.as_str()))?;
        if let (Some(path), Some(range)) = (virtual_path.as_ref(), message.range.as_ref())
            && directives.get(path).is_some_and(|directives| {
                directives.contains(&rule, Span::new(range.pos, range.end))
            })
        {
            return None;
        }
        let mut labels = message
            .labeled_ranges
            .into_iter()
            .map(|label| EngineSpan {
                offset: label.range.pos,
                length: label.range.end.saturating_sub(label.range.pos),
                message: Some(label.label),
            })
            .collect::<Vec<_>>();
        if labels.is_empty() {
            if let Some(range) = message.range {
                labels.push(EngineSpan {
                    offset: range.pos,
                    length: range.end.saturating_sub(range.pos),
                    message: None,
                });
            }
        } else if let Some(range) = message.range
            && range.end > range.pos
        {
            labels.push(EngineSpan {
                offset: range.pos,
                length: range.end - range.pos,
                message: None,
            });
        }
        let mut fixes = message
            .fixes
            .into_iter()
            .map(|fix| EngineFix {
                offset: fix.range.pos,
                length: fix.range.end.saturating_sub(fix.range.pos),
                replacement: fix.text,
                safe: true,
            })
            .collect::<Vec<_>>();
        fixes.extend(message.suggestions.into_iter().flat_map(|suggestion| suggestion.fixes).map(
            |fix| EngineFix {
                offset: fix.range.pos,
                length: fix.range.end.saturating_sub(fix.range.pos),
                replacement: fix.text,
                safe: false,
            },
        ));
        Some(TypeBatchDiagnostic {
            virtual_path,
            diagnostic: EngineDiagnostic {
                rule: Some(rule.clone()),
                plugin: Some("typescript".to_string()),
                code: format!("typescript({rule})"),
                severity: if *severity == AllowWarnDeny::Deny {
                    "error".to_string()
                } else {
                    "warning".to_string()
                },
                message: message.message.description,
                labels,
                fixes,
            },
        })
    } else {
        let labels = message.range.map_or_else(Vec::new, |range| {
            vec![EngineSpan {
                offset: range.pos,
                length: range.end.saturating_sub(range.pos),
                message: None,
            }]
        });
        Some(TypeBatchDiagnostic {
            virtual_path,
            diagnostic: EngineDiagnostic {
                rule: None,
                plugin: Some("typescript".to_string()),
                code: format!("typescript({})", message.message.id),
                severity: "error".to_string(),
                message: message.message.description,
                labels,
                fixes: Vec::new(),
            },
        })
    }
}

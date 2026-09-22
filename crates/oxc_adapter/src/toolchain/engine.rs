//! Compiling one Oxlint configuration into an engine that a whole native lint batch reuses.

use std::path::{Path, PathBuf};
use std::time::Instant;

use oxc_linter::{
    ConfigBuilderError, ConfigStore, ConfigStoreBuilder, ExternalPluginStore, FixKind,
    LintFilter as OxcLintFilter, LintIgnoreMatcher, LintOptions, Linter, Oxlintrc,
};
use rustc_hash::FxHashMap;

use super::config::{
    ConfigError, config_builder_error, load_oxlintrc, reject_unavailable_lint_capabilities,
};
use super::timings::elapsed_ns;
use super::{RuleFilter, RuleSeverity};

#[derive(Debug)]
pub struct LintEngineOptions<'a> {
    pub cwd: &'a Path,
    pub config_path: Option<&'a Path>,
    /// Directory against which a materialized configuration's relative paths are resolved.
    ///
    /// The thin Vite+ host uses this when the JSON payload lives in a disposable directory but
    /// was authored in the consumer project. Ordinary JSON/JSONC loading leaves it unset.
    pub config_base: Option<&'a Path>,
    pub filters: &'a [RuleFilter],
    pub collect_fixes: bool,
}

/// One compiled Oxlint configuration reused across a native lint batch.
pub struct LintEngine {
    pub(super) linter: Linter,
    pub(super) config_store: ConfigStore,
    ignore_matcher: LintIgnoreMatcher,
    config_path: Option<PathBuf>,
    config_load_ns: u64,
    number_of_rules: usize,
    /// Configured rules the pinned OXC crates do not know, left out rather than refused.
    skipped_rules: Vec<String>,
    pub(super) collect_fixes: bool,
    deny_warnings: bool,
    max_warnings: Option<usize>,
    pub(super) cwd: PathBuf,
    type_mode: TypeMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TypeMode {
    Disabled,
    Aware,
    Check,
}

impl LintEngine {
    /// Discover and compile one JSON/JSONC Oxlint configuration.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] for invalid, conflicting, JavaScript/TypeScript, external-plugin,
    /// or type-aware configuration before any source file is parsed or changed.
    pub fn new(options: &LintEngineOptions<'_>) -> Result<Self, ConfigError> {
        Self::new_with_capabilities(options, false, false)
    }

    /// Compile the same configuration with the explicit TypeScript-Go opt-in.
    ///
    /// # Errors
    ///
    /// Returns the same configuration errors as [`Self::new`]. Executable discovery happens only
    /// when a type-aware source is linted.
    pub fn new_type_aware(
        options: &LintEngineOptions<'_>,
        type_check: bool,
    ) -> Result<Self, ConfigError> {
        Self::new_with_capabilities(options, true, type_check)
    }

    /// Compile one in-memory JSON Oxlint configuration without touching the
    /// filesystem. The WebAssembly playground uses this: browser WASI
    /// instances have no writable filesystem to stage a config file in.
    ///
    /// # Errors
    ///
    /// Returns the same configuration errors as [`Self::new`].
    pub fn new_from_config_source(
        cwd: &Path,
        config_source: Option<&str>,
        filters: &[RuleFilter],
        collect_fixes: bool,
    ) -> Result<Self, ConfigError> {
        let started = Instant::now();
        let config = match config_source {
            Some(source) => Oxlintrc::from_string(source).map_err(ConfigError::oxlintrc)?,
            None => Oxlintrc::default(),
        };
        let options =
            LintEngineOptions { cwd, config_path: None, config_base: None, filters, collect_fixes };
        Self::build(config, None, &options, false, false, started)
    }

    fn new_with_capabilities(
        options: &LintEngineOptions<'_>,
        type_aware: bool,
        requested_type_check: bool,
    ) -> Result<Self, ConfigError> {
        let started = Instant::now();
        let (config, config_path) =
            load_oxlintrc(options.cwd, options.config_path, options.config_base)?;
        Self::build(config, config_path, options, type_aware, requested_type_check, started)
    }

    fn build(
        config: Oxlintrc,
        config_path: Option<PathBuf>,
        options: &LintEngineOptions<'_>,
        type_aware: bool,
        requested_type_check: bool,
        started: Instant,
    ) -> Result<Self, ConfigError> {
        reject_unavailable_lint_capabilities(&config, type_aware)?;
        let type_check = requested_type_check || config.options.type_check == Some(true);

        let base_root = config.dir().unwrap_or(options.cwd).to_path_buf();
        let ignore_patterns = config.ignore_patterns.clone();
        let mut external_plugin_store = ExternalPluginStore::new(false);
        let filters = options
            .filters
            .iter()
            .map(|filter| {
                OxcLintFilter::new(
                    match filter.severity {
                        RuleSeverity::Allow => oxc_linter::AllowWarnDeny::Allow,
                        RuleSeverity::Warn => oxc_linter::AllowWarnDeny::Warn,
                        RuleSeverity::Deny => oxc_linter::AllowWarnDeny::Deny,
                    },
                    filter.name.clone(),
                )
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ConfigError::Filter { detail: error.to_string() })?;
        let (config, skipped_rules) = without_unknown_rules(config)?;
        let built = ConfigStoreBuilder::from_oxlintrc(
            false,
            config,
            None,
            &mut external_plugin_store,
            None,
        )
        .map_err(config_builder_error)?
        .with_filters(filters.iter())
        .build(&mut external_plugin_store)
        .map_err(config_builder_error)?;
        let config_store = ConfigStore::new(built, FxHashMap::default(), external_plugin_store);
        let number_of_rules = config_store.number_of_rules(type_aware).unwrap_or(0);
        let deny_warnings = config_store.deny_warnings();
        let max_warnings = config_store.max_warnings();
        let lint_options = LintOptions {
            fix: if options.collect_fixes { FixKind::SafeFix } else { FixKind::None },
            ..LintOptions::default()
        };
        let linter = Linter::new(lint_options, config_store.clone(), None);
        Ok(Self {
            linter,
            config_store,
            ignore_matcher: LintIgnoreMatcher::new(&ignore_patterns, &base_root, Vec::new()),
            config_path,
            config_load_ns: elapsed_ns(started),
            number_of_rules,
            skipped_rules,
            collect_fixes: options.collect_fixes,
            deny_warnings,
            max_warnings,
            cwd: options.cwd.to_path_buf(),
            type_mode: if !type_aware {
                TypeMode::Disabled
            } else if type_check {
                TypeMode::Check
            } else {
                TypeMode::Aware
            },
        })
    }

    #[must_use]
    pub fn should_ignore(&self, path: &Path) -> bool {
        let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        self.ignore_matcher.should_ignore(&normalized)
    }

    #[must_use]
    pub fn config_path(&self) -> Option<&Path> {
        self.config_path.as_deref()
    }

    #[must_use]
    pub fn config_load_ns(&self) -> u64 {
        self.config_load_ns
    }

    #[must_use]
    pub fn config_loads(&self) -> u32 {
        u32::from(self.config_path.is_some())
    }

    #[must_use]
    pub fn number_of_rules(&self) -> usize {
        self.number_of_rules
    }

    /// Configured rules this engine left out because the pinned OXC crates do not know them.
    ///
    /// The project's configuration tracks the Oxlint the project installed, which can be newer
    /// than the crates this target is built on (tsrx-org/oxc#105). Refusing the whole run for a
    /// rule that cannot exist here yet would block every `.tsrx` file over a rule that could not
    /// have fired on one; the rule is skipped instead and named here so the caller can say so.
    #[must_use]
    pub fn skipped_rules(&self) -> &[String] {
        &self.skipped_rules
    }

    #[must_use]
    pub fn deny_warnings(&self) -> bool {
        self.deny_warnings
    }

    #[must_use]
    pub fn max_warnings(&self) -> Option<usize> {
        self.max_warnings
    }

    #[must_use]
    pub const fn type_aware_enabled(&self) -> bool {
        !matches!(self.type_mode, TypeMode::Disabled)
    }

    #[must_use]
    pub const fn type_check_enabled(&self) -> bool {
        matches!(self.type_mode, TypeMode::Check)
    }
}

/// Drops the configured rules the pinned crates do not know, and names them.
///
/// `ConfigStoreBuilder` refuses a configuration naming a rule it has never heard of, which is the
/// right answer for Oxlint itself and the wrong one here: this target is built on one pinned OXC
/// revision while the configuration is the project's and follows the Oxlint the project installed.
/// A rule added upstream after the pin is real, and it cannot run on `.tsrx` until the pin moves,
/// but it must not stop every other rule from running. The check is a dry build; a configuration
/// with no unknown rules costs one extra build and nothing else. Base rules surface at
/// `from_oxlintrc` and override rules at `build`, so the probe repeats until the build is clean,
/// each round stripping at least one rule.
fn without_unknown_rules(mut config: Oxlintrc) -> Result<(Oxlintrc, Vec<String>), ConfigError> {
    let mut skipped = Vec::new();
    loop {
        let mut probe_store = ExternalPluginStore::new(false);
        let probe =
            ConfigStoreBuilder::from_oxlintrc(false, config.clone(), None, &mut probe_store, None)
                .and_then(|builder| builder.build(&mut probe_store));
        let names = match probe {
            Err(ConfigBuilderError::UnknownRules { rules }) => {
                rules.iter().map(|rule| rule.full_name().into_owned()).collect::<Vec<_>>()
            }
            // The builder reports a rule it cannot find as a per-rule configuration error. The
            // error type behind that list is not exported, so it is read through its message;
            // any entry that is not a plain "not found" is a real configuration error, left for
            // the build below to report.
            Err(ConfigBuilderError::RuleConfigurationErrors { errors }) => {
                let mut names = Vec::with_capacity(errors.len());
                for error in &errors {
                    match rule_not_found(&error.to_string()) {
                        Some(name) => names.push(name),
                        None => return Ok((config, skipped)),
                    }
                }
                names
            }
            // Any other outcome is decided by the real build below, with its own error mapping.
            Ok(_) | Err(_) => return Ok((config, skipped)),
        };
        if names.is_empty() || names.iter().any(|name| skipped.contains(name)) {
            return Ok((config, skipped));
        }
        config = strip_rules(config, &names)?;
        skipped.extend(names);
    }
}

/// `OxlintRules` exposes no way to remove an entry, but the configuration round-trips through
/// its own JSON form, which keys every rule by the same full name the error reports.
fn strip_rules(config: Oxlintrc, names: &[String]) -> Result<Oxlintrc, ConfigError> {
    let mut value = serde_json::to_value(&config)
        .map_err(|error| ConfigError::Invalid { detail: error.to_string() })?;
    let strip = |rules: &mut serde_json::Value| {
        if let serde_json::Value::Object(map) = rules {
            for name in names {
                map.remove(name.as_str());
                // An `eslint` rule serializes under its bare name.
                if let Some(bare) = name.strip_prefix("eslint/") {
                    map.remove(bare);
                }
            }
        }
    };
    if let Some(rules) = value.get_mut("rules") {
        strip(rules);
    }
    if let Some(serde_json::Value::Array(overrides)) = value.get_mut("overrides") {
        for entry in overrides {
            if let Some(rules) = entry.get_mut("rules") {
                strip(rules);
            }
        }
    }
    let mut stripped: Oxlintrc = serde_json::from_value(value)
        .map_err(|error| ConfigError::Invalid { detail: error.to_string() })?;
    stripped.path = config.path;
    Ok(stripped)
}

/// The `plugin/rule` name a "not found" configuration error is about, if that is what it is.
fn rule_not_found(message: &str) -> Option<String> {
    let rest = message.strip_prefix("Rule '")?;
    let (rule, rest) = rest.split_once("' not found in plugin '")?;
    let plugin = rest.strip_suffix('\'')?;
    if rule.is_empty() || plugin.is_empty() || rule.contains('\'') || plugin.contains('\'') {
        return None;
    }
    Some(format!("{plugin}/{rule}"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::LintEngine;

    #[test]
    fn rules_the_pinned_crates_do_not_know_are_skipped_and_named() {
        let config = r#"{
            "plugins": ["react"],
            "rules": { "react/rule-from-the-future": "off", "no-debugger": "error" },
            "overrides": [{ "files": ["*.ts"], "rules": { "react/another-future-rule": "warn" } }]
        }"#;
        let engine = LintEngine::new_from_config_source(Path::new("."), Some(config), &[], false)
            .expect("a configuration with unknown rules still builds");
        assert_eq!(
            engine.skipped_rules(),
            ["react/rule-from-the-future", "react/another-future-rule"]
        );
        assert!(engine.number_of_rules() > 0);

        let known = LintEngine::new_from_config_source(
            Path::new("."),
            Some(r#"{ "rules": { "no-debugger": "error" } }"#),
            &[],
            false,
        )
        .expect("a known configuration builds");
        assert!(known.skipped_rules().is_empty());
    }
}

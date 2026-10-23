//! Compiling one Oxlint configuration into an engine that a whole native lint batch reuses.

use std::path::{Path, PathBuf};
use std::time::Instant;

use oxc_linter::{
    ConfigStore, ConfigStoreBuilder, ExternalPluginStore, FixKind, LintFilter as OxcLintFilter,
    LintIgnoreMatcher, LintOptions, Linter, Oxlintrc,
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
    pub(super) collect_fixes: bool,
    deny_warnings: bool,
    max_warnings: Option<usize>,
    pub(super) cwd: PathBuf,
    type_mode: TypeMode,
    tsconfig: Option<PathBuf>,
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
            tsconfig: None,
        })
    }

    /// Name the tsconfig whose project every type-aware `.tsrx` projection joins, as `--tsconfig`
    /// does. Without one, each projection joins the project that owns its authored file.
    #[must_use]
    pub fn with_tsconfig(mut self, tsconfig: Option<PathBuf>) -> Self {
        self.tsconfig = tsconfig;
        self
    }

    #[must_use]
    pub fn tsconfig(&self) -> Option<&Path> {
        self.tsconfig.as_deref()
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

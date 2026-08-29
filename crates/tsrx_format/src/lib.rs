//! Native TSRX formatting orchestration over canonical Oxfmt.

mod error;

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use oxc_adapter::{
    DynamicTagContract, FormatOptions as EngineFormatOptions, FormatRequest, SourceKind,
};
use serde::Deserialize;
use serde_json::Value;
use tsrx_syntax::{lift_formatted, project_for_format, scan_for_parser};

pub use error::{ConfigScope, FormatError, GlobField};
pub use oxc_adapter::OXC_REVISION;

/// Deliberate embedded-CSS boundary for this release.
///
/// `<style>` payloads never leave the current process and stay byte-exact until canonical OXC
/// CSS can share the pinned allocator graph without a downstream Cargo patch.
pub const EMBEDDED_CSS_MODE: &str = "KEEP_RAW";
pub const EMBEDDED_CSS_PARSE_COUNT: u32 = 0;
pub const EMBEDDED_CSS_FORMAT_NS: u64 = 0;
pub const EMBEDDED_CSS_USES_SUBPROCESS: bool = false;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatMode {
    Direct,
    Projected,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FormatTimings {
    pub scan_ns: u64,
    pub projection_ns: u64,
    pub parse_ns: u64,
    pub format_ns: u64,
    /// Canonical embedded-language formatting time; zero while raw CSS is preserved verbatim.
    pub embedded_format_ns: u64,
    pub lift_ns: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FormatMetadata {
    pub native: bool,
    pub engine: &'static str,
    pub oxc_revision: &'static str,
    pub mode: FormatMode,
    pub parse_count: u32,
    /// Zero while style payloads use the checked raw-preservation path.
    pub embedded_parse_count: u32,
    pub is_tsrx: bool,
    pub projection_bytes: usize,
    pub marker_count: usize,
    pub style_count: usize,
    pub timings: FormatTimings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatOutput {
    pub code: String,
    pub changed: bool,
    pub metadata: FormatMetadata,
}

/// One discovered/compiled Oxfmt-compatible JSON configuration reused across a batch or editor.
pub struct FormatSession {
    cwd: PathBuf,
    config_root: PathBuf,
    config_path: Option<PathBuf>,
    config_load_ns: u64,
    base: FileFormatOptions,
    overrides: Vec<FormatOverride>,
    ignore: Option<Gitignore>,
}

#[derive(Debug, Clone, Default)]
struct FileFormatOptions {
    engine: EngineFormatOptions,
    insert_final_newline: Option<bool>,
}

struct FormatOverride {
    files: GlobSet,
    exclude_files: GlobSet,
    options: FileFormatOptions,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawOxfmtrc {
    #[serde(flatten)]
    options: RawFormatOptions,
    overrides: Vec<RawFormatOverride>,
    ignore_patterns: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawFormatOverride {
    files: Vec<String>,
    exclude_files: Vec<String>,
    options: RawFormatOptions,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawFormatOptions {
    #[serde(rename = "$schema")]
    schema: Option<Value>,
    use_tabs: Option<bool>,
    tab_width: Option<u8>,
    end_of_line: Option<String>,
    print_width: Option<u16>,
    single_quote: Option<bool>,
    jsx_single_quote: Option<bool>,
    quote_props: Option<String>,
    trailing_comma: Option<String>,
    semi: Option<bool>,
    arrow_parens: Option<String>,
    bracket_spacing: Option<bool>,
    bracket_same_line: Option<bool>,
    object_wrap: Option<String>,
    single_attribute_per_line: Option<bool>,
    embedded_language_formatting: Option<String>,
    html_whitespace_sensitivity: Option<String>,
    insert_final_newline: Option<bool>,
    /// Oxfmt's `true | false | object` import-sorting option, kept as JSON until the adapter
    /// parses it into its own revision-independent shape. Canonical Oxfmt still accepts the
    /// original `experimentalSortImports` spelling, so this reads both.
    #[serde(alias = "experimentalSortImports")]
    sort_imports: Option<Value>,
    sort_tailwindcss: Option<Value>,
    /// Oxfmt's `true | false | object` doc-comment option, kept as JSON until the adapter parses
    /// it into its own revision-independent shape.
    jsdoc: Option<Value>,
    experimental_operator_position: Option<Value>,
    experimental_ternaries: Option<Value>,
    prose_wrap: Option<Value>,
    sort_package_json: Option<Value>,
    svelte: Option<Value>,
    vue_indent_script_and_style: Option<Value>,
    #[serde(flatten)]
    unknown: BTreeMap<String, Value>,
}

impl FormatSession {
    /// Discover or explicitly load one JSON/JSONC Oxfmt configuration.
    ///
    /// # Errors
    ///
    /// Returns an error for conflicts, invalid config, JS/TS config modules, unsupported
    /// TSRX-affecting options, or malformed glob/ignore patterns.
    pub fn new(cwd: &Path, explicit_config: Option<&Path>) -> Result<Self, FormatError> {
        Self::new_with_config_base(cwd, explicit_config, None)
    }

    /// Load a materialized config while resolving relative paths from its authored directory.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid base or any invalid/unsupported formatter configuration.
    pub fn new_with_config_base(
        cwd: &Path,
        explicit_config: Option<&Path>,
        config_base: Option<&Path>,
    ) -> Result<Self, FormatError> {
        let started = Instant::now();
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        if config_base.is_some() && explicit_config.is_none() {
            return Err(FormatError::BaseWithoutMaterializedConfig);
        }
        reject_editorconfig(&cwd, explicit_config)?;
        let config_path = resolve_oxfmt_config(&cwd, explicit_config)?;
        let (base, overrides, ignore_patterns, config_root) = if let Some(path) = &config_path {
            let raw = read_oxfmt_config(path)?;
            let base = raw.options.resolve(ConfigScope::Root)?;
            let overrides = raw
                .overrides
                .into_iter()
                .enumerate()
                .map(|(index, raw)| FormatOverride::new(raw, index))
                .collect::<Result<Vec<_>, _>>()?;
            let root = if let Some(config_base) = config_base {
                resolve_existing_config_base(&cwd, config_base)?
            } else {
                path.parent().unwrap_or(&cwd).to_path_buf()
            };
            (base, overrides, raw.ignore_patterns, root)
        } else {
            (FileFormatOptions::default(), Vec::new(), Vec::new(), cwd.clone())
        };
        let ignore = build_ignore(&config_root, &ignore_patterns)?;
        Ok(Self {
            cwd,
            config_root,
            config_path,
            config_load_ns: elapsed_ns(started),
            base,
            overrides,
            ignore,
        })
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
    pub fn should_ignore(&self, path: &Path) -> bool {
        let path = self.absolute_path(path);
        let path = path.canonicalize().unwrap_or(path);
        if !path.starts_with(&self.config_root) {
            return false;
        }
        self.ignore
            .as_ref()
            .is_some_and(|ignore| ignore.matched_path_or_any_parents(path, false).is_ignore())
    }

    /// Format one loaded source with the options resolved for its authored path.
    ///
    /// # Errors
    ///
    /// Returns no partial output for configuration, projection, parser, formatter, or lift errors.
    pub fn format_text(&self, path: &Path, source: &str) -> Result<FormatOutput, FormatError> {
        let options = self.options_for(path);
        format_text_with_options(path, source, Some(&options))
    }

    fn absolute_path(&self, path: &Path) -> PathBuf {
        if path.is_absolute() { path.to_path_buf() } else { self.cwd.join(path) }
    }

    fn options_for(&self, path: &Path) -> FileFormatOptions {
        let absolute = self.absolute_path(path);
        let relative = absolute.strip_prefix(&self.config_root).unwrap_or(&absolute);
        let candidate = relative.to_string_lossy();
        let mut options = self.base.clone();
        for r#override in &self.overrides {
            if r#override.files.is_match(candidate.as_ref())
                && !r#override.exclude_files.is_match(candidate.as_ref())
            {
                options.merge(&r#override.options);
            }
        }
        options
    }
}

fn resolve_existing_config_base(cwd: &Path, base: &Path) -> Result<PathBuf, FormatError> {
    let base = if base.is_absolute() { base.to_path_buf() } else { cwd.join(base) };
    let base = base
        .canonicalize()
        .map_err(|error| FormatError::UnresolvableBase { path: base.clone(), error })?;
    if !base.is_dir() {
        return Err(FormatError::BaseNotDirectory { path: base });
    }
    Ok(base)
}

impl FileFormatOptions {
    fn merge(&mut self, other: &Self) {
        macro_rules! merge {
            ($($field:ident),+ $(,)?) => {
                $(if other.engine.$field.is_some() {
                    self.engine.$field.clone_from(&other.engine.$field);
                })+
            };
        }
        merge!(
            use_tabs,
            tab_width,
            end_of_line,
            print_width,
            single_quote,
            jsx_single_quote,
            quote_props,
            trailing_comma,
            semi,
            arrow_parens,
            bracket_spacing,
            bracket_same_line,
            object_wrap,
            single_attribute_per_line,
            embedded_language_formatting,
            html_whitespace_sensitivity,
            jsdoc,
            sort_imports,
        );
        if other.insert_final_newline.is_some() {
            self.insert_final_newline = other.insert_final_newline;
        }
    }
}

impl FormatOverride {
    fn new(raw: RawFormatOverride, index: usize) -> Result<Self, FormatError> {
        if raw.files.is_empty() {
            return Err(FormatError::OverrideWithoutFiles { index });
        }
        let scope = ConfigScope::Override { index };
        Ok(Self {
            files: build_globs(&raw.files, scope, GlobField::Files)?,
            exclude_files: build_globs(&raw.exclude_files, scope, GlobField::ExcludeFiles)?,
            options: raw.options.resolve(scope)?,
        })
    }
}

impl RawFormatOptions {
    fn resolve(self, scope: ConfigScope) -> Result<FileFormatOptions, FormatError> {
        let Self {
            schema,
            use_tabs,
            tab_width,
            end_of_line,
            print_width,
            single_quote,
            jsx_single_quote,
            quote_props,
            trailing_comma,
            semi,
            arrow_parens,
            bracket_spacing,
            bracket_same_line,
            object_wrap,
            single_attribute_per_line,
            embedded_language_formatting,
            html_whitespace_sensitivity,
            insert_final_newline,
            sort_imports,
            sort_tailwindcss,
            jsdoc,
            experimental_operator_position,
            experimental_ternaries,
            prose_wrap,
            sort_package_json,
            svelte,
            vue_indent_script_and_style,
            unknown,
        } = self;
        let _language_irrelevant =
            (schema, prose_wrap, sort_package_json, svelte, vue_indent_script_and_style);
        if let Some((option, _)) = unknown.into_iter().next() {
            return Err(FormatError::UnknownOption { option, scope });
        }
        reject_enabled_value(scope, "sortTailwindcss", sort_tailwindcss)?;
        if embedded_language_formatting.is_some() {
            return Err(FormatError::EmbeddedLanguageFormattingUnavailable { scope });
        }
        if experimental_operator_position.is_some() || experimental_ternaries.is_some() {
            return Err(FormatError::ExperimentalOptions { scope });
        }
        let mut engine = EngineFormatOptions {
            use_tabs,
            tab_width,
            end_of_line,
            print_width,
            single_quote,
            jsx_single_quote,
            quote_props,
            trailing_comma,
            semi,
            arrow_parens,
            bracket_spacing,
            bracket_same_line,
            object_wrap,
            single_attribute_per_line,
            embedded_language_formatting: None,
            html_whitespace_sensitivity,
            jsdoc: None,
            sort_imports: None,
        };
        // The adapter owns both of these options' shapes, so an unusable value is reported in the
        // same wording a bad value for any other Oxfmt option gets, and named with the block it
        // was authored in the way every other refusal here is.
        if let Some(jsdoc) = jsdoc {
            engine
                .set_jsdoc(&jsdoc)
                .map_err(|error| FormatError::invalid_option_value(scope, error))?;
        }
        if let Some(sort_imports) = sort_imports {
            engine
                .set_sort_imports(&sort_imports)
                .map_err(|error| FormatError::invalid_option_value(scope, error))?;
        }
        Ok(FileFormatOptions { engine, insert_final_newline })
    }
}

fn reject_enabled_value(
    scope: ConfigScope,
    option: &'static str,
    value: Option<Value>,
) -> Result<(), FormatError> {
    if value.is_some_and(|value| !value.is_null() && value != Value::Bool(false)) {
        return Err(FormatError::UnavailableOption { option, scope });
    }
    Ok(())
}

fn build_globs(
    patterns: &[String],
    scope: ConfigScope,
    field: GlobField,
) -> Result<GlobSet, FormatError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern).map_err(|error| FormatError::InvalidGlob {
            scope,
            field,
            pattern: pattern.clone(),
            detail: error.to_string(),
        })?);
    }
    builder.build().map_err(|error| FormatError::UnbuildableGlobSet {
        scope,
        field,
        detail: error.to_string(),
    })
}

fn build_ignore(root: &Path, patterns: &[String]) -> Result<Option<Gitignore>, FormatError> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut builder = GitignoreBuilder::new(root);
    for pattern in patterns {
        builder.add_line(None, pattern).map_err(|error| FormatError::InvalidIgnorePattern {
            pattern: pattern.clone(),
            detail: error.to_string(),
        })?;
    }
    builder
        .build()
        .map(Some)
        .map_err(|error| FormatError::UnbuildableIgnore { detail: error.to_string() })
}

fn resolve_oxfmt_config(
    cwd: &Path,
    explicit: Option<&Path>,
) -> Result<Option<PathBuf>, FormatError> {
    if let Some(path) = explicit {
        let path = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
        if is_js_config(&path) {
            return Err(FormatError::ExplicitJsConfigModule);
        }
        return Ok(Some(path.canonicalize().unwrap_or(path)));
    }

    let mut directory = cwd.to_path_buf();
    loop {
        let entries = fs::read_dir(&directory)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let name = path.file_name()?.to_str()?;
                matches!(
                    name,
                    ".oxfmtrc.json"
                        | ".oxfmtrc.jsonc"
                        | "oxfmt.config.js"
                        | "oxfmt.config.mjs"
                        | "oxfmt.config.cjs"
                        | "oxfmt.config.ts"
                        | "oxfmt.config.mts"
                        | "oxfmt.config.cts"
                )
                .then_some(path)
            })
            .collect::<Vec<_>>();
        match entries.as_slice() {
            [] => {}
            [path] if is_js_config(path) => {
                return Err(FormatError::DiscoveredJsConfigModule);
            }
            [path] => return Ok(Some(path.canonicalize().unwrap_or_else(|_| path.clone()))),
            _ => {
                let names = entries
                    .iter()
                    .filter_map(|path| path.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .collect();
                return Err(FormatError::ConflictingConfigFiles { directory, names });
            }
        }
        if !directory.pop() {
            return Ok(None);
        }
    }
}

fn reject_editorconfig(cwd: &Path, explicit: Option<&Path>) -> Result<(), FormatError> {
    if explicit.is_some_and(|path| path.file_name().is_some_and(|name| name == ".editorconfig")) {
        return Err(FormatError::EditorConfigRejected);
    }
    let mut directory = cwd.to_path_buf();
    loop {
        let path = directory.join(".editorconfig");
        if path.is_file() {
            return Err(FormatError::EditorConfigDiscovered { path });
        }
        if !directory.pop() {
            return Ok(());
        }
    }
}

fn is_js_config(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("js" | "mjs" | "cjs" | "ts" | "mts" | "cts")
    )
}

fn read_oxfmt_config(path: &Path) -> Result<RawOxfmtrc, FormatError> {
    let mut source =
        fs::read_to_string(path).map_err(|error| FormatError::unreadable_config(path, error))?;
    json_strip_comments::strip(&mut source).map_err(|error| FormatError::InvalidJsonc {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    serde_json::from_str(&source).map_err(|error| FormatError::InvalidConfig {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })
}

/// Formats source already owned by a caller without filesystem I/O.
///
/// Ordinary JavaScript/TypeScript source goes directly to canonical Oxfmt. `.tsrx` source is
/// scanned once, projected once with checked structural markers, parsed/formatted once by Oxfmt,
/// and lifted once. Style payloads stay byte-identical behind checked opaque markers until OXC's
/// CSS formatter is consumable without a downstream Cargo patch. A failure returns no partial
/// output and cannot mutate the caller's source.
///
/// # Errors
///
/// Returns an error for unsupported extensions, unsupported TSRX grammar, invalid projected TSX,
/// canonical Oxfmt failures, or any marker/source-fidelity violation.
pub fn format_text(path: &Path, source: &str) -> Result<FormatOutput, FormatError> {
    format_text_with_options(path, source, None)
}

fn format_text_with_options(
    path: &Path,
    source: &str,
    options: Option<&FileFormatOptions>,
) -> Result<FormatOutput, FormatError> {
    let is_tsrx = path.extension().is_some_and(|extension| extension == "tsrx");
    if !is_tsrx {
        return format_direct(path, source, options);
    }

    let mut timings = FormatTimings::default();
    let started = Instant::now();
    let overlay = scan_for_parser(source)?;
    timings.scan_ns = elapsed_ns(started);

    let started = Instant::now();
    let projection = project_for_format(source, &overlay)?;
    timings.projection_ns = elapsed_ns(started);

    let engine = oxc_adapter::format(&FormatRequest {
        parse_source: projection.source(),
        source_kind: SourceKind::TypeScriptReact,
        dynamic_tags: projection.dynamic_contract().map(|(prefix, count, original_offsets)| {
            DynamicTagContract { prefix, count, original_offsets }
        }),
        options: options.map(|options| &options.engine),
    })?;
    timings.parse_ns = engine.timings.parse_ns;
    timings.format_ns = engine.timings.format_ns;

    let style_count = projection.style_count();

    let started = Instant::now();
    let code = lift_formatted(&engine.code, source, &projection)?;
    let code = apply_final_newline(code, options);
    timings.lift_ns = elapsed_ns(started);

    Ok(FormatOutput {
        changed: code != source,
        code,
        metadata: FormatMetadata {
            native: true,
            engine: "oxc_formatter",
            oxc_revision: OXC_REVISION,
            mode: FormatMode::Projected,
            parse_count: engine.parse_count,
            embedded_parse_count: EMBEDDED_CSS_PARSE_COUNT,
            is_tsrx: true,
            projection_bytes: projection.source().len(),
            marker_count: projection.marker_count(),
            style_count,
            timings,
        },
    })
}

fn format_direct(
    path: &Path,
    source: &str,
    options: Option<&FileFormatOptions>,
) -> Result<FormatOutput, FormatError> {
    let engine = oxc_adapter::format(&FormatRequest {
        parse_source: source,
        source_kind: SourceKind::from_path(path)?,
        dynamic_tags: None,
        options: options.map(|options| &options.engine),
    })?;
    let code = apply_final_newline(engine.code, options);
    Ok(FormatOutput {
        changed: code != source,
        code,
        metadata: FormatMetadata {
            native: true,
            engine: "oxc_formatter",
            oxc_revision: OXC_REVISION,
            mode: FormatMode::Direct,
            parse_count: engine.parse_count,
            embedded_parse_count: EMBEDDED_CSS_PARSE_COUNT,
            is_tsrx: false,
            projection_bytes: 0,
            marker_count: 0,
            style_count: 0,
            timings: FormatTimings {
                parse_ns: engine.timings.parse_ns,
                format_ns: engine.timings.format_ns,
                ..FormatTimings::default()
            },
        },
    })
}

fn apply_final_newline(mut code: String, options: Option<&FileFormatOptions>) -> String {
    if options.and_then(|options| options.insert_final_newline) == Some(false) {
        while code.ends_with('\n') || code.ends_with('\r') {
            code.pop();
        }
    }
    code
}

fn elapsed_ns(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value, json};

    use super::{
        ConfigScope, EMBEDDED_CSS_FORMAT_NS, EMBEDDED_CSS_MODE, EMBEDDED_CSS_PARSE_COUNT,
        EMBEDDED_CSS_USES_SUBPROCESS, EngineFormatOptions, FileFormatOptions, FormatMode,
        RawFormatOptions, format_text, format_text_with_options,
    };

    /// The options one `.oxfmtrc.json` carrying only a `jsdoc` value resolves to.
    fn jsdoc_options(value: &Value) -> FileFormatOptions {
        let mut engine = EngineFormatOptions::default();
        engine.set_jsdoc(value).expect("a usable jsdoc option");
        FileFormatOptions { engine, insert_final_newline: None }
    }

    /// The options one `.oxfmtrc.json` carrying only a `sortImports` value resolves to.
    fn sort_imports_options(value: &Value) -> FileFormatOptions {
        let mut engine = EngineFormatOptions::default();
        engine.set_sort_imports(value).expect("a usable sortImports option");
        FileFormatOptions { engine, insert_final_newline: None }
    }

    /// The options one whole authored root configuration resolves to.
    ///
    /// This goes through the same deserialize-then-resolve path a discovered `.oxfmtrc.json`
    /// takes, so a test can pin how several options compose rather than how one behaves alone.
    fn root_options(config: &Value) -> FileFormatOptions {
        serde_json::from_value::<RawFormatOptions>(config.clone())
            .expect("a readable Oxfmt configuration")
            .resolve(ConfigScope::Root)
            .expect("a usable Oxfmt configuration")
    }

    /// The error one authored options block is refused with, in the scope it was authored in.
    fn scoped_error(config: &Value, scope: ConfigScope) -> String {
        serde_json::from_value::<RawFormatOptions>(config.clone())
            .expect("a readable Oxfmt configuration")
            .resolve(scope)
            .expect_err("an unusable Oxfmt configuration")
            .to_string()
    }

    /// The error one authored root configuration is refused with.
    fn root_error(config: &Value) -> String {
        scoped_error(config, ConfigScope::Root)
    }

    #[test]
    fn sort_imports_orders_a_tsrx_import_chunk_and_converges() {
        let source = concat!(
            "import { z } from \"zebra\";\n",
            "// this note belongs to apple\n",
            "import { a } from \"apple\";\n",
            "export function Card() @{<p>{a}{z}</p>}\n",
        );
        let options = sort_imports_options(&json!(true));
        let first =
            format_text_with_options(Path::new("Card.tsrx"), source, Some(&options)).unwrap();
        assert_eq!(first.metadata.mode, FormatMode::Projected);
        assert_eq!(first.metadata.parse_count, 1);
        // The comment is attached to the import it was authored above, so it travels with it.
        assert!(
            first.code.starts_with(concat!(
                "// this note belongs to apple\n",
                "import { a } from \"apple\";\n",
                "import { z } from \"zebra\";\n",
            )),
            "{}",
            first.code
        );
        // The projection markers are gone and the component body survived the reorder.
        assert!(!first.code.contains("_t"), "{}", first.code);
        assert!(first.code.contains("export function Card() @{"), "{}", first.code);

        let second =
            format_text_with_options(Path::new("Card.tsrx"), &first.code, Some(&options)).unwrap();
        assert_eq!(second.code, first.code);
        assert!(!second.changed);

        // Without the option the authored order is left exactly as it was written.
        let untouched = format_text(Path::new("Card.tsrx"), source).unwrap();
        assert!(untouched.code.starts_with("import { z } from \"zebra\";\n"), "{}", untouched.code);
    }

    #[test]
    fn sort_imports_reorders_each_import_chunk_between_components_on_its_own() {
        let source = concat!(
            "import { z } from \"zebra\";\n",
            "import { a } from \"apple\";\n",
            "export function Card() @{<p>{a}{z}</p>}\n",
            "import { m } from \"middle\";\n",
            "import { b } from \"beta\";\n",
            "export function Other() @{<p>{m}{b}</p>}\n",
        );
        let options = sort_imports_options(&json!(true));
        let formatted =
            format_text_with_options(Path::new("Two.tsrx"), source, Some(&options)).unwrap();
        // Each run of consecutive imports sorts within itself; the second run never climbs above
        // the component authored between them.
        assert!(
            formatted.code.starts_with(concat!(
                "import { a } from \"apple\";\n",
                "import { z } from \"zebra\";\n",
                "export function Card() @{\n",
            )),
            "{}",
            formatted.code
        );
        assert!(
            formatted.code.contains(concat!(
                "}\n",
                "import { b } from \"beta\";\n",
                "import { m } from \"middle\";\n",
                "export function Other() @{\n",
            )),
            "{}",
            formatted.code
        );
        assert!(!formatted.code.contains("_t"), "{}", formatted.code);

        let again =
            format_text_with_options(Path::new("Two.tsrx"), &formatted.code, Some(&options))
                .unwrap();
        assert_eq!(again.code, formatted.code);
    }

    #[test]
    fn sort_imports_leaves_side_effect_imports_anchored_and_groups_type_imports() {
        let source = concat!(
            "import \"./reset.css\";\n",
            "import type { Shape } from \"./shape\";\n",
            "import { z } from \"zebra\";\n",
            "import { a } from \"apple\";\n",
            "export function Card() @{<p>{a}{z}</p>}\n",
        );
        let options = sort_imports_options(&json!(true));
        let formatted =
            format_text_with_options(Path::new("Side.tsrx"), source, Some(&options)).unwrap();
        // Side-effect imports are not sorted by default, so the stylesheet keeps its authored
        // position while the value imports sort and the type import lands in its own group.
        assert!(
            formatted.code.starts_with(concat!(
                "import \"./reset.css\";\n",
                "import { a } from \"apple\";\n",
                "import { z } from \"zebra\";\n",
                "\n",
                "import type { Shape } from \"./shape\";\n",
            )),
            "{}",
            formatted.code
        );
        assert!(!formatted.code.contains("_t"), "{}", formatted.code);

        let again =
            format_text_with_options(Path::new("Side.tsrx"), &formatted.code, Some(&options))
                .unwrap();
        assert_eq!(again.code, formatted.code);
    }

    #[test]
    fn the_sort_imports_object_form_selects_sub_options_and_reports_unusable_ones() {
        let source = concat!(
            "import { B } from \"Beta\";\n",
            "import { a } from \"alpha\";\n",
            "export function Card() @{<p>{a}{B}</p>}\n",
        );
        // Case-sensitive descending order with one flat group and no blank line between groups.
        let tuned = format_text_with_options(
            Path::new("Case.tsrx"),
            source,
            Some(&sort_imports_options(&json!({
                "ignoreCase": false,
                "newlinesBetween": false,
                "groups": ["external", "unknown"],
            }))),
        )
        .unwrap();
        assert!(
            tuned.code.starts_with(concat!(
                "import { B } from \"Beta\";\n",
                "import { a } from \"alpha\";\n",
            )),
            "{}",
            tuned.code
        );

        // `false` is a value, not an absent option, so it leaves the authored order alone.
        let disabled = format_text_with_options(
            Path::new("Case.tsrx"),
            source,
            Some(&sort_imports_options(&json!(false))),
        )
        .unwrap();
        assert!(disabled.code.starts_with("import { B } from \"Beta\";\n"), "{}", disabled.code);

        // Every refusal quotes canonical Oxfmt's own sentence for the same configuration.
        let unusable = |value: Value| {
            format_text_with_options(
                Path::new("Case.tsrx"),
                source,
                Some(&sort_imports_options(&value)),
            )
            .unwrap_err()
            .to_string()
        };
        assert!(
            unusable(json!({ "groups": ["nope"] }))
                .contains("unknown group name `nope` in `groups`"),
            "{}",
            unusable(json!({ "groups": ["nope"] }))
        );
        let marker_first = unusable(json!({ "groups": [{ "newlinesBetween": true }, "external"] }));
        assert!(marker_first.contains("cannot appear at the start of `groups`"), "{marker_first}");
        let marker_last = unusable(json!({ "groups": ["external", { "newlinesBetween": true }] }));
        assert!(marker_last.contains("cannot appear at the end of `groups`"), "{marker_last}");
        let incompatible = unusable(json!({ "partitionByNewline": true }));
        assert!(
            incompatible.contains(
                "`partitionByNewline: true` and `newlinesBetween: true` cannot be used together"
            ),
            "{incompatible}"
        );
        let selector = unusable(
            json!({ "customGroups": [{ "groupName": "mine", "elementNamePattern": ["x"], "selector": "nope" }] }),
        );
        assert!(
            selector.contains("unknown selector: `nope` in customGroups: `mine`"),
            "{selector}"
        );

        // A misspelled sub-option and a value of the wrong shape are refused rather than ignored.
        let mut engine = EngineFormatOptions::default();
        let misspelled =
            engine.set_sort_imports(&json!({ "ignorecase": true })).unwrap_err().to_string();
        assert!(misspelled.contains("unknown field `ignorecase`"), "{misspelled}");
        let bad_order = engine.set_sort_imports(&json!({ "order": "up" })).unwrap_err().to_string();
        assert!(bad_order.contains("expected `asc` or `desc`"), "{bad_order}");
        let bad_shape = engine.set_sort_imports(&json!("always")).unwrap_err().to_string();
        assert!(bad_shape.contains("sortImports"), "{bad_shape}");
    }

    #[test]
    fn a_root_config_composes_sort_imports_with_jsdoc_and_semi_and_still_refuses_tailwind() {
        // The configuration the issue reports as failing: three options at once, one of which was
        // refused outright before either of them was implemented.
        let options = root_options(&json!({ "semi": false, "sortImports": true, "jsdoc": true }));
        let source = concat!(
            "import { z } from \"zebra\";\n",
            "import { a } from \"apple\";\n",
            "/**    counts   things   */\n",
            "export function Card({ok}:{ok:boolean}) @{@if(ok){<p>{a}{z}</p>}}\n",
        );
        let first =
            format_text_with_options(Path::new("Card.tsrx"), source, Some(&options)).unwrap();
        assert!(
            first.code.starts_with(concat!(
                "import { a } from \"apple\"\n",
                "import { z } from \"zebra\"\n",
                "/** Counts things */\n",
            )),
            "{}",
            first.code
        );
        assert!(first.code.contains("@if (ok) {"), "{}", first.code);
        assert!(!first.code.contains("_t"), "{}", first.code);
        let second =
            format_text_with_options(Path::new("Card.tsrx"), &first.code, Some(&options)).unwrap();
        assert_eq!(second.code, first.code);

        // Canonical Oxfmt's original spelling of the option reaches the same engine.
        let aliased = root_options(&json!({ "semi": false, "experimentalSortImports": true }));
        let via_alias =
            format_text_with_options(Path::new("Card.tsrx"), source, Some(&aliased)).unwrap();
        assert!(via_alias.code.starts_with("import { a } from \"apple\"\n"), "{}", via_alias.code);

        // The one option still outside the pinned formatter boundary is refused exactly as before.
        let refused = root_error(&json!({ "sortTailwindcss": true }));
        assert!(refused.contains("`sortTailwindcss` is not available for TSRX"), "{refused}");
    }

    #[test]
    fn an_unusable_sort_imports_or_jsdoc_value_names_the_block_it_was_authored_in() {
        // The same bad value has to read differently depending on where it was written, the way
        // every other refusal in this crate already does.
        let sort_imports = json!({ "sortImports": { "order": "up" } });
        let at_root = root_error(&sort_imports);
        let in_override = scoped_error(&sort_imports, ConfigScope::Override { index: 3 });
        assert!(at_root.contains("invalid Oxfmt sortImports"), "{at_root}");
        assert!(at_root.contains("expected `asc` or `desc`"), "{at_root}");
        assert!(at_root.ends_with(" in root Oxfmt config"), "{at_root}");
        assert!(in_override.ends_with(" in Oxfmt override 3"), "{in_override}");
        assert_ne!(at_root, in_override);

        // A misspelled `jsdoc` sub-option travels the same path.
        let jsdoc = json!({ "jsdoc": { "commentlinestrategy": "multiline" } });
        let jsdoc_at_root = root_error(&jsdoc);
        let jsdoc_in_override = scoped_error(&jsdoc, ConfigScope::Override { index: 0 });
        assert!(jsdoc_at_root.contains("unknown field `commentlinestrategy`"), "{jsdoc_at_root}");
        assert!(jsdoc_at_root.ends_with(" in root Oxfmt config"), "{jsdoc_at_root}");
        assert!(jsdoc_in_override.ends_with(" in Oxfmt override 0"), "{jsdoc_in_override}");
    }

    #[test]
    fn jsdoc_reflows_a_doc_comment_over_tsrx_control_flow_and_converges() {
        let source = concat!(
            "/**\n",
            "*    counts   things\n",
            "*   @param {number}   start    the first value\n",
            "* @returns {number} the next value\n",
            "*/\n",
            "export function View({start,ready}:{start:number;ready:boolean}) @{",
            "@if(ready){<p>{start}</p>}@else{<span>no</span>}}\n",
        );
        let options = jsdoc_options(&json!(true));
        let first =
            format_text_with_options(Path::new("Doc.tsrx"), source, Some(&options)).unwrap();
        assert_eq!(first.metadata.mode, FormatMode::Projected);
        assert_eq!(first.metadata.parse_count, 1);
        assert!(
            first.code.contains(concat!(
                "/**\n",
                " * Counts things\n",
                " *\n",
                " * @param {number} start The first value\n",
                " * @returns {number} The next value\n",
                " */\n",
            )),
            "{}",
            first.code
        );
        assert!(first.code.contains("@if (ready) {"), "{}", first.code);
        assert!(first.code.contains("} @else {"), "{}", first.code);
        assert!(!first.code.contains("_t"), "{}", first.code);

        let second =
            format_text_with_options(Path::new("Doc.tsrx"), &first.code, Some(&options)).unwrap();
        assert_eq!(second.code, first.code);
        assert!(!second.changed);

        // Without the option the same comment is left exactly as it was authored.
        let untouched = format_text(Path::new("Doc.tsrx"), source).unwrap();
        assert!(untouched.code.contains("counts   things"), "{}", untouched.code);
    }

    #[test]
    fn the_jsdoc_object_form_selects_sub_options_and_reports_unusable_ones() {
        let source = "/**    counts   things   */\nexport function View() @{<p>hi</p>}\n";
        let dotted = format_text_with_options(
            Path::new("Doc.tsrx"),
            source,
            Some(&jsdoc_options(&json!({ "descriptionWithDot": true }))),
        )
        .unwrap();
        assert!(dotted.code.starts_with("/** Counts things. */"), "{}", dotted.code);

        let multiline = format_text_with_options(
            Path::new("Doc.tsrx"),
            source,
            Some(&jsdoc_options(&json!({ "commentLineStrategy": "multiline" }))),
        )
        .unwrap();
        assert!(multiline.code.starts_with("/**\n * Counts things\n */"), "{}", multiline.code);

        let disabled = format_text_with_options(
            Path::new("Doc.tsrx"),
            source,
            Some(&jsdoc_options(&json!(false))),
        )
        .unwrap();
        assert!(disabled.code.starts_with("/**    counts   things   */"), "{}", disabled.code);

        // An unusable enum string is reported in canonical Oxfmt's own wording.
        let error = format_text_with_options(
            Path::new("Doc.tsrx"),
            source,
            Some(&jsdoc_options(&json!({ "lineWrappingStyle": "wrap" }))),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("jsdoc lineWrappingStyle `wrap`"), "{error}");
        assert!(error.contains("greedy"), "{error}");
        assert!(error.contains("balance"), "{error}");

        // A misspelled sub-option is refused rather than silently ignored.
        let mut engine = EngineFormatOptions::default();
        let rejected =
            engine.set_jsdoc(&json!({ "capitalizeDescription": true })).unwrap_err().to_string();
        assert!(rejected.contains("capitalizeDescription"), "{rejected}");
        let rejected = engine.set_jsdoc(&json!("always")).unwrap_err().to_string();
        assert!(rejected.contains("jsdoc"), "{rejected}");
    }

    #[test]
    fn jsdoc_leaves_projection_markers_and_raw_style_payloads_alone() {
        let payload = "/**   raw   doc  */ .card{color:red}";
        let source = format!(
            "export function View({{ok}}:{{ok:boolean}}) @{{<main><style>{payload}</style>\
             @if(ok){{<p>hi</p>}}</main>}}\n"
        );
        let options = jsdoc_options(&json!(true));
        let first =
            format_text_with_options(Path::new("Style.tsrx"), &source, Some(&options)).unwrap();
        assert_eq!(first.metadata.style_count, 1);
        assert_eq!(first.metadata.embedded_parse_count, 0);
        // The style payload is a checked opaque region, so a JSDoc-shaped comment inside it is
        // still not code and stays byte-identical.
        assert!(first.code.contains(payload), "{}", first.code);
        assert!(!first.code.contains("_t"), "{}", first.code);

        let second =
            format_text_with_options(Path::new("Style.tsrx"), &first.code, Some(&options)).unwrap();
        assert_eq!(second.code, first.code);
    }

    #[test]
    fn jsdoc_keeps_a_dynamic_tag_region_byte_identical() {
        let source = concat!(
            "export function View({Tag,ok}:{Tag:string;ok:boolean}) @{",
            "<main>@if(ok){<{Tag}>hi</{Tag /**   inner   doc  */}>}</main>}\n",
        );
        let first = format_text_with_options(
            Path::new("Dyn.tsrx"),
            source,
            Some(&jsdoc_options(&json!(true))),
        )
        .unwrap();
        // The lift restores a dynamic-tag region from the authored bytes, so the comment written
        // inside its braces comes back exactly as authored rather than reflowed.
        assert_eq!(first.code.matches("/**   inner   doc  */").count(), 1, "{}", first.code);
        assert!(first.code.contains("<{Tag}>"), "{}", first.code);
        assert!(first.code.contains("</{Tag}>"), "{}", first.code);
        assert!(!first.code.contains("_t"), "{}", first.code);
    }

    /// Formatting runs the parser scan, so a decorator whose name only begins with a control
    /// keyword has to survive it. The escaped spellings are the ones that regressed: `\` ends no
    /// identifier, so a raw-byte keyword boundary read `@for` out of `@forπ` and rejected the
    /// file for a missing `(`. A `.tsrx` file has to format exactly as the same bytes do as `.tsx`.
    #[test]
    fn decorators_named_after_control_keywords_format_like_ordinary_tsx() {
        for source in [
            "@if\u{03c0}\nclass Decorated{method( ){return 1}}\n",
            "@for\\u03c0\nclass Decorated{method( ){return 1}}\n",
            "@try\\u{1D49C}\nclass Decorated{method( ){return 1}}\n",
        ] {
            let through_tsrx = format_text(Path::new("Decorated.tsrx"), source)
                .unwrap_or_else(|error| panic!("{source:?}: {error}"));
            let canonical = format_text(Path::new("Decorated.tsx"), source)
                .unwrap_or_else(|error| panic!("{source:?}: {error}"));
            assert_eq!(through_tsrx.code, canonical.code, "{source:?}");
        }
    }

    #[test]
    fn embedded_css_boundary_is_keep_raw_without_hidden_work() {
        let payload = "/* spacing is authored */ .card{color:oklch(62% .2 25);  margin:0  1rem}";
        let source =
            format!("export function View() @{{<main><style>{payload}</style><p>Hi</p></main>}}\n");
        let output = format_text(Path::new("View.tsrx"), &source).unwrap();

        assert_eq!(EMBEDDED_CSS_MODE, "KEEP_RAW");
        assert_eq!(EMBEDDED_CSS_PARSE_COUNT, 0);
        assert_eq!(EMBEDDED_CSS_FORMAT_NS, 0);
        const { assert!(!EMBEDDED_CSS_USES_SUBPROCESS) };
        assert!(output.code.contains(payload));
        assert_eq!(output.metadata.style_count, 1);
        assert_eq!(output.metadata.embedded_parse_count, EMBEDDED_CSS_PARSE_COUNT);
        assert_eq!(output.metadata.timings.embedded_format_ns, EMBEDDED_CSS_FORMAT_NS);
    }

    #[test]
    fn formats_tsrx_with_one_parse_and_converges() {
        let source = "export function View({ready}:{ready:boolean}) @{ @if(ready){<p>Crème 🚀</p>;}@else{<span>no</span>;} }\n";
        let first = format_text(Path::new("View.tsrx"), source).unwrap();
        assert_eq!(first.metadata.mode, FormatMode::Projected);
        assert_eq!(first.metadata.parse_count, 1);
        assert_eq!(first.metadata.embedded_parse_count, 0);
        assert_eq!(first.metadata.marker_count, 3);
        assert!(first.metadata.projection_bytes > source.len());
        assert!(first.code.contains("function View({ ready }: { ready: boolean }) @{"));
        assert!(first.code.contains("@if (ready) {"));
        assert!(first.code.contains("} @else {"));

        let second = format_text(Path::new("View.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
        assert!(!second.changed);
    }

    #[test]
    fn formats_parser_only_code_blocks_shorthand_and_lazy_patterns() {
        let source = concat!(
            "export function View(props:Props) @{\n",
            "const title=@{const prefix='Hi';`${prefix} ${props.name}`};\n",
            "const &{value=1,...rest}=props;\n",
            "&[first,...tail]=props.items;\n",
            "<main {title}><script>if (ready) console.log(\"raw\");</script>",
            "@{const label=rest.label;<p>{label}{value}{first}{tail.length}</p>}</main>\n",
            "}\n",
        );
        let first = format_text(Path::new("View.tsrx"), source).unwrap();
        assert!(first.code.contains("const title = @{"), "{}", first.code);
        assert!(first.code.contains("const &{ value = 1, ...rest } = props;"), "{}", first.code);
        assert!(first.code.contains("&[first, ...tail] = props.items;"), "{}", first.code);
        assert!(first.code.contains("<main {title}>"), "{}", first.code);
        assert!(first.code.contains("if (ready) console.log(\"raw\");"), "{}", first.code);
        assert!(first.code.contains("@{"), "{}", first.code);
        assert!(!first.code.contains("_t"), "{}", first.code);

        let second = format_text(Path::new("View.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
        assert!(!second.changed);
    }

    #[test]
    fn ordinary_tsx_has_zero_tsrx_work() {
        let source = "export const view=<main>hello</main>\n";
        let output = format_text(Path::new("View.tsx"), source).unwrap();
        assert_eq!(output.metadata.mode, FormatMode::Direct);
        assert_eq!(output.metadata.parse_count, 1);
        assert_eq!(output.metadata.embedded_parse_count, 0);
        assert_eq!(output.metadata.timings.scan_ns, 0);
        assert_eq!(output.metadata.timings.projection_ns, 0);
        assert_eq!(output.metadata.timings.lift_ns, 0);
        assert_eq!(output.metadata.projection_bytes, 0);
        assert_eq!(output.metadata.marker_count, 0);
    }

    #[test]
    fn direct_control_lift_preserves_utf8_bytes_and_converges() {
        let source = "export function View({ok}:{ok:boolean}) @{<main>@if(ok){<p>Crème 🚀 ❚</p>}@else{<i>否</i>}</main>}\n";
        let first = format_text(Path::new("View.tsrx"), source).unwrap();
        assert!(first.code.contains("Crème 🚀 ❚"));
        assert!(first.code.contains("否"));
        let second = format_text(Path::new("View.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
    }

    #[test]
    fn switch_and_source_order_try_format_with_one_parse_and_converge() {
        let source = concat!(
            "export function View({value}:{value:number}) @{<main>",
            "@switch(value){@case 0:{@try{<b/>}@pending{<i/>}",
            "@catch(error:Error,reset:()=>void){<button onClick={reset}>{error.message}</button>}}",
            "@default:{<em/>}}</main>}\n"
        );
        let first = format_text(Path::new("View.tsrx"), source).unwrap();
        assert_eq!(first.metadata.parse_count, 1);
        assert_eq!(first.metadata.embedded_parse_count, 0);
        assert_eq!(first.metadata.style_count, 0);
        assert!(first.code.contains("@switch (value)"));
        assert!(first.code.contains("} @pending {"));
        assert!(first.code.contains("} @catch (error: Error, reset: () => void) {"));
        let second = format_text(Path::new("View.tsrx"), &first.code).unwrap();
        assert_eq!(second.metadata.parse_count, 1);
        assert_eq!(second.code, first.code);
    }

    #[test]
    fn expression_control_preserves_template_raw_indentation() {
        let source = "export function View({ok}:{ok:boolean}) @{const value=@if(ok){`first\n  raw 🚀`}@else{`second\n    否`};<p>{value}</p>;}\n";
        let first = format_text(Path::new("View.tsrx"), source).unwrap();
        assert!(first.code.contains("`first\n  raw 🚀`"));
        assert!(first.code.contains("`second\n    否`"));
        let second = format_text(Path::new("View.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
    }

    #[test]
    fn dynamic_tags_and_raw_css_preservation_format_natively_and_converge() {
        let source = "export function View({tag}:{tag:string}) @{<main><{tag}>Hi</{tag}><style>.card{color:red}</style></main>}\n";
        let first = format_text(Path::new("List.tsrx"), source).unwrap();
        assert_eq!(first.metadata.parse_count, 1);
        assert_eq!(first.metadata.embedded_parse_count, 0);
        assert_eq!(first.metadata.style_count, 1);
        assert!(first.code.contains("<{tag}>"));
        assert!(first.code.contains("</{tag}>"));
        assert!(first.code.contains(".card{color:red}"));
        let second = format_text(Path::new("List.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
        assert!(!second.changed);
    }

    #[test]
    fn preserves_dynamic_closing_comments_and_converges() {
        let source = concat!(
            "export function View({Tag}:{Tag:string}) @{",
            "<main>",
            "@if (true) {<>",
            "<{Tag}>block</{Tag /* closing block */}>",
            "<{Tag}>line</{Tag // closing line\n}>",
            "</>}",
            "</main>",
            "}\n",
        );
        let first = format_text(Path::new("Comments.tsrx"), source).unwrap();
        assert_eq!(first.code.matches("/* closing block */").count(), 1);
        assert_eq!(first.code.matches("// closing line").count(), 1);
        assert!(first.code.contains("</{Tag}>"));
        let second = format_text(Path::new("Comments.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
    }

    #[test]
    fn dynamic_regex_braces_use_checked_end_sentinels_and_converge() {
        let source = concat!(
            "export function View({ok,Tag}:{ok:boolean;Tag:string}) @{",
            "<{ok ? /\\{/ : Tag} />",
            "}\n",
        );
        let first = format_text(Path::new("Regex.tsrx"), source).unwrap();
        assert!(first.code.contains("<{ok ? /\\{/ : Tag} />;"));
        assert!(first.code.contains("\n}\n"), "{}", first.code);
        let second = format_text(Path::new("Regex.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
    }

    #[test]
    fn repeated_dynamic_style_markers_converge_past_single_digit_ordinals() {
        let mut source = String::from("export function View({Tag}:{Tag:string}) @{<main>");
        for _ in 0..32 {
            source
                .push_str("<{Tag}><{Tag} /><style>/* raw {label} */ .x{color:red}</style></{Tag}>");
        }
        source.push_str("</main>}\n");
        let first = format_text(Path::new("Repeated.tsrx"), &source).unwrap();
        assert_eq!(first.metadata.style_count, 32);
        assert_eq!(first.metadata.embedded_parse_count, 0);
        assert_eq!(first.code.matches("<{Tag}>").count(), 32);
        assert_eq!(first.code.matches("<{Tag} />").count(), 32);
        assert_eq!(first.code.matches("/* raw {label} */").count(), 32);
        let second = format_text(Path::new("Repeated.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
    }

    #[test]
    fn wide_keyed_header_survives_the_formatter_breaking_its_scaffold_call() {
        // A `key` expression wide enough that the projected header call cannot fit the
        // print width. The formatter then breaks that call across lines and writes a
        // trailing comma after its last argument, which the checked lift has to read
        // back. Before this was handled the whole file was refused with
        // "Oxfmt changed TSRX scaffold 0" and left byte-identical.
        let source = concat!(
            "export function View({rows}:{rows:Row[]}) @{<ul>",
            "@for(const row of rows;key row.aVeryLongPropertyNameSegment",
            "aVeryLongPropertyNameSegmentaVeryLongPropertyNameSegment)",
            "{<li>{row.label}</li>}</ul>}\n"
        );
        let first = format_text(Path::new("Wide.tsrx"), source).unwrap();
        assert!(
            first.code.contains(
                "key row.aVeryLongPropertyNameSegmentaVeryLongPropertyNameSegment\
                 aVeryLongPropertyNameSegment"
            ),
            "{}",
            first.code
        );
        assert!(!first.code.contains("_t"), "{}", first.code);
        let second = format_text(Path::new("Wide.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
        assert!(!second.changed);
    }

    #[test]
    fn wide_indexed_header_survives_the_formatter_breaking_its_scaffold_call() {
        let source = concat!(
            "export function View({rows}:{rows:Row[]}) @{<ul>",
            "@for(const row of rows;index positionOfThisRowWithinTheCollection",
            "ThatIsBeingIteratedOverHere)",
            "{<li>{row.label}</li>}</ul>}\n"
        );
        let first = format_text(Path::new("Indexed.tsrx"), source).unwrap();
        assert!(
            first
                .code
                .contains("index positionOfThisRowWithinTheCollectionThatIsBeingIteratedOverHere"),
            "{}",
            first.code
        );
        let second = format_text(Path::new("Indexed.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
    }

    #[test]
    fn keyed_header_inside_a_try_arm_formats_at_a_wider_tab_width() {
        // The shape three real files hit: a keyed `@for` two element levels inside a
        // `@try` arm. At the default two-space indent the projected header still fits
        // the print width; at four the same header runs long, the formatter breaks its
        // scaffold call, and the lift has to read the break back. Indent width alone
        // decided whether the file could be formatted at all.
        let source = concat!(
            "export default function Page({rows}:{rows:Row[]}) @{\n",
            "\t<div data-page>\n",
            "\t\t@try {\n",
            "\t\t\t<ContextFrame>\n",
            "\t\t\t\t<ul>\n",
            "\t\t\t\t\t@for (const row of rows; key row.id) {\n",
            "\t\t\t\t\t\t<li data-row>{row.label}</li>\n",
            "\t\t\t\t\t}\n",
            "\t\t\t\t</ul>\n",
            "\t\t\t</ContextFrame>\n",
            "\t\t} @pending {\n",
            "\t\t\t<p>loading</p>\n",
            "\t\t} @catch {\n",
            "\t\t\t<p>failed</p>\n",
            "\t\t}\n",
            "\t</div>\n",
            "}\n",
        );
        let options = FileFormatOptions {
            engine: EngineFormatOptions {
                use_tabs: Some(true),
                tab_width: Some(4),
                ..EngineFormatOptions::default()
            },
            insert_final_newline: None,
        };
        let first =
            format_text_with_options(Path::new("Page.tsrx"), source, Some(&options)).unwrap();
        assert_eq!(first.metadata.mode, FormatMode::Projected);
        assert!(first.code.contains("@for (const row of rows; key row.id) {"), "{}", first.code);
        assert!(first.code.contains("} @pending {"), "{}", first.code);
        assert!(first.code.contains("} @catch {"), "{}", first.code);
        assert!(first.code.contains("<ContextFrame>"), "{}", first.code);
        assert!(!first.code.contains("_t"), "{}", first.code);

        let second =
            format_text_with_options(Path::new("Page.tsrx"), &first.code, Some(&options)).unwrap();
        assert_eq!(second.code, first.code);
        assert!(!second.changed);
    }
}

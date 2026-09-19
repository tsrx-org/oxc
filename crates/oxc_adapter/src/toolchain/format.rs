//! The canonical Oxfmt formatting lane and the project-owned options it is driven by.

use std::{collections::HashSet, error::Error, fmt, str::FromStr, time::Instant};

use oxc_allocator::Allocator;
use oxc_diagnostics::GraphicalTheme;
use oxc_formatter::{
    ArrowParentheses, AttributePosition, BracketSameLine, BracketSpacing, CommentLineStrategy,
    CustomGroupDefinition, Expand, GroupEntry, ImportModifier, ImportSelector, JsFormatOptions,
    JsdocOptions, LineWrappingStyle, QuoteProperties, QuoteStyle, Semicolons, SortImportsOptions,
    SortOrder, TrailingCommas, format_program, parse_for_format,
};
use oxc_formatter_core::{IndentStyle, IndentWidth, LineEnding, LineWidth};
use serde::Deserialize;
use serde_json::Value;

use super::timings::{FormatEngineTimings, elapsed_ns};
use crate::{DynamicTagContract, DynamicTagError, SourceKind, validate_dynamic_tags};

/// Why one canonical Oxfmt formatting pass produced no output.
#[derive(Debug)]
pub enum FormatError {
    /// Canonical OXC could not parse the projected source. Holds its joined diagnostic text.
    Parse { detail: String },
    /// Canonical Oxfmt built a document it could not print. Holds its wording.
    Print { detail: String },
    /// One of the caller's Oxfmt options is not usable.
    Options(FormatOptionError),
    /// The TSRX dynamic-tag scaffold did not survive the parse.
    DynamicTags(DynamicTagError),
}

impl fmt::Display for FormatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse { detail } => write!(formatter, "OXC formatter parse failed: {detail}"),
            Self::Print { detail } => write!(formatter, "OXC formatter print failed: {detail}"),
            Self::Options(error) => error.fmt(formatter),
            Self::DynamicTags(error) => error.fmt(formatter),
        }
    }
}

impl Error for FormatError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Options(error) => Some(error),
            Self::DynamicTags(error) => Some(error),
            Self::Parse { .. } | Self::Print { .. } => None,
        }
    }
}

impl From<FormatOptionError> for FormatError {
    fn from(error: FormatOptionError) -> Self {
        Self::Options(error)
    }
}

impl From<DynamicTagError> for FormatError {
    fn from(error: DynamicTagError) -> Self {
        Self::DynamicTags(error)
    }
}

/// A single Oxfmt option this adapter refuses to pass to canonical Oxfmt.
///
/// `detail` quotes canonical Oxfmt's own wording where the option is parsed upstream, so the
/// rendered text stays the one users already see; see [`ConfigError`](super::ConfigError) for why
/// the upstream error type itself is not carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormatOptionError {
    /// A numeric option outside the range canonical Oxfmt accepts.
    Numeric { option: &'static str, value: u16, detail: String },
    /// A named option canonical Oxfmt parses and rejected, with its wording.
    Named { option: &'static str, value: String, detail: String },
    /// A named option this adapter resolves itself, so there is no upstream wording to quote.
    Unrecognized { option: &'static str, value: String },
}

impl fmt::Display for FormatOptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Numeric { option, value, detail } => {
                write!(formatter, "invalid Oxfmt {option} {value}: {detail}")
            }
            Self::Named { option, value, detail } => {
                write!(formatter, "invalid Oxfmt {option} `{value}`: {detail}")
            }
            Self::Unrecognized { option, value } => {
                write!(formatter, "invalid Oxfmt {option} `{value}`")
            }
        }
    }
}

impl Error for FormatOptionError {}

impl FormatOptionError {
    fn numeric(option: &'static str, value: u16, detail: impl fmt::Display) -> Self {
        Self::Numeric { option, value, detail: detail.to_string() }
    }

    fn named(option: &'static str, value: &str, detail: impl fmt::Display) -> Self {
        Self::Named { option, value: value.to_string(), detail: detail.to_string() }
    }

    fn unrecognized(option: &'static str, value: &str) -> Self {
        Self::Unrecognized { option, value: value.to_string() }
    }
}

#[derive(Debug)]
pub struct FormatRequest<'a> {
    pub parse_source: &'a str,
    pub source_kind: SourceKind,
    pub dynamic_tags: Option<DynamicTagContract<'a>>,
    pub options: Option<&'a FormatOptions>,
}

/// Oxfmt-compatible options that affect JavaScript, TypeScript, JSX, and TSRX output.
///
/// This project-owned representation keeps revision-specific OXC option types inside this adapter.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FormatOptions {
    pub use_tabs: Option<bool>,
    pub tab_width: Option<u8>,
    pub end_of_line: Option<String>,
    pub print_width: Option<u16>,
    pub single_quote: Option<bool>,
    pub jsx_single_quote: Option<bool>,
    pub quote_props: Option<String>,
    pub trailing_comma: Option<String>,
    pub semi: Option<bool>,
    pub arrow_parens: Option<String>,
    pub bracket_spacing: Option<bool>,
    pub bracket_same_line: Option<bool>,
    pub object_wrap: Option<String>,
    pub single_attribute_per_line: Option<bool>,
    pub embedded_language_formatting: Option<String>,
    pub html_whitespace_sensitivity: Option<String>,
    /// Oxfmt's `jsdoc` option, parsed by [`FormatOptions::set_jsdoc`].
    pub jsdoc: Option<JsdocSetting>,
    /// Oxfmt's `sortImports` option, parsed by [`FormatOptions::set_sort_imports`].
    pub sort_imports: Option<SortImportsSetting>,
}

/// Whether one configuration scope turns `jsdoc` comment formatting on, and with which
/// sub-options.
///
/// Canonical Oxfmt spells this option `true`, `false`, or an object. The disabled form stays a
/// value rather than an absent option so one `overrides` entry can turn the option back off for
/// the files it matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsdocSetting {
    Disabled,
    Enabled(JsdocConfig),
}

/// The sub-options canonical Oxfmt reads out of a `jsdoc` object.
///
/// Every field stays `None` when the author did not write it, so the pinned formatter's own
/// defaults decide. The two string fields are validated where every other named option is, in
/// [`js_format_options`], and unknown fields are refused rather than silently ignored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsdocConfig {
    pub capitalize_descriptions: Option<bool>,
    pub description_with_dot: Option<bool>,
    pub add_default_to_description: Option<bool>,
    pub prefer_code_fences: Option<bool>,
    pub line_wrapping_style: Option<String>,
    pub comment_line_strategy: Option<String>,
    pub separate_tag_groups: Option<bool>,
    pub separate_returns_from_param: Option<bool>,
    pub bracket_spacing: Option<bool>,
    pub description_tag: Option<bool>,
    pub keep_unparsable_example_indent: Option<bool>,
}

/// Whether one configuration scope turns import sorting on, and with which sub-options.
///
/// Canonical Oxfmt spells this option `true`, `false`, or an object, under either `sortImports` or
/// its `experimentalSortImports` alias. The disabled form stays a value rather than an absent
/// option so one `overrides` entry can turn sorting back off for the files it matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SortImportsSetting {
    Disabled,
    Enabled(SortImportsConfig),
}

/// The sub-options canonical Oxfmt reads out of a `sortImports` object.
///
/// Every field stays `None` when the author did not write it, so the pinned formatter's own
/// defaults decide. Names inside `groups` and `customGroups` are parsed and cross-checked where
/// every other named option is, in [`js_format_options`], and unknown fields are refused rather
/// than silently ignored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SortImportsConfig {
    pub partition_by_newline: Option<bool>,
    pub partition_by_comment: Option<bool>,
    pub sort_side_effects: Option<bool>,
    pub order: Option<SortImportsOrder>,
    pub ignore_case: Option<bool>,
    pub newlines_between: Option<bool>,
    pub internal_pattern: Option<Vec<String>>,
    pub groups: Option<Vec<SortImportsGroup>>,
    pub custom_groups: Option<Vec<SortImportsCustomGroup>>,
}

/// Whether imports sort A-Z or Z-A, spelled the way canonical Oxfmt spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortImportsOrder {
    Asc,
    Desc,
}

/// One entry of the `groups` list.
///
/// Canonical Oxfmt accepts a single group name, an array of names sorted as one group, or a
/// `{ "newlinesBetween": bool }` marker that overrides the blank line at one group boundary.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum SortImportsGroup {
    NewlinesBetween(NewlinesBetweenMarker),
    Single(String),
    Multiple(Vec<String>),
}

impl SortImportsGroup {
    /// The group names this entry contributes, which is nothing for a boundary marker.
    fn names(&self) -> &[String] {
        match self {
            Self::Single(name) => std::slice::from_ref(name),
            Self::Multiple(names) => names,
            Self::NewlinesBetween(_) => &[],
        }
    }
}

/// The `{ "newlinesBetween": bool }` marker one `groups` entry can be.
///
/// A misspelled key is refused rather than read as a group name, so a typo cannot silently turn
/// into an undefined custom group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewlinesBetweenMarker {
    pub newlines_between: bool,
}

/// One `customGroups` entry: a name usable in `groups`, plus what it matches.
///
/// `groupName` is required. A container-level `default` would let an entry omit it, read the
/// entry as the empty name, and then let a `groups` entry of `""` resolve against it, so a typo
/// would define a group instead of being refused.
///
/// `elementNamePattern` stays optional because canonical Oxfmt reads an empty pattern list as
/// "matches every import", which is how a group selected purely by `selector` or `modifiers` is
/// written; its own `custom_groups_selector_modifiers` fixture authors one that way.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SortImportsCustomGroup {
    pub group_name: String,
    #[serde(default)]
    pub element_name_pattern: Vec<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub modifiers: Option<Vec<String>>,
}

impl FormatOptions {
    /// Reads Oxfmt's `sortImports` option out of one JSON configuration value.
    ///
    /// Callers hand over the raw JSON for the same reason [`FormatOptions::set_jsdoc`] does: the
    /// parsed shape is this adapter's own, so the `true | false | object` form canonical Oxfmt
    /// documents stays in the one module allowed to know how the pinned formatter spells it.
    ///
    /// # Errors
    ///
    /// Returns [`FormatOptionError`] when the value is neither a boolean nor an object of the
    /// sub-options canonical Oxfmt accepts.
    pub fn set_sort_imports(&mut self, value: &Value) -> Result<(), FormatOptionError> {
        let setting = match value {
            Value::Bool(false) => SortImportsSetting::Disabled,
            Value::Bool(true) => SortImportsSetting::Enabled(SortImportsConfig::default()),
            Value::Object(_) => {
                SortImportsSetting::Enabled(serde_json::from_value(value.clone()).map_err(
                    |error| FormatOptionError::named("sortImports", &value.to_string(), error),
                )?)
            }
            other => {
                return Err(FormatOptionError::named(
                    "sortImports",
                    &other.to_string(),
                    "expected `true`, `false`, or an object of import-sorting options",
                ));
            }
        };
        self.sort_imports = Some(setting);
        Ok(())
    }

    /// Reads Oxfmt's `jsdoc` option out of one JSON configuration value.
    ///
    /// Callers hand over the raw JSON because the parsed shape is this adapter's own, which keeps
    /// the `true | false | object` form canonical Oxfmt documents in the one module allowed to
    /// know how the pinned formatter spells it.
    ///
    /// # Errors
    ///
    /// Returns [`FormatOptionError`] when the value is neither a boolean nor an object of the
    /// sub-options canonical Oxfmt accepts.
    pub fn set_jsdoc(&mut self, value: &Value) -> Result<(), FormatOptionError> {
        let setting = match value {
            Value::Bool(false) => JsdocSetting::Disabled,
            Value::Bool(true) => JsdocSetting::Enabled(JsdocConfig::default()),
            Value::Object(_) => {
                JsdocSetting::Enabled(serde_json::from_value(value.clone()).map_err(|error| {
                    FormatOptionError::named("jsdoc", &value.to_string(), error)
                })?)
            }
            other => {
                return Err(FormatOptionError::named(
                    "jsdoc",
                    &other.to_string(),
                    "expected `true`, `false`, or an object of JSDoc options",
                ));
            }
        };
        self.jsdoc = Some(setting);
        Ok(())
    }
}

#[derive(Debug)]
pub struct EngineFormatResult {
    pub code: String,
    pub timings: FormatEngineTimings,
    pub parse_count: u32,
}

/// Formats one legal JavaScript/TypeScript projection with canonical Oxfmt.
///
/// This deliberately calls [`parse_for_format`] once and [`format_program`] once. Keeping this
/// sequence here prevents revision-specific OXC APIs from leaking into the TSRX language crates
/// and makes the one-parse invariant directly inspectable.
///
/// # Errors
///
/// Returns [`FormatError`] when an option is unusable, or when canonical OXC parsing, dynamic-tag
/// validation, or document printing fails.
pub fn format(request: &FormatRequest<'_>) -> Result<EngineFormatResult, FormatError> {
    let allocator = Allocator::default();
    let source_type = request.source_kind.source_type();

    let started = Instant::now();
    let parsed = parse_for_format(&allocator, request.parse_source, source_type);
    if !parsed.diagnostics.is_empty() {
        let detail =
            parsed.diagnostics.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ");
        return Err(FormatError::Parse { detail });
    }
    validate_dynamic_tags(&parsed.program, request.dynamic_tags)?;
    let parse_ns = elapsed_ns(started);

    let started = Instant::now();
    let options =
        request.options.map_or_else(|| Ok(JsFormatOptions::default()), js_format_options)?;
    let code = format_program(&allocator, &parsed.program, options)
        .print()
        .map_err(|error| FormatError::Print { detail: error.to_string() })?
        .into_code();
    let format_ns = elapsed_ns(started);

    Ok(EngineFormatResult {
        code,
        timings: FormatEngineTimings { parse_ns, format_ns },
        parse_count: 1,
    })
}

fn js_format_options(options: &FormatOptions) -> Result<JsFormatOptions, FormatOptionError> {
    let mut resolved = JsFormatOptions::default();
    if let Some(use_tabs) = options.use_tabs {
        resolved.indent_style = if use_tabs { IndentStyle::Tab } else { IndentStyle::Space };
    }
    if let Some(width) = options.tab_width {
        resolved.indent_width = IndentWidth::try_from(width)
            .map_err(|error| FormatOptionError::numeric("tabWidth", u16::from(width), error))?;
    }
    if let Some(value) = &options.end_of_line {
        resolved.line_ending = LineEnding::from_str(value)
            .map_err(|error| FormatOptionError::named("endOfLine", value, error))?;
    }
    if let Some(width) = options.print_width {
        resolved.line_width = LineWidth::try_from(width)
            .map_err(|error| FormatOptionError::numeric("printWidth", width, error))?;
    }
    if let Some(single) = options.single_quote {
        resolved.quote_style = if single { QuoteStyle::Single } else { QuoteStyle::Double };
    }
    if let Some(single) = options.jsx_single_quote {
        resolved.jsx_quote_style = if single { QuoteStyle::Single } else { QuoteStyle::Double };
    }
    if let Some(value) = &options.quote_props {
        resolved.quote_properties = QuoteProperties::from_str(value)
            .map_err(|error| FormatOptionError::named("quoteProps", value, error))?;
    }
    if let Some(value) = &options.trailing_comma {
        resolved.trailing_commas = TrailingCommas::from_str(value)
            .map_err(|error| FormatOptionError::named("trailingComma", value, error))?;
    }
    if let Some(semi) = options.semi {
        resolved.semicolons = if semi { Semicolons::Always } else { Semicolons::AsNeeded };
    }
    if let Some(value) = &options.arrow_parens {
        resolved.arrow_parentheses = match value.as_str() {
            "avoid" => ArrowParentheses::AsNeeded,
            "always" => ArrowParentheses::Always,
            _ => {
                return Err(FormatOptionError::named(
                    "arrowParens",
                    value,
                    "expected `always` or `avoid`",
                ));
            }
        };
    }
    if let Some(spacing) = options.bracket_spacing {
        resolved.bracket_spacing = BracketSpacing::from(spacing);
    }
    if let Some(same_line) = options.bracket_same_line {
        resolved.bracket_same_line = BracketSameLine::from(same_line);
    }
    if let Some(value) = &options.object_wrap {
        resolved.expand = match value.as_str() {
            "preserve" => Expand::Auto,
            "collapse" => Expand::Never,
            _ => return Err(FormatOptionError::unrecognized("objectWrap", value)),
        };
    }
    if let Some(single_attribute) = options.single_attribute_per_line {
        resolved.attribute_position =
            if single_attribute { AttributePosition::Multiline } else { AttributePosition::Auto };
    }
    // `embeddedLanguageFormatting` is no longer a formatter-crate option: canonical Oxfmt
    // implements it with an application-level embedded-language dispatcher this adapter does
    // not carry, and the TSRX formatter rejects the option before reaching this point.
    if let Some(value) = &options.html_whitespace_sensitivity {
        resolved.html_whitespace_sensitivity_ignore = match value.as_str() {
            "ignore" => true,
            "css" | "strict" => false,
            _ => return Err(FormatOptionError::unrecognized("htmlWhitespaceSensitivity", value)),
        };
    }
    if let Some(setting) = &options.jsdoc {
        resolved.jsdoc = jsdoc_options(setting)?;
    }
    if let Some(setting) = &options.sort_imports {
        resolved.sort_imports = sort_imports_options(setting)?;
    }
    Ok(resolved)
}

/// One unusable `sortImports` value, reported in canonical Oxfmt's own wording.
///
/// Canonical prefixes each of these sentences with ``Invalid `sortImports` configuration:``; this
/// error type already names the option, so only the sentence itself is carried.
fn sort_imports_error(value: &str, detail: impl fmt::Display) -> FormatOptionError {
    FormatOptionError::named("sortImports", value, detail)
}

/// Maps the project-owned `sortImports` option onto the pinned formatter's own options.
///
/// `customGroups` is resolved before `groups`, because a `groups` entry that names none of the
/// predefined groups is only legal when a custom group defines that name.
fn sort_imports_options(
    setting: &SortImportsSetting,
) -> Result<Option<SortImportsOptions>, FormatOptionError> {
    let SortImportsSetting::Enabled(config) = setting else {
        return Ok(None);
    };
    let mut resolved = SortImportsOptions::default();
    if let Some(value) = config.partition_by_newline {
        resolved.partition_by_newline = value;
    }
    if let Some(value) = config.partition_by_comment {
        resolved.partition_by_comment = value;
    }
    if let Some(value) = config.sort_side_effects {
        resolved.sort_side_effects = value;
    }
    if let Some(value) = config.order {
        resolved.order = match value {
            SortImportsOrder::Asc => SortOrder::Asc,
            SortImportsOrder::Desc => SortOrder::Desc,
        };
    }
    if let Some(value) = config.ignore_case {
        resolved.ignore_case = value;
    }
    if let Some(value) = config.newlines_between {
        resolved.newlines_between = value;
    }
    if let Some(value) = &config.internal_pattern {
        resolved.internal_pattern.clone_from(value);
    }
    if let Some(groups) = &config.custom_groups {
        resolved.custom_groups = custom_group_definitions(groups)?;
    }
    if let Some(entries) = &config.groups {
        let (groups, overrides) = group_entries(entries, &resolved.custom_groups)?;
        resolved.groups = groups;
        resolved.newline_boundary_overrides = overrides;
    }
    resolved.validate().map_err(|error| sort_imports_error("options", error))?;
    Ok(Some(resolved))
}

/// Parses every `customGroups` entry's selector and modifiers into the pinned formatter's own.
fn custom_group_definitions(
    groups: &[SortImportsCustomGroup],
) -> Result<Vec<CustomGroupDefinition>, FormatOptionError> {
    let mut resolved = Vec::with_capacity(groups.len());
    for group in groups {
        let name = group.group_name.as_str();
        let selector = match group.selector.as_deref() {
            Some(selector) => Some(ImportSelector::parse(selector).ok_or_else(|| {
                sort_imports_error(
                    selector,
                    format!("unknown selector: `{selector}` in customGroups: `{name}`"),
                )
            })?),
            None => None,
        };
        let raw_modifiers = group.modifiers.as_deref().unwrap_or_default();
        let mut modifiers = Vec::with_capacity(raw_modifiers.len());
        for modifier in raw_modifiers {
            modifiers.push(ImportModifier::parse(modifier).ok_or_else(|| {
                sort_imports_error(
                    modifier,
                    format!("unknown modifier: `{modifier}` in customGroups: `{name}`"),
                )
            })?);
        }
        resolved.push(CustomGroupDefinition {
            group_name: group.group_name.clone(),
            element_name_pattern: group.element_name_pattern.clone(),
            selector,
            modifiers,
        });
    }
    Ok(resolved)
}

/// The pinned formatter's `groups` list paired with its per-boundary `newlinesBetween` overrides.
///
/// `overrides[i]` covers the boundary between `groups[i]` and `groups[i + 1]`, and `None` there
/// means the global `newlinesBetween` decides.
type ResolvedGroups = (Vec<Vec<GroupEntry>>, Vec<Option<bool>>);

/// Splits the authored `groups` list into the pinned formatter's groups and its per-boundary
/// `newlinesBetween` overrides.
///
/// A marker sits *between* two groups, so one at either end of the list, or two in a row, names a
/// boundary that does not exist and is refused the way canonical Oxfmt refuses it.
fn group_entries(
    entries: &[SortImportsGroup],
    custom_groups: &[CustomGroupDefinition],
) -> Result<ResolvedGroups, FormatOptionError> {
    let defined: HashSet<&str> =
        custom_groups.iter().map(|group| group.group_name.as_str()).collect();
    let mut groups: Vec<Vec<GroupEntry>> = Vec::new();
    let mut boundary_overrides: Vec<Option<bool>> = Vec::new();
    let mut pending: Option<bool> = None;
    for entry in entries {
        if let SortImportsGroup::NewlinesBetween(marker) = entry {
            if groups.is_empty() {
                return Err(sort_imports_error(
                    "groups",
                    "`{ \"newlinesBetween\" }` marker cannot appear at the start of `groups`",
                ));
            }
            if pending.is_some() {
                return Err(sort_imports_error(
                    "groups",
                    "consecutive `{ \"newlinesBetween\" }` markers are not allowed in `groups`",
                ));
            }
            pending = Some(marker.newlines_between);
            continue;
        }
        if !groups.is_empty() {
            boundary_overrides.push(pending.take());
        }
        let mut parsed = Vec::new();
        for name in entry.names() {
            let group = GroupEntry::parse(name);
            if let GroupEntry::Custom(custom) = &group
                && !defined.contains(custom.as_str())
            {
                return Err(sort_imports_error(
                    name,
                    format!("unknown group name `{name}` in `groups`"),
                ));
            }
            parsed.push(group);
        }
        groups.push(parsed);
    }
    if pending.is_some() {
        return Err(sort_imports_error(
            "groups",
            "`{ \"newlinesBetween\" }` marker cannot appear at the end of `groups`",
        ));
    }
    Ok((groups, boundary_overrides))
}

/// Maps the project-owned `jsdoc` option onto the pinned formatter's own options.
///
/// The two string sub-options quote canonical Oxfmt's wording for an invalid value, the way every
/// other named option here does.
fn jsdoc_options(setting: &JsdocSetting) -> Result<Option<JsdocOptions>, FormatOptionError> {
    let JsdocSetting::Enabled(config) = setting else {
        return Ok(None);
    };
    let mut resolved = JsdocOptions::default();
    if let Some(value) = config.capitalize_descriptions {
        resolved.capitalize_descriptions = value;
    }
    if let Some(value) = config.description_with_dot {
        resolved.description_with_dot = value;
    }
    if let Some(value) = config.add_default_to_description {
        resolved.add_default_to_description = value;
    }
    if let Some(value) = config.prefer_code_fences {
        resolved.prefer_code_fences = value;
    }
    if let Some(value) = &config.line_wrapping_style {
        resolved.line_wrapping_style = match value.as_str() {
            "greedy" => LineWrappingStyle::Greedy,
            "balance" => LineWrappingStyle::Balance,
            _ => {
                return Err(FormatOptionError::named(
                    "jsdoc lineWrappingStyle",
                    value,
                    "Expected \"greedy\" or \"balance\".",
                ));
            }
        };
    }
    if let Some(value) = &config.comment_line_strategy {
        resolved.comment_line_strategy = match value.as_str() {
            "singleLine" => CommentLineStrategy::SingleLine,
            "multiline" => CommentLineStrategy::Multiline,
            "keep" => CommentLineStrategy::Keep,
            _ => {
                return Err(FormatOptionError::named(
                    "jsdoc commentLineStrategy",
                    value,
                    "Expected \"singleLine\", \"multiline\", or \"keep\".",
                ));
            }
        };
    }
    if let Some(value) = config.separate_tag_groups {
        resolved.separate_tag_groups = value;
    }
    if let Some(value) = config.separate_returns_from_param {
        resolved.separate_returns_from_param = value;
    }
    if let Some(value) = config.bracket_spacing {
        resolved.bracket_spacing = value;
    }
    if let Some(value) = config.description_tag {
        resolved.description_tag = value;
    }
    if let Some(value) = config.keep_unparsable_example_indent {
        resolved.keep_unparsable_example_indent = value;
    }
    Ok(Some(resolved))
}

/// Appends one differing path to a `--check` report styled the way canonical Oxfmt styles it.
///
/// Since Oxfmt 0.60 the check report colours each differing path with the diagnostics theme's
/// warning style, and detects colour support the same way its graphical report handler does:
/// `CI` or `FORCE_COLOR` forces colour, a non-terminal gets none, and `NO_COLOR` strips it. The
/// merged wrapper report interleaves canonical lines with TSRX lines, so both halves must make
/// the same decision from the same environment; delegating to the pinned theme keeps them
/// byte-identical without restating its rules here. `--list-different` output stays unstyled.
pub fn write_check_report_path(output: &mut String, path: &str) {
    // Writing into a `String` cannot fail.
    let _ = GraphicalTheme::default().write_warning(output, path);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        DynamicTagContract, FormatError, FormatOptions, FormatRequest, SourceKind, Value, format,
        sort_imports_options,
    };

    fn format_dynamic(expression: &str) -> Result<String, FormatError> {
        let source = format!("const value = <_t0_D0 _t0_A0_={{{expression}}} _t0_Z0_={{null}} />;");
        let original_offsets = [0];
        format(&FormatRequest {
            parse_source: &source,
            source_kind: SourceKind::TypeScriptReact,
            dynamic_tags: Some(DynamicTagContract {
                prefix: "_t0_",
                count: 1,
                original_offsets: &original_offsets,
            }),
            options: None,
        })
        .map(|result| result.code)
    }

    #[test]
    fn dynamic_tag_validator_matches_authoritative_allowed_ast_shapes() {
        for expression in [
            "tag",
            "obj.new",
            "obj?.[key]",
            "(obj)[key]",
            "obj![key]",
            "-1",
            "() => Tag",
            "x = Tag",
            "x += Tag",
            "x++",
            "++x",
            "`d\\${kind}`",
        ] {
            assert!(format_dynamic(expression).is_ok(), "{expression}");
        }
    }

    #[test]
    fn dynamic_tag_validator_rejects_authoritative_disallowed_ast_shapes() {
        for expression in [
            "/x/",
            "null as any",
            "undefined as any",
            "true as any",
            "tag()",
            "condition ? tagName() : Tag",
            "new TagName()",
            "({ tag }).tag",
            "[Tag][0]",
            "'hello' + 'bye'",
            "`d${kind}`",
            "tag`div`",
            "fn!()",
            "fn<string>()",
            "key in [Tag]",
        ] {
            let error = format_dynamic(expression).unwrap_err().to_string();
            assert!(error.contains("dynamic tag"), "{expression}: {error}");
            assert!(error.contains("source byte 0"), "{expression}: {error}");
        }
    }

    /// One authored `sortImports` value taken all the way to the pinned formatter's own options,
    /// which is where a `groups` entry is checked against the custom groups that define it.
    fn resolve_sort_imports(value: &Value) -> Result<(), String> {
        let mut options = FormatOptions::default();
        options.set_sort_imports(value).map_err(|error| error.to_string())?;
        let setting = options.sort_imports.as_ref().expect("a sortImports setting");
        sort_imports_options(setting).map(|_| ()).map_err(|error| error.to_string())
    }

    #[test]
    fn a_custom_group_without_a_group_name_is_refused() {
        // Omitting `groupName` names no group at all, so it is refused by name rather than read
        // as the empty name.
        let missing = resolve_sort_imports(&json!({
            "customGroups": [{ "elementNamePattern": ["~/stores/*"] }],
            "groups": ["stores", "unknown"],
        }))
        .unwrap_err();
        assert!(missing.contains("missing field `groupName`"), "{missing}");

        // With that entry refused, the empty name it used to define resolves in no `groups` list.
        let empty = resolve_sort_imports(&json!({
            "customGroups": [{ "groupName": "stores", "elementNamePattern": ["~/stores/*"] }],
            "groups": ["", "unknown"],
        }))
        .unwrap_err();
        assert!(empty.contains("unknown group name `` in `groups`"), "{empty}");

        // A group matched purely by selector is what canonical Oxfmt's own fixture authors, so an
        // entry without `elementNamePattern` is still accepted.
        resolve_sort_imports(&json!({
            "customGroups": [{ "groupName": "externals", "selector": "external" }],
            "groups": ["externals", "unknown"],
        }))
        .expect("a selector-only custom group");
    }
}

//! Running a compiled [`LintEngine`] over one projected buffer or a whole type-aware batch.

use std::{
    error::Error,
    ffi::OsStr,
    fmt, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

use oxc_allocator::Allocator;
use oxc_linter::{
    ContextSubHost, ContextSubHostOptions, DisableDirectives, FixKind, ModuleRecord,
    RuntimeFileSystem, TsGoLintState,
};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use rustc_hash::FxHashMap;

use super::config::ConfigError;
use super::diagnostics::{EngineDiagnostic, map_message, map_oxc_diagnostic};
use super::engine::{LintEngine, LintEngineOptions};
use super::timings::{EngineTimings, elapsed_ns};
use super::tsgolint::{
    TsgolintError, find_tsgolint_executable, prepare_type_batch, run_type_protocol,
    verify_tsgolint_version,
};
use super::{RuleFilter, RuleSeverity};
use crate::{DynamicTagContract, DynamicTagError, SourceKind, validate_dynamic_tags};

/// Why one syntax-lane lint pass produced no diagnostics.
#[derive(Debug)]
pub enum LintError {
    /// The request's fix mode does not match the mode the session was compiled with.
    FixModeMismatch,
    /// Canonical OXC could not parse the projected source. Holds its joined diagnostic text and
    /// the diagnostics themselves, whose labels address the parsed buffer, so a caller that
    /// projected that buffer can map them back and report the failure at a real position.
    Parse { detail: String, diagnostics: Vec<EngineDiagnostic> },
    /// Canonical OXC could not build semantics. Same shape as `Parse`.
    Semantic { detail: String, diagnostics: Vec<EngineDiagnostic> },
    /// The TSRX dynamic-tag scaffold did not survive the parse.
    DynamicTags(DynamicTagError),
    /// The single-shot [`lint`] entry point could not compile a configuration first.
    Config(ConfigError),
}

impl fmt::Display for LintError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FixModeMismatch => {
                formatter.write_str("lint request fix mode differs from the compiled lint session")
            }
            Self::Parse { detail, .. } => write!(formatter, "OXC parse failed: {detail}"),
            Self::Semantic { detail, .. } => {
                write!(formatter, "OXC semantic analysis failed: {detail}")
            }
            Self::DynamicTags(error) => error.fmt(formatter),
            Self::Config(error) => error.fmt(formatter),
        }
    }
}

impl Error for LintError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::DynamicTags(error) => Some(error),
            Self::Config(error) => Some(error),
            Self::FixModeMismatch | Self::Parse { .. } | Self::Semantic { .. } => None,
        }
    }
}

impl From<DynamicTagError> for LintError {
    fn from(error: DynamicTagError) -> Self {
        Self::DynamicTags(error)
    }
}

impl From<ConfigError> for LintError {
    fn from(error: ConfigError) -> Self {
        Self::Config(error)
    }
}

/// Why the type-aware lane produced no diagnostics.
#[derive(Debug)]
pub enum TypeLintError {
    /// The session was not built through [`LintEngine::new_type_aware`].
    NotOptedIn,
    /// The request's fix mode does not match the mode the session was compiled with.
    FixModeMismatch,
    /// Locating, verifying, or speaking protocol v2 to tsgolint failed.
    Tsgolint(TsgolintError),
    /// Canonical OXC's own type-aware helper failed. Holds its wording verbatim.
    Upstream { detail: String },
}

impl fmt::Display for TypeLintError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotOptedIn => {
                formatter.write_str("type-aware linting requires the explicit opt-in")
            }
            Self::FixModeMismatch => formatter.write_str(
                "type-aware lint request fix mode differs from the compiled lint session",
            ),
            Self::Tsgolint(error) => error.fmt(formatter),
            Self::Upstream { detail } => formatter.write_str(detail),
        }
    }
}

impl Error for TypeLintError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Tsgolint(error) => Some(error),
            _ => None,
        }
    }
}

impl From<TsgolintError> for TypeLintError {
    fn from(error: TsgolintError) -> Self {
        Self::Tsgolint(error)
    }
}

#[derive(Debug)]
pub struct LintRequest<'a> {
    pub path: &'a Path,
    pub original_source: &'a str,
    pub parse_source: &'a str,
    pub source_kind: SourceKind,
    pub rules: &'a [String],
    pub collect_fixes: bool,
    pub dynamic_tags: Option<DynamicTagContract<'a>>,
}

#[derive(Debug)]
pub struct LintResult {
    pub diagnostics: Vec<EngineDiagnostic>,
    pub timings: EngineTimings,
    pub parse_count: u32,
    pub disable_directives: Option<DisableDirectives>,
}

#[derive(Debug)]
pub struct TypeLintRequest<'a> {
    pub virtual_path: &'a Path,
    pub projected_source: &'a str,
    pub collect_fixes: bool,
    pub disable_directives: Option<DisableDirectives>,
}

#[derive(Debug)]
pub struct TypeLintResult {
    pub diagnostics: Vec<EngineDiagnostic>,
    pub elapsed_ns: u64,
    pub process_count: u32,
}

#[derive(Debug)]
pub struct TypeBatchFile<'a> {
    pub authored_path: &'a Path,
    pub virtual_path: &'a Path,
    pub projected_source: &'a str,
    pub disable_directives: Option<&'a DisableDirectives>,
}

#[derive(Debug)]
pub struct TypeBatchDiagnostic {
    pub virtual_path: Option<PathBuf>,
    pub diagnostic: EngineDiagnostic,
}

#[derive(Debug)]
pub struct TypeBatchResult {
    pub diagnostics: Vec<TypeBatchDiagnostic>,
    pub elapsed_ns: u64,
    pub process_count: u32,
}

/// Runs canonical OXC parsing, semantic analysis, and selected built-in lint rules.
///
/// # Errors
///
/// Returns [`LintError`] when parsing, semantic construction, rule selection, or linter
/// configuration fails. No partial diagnostic set or edit is returned on those failures.
pub fn lint(request: &LintRequest<'_>) -> Result<LintResult, LintError> {
    let filters = request
        .rules
        .iter()
        .map(|name| RuleFilter { severity: RuleSeverity::Deny, name: name.clone() })
        .collect::<Vec<_>>();
    let engine = LintEngine::new(&LintEngineOptions {
        cwd: request.path.parent().unwrap_or_else(|| Path::new(".")),
        config_path: None,
        config_base: None,
        filters: &filters,
        collect_fixes: request.collect_fixes,
    })?;
    engine.lint(request)
}

impl LintEngine {
    /// Run the already-compiled configuration over one legal JS/TSX source buffer.
    ///
    /// # Errors
    ///
    /// Returns [`LintError`] for parser, semantic, dynamic-tag, or fix-mode mismatches.
    pub fn lint(&self, request: &LintRequest<'_>) -> Result<LintResult, LintError> {
        if request.collect_fixes != self.collect_fixes {
            return Err(LintError::FixModeMismatch);
        }
        let allocator = Allocator::default();
        let source_type = request.source_kind.source_type();

        let started = Instant::now();
        let mut parsed = Parser::new(&allocator, request.parse_source, source_type).parse();
        if !parsed.diagnostics.is_empty() {
            let detail =
                parsed.diagnostics.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ");
            let diagnostics = parsed.diagnostics.iter().map(map_oxc_diagnostic).collect();
            return Err(LintError::Parse { detail, diagnostics });
        }
        validate_dynamic_tags(&parsed.program, request.dynamic_tags)?;
        let parse_ns = elapsed_ns(started);

        // AST spans address the legal TSX projection. Expanded framework projections are mapped back
        // by the TSRX adapter after linting, so source-sensitive rules must inspect this same buffer.
        parsed.program.source_text = request.parse_source;

        let started = Instant::now();
        let semantic_return = SemanticBuilder::new_linter().build(&parsed.program);
        let semantic_ns = elapsed_ns(started);
        if !semantic_return.diagnostics.is_empty() {
            let detail = semantic_return
                .diagnostics
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; ");
            let diagnostics = semantic_return.diagnostics.iter().map(map_oxc_diagnostic).collect();
            return Err(LintError::Semantic { detail, diagnostics });
        }
        let semantic = semantic_return.semantic;

        let started = Instant::now();
        let module_record =
            Arc::new(ModuleRecord::new(request.path, &parsed.module_record, &semantic));
        let mut context_options = ContextSubHostOptions::default();
        context_options.respect_eslint_disable_directives =
            self.config_store.respect_eslint_disable_directives();
        let context_sub_hosts =
            vec![ContextSubHost::new(semantic, module_record, 0, context_options)];
        let (messages, disable_directives) = if self.type_aware_enabled() {
            self.linter.run_with_disable_directives::<false>(
                request.path,
                context_sub_hosts,
                &allocator,
                None,
                None,
            )
        } else {
            (self.linter.run(request.path, context_sub_hosts, &allocator), None)
        };
        let lint_ns = elapsed_ns(started);

        let diagnostics = messages.iter().map(map_message).collect();

        Ok(LintResult {
            diagnostics,
            timings: EngineTimings { parse_ns, semantic_ns, lint_ns },
            parse_count: 1,
            disable_directives,
        })
    }

    /// Runs the official public TypeScript-Go source-override seam for one in-memory projection.
    ///
    /// # Errors
    ///
    /// Returns [`TypeLintError`] when the opt-in is disabled, the supported executable is missing,
    /// projected source cannot be read, or tsgolint fails. No generated file is written.
    pub fn lint_types(
        &self,
        request: TypeLintRequest<'_>,
    ) -> Result<TypeLintResult, TypeLintError> {
        if !self.type_aware_enabled() {
            return Err(TypeLintError::NotOptedIn);
        }
        if request.collect_fixes != self.collect_fixes {
            return Err(TypeLintError::FixModeMismatch);
        }
        let started = Instant::now();
        let state = TsGoLintState::try_new(
            &self.cwd,
            self.config_store.clone(),
            if request.collect_fixes { FixKind::SafeFix } else { FixKind::None },
        )
        .map_err(|detail| TypeLintError::Upstream { detail })?
        .with_silent(true)
        .with_type_check(self.type_check_enabled());
        let file_system =
            ProjectedFileSystem { path: request.virtual_path, source: request.projected_source };
        let mut directives = FxHashMap::default();
        if let Some(disable_directives) = request.disable_directives {
            directives.insert(request.virtual_path.to_path_buf(), disable_directives);
        }
        let paths: Vec<Arc<OsStr>> = vec![Arc::from(request.virtual_path.as_os_str())];
        let messages = state
            .lint_source(&paths, &file_system, Arc::new(Mutex::new(directives)))
            .map_err(|detail| TypeLintError::Upstream { detail })?;
        Ok(TypeLintResult {
            diagnostics: messages.iter().map(map_message).collect(),
            elapsed_ns: elapsed_ns(started),
            process_count: 1,
        })
    }

    /// Runs one documented tsgolint protocol-v2 batch while preserving each virtual file path.
    ///
    /// OXC's public single-source helper converts diagnostics to `Message` and drops `file_path`.
    /// The documented headless stream is therefore required for a correct multi-file project
    /// batch. Rules are resolved against each authored path before its `.tsrx.tsx` virtual name is
    /// sent, so user overrides retain their original meaning.
    ///
    /// # Errors
    ///
    /// Returns [`TypeLintError`] for a missing executable, invalid rule serialization, protocol
    /// corruption, or a failed tsgolint process. Sources are transferred only through stdin.
    pub fn lint_type_batch(
        &self,
        files: &[TypeBatchFile<'_>],
        collect_fixes: bool,
    ) -> Result<TypeBatchResult, TypeLintError> {
        if !self.type_aware_enabled() {
            return Err(TypeLintError::NotOptedIn);
        }
        if collect_fixes != self.collect_fixes {
            return Err(TypeLintError::FixModeMismatch);
        }
        let started = Instant::now();
        let prepared = prepare_type_batch(self, files)?;
        if prepared.payload.configs.is_empty() {
            return Ok(TypeBatchResult {
                diagnostics: Vec::new(),
                elapsed_ns: elapsed_ns(started),
                process_count: 0,
            });
        }
        let executable = find_tsgolint_executable(&self.cwd)?;
        verify_tsgolint_version(&executable)?;
        let diagnostics = run_type_protocol(&executable, collect_fixes, &prepared)?;
        Ok(TypeBatchResult { diagnostics, elapsed_ns: elapsed_ns(started), process_count: 1 })
    }
}

struct ProjectedFileSystem<'a> {
    path: &'a Path,
    source: &'a str,
}

impl RuntimeFileSystem for ProjectedFileSystem<'_> {
    fn read_to_arena_str<'a>(
        &self,
        path: &Path,
        allocator: &'a Allocator,
    ) -> Result<&'a str, io::Error> {
        if path == self.path {
            Ok(allocator.alloc_str(self.source))
        } else {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("no in-memory TSRX projection for {}", path.display()),
            ))
        }
    }

    fn write_file(&self, path: &Path, _content: &str) -> Result<(), io::Error> {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("type-aware source overrides are read-only: {}", path.display()),
        ))
    }
}

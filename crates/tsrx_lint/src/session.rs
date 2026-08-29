//! The batch boundary: one compiled configuration reused across every file, and the type-aware
//! lane that has to see the whole batch at once.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use oxc_adapter::{EngineDiagnostic, LintEngine, LintEngineOptions, RuleFilter, TypeBatchFile};
use tsrx_syntax::TypeProjection;

use crate::{
    error::LintError,
    fixes::collect_editor_fixes,
    pipeline::{
        PendingBatchFile, finish_lint, lint_loaded_file, lint_loaded_source, run_syntax_lint,
        run_type_lint, virtual_type_path,
    },
    report::{EditorFix, Output, aggregate_outputs, projection_failure_output},
    translate::{translate_diagnostics, translate_type_diagnostics},
};

/// One compiled configuration reused across every file in a lint command/editor batch.
pub struct LintSession {
    pub(crate) engine: LintEngine,
    pub(crate) fix: bool,
}

impl LintSession {
    /// Discover or explicitly load one JSON/JSONC Oxlint configuration.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid or unsupported configuration before any source is parsed.
    pub fn new(
        cwd: &Path,
        config_path: Option<&Path>,
        filters: &[RuleFilter],
        fix: bool,
    ) -> Result<Self, LintError> {
        Self::new_with_config_base(cwd, config_path, None, filters, fix)
    }

    /// Load a materialized config while preserving the directory in which it was authored.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid base or any invalid/unsupported lint configuration.
    pub fn new_with_config_base(
        cwd: &Path,
        config_path: Option<&Path>,
        config_base: Option<&Path>,
        filters: &[RuleFilter],
        fix: bool,
    ) -> Result<Self, LintError> {
        Self::new_with_capabilities(cwd, config_path, config_base, filters, fix, false, false)
    }

    /// Build a session with the explicitly opted-in TypeScript-Go lane.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid configuration. Missing tsgolint is reported on the first lint
    /// operation so session construction remains side-effect free.
    pub fn new_type_aware_with_config_base(
        cwd: &Path,
        config_path: Option<&Path>,
        config_base: Option<&Path>,
        filters: &[RuleFilter],
        fix: bool,
        type_check: bool,
    ) -> Result<Self, LintError> {
        Self::new_with_capabilities(cwd, config_path, config_base, filters, fix, true, type_check)
    }

    /// Build a session from an in-memory JSON Oxlint configuration without
    /// reading the filesystem (used by the WebAssembly playground).
    ///
    /// # Errors
    ///
    /// Returns an error for invalid or unsupported configuration.
    pub fn new_with_config_source(
        cwd: &Path,
        config_source: Option<&str>,
        filters: &[RuleFilter],
        fix: bool,
    ) -> Result<Self, LintError> {
        let engine = LintEngine::new_from_config_source(cwd, config_source, filters, fix)?;
        Ok(Self { engine, fix })
    }

    fn new_with_capabilities(
        cwd: &Path,
        config_path: Option<&Path>,
        config_base: Option<&Path>,
        filters: &[RuleFilter],
        fix: bool,
        type_aware: bool,
        type_check: bool,
    ) -> Result<Self, LintError> {
        let options =
            LintEngineOptions { cwd, config_path, config_base, filters, collect_fixes: fix };
        let engine = if type_aware {
            LintEngine::new_type_aware(&options, type_check)?
        } else {
            LintEngine::new(&options)?
        };
        Ok(Self { engine, fix })
    }

    #[must_use]
    pub fn should_ignore(&self, path: &Path) -> bool {
        self.engine.should_ignore(path)
    }

    #[must_use]
    pub fn deny_warnings(&self) -> bool {
        self.engine.deny_warnings()
    }

    #[must_use]
    pub fn max_warnings(&self) -> Option<usize> {
        self.engine.max_warnings()
    }

    /// Lint one filesystem source with this compiled configuration.
    ///
    /// A TSRX file that cannot be scanned or projected is reported as that file's own error
    /// diagnostic rather than as a command failure, so a syntax error reads like every other
    /// diagnostic and never discards the rest of a batch. Read, parser, semantic, and lint
    /// failures remain errors.
    ///
    /// # Errors
    ///
    /// Returns an error without writing for read, parser, semantic, or lint failures.
    pub fn lint_file(&self, path: &Path) -> Result<Output, LintError> {
        let source =
            fs::read_to_string(path).map_err(|error| LintError::unreadable(path, error))?;
        lint_loaded_file(self, path, &source, true)
    }

    /// Lint a filesystem batch with one shared TypeScript-Go project process when opted in.
    ///
    /// One unprojectable TSRX file contributes its own error diagnostic and the batch continues,
    /// so a single typo cannot blank every other file's report.
    ///
    /// # Errors
    ///
    /// Returns before writing if any source, OXC pass, or type-aware batch fails.
    pub fn lint_files(&self, paths: &[PathBuf]) -> Result<Vec<Output>, LintError> {
        if !self.engine.type_aware_enabled() {
            return paths.iter().map(|path| self.lint_file(path)).collect();
        }
        // Each path keeps its slot so a file that fails projection stays in argument order
        // alongside the files that reached the shared type-aware batch.
        let mut ordered = Vec::with_capacity(paths.len());
        ordered.resize_with(paths.len(), || None);
        let mut pending = Vec::with_capacity(paths.len());
        for (slot, path) in paths.iter().enumerate() {
            let source =
                fs::read_to_string(path).map_err(|error| LintError::unreadable(path, error))?;
            match run_syntax_lint(self, path, &source) {
                Ok((prepared, syntax)) => pending.push(PendingBatchFile {
                    slot,
                    path: path.clone(),
                    source,
                    prepared,
                    syntax,
                }),
                Err(LintError::Projection(error)) => {
                    ordered[slot] = Some(projection_failure_output(self, path, &error));
                }
                Err(error) => return Err(error),
            }
        }
        if pending.is_empty() {
            return Ok(ordered.into_iter().flatten().collect());
        }
        let virtual_paths = pending
            .iter()
            .map(|file| {
                if file.prepared.is_tsrx {
                    virtual_type_path(&file.path)
                } else {
                    file.path.clone()
                }
            })
            .collect::<Vec<_>>();
        let batch_files = pending
            .iter()
            .zip(&virtual_paths)
            .map(|(file, virtual_path)| TypeBatchFile {
                authored_path: &file.path,
                virtual_path,
                projected_source: file
                    .prepared
                    .type_projection
                    .as_ref()
                    .map_or(file.source.as_str(), TypeProjection::source),
                disable_directives: file.syntax.disable_directives.as_ref(),
            })
            .collect::<Vec<_>>();
        let type_result = self.engine.lint_type_batch(&batch_files, self.fix)?;
        let mut by_path = HashMap::<PathBuf, Vec<EngineDiagnostic>>::new();
        let mut global = Vec::new();
        for result in type_result.diagnostics {
            if let Some(path) = result.virtual_path {
                by_path.entry(path).or_default().push(result.diagnostic);
            } else {
                global.push(result.diagnostic);
            }
        }
        for (index, (file, virtual_path)) in pending.into_iter().zip(virtual_paths).enumerate() {
            let mut diagnostics = by_path.remove(&virtual_path).unwrap_or_default();
            if index == 0 {
                diagnostics.append(&mut global);
            }
            let slot = file.slot;
            ordered[slot] = Some(finish_lint(
                self,
                &file.path,
                &file.source,
                file.prepared,
                file.syntax,
                diagnostics,
                true,
                if index == 0 { type_result.elapsed_ns } else { 0 },
                if index == 0 { type_result.process_count } else { 0 },
            )?);
        }
        Ok(ordered.into_iter().flatten().collect())
    }

    /// Lint caller-owned source with this compiled configuration and no filesystem writes.
    ///
    /// Unlike [`LintSession::lint_file`], a projection failure stays an error here. The editor
    /// boundary in `oxc_tsrx_cli::lsp` renders it as its own LSP diagnostic and must keep
    /// receiving it as an error.
    ///
    /// # Errors
    ///
    /// Returns an error when this session was created with fixes enabled or linting fails.
    pub fn lint_text(&self, path: &Path, source: &str) -> Result<Output, LintError> {
        if self.fix {
            return Err(LintError::TextLintWithFixes);
        }
        lint_loaded_source(self, path, source, false)
    }

    /// Collect safe, mapped, validation-passed edits for an in-memory editor document.
    ///
    /// This method never writes the document. The session must have been constructed with
    /// `fix = true` so canonical OXC and tsgolint retain their fix payloads. Every returned edit
    /// belongs to one authored affine range and has survived the same TSRX validation reparse as
    /// a filesystem fix.
    ///
    /// # Errors
    ///
    /// Returns an error when fix collection was not enabled or linting cannot complete.
    pub fn code_actions(&self, path: &Path, source: &str) -> Result<Vec<EditorFix>, LintError> {
        if !self.fix {
            return Err(LintError::CodeActionsWithoutFixes);
        }
        let (prepared, syntax) = run_syntax_lint(self, path, source)?;
        let (type_diagnostics, _, _) = run_type_lint(self, path, source, &prepared, &syntax)?;
        let mut translated =
            translate_diagnostics(syntax.diagnostics, prepared.projection.as_ref());
        let mut type_translated =
            translate_type_diagnostics(type_diagnostics, prepared.type_projection.as_ref());
        translated.diagnostics.append(&mut type_translated.diagnostics);
        Ok(collect_editor_fixes(self, path, source, &prepared, &translated.diagnostics))
    }

    /// Combine file results without recompiling configuration or hiding per-file work.
    #[must_use]
    pub fn aggregate(&self, outputs: Vec<Output>) -> Output {
        aggregate_outputs(self, outputs)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use oxc_adapter::{RuleFilter, RuleSeverity};

    use super::LintSession;

    #[test]
    fn editor_actions_are_identity_mapped_validated_and_do_not_write() {
        let source = "function View() @{ var value = 1; <p>{value}</p>; }";
        let path = Path::new("editor-action.tsrx");
        let session = LintSession::new(
            Path::new("."),
            None,
            &[RuleFilter { severity: RuleSeverity::Deny, name: "no-var".to_string() }],
            true,
        )
        .unwrap();
        let actions = session.code_actions(path, source).unwrap();
        assert_eq!(actions.len(), 1);
        let action = &actions[0];
        assert_eq!(action.rule, "no-var");
        let mut fixed = source.to_string();
        fixed.replace_range(
            action.offset as usize..(action.offset + action.length) as usize,
            &action.replacement,
        );
        assert!(!fixed.contains("var value"));
        assert!(fixed.contains("let value") || fixed.contains("const value"));
        assert!(!path.exists());
    }

    #[test]
    fn in_memory_config_applies_without_a_config_file() {
        let source = "export function View() @{ console.log('browser'); <p>ok</p>; }";
        let path = Path::new("browser-demo.tsrx");
        let session = LintSession::new_with_config_source(
            Path::new("/demo"),
            Some(r#"{ "rules": { "no-console": "error" } }"#),
            &[],
            false,
        )
        .unwrap();
        let output = session.lint_text(path, source).unwrap();
        assert!(output.diagnostics.iter().any(|diagnostic| diagnostic.rule == "no-console"));
        assert!(!path.exists());
    }

    #[test]
    fn parser_only_scaffolds_remain_lintable_and_map_authored_diagnostics() {
        let source = concat!(
            "export function View(props: Props) @{\n",
            "  const title = @{ console.log(props.name); props.name };\n",
            "  const &{ value = 1, ...rest } = props;\n",
            "  &[first, ...tail] = props.items;\n",
            "  <main {title}>@{ debugger; <p>{value}{rest.label}{first}{tail.length}</p> }</main>\n",
            "}\n",
        );
        let session = LintSession::new(
            Path::new("."),
            None,
            &[
                RuleFilter { severity: RuleSeverity::Deny, name: "no-console".to_string() },
                RuleFilter { severity: RuleSeverity::Deny, name: "no-debugger".to_string() },
            ],
            false,
        )
        .unwrap();
        let output = session.lint_text(Path::new("parser-scaffolds.tsrx"), source).unwrap();
        for (rule, needle) in [("no-console", "console.log"), ("no-debugger", "debugger")] {
            let diagnostic = output
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.rule == rule)
                .unwrap_or_else(|| panic!("missing {rule}: {:?}", output.diagnostics));
            assert!(
                diagnostic
                    .labels
                    .iter()
                    .any(|label| label.span.offset as usize == source.find(needle).unwrap()),
                "{diagnostic:?}"
            );
        }
    }

    #[test]
    fn one_unprojectable_file_keeps_the_rest_of_the_batch_reporting() {
        let directory = std::env::temp_dir().join("oxc-tsrx-lint-batch-continues");
        std::fs::create_dir_all(&directory).expect("temp directory");
        let good_source = "export function Good() @{\n  var legacy = 1;\n  <div>hi</div>\n}\n";
        let broken_source =
            "export function Broken() @{\n  let x = 1;\n  <main>\n    <h1>hi</h1>\n}\n";
        let good = directory.join("Good.tsrx");
        let broken = directory.join("Broken.tsrx");
        std::fs::write(&good, good_source).expect("write");
        std::fs::write(&broken, broken_source).expect("write");

        let session = LintSession::new(
            &directory,
            None,
            // A warning, so the one error in the aggregate below can only be the syntax error.
            &[RuleFilter { severity: RuleSeverity::Warn, name: "no-var".to_string() }],
            false,
        )
        .unwrap();
        let outputs = session
            .lint_files(&[good, broken.clone()])
            .expect("an unprojectable file must not fail the batch");

        assert_eq!(outputs.len(), 2);
        // The good file still reports, which is the whole point: before this, the first failing
        // file short-circuited the collect and discarded every other file's diagnostics.
        assert!(
            outputs[0]
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.rule == "no-var" && diagnostic.severity == "warning"),
            "{:?}",
            outputs[0].diagnostics
        );

        let failure = &outputs[1].diagnostics;
        assert_eq!(failure.len(), 1);
        assert_eq!(failure[0].filename, broken.to_string_lossy());
        assert_eq!(failure[0].severity, "error");
        assert!(failure[0].message.contains("unterminated"), "{failure:?}");
        // No rule and no code: there is nothing to disable, and the default renderer omits the
        // code slot for a diagnostic that carries none, matching canonical Oxlint's parse errors.
        assert_eq!(failure[0].rule, "");
        assert_eq!(failure[0].code, "");
        assert_eq!(
            failure[0].labels[0].span.offset as usize,
            broken_source.find("<main>").expect("fixture")
        );

        // The aggregate the CLI exits on now counts the syntax error as one error.
        let aggregated = session.aggregate(outputs);
        assert_eq!(
            aggregated
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == "error")
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn lint_text_still_fails_a_projection_error_for_the_editor() {
        let session = LintSession::new(Path::new("."), None, &[], false).unwrap();
        let error = session
            .lint_text(Path::new("Broken.tsrx"), "export function Broken() @{\n  <main>\n}\n")
            .expect_err("the LSP boundary must keep receiving projection failures as errors")
            .to_string();
        assert!(error.contains("unterminated"), "{error}");
    }

    #[test]
    fn in_memory_config_rejects_invalid_json() {
        let error =
            LintSession::new_with_config_source(Path::new("/demo"), Some("{ not-json"), &[], false)
                .err()
                .expect("invalid JSON must fail before linting")
                .to_string();
        assert!(!error.is_empty());
    }
}

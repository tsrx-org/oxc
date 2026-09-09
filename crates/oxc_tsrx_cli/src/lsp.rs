//! The `oxc-tsrx-lsp` language server. Selected by `argv[0]` or the `lsp`
//! subcommand.

use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitCode, Stdio},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use oxc_adapter::{
    JsPluginFreeLintConfig, LintError as EngineLintError,
    editor::{
        EditorActionKind, EditorCodeAction, EditorCodeActionRequest, EditorDiagnostic,
        EditorDocument, EditorDocumentEdit, EditorRange, EditorSeverity, EditorTextEdit,
        EditorTool, EditorToolFactory, EditorWorkspace, run_editor_server,
    },
    lint_config_without_js_plugins,
};
use serde_json::{Value, json};
use tsrx_format::FormatSession;
use tsrx_lint::{ConfigRuleFilter, LintError, LintSession, PluginLabel, PluginProjection};

#[expect(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "oxc-tsrx-lsp's version banner and errors are the CLI's contract"
)]
pub fn run_cli(arguments: &[String]) -> ExitCode {
    if arguments.iter().any(|argument| matches!(argument.as_str(), "-V" | "--version")) {
        println!("oxc-tsrx-lsp {} (OXC {})", env!("CARGO_PKG_VERSION"), oxc_adapter::OXC_REVISION);
        return ExitCode::SUCCESS;
    }
    if arguments.iter().any(|argument| matches!(argument.as_str(), "-h" | "--help")) {
        println!(
            "OXC for TSRX language server\n\nUsage: oxc-tsrx-lsp\n       oxc-tsrx-lsp --version"
        );
        return ExitCode::SUCCESS;
    }
    if let Some(argument) = arguments.iter().find(|argument| argument.as_str() != "--stdio") {
        eprintln!("oxc-tsrx-lsp: unsupported option: {argument}");
        return ExitCode::from(2);
    }
    match run_editor_server("OXC for TSRX", env!("CARGO_PKG_VERSION"), Arc::new(TsrxEditorFactory))
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("oxc-tsrx-lsp: {error}");
            ExitCode::from(2)
        }
    }
}

struct TsrxEditorFactory;

impl EditorToolFactory for TsrxEditorFactory {
    #[expect(
        clippy::print_stderr,
        reason = "the transport has nowhere to carry a workspace-construction failure, so stderr is the server log the client surfaces; both messages are also published as diagnostics"
    )]
    fn create(
        &self,
        workspace: &EditorWorkspace,
        options: &Value,
    ) -> Result<Box<dyn EditorTool>, String> {
        let root = workspace
            .root_path
            .clone()
            .or_else(|| env::current_dir().ok())
            .ok_or("editor workspace has no filesystem root")?;
        let lint_config = option_path(&root, options, "lintConfigPath");
        let format_config = option_path(&root, options, "formatConfigPath");
        let type_check = option_bool(options, "typeCheck");
        let type_aware = option_bool(options, "typeAware") || type_check;
        let format = FormatSession::new(&root, format_config.as_deref())?;
        // A lint session that cannot be built is a state the user has to be able to see.
        // Returning it as an error here loses it: the transport has nowhere to put a
        // workspace-construction failure, so the editor shows an empty file with no
        // diagnostics, no message, and nothing in the log. Keep the tool, remember why
        // linting is unavailable, and report it on every `.tsrx` file that is opened.
        match build_lint_sessions(&root, lint_config.as_deref(), type_aware, type_check) {
            Ok(sessions) => {
                // `build_lint_sessions` stripped a `jsPlugins` declaration exactly when this
                // project has one and has not opted out, which is the same condition that
                // decides whether a user's own rules should be running on `.tsrx` here.
                let (js_plugins, js_plugins_unavailable) = if sessions.declares_js_plugins {
                    match JsPluginLane::locate(&root) {
                        Ok(lane) => (Some(lane), None),
                        Err(reason) => {
                            eprintln!(
                                "oxc-tsrx-lsp: this project's Oxlint JS plugins cannot run on .tsrx: {reason}"
                            );
                            (None, Some(reason))
                        }
                    }
                } else {
                    (None, None)
                };
                Ok(Box::new(TsrxEditorTool {
                    lint: Some(sessions.lint),
                    actions: Some(sessions.actions),
                    format,
                    unavailable: None,
                    js_plugins,
                    js_plugins_unavailable,
                    _staged_config: sessions.staged_config,
                }))
            }
            Err(error) => {
                // Also on stderr, which clients surface as the server's output log.
                eprintln!("oxc-tsrx-lsp: TSRX linting is unavailable: {error}");
                Ok(Box::new(TsrxEditorTool {
                    lint: None,
                    actions: None,
                    format,
                    unavailable: Some(error),
                    js_plugins: None,
                    js_plugins_unavailable: None,
                    _staged_config: None,
                }))
            }
        }
    }

    fn watcher_patterns(&self, _workspace: &EditorWorkspace, options: &Value) -> Vec<String> {
        let mut patterns = vec![
            "**/.oxlintrc.json".to_string(),
            "**/.oxlintrc.jsonc".to_string(),
            "**/.oxfmtrc.json".to_string(),
            "**/.oxfmtrc.jsonc".to_string(),
        ];
        for (key, section) in [("lintConfigPath", "lint"), ("formatConfigPath", "format")] {
            if let Some(path) = option_string(options, key, section, "configPath")
                && !path.is_empty()
            {
                patterns.push(path.to_string());
            }
        }
        patterns
    }
}

fn option_bool(options: &Value, key: &str) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn option_path(root: &std::path::Path, options: &Value, key: &str) -> Option<PathBuf> {
    let section = if key == "lintConfigPath" { "lint" } else { "format" };
    let path =
        option_string(options, key, section, "configPath").filter(|path| !path.is_empty())?;
    let path = PathBuf::from(path);
    Some(if path.is_absolute() { path } else { root.join(path) })
}

fn option_string<'a>(
    options: &'a Value,
    flat: &str,
    section: &str,
    nested: &str,
) -> Option<&'a str> {
    options.get(flat).and_then(Value::as_str).or_else(|| {
        options.get(section).and_then(|value| value.get(nested)).and_then(Value::as_str)
    })
}

/// A stripped Oxlint configuration written to a throwaway directory, removed with the
/// workspace tool that owns it.
struct StagedConfig {
    directory: PathBuf,
    path: PathBuf,
    base: PathBuf,
}

impl StagedConfig {
    fn write(stripped: &JsPluginFreeLintConfig) -> Result<Self, String> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos =
            SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());
        let directory = env::temp_dir().join(format!(
            "oxc-tsrx-lsp-config-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&directory).map_err(|error| {
            format!(
                "unable to stage a JS-plugin-free Oxlint config in {}: {error}",
                directory.display()
            )
        })?;
        let path = directory.join(".oxlintrc.json");
        fs::write(&path, &stripped.json).map_err(|error| {
            format!("unable to stage a JS-plugin-free Oxlint config at {}: {error}", path.display())
        })?;
        Ok(Self { directory, path, base: stripped.base.clone() })
    }
}

impl Drop for StagedConfig {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

struct LintSessions {
    lint: LintSession,
    actions: LintSession,
    staged_config: Option<StagedConfig>,
    /// Whether the configuration this workspace loaded declares JavaScript plugins that
    /// were stripped before the native engine, and therefore still have to be run.
    declares_js_plugins: bool,
}

/// Build the diagnostics and quick-fix sessions this workspace lints with.
///
/// A project's `jsPlugins` are hosted by the `oxlint` command OXC for TSRX installs,
/// over each `.tsrx` file's TSX projection. The native engine refuses a configuration
/// that still declares them, so the command line strips them before handing the config
/// down. This is the same strip on the editor path: without it, adding one JavaScript
/// plugin to `.oxlintrc.json` takes away every diagnostic on every `.tsrx` file,
/// including the native Rust ones that have nothing to do with plugins.
///
/// The stripped copy is written to a temporary directory and handed over with the
/// directory the original was authored in as its config base, so relative `extends`,
/// `overrides` globs and `ignorePatterns` still resolve exactly where they did.
fn build_lint_sessions(
    root: &Path,
    config: Option<&Path>,
    type_aware: bool,
    type_check: bool,
) -> Result<LintSessions, String> {
    let filters = Vec::<ConfigRuleFilter>::new();
    let staged_config = match lint_config_without_js_plugins(root, config)? {
        Some(stripped) => Some(StagedConfig::write(&stripped)?),
        None => None,
    };
    let declares_js_plugins = staged_config.is_some();
    let (config_path, config_base) = match &staged_config {
        Some(staged) => (Some(staged.path.as_path()), Some(staged.base.as_path())),
        None => (config, None),
    };
    Ok(LintSessions {
        declares_js_plugins,
        lint: build_lint_session(
            root,
            config_path,
            config_base,
            &filters,
            false,
            type_aware,
            type_check,
        )?,
        actions: build_lint_session(
            root,
            config_path,
            config_base,
            &filters,
            true,
            type_aware,
            type_check,
        )?,
        staged_config,
    })
}

fn build_lint_session(
    root: &Path,
    config: Option<&Path>,
    config_base: Option<&Path>,
    filters: &[ConfigRuleFilter],
    fix: bool,
    type_aware: bool,
    type_check: bool,
) -> Result<LintSession, LintError> {
    if type_aware {
        LintSession::new_type_aware_with_config_base(
            root,
            config,
            config_base,
            filters,
            fix,
            type_check,
        )
    } else {
        LintSession::new_with_config_base(root, config, config_base, filters, fix)
    }
}

struct TsrxEditorTool {
    lint: Option<LintSession>,
    actions: Option<LintSession>,
    format: FormatSession,
    /// Why linting is unavailable in this workspace, when it is.
    unavailable: Option<String>,
    /// The project's own Oxlint JavaScript plugins, hosted for this session.
    js_plugins: Option<JsPluginLane>,
    /// Why this project's JavaScript plugins cannot run here, when they cannot.
    js_plugins_unavailable: Option<String>,
    /// Held so the staged configuration outlives the sessions compiled from it and is
    /// removed with them.
    _staged_config: Option<StagedConfig>,
}

impl TsrxEditorTool {
    fn source<'a>(document: &'a EditorDocument<'_>) -> Result<(PathBuf, &'a str), String> {
        let path =
            document.path.ok_or_else(|| format!("editor URI is not a file: {}", document.uri))?;
        if path.extension().is_none_or(|extension| extension != "tsrx") {
            return Err(format!("editor document is not TSRX: {}", path.display()));
        }
        let source = document
            .source
            .ok_or_else(|| format!("editor document has no in-memory source: {}", document.uri))?;
        Ok((path.to_path_buf(), source))
    }
}

impl EditorTool for TsrxEditorTool {
    fn diagnostics(&self, document: &EditorDocument<'_>) -> Result<Vec<EditorDiagnostic>, String> {
        let (path, source) = Self::source(document)?;
        let Some(lint) = self.lint.as_ref() else {
            // Silence here is the worst answer available: the file looks clean, the
            // native rules that were working a moment ago are gone, and nothing says
            // why. Publish the reason as this file's own diagnostic instead.
            return Ok(vec![unavailable_diagnostic(
                source,
                self.unavailable.as_deref().unwrap_or(
                    "TSRX linting is unavailable for this workspace and no reason was recorded",
                ),
            )]);
        };
        if lint.should_ignore(&path) {
            return Ok(Vec::new());
        }
        let output = match lint.lint_text(&path, source) {
            Ok(output) => output,
            Err(error) => return Ok(vec![parse_error_diagnostic(source, &error)]),
        };
        let mut diagnostics = output
            .diagnostics
            .into_iter()
            .filter_map(|diagnostic| {
                let primary = diagnostic.labels.first()?;
                let start = primary.span.offset;
                let end = start.saturating_add(primary.span.length);
                Some(EditorDiagnostic {
                    range: EditorRange::new(start, end),
                    severity: if diagnostic.severity == "error" {
                        EditorSeverity::Error
                    } else {
                        EditorSeverity::Warning
                    },
                    code: Some(diagnostic.rule.clone()),
                    source: Some("oxlint-tsrx".to_string()),
                    message: diagnostic.message,
                    related: Vec::new(),
                    data: Some(json!({ "rule": diagnostic.rule, "code": diagnostic.code })),
                })
            })
            .collect::<Vec<_>>();
        // The native rules above are already published whatever happens next. A plugin
        // that throws, a lane that cannot start, or an Oxlint outside the supported range
        // adds one visible diagnostic of its own; none of them can take a Rust rule away.
        if let Some(lane) = self.js_plugins.as_ref() {
            match lane.diagnostics(document.uri, &path, source) {
                Ok(plugin) => {
                    // A rule whose report had no authored position was dropped. Publishing
                    // the count is what keeps a dropped rule from looking like a rule that
                    // found nothing, which is a clean panel hiding a real result.
                    if plugin.unmapped > 0 {
                        diagnostics.push(js_plugin_unmapped_diagnostic(source, plugin.unmapped));
                    }
                    diagnostics.extend(plugin.diagnostics);
                }
                Err(reason) => diagnostics.push(js_plugin_lane_diagnostic(source, &reason)),
            }
        } else if let Some(reason) = self.js_plugins_unavailable.as_deref() {
            diagnostics.push(js_plugin_lane_diagnostic(source, reason));
        }
        Ok(diagnostics)
    }

    fn format(&self, document: &EditorDocument<'_>) -> Result<Vec<EditorTextEdit>, String> {
        let (path, source) = Self::source(document)?;
        if self.format.should_ignore(&path) {
            return Ok(Vec::new());
        }
        let output = self.format.format_text(&path, source)?;
        if !output.changed {
            return Ok(Vec::new());
        }
        Ok(vec![EditorTextEdit {
            range: EditorRange::new(
                0,
                u32::try_from(source.len()).map_err(|_| "editor source is too large")?,
            ),
            new_text: output.code,
        }])
    }

    fn code_actions(
        &self,
        request: &EditorCodeActionRequest<'_>,
    ) -> Result<Vec<EditorCodeAction>, String> {
        if !request.only.is_empty()
            && !request.only.iter().any(|kind| kind == "quickfix" || "quickfix".starts_with(kind))
        {
            return Ok(Vec::new());
        }
        let (path, source) = Self::source(&request.document)?;
        // The refusal is already published as a diagnostic; a quick fix cannot repair a
        // configuration, so this stays quiet rather than reporting it a second time.
        let Some(actions) = self.actions.as_ref() else {
            return Ok(Vec::new());
        };
        if actions.should_ignore(&path) {
            return Ok(Vec::new());
        }
        Ok(actions
            .code_actions(&path, source)?
            .into_iter()
            .filter(|fix| {
                ranges_overlap(
                    request.range,
                    EditorRange::new(fix.offset, fix.offset.saturating_add(fix.length)),
                )
            })
            .map(|fix| EditorCodeAction {
                title: fix.title,
                kind: EditorActionKind::QuickFix,
                is_preferred: true,
                edits: vec![EditorDocumentEdit {
                    uri: request.document.uri.to_string(),
                    edits: vec![EditorTextEdit {
                        range: EditorRange::new(fix.offset, fix.offset.saturating_add(fix.length)),
                        new_text: fix.replacement,
                    }],
                }],
                data: Some(json!({ "rule": fix.rule })),
            })
            .collect())
    }

    fn remove_document(&self, uri: &str) {
        if let Some(lane) = self.js_plugins.as_ref() {
            lane.forget(uri);
        }
    }
}

// ---------------------------------------------------------------------------
// The project's own Oxlint JavaScript plugins, in the editor.
//
// This process can project a `.tsrx` buffer to legal TSX and can move a
// projection byte range back to the range the user wrote, both in-process and
// through exactly the API `oxc-tsrx lint --emit-plugin-projection` and
// `--map-plugin-diagnostics` use for the command line. What it cannot do is
// execute a JavaScript rule: it is a Rust process with no Node runtime.
//
// So the missing half is borrowed rather than rebuilt. One Node host per
// workspace — `packages/toolchain/src/lint-js-plugins.js`, the same file the
// `oxlint` command's lane lives in — is started lazily the first time a `.tsrx`
// file is linted in a project that declares `jsPlugins`. It receives a
// projection, runs the published Oxlint binary over it with the project's own
// configuration, and answers with the diagnostics the project's plugins
// produced, still in projection bytes. This side maps them.
//
// One process per workspace, not per file, and it only exists in a workspace
// that asked for plugins.
// ---------------------------------------------------------------------------

/// How long to wait for the lane host to announce itself.
const LANE_START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for one projection to come back linted.
const LANE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The flag that turns the lane module into the editor's host, mirrored from its
/// exported `LANE_HOST_FLAG`.
const LANE_HOST_FLAG: &str = "--oxc-tsrx-js-plugin-lane-host";
/// Where the lane host lives, relative to a directory that may contain it.
///
/// The `dist/` entries are the current layout and are tried first: the package
/// authors TypeScript in `src/` and ships only the built `dist/`, so a project on
/// the current package always resolves to `dist/`. The `src/` entries are a
/// compatibility fallback, not a second supported layout: this constant is compiled
/// into the native binary, and the native binary and the `oxc-tsrx` JavaScript
/// package are installed as separate packages that can skew by a version. A binary
/// compiled while the package briefly shipped authored `src/` JavaScript would
/// otherwise fail to find a current package's lane host, and a current binary would
/// otherwise fail to find that older package's. Both directions resolve here instead.
const LANE_HOST_PATHS: [&str; 6] = [
    "node_modules/@tsrx/oxc/dist/lint-js-plugins.js",
    "node_modules/@tsrx/oxc/src/lint-js-plugins.js",
    "node_modules/oxc-tsrx/dist/lint-js-plugins.js",
    "node_modules/oxc-tsrx/src/lint-js-plugins.js",
    "packages/toolchain/dist/lint-js-plugins.js",
    "packages/toolchain/src/lint-js-plugins.js",
];

/// One diagnostic the project's plugins produced, still measured in projection bytes.
struct LanePluginDiagnostic {
    code: Option<String>,
    message: String,
    severity: EditorSeverity,
    labels: Vec<PluginLabel>,
}

/// A lane failure that is worth reporting, and whether the host survived it.
enum LaneFailure {
    /// The host is gone or unusable. Every later request fails the same way.
    Fatal(String),
    /// This one request failed. The host is still there.
    Reported(String),
}

impl LaneFailure {
    fn message(&self) -> &str {
        match self {
            Self::Fatal(message) | Self::Reported(message) => message,
        }
    }
}

enum LaneProcess {
    NotStarted,
    Running(Box<LaneChild>),
    Failed(String),
}

/// One file's plugin answer: what reached the editor, and what could not.
#[derive(Clone)]
struct LaneAnswer {
    diagnostics: Vec<EditorDiagnostic>,
    /// Diagnostics whose labels landed on text the projection inserted, so they had no
    /// position in the file the developer wrote. They are dropped, and this is how many,
    /// because a rule that fires on `.tsx` and disappears on `.tsrx` with an empty
    /// Problems panel is the exact failure this lane exists to remove.
    unmapped: usize,
}

/// The project's JavaScript plugin host for one editor workspace.
struct JsPluginLane {
    root: PathBuf,
    node: PathBuf,
    script: PathBuf,
    process: Mutex<LaneProcess>,
    /// The last answer for each open document, keyed by the projection it was computed
    /// from. An editor republishes far more often than it really changes a file, and a
    /// projection that has not moved cannot have new plugin diagnostics.
    cache: RwLock<HashMap<String, (String, LaneAnswer)>>,
}

impl JsPluginLane {
    /// Find the Node runtime and the lane host this workspace should use.
    ///
    /// # Errors
    ///
    /// Returns the reason the lane cannot run, which the caller publishes on every
    /// `.tsrx` file rather than swallowing: a plugin that is configured and silently not
    /// running is the exact failure this lane exists to remove.
    fn locate(root: &Path) -> Result<Self, String> {
        let script = locate_lane_host_script(root).ok_or_else(|| {
            format!(
                "unable to find {}. Install `@tsrx/oxc` in this project, or set OXC_TSRX_JS_PLUGIN_LANE to the file",
                LANE_HOST_PATHS[0]
            )
        })?;
        let node = locate_node().ok_or(
            "unable to find a `node` executable on PATH. A JavaScript plugin needs a Node runtime; set OXC_TSRX_NODE to one",
        )?;
        Ok(Self {
            root: root.to_path_buf(),
            node,
            script,
            process: Mutex::new(LaneProcess::NotStarted),
            cache: RwLock::new(HashMap::new()),
        })
    }

    /// This project's plugin diagnostics for one in-memory buffer, in authored bytes.
    fn diagnostics(&self, uri: &str, path: &Path, source: &str) -> Result<LaneAnswer, String> {
        // A source this process cannot project is a syntax error the native lane already
        // reports against the authored file, and a plugin has nothing to say about it.
        let Ok(projection) = PluginProjection::new(source) else {
            return Ok(LaneAnswer { diagnostics: Vec::new(), unmapped: 0 });
        };
        if let Ok(cache) = self.cache.read()
            && let Some((cached, answer)) = cache.get(uri)
            && cached == projection.source()
        {
            return Ok(answer.clone());
        }

        let reported = match self.request(path, projection.source()) {
            Ok(reported) => reported,
            Err(failure) => return Err(failure.message().to_string()),
        };
        let requested = reported.len();
        let diagnostics = reported
            .into_iter()
            .filter_map(|diagnostic| authored_plugin_diagnostic(&projection, source, diagnostic))
            .collect::<Vec<_>>();
        let answer =
            LaneAnswer { unmapped: requested.saturating_sub(diagnostics.len()), diagnostics };
        if let Ok(mut cache) = self.cache.write() {
            cache.insert(uri.to_string(), (projection.source().to_string(), answer.clone()));
        }
        Ok(answer)
    }

    /// Drop one closed document's cached answer.
    fn forget(&self, uri: &str) {
        if let Ok(mut cache) = self.cache.write() {
            cache.remove(uri);
        }
    }

    fn request(
        &self,
        path: &Path,
        projection: &str,
    ) -> Result<Vec<LanePluginDiagnostic>, LaneFailure> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| LaneFailure::Fatal("the JS plugin lane host is poisoned".to_string()))?;
        if let LaneProcess::Failed(reason) = &*process {
            return Err(LaneFailure::Fatal(reason.clone()));
        }
        if matches!(*process, LaneProcess::NotStarted) {
            match LaneChild::start(&self.node, &self.script, &self.root) {
                Ok(child) => *process = LaneProcess::Running(Box::new(child)),
                Err(reason) => {
                    *process = LaneProcess::Failed(reason.clone());
                    return Err(LaneFailure::Fatal(reason));
                }
            }
        }
        let LaneProcess::Running(child) = &mut *process else {
            return Err(LaneFailure::Fatal("the JS plugin lane host is not running".to_string()));
        };
        match child.lint(path, projection) {
            Ok(diagnostics) => Ok(diagnostics),
            Err(LaneFailure::Reported(message)) => Err(LaneFailure::Reported(message)),
            Err(LaneFailure::Fatal(message)) => {
                // The host is gone. Remember why, so the next keystroke reports the same
                // reason instead of spawning a fresh process that will fail the same way.
                *process = LaneProcess::Failed(message.clone());
                Err(LaneFailure::Fatal(message))
            }
        }
    }
}

/// One running lane host, its request writer, and its answer reader.
struct LaneChild {
    child: Child,
    stdin: ChildStdin,
    answers: Receiver<Option<String>>,
    next_id: u64,
}

impl LaneChild {
    fn start(node: &Path, script: &Path, root: &Path) -> Result<Self, String> {
        let mut child = Command::new(node)
            .arg(script)
            .arg(LANE_HOST_FLAG)
            .arg("--cwd")
            .arg(root)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherited, so the host's disclosure line and any plugin's own output reach
            // the client's server log rather than disappearing.
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                format!("unable to start the JS plugin lane host with {}: {error}", node.display())
            })?;
        let stdin = child.stdin.take().ok_or("the JS plugin lane host has no stdin")?;
        let stdout = child.stdout.take().ok_or("the JS plugin lane host has no stdout")?;
        let (sender, answers) = mpsc::channel();
        // Blocking reads live on their own thread so a wedged host times out here instead
        // of hanging the editor's diagnostics forever.
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(Some(line)).is_err() {
                    return;
                }
            }
            let _ = sender.send(None);
        });

        let mut host = Self { child, stdin, answers, next_id: 1 };
        let ready = host
            .read_answer(LANE_START_TIMEOUT)
            .map_err(|failure| failure.message().to_string())?;
        if ready.get("ready").and_then(Value::as_bool) == Some(true) {
            return Ok(host);
        }
        Err(ready
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the JS plugin lane host refused to start")
            .to_string())
    }

    fn lint(
        &mut self,
        path: &Path,
        projection: &str,
    ) -> Result<Vec<LanePluginDiagnostic>, LaneFailure> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({
            "id": id,
            "path": path.to_string_lossy(),
            "projection": projection,
        });
        writeln!(self.stdin, "{request}").and_then(|()| self.stdin.flush()).map_err(|error| {
            LaneFailure::Fatal(format!("the JS plugin lane host stopped reading: {error}"))
        })?;

        loop {
            let answer = self.read_answer(LANE_REQUEST_TIMEOUT)?;
            // A late answer to a request that already timed out is discarded rather than
            // attributed to this file.
            if answer.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = answer.get("error").and_then(Value::as_str) {
                return Err(LaneFailure::Reported(error.to_string()));
            }
            return Ok(answer
                .get("diagnostics")
                .and_then(Value::as_array)
                .map_or_else(Vec::new, |diagnostics| {
                    diagnostics.iter().filter_map(lane_diagnostic).collect()
                }));
        }
    }

    #[expect(
        clippy::needless_pass_by_ref_mut,
        reason = "reading one answer takes it off the channel `lint`'s loop is matching request ids against; exclusive access is what stops two readers pairing an answer with the wrong file"
    )]
    fn read_answer(&mut self, timeout: Duration) -> Result<Value, LaneFailure> {
        let line = match self.answers.recv_timeout(timeout) {
            Ok(Some(line)) => line,
            Ok(None) | Err(RecvTimeoutError::Disconnected) => {
                return Err(LaneFailure::Fatal(
                    "the JS plugin lane host exited; your plugins are not running on .tsrx"
                        .to_string(),
                ));
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err(LaneFailure::Fatal(format!(
                    "the JS plugin lane host did not answer within {} seconds",
                    timeout.as_secs()
                )));
            }
        };
        serde_json::from_str(&line).map_err(|error| {
            LaneFailure::Fatal(format!(
                "the JS plugin lane host wrote something that is not a JSON answer: {error}"
            ))
        })
    }
}

impl Drop for LaneChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn lane_diagnostic(value: &Value) -> Option<LanePluginDiagnostic> {
    let labels = value
        .get("labels")?
        .as_array()?
        .iter()
        .map(|label| {
            Some(PluginLabel {
                offset: u32::try_from(label.get("offset")?.as_u64()?).ok()?,
                length: u32::try_from(label.get("length")?.as_u64().unwrap_or(0)).ok()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    if labels.is_empty() {
        return None;
    }
    Some(LanePluginDiagnostic {
        code: value.get("code").and_then(Value::as_str).map(ToString::to_string),
        message: value.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
        severity: if value.get("severity").and_then(Value::as_str) == Some("error") {
            EditorSeverity::Error
        } else {
            EditorSeverity::Warning
        },
        labels,
    })
}

/// One plugin diagnostic moved from projection bytes to the bytes the user wrote.
///
/// `None` drops it, under the same rule the native lane applies to OXC's own diagnostics:
/// a label that landed on projection-only text has no authored position, and a squiggle
/// on code the developer did not write is worse than no squiggle at all.
fn authored_plugin_diagnostic(
    projection: &PluginProjection,
    source: &str,
    diagnostic: LanePluginDiagnostic,
) -> Option<EditorDiagnostic> {
    // Same mapping the CLI uses, including its whole-file case. A rule that reports on the
    // whole `Program` spans the entire projection, markers and synthetic wrappers included, so
    // an all-or-nothing mapping can never place it inside authored text and it used to vanish
    // here while firing at 1:1 on an ordinary .tsx. Sharing the helper is what keeps the editor
    // and the CLI reporting the same rule at the same place.
    let authored_length = u32::try_from(source.len()).ok()?;
    let mut authored = Vec::with_capacity(diagnostic.labels.len());
    for label in &diagnostic.labels {
        authored.push(crate::lint::map_label(projection, authored_length, *label)?);
    }
    let primary = authored.first()?;
    let start = usize::try_from(primary.offset).ok()?;
    let end = start.checked_add(usize::try_from(primary.length).ok()?)?;
    // The transport rejects a whole publish over one invalid range, which would cost this
    // file its native Rust diagnostics too. Check here instead of trusting the mapping.
    if end > source.len() || !source.is_char_boundary(start) || !source.is_char_boundary(end) {
        return None;
    }
    let rule = diagnostic.code.as_deref().map(|code| {
        code.split_once('(').map_or(code, |(_, rest)| rest.trim_end_matches(')')).to_string()
    });
    Some(EditorDiagnostic {
        range: EditorRange::new(primary.offset, primary.offset.saturating_add(primary.length)),
        severity: diagnostic.severity,
        // Oxlint's own `plugin(rule)` code, verbatim, so the Problems panel names the
        // plugin the developer wrote as well as the rule inside it.
        code: diagnostic.code.clone(),
        source: Some("oxlint-tsrx".to_string()),
        message: diagnostic.message,
        related: Vec::new(),
        data: Some(json!({ "rule": rule, "code": diagnostic.code, "jsPlugin": true })),
    })
}

/// Where the editor's plugin lane host lives, or `None` when it cannot be found.
fn locate_lane_host_script(root: &Path) -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("OXC_TSRX_JS_PLUGIN_LANE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    // The workspace first, because that is where the project's own install is, then this
    // executable, which covers a native package installed beside the toolchain one and a
    // binary run straight out of this repository's `target/`.
    let mut starting_points = vec![root.to_path_buf()];
    if let Ok(executable) = env::current_exe() {
        starting_points.push(executable);
    }
    for start in starting_points {
        for ancestor in start.ancestors() {
            for relative in LANE_HOST_PATHS {
                let candidate = ancestor.join(relative);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// The Node runtime a JavaScript rule needs, or `None` when there is none to be had.
fn locate_node() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("OXC_TSRX_NODE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    let names: &[&str] = if cfg!(windows) { &["node.exe", "node.cmd"] } else { &["node"] };
    for directory in env::split_paths(&env::var_os("PATH")?) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Why this project's JavaScript plugins are not reporting, as a diagnostic.
///
/// Anchored at the first character, next to whatever the native rules found, because the
/// alternative is a file that looks like the developer's rule simply found nothing.
fn js_plugin_lane_diagnostic(source: &str, reason: &str) -> EditorDiagnostic {
    let end = source.chars().next().map_or(0, char::len_utf8);
    EditorDiagnostic {
        range: EditorRange::new(0, u32::try_from(end).unwrap_or(0)),
        severity: EditorSeverity::Warning,
        code: Some("js-plugins-unavailable".to_string()),
        source: Some("oxc-tsrx".to_string()),
        message: format!(
            "OXC for TSRX could not run this project's Oxlint JS plugins on this file: {reason}. The native Rust rules above are unaffected."
        ),
        related: Vec::new(),
        data: Some(json!({ "rule": "js-plugins-unavailable" })),
    }
}

/// What this file's plugin lane found and could not place, as a diagnostic.
///
/// The command line writes the same count to stderr and puts it in
/// `oxcTsrx.jsPluginProjection.unmapped`. An editor has neither, so it gets this instead:
/// one warning beside the rules that did report, in the same place and the same style as
/// `js-plugins-unavailable`. Without it a rule dropped for having no authored position is
/// indistinguishable from a rule that ran and found nothing.
fn js_plugin_unmapped_diagnostic(source: &str, count: usize) -> EditorDiagnostic {
    let end = source.chars().next().map_or(0, char::len_utf8);
    EditorDiagnostic {
        range: EditorRange::new(0, u32::try_from(end).unwrap_or(0)),
        severity: EditorSeverity::Warning,
        code: Some("js-plugins-unmapped".to_string()),
        source: Some("oxc-tsrx".to_string()),
        message: format!(
            "OXC for TSRX dropped {count} of this project's Oxlint JS plugin diagnostic(s) on this file: they landed on text the TSX projection inserted, so they have no position in the source you wrote. The rules that did report are unaffected."
        ),
        related: Vec::new(),
        data: Some(json!({ "rule": "js-plugins-unmapped" })),
    }
}

/// The reason TSRX linting is unavailable, as this file's own diagnostic.
///
/// It is anchored at the first character so an editor has something to underline and
/// the message reaches the Problems panel, the hover, and the client's own log.
fn unavailable_diagnostic(source: &str, reason: &str) -> EditorDiagnostic {
    let end = source.chars().next().map_or(0, char::len_utf8);
    EditorDiagnostic {
        range: EditorRange::new(0, u32::try_from(end).unwrap_or(0)),
        severity: EditorSeverity::Error,
        code: Some("lint-unavailable".to_string()),
        source: Some("oxc-tsrx".to_string()),
        message: format!("OXC for TSRX cannot lint this file: {reason}"),
        related: Vec::new(),
        data: Some(json!({ "rule": "lint-unavailable" })),
    }
}

fn parse_error_diagnostic(source: &str, error: &LintError) -> EditorDiagnostic {
    // Two of the ten variants position themselves in the authored source, and both hand the
    // offset over as a number. The remaining eight describe a whole-file or tool failure, so the
    // diagnostic covers the first character. This match is written out rather than wildcarded so
    // a future positioned variant fails to compile here instead of silently losing its offset.
    let positioned = match error {
        LintError::Projection(error) => error.byte_offset(),
        LintError::Syntax(EngineLintError::DynamicTags(error)) => error.byte_offset(),
        LintError::Unparsed(unparsed) => unparsed
            .diagnostics
            .iter()
            .flat_map(|diagnostic| diagnostic.labels.iter())
            .map(|label| label.offset)
            .next(),
        LintError::UnreadableSource { .. }
        | LintError::UnwritableSource { .. }
        | LintError::TextLintWithFixes
        | LintError::CodeActionsWithoutFixes
        | LintError::SourceKind(_)
        | LintError::Config(_)
        | LintError::Syntax(_)
        | LintError::TypeAware(_) => None,
    };
    // An offset is only usable if it still addresses this document: the editor can hand over a
    // buffer that has moved on since the error was produced. `is_char_boundary` is false past the
    // end, so it rejects a stale offset and a mid-character one in the same call.
    let offset = positioned
        .and_then(|offset| usize::try_from(offset).ok())
        .filter(|offset| source.is_char_boundary(*offset))
        .unwrap_or(0);
    let end =
        source[offset..].chars().next().map_or(offset, |character| offset + character.len_utf8());
    EditorDiagnostic {
        range: EditorRange::new(
            u32::try_from(offset).unwrap_or(0),
            u32::try_from(end).unwrap_or(0),
        ),
        severity: EditorSeverity::Error,
        code: Some("parse-error".to_string()),
        source: Some("oxc-tsrx".to_string()),
        message: error.to_string(),
        related: Vec::new(),
        data: None,
    }
}

#[expect(
    clippy::suspicious_operation_groupings,
    reason = "an empty `left` overlaps when its single position lies inside `right`, so both comparisons are against `left.start` on purpose"
)]
fn ranges_overlap(left: EditorRange, right: EditorRange) -> bool {
    if left.start == left.end {
        return right.start <= left.start && left.start <= right.end;
    }
    left.start < right.end && right.start < left.end
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use oxc_adapter::{DynamicTagError, editor::EditorRange};
    use tsrx_lint::{LintError, LintSession};

    use super::{EngineLintError, parse_error_diagnostic};

    /// The range `parse_error_diagnostic` produced while it read the offset out of the rendered
    /// `Display` text: the last `byte ` anywhere in the whole message, then its digits.
    ///
    /// This is the retired implementation, kept only so the typed accessors can be held against
    /// it. It takes the last match of the marker, which is exactly the position the reverse `str`
    /// search it replaced returned.
    fn scraped_range(source: &str, message: &str) -> EditorRange {
        let marker = "byte ";
        let offset = message
            .rmatch_indices(marker)
            .next()
            .map(|(index, _)| index + marker.len())
            .map(|start| {
                message[start..].chars().take_while(char::is_ascii_digit).collect::<String>()
            })
            .filter(|digits| !digits.is_empty())
            .and_then(|digits| digits.parse::<usize>().ok())
            .filter(|offset| *offset <= source.len() && source.is_char_boundary(*offset))
            .unwrap_or(0);
        let end = source[offset..]
            .chars()
            .next()
            .map_or(offset, |character| offset + character.len_utf8());
        EditorRange::new(u32::try_from(offset).unwrap_or(0), u32::try_from(end).unwrap_or(0))
    }

    fn lint_failure(source: &str) -> LintError {
        LintSession::new_with_config_source(Path::new("/demo"), Some("{}"), &[], false)
            .expect("an in-memory config compiles without reading the filesystem")
            .lint_text(Path::new("View.tsrx"), source)
            .expect_err("the fixture must fail before it produces diagnostics")
    }

    #[test]
    fn the_typed_offset_reproduces_the_display_scrape_it_replaced() {
        // Both positioned variants, each reached through a real lint of a real authored source
        // rather than by hand: an unterminated element fails in projection, and a call expression
        // in a dynamic tag survives projection and fails against the parsed AST. The multi-byte
        // identifier in the first fixture shifts the offset off a code-unit count.
        let unterminated =
            "export function Broken() @{\n  let \u{3c0} = 1;\n  <main>\n    <h1>hi</h1>\n}\n";
        let dynamic_tag = "export function View() @{ <{tag()}>hi</{tag()}> }";
        for (source, reaches_the_syntax_lane) in [(unterminated, false), (dynamic_tag, true)] {
            let error = lint_failure(source);
            // Each fixture must exercise a different arm, or one of the two would go untested.
            assert_eq!(
                matches!(error, LintError::Syntax(EngineLintError::DynamicTags(_))),
                reaches_the_syntax_lane,
                "{source}: {error:?}"
            );
            assert!(
                matches!(
                    error,
                    LintError::Projection(_) | LintError::Syntax(EngineLintError::DynamicTags(_))
                ),
                "{source}: {error:?}"
            );
            let message = error.to_string();
            assert!(message.contains("byte "), "{source}: {message}");
            let diagnostic = parse_error_diagnostic(source, &error);
            assert_eq!(diagnostic.range, scraped_range(source, &message), "{source}: {message}");
            assert_ne!(diagnostic.range.start, 0, "{source}: {message}");
            assert_eq!(diagnostic.message, message);
        }
    }

    #[test]
    fn an_unaddressable_or_positionless_failure_still_lands_on_the_first_character() {
        // A stale offset past the end of the editor's buffer and a variant that never carries one
        // both fall back to the first character, which is what the scrape did too.
        let source = "short";
        let stale =
            LintError::Syntax(EngineLintError::DynamicTags(DynamicTagError::AuthoredGrammar {
                index: 0,
                offset: 4096,
            }));
        for error in [stale, LintError::TextLintWithFixes] {
            let diagnostic = parse_error_diagnostic(source, &error);
            assert_eq!(diagnostic.range, scraped_range(source, &error.to_string()), "{error:?}");
            assert_eq!(diagnostic.range, EditorRange::new(0, 1), "{error:?}");
        }
    }
}

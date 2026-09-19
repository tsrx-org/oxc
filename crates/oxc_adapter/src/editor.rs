//! Stable editor boundary over canonical OXC's language-server transport.
//!
//! Public types in this module deliberately contain no OXC or LSP framework types. A deliberate
//! OXC upgrade can therefore change the private adapter without forcing the TSRX language or
//! editor packages to follow upstream protocol implementation churn.

use std::{
    borrow::Cow,
    collections::HashMap,
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, RwLock},
};

use oxc_language_server::{
    Capabilities, CodeActionParams, DiagnosticMode, DiagnosticResult, TextDocument, Tool,
    ToolBuildResult, ToolBuilder, ToolRestartChanges, WorkerManager, offset_to_position,
    run_server,
};
use serde_json::Value;
use tower_lsp_server::ls_types::{
    CodeAction, CodeActionKind, CodeActionOptions, CodeActionOrCommand,
    CodeActionProviderCapability, CodeActionTriggerKind, Diagnostic as LspDiagnostic,
    DiagnosticRelatedInformation, DiagnosticSeverity, Location, NumberOrString, OneOf, Pattern,
    Range, ServerCapabilities, TextEdit, Uri, WorkDoneProgressOptions, WorkspaceEdit,
};

/// One zero-based editor position. `character` is measured in UTF-16 code units.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EditorPosition {
    pub line: u32,
    pub character: u32,
}

/// One half-open byte range in the caller-owned UTF-8 source.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EditorRange {
    pub start: u32,
    pub end: u32,
}

impl EditorRange {
    #[must_use]
    pub const fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }
}

/// Diagnostic severity independent of the private LSP implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorSeverity {
    Error,
    Warning,
    Information,
    Hint,
}

/// A secondary authored location attached to an editor diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorRelatedDiagnostic {
    pub uri: String,
    pub range: EditorRange,
    pub message: String,
}

/// One diagnostic expressed entirely in authored UTF-8 byte offsets.
#[expect(
    clippy::derive_partial_eq_without_eq,
    reason = "deriving `Eq` would add a public trait impl, and this crate's public surface is frozen"
)]
#[derive(Debug, Clone, PartialEq)]
pub struct EditorDiagnostic {
    pub range: EditorRange,
    pub severity: EditorSeverity,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
    pub related: Vec<EditorRelatedDiagnostic>,
    pub data: Option<Value>,
}

/// One source edit expressed in authored UTF-8 byte offsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorTextEdit {
    pub range: EditorRange,
    pub new_text: String,
}

/// One document's edits within a code action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorDocumentEdit {
    pub uri: String,
    pub edits: Vec<EditorTextEdit>,
}

/// Stable code-action categories exposed by the editor adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorActionKind {
    QuickFix,
}

/// A validated editor action. The adapter never derives edits itself.
#[expect(
    clippy::derive_partial_eq_without_eq,
    reason = "deriving `Eq` would add a public trait impl, and this crate's public surface is frozen"
)]
#[derive(Debug, Clone, PartialEq)]
pub struct EditorCodeAction {
    pub title: String,
    pub kind: EditorActionKind,
    pub is_preferred: bool,
    pub edits: Vec<EditorDocumentEdit>,
    pub data: Option<Value>,
}

/// Why the editor requested code actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorActionTrigger {
    Invoked,
    Automatic,
    Unknown,
}

/// The subset of a client diagnostic useful for filtering code actions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorDiagnosticContext {
    pub range: EditorRange,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
}

/// Caller-owned source and identity passed to native lint or format work.
#[derive(Debug, Clone, Copy)]
pub struct EditorDocument<'a> {
    pub uri: &'a str,
    pub path: Option<&'a Path>,
    pub language_id: &'a str,
    pub source: Option<&'a str>,
}

/// One code-action request with client positions already mapped back to UTF-8 bytes.
#[derive(Debug)]
pub struct EditorCodeActionRequest<'a> {
    pub document: EditorDocument<'a>,
    pub range: EditorRange,
    pub only: Vec<String>,
    pub trigger: EditorActionTrigger,
    pub diagnostics: Vec<EditorDiagnosticContext>,
}

/// Stable workspace identity used when creating one configured native editor tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorWorkspace {
    pub root_uri: String,
    pub root_path: Option<PathBuf>,
}

/// Native lint/format behavior hosted by the canonical OXC language-server transport.
///
/// These methods keep `String` errors on purpose, and they are the only surface in this crate that
/// still does. The message is produced by the downstream implementor, never interpreted here, and
/// handed straight to `oxc_language_server`'s `Tool::run_format` and `DiagnosticResult`, both of
/// which are foreign traits typed `Result<_, String>`. An adapter-owned enum could therefore only
/// be a single `Other(String)` variant plus a conversion at every implementor and at every
/// forwarding site, which is ceremony rather than type safety.
pub trait EditorTool: Send + Sync {
    /// Produce diagnostics for an opened document.
    ///
    /// # Errors
    ///
    /// Returns an error when configured native analysis cannot complete safely.
    fn diagnostics(&self, document: &EditorDocument<'_>) -> Result<Vec<EditorDiagnostic>, String>;

    /// Produce diagnostics after an in-memory source change.
    ///
    /// # Errors
    ///
    /// Returns an error when configured native analysis cannot complete safely.
    fn diagnostics_on_change(
        &self,
        document: &EditorDocument<'_>,
    ) -> Result<Vec<EditorDiagnostic>, String> {
        self.diagnostics(document)
    }

    /// Produce diagnostics after a save notification.
    ///
    /// # Errors
    ///
    /// Returns an error when configured native analysis cannot complete safely.
    fn diagnostics_on_save(
        &self,
        document: &EditorDocument<'_>,
    ) -> Result<Vec<EditorDiagnostic>, String> {
        self.diagnostics(document)
    }

    /// Format caller-owned source without writing it.
    ///
    /// # Errors
    ///
    /// Returns an error when formatting cannot produce a validated authored-source edit.
    fn format(&self, document: &EditorDocument<'_>) -> Result<Vec<EditorTextEdit>, String>;

    /// Return only edits already classified and validated as safe by the native language layer.
    ///
    /// # Errors
    ///
    /// Returns an error when safe actions cannot be computed or validated.
    fn code_actions(
        &self,
        _request: &EditorCodeActionRequest<'_>,
    ) -> Result<Vec<EditorCodeAction>, String> {
        Ok(Vec::new())
    }

    /// Drop any tool-owned state associated with a changed or closed URI.
    fn remove_document(&self, _uri: &str) {}
}

/// Creates one configured native tool per OXC language-server workspace.
///
/// [`Self::create`]'s error is a `String` for the same reason [`EditorTool`]'s are: it is stored
/// verbatim and replayed into the same foreign `Result<_, String>` transport.
pub trait EditorToolFactory: Send + Sync + 'static {
    /// Build a workspace tool from JSON-compatible editor options.
    ///
    /// # Errors
    ///
    /// Returns an error when workspace configuration cannot be compiled safely.
    fn create(
        &self,
        workspace: &EditorWorkspace,
        options: &Value,
    ) -> Result<Box<dyn EditorTool>, String>;

    /// Return configuration paths that should rebuild this workspace tool when changed.
    fn watcher_patterns(&self, _workspace: &EditorWorkspace, _options: &Value) -> Vec<String> {
        Vec::new()
    }

    /// Release factory-owned resources for a removed workspace.
    fn shutdown(&self, _workspace: &EditorWorkspace) {}
}

#[derive(Clone)]
struct CachedDocument {
    path: Option<PathBuf>,
    language_id: String,
    source: Arc<str>,
}

enum NativeTool {
    Ready(Box<dyn EditorTool>),
    Failed(String),
}

struct AdapterTool {
    native: NativeTool,
    watch_patterns: Vec<String>,
    sources: RwLock<HashMap<String, CachedDocument>>,
}

impl AdapterTool {
    fn new(native: Result<Box<dyn EditorTool>, String>, watch_patterns: Vec<String>) -> Self {
        Self {
            native: match native {
                Ok(tool) => NativeTool::Ready(tool),
                Err(error) => NativeTool::Failed(error),
            },
            watch_patterns,
            sources: RwLock::new(HashMap::new()),
        }
    }

    fn native(&self) -> Result<&dyn EditorTool, String> {
        match &self.native {
            NativeTool::Ready(tool) => Ok(tool.as_ref()),
            NativeTool::Failed(error) => Err(error.clone()),
        }
    }

    fn cache_document(&self, document: &TextDocument<'_>) {
        let Some(source) = &document.text else {
            return;
        };
        let cached = CachedDocument {
            path: document.uri.to_file_path().map(Cow::into_owned),
            language_id: document.language_id.as_str().to_string(),
            source: Arc::clone(source),
        };
        self.sources
            .write()
            .expect("editor source cache poisoned")
            .insert(document.uri.as_str().to_string(), cached);
    }

    fn run_diagnostics(
        &self,
        document: &TextDocument<'_>,
        run: impl FnOnce(&dyn EditorTool, &EditorDocument<'_>) -> Result<Vec<EditorDiagnostic>, String>,
    ) -> DiagnosticResult {
        self.cache_document(document);
        let path = document.uri.to_file_path();
        let native_document = EditorDocument {
            uri: document.uri.as_str(),
            path: path.as_deref(),
            language_id: document.language_id.as_str(),
            source: document.text.as_deref(),
        };
        let diagnostics = run(self.native()?, &native_document)?;
        let source = native_document.source.unwrap_or_default();
        let diagnostics = diagnostics
            .into_iter()
            .map(|diagnostic| diagnostic_to_lsp(diagnostic, source, document.uri))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(vec![(document.uri.clone(), diagnostics)])
    }
}

impl Tool for AdapterTool {
    fn handle_configuration_change(
        &self,
        builder: &dyn ToolBuilder,
        root_uri: &Uri,
        old_options_json: &Value,
        new_options_json: Value,
    ) -> ToolRestartChanges {
        if old_options_json == &new_options_json {
            return ToolRestartChanges {
                tool: None,
                watch_patterns: None,
                client_messages: Vec::new(),
            };
        }
        rebuilt_tool(builder, root_uri, new_options_json)
    }

    fn get_watcher_patterns(&self, _options: Value) -> Vec<Pattern> {
        self.watch_patterns.clone()
    }

    fn handle_watched_file_change(
        &self,
        builder: &dyn ToolBuilder,
        _changed_uri: &Uri,
        root_uri: &Uri,
        options: Value,
    ) -> ToolRestartChanges {
        rebuilt_tool(builder, root_uri, options)
    }

    fn get_code_actions_or_commands(&self, params: CodeActionParams) -> Vec<CodeActionOrCommand> {
        let CodeActionParams { uri, range, context, .. } = params;
        let (uri, range, context) = (&uri, &range, &context);
        let Some(cached) =
            self.sources.read().expect("editor source cache poisoned").get(uri.as_str()).cloned()
        else {
            return Vec::new();
        };
        let Some(range) = lsp_range_to_editor(&cached.source, range) else {
            return Vec::new();
        };
        let diagnostics = context
            .diagnostics
            .iter()
            .filter_map(|diagnostic| diagnostic_context(diagnostic, &cached.source))
            .collect();
        let request = EditorCodeActionRequest {
            document: EditorDocument {
                uri: uri.as_str(),
                path: cached.path.as_deref(),
                language_id: &cached.language_id,
                source: Some(cached.source.as_ref()),
            },
            range,
            only: context.only.as_ref().map_or_else(Vec::new, |kinds| {
                kinds.iter().map(|kind| kind.as_str().to_string()).collect()
            }),
            trigger: match context.trigger_kind {
                Some(CodeActionTriggerKind::INVOKED) => EditorActionTrigger::Invoked,
                Some(CodeActionTriggerKind::AUTOMATIC) => EditorActionTrigger::Automatic,
                _ => EditorActionTrigger::Unknown,
            },
            diagnostics,
        };
        let actions =
            self.native().and_then(|native| native.code_actions(&request)).unwrap_or_default();
        let sources = self.sources.read().expect("editor source cache poisoned");
        actions
            .into_iter()
            .filter_map(|action| action_to_lsp(action, &sources))
            .map(CodeActionOrCommand::CodeAction)
            .collect()
    }

    fn run_format(&self, document: TextDocument<'_>) -> Result<Vec<TextEdit>, String> {
        let document = &document;
        self.cache_document(document);
        let path = document.uri.to_file_path();
        let native_document = EditorDocument {
            uri: document.uri.as_str(),
            path: path.as_deref(),
            language_id: document.language_id.as_str(),
            source: document.text.as_deref(),
        };
        let source = native_document.source.unwrap_or_default();
        self.native()?
            .format(&native_document)?
            .into_iter()
            .map(|edit| text_edit_to_lsp(edit, source).ok_or_else(invalid_edit_error))
            .collect()
    }

    fn run_diagnostic(&self, document: TextDocument<'_>) -> DiagnosticResult {
        self.run_diagnostics(&document, |tool, document| tool.diagnostics(document))
    }

    fn run_diagnostic_on_change(&self, document: TextDocument<'_>) -> DiagnosticResult {
        self.run_diagnostics(&document, |tool, document| tool.diagnostics_on_change(document))
    }

    fn run_diagnostic_on_save(&self, document: TextDocument<'_>) -> DiagnosticResult {
        self.run_diagnostics(&document, |tool, document| tool.diagnostics_on_save(document))
    }

    fn remove_uri_cache(&self, uri: &Uri) {
        self.sources.write().expect("editor source cache poisoned").remove(uri.as_str());
        if let Ok(native) = self.native() {
            native.remove_document(uri.as_str());
        }
    }
}

struct AdapterToolBuilder {
    factory: Arc<dyn EditorToolFactory>,
}

impl AdapterToolBuilder {
    fn workspace(root_uri: &Uri) -> EditorWorkspace {
        EditorWorkspace {
            root_uri: root_uri.as_str().to_string(),
            root_path: root_uri.to_file_path().map(Cow::into_owned),
        }
    }
}

impl ToolBuilder for AdapterToolBuilder {
    fn server_capabilities(
        &self,
        capabilities: &mut ServerCapabilities,
        backend_capabilities: &mut Capabilities,
    ) {
        capabilities.document_formatting_provider = Some(OneOf::Left(true));
        capabilities.code_action_provider =
            Some(CodeActionProviderCapability::Options(CodeActionOptions {
                code_action_kinds: Some(vec![CodeActionKind::QUICKFIX]),
                resolve_provider: Some(false),
                work_done_progress_options: WorkDoneProgressOptions::default(),
            }));
        backend_capabilities.diagnostic_mode = DiagnosticMode::Push;
    }

    fn build(&self, root_uri: &Uri, options: Value) -> ToolBuildResult {
        let workspace = Self::workspace(root_uri);
        let patterns = self.factory.watcher_patterns(&workspace, &options);
        ToolBuildResult {
            tool: Box::new(AdapterTool::new(self.factory.create(&workspace, &options), patterns)),
            client_messages: Vec::new(),
        }
    }

    fn shutdown(&self, root_uri: &Uri) {
        self.factory.shutdown(&Self::workspace(root_uri));
    }
}

/// Run canonical OXC's stdio language-server transport around a project-owned editor tool.
///
/// This is intentionally synchronous so native command binaries do not depend on Tokio or OXC
/// language-server types. It should be called once from a process dedicated to LSP stdio.
///
/// # Errors
///
/// Returns [`EditorServerError`] when the private asynchronous runtime cannot be constructed.
pub fn run_editor_server(
    server_name: impl Into<String>,
    server_version: impl Into<String>,
    factory: Arc<dyn EditorToolFactory>,
) -> Result<(), EditorServerError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(EditorServerError)?;
    runtime.block_on(run_server(
        server_name.into(),
        server_version.into(),
        WorkerManager::new(Arc::new(AdapterToolBuilder { factory })),
    ));
    Ok(())
}

/// The private asynchronous runtime backing the editor transport could not be constructed.
///
/// [`run_editor_server`] fails exactly one way, so this is a newtype rather than an enum.
#[derive(Debug)]
pub struct EditorServerError(io::Error);

impl fmt::Display for EditorServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "unable to start editor runtime: {}", self.0)
    }
}

impl Error for EditorServerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.0)
    }
}

fn rebuilt_tool(builder: &dyn ToolBuilder, root_uri: &Uri, options: Value) -> ToolRestartChanges {
    let ToolBuildResult { tool, client_messages } = builder.build(root_uri, options.clone());
    let watch_patterns = tool.get_watcher_patterns(options);
    ToolRestartChanges { tool: Some(tool), watch_patterns: Some(watch_patterns), client_messages }
}

fn diagnostic_to_lsp(
    diagnostic: EditorDiagnostic,
    source: &str,
    current_uri: &Uri,
) -> Result<LspDiagnostic, String> {
    let range = editor_range_to_lsp(source, diagnostic.range).ok_or_else(|| {
        "native editor tool returned an invalid UTF-8 byte diagnostic range".to_string()
    })?;
    let related_information = diagnostic
        .related
        .into_iter()
        .filter_map(|related| {
            let uri = Uri::from_str(&related.uri).ok()?;
            let related_range = if uri == *current_uri {
                editor_range_to_lsp(source, related.range)?
            } else {
                return None;
            };
            Some(DiagnosticRelatedInformation {
                location: Location { uri, range: related_range },
                message: related.message,
            })
        })
        .collect::<Vec<_>>();
    Ok(LspDiagnostic {
        range,
        severity: Some(match diagnostic.severity {
            EditorSeverity::Error => DiagnosticSeverity::ERROR,
            EditorSeverity::Warning => DiagnosticSeverity::WARNING,
            EditorSeverity::Information => DiagnosticSeverity::INFORMATION,
            EditorSeverity::Hint => DiagnosticSeverity::HINT,
        }),
        code: diagnostic.code.map(NumberOrString::String),
        code_description: None,
        source: diagnostic.source,
        message: diagnostic.message,
        related_information: (!related_information.is_empty()).then_some(related_information),
        tags: None,
        data: diagnostic.data,
    })
}

fn diagnostic_context(diagnostic: &LspDiagnostic, source: &str) -> Option<EditorDiagnosticContext> {
    Some(EditorDiagnosticContext {
        range: lsp_range_to_editor(source, &diagnostic.range)?,
        code: diagnostic.code.as_ref().map(|code| match code {
            NumberOrString::Number(number) => number.to_string(),
            NumberOrString::String(string) => string.clone(),
        }),
        source: diagnostic.source.clone(),
        message: diagnostic.message.clone(),
    })
}

fn action_to_lsp(
    action: EditorCodeAction,
    sources: &HashMap<String, CachedDocument>,
) -> Option<CodeAction> {
    let mut changes = HashMap::<Uri, Vec<TextEdit>>::new();
    for document in action.edits {
        let uri = Uri::from_str(&document.uri).ok()?;
        let source = sources.get(uri.as_str())?.source.as_ref();
        let edits = document
            .edits
            .into_iter()
            .map(|edit| text_edit_to_lsp(edit, source))
            .collect::<Option<Vec<_>>>()?;
        changes.entry(uri).or_default().extend(edits);
    }
    Some(CodeAction {
        title: action.title,
        kind: Some(match action.kind {
            EditorActionKind::QuickFix => CodeActionKind::QUICKFIX,
        }),
        diagnostics: None,
        edit: Some(WorkspaceEdit { changes: Some(changes), ..WorkspaceEdit::default() }),
        command: None,
        is_preferred: Some(action.is_preferred),
        disabled: None,
        data: action.data,
    })
}

fn text_edit_to_lsp(edit: EditorTextEdit, source: &str) -> Option<TextEdit> {
    Some(TextEdit { range: editor_range_to_lsp(source, edit.range)?, new_text: edit.new_text })
}

fn invalid_edit_error() -> String {
    "native editor tool returned an invalid UTF-8 byte edit".to_string()
}

fn editor_range_to_lsp(source: &str, range: EditorRange) -> Option<Range> {
    if range.start > range.end
        || usize::try_from(range.end).ok()? > source.len()
        || !source.is_char_boundary(usize::try_from(range.start).ok()?)
        || !source.is_char_boundary(usize::try_from(range.end).ok()?)
    {
        return None;
    }
    Some(Range::new(offset_to_position(source, range.start), offset_to_position(source, range.end)))
}

fn lsp_range_to_editor(source: &str, range: &Range) -> Option<EditorRange> {
    Some(EditorRange {
        start: position_to_offset(source, range.start)?,
        end: position_to_offset(source, range.end)?,
    })
}

fn position_to_offset(source: &str, position: tower_lsp_server::ls_types::Position) -> Option<u32> {
    let bytes = source.as_bytes();
    let mut cursor = 0_usize;
    let mut line = 0_u32;
    while line < position.line {
        match bytes.get(cursor).copied() {
            Some(b'\r') => {
                cursor += if bytes.get(cursor + 1) == Some(&b'\n') { 2 } else { 1 };
                line += 1;
            }
            Some(b'\n') => {
                cursor += 1;
                line += 1;
            }
            Some(_) => {
                cursor += source[cursor..].chars().next()?.len_utf8();
            }
            None => return None,
        }
    }

    let mut utf16 = 0_u32;
    loop {
        if utf16 == position.character {
            return u32::try_from(cursor).ok();
        }
        match bytes.get(cursor).copied() {
            Some(b'\r' | b'\n') | None => return None,
            Some(_) => {
                let character = source[cursor..].chars().next()?;
                let width = u32::try_from(character.len_utf16()).ok()?;
                if utf16.saturating_add(width) > position.character {
                    return None;
                }
                utf16 = utf16.saturating_add(width);
                cursor += character.len_utf8();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use tower_lsp_server::ls_types::{Position, Range};

    use super::{EditorRange, editor_range_to_lsp, lsp_range_to_editor, position_to_offset};

    #[test]
    fn maps_utf8_bytes_and_utf16_positions_without_splitting_surrogates() {
        let source = "£🍄\r\nvalue";
        assert_eq!(position_to_offset(source, Position::new(0, 0)), Some(0));
        assert_eq!(position_to_offset(source, Position::new(0, 1)), Some(2));
        assert_eq!(position_to_offset(source, Position::new(0, 2)), None);
        assert_eq!(position_to_offset(source, Position::new(0, 3)), Some(6));
        assert_eq!(position_to_offset(source, Position::new(1, 0)), Some(8));

        let editor = EditorRange::new(2, 6);
        let lsp = editor_range_to_lsp(source, editor).unwrap();
        assert_eq!(lsp, Range::new(Position::new(0, 1), Position::new(0, 3)));
        assert_eq!(lsp_range_to_editor(source, &lsp), Some(editor));
    }

    #[test]
    fn rejects_out_of_bounds_or_non_boundary_ranges() {
        assert!(editor_range_to_lsp("🍄", EditorRange::new(1, 4)).is_none());
        assert!(editor_range_to_lsp("abc", EditorRange::new(2, 1)).is_none());
        assert!(editor_range_to_lsp("abc", EditorRange::new(0, 4)).is_none());
    }
}

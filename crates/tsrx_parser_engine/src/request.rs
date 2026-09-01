//! What a caller hands in: the two source forms, and the options both of them accept.

#[derive(Debug, Clone, Copy)]
pub struct TsrxParseRequest<'a> {
    pub source: &'a str,
}

/// Binding-neutral request over the exact JavaScript UTF-16 source units.
///
/// Unlike Rust `str`, this can represent the unpaired surrogate units accepted by JavaScript
/// strings in opaque lexical contexts. The returned result never borrows this storage.
#[derive(Debug, Clone, Copy)]
pub struct TsrxUtf16ParseRequest<'a> {
    pub source: &'a [u16],
}

/// Whether authored syntax errors may return OXC's partial editor tree.
///
/// Recovery is opt-in and never changes the fail-closed compiler path.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TsrxParseRecovery {
    #[default]
    None,
    Editor,
}

#[derive(Debug, Clone, Copy)]
pub struct TsrxParseOptions<'a> {
    pub filename: &'a str,
    pub source_type: Option<&'a str>,
    pub include_ts_fields: bool,
    pub ranges: bool,
    pub preserve_parens: Option<bool>,
    pub show_semantic_errors: bool,
    pub recovery: TsrxParseRecovery,
}

impl Default for TsrxParseOptions<'static> {
    fn default() -> Self {
        Self {
            filename: "input.tsrx",
            source_type: None,
            include_ts_fields: false,
            ranges: false,
            preserve_parens: None,
            show_semantic_errors: false,
            recovery: TsrxParseRecovery::None,
        }
    }
}

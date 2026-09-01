//! Node-API 8 boundary for the canonical OXC-for-TSRX parser.

mod materialize;

use std::cell::RefCell;
#[cfg(feature = "stage4-observer")]
use std::sync::atomic::{AtomicU64, Ordering};

use materialize::{
    NativeProgramTransfer, materialize_comments, materialize_diagnostics, materialize_module,
    materialize_ordinary_comments, materialize_ordinary_diagnostics, materialize_ordinary_module,
    materialize_program, program_transfer_engine_binary,
};
use napi::{
    Env, JsValue, Task,
    bindgen_prelude::{
        AsyncTask, Either, JsObjectValue, Object, ToNapiValue, Unknown, Utf16String,
    },
};
use napi_derive::napi;
use oxc_adapter::parser::{OrdinaryParseRequest, OrdinaryParseResult, parse_ordinary};
#[cfg(feature = "stage4-observer")]
use tsrx_parser_engine::{
    Stage4WorkCounters, parse_tsrx_utf16_with_options_for_compat_transfer_observed,
    parse_tsrx_utf16_with_options_observed, parse_tsrx_with_options_for_compat_transfer_observed,
    parse_tsrx_with_options_for_transfer_observed,
};
use tsrx_parser_engine::{
    TsrxParseError, TsrxParseOptions, TsrxParseRecovery, TsrxParseRequest, TsrxParseResult,
    TsrxUtf16ParseRequest,
};
#[cfg(not(feature = "stage4-observer"))]
use tsrx_parser_engine::{
    parse_tsrx_utf16_with_options, parse_tsrx_utf16_with_options_for_compat_transfer,
    parse_tsrx_with_options_for_compat_transfer, parse_tsrx_with_options_for_transfer,
};

// mimalloc is a C library, so building it for a musl target needs a musl cross
// C++ compiler that the release runners do not have: the build script fails
// with `ToolNotFound: aarch64-linux-musl-g++`. The executables do not hit this
// because they have no C dependency at all. Rather than carry a cross toolchain
// only this one crate needs, musl builds keep the platform allocator, and every
// other target keeps mimalloc. This is an allocator choice, not a behavioural
// one: nothing in the parser's output depends on which allocator served it.
#[cfg(not(target_env = "musl"))]
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

const NODE_API: u32 = 8;
const ROUTE_INFER_ORDINARY: u8 = 0;
const ROUTE_JAVASCRIPT: u8 = 1;
const ROUTE_JAVASCRIPT_REACT: u8 = 2;
const ROUTE_TYPESCRIPT: u8 = 3;
const ROUTE_TYPESCRIPT_REACT: u8 = 4;
const ROUTE_TYPESCRIPT_DEFINITION: u8 = 5;
const ROUTE_TSRX: u8 = 6;
const ROUTE_TSRX_CORE_COMPAT: u8 = 7;

#[cfg(feature = "stage4-observer")]
const EMPTY_SHA256: &str = "0000000000000000000000000000000000000000000000000000000000000000";
#[cfg(feature = "stage4-observer")]
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[cfg(feature = "stage4-observer")]
static TSRX_SCANS: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "stage4-observer")]
static TSRX_COPIED_BYTES: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "stage4-observer")]
static TSRX_PROJECTION_BYTES: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "stage4-observer")]
static TSRX_MAP_BYTES: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "stage4-observer")]
static TSRX_SURROGATE_BYTES: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "stage4-observer")]
static TSRX_TAPE_BYTES: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "stage4-observer")]
static RECOVERY_WORK: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "stage4-observer")]
static CSS_WORK: AtomicU64 = AtomicU64::new(0);

#[cfg(feature = "stage4-observer")]
const OBSERVER_COUNTERS: [&AtomicU64; 8] = [
    &TSRX_SCANS,
    &TSRX_COPIED_BYTES,
    &TSRX_PROJECTION_BYTES,
    &TSRX_MAP_BYTES,
    &TSRX_SURROGATE_BYTES,
    &TSRX_TAPE_BYTES,
    &RECOVERY_WORK,
    &CSS_WORK,
];

#[cfg(feature = "stage4-observer")]
fn saturating_counter_add(counter: &AtomicU64, value: u64) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_add(value).min(JS_MAX_SAFE_INTEGER))
    });
}

#[cfg(feature = "stage4-observer")]
fn record_stage4_work(source_units: usize, work: Stage4WorkCounters) {
    let units = u64::try_from(source_units).unwrap_or(u64::MAX);
    let original_utf16_bytes = units.saturating_mul(size_of::<u16>() as u64);
    saturating_counter_add(&TSRX_SCANS, u64::try_from(work.scans).unwrap_or(u64::MAX));
    saturating_counter_add(
        &TSRX_COPIED_BYTES,
        original_utf16_bytes.saturating_add(u64::try_from(work.copied_bytes).unwrap_or(u64::MAX)),
    );
    saturating_counter_add(
        &TSRX_PROJECTION_BYTES,
        u64::try_from(work.projection_bytes).unwrap_or(u64::MAX),
    );
    saturating_counter_add(&TSRX_MAP_BYTES, u64::try_from(work.map_bytes).unwrap_or(u64::MAX));
    saturating_counter_add(
        &TSRX_SURROGATE_BYTES,
        u64::try_from(work.surrogate_bytes).unwrap_or(u64::MAX),
    );
    saturating_counter_add(&TSRX_TAPE_BYTES, u64::try_from(work.tape_bytes).unwrap_or(u64::MAX));
}

#[cfg(feature = "stage4-observer")]
fn reset_observer_counters() {
    for counter in OBSERVER_COUNTERS {
        counter.store(0, Ordering::Relaxed);
    }
}

#[cfg(feature = "stage4-observer")]
fn counter_as_number(counter: &AtomicU64) -> f64 {
    #[expect(
        clippy::cast_precision_loss,
        reason = "every `Stage4OrdinaryCounters` field is `f64` because a napi object carries \
                  JavaScript numbers, and the only writer, `saturating_counter_add`, already clamps \
                  each counter to `JS_MAX_SAFE_INTEGER`, so the cast cannot lose a digit"
    )]
    let value = counter.load(Ordering::Relaxed) as f64;
    value
}

#[cfg(feature = "stage4-observer")]
#[derive(Debug)]
#[napi(object, object_from_js = false, object_to_js = true)]
pub struct Stage4OrdinaryCounters {
    pub tsrx_scans: f64,
    pub tsrx_copied_bytes: f64,
    pub tsrx_projection_bytes: f64,
    pub tsrx_map_bytes: f64,
    pub tsrx_surrogate_bytes: f64,
    pub tsrx_tape_bytes: f64,
    pub recovery_work: f64,
    pub css_work: f64,
}

#[cfg(feature = "stage4-observer")]
fn observer_counters() -> Stage4OrdinaryCounters {
    Stage4OrdinaryCounters {
        tsrx_scans: counter_as_number(&TSRX_SCANS),
        tsrx_copied_bytes: counter_as_number(&TSRX_COPIED_BYTES),
        tsrx_projection_bytes: counter_as_number(&TSRX_PROJECTION_BYTES),
        tsrx_map_bytes: counter_as_number(&TSRX_MAP_BYTES),
        tsrx_surrogate_bytes: counter_as_number(&TSRX_SURROGATE_BYTES),
        tsrx_tape_bytes: counter_as_number(&TSRX_TAPE_BYTES),
        recovery_work: counter_as_number(&RECOVERY_WORK),
        css_work: counter_as_number(&CSS_WORK),
    }
}

#[cfg(feature = "stage4-observer")]
#[derive(Debug)]
#[napi(object, object_from_js = false, object_to_js = true)]
pub struct Stage4ObserverSourceFile {
    pub path: String,
    pub sha256: String,
}

#[cfg(feature = "stage4-observer")]
#[derive(Debug)]
#[napi(object, object_from_js = false, object_to_js = true)]
pub struct Stage4ObserverIdentity {
    pub schema: String,
    pub version: u32,
    pub profile: String,
    pub allocator: String,
    pub timed: bool,
    pub shipped: bool,
    pub oxc_revision: String,
    pub source_files: Vec<Stage4ObserverSourceFile>,
}

#[cfg(feature = "stage4-observer")]
fn observer_source(path: &str, sha256: &str) -> Stage4ObserverSourceFile {
    Stage4ObserverSourceFile { path: path.to_string(), sha256: sha256.to_string() }
}

/// Options read by the native boundary after the ESM wrapper has consumed `lang` exactly once.
#[derive(Clone, Default)]
#[napi(object)]
pub struct NativeParserOptions {
    pub source_type: Option<String>,
    pub ast_type: Option<String>,
    pub range: Option<bool>,
    pub preserve_parens: Option<bool>,
    pub show_semantic_errors: Option<bool>,
    pub recovery: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route {
    Ordinary { explicit_lang: Option<&'static str> },
    Tsrx,
}

impl Route {
    fn from_code(code: u8) -> napi::Result<Self> {
        let route = match code {
            ROUTE_INFER_ORDINARY => Self::Ordinary { explicit_lang: None },
            ROUTE_JAVASCRIPT => Self::Ordinary { explicit_lang: Some("js") },
            ROUTE_JAVASCRIPT_REACT => Self::Ordinary { explicit_lang: Some("jsx") },
            ROUTE_TYPESCRIPT => Self::Ordinary { explicit_lang: Some("ts") },
            ROUTE_TYPESCRIPT_REACT => Self::Ordinary { explicit_lang: Some("tsx") },
            ROUTE_TYPESCRIPT_DEFINITION => Self::Ordinary { explicit_lang: Some("dts") },
            ROUTE_TSRX | ROUTE_TSRX_CORE_COMPAT => Self::Tsrx,
            _ => return Err(invalid("wrapper supplied an unknown source-family route")),
        };
        Ok(route)
    }
}

enum OwnedSource {
    Ordinary { source: String, explicit_lang: Option<&'static str> },
    TsrxUtf8(String),
    TsrxUtf16(Utf16String),
}

#[doc(hidden)]
pub enum ParsedPayload {
    Ordinary(OrdinaryParseResult),
    Tsrx(Box<TsrxParseResult>),
}

fn invalid(message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(format!("ERR_TSRX_INVALID_ARGUMENT: {}", message.into()))
}

fn parse_error(error: &TsrxParseError) -> napi::Error {
    let resource_exhausted = error.is_resource_exhausted();
    let message = error.to_string();
    if resource_exhausted {
        napi::Error::from_reason(format!("ERR_TSRX_RESOURCE_EXHAUSTED: {message}"))
    } else {
        invalid(message)
    }
}

enum LaneState<T> {
    Pending(T),
    Failed(String),
    Transferred,
}

fn take_lane<T>(state: &RefCell<LaneState<T>>, name: &str) -> napi::Result<T> {
    let mut state = state.borrow_mut();
    match std::mem::replace(&mut *state, LaneState::Transferred) {
        LaneState::Pending(lane) => Ok(lane),
        LaneState::Failed(reason) => {
            *state = LaneState::Failed(reason.clone());
            Err(napi::Error::from_reason(reason))
        }
        LaneState::Transferred => Err(invalid(format!("{name} table was already transferred"))),
    }
}

fn retain_lane_failure<T>(state: &RefCell<LaneState<T>>, error: &napi::Error) {
    *state.borrow_mut() = LaneState::Failed(error.reason.clone());
}

fn validate_tsrx_options(options: &NativeParserOptions) -> napi::Result<()> {
    if let Some(value) = options.source_type.as_deref()
        && !matches!(value, "script" | "module" | "commonjs" | "unambiguous")
    {
        return Err(invalid(format!("unsupported sourceType `{value}`")));
    }
    if let Some(value) = options.ast_type.as_deref()
        && !matches!(value, "js" | "ts")
    {
        return Err(invalid(format!("unsupported astType `{value}`")));
    }
    if let Some(value) = options.recovery.as_deref() {
        match value {
            "none" | "editor" => {}
            _ => return Err(invalid(format!("unsupported recovery `{value}`"))),
        }
    }
    Ok(())
}

fn tsrx_recovery(options: &NativeParserOptions) -> TsrxParseRecovery {
    if options.recovery.as_deref() == Some("editor") {
        TsrxParseRecovery::Editor
    } else {
        TsrxParseRecovery::None
    }
}

fn owned_source(
    ordinary_source: String,
    tsrx_source: Option<Utf16String>,
    route_code: u8,
    options: &NativeParserOptions,
) -> napi::Result<OwnedSource> {
    match Route::from_code(route_code)? {
        Route::Ordinary { explicit_lang } => {
            if tsrx_source.is_some() {
                return Err(invalid("ordinary route received a TSRX UTF-16 source lane"));
            }
            Ok(OwnedSource::Ordinary { source: ordinary_source, explicit_lang })
        }
        Route::Tsrx => {
            validate_tsrx_options(options)?;
            match (ordinary_source.is_empty(), tsrx_source) {
                (false, None) => Ok(OwnedSource::TsrxUtf8(ordinary_source)),
                (true, Some(source)) => Ok(OwnedSource::TsrxUtf16(source)),
                (false, Some(_)) => Err(invalid("TSRX route received both source lanes")),
                (true, None) => Err(invalid("TSRX route requires one exact source lane")),
            }
        }
    }
}

fn parse_owned(
    filename: &str,
    source: OwnedSource,
    options: &NativeParserOptions,
    eager_compat: bool,
) -> napi::Result<ParsedPayload> {
    match source {
        OwnedSource::Ordinary { source, explicit_lang } => {
            Ok(ParsedPayload::Ordinary(parse_ordinary(OrdinaryParseRequest {
                filename,
                source: &source,
                lang: explicit_lang,
                source_type: options.source_type.as_deref(),
                ast_type: options.ast_type.as_deref(),
                ranges: options.range.unwrap_or(false),
                preserve_parens: options.preserve_parens,
                show_semantic_errors: options.show_semantic_errors.unwrap_or(false),
            })))
        }
        OwnedSource::TsrxUtf8(source) => {
            let request = TsrxParseRequest { source: &source };
            let parse_options = TsrxParseOptions {
                filename,
                source_type: if eager_compat {
                    Some("module")
                } else {
                    options.source_type.as_deref()
                },
                // The canonical TSRX contract deliberately defaults to the JavaScript ESTree
                // field policy; callers can request OXC's TypeScript field policy explicitly.
                include_ts_fields: eager_compat || options.ast_type.as_deref() == Some("ts"),
                ranges: options.range.unwrap_or(false),
                preserve_parens: if eager_compat { Some(false) } else { options.preserve_parens },
                show_semantic_errors: !eager_compat
                    && options.show_semantic_errors.unwrap_or(false),
                recovery: tsrx_recovery(options),
            };
            #[cfg(feature = "stage4-observer")]
            let parsed = if eager_compat {
                parse_tsrx_with_options_for_compat_transfer_observed(&request, parse_options)
            } else {
                parse_tsrx_with_options_for_transfer_observed(&request, parse_options)
            }
            .map(|(result, work)| {
                record_stage4_work(source.len(), work);
                result
            });
            #[cfg(not(feature = "stage4-observer"))]
            let parsed = if eager_compat {
                parse_tsrx_with_options_for_compat_transfer(&request, parse_options)
            } else {
                parse_tsrx_with_options_for_transfer(&request, parse_options)
            };
            parsed
                .map(|result| ParsedPayload::Tsrx(Box::new(result)))
                .map_err(|error| parse_error(&error))
        }
        OwnedSource::TsrxUtf16(source) => {
            let request = TsrxUtf16ParseRequest { source: &source };
            let parse_options = TsrxParseOptions {
                filename,
                source_type: if eager_compat {
                    Some("module")
                } else {
                    options.source_type.as_deref()
                },
                include_ts_fields: eager_compat || options.ast_type.as_deref() == Some("ts"),
                ranges: options.range.unwrap_or(false),
                preserve_parens: if eager_compat { Some(false) } else { options.preserve_parens },
                show_semantic_errors: !eager_compat
                    && options.show_semantic_errors.unwrap_or(false),
                recovery: tsrx_recovery(options),
            };
            #[cfg(feature = "stage4-observer")]
            let parsed = if eager_compat {
                parse_tsrx_utf16_with_options_for_compat_transfer_observed(&request, parse_options)
            } else {
                parse_tsrx_utf16_with_options_observed(&request, parse_options)
            }
            .map(|(result, work)| {
                record_stage4_work(source.len(), work);
                result
            });
            #[cfg(not(feature = "stage4-observer"))]
            let parsed = if eager_compat {
                parse_tsrx_utf16_with_options_for_compat_transfer(&request, parse_options)
            } else {
                parse_tsrx_utf16_with_options(&request, parse_options)
            };
            parsed
                .map(|result| ParsedPayload::Tsrx(Box::new(result)))
                .map_err(|error| parse_error(&error))
        }
    }
}

fn lazy_result(env: &Env, payload: ParsedPayload) -> napi::Result<Object<'static>> {
    let (program, module, comments, errors) = match payload {
        ParsedPayload::Ordinary(result) => (
            ProgramLane::Ordinary(result.program_and_fixes),
            ModuleLane::Ordinary(result.module),
            CommentsLane::Ordinary(result.comments),
            ErrorsLane::Ordinary(result.errors),
        ),
        ParsedPayload::Tsrx(result) => {
            let result = *result;
            (
                ProgramLane::Tsrx(result.program),
                ModuleLane::Tsrx(result.module),
                CommentsLane::Tsrx(result.comments),
                ErrorsLane::Tsrx(result.errors),
            )
        }
    };
    let program = RefCell::new(LaneState::Pending(program));
    let module = RefCell::new(LaneState::Pending(module));
    let comments = RefCell::new(LaneState::Pending(comments));
    let errors = RefCell::new(LaneState::Pending(errors));
    let mut object = Object::new(env)?;
    object.define_properties(&[
        napi::Property::new().with_utf8_name("program")?.with_getter_closure(move |env, _| {
            let lane = take_lane(&program, "program")?;
            match lane.materialize(&env) {
                Ok(value) => Ok(value.raw()),
                Err(error) => {
                    retain_lane_failure(&program, &error);
                    Err(error)
                }
            }
        }),
        napi::Property::new().with_utf8_name("module")?.with_getter_closure(move |env, _| {
            let lane = take_lane(&module, "module")?;
            match lane.materialize(&env) {
                Ok(value) => Ok(value.raw()),
                Err(error) => {
                    retain_lane_failure(&module, &error);
                    Err(error)
                }
            }
        }),
        napi::Property::new().with_utf8_name("comments")?.with_getter_closure(move |env, _| {
            let lane = take_lane(&comments, "comment")?;
            match lane.materialize(&env) {
                Ok(value) => Ok(value.raw()),
                Err(error) => {
                    retain_lane_failure(&comments, &error);
                    Err(error)
                }
            }
        }),
        napi::Property::new().with_utf8_name("errors")?.with_getter_closure(move |env, _| {
            let lane = take_lane(&errors, "diagnostic")?;
            match lane.materialize(&env) {
                Ok(value) => Ok(value.raw()),
                Err(error) => {
                    retain_lane_failure(&errors, &error);
                    Err(error)
                }
            }
        }),
    ])?;
    Ok(object)
}

/// Materializes exactly the two lanes consumed immediately by the synchronous `@tsrx/core`
/// compatibility facade. Keeping this private route inside the existing `parseSync` call avoids
/// four unused native getter closures and two additional Node-API callbacks per source file.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "the borrow is forwarded unchanged to `materialize_program`, `materialize_diagnostics` \
              and `Object::new`, and it matches the sibling `lazy_result` lane so both `parse_sync` \
              branches hand the environment on the same way"
)]
fn eager_compat_result(
    env: &Env,
    payload: ParsedPayload,
) -> napi::Result<Either<NativeProgramTransfer, Object<'static>>> {
    let ParsedPayload::Tsrx(result) = payload else {
        return Err(invalid("TSRX compatibility route received an ordinary result"));
    };
    let result = *result;
    if result.errors.is_empty()
        && let Some(program) = result.program
    {
        return program_transfer_engine_binary(program).map(Either::A);
    }
    let program = match result.program {
        Some(value) => materialize_program(env, value)?,
        None => Option::<String>::None.into_unknown(env)?,
    };
    let errors = materialize_diagnostics(env, result.errors)?;
    let mut object = Object::new(env)?;
    object.set_c_named_property(c"program", program)?;
    object.set_c_named_property(c"errors", errors)?;
    Ok(Either::B(object))
}

enum ProgramLane {
    Ordinary(String),
    Tsrx(Option<tsrx_tape_schema::FlatTape>),
}

impl ProgramLane {
    fn materialize(self, env: &Env) -> napi::Result<Unknown<'_>> {
        match self {
            Self::Ordinary(value) => value.into_unknown(env),
            Self::Tsrx(Some(value)) => materialize_program(env, value),
            Self::Tsrx(None) => Option::<String>::None.into_unknown(env),
        }
    }
}

enum ModuleLane {
    Ordinary(oxc_adapter::parser::OrdinaryModule),
    Tsrx(Option<tsrx_tape_schema::ModuleTable>),
}

impl ModuleLane {
    fn materialize(self, env: &Env) -> napi::Result<Unknown<'_>> {
        match self {
            Self::Ordinary(value) => materialize_ordinary_module(env, value),
            Self::Tsrx(Some(value)) => materialize_module(env, value),
            Self::Tsrx(None) => Option::<String>::None.into_unknown(env),
        }
    }
}

enum CommentsLane {
    Ordinary(Vec<oxc_adapter::parser::OrdinaryComment>),
    Tsrx(tsrx_tape_schema::CommentTable),
}

impl CommentsLane {
    fn materialize(self, env: &Env) -> napi::Result<Unknown<'_>> {
        match self {
            Self::Ordinary(value) => materialize_ordinary_comments(env, value),
            Self::Tsrx(value) => materialize_comments(env, value),
        }
    }
}

enum ErrorsLane {
    Ordinary(Vec<oxc_adapter::parser::OrdinaryDiagnostic>),
    Tsrx(tsrx_tape_schema::DiagnosticTable),
}

impl ErrorsLane {
    fn materialize(self, env: &Env) -> napi::Result<Unknown<'_>> {
        match self {
            Self::Ordinary(value) => materialize_ordinary_diagnostics(env, value),
            Self::Tsrx(value) => materialize_diagnostics(env, value),
        }
    }
}

#[napi]
#[must_use]
pub const fn node_api() -> u32 {
    NODE_API
}

/// Returns the identity of the nonshipping Stage 4 counter-observation sibling.
///
/// This export and all of its supporting data are compile-time absent from the production addon.
#[cfg(feature = "stage4-observer")]
#[napi]
#[must_use]
pub fn observer_identity() -> Stage4ObserverIdentity {
    Stage4ObserverIdentity {
        schema: "stage4-ordinary-counter-observer-identity-v1".to_string(),
        version: 1,
        profile: "release".to_string(),
        allocator: "system".to_string(),
        timed: false,
        shipped: false,
        oxc_revision: oxc_adapter::OXC_REVISION.to_string(),
        source_files: vec![
            observer_source(
                "crates/oxc_adapter/src/lib.rs",
                option_env!("OXC_TSRX_STAGE4_ADAPTER_SHA256").unwrap_or(EMPTY_SHA256),
            ),
            observer_source(
                "crates/tsrx_parser_engine/Cargo.toml",
                option_env!("OXC_TSRX_STAGE4_ENGINE_MANIFEST_SHA256").unwrap_or(EMPTY_SHA256),
            ),
            observer_source(
                "crates/tsrx_parser_engine/src/lib.rs",
                option_env!("OXC_TSRX_STAGE4_ENGINE_SHA256").unwrap_or(EMPTY_SHA256),
            ),
            observer_source(
                "crates/tsrx_parser_engine/src/utf16_result.rs",
                option_env!("OXC_TSRX_STAGE4_ENGINE_UTF16_SHA256").unwrap_or(EMPTY_SHA256),
            ),
            observer_source(
                "crates/tsrx_parser_engine/src/source_bridge.rs",
                option_env!("OXC_TSRX_STAGE4_ENGINE_BRIDGE_SHA256").unwrap_or(EMPTY_SHA256),
            ),
            observer_source(
                "crates/parser_napi_binding/Cargo.toml",
                option_env!("OXC_TSRX_STAGE4_BINDING_MANIFEST_SHA256").unwrap_or(EMPTY_SHA256),
            ),
            observer_source(
                "crates/parser_napi_binding/src/lib.rs",
                option_env!("OXC_TSRX_STAGE4_BINDING_SHA256").unwrap_or(EMPTY_SHA256),
            ),
        ],
    }
}

/// Snapshots real route-owned counters for the nonshipping Stage 4 qualification sibling.
#[cfg(feature = "stage4-observer")]
#[napi]
#[must_use]
pub fn ordinary_counters() -> Stage4OrdinaryCounters {
    observer_counters()
}

/// Resets the nonshipping Stage 4 qualification counters before an isolated campaign.
#[cfg(feature = "stage4-observer")]
#[napi]
pub fn reset_ordinary_counters() {
    reset_observer_counters();
}

/// Parses one source synchronously and returns independently lazy result lanes.
///
/// # Errors
///
/// Returns a stable operational error when arguments, resources, or native materialization fail.
// Node-API owns the JavaScript string at this boundary even though synchronous parsing borrows it.
#[expect(
    clippy::allow_attributes,
    reason = "napi-derive copies this attribute list onto the generated parse_sync_c_callback \
              shim, whose raw napi_env/napi_callback_info parameters can never fulfil an expect"
)]
#[allow(clippy::needless_pass_by_value)]
#[napi]
pub fn parse_sync(
    env: Env,
    filename: String,
    ordinary_source: String,
    tsrx_source: Option<Utf16String>,
    options: Option<NativeParserOptions>,
    route_code: u8,
) -> napi::Result<Either<NativeProgramTransfer, Object<'static>>> {
    let options = options.unwrap_or_default();
    let source = owned_source(ordinary_source, tsrx_source, route_code, &options)?;
    let eager_compat = route_code == ROUTE_TSRX_CORE_COMPAT;
    let payload = parse_owned(&filename, source, &options, eager_compat)?;
    if route_code == ROUTE_TSRX_CORE_COMPAT {
        eager_compat_result(&env, payload)
    } else {
        lazy_result(&env, payload).map(Either::B)
    }
}

pub struct ParseTask {
    filename: String,
    source: Option<OwnedSource>,
    options: NativeParserOptions,
}

impl Task for ParseTask {
    type Output = ParsedPayload;
    type JsValue = Object<'static>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let source = self
            .source
            .take()
            .ok_or_else(|| invalid("async parser source was already consumed"))?;
        parse_owned(&self.filename, source, &self.options, false)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        lazy_result(&env, output)
    }
}

/// Schedules one off-thread parse and returns the same independently lazy result contract.
///
/// # Errors
///
/// Returns a stable operational error when argument validation or task construction fails.
#[napi]
pub fn parse(
    filename: String,
    ordinary_source: String,
    tsrx_source: Option<Utf16String>,
    options: Option<NativeParserOptions>,
    route_code: u8,
) -> napi::Result<AsyncTask<ParseTask>> {
    if route_code == ROUTE_TSRX_CORE_COMPAT {
        return Err(invalid("TSRX compatibility route is synchronous-only"));
    }
    let options = options.unwrap_or_default();
    let source = owned_source(ordinary_source, tsrx_source, route_code, &options)?;
    Ok(AsyncTask::new(ParseTask { filename, source: Some(source), options }))
}

#[cfg(test)]
mod tests {
    use super::{
        LaneState, NODE_API, ROUTE_INFER_ORDINARY, ROUTE_TSRX, ROUTE_TSRX_CORE_COMPAT,
        ROUTE_TYPESCRIPT_REACT, Route, invalid, parse_error, retain_lane_failure, take_lane,
    };
    #[cfg(feature = "stage4-observer")]
    use super::{record_stage4_work, reset_observer_counters};
    use std::cell::RefCell;
    use tsrx_parser_engine::TsrxParseError;
    #[cfg(feature = "stage4-observer")]
    use tsrx_parser_engine::{
        TsrxParseOptions, TsrxUtf16ParseRequest, parse_tsrx_utf16_with_options_observed,
    };
    use tsrx_tape_schema::TapeBuildError;

    #[test]
    fn native_errors_preserve_resource_exhaustion() {
        let exhausted = parse_error(&TsrxParseError::from(TapeBuildError::CapacityOverflow));
        assert!(exhausted.reason.starts_with("ERR_TSRX_RESOURCE_EXHAUSTED:"));

        let invalid = parse_error(&TsrxParseError::from(TapeBuildError::InvalidRecordIndex));
        assert!(invalid.reason.starts_with("ERR_TSRX_INVALID_ARGUMENT:"));
    }

    #[test]
    fn lazy_lane_replays_the_same_terminal_materialization_error() {
        let state = RefCell::new(LaneState::Pending(7_u8));
        assert_eq!(take_lane(&state, "program").expect("pending lane"), 7);
        let failure = invalid("materialization failed");
        retain_lane_failure(&state, &failure);

        let first = take_lane(&state, "program").expect_err("first failure");
        let second = take_lane(&state, "program").expect_err("replayed failure");
        assert_eq!(first.reason, failure.reason);
        assert_eq!(second.reason, failure.reason);
    }

    #[test]
    fn route_codes_preserve_explicit_versus_inferred_language() {
        assert_eq!(
            Route::from_code(ROUTE_INFER_ORDINARY).expect("inferred route"),
            Route::Ordinary { explicit_lang: None }
        );
        assert_eq!(
            Route::from_code(ROUTE_TYPESCRIPT_REACT).expect("explicit route"),
            Route::Ordinary { explicit_lang: Some("tsx") }
        );
        assert_eq!(Route::from_code(ROUTE_TSRX).expect("TSRX route"), Route::Tsrx);
        assert_eq!(
            Route::from_code(ROUTE_TSRX_CORE_COMPAT).expect("TSRX compat route"),
            Route::Tsrx
        );
    }

    #[test]
    fn native_identity_is_frozen() {
        assert_eq!(NODE_API, 8);
        assert_eq!(oxc_adapter::OXC_REVISION, "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40");
    }

    #[cfg(feature = "stage4-observer")]
    #[test]
    fn stage4_observer_has_real_positive_controls_for_every_canonical_work_lane() {
        reset_observer_counters();
        let mut source =
            "function Positive() @{ @if(ok){<main data-value=\"".encode_utf16().collect::<Vec<_>>();
        source.push(0xd800);
        source.extend("\"/>}@else{<aside/>} }".encode_utf16());
        let (result, work) = parse_tsrx_utf16_with_options_observed(
            &TsrxUtf16ParseRequest { source: &source },
            TsrxParseOptions::default(),
        )
        .expect("real projected TSRX positive control");
        assert!(result.program.is_some());
        record_stage4_work(source.len(), work);

        assert_eq!(super::TSRX_SCANS.load(super::Ordering::Relaxed), 1);
        for counter in &super::OBSERVER_COUNTERS[..6] {
            assert!(counter.load(super::Ordering::Relaxed) > 0);
        }
        for counter in &super::OBSERVER_COUNTERS[6..] {
            assert_eq!(counter.load(super::Ordering::Relaxed), 0);
        }
    }
}

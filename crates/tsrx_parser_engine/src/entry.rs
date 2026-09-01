//! The public entry points. Each one is only a fixed arrangement of options over the shared
//! route, so no caller policy leaks into the pipeline itself.

#[cfg(feature = "stage4-observer")]
use crate::Stage4WorkCounters;
use crate::{
    TsrxParseError, TsrxParseOptions, TsrxParseRequest, TsrxParseResult, TsrxUtf16ParseRequest,
    pipeline::parse_tsrx_utf8_source, utf16_result::NoopUtf16WorkObserver,
    utf16_route::parse_tsrx_utf16_with_options_and_observer,
};

/// Parses the implemented canonical TSRX grammar through one pinned public-OXC arena parse.
///
/// Unsupported syntax fails closed. Broader authored constructs are added as independently
/// verified reconstruction slices without changing the ordinary JS/TS/TSX OXC route.
///
/// # Errors
///
/// Malformed, unsupported, or OXC-rejected authored grammar is returned as a structured
/// [`ParseCompleteness::Failed`](tsrx_tape_schema::ParseCompleteness::Failed) result with null `program` and `module` records. Returns
/// [`TsrxParseError`] only for operational failures such as unsupported coordinate domains,
/// capacity exhaustion, or an internal projection/reconstruction invariant.
pub fn parse_tsrx(request: &TsrxParseRequest<'_>) -> Result<TsrxParseResult, TsrxParseError> {
    parse_tsrx_with_options(request, TsrxParseOptions::default())
}

/// Parses canonical TSRX with the bounded options needed by the eventual OXC-compatible binding.
///
/// # Errors
///
/// With default options, malformed, unsupported, or OXC-rejected authored grammar is returned as
/// a structured [`ParseCompleteness::Failed`](tsrx_tape_schema::ParseCompleteness::Failed) result
/// with null `program` and `module` records. Editor recovery may instead retain a usable OXC
/// partial tree and mark it
/// [`ParseCompleteness::Recovered`](tsrx_tape_schema::ParseCompleteness::Recovered). Requested
/// semantic diagnostics are likewise returned as structured result data. Returns an error only
/// for operational failures such as unsupported coordinate domains, capacity exhaustion, or an
/// internal projection/reconstruction invariant.
pub fn parse_tsrx_with_options(
    request: &TsrxParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<TsrxParseResult, TsrxParseError> {
    let source = request.source;
    if !source.is_ascii() {
        return Err(TsrxParseError::Unsupported("non-ASCII source"));
    }

    let mut observer = NoopUtf16WorkObserver;
    parse_tsrx_utf8_source(source, options, false, false, true, &mut observer)
}

/// Parses ASCII TSRX for a consumer that serializes only the reachable Program tree.
#[doc(hidden)]
pub fn parse_tsrx_with_options_for_transfer(
    request: &TsrxParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<TsrxParseResult, TsrxParseError> {
    if !request.source.is_ascii() {
        return Err(TsrxParseError::Unsupported("non-ASCII source"));
    }
    let mut observer = NoopUtf16WorkObserver;
    parse_tsrx_utf8_source(request.source, options, true, false, true, &mut observer)
}

/// Parses ASCII TSRX for the private Program-and-diagnostics compatibility transport.
#[doc(hidden)]
pub fn parse_tsrx_with_options_for_compat_transfer(
    request: &TsrxParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<TsrxParseResult, TsrxParseError> {
    if !request.source.is_ascii() {
        return Err(TsrxParseError::Unsupported("non-ASCII source"));
    }
    let mut observer = NoopUtf16WorkObserver;
    parse_tsrx_utf8_source(request.source, options, true, false, false, &mut observer)
}

/// Parses ASCII canonical TSRX while returning real route-owned Stage 4 work totals.
#[cfg(feature = "stage4-observer")]
#[doc(hidden)]
pub fn parse_tsrx_with_options_observed(
    request: &TsrxParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<(TsrxParseResult, Stage4WorkCounters), TsrxParseError> {
    if !request.source.is_ascii() {
        return Err(TsrxParseError::Unsupported("non-ASCII source"));
    }
    let mut work = Stage4WorkCounters::default();
    let result = parse_tsrx_utf8_source(request.source, options, false, false, true, &mut work)?;
    Ok((result, work))
}

/// Parses ASCII TSRX for reachable-tree transfer while returning Stage 4 work totals.
#[cfg(feature = "stage4-observer")]
#[doc(hidden)]
pub fn parse_tsrx_with_options_for_transfer_observed(
    request: &TsrxParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<(TsrxParseResult, Stage4WorkCounters), TsrxParseError> {
    if !request.source.is_ascii() {
        return Err(TsrxParseError::Unsupported("non-ASCII source"));
    }
    let mut work = Stage4WorkCounters::default();
    let result = parse_tsrx_utf8_source(request.source, options, true, false, true, &mut work)?;
    Ok((result, work))
}

/// Parses ASCII TSRX for the private compatibility transport while returning Stage 4 totals.
#[cfg(feature = "stage4-observer")]
#[doc(hidden)]
pub fn parse_tsrx_with_options_for_compat_transfer_observed(
    request: &TsrxParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<(TsrxParseResult, Stage4WorkCounters), TsrxParseError> {
    if !request.source.is_ascii() {
        return Err(TsrxParseError::Unsupported("non-ASCII source"));
    }
    let mut work = Stage4WorkCounters::default();
    let result = parse_tsrx_utf8_source(request.source, options, true, false, false, &mut work)?;
    Ok((result, work))
}

/// Parses exact JavaScript UTF-16 source units through the same single public-OXC parse.
///
/// # Errors
///
/// Returns an operational error only when the lossless bridge or existing canonical parser
/// invariants fail. Authored syntax failures remain structured failed parse results.
pub fn parse_tsrx_utf16(
    request: &TsrxUtf16ParseRequest<'_>,
) -> Result<TsrxParseResult, TsrxParseError> {
    parse_tsrx_utf16_with_options(request, TsrxParseOptions::default())
}

/// Parses exact JavaScript UTF-16 source units with canonical parser options.
///
/// # Errors
///
/// Returns an operational error only when the lossless bridge or existing canonical parser
/// invariants fail. Authored syntax failures remain structured failed parse results.
pub fn parse_tsrx_utf16_with_options(
    request: &TsrxUtf16ParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<TsrxParseResult, TsrxParseError> {
    let mut observer = NoopUtf16WorkObserver;
    parse_tsrx_utf16_with_options_and_observer(request, options, false, true, &mut observer)
}

/// Parses exact UTF-16 TSRX for the private Program-and-diagnostics compatibility transport.
#[doc(hidden)]
pub fn parse_tsrx_utf16_with_options_for_compat_transfer(
    request: &TsrxUtf16ParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<TsrxParseResult, TsrxParseError> {
    let mut observer = NoopUtf16WorkObserver;
    parse_tsrx_utf16_with_options_and_observer(request, options, true, false, &mut observer)
}

/// Parses exact JavaScript UTF-16 while returning real route-owned Stage 4 work totals.
///
/// This entry point exists only in the nonshipping observer build. The production parser uses the
/// monomorphized no-op observer and exposes no observation API.
#[cfg(feature = "stage4-observer")]
#[doc(hidden)]
pub fn parse_tsrx_utf16_with_options_observed(
    request: &TsrxUtf16ParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<(TsrxParseResult, Stage4WorkCounters), TsrxParseError> {
    let mut work = Stage4WorkCounters::default();
    let result =
        parse_tsrx_utf16_with_options_and_observer(request, options, false, true, &mut work)?;
    Ok((result, work))
}

/// Parses exact UTF-16 TSRX for the compatibility transport while returning Stage 4 totals.
#[cfg(feature = "stage4-observer")]
#[doc(hidden)]
pub fn parse_tsrx_utf16_with_options_for_compat_transfer_observed(
    request: &TsrxUtf16ParseRequest<'_>,
    options: TsrxParseOptions<'_>,
) -> Result<(TsrxParseResult, Stage4WorkCounters), TsrxParseError> {
    let mut work = Stage4WorkCounters::default();
    let result =
        parse_tsrx_utf16_with_options_and_observer(request, options, true, false, &mut work)?;
    Ok((result, work))
}

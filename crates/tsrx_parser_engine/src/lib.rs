//! Canonical authored-TSRX reconstruction over allocator-contained OXC tapes.

mod entry;
mod error;
mod grammar_result;
mod lexical;
#[cfg(feature = "stage4-observer")]
mod observer;
mod parse_result;
mod pipeline;
mod projection;
mod reconstruct;
mod recovery;
mod request;
mod results;
mod source_bridge;
mod tape_index;
mod utf16_result;
mod utf16_route;

pub use entry::{
    parse_tsrx, parse_tsrx_utf16, parse_tsrx_utf16_with_options,
    parse_tsrx_utf16_with_options_for_compat_transfer, parse_tsrx_with_options,
    parse_tsrx_with_options_for_compat_transfer, parse_tsrx_with_options_for_transfer,
};
#[cfg(feature = "stage4-observer")]
pub use entry::{
    parse_tsrx_utf16_with_options_for_compat_transfer_observed,
    parse_tsrx_utf16_with_options_observed, parse_tsrx_with_options_for_compat_transfer_observed,
    parse_tsrx_with_options_for_transfer_observed, parse_tsrx_with_options_observed,
};
pub use error::TsrxParseError;
#[cfg(feature = "stage4-observer")]
pub use observer::Stage4WorkCounters;
pub use parse_result::TsrxParseResult;
pub use request::{TsrxParseOptions, TsrxParseRecovery, TsrxParseRequest, TsrxUtf16ParseRequest};

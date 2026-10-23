//! The type-aware lane: finding a supported tsgolint, and talking its documented protocol v2.

mod batch;
mod discovery;
mod error;
mod protocol;
mod tsconfig;

pub(crate) use batch::prepare_type_batch;
pub use discovery::SUPPORTED_TSGOLINT_VERSION;
pub(crate) use discovery::{find_tsgolint_executable, verify_tsgolint_version};
pub use error::{FramePart, TsgolintError};
pub(crate) use protocol::run_type_protocol;

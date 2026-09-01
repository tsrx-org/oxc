//! Restoring exact JavaScript UTF-16 into a result that was parsed from the bridged UTF-8
//! source, and mapping its spans back onto the caller's code units.

mod codeframe;
mod comments;
mod finalize;
mod ledger;
mod module_values;
mod observer;
mod program_values;
mod pua_markers;
mod reachability;
mod tape_fields;

pub(super) use finalize::finalize_utf16_result;
pub(super) use module_values::{forbidden_module_name_span, forbidden_rejection_module_name_span};
#[cfg(feature = "stage4-observer")]
pub(super) use observer::RepairCopyLane;
#[cfg(test)]
pub(super) use observer::Utf16Work;
pub(super) use observer::{NoopUtf16WorkObserver, Utf16WorkObserver};
pub(crate) use reachability::{program_reachable_objects, try_map_program_spans};

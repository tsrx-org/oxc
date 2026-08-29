mod builder;
mod format;
mod lift;
mod lint;
mod mapping;
mod marker;
mod types;

use std::borrow::Cow;

use crate::{diagnostics::ProjectionError, model::Overlay};

pub use format::{FormatProjection, project_for_format};
pub use lift::lift_formatted;
pub use lint::{project, project_for_lint};
pub use mapping::{MappedProjection, TypeProjection};
pub use types::project_for_types;

fn parser_overlay<'a>(
    source: &str,
    overlay: &'a Overlay,
) -> Result<Cow<'a, Overlay>, ProjectionError> {
    marker::validate_overlay_source(source, overlay)?;
    if overlay.has_parser_metadata() {
        Ok(Cow::Borrowed(overlay))
    } else {
        crate::scan_for_parser(source).map(Cow::Owned)
    }
}

use std::ops::Range;

use crate::{
    model::ByteSpan,
    projection_view::{ProjectionSegment, ProjectionView},
};

/// Legal TSX plus an affine map for ranges copied byte-for-byte from authored TSRX.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedProjection {
    pub(super) projected: String,
    pub(super) segments: Vec<ProjectionSegment>,
    pub(super) dynamic_prefix: Option<String>,
    pub(super) dynamic_count: u32,
    pub(super) dynamic_offsets: Vec<u32>,
    pub(super) dynamic_expressions: Vec<ByteSpan>,
    pub(super) synthetic_generator_spans: Vec<ByteSpan>,
    pub(super) synthetic_callee_spans: Vec<(u32, u32)>,
}

/// Legal TSX for TypeScript-Go plus an authored-byte map.
///
/// This is deliberately distinct from [`MappedProjection`]. The syntax-lint projection only has
/// to satisfy OXC's parser and built-in rules; the type projection also declares its synthetic
/// helpers so they cannot erase surrounding TypeScript types or create false missing-name errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeProjection {
    pub(super) projected: String,
    pub(super) segments: Vec<ProjectionSegment>,
}

impl TypeProjection {
    #[must_use]
    pub fn source(&self) -> &str {
        &self.projected
    }

    #[must_use]
    pub fn view(&self) -> ProjectionView<'_> {
        ProjectionView { source: &self.projected, segments: &self.segments }
    }

    /// Maps a diagnostic whose first and last bytes are both anchored in authored source.
    ///
    /// TypeScript diagnostics can span synthetic control scaffolding between two authored tokens.
    /// The endpoints must still map monotonically; diagnostics wholly inside generated helpers are
    /// rejected.
    #[must_use]
    pub fn map_range(&self, range: Range<u32>) -> Option<Range<u32>> {
        if range.start > range.end {
            return None;
        }
        if range.is_empty() {
            return self.map_endpoint(range.start, true).map(|point| point..point);
        }
        let start = self.map_endpoint(range.start, true)?;
        let end = self.map_endpoint(range.end, false)?;
        (start <= end).then_some(start..end)
    }

    /// Maps a fix only when the complete edit is one unchanged affine authored segment.
    #[must_use]
    pub fn map_fix_range(&self, range: Range<u32>) -> Option<Range<u32>> {
        map_single_segment(&self.segments, range, true)
    }

    fn map_endpoint(&self, point: u32, start: bool) -> Option<u32> {
        self.segments.iter().find_map(|segment| {
            let contains = if start {
                segment.projected.start <= point && point < segment.projected.end
            } else {
                segment.projected.start < point && point <= segment.projected.end
            };
            contains.then(|| segment.original_start + (point - segment.projected.start))
        })
    }
}

impl MappedProjection {
    #[must_use]
    pub fn source(&self) -> &str {
        &self.projected
    }

    #[must_use]
    pub fn view(&self) -> ProjectionView<'_> {
        ProjectionView { source: &self.projected, segments: &self.segments }
    }

    /// Maps a projected range only when every byte belongs to one unchanged authored segment.
    #[must_use]
    pub fn map_range(&self, range: Range<u32>) -> Option<Range<u32>> {
        self.map_range_with(range, false)
    }

    /// Maps a projected fix only when it is affine and cannot invalidate a paired dynamic name.
    #[must_use]
    pub fn map_fix_range(&self, range: Range<u32>) -> Option<Range<u32>> {
        self.map_range_with(range, true)
    }

    fn map_range_with(&self, range: Range<u32>, require_fixable: bool) -> Option<Range<u32>> {
        map_single_segment(&self.segments, range, require_fixable)
    }

    /// Returns the collision-free synthetic dynamic-tag namespace and expected tag count.
    #[must_use]
    pub fn dynamic_contract(&self) -> Option<(&str, u32, &[u32])> {
        if self.dynamic_count == 0 {
            return None;
        }
        self.dynamic_prefix
            .as_deref()
            .map(|prefix| (prefix, self.dynamic_count, self.dynamic_offsets.as_slice()))
    }

    /// The authored span of each dynamic tag's name expression, by scaffold ordinal.
    ///
    /// A report on a dynamic tag expression whose ends cannot be mapped on their own still
    /// belongs to one of these, which is where the parser lane reports it too.
    #[must_use]
    pub fn dynamic_expression_spans(&self) -> &[ByteSpan] {
        &self.dynamic_expressions
    }

    /// Collision-free marker namespace used by the parser-only reconstruction lane.
    #[must_use]
    pub fn parser_marker_prefix(&self) -> Option<&str> {
        self.dynamic_prefix.as_deref()
    }

    /// Returns true when an authored range belongs to a generator introduced only as projection
    /// scaffolding. Generator-specific built-in diagnostics in these ranges are synthetic.
    #[must_use]
    pub fn is_synthetic_generator_range(&self, range: Range<u32>) -> bool {
        self.synthetic_generator_spans.iter().any(|span| span.intersects(range.start, range.end))
    }

    /// Projected byte spans of helper callees introduced by this projection.
    #[must_use]
    pub fn synthetic_callee_spans(&self) -> &[(u32, u32)] {
        &self.synthetic_callee_spans
    }
}

fn map_single_segment(
    segments: &[ProjectionSegment],
    range: Range<u32>,
    require_fixable: bool,
) -> Option<Range<u32>> {
    if range.start > range.end {
        return None;
    }
    segments.iter().find_map(|segment| {
        if require_fixable && !segment.fixable {
            return None;
        }
        let inside = if range.is_empty() {
            segment.projected.start < range.start && range.start < segment.projected.end
        } else {
            segment.projected.start <= range.start && range.end <= segment.projected.end
        };
        inside.then(|| {
            let start = segment.original_start + (range.start - segment.projected.start);
            start..start + (range.end - range.start)
        })
    })
}

#[cfg(all(test, target_pointer_width = "64"))]
mod layout_tests {
    use std::mem::size_of;

    use crate::projection_view::ProjectionSegment;

    #[test]
    fn map_segment_layout_remains_compact() {
        assert_eq!(size_of::<ProjectionSegment>(), 16);
    }
}

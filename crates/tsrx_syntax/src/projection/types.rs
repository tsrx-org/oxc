use std::fmt::Write as _;

use crate::{
    diagnostics::ProjectionError,
    model::{ControlContext, ControlKind, Overlay},
};

use super::{
    builder::{ProjectionPurpose, build_projection_with_purpose},
    mapping::TypeProjection,
    parser_overlay,
};

/// Builds the Rust-native TypeScript-Go projection.
///
/// Synthetic helpers are declared after the projected module. Keeping the declarations at the end
/// preserves every authored/scaffold offset shared with the normal syntax-lint projection, which
/// lets one OXC parse supply disable-directive spans without a second parser pass.
/// A base [`crate::scan`] overlay is upgraded for compatibility; hot paths
/// should pass [`crate::scan_for_parser`] output.
///
/// # Errors
///
/// Returns an error for a stale overlay or a projection scaffold collision.
pub fn project_for_types(
    source: &str,
    overlay: &Overlay,
) -> Result<TypeProjection, ProjectionError> {
    let overlay = parser_overlay(source, overlay)?;
    let overlay = overlay.as_ref();
    let built = build_projection_with_purpose(source, overlay, true, ProjectionPurpose::Types)?;
    let mut projected = built.mapped.projected;
    append_type_helper_declarations(&mut projected, overlay, &built.prefix);
    Ok(TypeProjection { projected, segments: built.mapped.segments })
}

fn append_type_helper_declarations(output: &mut String, overlay: &Overlay, prefix: &str) {
    if overlay.nodes.is_empty()
        && overlay.dynamic_tags.is_empty()
        && overlay.clauses.iter().all(|clause| !clause.for_header.annotated)
    {
        return;
    }
    output.push_str("\n/* OXC for TSRX type-only projection helpers. */\n");
    for (index, node) in overlay.nodes.iter().enumerate() {
        if node.context != ControlContext::Statement {
            writeln!(output, "declare function {prefix}W{index}_<T>(value: T, end: unknown): any;")
                .expect("writing to a String cannot fail");
            writeln!(output, "declare const {prefix}E{index}_: unique symbol;")
                .expect("writing to a String cannot fail");
        }
        if node.kind == ControlKind::Try {
            writeln!(
                output,
                "declare function {prefix}T{index}_(value: {{ {prefix}B{index}_(): AsyncGenerator<unknown>; {prefix}P{index}_?(): AsyncGenerator<unknown>; {prefix}C{index}_?(error: unknown, reset: () => void): AsyncGenerator<unknown>; }}, end: unknown): any;"
            )
            .expect("writing to a String cannot fail");
            writeln!(output, "declare const {prefix}TE{index}_: unique symbol;")
                .expect("writing to a String cannot fail");
        }
    }
    for (ordinal, clause) in
        overlay.clauses.iter().filter(|clause| clause.for_header.annotated).enumerate()
    {
        writeln!(
            output,
            "declare function {prefix}H{ordinal}_<T>(value: T, ...metadata: unknown[]): T;"
        )
        .expect("writing to a String cannot fail");
        if !clause.for_header.index.is_empty() {
            writeln!(output, "declare function {prefix}IH{ordinal}_<T>(value: T): T;")
                .expect("writing to a String cannot fail");
        }
        if !clause.for_header.key.is_empty() {
            writeln!(output, "declare function {prefix}KH{ordinal}_<T>(value: T): T;")
                .expect("writing to a String cannot fail");
        }
        writeln!(output, "declare const {prefix}HE{ordinal}_: unique symbol;")
            .expect("writing to a String cannot fail");
    }
    for index in 0..overlay.dynamic_tags.len() {
        writeln!(output, "declare const {prefix}D{index}: any;")
            .expect("writing to a String cannot fail");
    }
}

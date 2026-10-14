use crate::{diagnostics::ProjectionError, model::Overlay, scanner::source_fingerprint};

pub(super) fn validate_overlay_source(
    source: &str,
    overlay: &Overlay,
) -> Result<(), ProjectionError> {
    if source.len() != overlay.source_len as usize
        || source_fingerprint(source.as_bytes()) != overlay.source_fingerprint
    {
        return Err(ProjectionError::SourceChanged { offset: 0 });
    }
    Ok(())
}

pub(super) fn structural_fingerprint(overlay: &Overlay) -> u128 {
    let mut first = 0x517c_c1b7_2722_0a95_u64;
    let mut second = 0x6eed_0e9d_a4d9_4a4f_u64;
    let mut mix = |value: u64| {
        first = (first ^ value).wrapping_mul(0x9e37_79b1_85eb_ca87).rotate_left(23);
        second =
            (second ^ value.rotate_left(29)).wrapping_mul(0xc2b2_ae3d_27d4_eb4f).rotate_left(31);
    };
    mix(overlay.tokens.len() as u64);
    for token in &overlay.tokens {
        mix((u64::from(token.owner) << 8) | token.kind as u64);
    }
    mix(overlay.nodes.len() as u64);
    for node in &overlay.nodes {
        mix((u64::from(node.parent) << 16) | ((node.kind as u64) << 8) | node.context as u64);
    }
    mix(overlay.clauses.len() as u64);
    for clause in &overlay.clauses {
        let flags = u64::from(clause.for_header.annotated)
            | (u64::from(clause.for_header.r#await) << 1)
            | (u64::from(!clause.for_header.index.is_empty()) << 2)
            | (u64::from(!clause.for_header.key.is_empty()) << 3)
            | (u64::from(!clause.header.is_empty()) << 4)
            | (u64::from(clause.bindings) << 5);
        mix(((clause.role as u64) << 8) | flags);
    }
    mix(overlay.embedded_tokens.len() as u64);
    for token in &overlay.embedded_tokens {
        mix((u64::from(token.owner) << 8) | token.kind as u64);
    }
    mix(overlay.dynamic_tags.len() as u64);
    for tag in &overlay.dynamic_tags {
        let flags =
            u64::from(tag.self_closing) | (u64::from(!tag.closing_expression.is_empty()) << 1);
        mix(flags);
    }
    mix(overlay.style_blocks.len() as u64);
    mix(overlay.jsx_text_gts.len() as u64);
    mix(overlay.case_expressions.len() as u64);
    (u128::from(first) << 64) | u128::from(second)
}

pub(super) fn collision_free_prefix(source: &str) -> Result<String, ProjectionError> {
    for nonce in 0..=1024_u16 {
        let prefix = format!("_t{nonce:x}_");
        if !source.contains(&prefix) {
            return Ok(prefix);
        }
    }
    Err(ProjectionError::MarkerSpaceExhausted)
}

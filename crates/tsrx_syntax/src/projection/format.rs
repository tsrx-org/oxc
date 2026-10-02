use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, ControlContext, NONE, Overlay, ParserCodeBlock, ParserShorthandAttribute,
        StructuralKind,
    },
};

use super::{builder::build_projection, marker::structural_fingerprint, parser_overlay};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WrapperManifest {
    pub(super) node: u32,
    pub(super) context: ControlContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct HeaderManifest {
    pub(super) ordinal: u32,
    pub(super) has_index: bool,
    pub(super) has_key: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TokenManifest {
    pub(super) kind: StructuralKind,
    pub(super) owner: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TryManifest {
    pub(super) node: u32,
    pub(super) context: ControlContext,
    pub(super) flags: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DynamicManifest {
    pub(super) self_closing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct StyleManifest {
    pub(super) payload: ByteSpan,
}

/// What separates a comment in JSX text from its neighbour on one side, as authored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Gap {
    Glued,
    Spaced,
    Layout,
}

fn gap(spaces: usize, next: Option<char>) -> Gap {
    match next {
        None | Some('\n' | '\r') => Gap::Layout,
        _ if spaces > 0 => Gap::Spaced,
        _ => Gap::Glued,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ScriptManifest {
    pub(super) payload: ByteSpan,
}

impl TryManifest {
    pub(super) const HAS_PENDING: u8 = 1;
    pub(super) const HAS_CATCH: u8 = 1 << 1;
    pub(super) const CATCH_HAS_HEADER: u8 = 1 << 2;
    pub(super) const AUTHORED_SEMICOLON: u8 = 1 << 3;

    pub(super) const fn has_pending(self) -> bool {
        self.flags & Self::HAS_PENDING != 0
    }

    pub(super) const fn has_catch(self) -> bool {
        self.flags & Self::HAS_CATCH != 0
    }

    pub(super) const fn catch_has_header(self) -> bool {
        self.flags & Self::CATCH_HAS_HEADER != 0
    }

    pub(super) const fn authored_semicolon(self) -> bool {
        self.flags & Self::AUTHORED_SEMICOLON != 0
    }
}

/// Legal TSX plus the compact manifest required to lift canonical Oxfmt output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatProjection {
    projected: String,
    pub(super) prefix: String,
    pub(super) tokens: Vec<TokenManifest>,
    pub(super) wrappers: Vec<WrapperManifest>,
    pub(super) headers: Vec<HeaderManifest>,
    pub(super) tries: Vec<TryManifest>,
    pub(super) try_slots: Vec<u32>,
    pub(super) dynamics: Vec<DynamicManifest>,
    dynamic_count: u32,
    dynamic_offsets: Vec<u32>,
    pub(super) dynamic_comments: Vec<ByteSpan>,
    pub(super) styles: Vec<StyleManifest>,
    pub(super) scripts: Vec<ScriptManifest>,
    /// What the author wrote before and after each comment in JSX text, which the projection
    /// wrote in marked braces.
    pub(super) text_comments: Vec<[Gap; 2]>,
    /// How many `>` in JSX text the projection wrote as [`Self::gt_stand_in`].
    pub(super) text_gts: usize,
    /// How many `@case` and `@default` expression containers the projection wrote in marked
    /// elements.
    pub(super) case_expressions: usize,
    /// The private-use character written for each `>` in JSX text, which the source never holds.
    pub(super) gt_stand_in: char,
    pub(super) parser_code_blocks: Vec<ParserCodeBlock>,
    pub(super) parser_shorthand_attributes: Vec<ParserShorthandAttribute>,
    /// Each shorthand attribute's authored name, which the lift writes back for a reserved word.
    pub(super) shorthand_names: Vec<String>,
    pub(super) shape_fingerprint: u128,
}

impl FormatProjection {
    #[must_use]
    pub fn source(&self) -> &str {
        &self.projected
    }

    #[must_use]
    pub fn marker_count(&self) -> usize {
        self.tokens.len()
            + self.dynamics.len()
            + self.dynamic_comments.len()
            + self.styles.len()
            + self.scripts.len()
            + self.text_comments.len()
            + self.text_gts
            + self.case_expressions
            + self.parser_code_blocks.len()
            + self.parser_shorthand_attributes.len()
    }

    #[must_use]
    pub fn style_count(&self) -> usize {
        self.styles.len()
    }

    /// Returns the collision-free synthetic dynamic-tag namespace and expected tag count.
    #[must_use]
    pub fn dynamic_contract(&self) -> Option<(&str, u32, &[u32])> {
        (!self.dynamics.is_empty()).then_some((
            self.prefix.as_str(),
            self.dynamic_count,
            self.dynamic_offsets.as_slice(),
        ))
    }
}

/// Builds a legal-TSX formatter projection and checked lift manifest.
///
/// A base [`crate::scan`] overlay is upgraded to the richer parser/tooling
/// overlay for compatibility. Hot paths should pass [`crate::scan_for_parser`]
/// output to avoid a second scan.
///
/// # Errors
///
/// Returns an error for a stale overlay or a projection scaffold collision.
pub fn project_for_format(
    source: &str,
    overlay: &Overlay,
) -> Result<FormatProjection, ProjectionError> {
    let overlay = parser_overlay(source, overlay)?;
    let overlay = overlay.as_ref();
    let built = build_projection(source, overlay, false)?;
    let mut try_slots = vec![NONE; overlay.nodes.len()];
    for (slot, manifest) in built.tries.iter().enumerate() {
        try_slots[manifest.node as usize] = to_u32(slot)?;
    }
    let styles =
        overlay.style_blocks.iter().map(|style| StyleManifest { payload: style.content }).collect();
    let scripts = overlay
        .script_blocks
        .iter()
        .map(|script| ScriptManifest { payload: script.content })
        .collect();
    let dynamic_count = to_u32(overlay.dynamic_tags.len())?;
    Ok(FormatProjection {
        projected: built.mapped.projected,
        prefix: built.prefix,
        tokens: overlay
            .tokens
            .iter()
            .map(|token| TokenManifest { kind: token.kind, owner: token.owner })
            .collect(),
        wrappers: built.wrappers,
        headers: built.headers,
        tries: built.tries,
        try_slots,
        dynamics: overlay
            .dynamic_tags
            .iter()
            .map(|tag| DynamicManifest { self_closing: tag.self_closing })
            .collect(),
        dynamic_count,
        dynamic_offsets: overlay.dynamic_tags.iter().map(|tag| tag.expression.start).collect(),
        dynamic_comments: overlay.dynamic_comments.clone(),
        styles,
        scripts,
        text_comments: overlay
            .jsx_text_comments
            .iter()
            .map(|comment| {
                let (before, after) =
                    (&source[..comment.start as usize], &source[comment.end as usize..]);
                let (left, right) =
                    (before.trim_end_matches([' ', '\t']), after.trim_start_matches([' ', '\t']));
                [
                    gap(before.len() - left.len(), left.chars().next_back()),
                    gap(0, right.chars().next()),
                ]
            })
            .collect(),
        text_gts: overlay.jsx_text_gts.len(),
        case_expressions: overlay.case_expressions.len(),
        gt_stand_in: built.gt_stand_in,
        parser_code_blocks: overlay.parser_code_blocks.clone(),
        parser_shorthand_attributes: overlay.parser_shorthand_attributes.clone(),
        shorthand_names: overlay
            .parser_shorthand_attributes
            .iter()
            .map(|attribute| {
                source
                    .get(attribute.identifier.start as usize..attribute.identifier.end as usize)
                    .map(str::to_owned)
                    .ok_or(ProjectionError::SourceChanged { offset: attribute.identifier.start })
            })
            .collect::<Result<_, _>>()?,
        shape_fingerprint: structural_fingerprint(overlay),
    })
}

#[cfg(all(test, target_pointer_width = "64"))]
mod layout_tests {
    use std::mem::size_of;

    use super::{
        DynamicManifest, HeaderManifest, ScriptManifest, StyleManifest, TokenManifest, TryManifest,
        WrapperManifest,
    };

    #[test]
    fn manifest_layouts_remain_compact() {
        assert_eq!(size_of::<WrapperManifest>(), 8);
        assert_eq!(size_of::<HeaderManifest>(), 8);
        assert_eq!(size_of::<TokenManifest>(), 8);
        assert_eq!(size_of::<TryManifest>(), 8);
        assert_eq!(size_of::<DynamicManifest>(), 1);
        assert_eq!(size_of::<StyleManifest>(), 8);
        assert_eq!(size_of::<ScriptManifest>(), 8);
    }
}

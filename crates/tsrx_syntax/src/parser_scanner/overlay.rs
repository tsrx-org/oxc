//! Recording into the overlay, and the checkpoint/rollback that lets a speculative construct be
//! abandoned without leaving half-built nodes behind.

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, Clause, ClauseRole, ControlContext, ControlKind, ForHeader, NONE, Overlay,
        StructuralKind, StructuralToken, SyntaxNode,
    },
};

use super::Scanner;

#[derive(Clone, Copy)]
pub(super) struct Checkpoint {
    pub(super) tokens: usize,
    pub(super) nodes: usize,
    pub(super) clauses: usize,
    pub(super) embedded_tokens: usize,
    pub(super) parser_dynamic_tokens: usize,
    pub(super) parser_code_blocks: usize,
    pub(super) parser_shorthand_attributes: usize,
    pub(super) parser_lazy_patterns: usize,
    pub(super) dynamic_tags: usize,
    pub(super) dynamic_comments: usize,
    pub(super) style_blocks: usize,
    pub(super) script_blocks: usize,
    pub(super) statement_boundaries: usize,
    pub(super) first_root: u32,
    pub(super) last_root: u32,
    parent: Option<(usize, u32, u32)>,
    probe_changes: usize,
}
impl Scanner<'_> {
    pub(super) fn into_overlay(self, source_len: u32) -> Overlay {
        Overlay {
            source_len,
            source_fingerprint: source_fingerprint(self.bytes),
            parser_metadata: true,
            tokens: self.tokens,
            nodes: self.nodes,
            clauses: self.clauses,
            embedded_tokens: self.embedded_tokens,
            parser_dynamic_tokens: self.parser_dynamic_tokens,
            parser_code_blocks: self.parser_code_blocks,
            parser_shorthand_attributes: self.parser_shorthand_attributes,
            parser_lazy_patterns: self.parser_lazy_patterns,
            dynamic_tags: self.dynamic_tags,
            dynamic_comments: self.dynamic_comments,
            style_blocks: self.style_blocks,
            script_blocks: self.script_blocks,
            statement_boundaries: self.statement_boundaries,
            first_root: self.first_root,
            last_root: self.last_root,
        }
    }

    pub(super) fn begin_node(
        &mut self,
        kind: ControlKind,
        context: ControlContext,
        start: usize,
    ) -> Result<u32, ProjectionError> {
        let index = to_u32(self.nodes.len())?;
        let parent = self.parents.last().copied().unwrap_or(NONE);
        self.nodes.push(SyntaxNode {
            kind,
            context,
            span: ByteSpan::new(to_u32(start)?, to_u32(start)?),
            parent,
            first_child: NONE,
            last_child: NONE,
            next_sibling: NONE,
            first_clause: NONE,
            last_clause: NONE,
        });
        if parent == NONE {
            if self.first_root == NONE {
                self.first_root = index;
            } else {
                self.nodes[self.last_root as usize].next_sibling = index;
            }
            self.last_root = index;
        } else {
            let parent_index = parent as usize;
            let previous = self.nodes[parent_index].last_child;
            if previous == NONE {
                self.nodes[parent_index].first_child = index;
            } else {
                self.nodes[previous as usize].next_sibling = index;
            }
            self.nodes[parent_index].last_child = index;
        }
        Ok(index)
    }

    pub(super) fn add_clause(
        &mut self,
        node: u32,
        role: ClauseRole,
        keyword_start: usize,
        header: ByteSpan,
        body: ByteSpan,
        for_header: ForHeader,
    ) -> Result<u32, ProjectionError> {
        self.add_clause_with_bindings(node, role, keyword_start, header, body, for_header, 0)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "one parameter per binding slot the overlay clause records"
    )]
    pub(super) fn add_clause_with_bindings(
        &mut self,
        node: u32,
        role: ClauseRole,
        keyword_start: usize,
        header: ByteSpan,
        body: ByteSpan,
        for_header: ForHeader,
        bindings: u8,
    ) -> Result<u32, ProjectionError> {
        let index = to_u32(self.clauses.len())?;
        self.clauses.push(Clause {
            role,
            keyword: ByteSpan::new(to_u32(keyword_start)?, to_u32(keyword_start + 1)?),
            header,
            body,
            for_header,
            bindings,
            next: NONE,
        });
        let node_index = node as usize;
        let previous = self.nodes[node_index].last_clause;
        if previous == NONE {
            self.nodes[node_index].first_clause = index;
        } else {
            self.clauses[previous as usize].next = index;
        }
        self.nodes[node_index].last_clause = index;
        Ok(index)
    }

    pub(super) fn push_token(
        &mut self,
        kind: StructuralKind,
        index: usize,
    ) -> Result<(), ProjectionError> {
        let start = to_u32(index)?;
        self.tokens.push(StructuralToken {
            kind,
            span: ByteSpan::new(start, start + 1),
            owner: self.parents.last().copied().unwrap_or(NONE),
        });
        Ok(())
    }

    pub(super) fn checkpoint(&self) -> Checkpoint {
        let parent = self.parents.last().copied().map(|index| {
            let node = self.nodes[index as usize];
            (index as usize, node.first_child, node.last_child)
        });
        Checkpoint {
            tokens: self.tokens.len(),
            nodes: self.nodes.len(),
            clauses: self.clauses.len(),
            embedded_tokens: self.embedded_tokens.len(),
            parser_dynamic_tokens: self.parser_dynamic_tokens.len(),
            parser_code_blocks: self.parser_code_blocks.len(),
            parser_shorthand_attributes: self.parser_shorthand_attributes.len(),
            parser_lazy_patterns: self.parser_lazy_patterns.len(),
            dynamic_tags: self.dynamic_tags.len(),
            dynamic_comments: self.dynamic_comments.len(),
            style_blocks: self.style_blocks.len(),
            script_blocks: self.script_blocks.len(),
            statement_boundaries: self.statement_boundaries.len(),
            first_root: self.first_root,
            last_root: self.last_root,
            parent,
            probe_changes: self
                .surrogate_probes
                .as_deref()
                .map_or(0, |probes| probes.borrow().changes.len()),
        }
    }

    pub(super) fn rollback(&mut self, checkpoint: Checkpoint) {
        self.tokens.truncate(checkpoint.tokens);
        self.nodes.truncate(checkpoint.nodes);
        self.clauses.truncate(checkpoint.clauses);
        self.embedded_tokens.truncate(checkpoint.embedded_tokens);
        self.parser_dynamic_tokens.truncate(checkpoint.parser_dynamic_tokens);
        self.parser_code_blocks.truncate(checkpoint.parser_code_blocks);
        self.parser_shorthand_attributes.truncate(checkpoint.parser_shorthand_attributes);
        self.parser_lazy_patterns.truncate(checkpoint.parser_lazy_patterns);
        self.dynamic_tags.truncate(checkpoint.dynamic_tags);
        self.dynamic_comments.truncate(checkpoint.dynamic_comments);
        self.style_blocks.truncate(checkpoint.style_blocks);
        self.script_blocks.truncate(checkpoint.script_blocks);
        self.statement_boundaries.truncate(checkpoint.statement_boundaries);
        if let Some(probes) = self.surrogate_probes.as_deref() {
            probes.borrow_mut().rollback(checkpoint.probe_changes);
        }
        self.first_root = checkpoint.first_root;
        self.last_root = checkpoint.last_root;
        if let Some((index, first_child, last_child)) = checkpoint.parent {
            self.nodes[index].first_child = first_child;
            self.nodes[index].last_child = last_child;
            if last_child != NONE {
                self.nodes[last_child as usize].next_sibling = NONE;
            }
        } else if self.last_root != NONE {
            self.nodes[self.last_root as usize].next_sibling = NONE;
        }
    }
}

pub(crate) fn source_fingerprint(bytes: &[u8]) -> u128 {
    let mut first = 0x9e37_79b1_85eb_ca87_u64 ^ bytes.len() as u64;
    let mut second = 0xc2b2_ae3d_27d4_eb4f_u64 ^ (bytes.len() as u64).rotate_left(17);
    for chunk in bytes.chunks(8) {
        let mut word = [0_u8; 8];
        word[..chunk.len()].copy_from_slice(chunk);
        let value = u64::from_le_bytes(word);
        first = (first ^ value).wrapping_mul(0x9e37_79b1_85eb_ca87).rotate_left(27);
        second =
            (second ^ value.rotate_left(31)).wrapping_mul(0xc2b2_ae3d_27d4_eb4f).rotate_left(33);
    }
    (u128::from(first) << 64) | u128::from(second)
}

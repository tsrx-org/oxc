#[derive(Clone, Copy)]
pub(super) struct Checkpoint {
    tokens: usize,
    nodes: usize,
    clauses: usize,
    embedded_tokens: usize,
    dynamic_tags: usize,
    dynamic_comments: usize,
    style_blocks: usize,
    statement_boundaries: usize,
    first_root: u32,
    last_root: u32,
    last_markup_end: usize,
    parent: Option<(usize, u32, u32)>,
}

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, Clause, ClauseRole, ControlContext, ControlKind, ForHeader, NONE, StructuralKind,
        StructuralToken, SyntaxNode,
    },
};

use super::Scanner;

impl Scanner<'_> {
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
            dynamic_tags: self.dynamic_tags.len(),
            dynamic_comments: self.dynamic_comments.len(),
            style_blocks: self.style_blocks.len(),
            statement_boundaries: self.statement_boundaries.len(),
            first_root: self.first_root,
            last_root: self.last_root,
            last_markup_end: self.last_markup_end,
            parent,
        }
    }

    pub(super) fn rollback(&mut self, checkpoint: Checkpoint) {
        self.tokens.truncate(checkpoint.tokens);
        self.nodes.truncate(checkpoint.nodes);
        self.clauses.truncate(checkpoint.clauses);
        self.embedded_tokens.truncate(checkpoint.embedded_tokens);
        self.dynamic_tags.truncate(checkpoint.dynamic_tags);
        self.dynamic_comments.truncate(checkpoint.dynamic_comments);
        self.style_blocks.truncate(checkpoint.style_blocks);
        self.statement_boundaries.truncate(checkpoint.statement_boundaries);
        self.first_root = checkpoint.first_root;
        self.last_root = checkpoint.last_root;
        self.last_markup_end = checkpoint.last_markup_end;
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

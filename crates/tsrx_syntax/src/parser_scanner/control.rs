//! The four control constructs, each recorded as one node plus the clauses its header and bodies
//! occupy.

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{ByteSpan, ClauseRole, ControlContext, ControlKind, ForHeader, StructuralKind},
};

use super::Scanner;

impl Scanner<'_> {
    pub(super) fn parse_if(
        &mut self,
        start: usize,
        context: ControlContext,
    ) -> Result<usize, ProjectionError> {
        let node = self.begin_node(ControlKind::If, context, start)?;
        self.parents.push(node);
        let result = self.parse_if_clauses(node, start);
        self.parents.pop();
        let end = result?;
        self.nodes[node as usize].span.end = to_u32(end)?;
        Ok(end)
    }

    fn parse_if_clauses(&mut self, node: u32, start: usize) -> Result<usize, ProjectionError> {
        self.push_token(StructuralKind::If, start)?;
        let mut index = Self::after_keyword(start, b"if");
        index = self.skip_trivia(index)?;
        let (header, after_header) = self.parse_parenthesized(index)?;
        index = self.skip_trivia(after_header)?;
        let body = self.parse_body(node, index)?;
        self.add_clause(node, ClauseRole::If, start, header, body, ForHeader::default())?;
        index = body.end as usize;

        loop {
            let clause_start = self.skip_trivia(index)?;
            if self.keyword_at(clause_start, b"else") {
                self.push_token(StructuralKind::Else, clause_start)?;
                let mut after_else = Self::after_keyword(clause_start, b"else");
                after_else = self.skip_trivia(after_else)?;
                if self.bare_keyword_at(after_else, b"if") {
                    let keyword_end = Self::after_bare_keyword(after_else, b"if");
                    let header_start = self.skip_trivia(keyword_end)?;
                    let (header, after_header) = self.parse_parenthesized(header_start)?;
                    let body_start = self.skip_trivia(after_header)?;
                    let body = self.parse_body(node, body_start)?;
                    self.add_clause(
                        node,
                        ClauseRole::ElseIf,
                        clause_start,
                        header,
                        body,
                        ForHeader::default(),
                    )?;
                    index = body.end as usize;
                    continue;
                }
                let body = self.parse_body(node, after_else)?;
                self.add_clause(
                    node,
                    ClauseRole::Else,
                    clause_start,
                    ByteSpan::default(),
                    body,
                    ForHeader::default(),
                )?;
                return Ok(body.end as usize);
            }
            if self.bare_keyword_at(clause_start, b"else") {
                return Err(ProjectionError::MalformedSyntax {
                    offset: to_u32(clause_start)?,
                    expected: "`@else`",
                });
            }
            return Ok(index);
        }
    }

    pub(super) fn parse_for(
        &mut self,
        start: usize,
        context: ControlContext,
    ) -> Result<usize, ProjectionError> {
        let node = self.begin_node(ControlKind::For, context, start)?;
        self.parents.push(node);
        let result = self.parse_for_parts(node, start);
        self.parents.pop();
        let end = result?;
        self.nodes[node as usize].span.end = to_u32(end)?;
        Ok(end)
    }

    fn parse_for_parts(&mut self, node: u32, start: usize) -> Result<usize, ProjectionError> {
        self.push_token(StructuralKind::For, start)?;
        let mut index = Self::after_keyword(start, b"for");
        index = self.skip_trivia(index)?;
        let mut is_await = false;
        if self.bare_keyword_at(index, b"await") {
            is_await = true;
            index = self.skip_trivia(Self::after_bare_keyword(index, b"await"))?;
        }
        self.register_lazy_loop_target(index)?;
        let (header, after_header) = self.parse_parenthesized(index)?;
        let mut for_header = self.analyze_for_header(header)?;
        for_header.r#await = is_await;
        index = self.skip_trivia(after_header)?;
        let body = self.parse_body(node, index)?;
        self.add_clause(node, ClauseRole::For, start, header, body, for_header)?;
        index = body.end as usize;

        let clause_start = self.skip_trivia(index)?;
        if self.keyword_at(clause_start, b"empty") {
            self.push_token(StructuralKind::Empty, clause_start)?;
            let body_start = self.skip_trivia(Self::after_keyword(clause_start, b"empty"))?;
            let empty_body = self.parse_body(node, body_start)?;
            self.add_clause(
                node,
                ClauseRole::Empty,
                clause_start,
                ByteSpan::default(),
                empty_body,
                ForHeader::default(),
            )?;
            return Ok(empty_body.end as usize);
        }
        if self.bare_keyword_at(clause_start, b"empty") {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(clause_start)?,
                expected: "`@empty`",
            });
        }
        Ok(index)
    }

    pub(super) fn parse_switch(
        &mut self,
        start: usize,
        context: ControlContext,
    ) -> Result<usize, ProjectionError> {
        let node = self.begin_node(ControlKind::Switch, context, start)?;
        self.parents.push(node);
        let result = self.parse_switch_parts(node, start);
        self.parents.pop();
        let end = result?;
        self.nodes[node as usize].span.end = to_u32(end)?;
        Ok(end)
    }

    fn parse_switch_parts(&mut self, node: u32, start: usize) -> Result<usize, ProjectionError> {
        self.push_token(StructuralKind::Switch, start)?;
        let header_start = self.skip_trivia(Self::after_keyword(start, b"switch"))?;
        let (_, after_header) = self.parse_parenthesized(header_start)?;
        let mut index = self.skip_trivia(after_header)?;
        if self.bytes.get(index) != Some(&b'{') {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(index)?,
                expected: "a braced `@switch` body",
            });
        }
        index += 1;
        let mut saw_default = false;
        loop {
            index = self.skip_trivia(index)?;
            if self.bytes.get(index) == Some(&b'}') {
                return Ok(index + 1);
            }
            if self.keyword_at(index, b"case") {
                self.push_token(StructuralKind::Case, index)?;
                let value_start = self.skip_trivia(Self::after_keyword(index, b"case"))?;
                let (header, colon) = self.parse_case_header(value_start)?;
                let body_start = self.skip_trivia(colon + 1)?;
                let body = self.parse_body(node, body_start)?;
                self.add_clause(node, ClauseRole::Case, index, header, body, ForHeader::default())?;
                index = body.end as usize;
                continue;
            }
            if self.keyword_at(index, b"default") {
                if saw_default {
                    return Err(ProjectionError::MalformedSyntax {
                        offset: to_u32(index)?,
                        expected: "only one `@default` clause",
                    });
                }
                saw_default = true;
                self.push_token(StructuralKind::Default, index)?;
                let colon = self.skip_trivia(Self::after_keyword(index, b"default"))?;
                if self.bytes.get(colon) != Some(&b':') {
                    return Err(ProjectionError::MalformedSyntax {
                        offset: to_u32(colon)?,
                        expected: "`:` after `@default`",
                    });
                }
                let body_start = self.skip_trivia(colon + 1)?;
                let body = self.parse_body(node, body_start)?;
                self.add_clause(
                    node,
                    ClauseRole::Default,
                    index,
                    ByteSpan::default(),
                    body,
                    ForHeader::default(),
                )?;
                index = body.end as usize;
                continue;
            }
            if self.bare_keyword_at(index, b"case") || self.bare_keyword_at(index, b"default") {
                return Err(ProjectionError::MalformedSyntax {
                    offset: to_u32(index)?,
                    expected: "an `@case` or `@default` clause",
                });
            }
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(index)?,
                expected: "an `@case`, `@default`, or closing `}`",
            });
        }
    }

    pub(super) fn parse_try(
        &mut self,
        start: usize,
        context: ControlContext,
    ) -> Result<usize, ProjectionError> {
        let node = self.begin_node(ControlKind::Try, context, start)?;
        self.parents.push(node);
        let result = self.parse_try_parts(node, start);
        self.parents.pop();
        let end = result?;
        self.nodes[node as usize].span.end = to_u32(end)?;
        Ok(end)
    }

    fn parse_try_parts(&mut self, node: u32, start: usize) -> Result<usize, ProjectionError> {
        self.push_token(StructuralKind::Try, start)?;
        let body_start = self.skip_trivia(Self::after_keyword(start, b"try"))?;
        let body = self.parse_body(node, body_start)?;
        self.add_clause(
            node,
            ClauseRole::Try,
            start,
            ByteSpan::default(),
            body,
            ForHeader::default(),
        )?;
        let mut index = body.end as usize;
        let mut has_pending = false;
        let mut has_catch = false;

        let pending_start = self.skip_trivia(index)?;
        if self.keyword_at(pending_start, b"pending") {
            has_pending = true;
            self.push_token(StructuralKind::Pending, pending_start)?;
            let pending_body_start =
                self.skip_trivia(Self::after_keyword(pending_start, b"pending"))?;
            let pending_body = self.parse_body(node, pending_body_start)?;
            self.add_clause(
                node,
                ClauseRole::Pending,
                pending_start,
                ByteSpan::default(),
                pending_body,
                ForHeader::default(),
            )?;
            index = pending_body.end as usize;
        } else if self.bare_keyword_at(pending_start, b"pending") {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(pending_start)?,
                expected: "`@pending`",
            });
        }

        let catch_start = self.skip_trivia(index)?;
        if self.keyword_at(catch_start, b"catch") {
            has_catch = true;
            self.push_token(StructuralKind::Catch, catch_start)?;
            let after_keyword = self.skip_trivia(Self::after_keyword(catch_start, b"catch"))?;
            let (header, bindings, catch_body_start) =
                if self.bytes.get(after_keyword) == Some(&b'(') {
                    self.register_lazy_catch_parameter(after_keyword)?;
                    let (header, after_header) = self.parse_parenthesized(after_keyword)?;
                    let bindings = self.catch_binding_count(header)?;
                    (header, bindings, self.skip_trivia(after_header)?)
                } else {
                    (ByteSpan::default(), 0, after_keyword)
                };
            let catch_body = self.parse_body(node, catch_body_start)?;
            self.add_clause_with_bindings(
                node,
                ClauseRole::Catch,
                catch_start,
                header,
                catch_body,
                ForHeader::default(),
                bindings,
            )?;
            index = catch_body.end as usize;
        } else if self.bare_keyword_at(catch_start, b"catch") {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(catch_start)?,
                expected: "`@catch`",
            });
        }

        if !has_pending && !has_catch {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(start)?,
                expected: "an `@pending` or `@catch` clause",
            });
        }
        let trailing = self.skip_trivia(index)?;
        if self.keyword_at(trailing, b"pending") || self.bare_keyword_at(trailing, b"pending") {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(trailing)?,
                expected: "at most one `@pending` before `@catch`",
            });
        }
        if self.keyword_at(trailing, b"catch") || self.bare_keyword_at(trailing, b"catch") {
            return Err(ProjectionError::MalformedSyntax {
                offset: to_u32(trailing)?,
                expected: "at most one `@catch` clause",
            });
        }
        Ok(index)
    }

    pub(super) fn control_has_header(&self, start: usize, keyword: &[u8]) -> bool {
        let mut index = Self::after_keyword(start, keyword);
        index = self.skip_ascii_whitespace(index, self.bytes.len());
        if keyword == b"for" && self.bare_keyword_at(index, b"await") {
            index = self
                .skip_ascii_whitespace(Self::after_bare_keyword(index, b"await"), self.bytes.len());
        }
        self.bytes.get(index) == Some(&b'(')
    }

    pub(super) fn control_has_body(&self, start: usize, keyword: &[u8]) -> bool {
        self.skip_trivia(Self::after_keyword(start, keyword))
            .is_ok_and(|index| self.bytes.get(index) == Some(&b'{'))
    }

    pub(super) fn code_context(
        &self,
        start: usize,
        root_control_start: Option<usize>,
    ) -> ControlContext {
        if root_control_start == Some(start) {
            return ControlContext::Expression;
        }
        let mut index = start;
        loop {
            while index > 0 && self.bytes[index - 1].is_ascii_whitespace() {
                index -= 1;
            }
            if index >= 2 && self.bytes.get(index - 2..index) == Some(b"*/") {
                let Some(comment_start) =
                    self.bytes[..index - 2].windows(2).rposition(|window| window == b"/*")
                else {
                    break;
                };
                index = comment_start;
                continue;
            }
            let line_start = self.bytes[..index]
                .iter()
                .rposition(|byte| matches!(byte, b'\n' | b'\r'))
                .map_or(0, |position| position + 1);
            let line = &self.bytes[line_start..index];
            let first =
                line.iter().position(|byte| !byte.is_ascii_whitespace()).unwrap_or(line.len());
            if line.get(first..first + 2) == Some(b"//") {
                index = line_start;
                continue;
            }
            break;
        }
        if index == 0
            || matches!(self.bytes[index - 1], b'{' | b'}' | b';')
            || self.line_leading_control_starts_a_statement(start, index)
        {
            ControlContext::Statement
        } else {
            ControlContext::Expression
        }
    }
}

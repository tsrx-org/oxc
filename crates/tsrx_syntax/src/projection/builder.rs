use std::fmt::Write as _;

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, ClauseRole, ControlContext, ControlKind, EmbeddedKind, NONE, Overlay,
        ParserCodeBlockKind, StructuralKind,
    },
};

use super::{
    format::{HeaderManifest, TryManifest, WrapperManifest},
    mapping::MappedProjection,
    marker::{collision_free_prefix, validate_overlay_source},
};
use crate::projection_view::ProjectionSegment;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    TryEnd(u32),
    ParserCodeBlockEnd(u32),
    WrapperEnd(u32),
    WrapperStart(u32),
    Token(u32),
    Header { clause: u32, ordinal: u32 },
    ForBody(u32),
    Embedded(u32),
    ParserShorthand(u32),
    ParserLazyPattern(u32),
    StatementBoundary(u32),
}

impl Action {
    fn key(self, overlay: &Overlay) -> (u32, u8) {
        match self {
            Self::TryEnd(node) => (overlay.nodes[node as usize].span.end, 0),
            Self::ParserCodeBlockEnd(block) => {
                (overlay.parser_code_blocks[block as usize].body.end.saturating_sub(1), 0)
            }
            Self::WrapperEnd(node) => (overlay.nodes[node as usize].span.end, 1),
            Self::WrapperStart(node) => (overlay.nodes[node as usize].span.start, 2),
            Self::Token(token) => (overlay.tokens[token as usize].span.start, 3),
            Self::Header { clause, .. } => (overlay.clauses[clause as usize].header.start, 3),
            Self::ForBody(clause) => {
                (overlay.clauses[clause as usize].body.start.saturating_add(1), 0)
            }
            Self::Embedded(token) => (overlay.embedded_tokens[token as usize].span.start, 3),
            Self::ParserShorthand(attribute) => {
                (overlay.parser_shorthand_attributes[attribute as usize].span.start, 2)
            }
            Self::ParserLazyPattern(pattern) => {
                (overlay.parser_lazy_patterns[pattern as usize].ampersand, 2)
            }
            // The boundary precedes everything else written at the same markup opening.
            Self::StatementBoundary(boundary) => {
                (overlay.statement_boundaries[boundary as usize], 0)
            }
        }
    }
}

pub(super) struct BuiltProjection {
    pub(super) mapped: MappedProjection,
    pub(super) prefix: String,
    pub(super) wrappers: Vec<WrapperManifest>,
    pub(super) headers: Vec<HeaderManifest>,
    pub(super) tries: Vec<TryManifest>,
}

struct Builder<'a> {
    source: &'a str,
    overlay: &'a Overlay,
    prefix: &'a str,
    output: String,
    segments: Vec<ProjectionSegment>,
    record_segments: bool,
    type_semantic: bool,
    cursor: usize,
}

impl<'a> Builder<'a> {
    fn new(
        source: &'a str,
        overlay: &'a Overlay,
        prefix: &'a str,
        record_segments: bool,
        type_semantic: bool,
    ) -> Self {
        Self {
            source,
            overlay,
            prefix,
            output: String::with_capacity(
                source
                    .len()
                    .saturating_add(overlay.tokens.len().saturating_mul(64))
                    .saturating_add(overlay.embedded_tokens.len().saturating_mul(32)),
            ),
            segments: if record_segments {
                Vec::with_capacity(
                    overlay
                        .tokens
                        .len()
                        .saturating_mul(2)
                        .saturating_add(overlay.dynamic_tags.len())
                        .saturating_add(1),
                )
            } else {
                Vec::new()
            },
            record_segments,
            type_semantic,
            cursor: 0,
        }
    }

    fn finish(mut self) -> Result<MappedProjection, ProjectionError> {
        self.copy_to(self.source.len())?;
        Ok(MappedProjection {
            projected: self.output,
            segments: self.segments,
            dynamic_prefix: None,
            dynamic_count: 0,
            dynamic_offsets: Vec::new(),
            synthetic_generator_spans: Vec::new(),
            synthetic_callee_spans: Vec::new(),
        })
    }

    fn copy_to(&mut self, end: usize) -> Result<(), ProjectionError> {
        if end < self.cursor || end > self.source.len() {
            return Err(ProjectionError::SourceChanged {
                offset: to_u32(end.min(self.source.len()))?,
            });
        }
        if end > self.cursor {
            let span = ByteSpan::new(to_u32(self.cursor)?, to_u32(end)?);
            self.copy_original(span)?;
            self.cursor = end;
        }
        Ok(())
    }

    fn copy_original(&mut self, span: ByteSpan) -> Result<(), ProjectionError> {
        self.copy_original_with_fixability(span, true)
    }

    fn copy_original_with_fixability(
        &mut self,
        span: ByteSpan,
        fixable: bool,
    ) -> Result<(), ProjectionError> {
        let start = span.start as usize;
        let end = span.end as usize;
        let Some(value) = self.source.get(start..end) else {
            return Err(ProjectionError::SourceChanged { offset: span.start });
        };
        let projected_start =
            self.record_segments.then(|| to_u32(self.output.len())).transpose()?;
        self.output.push_str(value);
        let Some(projected_start) = projected_start else {
            return Ok(());
        };
        let projected_end = to_u32(self.output.len())?;
        if let Some(previous) = self.segments.last_mut()
            && previous.projected.end == projected_start
            && previous.fixable == fixable
            && previous.original_start + (previous.projected.end - previous.projected.start)
                == span.start
        {
            previous.projected.end = projected_end;
        } else {
            self.segments.push(ProjectionSegment {
                projected: ByteSpan::new(projected_start, projected_end),
                original_start: span.start,
                fixable,
            });
        }
        Ok(())
    }

    fn copy_original_with_lazy_markers(&mut self, span: ByteSpan) -> Result<(), ProjectionError> {
        let mut cursor = span.start;
        for (index, pattern) in self.overlay.parser_lazy_patterns.iter().enumerate() {
            if pattern.ampersand < span.start || pattern.ampersand >= span.end {
                continue;
            }
            self.copy_original(ByteSpan::new(cursor, pattern.ampersand))?;
            write!(self.output, "/*{}Y{index}__*/", self.prefix)
                .expect("writing to a String cannot fail");
            cursor = pattern.ampersand.saturating_add(1);
        }
        self.copy_original(ByteSpan::new(cursor, span.end))
    }

    fn wrapper_start(&mut self, node_index: u32) -> Result<(), ProjectionError> {
        let node = self.overlay.nodes[node_index as usize];
        self.copy_to(node.span.start as usize)?;
        if node.context == ControlContext::JsxChild {
            self.output.push('{');
        }
        write!(
            self.output,
            "{}W{node_index}_({{async *{}M{node_index}_(){{/*{}N{node_index}S__*/",
            self.prefix, self.prefix, self.prefix
        )
        .expect("writing to a String cannot fail");
        Ok(())
    }

    fn wrapper_end(&mut self, node_index: u32) -> Result<(), ProjectionError> {
        let node = self.overlay.nodes[node_index as usize];
        self.copy_to(node.span.end as usize)?;
        write!(
            self.output,
            "/*{}N{node_index}E__*/}}}},{}E{node_index}_)",
            self.prefix, self.prefix
        )
        .expect("writing to a String cannot fail");
        if node.context == ControlContext::JsxChild {
            self.output.push('}');
        }
        Ok(())
    }

    fn try_end(&mut self, node_index: u32) -> Result<(), ProjectionError> {
        let node = self.overlay.nodes[node_index as usize];
        if node.kind != ControlKind::Try {
            return Err(ProjectionError::StructuralMismatch);
        }
        self.copy_to(node.span.end as usize)?;
        write!(self.output, "}},{}TE{node_index}_)", self.prefix)
            .expect("writing to a String cannot fail");
        Ok(())
    }

    fn token(&mut self, token_index: u32) -> Result<(), ProjectionError> {
        let token = self.overlay.tokens[token_index as usize];
        let start = token.span.start as usize;
        self.copy_to(start)?;
        let spelling = match token.kind {
            StructuralKind::FunctionBody => b"@{".as_slice(),
            StructuralKind::If => b"@if",
            StructuralKind::Else => b"@else",
            StructuralKind::For => b"@for",
            StructuralKind::Empty => b"@empty",
            StructuralKind::Switch => b"@switch",
            StructuralKind::Case => b"@case",
            StructuralKind::Default => b"@default",
            StructuralKind::Try => b"@try",
            StructuralKind::Pending => b"@pending",
            StructuralKind::Catch => b"@catch",
        };
        if self.source.as_bytes().get(start..start + spelling.len()) != Some(spelling) {
            return Err(ProjectionError::SourceChanged { offset: token.span.start });
        }
        match token.kind {
            StructuralKind::FunctionBody if self.parser_code_block_index(token_index).is_some() => {
                let block_index = self
                    .parser_code_block_index(token_index)
                    .ok_or(ProjectionError::StructuralMismatch)?;
                self.parser_code_block_start(token_index, block_index, start)?;
            }
            StructuralKind::FunctionBody if self.type_semantic => {
                write!(self.output, "/*{}{token_index}*/", self.prefix)
                    .expect("writing to a String cannot fail");
                self.cursor = start + 1;
                if self.source.as_bytes().get(self.cursor) != Some(&b'{') {
                    return Err(ProjectionError::SourceChanged { offset: token.span.start });
                }
                self.copy_to(self.cursor + 1)?;
                self.output.push_str("\nif (false) return null as any;\n");
            }
            StructuralKind::Try => {
                if token.owner == NONE {
                    return Err(ProjectionError::StructuralMismatch);
                }
                write!(
                    self.output,
                    "/*{}{token_index}*/{}T{}_({{async *{}B{}_()",
                    self.prefix, self.prefix, token.owner, self.prefix, token.owner
                )
                .expect("writing to a String cannot fail");
                self.cursor = start + spelling.len();
            }
            StructuralKind::Pending => {
                if token.owner == NONE {
                    return Err(ProjectionError::StructuralMismatch);
                }
                write!(
                    self.output,
                    ",/*{}{token_index}*/async *{}P{}_()",
                    self.prefix, self.prefix, token.owner
                )
                .expect("writing to a String cannot fail");
                self.cursor = start + spelling.len();
            }
            StructuralKind::Catch => {
                if token.owner == NONE {
                    return Err(ProjectionError::StructuralMismatch);
                }
                write!(
                    self.output,
                    ",/*{}{token_index}*/async *{}C{}_",
                    self.prefix, self.prefix, token.owner
                )
                .expect("writing to a String cannot fail");
                if !self.catch_has_header(token.owner)? {
                    self.output.push_str("()");
                }
                self.cursor = start + spelling.len();
            }
            kind => {
                write!(self.output, "/*{}{token_index}*/", self.prefix)
                    .expect("writing to a String cannot fail");
                if kind == StructuralKind::Empty {
                    self.output.push_str("if (false)");
                    self.cursor = start + spelling.len();
                } else {
                    self.cursor = start + 1;
                }
            }
        }
        Ok(())
    }

    fn parser_code_block_index(&self, token: u32) -> Option<u32> {
        self.overlay
            .parser_code_blocks
            .binary_search_by_key(&token, |block| block.token)
            .ok()
            .and_then(|index| u32::try_from(index).ok())
    }

    fn parser_code_block_start(
        &mut self,
        token_index: u32,
        block_index: u32,
        start: usize,
    ) -> Result<(), ProjectionError> {
        let block = self
            .overlay
            .parser_code_blocks
            .get(block_index as usize)
            .ok_or(ProjectionError::StructuralMismatch)?;
        self.cursor = start + 1;
        match block.kind {
            ParserCodeBlockKind::JsxChild => {
                self.copy_to(start + 2)?;
                write!(
                    self.output,
                    "/*{}X{block_index}P__*/(async function*(){{/*{}{token_index}*//*{}X{block_index}S__*/",
                    self.prefix, self.prefix, self.prefix
                )
                .expect("writing to a String cannot fail");
            }
            ParserCodeBlockKind::Expression => {
                write!(self.output, "/*{}X{block_index}P__*/void async function*()", self.prefix)
                    .expect("writing to a String cannot fail");
                self.copy_to(start + 2)?;
                write!(
                    self.output,
                    "/*{}{token_index}*//*{}X{block_index}S__*/",
                    self.prefix, self.prefix
                )
                .expect("writing to a String cannot fail");
            }
        }
        Ok(())
    }

    fn parser_code_block_end(&mut self, block_index: u32) -> Result<(), ProjectionError> {
        let block = self
            .overlay
            .parser_code_blocks
            .get(block_index as usize)
            .ok_or(ProjectionError::StructuralMismatch)?;
        let closing =
            block.body.end.checked_sub(1).ok_or(ProjectionError::StructuralMismatch)? as usize;
        if self.source.as_bytes().get(closing) != Some(&b'}') {
            return Err(ProjectionError::SourceChanged {
                offset: block.body.end.saturating_sub(1),
            });
        }
        self.copy_to(closing)?;
        write!(self.output, "/*{}X{block_index}C__*/", self.prefix)
            .expect("writing to a String cannot fail");
        match block.kind {
            ParserCodeBlockKind::JsxChild => {
                write!(self.output, "}})/*{}X{block_index}E__*/", self.prefix)
                    .expect("writing to a String cannot fail");
            }
            ParserCodeBlockKind::Expression => {
                self.copy_to(block.body.end as usize)?;
                write!(self.output, "/*{}X{block_index}E__*/", self.prefix)
                    .expect("writing to a String cannot fail");
            }
        }
        Ok(())
    }

    fn catch_has_header(&self, node: u32) -> Result<bool, ProjectionError> {
        let mut clause = self.overlay.nodes[node as usize].first_clause;
        while clause != NONE {
            let current = self.overlay.clauses[clause as usize];
            if current.role == ClauseRole::Catch {
                return Ok(!current.header.is_empty());
            }
            clause = current.next;
        }
        Err(ProjectionError::StructuralMismatch)
    }

    fn header(&mut self, clause_index: u32, ordinal: u32) -> Result<(), ProjectionError> {
        let clause = self.overlay.clauses[clause_index as usize];
        if self.type_semantic {
            return self.type_header(clause);
        }
        let header = clause.for_header;
        if !header.annotated {
            return Err(ProjectionError::ScaffoldMismatch { index: ordinal as usize });
        }
        self.copy_to(clause.header.start as usize)?;
        self.output.push('(');
        self.copy_original_with_lazy_markers(header.left)?;
        write!(self.output, " of {}H{ordinal}_(/*{}R{ordinal}S__*/", self.prefix, self.prefix)
            .expect("writing to a String cannot fail");
        self.copy_original(header.right)?;
        write!(self.output, "/*{}R{ordinal}E__*/", self.prefix)
            .expect("writing to a String cannot fail");
        if !header.index.is_empty() {
            write!(self.output, ",{}IH{ordinal}_(/*{}I{ordinal}S__*/", self.prefix, self.prefix)
                .expect("writing to a String cannot fail");
            self.copy_original(header.index)?;
            write!(self.output, "/*{}I{ordinal}E__*/)", self.prefix)
                .expect("writing to a String cannot fail");
        }
        if !header.key.is_empty() {
            write!(self.output, ",{}KH{ordinal}_(/*{}K{ordinal}S__*/", self.prefix, self.prefix)
                .expect("writing to a String cannot fail");
            self.copy_original(header.key)?;
            write!(self.output, "/*{}K{ordinal}E__*/)", self.prefix)
                .expect("writing to a String cannot fail");
        }
        write!(self.output, ",{}HE{ordinal}_))", self.prefix)
            .expect("writing to a String cannot fail");
        self.cursor = clause.header.end as usize;
        Ok(())
    }

    fn type_header(&mut self, clause: crate::model::Clause) -> Result<(), ProjectionError> {
        if clause.role != ClauseRole::For {
            return Err(ProjectionError::StructuralMismatch);
        }
        let header = clause.for_header;
        // Only an annotated header carries `left`/`right`, because only an annotated header has a
        // grammar the type lane has to rewrite. An unannotated `@for (const {cell} of rows)` is
        // already the TypeScript it projects to, so it is copied the way every other lane copies
        // it rather than demanding fields the scanner never fills in.
        if !header.annotated {
            return self.unannotated_type_header(clause.header);
        }
        if header.left.is_empty() || header.right.is_empty() {
            return Err(ProjectionError::StructuralMismatch);
        }
        self.copy_to(clause.header.start as usize)?;
        self.output.push('(');
        let left = self
            .source
            .get(header.left.start as usize..header.left.end as usize)
            .ok_or(ProjectionError::SourceChanged { offset: header.left.start })?;
        let trimmed = left.trim_start();
        if !trimmed.starts_with("const ")
            && !trimmed.starts_with("let ")
            && !trimmed.starts_with("var ")
            && !trimmed.starts_with("using ")
            && !trimmed.starts_with("await using ")
        {
            self.output.push_str("const ");
        }
        // The lazy sigil has to be spent here, exactly as the non-type header spends it. Rewriting
        // the header at all moves the cursor past the whole clause, and `PendingActions::next`
        // then skips every lazy pattern behind that cursor — so an `&` copied verbatim is an `&`
        // no later action will rewrite, and the type projection emits `const &{…}`.
        self.copy_original_with_lazy_markers(header.left)?;
        self.output.push_str(" of ");
        self.copy_original(header.right)?;
        self.output.push(')');
        self.cursor = clause.header.end as usize;
        Ok(())
    }

    /// Copies an unannotated `@for` header verbatim, spending the lazy sigils on the way through.
    ///
    /// The sigils have to be spent here for the same reason the annotated header spends them:
    /// rewriting the header moves the cursor past the whole clause, and `PendingActions::next`
    /// then skips every lazy pattern behind that cursor.
    fn unannotated_type_header(&mut self, header: ByteSpan) -> Result<(), ProjectionError> {
        let open = header.start as usize;
        if self.source.as_bytes().get(open) != Some(&b'(') || header.end <= header.start {
            return Err(ProjectionError::StructuralMismatch);
        }
        let inner = ByteSpan::new(to_u32(open.saturating_add(1))?, header.end);
        self.copy_to(inner.start as usize)?;
        // A bare lazy loop target — `@for (&{cell} of rows)` — is the one unannotated shape that is
        // not already TypeScript: the sigil stands in for the declaration keyword, so the type lane
        // writes the keyword the annotated lane writes for the very same target.
        if self.has_bare_lazy_loop_target(inner) {
            self.output.push_str("const ");
        }
        self.copy_original_with_lazy_markers(inner)?;
        self.cursor = header.end as usize;
        Ok(())
    }

    /// Reports whether the header's iteration target is a lazy pattern with no declaration keyword
    /// of its own, which is the shape `Scanner::register_lazy_loop_target` records.
    ///
    /// The scan has to step over full trivia rather than whitespace alone, because the scanner
    /// reaches the sigil through `Scanner::skip_trivia`: in `@for (/* note */ &{cell} of rows)` the
    /// `&` is registered behind a comment, and a whitespace-only scan stops at the `/` and never
    /// matches the recorded position — so the type lane would omit the `const` the sigil stands in
    /// for. That scanner helper is private to the scanner, so its comment handling is mirrored
    /// here, bounded by the header span the scanner already balanced.
    fn has_bare_lazy_loop_target(&self, inner: ByteSpan) -> bool {
        let bytes = self.source.as_bytes();
        let end = (inner.end as usize).min(bytes.len());
        let mut index = (inner.start as usize).min(end);
        let target = loop {
            while index < end && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            let rest = &bytes[index..end];
            if rest.starts_with(b"//") {
                index += 2;
                while index < end && !matches!(bytes[index], b'\n' | b'\r') {
                    index += 1;
                }
            } else if rest.starts_with(b"/*") {
                // An unterminated block comment never reaches projection — the scanner rejects it
                // before an overlay exists — so a missing `*/` only means there is no target here.
                let Some(close) = rest[2..].windows(2).position(|pair| pair == b"*/") else {
                    return false;
                };
                index += 2 + close + 2;
            } else {
                break index;
            }
        };
        let Ok(target) = u32::try_from(target) else {
            return false;
        };
        self.overlay.parser_lazy_patterns.iter().any(|pattern| pattern.ampersand == target)
    }

    fn for_body(&mut self, clause_index: u32) -> Result<(), ProjectionError> {
        if !self.type_semantic {
            return Err(ProjectionError::StructuralMismatch);
        }
        let clause = self.overlay.clauses[clause_index as usize];
        if clause.role != ClauseRole::For
            || self.source.as_bytes().get(clause.body.start as usize) != Some(&b'{')
        {
            return Err(ProjectionError::StructuralMismatch);
        }
        self.copy_to(clause.body.start.saturating_add(1) as usize)?;
        let header = clause.for_header;
        if !header.index.is_empty() {
            self.output.push_str("\nlet ");
            self.copy_original(header.index)?;
            self.output.push_str(" = 0;\n");
        }
        if !header.key.is_empty() {
            self.output.push_str("\nvoid (");
            self.copy_original(header.key)?;
            self.output.push_str(");\n");
        }
        Ok(())
    }

    /// Writes the `;` that a new statement-level markup opening implies, immediately before the
    /// opening so the authored `<` is still copied verbatim and every authored byte keeps its
    /// segment. Used for line-leading markup and for a sibling JSX statement after another JSX
    /// tree.
    fn statement_boundary(&mut self, boundary: u32) -> Result<(), ProjectionError> {
        let offset = *self
            .overlay
            .statement_boundaries
            .get(boundary as usize)
            .ok_or(ProjectionError::StructuralMismatch)?;
        let start = offset as usize;
        if self.source.as_bytes().get(start) != Some(&b'<') {
            return Err(ProjectionError::SourceChanged { offset });
        }
        self.copy_to(start)?;
        self.output.push(';');
        Ok(())
    }

    fn embedded(&mut self, token_index: u32) -> Result<(), ProjectionError> {
        let token = self.overlay.embedded_tokens[token_index as usize];
        let span_start = token.span.start as usize;
        let span_end = token.span.end as usize;
        self.copy_to(span_start)?;
        match token.kind {
            EmbeddedKind::DynamicOpen => {
                let tag = self
                    .overlay
                    .dynamic_tags
                    .get(token.owner as usize)
                    .ok_or(ProjectionError::StructuralMismatch)?;
                if self.source.as_bytes().get(span_start..span_start + 2) != Some(b"<{")
                    || tag.expression.start < token.span.start + 2
                    || tag.expression.end + 1 != token.span.end
                    || self.source.as_bytes().get(tag.expression.end as usize) != Some(&b'}')
                {
                    return Err(ProjectionError::SourceChanged { offset: token.span.start });
                }
                write!(
                    self.output,
                    "<{}D{} {}A{}_={{",
                    self.prefix, token.owner, self.prefix, token.owner
                )
                .expect("writing to a String cannot fail");
                self.cursor = tag.expression.start as usize;
                self.copy_original_with_fixability(tag.expression, tag.self_closing)?;
                self.cursor = tag.expression.end as usize;
                write!(self.output, "}} {}Z{}_={{null}}", self.prefix, token.owner)
                    .expect("writing to a String cannot fail");
                self.cursor = span_end;
            }
            EmbeddedKind::DynamicClose => {
                if self.source.as_bytes().get(span_start..span_start + 3) != Some(b"</{")
                    || self.source.as_bytes().get(span_end.saturating_sub(1)) != Some(&b'>')
                {
                    return Err(ProjectionError::SourceChanged { offset: token.span.start });
                }
                let tag = self
                    .overlay
                    .dynamic_tags
                    .get(token.owner as usize)
                    .ok_or(ProjectionError::StructuralMismatch)?;
                let first = tag.first_closing_comment as usize;
                let end = first
                    .checked_add(tag.closing_comment_count as usize)
                    .ok_or(ProjectionError::SourceTooLarge)?;
                let comments = self
                    .overlay
                    .dynamic_comments
                    .get(first..end)
                    .ok_or(ProjectionError::StructuralMismatch)?;
                for (offset, comment) in comments.iter().enumerate() {
                    let comment_source = self
                        .source
                        .as_bytes()
                        .get(comment.start as usize..comment.end as usize)
                        .ok_or(ProjectionError::SourceChanged { offset: comment.start })?;
                    if comment.start < tag.closing_expression.start
                        || comment.end > tag.closing_expression.end
                        || (!comment_source.starts_with(b"//")
                            && !comment_source.starts_with(b"/*"))
                    {
                        return Err(ProjectionError::StructuralMismatch);
                    }
                    let ordinal = first + offset;
                    write!(self.output, "{{/*{}Q{ordinal}__*/ null}}", self.prefix)
                        .expect("writing to a String cannot fail");
                }
                write!(self.output, "</{}D{}>", self.prefix, token.owner)
                    .expect("writing to a String cannot fail");
                self.cursor = span_end;
            }
            EmbeddedKind::StyleContent => {
                let style = self
                    .overlay
                    .style_blocks
                    .get(token.owner as usize)
                    .ok_or(ProjectionError::StructuralMismatch)?;
                if style.content != token.span {
                    return Err(ProjectionError::StructuralMismatch);
                }
                write!(self.output, "{{/*{}S{}__*/ null}}", self.prefix, token.owner)
                    .expect("writing to a String cannot fail");
                self.cursor = span_end;
            }
            EmbeddedKind::ScriptContent => {
                let script = self
                    .overlay
                    .script_blocks
                    .get(token.owner as usize)
                    .ok_or(ProjectionError::StructuralMismatch)?;
                if script.content != token.span {
                    return Err(ProjectionError::StructuralMismatch);
                }
                write!(self.output, "{{/*{}L{}__*/ null}}", self.prefix, token.owner)
                    .expect("writing to a String cannot fail");
                self.cursor = span_end;
            }
        }
        Ok(())
    }

    fn parser_shorthand(&mut self, attribute_index: u32) -> Result<(), ProjectionError> {
        let attribute = self
            .overlay
            .parser_shorthand_attributes
            .get(attribute_index as usize)
            .ok_or(ProjectionError::StructuralMismatch)?;
        if attribute.span.start.saturating_add(1) != attribute.identifier.start
            || attribute.identifier.end.saturating_add(1) != attribute.span.end
            || self.source.as_bytes().get(attribute.span.start as usize) != Some(&b'{')
            || self.source.as_bytes().get(attribute.identifier.end as usize) != Some(&b'}')
        {
            return Err(ProjectionError::StructuralMismatch);
        }
        self.copy_to(attribute.span.start as usize)?;
        if self.type_semantic {
            let name = self
                .source
                .get(attribute.identifier.start as usize..attribute.identifier.end as usize)
                .ok_or(ProjectionError::SourceChanged { offset: attribute.identifier.start })?;
            self.output.push_str(name);
            self.output.push('=');
        } else {
            write!(self.output, "{}V{attribute_index}_=", self.prefix)
                .expect("writing to a String cannot fail");
        }
        self.copy_original(attribute.span)?;
        self.cursor = attribute.span.end as usize;
        Ok(())
    }

    fn parser_lazy_pattern(&mut self, pattern_index: u32) -> Result<(), ProjectionError> {
        let pattern = self
            .overlay
            .parser_lazy_patterns
            .get(pattern_index as usize)
            .ok_or(ProjectionError::StructuralMismatch)?;
        if pattern.pattern_start <= pattern.ampersand
            || self.source.as_bytes().get(pattern.ampersand as usize) != Some(&b'&')
        {
            return Err(ProjectionError::StructuralMismatch);
        }
        self.copy_to(pattern.ampersand as usize)?;
        if pattern.standalone {
            self.output.push_str("var ");
        }
        write!(self.output, "/*{}Y{pattern_index}__*/", self.prefix)
            .expect("writing to a String cannot fail");
        self.cursor = pattern.ampersand.saturating_add(1) as usize;
        Ok(())
    }
}

pub(super) fn build_projection(
    source: &str,
    overlay: &Overlay,
    record_segments: bool,
) -> Result<BuiltProjection, ProjectionError> {
    build_projection_with_purpose(source, overlay, record_segments, ProjectionPurpose::Syntax)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProjectionPurpose {
    Syntax,
    Types,
}

struct PendingActions<'a> {
    overlay: &'a Overlay,
    wrappers: &'a [Action],
    try_ends: &'a [Action],
    code_block_ends: &'a [Action],
    headers: &'a [Action],
    wrapper: usize,
    try_end: usize,
    code_block_end: usize,
    token: usize,
    header: usize,
    embedded: usize,
    shorthand: usize,
    lazy_pattern: usize,
    statement_boundary: usize,
}

impl<'a> PendingActions<'a> {
    fn new(
        overlay: &'a Overlay,
        wrappers: &'a [Action],
        try_ends: &'a [Action],
        code_block_ends: &'a [Action],
        headers: &'a [Action],
    ) -> Self {
        Self {
            overlay,
            wrappers,
            try_ends,
            code_block_ends,
            headers,
            wrapper: 0,
            try_end: 0,
            code_block_end: 0,
            token: 0,
            header: 0,
            embedded: 0,
            shorthand: 0,
            lazy_pattern: 0,
            statement_boundary: 0,
        }
    }

    fn next(&mut self, original_cursor: usize) -> Result<Option<Action>, ProjectionError> {
        while self.overlay.parser_lazy_patterns.get(self.lazy_pattern).is_some_and(|pattern| {
            usize::try_from(pattern.ampersand).is_ok_and(|ampersand| ampersand < original_cursor)
        }) {
            self.lazy_pattern += 1;
        }
        let token = (self.token < self.overlay.tokens.len())
            .then(|| to_u32(self.token).map(Action::Token))
            .transpose()?;
        let embedded = (self.embedded < self.overlay.embedded_tokens.len())
            .then(|| to_u32(self.embedded).map(Action::Embedded))
            .transpose()?;
        let shorthand = (self.shorthand < self.overlay.parser_shorthand_attributes.len())
            .then(|| to_u32(self.shorthand).map(Action::ParserShorthand))
            .transpose()?;
        let lazy_pattern = (self.lazy_pattern < self.overlay.parser_lazy_patterns.len())
            .then(|| to_u32(self.lazy_pattern).map(Action::ParserLazyPattern))
            .transpose()?;
        let statement_boundary = (self.statement_boundary
            < self.overlay.statement_boundaries.len())
        .then(|| to_u32(self.statement_boundary).map(Action::StatementBoundary))
        .transpose()?;
        Ok([
            self.wrappers.get(self.wrapper).copied(),
            self.try_ends.get(self.try_end).copied(),
            self.code_block_ends.get(self.code_block_end).copied(),
            token,
            self.headers.get(self.header).copied(),
            embedded,
            shorthand,
            lazy_pattern,
            statement_boundary,
        ]
        .into_iter()
        .flatten()
        .min_by_key(|action| action.key(self.overlay)))
    }

    fn apply(&mut self, builder: &mut Builder<'_>, action: Action) -> Result<(), ProjectionError> {
        match action {
            Action::TryEnd(node) => {
                self.try_end += 1;
                builder.try_end(node)
            }
            Action::ParserCodeBlockEnd(block) => {
                self.code_block_end += 1;
                builder.parser_code_block_end(block)
            }
            Action::WrapperEnd(node) => {
                self.wrapper += 1;
                builder.wrapper_end(node)
            }
            Action::WrapperStart(node) => {
                self.wrapper += 1;
                builder.wrapper_start(node)
            }
            Action::Token(token) => {
                self.token += 1;
                builder.token(token)
            }
            Action::Header { clause, ordinal } => {
                self.header += 1;
                builder.header(clause, ordinal)
            }
            Action::ForBody(clause) => {
                self.header += 1;
                builder.for_body(clause)
            }
            Action::Embedded(token) => {
                self.embedded += 1;
                builder.embedded(token)
            }
            Action::ParserShorthand(attribute) => {
                self.shorthand += 1;
                builder.parser_shorthand(attribute)
            }
            Action::ParserLazyPattern(pattern) => {
                self.lazy_pattern += 1;
                builder.parser_lazy_pattern(pattern)
            }
            Action::StatementBoundary(boundary) => {
                self.statement_boundary += 1;
                builder.statement_boundary(boundary)
            }
        }
    }
}

pub(super) fn build_projection_with_purpose(
    source: &str,
    overlay: &Overlay,
    record_segments: bool,
    purpose: ProjectionPurpose,
) -> Result<BuiltProjection, ProjectionError> {
    validate_overlay_source(source, overlay)?;
    let prefix = collision_free_prefix(source)?;
    let (wrapper_actions, wrappers) = build_wrapper_actions(overlay)?;

    let (try_end_actions, tries) = build_try_actions(source, overlay)?;

    let (header_actions, headers) =
        build_header_actions(overlay, purpose == ProjectionPurpose::Types)?;
    let mut parser_code_block_end_actions = overlay
        .parser_code_blocks
        .iter()
        .enumerate()
        .map(|(index, _)| to_u32(index).map(Action::ParserCodeBlockEnd))
        .collect::<Result<Vec<_>, _>>()?;
    parser_code_block_end_actions.sort_unstable_by_key(|action| action.key(overlay));

    let mut builder = Builder::new(
        source,
        overlay,
        &prefix,
        record_segments,
        purpose == ProjectionPurpose::Types,
    );
    let mut pending = PendingActions::new(
        overlay,
        &wrapper_actions,
        &try_end_actions,
        &parser_code_block_end_actions,
        &header_actions,
    );
    while let Some(action) = pending.next(builder.cursor)? {
        pending.apply(&mut builder, action)?;
    }
    let mut mapped = builder.finish()?;
    mapped.synthetic_generator_spans = overlay
        .nodes
        .iter()
        .filter(|node| node.context != ControlContext::Statement || node.kind == ControlKind::Try)
        .map(|node| node.span)
        .collect();
    if record_segments && !overlay.dynamic_tags.is_empty() {
        mapped.dynamic_prefix = Some(prefix.clone());
        mapped.dynamic_count = to_u32(overlay.dynamic_tags.len())?;
        mapped.dynamic_offsets =
            overlay.dynamic_tags.iter().map(|tag| tag.expression.start).collect();
    }
    Ok(BuiltProjection { mapped, prefix, wrappers, headers, tries })
}

fn build_wrapper_actions(
    overlay: &Overlay,
) -> Result<(Vec<Action>, Vec<WrapperManifest>), ProjectionError> {
    let mut actions = Vec::with_capacity(overlay.nodes.len().saturating_mul(2));
    let mut manifests = Vec::new();
    let mut active = Vec::with_capacity(8);
    for (index, node) in overlay.nodes.iter().enumerate() {
        while active
            .last()
            .is_some_and(|&active: &u32| overlay.nodes[active as usize].span.end <= node.span.start)
        {
            let active = active.pop().ok_or(ProjectionError::StructuralMismatch)?;
            actions.push(Action::WrapperEnd(active));
        }
        if node.context != ControlContext::Statement {
            let node_index = to_u32(index)?;
            if active
                .last()
                .is_some_and(|&active| node.span.end > overlay.nodes[active as usize].span.end)
            {
                return Err(ProjectionError::StructuralMismatch);
            }
            actions.push(Action::WrapperStart(node_index));
            active.push(node_index);
            manifests.push(WrapperManifest { node: node_index, context: node.context });
        }
    }
    while let Some(active) = active.pop() {
        actions.push(Action::WrapperEnd(active));
    }
    Ok((actions, manifests))
}

fn build_header_actions(
    overlay: &Overlay,
    type_semantic: bool,
) -> Result<(Vec<Action>, Vec<HeaderManifest>), ProjectionError> {
    let mut actions = Vec::new();
    let mut manifests = Vec::new();
    for node in &overlay.nodes {
        let mut clause_index = node.first_clause;
        while clause_index != NONE {
            let clause = overlay.clauses[clause_index as usize];
            if clause.for_header.annotated || type_semantic && clause.role == ClauseRole::For {
                let ordinal = to_u32(manifests.len())?;
                actions.push(Action::Header { clause: clause_index, ordinal });
                if clause.for_header.annotated {
                    manifests.push(HeaderManifest {
                        ordinal,
                        has_index: !clause.for_header.index.is_empty(),
                        has_key: !clause.for_header.key.is_empty(),
                    });
                }
                if type_semantic
                    && (!clause.for_header.index.is_empty() || !clause.for_header.key.is_empty())
                {
                    actions.push(Action::ForBody(clause_index));
                }
            }
            clause_index = clause.next;
        }
    }
    Ok((actions, manifests))
}

fn build_try_actions(
    source: &str,
    overlay: &Overlay,
) -> Result<(Vec<Action>, Vec<TryManifest>), ProjectionError> {
    let mut actions = Vec::new();
    let mut manifests = Vec::new();
    let mut active = Vec::with_capacity(8);
    for (index, node) in overlay.nodes.iter().enumerate() {
        while active.last().is_some_and(|&node_index: &u32| {
            overlay.nodes[node_index as usize].span.end <= node.span.start
        }) {
            actions.push(Action::TryEnd(active.pop().ok_or(ProjectionError::StructuralMismatch)?));
        }
        if node.kind != ControlKind::Try {
            continue;
        }
        let node_index = to_u32(index)?;
        let mut flags = 0;
        let mut clause_index = node.first_clause;
        while clause_index != NONE {
            let clause = overlay.clauses[clause_index as usize];
            match clause.role {
                ClauseRole::Pending => flags |= TryManifest::HAS_PENDING,
                ClauseRole::Catch => {
                    flags |= TryManifest::HAS_CATCH;
                    if !clause.header.is_empty() {
                        flags |= TryManifest::CATCH_HAS_HEADER;
                    }
                }
                _ => {}
            }
            clause_index = clause.next;
        }
        if flags & (TryManifest::HAS_PENDING | TryManifest::HAS_CATCH) == 0 {
            return Err(ProjectionError::StructuralMismatch);
        }
        if source.as_bytes()[node.span.end as usize..]
            .iter()
            .find(|byte| !byte.is_ascii_whitespace())
            == Some(&b';')
        {
            flags |= TryManifest::AUTHORED_SEMICOLON;
        }
        active.push(node_index);
        manifests.push(TryManifest { node: node_index, context: node.context, flags });
    }
    while let Some(node) = active.pop() {
        actions.push(Action::TryEnd(node));
    }
    Ok((actions, manifests))
}

#[cfg(all(test, target_pointer_width = "64"))]
mod layout_tests {
    use std::mem::size_of;

    use super::Action;

    #[test]
    fn action_layout_remains_compact() {
        assert_eq!(size_of::<Action>(), 12);
    }
}

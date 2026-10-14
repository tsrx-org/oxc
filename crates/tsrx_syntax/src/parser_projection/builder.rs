//! Emitting the projected text while recording which spans were copied verbatim, since only
//! those spans can carry a fix back to the author afterwards.

use std::fmt::Write as _;

use super::mapping::{MappedProjection, SyntheticAnchor};
use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, ClauseRole, ControlContext, ControlKind, EmbeddedKind, NONE, Overlay,
        PARSER_EXPRESSION_CODE_BLOCK_PREFIX, PARSER_JSX_TEXT_GT_STAND_IN, ParserCodeBlockKind,
        ParserDynamicKind, SHORTHAND_RESERVED_NAME_STAND_IN, StructuralKind,
        shorthand_name_is_reserved,
    },
    projection_view::ProjectionSegment,
};

pub(super) struct Builder<'a> {
    source: &'a str,
    overlay: &'a Overlay,
    prefix: &'a str,
    output: String,
    segments: Vec<ProjectionSegment>,
    cursor: usize,
    synthetic_callee_spans: Vec<(u32, u32)>,
    /// Next unwritten entry of `overlay.jsx_text_comments`.
    text_comment: usize,
    /// Next unwritten entry of `overlay.jsx_text_gts`.
    text_gt: usize,
    /// Next unwritten entry of `overlay.implicit_closes`.
    implicit_close: usize,
    anchors: Vec<SyntheticAnchor>,
}
impl<'a> Builder<'a> {
    pub(super) fn new(source: &'a str, overlay: &'a Overlay, prefix: &'a str) -> Self {
        let raw_style_bytes = overlay.style_blocks.iter().fold(0_usize, |bytes, style| {
            bytes.saturating_add(style.content.end.saturating_sub(style.content.start) as usize)
        });
        Self {
            source,
            overlay,
            prefix,
            output: String::with_capacity(
                source
                    .len()
                    .saturating_sub(raw_style_bytes)
                    .saturating_add(overlay.tokens.len().saturating_mul(64))
                    .saturating_add(overlay.embedded_tokens.len().saturating_mul(32))
                    .saturating_add(overlay.parser_shorthand_attributes.len().saturating_mul(8)),
            ),
            segments: Vec::with_capacity(
                overlay
                    .tokens
                    .len()
                    .saturating_mul(2)
                    .saturating_add(overlay.dynamic_tags.len())
                    .saturating_add(overlay.style_blocks.len())
                    .saturating_add(overlay.parser_shorthand_attributes.len().saturating_mul(2))
                    .saturating_add(1),
            ),
            cursor: 0,
            synthetic_callee_spans: Vec::new(),
            text_comment: 0,
            text_gt: 0,
            implicit_close: 0,
            anchors: Vec::new(),
        }
    }

    pub(super) fn finish(mut self) -> Result<MappedProjection, ProjectionError> {
        self.copy_to(self.source.len())?;
        if self.text_comment != self.overlay.jsx_text_comments.len()
            || self.text_gt != self.overlay.jsx_text_gts.len()
            || self.implicit_close != self.overlay.implicit_closes.len()
        {
            return Err(ProjectionError::StructuralMismatch);
        }
        Ok(MappedProjection {
            projected: self.output,
            segments: self.segments,
            dynamic_prefix: None,
            dynamic_count: 0,
            dynamic_offsets: Vec::new(),
            synthetic_generator_spans: Vec::new(),
            synthetic_callee_spans: self.synthetic_callee_spans,
            anchors: self.anchors,
        })
    }

    fn record_synthetic_callee(&mut self, start: usize) -> Result<(), ProjectionError> {
        self.synthetic_callee_spans.push((to_u32(start)?, to_u32(self.output.len())?));
        Ok(())
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

    /// Copies an authored span. A JavaScript comment in JSX text inside it is written in braces,
    /// `{/* ... */}` or `{// ...` and a line break, the empty child TSX reads as a comment, a `>`
    /// in JSX text as [`PARSER_JSX_TEXT_GT_STAND_IN`], and a closing tag a comment swallowed is
    /// written before the `}` that ends its element.
    fn copy_original(&mut self, span: ByteSpan) -> Result<(), ProjectionError> {
        let comments = &self.overlay.jsx_text_comments;
        let gts = &self.overlay.jsx_text_gts;
        let closes = &self.overlay.implicit_closes;
        if self.text_comment == comments.len()
            && self.text_gt == gts.len()
            && self.implicit_close == closes.len()
        {
            return self.copy_verbatim(span);
        }
        let mut start = span.start;
        loop {
            self.write_implicit_closes(start)?;
            let comment = self.overlay.jsx_text_comments.get(self.text_comment).copied();
            let gt = self.overlay.jsx_text_gts.get(self.text_gt).copied();
            if comment.is_some_and(|comment| comment.start < start)
                || gt.is_some_and(|gt| gt < start)
            {
                return Err(ProjectionError::StructuralMismatch);
            }
            let comment = comment.filter(|comment| comment.start < span.end);
            let gt = gt.filter(|gt| *gt < span.end);
            let close = self
                .overlay
                .implicit_closes
                .get(self.implicit_close)
                .map(|close| close.offset)
                .filter(|offset| *offset < span.end);
            let stop = [comment.map(|comment| comment.start), gt, close]
                .into_iter()
                .flatten()
                .fold(span.end, u32::min);
            self.copy_verbatim(ByteSpan::new(start, stop))?;
            start = stop;
            if let Some(comment) = comment
                && comment.start == stop
            {
                if comment.end > span.end {
                    return Err(ProjectionError::StructuralMismatch);
                }
                // The braces stand for the comment's ends, so the container and its empty
                // expression span exactly the comment.
                // A `//` comment runs to `\r` or `\n`; one holding U+2028 or U+2029, which end
                // a comment for OXC, is written inside `/* ... */`.
                let text = &self.source[comment.start as usize..comment.end as usize];
                let line = text.starts_with("//");
                if line && text.contains(['\u{2028}', '\u{2029}']) && !text.contains("*/") {
                    self.push_anchored("{/*", comment.start)?;
                    self.copy_verbatim(comment)?;
                    self.push_anchored("*/}", comment.end)?;
                } else {
                    self.push_anchored("{", comment.start)?;
                    self.copy_verbatim(comment)?;
                    self.push_anchored(if line { "\n}" } else { "}" }, comment.end)?;
                }
                self.text_comment += 1;
                start = comment.end;
                continue;
            }
            if let Some(gt) = gt
                && gt == stop
            {
                if self.source.as_bytes().get(gt as usize) != Some(&b'>') {
                    return Err(ProjectionError::StructuralMismatch);
                }
                // The stand-in takes the `>`'s one byte, and the empty anchor after it stands for
                // the offset after the `>`, so a text that starts or ends at it maps back exactly.
                self.push_anchored(PARSER_JSX_TEXT_GT_STAND_IN, gt)?;
                self.push_anchored("", gt + 1)?;
                self.text_gt += 1;
                start = gt + 1;
                continue;
            }
            if stop == span.end {
                break;
            }
        }
        self.write_implicit_closes(span.end)
    }

    /// Writes the closing tags of the elements a `}` at `offset` ends, innermost first, once the
    /// projection reaches the `}`.
    fn write_implicit_closes(&mut self, offset: u32) -> Result<(), ProjectionError> {
        while let Some(close) = self.overlay.implicit_closes.get(self.implicit_close).copied() {
            if close.offset > offset {
                break;
            }
            if close.offset < offset || self.source.as_bytes().get(offset as usize) != Some(&b'}') {
                return Err(ProjectionError::StructuralMismatch);
            }
            let name = self
                .source
                .get(close.name.start as usize..close.name.end as usize)
                .ok_or(ProjectionError::SourceChanged { offset: close.name.start })?;
            self.push_anchored(&format!("</{name}>"), close.offset)?;
            self.implicit_close += 1;
        }
        Ok(())
    }

    /// Writes generated text that stands for the authored offset `original`.
    fn push_anchored(&mut self, text: &str, original: u32) -> Result<(), ProjectionError> {
        let start = to_u32(self.output.len())?;
        self.output.push_str(text);
        self.anchors.push(SyntheticAnchor {
            projected: ByteSpan::new(start, to_u32(self.output.len())?),
            original,
        });
        Ok(())
    }

    /// Copies an authored span and records it as a fixable segment. Every span this lane copies
    /// verbatim survives a round trip, so the parser can map a fix range back onto any of them.
    fn copy_verbatim(&mut self, span: ByteSpan) -> Result<(), ProjectionError> {
        if span.is_empty() {
            return Ok(());
        }
        let start = span.start as usize;
        let end = span.end as usize;
        let Some(value) = self.source.get(start..end) else {
            return Err(ProjectionError::SourceChanged { offset: span.start });
        };
        let projected_start = to_u32(self.output.len())?;
        self.output.push_str(value);
        let projected_end = to_u32(self.output.len())?;
        if let Some(previous) = self.segments.last_mut()
            && previous.projected.end == projected_start
            && previous.original_start + (previous.projected.end - previous.projected.start)
                == span.start
        {
            previous.projected.end = projected_end;
        } else {
            self.segments.push(ProjectionSegment {
                projected: ByteSpan::new(projected_start, projected_end),
                original_start: span.start,
                fixable: true,
            });
        }
        Ok(())
    }

    pub(super) fn wrapper_start(&mut self, node_index: u32) -> Result<(), ProjectionError> {
        let node = self.overlay.nodes[node_index as usize];
        self.copy_to(node.span.start as usize)?;
        if node.context == ControlContext::JsxChild {
            self.output.push('{');
        }
        // An expression the control starts, such as the left operand of `||` or the test of
        // `? :`, starts where the wrapper does, so the wrapper's start stands for the control's.
        if node.context == ControlContext::Expression {
            self.push_anchored("", node.span.start)?;
        }
        let callee_start = self.output.len();
        write!(self.output, "{}W{node_index}_", self.prefix)
            .expect("writing to a String cannot fail");
        self.record_synthetic_callee(callee_start)?;
        write!(
            self.output,
            "({{async *{}M{node_index}_(){{/*{}N{node_index}S__*/",
            self.prefix, self.prefix
        )
        .expect("writing to a String cannot fail");
        Ok(())
    }

    pub(super) fn wrapper_end(&mut self, node_index: u32) -> Result<(), ProjectionError> {
        let node = self.overlay.nodes[node_index as usize];
        self.copy_to(node.span.end as usize)?;
        write!(
            self.output,
            "/*{}N{node_index}E__*/}}}},{}E{node_index}_)",
            self.prefix, self.prefix
        )
        .expect("writing to a String cannot fail");
        // An expression the control ends, such as a declaration with nothing after the control's
        // `}` before the end of the file, ends where the wrapper does.
        if node.context == ControlContext::Expression {
            self.push_anchored("", node.span.end)?;
        }
        if node.context == ControlContext::JsxChild {
            self.output.push('}');
        }
        Ok(())
    }

    pub(super) fn try_end(&mut self, node_index: u32) -> Result<(), ProjectionError> {
        let node = self.overlay.nodes[node_index as usize];
        if node.kind != ControlKind::Try {
            return Err(ProjectionError::StructuralMismatch);
        }
        self.copy_to(node.span.end as usize)?;
        write!(self.output, "}},{}TE{node_index}_)", self.prefix)
            .expect("writing to a String cannot fail");
        Ok(())
    }

    pub(super) fn token(&mut self, token_index: u32) -> Result<(), ProjectionError> {
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
            StructuralKind::FunctionBody => {
                self.parser_function_body(token_index, start)?;
            }
            StructuralKind::Try => {
                if token.owner == NONE {
                    return Err(ProjectionError::StructuralMismatch);
                }
                write!(self.output, "/*{}{token_index}*/", self.prefix)
                    .expect("writing to a String cannot fail");
                let callee_start = self.output.len();
                write!(self.output, "{}T{}_", self.prefix, token.owner)
                    .expect("writing to a String cannot fail");
                self.record_synthetic_callee(callee_start)?;
                write!(self.output, "({{async *{}B{}_()", self.prefix, token.owner)
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

    fn parser_function_body(
        &mut self,
        token_index: u32,
        start: usize,
    ) -> Result<(), ProjectionError> {
        // Keep the authored opening brace affine. It is either the ordinary function body's
        // brace, a JSX-child expression container, or the authenticated expression scaffold's
        // function-body brace.
        self.cursor = start + 1;
        match self.parser_code_block_kind(token_index) {
            Some(ParserCodeBlockKind::JsxChild) => {
                self.copy_to(start + 2)?;
                write!(
                    self.output,
                    "(async function*{}J{token_index}_(){{/*{}{token_index}*/",
                    self.prefix, self.prefix
                )
                .expect("writing to a String cannot fail");
            }
            Some(ParserCodeBlockKind::Expression) => {
                self.output.push_str(PARSER_EXPRESSION_CODE_BLOCK_PREFIX);
                self.copy_to(start + 2)?;
                write!(self.output, "/*{}{token_index}*/", self.prefix)
                    .expect("writing to a String cannot fail");
            }
            None => {
                self.copy_to(start + 2)?;
                write!(self.output, "/*{}{token_index}*/", self.prefix)
                    .expect("writing to a String cannot fail");
            }
        }
        Ok(())
    }

    fn parser_code_block_kind(&self, token: u32) -> Option<ParserCodeBlockKind> {
        self.overlay
            .parser_code_blocks
            .binary_search_by_key(&token, |block| block.token)
            .ok()
            .map(|index| self.overlay.parser_code_blocks[index].kind)
    }

    pub(super) fn parser_code_block_end(
        &mut self,
        block_index: u32,
    ) -> Result<(), ProjectionError> {
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
        match block.kind {
            ParserCodeBlockKind::JsxChild => {
                self.copy_to(closing)?;
                self.output.push_str("})");
            }
            ParserCodeBlockKind::Expression => {
                self.copy_to(block.body.end as usize)?;
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

    pub(super) fn header(
        &mut self,
        clause_index: u32,
        ordinal: u32,
    ) -> Result<(), ProjectionError> {
        let clause = self.overlay.clauses[clause_index as usize];
        let header = clause.for_header;
        if !header.annotated {
            return Err(ProjectionError::ScaffoldMismatch { index: ordinal as usize });
        }
        self.copy_to(clause.header.start as usize)?;
        self.output.push('(');
        self.copy_original(header.left)?;
        self.output.push_str(" of ");
        let callee_start = self.output.len();
        write!(self.output, "{}H{ordinal}_", self.prefix).expect("writing to a String cannot fail");
        self.record_synthetic_callee(callee_start)?;
        write!(self.output, "(/*{}R{ordinal}S__*/", self.prefix)
            .expect("writing to a String cannot fail");
        self.copy_original(header.right)?;
        write!(self.output, "/*{}R{ordinal}E__*/", self.prefix)
            .expect("writing to a String cannot fail");
        if !header.index.is_empty() {
            self.output.push(',');
            let callee_start = self.output.len();
            write!(self.output, "{}IH{ordinal}_", self.prefix)
                .expect("writing to a String cannot fail");
            self.record_synthetic_callee(callee_start)?;
            write!(self.output, "(/*{}I{ordinal}S__*/", self.prefix)
                .expect("writing to a String cannot fail");
            self.copy_original(header.index)?;
            write!(self.output, "/*{}I{ordinal}E__*/)", self.prefix)
                .expect("writing to a String cannot fail");
        }
        if !header.key.is_empty() {
            self.output.push(',');
            let callee_start = self.output.len();
            write!(self.output, "{}KH{ordinal}_", self.prefix)
                .expect("writing to a String cannot fail");
            self.record_synthetic_callee(callee_start)?;
            write!(self.output, "(/*{}K{ordinal}S__*/", self.prefix)
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

    /// Projects the raw content of an inline `<style>` block.
    ///
    /// The parser lane rewrites dynamic openings and closings from `parser_dynamic_tokens`, which
    /// carry the authored closing expression this lane must retain, so `project_actions` routes
    /// only style content here.
    pub(super) fn embedded(&mut self, token_index: u32) -> Result<(), ProjectionError> {
        let token = self.overlay.embedded_tokens[token_index as usize];
        let marker = match token.kind {
            EmbeddedKind::StyleContent => {
                self.copy_to(token.span.start as usize)?;
                let style = self
                    .overlay
                    .style_blocks
                    .get(token.owner as usize)
                    .ok_or(ProjectionError::StructuralMismatch)?;
                if style.content != token.span {
                    return Err(ProjectionError::StructuralMismatch);
                }
                'S'
            }
            EmbeddedKind::ScriptContent => {
                self.copy_to(token.span.start as usize)?;
                let script = self
                    .overlay
                    .script_blocks
                    .get(token.owner as usize)
                    .ok_or(ProjectionError::StructuralMismatch)?;
                if script.content != token.span {
                    return Err(ProjectionError::StructuralMismatch);
                }
                'Q'
            }
            EmbeddedKind::DynamicOpen | EmbeddedKind::DynamicClose => return Ok(()),
        };
        write!(self.output, "{{/*{}{marker}{}__*/ null}}", self.prefix, token.owner)
            .expect("writing to a String cannot fail");
        self.cursor = token.span.end as usize;
        Ok(())
    }

    pub(super) fn parser_dynamic(&mut self, token_index: u32) -> Result<(), ProjectionError> {
        let token = self.overlay.parser_dynamic_tokens[token_index as usize];
        let tag = self
            .overlay
            .dynamic_tags
            .get(token.owner as usize)
            .ok_or(ProjectionError::StructuralMismatch)?;
        match token.kind {
            ParserDynamicKind::OpenStart => {
                if token.offset != tag.opening.start
                    || self
                        .source
                        .as_bytes()
                        .get(tag.opening.start as usize..tag.expression.start as usize)
                        != Some(b"<{")
                {
                    return Err(ProjectionError::StructuralMismatch);
                }
                self.copy_to(tag.opening.start as usize)?;
                // Anchored, like the `))}</…>` below, so an expression that starts or ends at a
                // tag nested in another tag's expression still has authored ends.
                self.push_anchored(
                    &format!(
                        "<{}D{} {}A{}_={{(",
                        self.prefix, token.owner, self.prefix, token.owner
                    ),
                    tag.opening.start,
                )?;
                self.cursor = tag.expression.start as usize;
            }
            ParserDynamicKind::OpenEnd => {
                if token.offset != tag.expression.end
                    || tag.opening.end != tag.expression.end.saturating_add(1)
                    || self.source.as_bytes().get(tag.expression.end as usize) != Some(&b'}')
                {
                    return Err(ProjectionError::StructuralMismatch);
                }
                self.copy_to(tag.expression.end as usize)?;
                write!(self.output, ")}} {}Z{}_={{null}}", self.prefix, token.owner)
                    .expect("writing to a String cannot fail");
                self.cursor = tag.opening.end as usize;
            }
            ParserDynamicKind::CloseStart => {
                if token.offset != tag.closing.start
                    || self
                        .source
                        .as_bytes()
                        .get(tag.closing.start as usize..tag.closing_expression.start as usize)
                        != Some(b"</{")
                {
                    return Err(ProjectionError::StructuralMismatch);
                }
                self.copy_to(tag.closing.start as usize)?;
                self.output.push('{');
                let callee_start = self.output.len();
                write!(self.output, "{}C{}_", self.prefix, token.owner)
                    .expect("writing to a String cannot fail");
                self.record_synthetic_callee(callee_start)?;
                self.output.push_str("((");
                self.cursor = tag.closing_expression.start as usize;
            }
            ParserDynamicKind::CloseEnd => {
                if token.offset != tag.closing_expression.end
                    || tag.closing.end <= tag.closing_expression.end
                {
                    return Err(ProjectionError::StructuralMismatch);
                }
                self.copy_to(tag.closing_expression.end as usize)?;
                self.push_anchored(
                    &format!("))}}</{}D{}>", self.prefix, token.owner),
                    tag.closing.end,
                )?;
                self.cursor = tag.closing.end as usize;
            }
        }
        Ok(())
    }

    pub(super) fn parser_shorthand(&mut self, attribute_index: u32) -> Result<(), ProjectionError> {
        let attribute = self
            .overlay
            .parser_shorthand_attributes
            .get(attribute_index as usize)
            .ok_or(ProjectionError::StructuralMismatch)?;
        let attribute = *attribute;
        let bytes = self.source.as_bytes();
        if attribute.span.start >= attribute.identifier.start
            || attribute.identifier.end >= attribute.span.end
            || bytes.get(attribute.span.start as usize) != Some(&b'{')
            || bytes.get(attribute.span.end.saturating_sub(1) as usize) != Some(&b'}')
        {
            return Err(ProjectionError::StructuralMismatch);
        }
        let name = bytes
            .get(attribute.identifier.start as usize..attribute.identifier.end as usize)
            .ok_or(ProjectionError::SourceChanged { offset: attribute.identifier.start })?;
        self.copy_to(attribute.span.start as usize)?;
        // `<a{b} />` glues the shorthand to the tag name, which the scaffold name must not join.
        if !self.output.ends_with(|character: char| {
            character.is_ascii_whitespace() || matches!(character, '\u{2028}' | '\u{2029}')
        }) {
            self.output.push(' ');
        }
        write!(self.output, "{}S{attribute_index}_", self.prefix)
            .expect("writing to a String cannot fail");
        self.output.push('=');
        if shorthand_name_is_reserved(name) {
            // TSX can't read a reserved word as the container's identifier; the parser writes the
            // authored name back.
            self.copy_original(ByteSpan::new(attribute.span.start, attribute.identifier.start))?;
            self.push_anchored(SHORTHAND_RESERVED_NAME_STAND_IN, attribute.identifier.start)?;
            self.copy_original(ByteSpan::new(attribute.identifier.end, attribute.span.end))?;
        } else {
            self.copy_original(attribute.span)?;
        }
        self.cursor = attribute.span.end as usize;
        Ok(())
    }

    /// Writes the `;` that a new statement-level markup opening implies, immediately before the
    /// opening so the authored `<` is still copied verbatim and every authored byte keeps its
    /// segment. Used for line-leading markup and for a sibling JSX statement after another JSX
    /// tree.
    pub(super) fn statement_boundary(&mut self, boundary: u32) -> Result<(), ProjectionError> {
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
}

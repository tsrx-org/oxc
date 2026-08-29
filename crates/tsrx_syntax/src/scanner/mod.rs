use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{
        ByteSpan, Clause, DynamicTag, EmbeddedToken, NONE, Overlay, StructuralKind,
        StructuralToken, StyleBlock, SyntaxNode,
    },
};

mod control;
mod header;
mod jsx;
mod lexical;
mod overlay;
mod stack;

pub(crate) use lexical::is_identifier_continue;
use lexical::{previous_significant_byte, unsupported_at_construct};
use stack::TinyStack;

pub(crate) struct Scanner<'a> {
    bytes: &'a [u8],
    tokens: Vec<StructuralToken>,
    nodes: Vec<SyntaxNode>,
    clauses: Vec<Clause>,
    embedded_tokens: Vec<EmbeddedToken>,
    dynamic_tags: Vec<DynamicTag>,
    dynamic_comments: Vec<ByteSpan>,
    style_blocks: Vec<StyleBlock>,
    statement_boundaries: Vec<u32>,
    first_root: u32,
    last_root: u32,
    parents: Vec<u32>,
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

impl<'a> Scanner<'a> {
    pub(crate) fn new(source: &'a str) -> Self {
        let bytes = source.as_bytes();
        Self {
            bytes,
            tokens: Vec::with_capacity(bytes.len().div_ceil(384)),
            nodes: Vec::with_capacity(bytes.len().div_ceil(1024)),
            clauses: Vec::with_capacity(bytes.len().div_ceil(512)),
            // Dynamic tags and raw styles are sparse. Keep the common zero-syntax path free of
            // avoidable heap allocations; the flat vectors grow after the first commit.
            embedded_tokens: Vec::new(),
            dynamic_tags: Vec::new(),
            dynamic_comments: Vec::new(),
            style_blocks: Vec::new(),
            statement_boundaries: Vec::new(),
            first_root: NONE,
            last_root: NONE,
            parents: Vec::with_capacity(8),
        }
    }

    pub(crate) fn finish(mut self) -> Result<Overlay, ProjectionError> {
        let source_len = to_u32(self.bytes.len())?;
        self.scan_region(0, None)?;
        Ok(Overlay {
            source_len,
            source_fingerprint: source_fingerprint(self.bytes),
            parser_metadata: false,
            tokens: self.tokens,
            nodes: self.nodes,
            clauses: self.clauses,
            embedded_tokens: self.embedded_tokens,
            parser_dynamic_tokens: Vec::new(),
            parser_code_blocks: Vec::new(),
            parser_shorthand_attributes: Vec::new(),
            parser_lazy_patterns: Vec::new(),
            dynamic_tags: self.dynamic_tags,
            dynamic_comments: self.dynamic_comments,
            style_blocks: self.style_blocks,
            script_blocks: Vec::new(),
            statement_boundaries: self.statement_boundaries,
            first_root: self.first_root,
            last_root: self.last_root,
        })
    }

    #[expect(
        clippy::too_many_lines,
        reason = "a byte-level scanner state machine whose arms only make sense read in source order"
    )]
    fn scan_region(
        &mut self,
        mut index: usize,
        closing: Option<u8>,
    ) -> Result<usize, ProjectionError> {
        let mut delimiters = TinyStack::<(u8, bool), 16>::new();
        if let Some(closing) = closing {
            delimiters.push((closing, closing == b'}'));
        }
        let mut can_start_expression = true;
        let mut can_start_jsx = true;
        let mut pending_control_paren = false;
        let mut closed_control_paren = false;
        let mut parens = TinyStack::<bool, 16>::new();

        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if byte.is_ascii_whitespace() {
                index += 1;
                continue;
            }

            match byte {
                b'\'' | b'"' => {
                    index = self.skip_quote(index, byte)?;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'`' => {
                    index = self.scan_template(index)?;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                    index = self.skip_line_comment(index + 2);
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    index = self.skip_block_comment(index)?;
                }
                b'/' if can_start_expression => {
                    index = self.skip_regex(index)?;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'/' => {
                    index += usize::from(self.bytes.get(index + 1) == Some(&b'=')) + 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'<' if (can_start_jsx || self.line_leading_markup_starts_a_statement(index))
                    && self.looks_like_jsx_start(index)
                    && !self.looks_like_typescript_type_parameters(index) =>
                {
                    let checkpoint = self.checkpoint();
                    let committed = self.committed_jsx_opening(index);
                    if !can_start_jsx {
                        // Only the line-leading rule admitted this opening, so the legal-TSX lane
                        // needs an explicit `;` where TSRX read a statement boundary.
                        self.statement_boundaries.push(to_u32(index)?);
                    }
                    match self.scan_jsx_element(index) {
                        Ok(end) => {
                            index = end;
                            can_start_expression = false;
                            can_start_jsx = true;
                            pending_control_paren = false;
                            closed_control_paren = false;
                        }
                        Err(ProjectionError::UnsupportedSyntax { offset, construct }) => {
                            return Err(ProjectionError::UnsupportedSyntax { offset, construct });
                        }
                        Err(error) if committed => return Err(error),
                        Err(_) => {
                            self.rollback(checkpoint);
                            index += 1;
                            can_start_expression = true;
                            can_start_jsx = false;
                            pending_control_paren = false;
                            closed_control_paren = false;
                        }
                    }
                }
                b'@' if self.keyword_at(index, b"if") => {
                    index = self.parse_if(index, self.code_context(index))?;
                    can_start_expression = false;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'@' if self.keyword_at(index, b"for") => {
                    index = self.parse_for(index, self.code_context(index))?;
                    can_start_expression = false;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'@' if self.keyword_at(index, b"switch") => {
                    index = self.parse_switch(index, self.code_context(index))?;
                    can_start_expression = false;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'@' if self.keyword_at(index, b"try") => {
                    index = self.parse_try(index, self.code_context(index))?;
                    can_start_expression = false;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'@' if self.bytes.get(index + 1) == Some(&b'{') => {
                    self.push_token(StructuralKind::FunctionBody, index)?;
                    index += 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'@' => {
                    if self.keyword_at(index, b"else")
                        || self.keyword_at(index, b"empty")
                        || self.keyword_at(index, b"case")
                        || self.keyword_at(index, b"default")
                        || self.keyword_at(index, b"pending")
                        || self.keyword_at(index, b"catch")
                    {
                        return Err(ProjectionError::MalformedSyntax {
                            offset: to_u32(index)?,
                            expected: "an owning TSRX control",
                        });
                    }
                    if let Some(construct) = unsupported_at_construct(self.bytes, index) {
                        return Err(ProjectionError::UnsupportedSyntax {
                            offset: to_u32(index)?,
                            construct,
                        });
                    }
                    index += 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'(' | b'[' | b'{' => {
                    let close = match byte {
                        b'(' => b')',
                        b'[' => b']',
                        b'{' => b'}',
                        _ => unreachable!(),
                    };
                    let previous = previous_significant_byte(self.bytes, index);
                    let block = byte == b'{'
                        && (!can_start_expression
                            || closed_control_paren
                            || previous == Some(b'@')
                            || previous == Some(b';')
                            || previous == Some(b'}')
                            || previous == Some(b'>')
                                && previous_significant_byte(self.bytes, index.saturating_sub(1))
                                    == Some(b'='));
                    delimiters.push((close, block));
                    if byte == b'(' {
                        parens.push(pending_control_paren);
                    }
                    pending_control_paren = false;
                    closed_control_paren = false;
                    index += 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                }
                b')' | b']' | b'}' => {
                    let mut closed_block = false;
                    if delimiters.last().is_some_and(|delimiter| delimiter.0 == byte) {
                        closed_block = delimiters.pop().is_some_and(|delimiter| delimiter.1);
                        index += 1;
                        if delimiters.is_empty() && closing.is_some() {
                            return Ok(index);
                        }
                    } else if closing.is_some() {
                        return Err(ProjectionError::MalformedSyntax {
                            offset: to_u32(index)?,
                            expected: "a matching delimiter",
                        });
                    } else {
                        index += 1;
                    }
                    can_start_expression = if byte == b')' {
                        let control = parens.pop().unwrap_or(false);
                        closed_control_paren = control;
                        control
                    } else if byte == b'}' {
                        closed_control_paren = false;
                        closed_block
                    } else {
                        closed_control_paren = false;
                        false
                    };
                    can_start_jsx = (byte == b'}' && closed_block) || can_start_expression;
                    pending_control_paren = false;
                }
                b'0'..=b'9' => {
                    index = self.skip_number(index);
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                _ if self.identifier_start_width(index).is_some() => {
                    let end = self.skip_identifier(index);
                    let identifier = &self.bytes[index..end];
                    let type_position = identifier == b"void"
                        && previous_significant_byte(self.bytes, index) == Some(b':');
                    pending_control_paren = matches!(
                        identifier,
                        b"if" | b"for" | b"while" | b"with" | b"switch" | b"catch"
                    );
                    can_start_expression = !type_position
                        && (pending_control_paren
                            || matches!(
                                identifier,
                                b"return"
                                    | b"throw"
                                    | b"case"
                                    | b"delete"
                                    | b"void"
                                    | b"typeof"
                                    | b"new"
                                    | b"yield"
                                    | b"await"
                                    | b"in"
                                    | b"of"
                                    | b"instanceof"
                            ));
                    can_start_jsx = can_start_expression;
                    closed_control_paren = false;
                    index = end;
                }
                b'+' | b'-'
                    if self.bytes.get(index + 1) == Some(&byte) && !can_start_expression =>
                {
                    index += 2;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'!' if !can_start_expression => {
                    // In TypeScript expression position this is a postfix non-null assertion,
                    // so a following `/` is division rather than the start of a regexp.
                    index += 1;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                b'.' => {
                    index += if self.bytes.get(index..index + 3) == Some(b"...") { 3 } else { 1 };
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
                _ => {
                    index += 1;
                    can_start_expression = !matches!(byte, b']');
                    can_start_jsx = can_start_expression || matches!(byte, b';');
                    pending_control_paren = false;
                    closed_control_paren = false;
                }
            }
        }

        if closing.is_some() {
            return Err(ProjectionError::UnterminatedSyntax {
                offset: to_u32(index.saturating_sub(1))?,
                construct: "delimited expression",
            });
        }
        Ok(index)
    }
}

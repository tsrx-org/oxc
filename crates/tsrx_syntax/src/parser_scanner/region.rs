//! The main loop: walking one balanced region byte by byte and dispatching to whichever construct
//! begins at the cursor.

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{ParserCodeBlockKind, ParserLazyPattern, StructuralKind},
};

use super::Scanner;
use super::lexical::previous_significant_byte;
use super::lexical::unsupported_at_construct;
use super::stack::TinyStack;

impl Scanner<'_> {
    pub(super) fn scan_region(
        &mut self,
        index: usize,
        closing: Option<u8>,
    ) -> Result<usize, ProjectionError> {
        self.scan_region_with_root_context(index, closing, None)
    }

    pub(super) fn scan_expression_region(
        &mut self,
        index: usize,
        closing: Option<u8>,
    ) -> Result<usize, ProjectionError> {
        let root_control_start = self.skip_trivia(index)?;
        self.scan_region_with_root_context(index, closing, Some(root_control_start))
    }

    #[expect(
        clippy::too_many_lines,
        reason = "a byte-level scanner state machine whose arms only make sense read in source order"
    )]
    fn scan_region_with_root_context(
        &mut self,
        mut index: usize,
        closing: Option<u8>,
        root_control_start: Option<usize>,
    ) -> Result<usize, ProjectionError> {
        let mut delimiters = TinyStack::<(u8, bool), 16>::new();
        if let Some(closing) = closing {
            delimiters.push((closing, closing == b'}'));
        }
        let mut can_start_expression = true;
        let mut can_start_jsx = true;
        let mut pending_control_paren = false;
        let mut closed_control_paren = false;
        let mut pending_statement_body = false;
        let mut pending_arrow_body = false;
        let mut parens = TinyStack::<bool, 16>::new();
        let mut paren_starts = TinyStack::<usize, 16>::new();
        let mut pending_lazy_arrow_patterns = Vec::<(usize, usize, usize)>::new();
        let mut previous_token = None;

        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if byte.is_ascii_whitespace() {
                index += 1;
                continue;
            }

            let follows_arrow = pending_arrow_body;
            pending_arrow_body = false;
            let records_previous_token =
                !matches!(self.bytes.get(index..index + 2), Some(b"//" | b"/*"));
            match byte {
                b'\'' | b'"' => {
                    index = self.skip_quote(index, byte)?;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'`' => {
                    index = self.scan_template(index)?;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                    index = self.skip_line_comment(index + 2);
                    pending_arrow_body = follows_arrow;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    index = self.skip_block_comment(index)?;
                    pending_arrow_body = follows_arrow;
                }
                b'/' if can_start_expression => {
                    index = self.skip_regex(index)?;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'/' => {
                    index += usize::from(self.bytes.get(index + 1) == Some(&b'=')) + 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'<' if (can_start_jsx || self.line_leading_markup_starts_a_statement(index))
                    && self.looks_like_jsx_start(index)
                    && !self.looks_like_typescript_type_parameters(index) =>
                {
                    let checkpoint = self.checkpoint();
                    let committed = self.committed_jsx_opening(index);
                    if !can_start_jsx || !can_start_expression {
                        // Legal TSX cannot place two JSX trees in one expression. Insert `;`
                        // when this opening starts a new statement: either the line-leading
                        // exception (`!can_start_jsx`) or a sibling after a completed JSX
                        // statement (`!can_start_expression`).
                        self.statement_boundaries.push(to_u32(index)?);
                    }
                    match self.scan_jsx_element(index) {
                        Ok(end) => {
                            index = end;
                            can_start_expression = false;
                            can_start_jsx = true;
                            pending_control_paren = false;
                            closed_control_paren = false;
                            pending_statement_body = false;
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
                            pending_statement_body = false;
                        }
                    }
                }
                b'@' if self.keyword_at(index, b"if") => {
                    index = self.parse_if(index, self.code_context(index, root_control_start))?;
                    can_start_expression = false;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'@' if self.keyword_at(index, b"for") => {
                    index = self.parse_for(index, self.code_context(index, root_control_start))?;
                    can_start_expression = false;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'@' if self.keyword_at(index, b"switch") => {
                    index =
                        self.parse_switch(index, self.code_context(index, root_control_start))?;
                    can_start_expression = false;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'@' if self.keyword_at(index, b"try") => {
                    index = self.parse_try(index, self.code_context(index, root_control_start))?;
                    can_start_expression = false;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'@' if self.bytes.get(index + 1) == Some(&b'{') => {
                    if (can_start_expression || pending_statement_body) && !follows_arrow {
                        index =
                            self.scan_parser_code_block(index, ParserCodeBlockKind::Expression)?;
                        can_start_expression = false;
                    } else {
                        self.push_token(StructuralKind::FunctionBody, index)?;
                        index += 1;
                        can_start_expression = true;
                    }
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
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
                    pending_statement_body = false;
                }
                b'&' if self.lazy_pattern_start(index).is_some() => {
                    let pattern_start = self
                        .lazy_pattern_start(index)
                        .ok_or(ProjectionError::StructuralMismatch)?;
                    self.parser_lazy_patterns.push(ParserLazyPattern {
                        ampersand: to_u32(index)?,
                        pattern_start: to_u32(pattern_start)?,
                        standalone: false,
                    });
                    index += 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'&' if self
                    .lazy_arrow_pattern_start(
                        index,
                        paren_starts.last(),
                        previous_token,
                        pattern_interior(&delimiters),
                    )
                    .is_some() =>
                {
                    let pattern_start = self
                        .lazy_arrow_pattern_start(
                            index,
                            paren_starts.last(),
                            previous_token,
                            pattern_interior(&delimiters),
                        )
                        .ok_or(ProjectionError::StructuralMismatch)?;
                    pending_lazy_arrow_patterns.push((
                        paren_starts.last().ok_or(ProjectionError::StructuralMismatch)?,
                        index,
                        pattern_start,
                    ));
                    index += 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'&' if self
                    .standalone_lazy_pattern_start(
                        index,
                        closed_control_paren || pending_statement_body,
                        inside_parentheses(&delimiters),
                    )
                    .is_some() =>
                {
                    let pattern_start = self
                        .standalone_lazy_pattern_start(
                            index,
                            closed_control_paren || pending_statement_body,
                            inside_parentheses(&delimiters),
                        )
                        .ok_or(ProjectionError::StructuralMismatch)?;
                    self.parser_lazy_patterns.push(ParserLazyPattern {
                        ampersand: to_u32(index)?,
                        pattern_start: to_u32(pattern_start)?,
                        standalone: true,
                    });
                    index += 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
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
                        paren_starts.push(index);
                    }
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                    index += 1;
                    can_start_expression = true;
                    can_start_jsx = true;
                }
                b')' | b']' | b'}' => {
                    let mut closed_block = false;
                    let parameter_open = (byte == b')').then(|| paren_starts.pop()).flatten();
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
                    if let Some(parameter_open) = parameter_open {
                        // Only parens that queued a marker are worth the lookahead; classifying
                        // every closing paren would rescan the tail of the file each time.
                        let is_arrow = pending_lazy_arrow_patterns
                            .iter()
                            .any(|(open, _, _)| *open == parameter_open)
                            && self.arrow_follows_parameter_list(index);
                        let mut pending = 0;
                        while pending < pending_lazy_arrow_patterns.len() {
                            let (open, ampersand, pattern_start) =
                                pending_lazy_arrow_patterns[pending];
                            if open != parameter_open {
                                pending += 1;
                                continue;
                            }
                            pending_lazy_arrow_patterns.remove(pending);
                            if is_arrow {
                                let pattern = ParserLazyPattern {
                                    ampersand: to_u32(ampersand)?,
                                    pattern_start: to_u32(pattern_start)?,
                                    standalone: false,
                                };
                                let insert =
                                    self.parser_lazy_patterns.partition_point(|existing| {
                                        existing.ampersand < pattern.ampersand
                                    });
                                self.parser_lazy_patterns.insert(insert, pattern);
                            }
                        }
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
                    pending_statement_body = false;
                }
                b'0'..=b'9' => {
                    index = self.skip_number(index);
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                _ if self.identifier_start_width(index).is_some() => {
                    let end = self.skip_identifier(index);
                    let identifier = &self.bytes[index..end];
                    let type_position = identifier == b"void"
                        && previous_significant_byte(self.bytes, index) == Some(b':');
                    if identifier == b"catch"
                        && previous_significant_byte(self.bytes, index) != Some(b'.')
                    {
                        let open = self.skip_trivia(end)?;
                        self.register_lazy_catch_parameter(open)?;
                    }
                    if identifier == b"for"
                        && previous_significant_byte(self.bytes, index) != Some(b'.')
                    {
                        let mut open = self.skip_trivia(end)?;
                        if self.bare_keyword_at(open, b"await") {
                            open = self.skip_trivia(Self::after_bare_keyword(open, b"await"))?;
                        }
                        self.register_lazy_loop_target(open)?;
                    }
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
                                    | b"default"
                                    | b"in"
                                    | b"of"
                                    | b"instanceof"
                            ));
                    can_start_jsx = can_start_expression;
                    closed_control_paren = false;
                    pending_statement_body = matches!(identifier, b"else" | b"do");
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
                    pending_statement_body = false;
                }
                b'!' if !can_start_expression => {
                    // In TypeScript expression position this is a postfix non-null assertion,
                    // so a following `/` is division rather than the start of a regexp.
                    index += 1;
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                b'.' => {
                    index += if self.bytes.get(index..index + 3) == Some(b"...") { 3 } else { 1 };
                    can_start_expression = false;
                    can_start_jsx = false;
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
                _ => {
                    pending_arrow_body =
                        byte == b'>' && previous_significant_byte(self.bytes, index) == Some(b'=');
                    index += 1;
                    can_start_expression = !matches!(byte, b']');
                    can_start_jsx = can_start_expression || matches!(byte, b';');
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
            }
            if records_previous_token {
                previous_token = Some(byte);
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

/// Whether the innermost group still open is an object or array one — the interior of a
/// destructuring pattern rather than the parameter list that encloses it. A `(` here means the
/// cursor sits directly among the parameters, where a `:` is a type annotation.
fn pattern_interior(delimiters: &TinyStack<(u8, bool), 16>) -> bool {
    matches!(delimiters.last(), Some((b'}' | b']', _)))
}

/// Whether the innermost group still open is a `(` one, where a parameter list or an ordinary
/// parenthesised expression lives and a statement cannot begin.
fn inside_parentheses(delimiters: &TinyStack<(u8, bool), 16>) -> bool {
    matches!(delimiters.last(), Some((b')', _)))
}

//! The main loop: walking one balanced region byte by byte and dispatching to whichever construct
//! begins at the cursor.

use crate::{
    diagnostics::{ProjectionError, to_u32},
    model::{ByteSpan, ControlContext, ParserCodeBlockKind, StructuralKind},
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
        self.scan_region_with_root_context(index, closing, None, false)
    }

    pub(super) fn scan_expression_region(
        &mut self,
        index: usize,
        closing: Option<u8>,
    ) -> Result<usize, ProjectionError> {
        let root_control_start = self.skip_trivia(index)?;
        self.scan_region_with_root_context(index, closing, Some(root_control_start), false)
    }

    #[expect(
        clippy::too_many_lines,
        reason = "a byte-level scanner state machine whose arms only make sense read in source order"
    )]
    /// `case_body` marks an `@case` or `@default` body, whose expression containers it records.
    pub(super) fn scan_region_with_root_context(
        &mut self,
        mut index: usize,
        closing: Option<u8>,
        root_control_start: Option<usize>,
        case_body: bool,
    ) -> Result<usize, ProjectionError> {
        let region_start = index;
        // The last markup element that closed directly in a case body, and the slot of the
        // case-body expression container still open, if any.
        let mut case_markup_end = None;
        let mut open_case_expression = None;
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
        // Per open `(`: whether it follows a control keyword, and whether it can open a parameter
        // list, so its `)` may be followed by a return type annotation.
        let mut parens = TinyStack::<(bool, bool), 16>::new();
        // Whether the last token, comments aside, can end a method or function name, so a `(`
        // after it can open a parameter list: a name or keyword (`render`, `function`), a quoted
        // or computed name (`'render'`, `[key]`), an optional marker (`render?`), or the `>` that
        // closes type parameters (`App<T>`).
        let mut pending_parameter_list = false;
        // The offset of a template body `@{` found right after a return type annotation.
        let mut return_type_body = None;
        let mut token_end = region_start;

        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if byte.is_ascii_whitespace() {
                index += 1;
                continue;
            }
            let comment = byte == b'/' && matches!(self.bytes.get(index + 1), Some(b'/' | b'*'));
            let previous_token_end = token_end;

            let follows_arrow = pending_arrow_body;
            pending_arrow_body = false;
            let follows_name = pending_parameter_list;
            pending_parameter_list = false;
            match byte {
                b'\'' | b'"' => {
                    index = self.skip_quote(index, byte)?;
                    pending_parameter_list = true;
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
                    pending_parameter_list = follows_name;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    index = self.skip_block_comment(index)?;
                    pending_arrow_body = follows_arrow;
                    pending_parameter_list = follows_name;
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
                    // A markup element that begins a statement, as opposed to one inside an
                    // expression container or a control header. The lift reads this list to
                    // tell Oxfmt's ASI guard apart from a `;` that is content. Recorded before
                    // the element is scanned, so an element nested inside this one's expression
                    // children lands after it and the list stays in source order; a rollback
                    // truncates it with everything else.
                    if matches!(
                        self.code_context(index, root_control_start),
                        ControlContext::Statement
                    ) {
                        self.markup_statements.push(to_u32(index)?);
                    }
                    match self.scan_jsx_element(index) {
                        Ok(end) => {
                            if case_body && delimiters.len() == 1 {
                                case_markup_end = Some(end);
                            }
                            index = end;
                            can_start_expression = false;
                            can_start_jsx = true;
                            pending_control_paren = false;
                            closed_control_paren = false;
                            pending_statement_body = false;
                        }
                        // `<P>(props: P): void` in an interface or a function type is markup
                        // only to a scanner that cannot see it is in a type. When the markup
                        // reading fails, the signature's shape hands it to OXC as code.
                        Err(_) if self.looks_like_signature_type_parameters(index) => {
                            self.rollback(checkpoint);
                            index += 1;
                            can_start_expression = true;
                            can_start_jsx = false;
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
                    if (can_start_expression || pending_statement_body)
                        && !follows_arrow
                        && return_type_body != Some(index)
                    {
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
                b'(' | b'[' | b'{' => {
                    let close = match byte {
                        b'(' => b')',
                        b'[' => b']',
                        b'{' => b'}',
                        _ => unreachable!(),
                    };
                    if byte == b'{'
                        && case_body
                        && delimiters.len() == 1
                        && self.starts_case_consequent(
                            index,
                            previous_token_end,
                            region_start,
                            case_markup_end,
                        )
                    {
                        open_case_expression = Some(self.case_expressions.len());
                        self.case_expressions.push(ByteSpan::new(to_u32(index)?, to_u32(index)?));
                    }
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
                        parens.push((pending_control_paren, follows_name));
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
                    if delimiters.last().is_some_and(|delimiter| delimiter.0 == byte) {
                        closed_block = delimiters.pop().is_some_and(|delimiter| delimiter.1);
                        index += 1;
                        if byte == b'}'
                            && delimiters.len() == 1
                            && let Some(slot) = open_case_expression.take()
                        {
                            self.case_expressions[slot].end = to_u32(index)?;
                        }
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
                        let (control, parameters) = parens.pop().unwrap_or((false, false));
                        if parameters
                            && let Ok(colon) = self.skip_trivia(index)
                            && self.bytes.get(colon) == Some(&b':')
                            && let Some(body) = self.return_type_template_body(colon)
                        {
                            return_type_body = Some(body);
                        }
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
                    pending_parameter_list = byte == b']';
                    pending_control_paren = false;
                    pending_statement_body = false;
                }
                b'0'..=b'9' => {
                    index = self.skip_number(index);
                    pending_parameter_list = true;
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
                    pending_parameter_list = true;
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
                    pending_parameter_list = byte == b'?' || byte == b'>' && !pending_arrow_body;
                    index += 1;
                    can_start_expression = !matches!(byte, b']');
                    can_start_jsx = can_start_expression || matches!(byte, b';');
                    pending_control_paren = false;
                    closed_control_paren = false;
                    pending_statement_body = false;
                }
            }
            if !comment {
                token_end = index;
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

    /// Whether the `{` at `index`, directly in an `@case` or `@default` body, begins a
    /// consequent, which `@tsrx/core` reads as a template expression container: it opens the
    /// body, follows a `;`, a `}`, or a markup element, or starts a line after a token that ends
    /// a statement there by ASI. `token_end` is the end of the last token before it, comments
    /// aside.
    fn starts_case_consequent(
        &self,
        index: usize,
        token_end: usize,
        region_start: usize,
        markup_end: Option<usize>,
    ) -> bool {
        if token_end == region_start || markup_end == Some(token_end) {
            return true;
        }
        let Some(previous) = token_end.checked_sub(1) else {
            return false;
        };
        if matches!(self.bytes[previous], b';' | b'}') {
            return true;
        }
        if !self.bytes[token_end..index].iter().any(|byte| matches!(byte, b'\n' | b'\r')) {
            return false;
        }
        match self.bytes[previous] {
            b'\'' | b'"' | b'`' | b']' => true,
            byte if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$') => {
                let word_start = self.bytes[..=previous]
                    .iter()
                    .rposition(|byte| {
                        !(byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
                    })
                    .map_or(0, |at| at + 1);
                !matches!(&self.bytes[word_start..=previous], b"else" | b"try" | b"finally" | b"do")
            }
            _ => false,
        }
    }
}

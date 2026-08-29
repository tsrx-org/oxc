//! Skipping the JavaScript token forms whose interiors must not be searched for TSRX syntax:
//! strings, templates, regexes, comments, numbers, and identifiers.

use crate::diagnostics::{ProjectionError, to_u32};

use super::Scanner;
use super::surrogates::OpaqueSurrogateContext;

impl Scanner<'_> {
    pub(super) fn scan_template(&mut self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut raw_start = index;
        let mut escaped = false;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
                index += 1;
            } else if byte == b'\\' {
                escaped = true;
                index += 1;
            } else if byte == b'`' {
                self.mark_surrogates(raw_start, index, OpaqueSurrogateContext::TemplateRaw);
                return Ok(index + 1);
            } else if byte == b'$' && self.bytes.get(index + 1) == Some(&b'{') {
                self.mark_surrogates(raw_start, index, OpaqueSurrogateContext::TemplateRaw);
                index = self.scan_expression_region(index + 2, Some(b'}'))?;
                raw_start = index;
            } else {
                index += 1;
            }
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "template literal",
        })
    }

    pub(super) fn skip_template_raw(
        &self,
        start: usize,
        end: usize,
    ) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut raw_start = index;
        let mut escaped = false;
        let mut braces = 0usize;
        while index < end {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'`' && braces == 0 {
                self.mark_surrogates(raw_start, index, OpaqueSurrogateContext::TemplateRaw);
                return Ok(index + 1);
            } else if byte == b'$' && self.bytes.get(index + 1) == Some(&b'{') {
                if braces == 0 {
                    self.mark_surrogates(raw_start, index, OpaqueSurrogateContext::TemplateRaw);
                }
                braces += 1;
                index += 1;
            } else if byte == b'}' && braces > 0 {
                braces -= 1;
                if braces == 0 {
                    raw_start = index + 1;
                }
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "template literal",
        })
    }

    pub(super) fn skip_quote(&self, start: usize, quote: u8) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut escaped = false;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                self.mark_surrogates(start + 1, index, OpaqueSurrogateContext::QuotedString);
                return Ok(index + 1);
            } else if matches!(byte, b'\n' | b'\r') {
                break;
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "quoted string",
        })
    }

    /// JSX quoted attribute values may contain literal line terminators. JavaScript strings may
    /// not, so keep this separate from `skip_quote` rather than weakening the ordinary lexical
    /// boundary used everywhere else in the scanner.
    pub(super) fn skip_jsx_quote(&self, start: usize, quote: u8) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut escaped = false;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                self.mark_surrogates(start + 1, index, OpaqueSurrogateContext::QuotedString);
                return Ok(index + 1);
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "quoted JSX attribute",
        })
    }

    pub(super) fn skip_regex(&self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 1;
        let mut escaped = false;
        let mut in_class = false;
        while index < self.bytes.len() {
            let byte = self.bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'[' {
                in_class = true;
            } else if byte == b']' {
                in_class = false;
            } else if byte == b'/' && !in_class {
                self.mark_surrogates(start + 1, index, OpaqueSurrogateContext::RegexBody);
                index += 1;
                while let Some(width) = self.identifier_continue_width(index) {
                    index += width;
                }
                return Ok(index);
            } else if matches!(byte, b'\n' | b'\r') {
                break;
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "regular expression literal",
        })
    }

    pub(super) fn skip_number(&self, mut index: usize) -> usize {
        while self
            .bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.'))
        {
            index += 1;
        }
        index
    }

    /// Returns true for TypeScript type arguments and generic-arrow parameter lists that begin
    /// where an expression could otherwise begin with JSX. This is deliberately a narrow
    /// disambiguation: ordinary JSX remains committed by `committed_jsx_opening`, while the forms
    /// TypeScript requires to disambiguate generic arrows (`extends`, a default, or a trailing
    /// comma) are left for OXC.
    pub(super) fn looks_like_typescript_type_parameters(&self, start: usize) -> bool {
        if start > 0
            && self.bytes.get(start - 1).is_some_and(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$' | b']' | b')')
            })
        {
            return true;
        }

        let name_start = start + 1;
        if self.identifier_start_width(name_start).is_none() {
            return false;
        }
        let name_end = self.skip_identifier(name_start);
        let marker = self.skip_ascii_whitespace(name_end, self.bytes.len());
        if !matches!(self.bytes.get(marker), Some(b',' | b'='))
            && !self.bare_keyword_at(marker, b"extends")
        {
            return false;
        }

        self.type_parameter_list_precedes_parameters(name_end)
    }

    fn type_parameter_list_precedes_parameters(&self, mut index: usize) -> bool {
        let mut depth = 1_u32;
        while let Some(&byte) = self.bytes.get(index) {
            match byte {
                b'\'' | b'"' => {
                    let Ok(end) = self.skip_quote(index, byte) else {
                        return false;
                    };
                    index = end;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    let Ok(end) = self.skip_block_comment(index) else {
                        return false;
                    };
                    index = end;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                    index = self.skip_line_comment(index + 2);
                }
                b'<' => {
                    depth = depth.saturating_add(1);
                    index += 1;
                }
                b'>' if self.bytes.get(index.wrapping_sub(1)) != Some(&b'=') => {
                    depth -= 1;
                    index += 1;
                    if depth == 0 {
                        return self
                            .skip_trivia(index)
                            .is_ok_and(|next| self.bytes.get(next) == Some(&b'('));
                    }
                }
                _ => index += 1,
            }
        }
        false
    }

    pub(super) fn skip_line_comment(&self, mut index: usize) -> usize {
        let start = index;
        while index < self.bytes.len() && !matches!(self.bytes[index], b'\n' | b'\r') {
            index += 1;
        }
        self.mark_surrogates(start, index, OpaqueSurrogateContext::Comment);
        index
    }

    pub(super) fn skip_block_comment(&self, start: usize) -> Result<usize, ProjectionError> {
        let mut index = start + 2;
        while index + 1 < self.bytes.len() {
            if self.bytes[index..index + 2] == *b"*/" {
                self.mark_surrogates(start + 2, index, OpaqueSurrogateContext::Comment);
                return Ok(index + 2);
            }
            index += 1;
        }
        Err(ProjectionError::UnterminatedSyntax {
            offset: to_u32(start)?,
            construct: "block comment",
        })
    }

    pub(super) fn skip_trivia(&self, mut index: usize) -> Result<usize, ProjectionError> {
        loop {
            while self.bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                index += 1;
            }
            if self.bytes.get(index..index + 2) == Some(b"//") {
                index = self.skip_line_comment(index + 2);
            } else if self.bytes.get(index..index + 2) == Some(b"/*") {
                index = self.skip_block_comment(index)?;
            } else {
                return Ok(index);
            }
        }
    }

    pub(super) fn skip_ascii_whitespace(&self, mut index: usize, end: usize) -> usize {
        while index < end && self.bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        index
    }

    pub(super) fn lazy_pattern_start(&self, ampersand: usize) -> Option<usize> {
        let pattern_start = self.skip_ascii_whitespace(ampersand.checked_add(1)?, self.bytes.len());
        if !matches!(self.bytes.get(pattern_start), Some(b'[' | b'{')) {
            return None;
        }
        let mut keyword_end = ampersand;
        while keyword_end > 0 && self.bytes[keyword_end - 1].is_ascii_whitespace() {
            keyword_end -= 1;
        }
        let mut keyword_start = keyword_end;
        while keyword_start > 0 && self.bytes[keyword_start - 1].is_ascii_alphabetic() {
            keyword_start -= 1;
        }
        if matches!(self.bytes.get(keyword_start..keyword_end), Some(b"let" | b"const" | b"var")) {
            return Some(pattern_start);
        }

        let open = (0..ampersand).rev().find(|index| !self.bytes[*index].is_ascii_whitespace())?;
        if self.bytes[open] != b'(' {
            return None;
        }
        let mut name_end = open;
        while name_end > 0 && self.bytes[name_end - 1].is_ascii_whitespace() {
            name_end -= 1;
        }
        let mut name_start = name_end;
        while name_start > 0
            && (self.bytes[name_start - 1].is_ascii_alphanumeric()
                || matches!(self.bytes[name_start - 1], b'_' | b'$'))
        {
            name_start -= 1;
        }
        let mut function_end = name_start;
        while function_end > 0 && self.bytes[function_end - 1].is_ascii_whitespace() {
            function_end -= 1;
        }
        function_end
            .checked_sub("function".len())
            .filter(|start| self.bytes.get(*start..function_end) == Some(b"function"))
            .map(|_| pattern_start)
    }

    /// Skips the balanced group opening at `open` — a destructuring pattern or the header that
    /// encloses one — and returns the index just past its closing delimiter. String, template,
    /// comment, and regex interiors stay opaque, because a destructuring default may hold any of
    /// them. A mismatched closer or an unterminated group means the bytes were never the group they
    /// looked like, and returning `None` there leaves the caller declining rather than guessing at
    /// what follows.
    pub(super) fn skip_balanced_pattern(&self, open: usize) -> Option<usize> {
        let mut closers = vec![group_close(*self.bytes.get(open)?)?];
        let mut index = open + 1;
        let mut can_start_expression = true;
        while let Some(&byte) = self.bytes.get(index) {
            match byte {
                b'\'' | b'"' => {
                    index = self.skip_quote(index, byte).ok()?;
                    can_start_expression = false;
                }
                b'`' => {
                    index = self.skip_template_raw(index, self.bytes.len()).ok()?;
                    can_start_expression = false;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                    index = self.skip_line_comment(index + 2);
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    index = self.skip_block_comment(index).ok()?;
                }
                b'/' if can_start_expression => {
                    index = self.skip_regex(index).ok()?;
                    can_start_expression = false;
                }
                b'(' | b'[' | b'{' => {
                    closers.push(group_close(byte)?);
                    index += 1;
                    can_start_expression = true;
                }
                b')' | b']' | b'}' => {
                    if closers.last() != Some(&byte) {
                        return None;
                    }
                    closers.pop();
                    index += 1;
                    if closers.is_empty() {
                        return Some(index);
                    }
                    can_start_expression = false;
                }
                b'0'..=b'9' => {
                    index = self.skip_number(index);
                    can_start_expression = false;
                }
                _ if self.identifier_start_width(index).is_some() => {
                    index = self.skip_identifier(index);
                    can_start_expression = false;
                }
                _ if byte.is_ascii_whitespace() => index += 1,
                _ => {
                    can_start_expression = matches!(
                        byte,
                        b'=' | b',' | b':' | b'?' | b'!' | b'+' | b'-' | b'*' | b'%' | b'&' | b'|'
                    );
                    index += 1;
                }
            }
        }
        None
    }

    /// `inside_parentheses` says the innermost group still open is a `(` one. A statement cannot
    /// start there — only a `for` header's `;` reaches statement position inside parentheses — so
    /// the predecessors that are ambiguous between a statement boundary and a type do not admit
    /// the sigil: `:` opens a parameter's annotation and `}` closes an object type in one.
    pub(super) fn standalone_lazy_pattern_start(
        &self,
        ampersand: usize,
        statement_context: bool,
        inside_parentheses: bool,
    ) -> Option<usize> {
        let pattern_start = ampersand.checked_add(1)?;
        if !matches!(self.bytes.get(pattern_start), Some(b'[' | b'{')) {
            return None;
        }
        let previous = previous_significant_byte(self.bytes, ampersand);
        let admitted = previous.is_none()
            || previous == Some(b';')
            || matches!(previous, Some(b'{' | b'}' | b':')) && !inside_parentheses
            || statement_context;
        admitted.then_some(pattern_start)
    }

    /// `pattern_interior` says the innermost group still open at the ampersand is an object or
    /// array one, so the position is inside a binding pattern rather than directly in the
    /// parameter list. It is what separates the two meanings of a preceding `:`.
    pub(super) fn lazy_arrow_pattern_start(
        &self,
        ampersand: usize,
        parameter_open: Option<usize>,
        previous_token: Option<u8>,
        pattern_interior: bool,
    ) -> Option<usize> {
        parameter_open?;
        let pattern_start = ampersand.checked_add(1)?;
        if !matches!(self.bytes.get(pattern_start), Some(b'[' | b'{')) {
            return None;
        }
        // A `:` inside a pattern renames into a nested lazy pattern (`{ a: &{ b } }`). The same
        // `:` written directly in the parameter list opens a type annotation instead, and a type
        // may perfectly well lead with the intersection `&` of an object type.
        let admitted = matches!(previous_token, Some(b'(' | b'[' | b'{' | b','))
            || (previous_token == Some(b':') && pattern_interior)
            || self.follows_rest_spread(ampersand);
        admitted.then_some(pattern_start)
    }

    /// `...&{ … }` is a rest lazy parameter, so the spread's own `.` has to admit the pattern the
    /// way an opening delimiter or a comma does. The walk back is trivia-aware because the forward
    /// scan is: `, /* gap */ &{ a }` already queues a marker, so `... /* gap */ &{ a }` has to too.
    fn follows_rest_spread(&self, ampersand: usize) -> bool {
        let end = self.previous_significant_end(ampersand);
        end.checked_sub(3).is_some_and(|start| &self.bytes[start..end] == b"...")
    }

    /// The index just past the last significant byte before `end`, stepping over whitespace and
    /// both comment forms the way [`Scanner::skip_trivia`] does going forward.
    fn previous_significant_end(&self, mut end: usize) -> usize {
        loop {
            let mut crossed_line_break = false;
            while end > 0 && self.bytes[end - 1].is_ascii_whitespace() {
                crossed_line_break |= matches!(self.bytes[end - 1], b'\n' | b'\r');
                end -= 1;
            }
            // Block comments do not nest, so the nearest preceding `/*` opens this one. A `/*`
            // written inside the comment text would land the walk mid-comment instead, which
            // fails closed: the caller looks for an exact `...` and will not find one there.
            if end >= 4
                && self.bytes[end - 2..end] == *b"*/"
                && let Some(open) =
                    (0..end - 2).rev().find(|start| self.bytes[*start..*start + 2] == *b"/*")
            {
                end = open;
                continue;
            }
            // Only the line break that closed it can put a `//` comment before `end`.
            if crossed_line_break && let Some(open) = self.line_comment_start_before(end) {
                end = open;
                continue;
            }
            return end;
        }
    }

    /// Where the `//` comment ending the line before `end` opens, if there is one. Quoted text is
    /// stepped over so a `//` inside a string is not read as a comment; a template literal or an
    /// unterminated block comment leaves the line undecidable, and reporting no comment then keeps
    /// the caller from walking back over code it cannot account for.
    fn line_comment_start_before(&self, end: usize) -> Option<usize> {
        let line_start = self.bytes[..end]
            .iter()
            .rposition(|byte| matches!(byte, b'\n' | b'\r'))
            .map_or(0, |index| index + 1);
        let mut index = line_start;
        while index < end {
            match self.bytes[index] {
                b'`' => return None,
                quote @ (b'\'' | b'"') => {
                    index += 1;
                    while index < end && self.bytes[index] != quote {
                        index += 1 + usize::from(self.bytes[index] == b'\\');
                    }
                    if index >= end {
                        return None;
                    }
                    index += 1;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    let close =
                        self.bytes[index + 2..end].windows(2).position(|pair| pair == b"*/")?;
                    index += 4 + close;
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => return Some(index),
                _ => index += 1,
            }
        }
        None
    }

    pub(super) fn arrow_follows_parameter_list(&self, index: usize) -> bool {
        let Ok(index) = self.skip_trivia(index) else {
            return false;
        };
        if self.bytes.get(index..index + 2) == Some(b"=>") {
            return true;
        }
        if self.bytes.get(index) != Some(&b':') {
            return false;
        }
        // A return annotation is exactly one type expression. Its own `{ … }` (an object type) and
        // its own `=>` (a function type) stay inside it, so neither one decides anything on its
        // own: what follows the whole type does, and only an arrow puts a `=>` there.
        let Some(end) = self.skip_type_expression(index + 1) else {
            return false;
        };
        let Ok(next) = self.skip_trivia(end) else {
            return false;
        };
        self.bytes.get(next..next + 2) == Some(b"=>")
    }

    /// Consumes exactly one type expression and returns the index just past it. Union and
    /// intersection members, postfix `[]` and type arguments, qualified names, type predicates,
    /// conditional types, and the `=>` of a function type all continue the same type; the first
    /// token that cannot extend it ends the consumption and is left for the caller to classify.
    fn skip_type_expression(&self, mut index: usize) -> Option<usize> {
        let mut extends_seen = false;
        let mut conditionals = 0_u32;
        loop {
            index = self.skip_trivia(index).ok()?;
            let byte = *self.bytes.get(index)?;
            // Only a parenthesised parameter list can carry a function type's `=>`; every other
            // way of reaching a `=>` means the type already ended.
            let mut function_head = false;
            // `import("mod")` is the one type form whose name takes a call-like group.
            let mut import_head = false;
            match byte {
                b'(' | b'[' | b'{' => {
                    let group = self.skip_type_group(index)?;
                    index = group.end;
                    // A parenthesised group holding its own top-level `=>` is already a complete
                    // function type — `((x: T) => U)` — rather than the parameter list opening
                    // one, so the `=>` after it belongs to whatever follows the annotation.
                    function_head = byte == b'(' && !group.complete_function_type;
                }
                // Type parameters lead a generic function type, whose parameter list is the type.
                b'<' => {
                    index = self.skip_type_group(index)?.end;
                    continue;
                }
                // A leading `|` or `&`, and a numeric literal's sign, carry no type of their own.
                b'|' | b'&' | b'+' | b'-' => {
                    index += 1;
                    continue;
                }
                b'\'' | b'"' => index = self.skip_quote(index, byte).ok()?,
                b'`' => index = self.skip_template_raw(index, self.bytes.len()).ok()?,
                b'0'..=b'9' => index = self.skip_number(index),
                _ if self.identifier_start_width(index).is_some() => {
                    let end = self.skip_identifier(index);
                    let name = &self.bytes[index..end];
                    let leads_a_type = TYPE_PREFIX_KEYWORDS.contains(&name);
                    import_head = matches!(name, b"import");
                    index = end;
                    if leads_a_type {
                        continue;
                    }
                }
                _ => return None,
            }

            loop {
                let next = self.skip_trivia(index).ok()?;
                match self.bytes.get(next) {
                    // The module specifier of `import("mod").T`, the only call-like group a type
                    // may take. Its qualified name and type arguments continue below as usual.
                    Some(b'(') if import_head => index = self.skip_type_group(next)?.end,
                    // `T[]`, `T[K]`, and `T<Args>` all extend the type they follow.
                    Some(b'[' | b'<') => index = self.skip_type_group(next)?.end,
                    // A qualified name: `A.B.C`.
                    Some(b'.') => {
                        let name = self.skip_trivia(next + 1).ok()?;
                        index = self.skip_identifier(name);
                        if index == name {
                            return None;
                        }
                    }
                    _ => break,
                }
                function_head = false;
                import_head = false;
            }

            let next = self.skip_trivia(index).ok()?;
            match self.bytes.get(next).copied() {
                // Another union or intersection member follows.
                Some(b'|' | b'&') => index = next + 1,
                // `(a: A) => B` is one function type, so this `=>` and the return type it
                // introduces belong to the annotation rather than to an arrow body.
                Some(b'=') if function_head && self.bytes.get(next + 1) == Some(&b'>') => {
                    index = next + 2;
                }
                // The branches of `A extends B ? C : D`, admitted only behind the `extends` and
                // the `?` that make a `:` part of a type rather than the end of one.
                Some(b'?') if extends_seen => {
                    extends_seen = false;
                    conditionals += 1;
                    index = next + 1;
                }
                Some(b':') if conditionals > 0 => {
                    conditionals -= 1;
                    index = next + 1;
                }
                _ if self.bare_keyword_at(next, b"extends") => {
                    extends_seen = true;
                    index = Self::after_bare_keyword(next, b"extends");
                }
                // `x is T` completes a type predicate.
                _ if self.bare_keyword_at(next, b"is") => {
                    index = Self::after_bare_keyword(next, b"is");
                }
                _ => return Some(index),
            }
        }
    }

    /// Skips the balanced group opening at `open`, keeping string, template, and comment interiors
    /// opaque. A closer that does not match, and a `;` inside an angle group, both mean the group
    /// was never a group — most often a `<` that was really a comparison — and end the scan rather
    /// than let it run away through the rest of the file.
    fn skip_type_group(&self, open: usize) -> Option<TypeGroup> {
        let open_byte = *self.bytes.get(open)?;
        let parenthesised = open_byte == b'(';
        let mut closers = vec![group_close(open_byte)?];
        // A `=>` written directly in a parenthesised group belongs to a parameter's annotation
        // when a `:` has already opened one, and to the group's own function type otherwise.
        let mut annotated = false;
        let mut conditionals = 0_u32;
        let mut complete_function_type = false;
        let mut index = open + 1;
        while let Some(&byte) = self.bytes.get(index) {
            let outermost = parenthesised && closers.len() == 1;
            match byte {
                b'\'' | b'"' => index = self.skip_quote(index, byte).ok()?,
                b'`' => index = self.skip_template_raw(index, self.bytes.len()).ok()?,
                b'/' if self.bytes.get(index + 1) == Some(&b'/') => {
                    index = self.skip_line_comment(index + 2);
                }
                b'/' if self.bytes.get(index + 1) == Some(&b'*') => {
                    index = self.skip_block_comment(index).ok()?;
                }
                // A nested function type's `=>` ends in a `>` that closes no angle group.
                b'=' if self.bytes.get(index + 1) == Some(&b'>') => {
                    complete_function_type |= outermost && !annotated;
                    index += 2;
                }
                // A `?` that ends its parameter marks that parameter optional: `a?: T` goes on to
                // an annotation whose `:` opens one here, and the untyped `a?,` and `a?)` end the
                // parameter outright. Only a `?` with a type after it opens a conditional type,
                // whose `:` separates the branches instead of opening an annotation.
                b'?' if outermost => {
                    let next = self.skip_trivia(index + 1).ok()?;
                    if !matches!(self.bytes.get(next), Some(b':' | b',' | b')')) {
                        conditionals += 1;
                    }
                    index += 1;
                }
                b':' if outermost => {
                    if conditionals > 0 {
                        conditionals -= 1;
                    } else {
                        annotated = true;
                    }
                    index += 1;
                }
                b'(' | b'[' | b'{' | b'<' => {
                    closers.push(group_close(byte)?);
                    index += 1;
                }
                b')' | b']' | b'}' | b'>' => {
                    if closers.last() != Some(&byte) {
                        return None;
                    }
                    closers.pop();
                    index += 1;
                    if closers.is_empty() {
                        return Some(TypeGroup { end: index, complete_function_type });
                    }
                }
                b';' if closers.last() == Some(&b'>') => return None,
                _ => index += 1,
            }
        }
        None
    }

    pub(super) fn keyword_at(&self, index: usize, keyword: &[u8]) -> bool {
        let end = index + 1 + keyword.len();
        self.bytes.get(index) == Some(&b'@')
            && self.bytes.get(index + 1..end) == Some(keyword)
            && keyword_boundary(self.bytes, end)
    }

    pub(super) fn bare_keyword_at(&self, index: usize, keyword: &[u8]) -> bool {
        let end = index + keyword.len();
        self.bytes.get(index..end) == Some(keyword)
            && keyword_boundary(self.bytes, end)
            && !identifier_continue_before(self.bytes, index)
    }

    pub(super) const fn after_keyword(index: usize, keyword: &[u8]) -> usize {
        index + 1 + keyword.len()
    }

    pub(super) const fn after_bare_keyword(index: usize, keyword: &[u8]) -> usize {
        index + keyword.len()
    }

    #[inline]
    pub(super) fn identifier_start_width(&self, index: usize) -> Option<usize> {
        identifier_start_width(self.bytes, index)
    }

    #[inline]
    pub(super) fn identifier_continue_width(&self, index: usize) -> Option<usize> {
        identifier_continue_width(self.bytes, index)
    }

    pub(super) fn skip_identifier(&self, mut index: usize) -> usize {
        let Some(width) = self.identifier_start_width(index) else {
            return index;
        };
        index += width;
        while let Some(width) = self.identifier_continue_width(index) {
            index += width;
        }
        index
    }

    /// Octane starts a new statement when a line begins with a TSRX control, even though the
    /// previous line left its statement unterminated — the same boundary
    /// `line_leading_markup_starts_a_statement` gives a line-leading markup opening. `start` is the
    /// control's `@`; `previous` is one past the last non-trivia byte before it, as `code_context`
    /// computed it. The control only continues the preceding expression when the token before it
    /// demands an operand, so everything else on a fresh line opens a statement.
    pub(super) fn line_leading_control_starts_a_statement(
        &self,
        start: usize,
        previous: usize,
    ) -> bool {
        self.at_line_start(start) && !self.token_demands_an_operand(previous)
    }

    /// True when the token ending at `index` cannot end an expression, so whatever follows it has
    /// to continue that expression rather than start a statement. Deliberately a deny-list: an
    /// unrecognised token leaves the control where a line break already put it.
    fn token_demands_an_operand(&self, index: usize) -> bool {
        let Some(&last) = index.checked_sub(1).and_then(|last| self.bytes.get(last)) else {
            return false;
        };
        if OPERAND_BYTES.contains(&last) {
            return true;
        }
        let mut word_start = index;
        while word_start > 0 && self.bytes[word_start - 1].is_ascii_alphabetic() {
            word_start -= 1;
        }
        word_start < index
            && !identifier_continue_before(self.bytes, word_start)
            && OPERAND_KEYWORDS.contains(&&self.bytes[word_start..index])
    }
}

/// Last bytes of the tokens that cannot end an expression, so a TSRX control written after one is
/// continuing that expression however the source is laid out. `>` covers both `=>` and the close of
/// a markup element, and `/` covers both division and the close of a regular expression, which is
/// why neither of those shapes changes context under the line-leading rule.
const OPERAND_BYTES: &[u8] = b"=([,?:.+-*/%&|^!~<>";

/// Keywords that demand an operand. A line-leading control after one of these is still part of the
/// expression the keyword opened, even though ASI would end some of them.
const OPERAND_KEYWORDS: &[&[u8]] = &[
    b"await",
    b"case",
    b"default",
    b"delete",
    b"extends",
    b"in",
    b"instanceof",
    b"new",
    b"of",
    b"return",
    b"typeof",
    b"void",
    b"yield",
];

/// One balanced group consumed in type position.
struct TypeGroup {
    /// The index just past the group's closing delimiter.
    end: usize,
    /// The group is a function type in its own right rather than the parameter list opening one,
    /// so a following `=>` continues something else.
    complete_function_type: bool,
}

/// Type operators that lead the type they apply to, so consumption continues past them into it.
const TYPE_PREFIX_KEYWORDS: [&[u8]; 8] =
    [b"abstract", b"asserts", b"infer", b"keyof", b"new", b"readonly", b"typeof", b"unique"];

const fn group_close(open: u8) -> Option<u8> {
    match open {
        b'(' => Some(b')'),
        b'[' => Some(b']'),
        b'{' => Some(b'}'),
        b'<' => Some(b'>'),
        _ => None,
    }
}

pub(super) fn trim_ascii_end(bytes: &[u8], start: usize, mut end: usize) -> usize {
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    end
}

pub(super) fn previous_significant_byte(bytes: &[u8], before: usize) -> Option<u8> {
    bytes[..before].iter().rfind(|byte| !byte.is_ascii_whitespace()).copied()
}

pub(super) fn unsupported_at_construct(bytes: &[u8], index: usize) -> Option<&'static str> {
    const UNSUPPORTED: [(&[u8], &str); 1] = [(b"await", "@await control flow")];
    UNSUPPORTED.iter().find_map(|(keyword, construct)| {
        let end = index + 1 + keyword.len();
        (bytes.get(index + 1..end) == Some(*keyword) && keyword_boundary(bytes, end))
            .then_some(*construct)
    })
}

#[inline]
pub(super) fn identifier_start_width(bytes: &[u8], index: usize) -> Option<usize> {
    let byte = *bytes.get(index)?;
    if is_identifier_start(byte) {
        return Some(1);
    }
    if byte.is_ascii() {
        return None;
    }
    let (character, width) = decode_non_ascii_utf8(bytes, index)?;
    (unicode_identifier_start(character) || matches!(character, '\u{e000}' | '\u{ffff}'))
        .then_some(width)
}

/// The structural scanner only needs to preserve expression state, not validate identifiers.
/// After a proven start, consuming a complete non-ASCII scalar is deliberately conservative: all
/// ECMAScript `ID_Continue` scalars are covered without a generated Unicode table, while invalid
/// UTF-8 (including raw WTF-8 surrogate triples) remains active and unconsumed.
#[inline]
pub(super) fn identifier_continue_width(bytes: &[u8], index: usize) -> Option<usize> {
    let byte = *bytes.get(index)?;
    if is_identifier_continue(byte) {
        return Some(1);
    }
    if byte.is_ascii() {
        return None;
    }
    decode_non_ascii_utf8(bytes, index).map(|(_, width)| width)
}

/// Reports whether a keyword ending at `index` actually ends there.
///
/// `identifier_continue_width` answers that for raw bytes, but `\` is neither an identifier byte
/// nor the start of a UTF-8 scalar, so on its own it reads a trailing `\u` escape as a boundary
/// and turns the decorator `@for\u{03c0}` into the `@for` keyword — which then demands the `(` of a
/// loop header. The base scanner decodes the escape for exactly this reason, and the parser lane
/// has to agree with it, or format and lint reject a decorator the parser accepts.
#[inline]
fn keyword_boundary(bytes: &[u8], index: usize) -> bool {
    if identifier_continue_width(bytes, index).is_some() {
        return false;
    }
    bytes.get(index) != Some(&b'\\') || !escaped_identifier_continue(&bytes[index..])
}

/// Reports whether a leading `\uXXXX` or `\u{...}` escape names a scalar that continues an
/// identifier. Classification deliberately mirrors `identifier_continue_width`'s raw-byte answer
/// rather than the stricter `ID_Continue` table, so an escape and the character it spells always
/// land on the same side of a keyword boundary. A malformed, incomplete, or out-of-range escape is
/// not an identifier continuation, which leaves the keyword ending where it looked like it ended.
#[cold]
#[inline(never)]
fn escaped_identifier_continue(suffix: &[u8]) -> bool {
    let Some(character) = decode_unicode_escape(suffix).and_then(char::from_u32) else {
        return false;
    };
    if character.is_ascii() { is_identifier_continue(character as u8) } else { true }
}

/// Decodes the code point of a leading `\uXXXX` or `\u{...}` escape, without validating that it is
/// a scalar value; lone surrogates fall out at the `char::from_u32` that follows.
fn decode_unicode_escape(suffix: &[u8]) -> Option<u32> {
    if suffix.first() != Some(&b'\\') || suffix.get(1) != Some(&b'u') {
        return None;
    }
    if suffix.get(2) != Some(&b'{') {
        return suffix
            .get(2..6)?
            .iter()
            .try_fold(0_u32, |value, &byte| Some(value * 16 + hex_digit(byte)?));
    }
    let mut value = 0_u32;
    let mut has_digit = false;
    for &byte in suffix.get(3..)? {
        if byte == b'}' {
            return has_digit.then_some(value);
        }
        value = value.checked_mul(16)?.checked_add(hex_digit(byte)?)?;
        if value > 0x10_FFFF {
            return None;
        }
        has_digit = true;
    }
    None
}

const fn hex_digit(byte: u8) -> Option<u32> {
    match byte {
        b'0'..=b'9' => Some((byte - b'0') as u32),
        b'a'..=b'f' => Some((byte - b'a' + 10) as u32),
        b'A'..=b'F' => Some((byte - b'A' + 10) as u32),
        _ => None,
    }
}

fn identifier_continue_before(bytes: &[u8], index: usize) -> bool {
    let Some(mut start) = index.checked_sub(1) else {
        return false;
    };
    if bytes[start].is_ascii() {
        return is_identifier_continue(bytes[start]);
    }
    let lower_bound = index.saturating_sub(4);
    while start > lower_bound && bytes[start] & 0b1100_0000 == 0b1000_0000 {
        start -= 1;
    }
    identifier_continue_width(bytes, start).is_some_and(|width| start + width == index)
}

#[inline]
fn decode_non_ascii_utf8(bytes: &[u8], index: usize) -> Option<(char, usize)> {
    let width = match *bytes.get(index)? {
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return None,
    };
    let end = index.checked_add(width)?;
    let encoded = bytes.get(index..end)?;
    let character = std::str::from_utf8(encoded).ok()?.chars().next()?;
    Some((character, width))
}

#[inline]
fn unicode_identifier_start(character: char) -> bool {
    character.is_alphabetic()
        || matches!(
            character,
            '\u{1885}' | '\u{1886}' | '\u{2118}' | '\u{212E}' | '\u{309B}' | '\u{309C}'
        )
}

pub(crate) const fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$')
}

pub(crate) const fn is_identifier_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

#[cfg(test)]
mod tests {
    use super::{super::Scanner, keyword_boundary, unsupported_at_construct};

    fn boundary(suffix: &[u8]) -> bool {
        let mut bytes = b"if".to_vec();
        bytes.extend_from_slice(suffix);
        keyword_boundary(&bytes, 2)
    }

    #[test]
    fn malformed_escapes_and_non_identifier_scalars_remain_boundaries() {
        for suffix in [
            b"(".as_slice(),
            b"",
            b"\\u{}",
            b"\\u{110000}",
            b"\\u{2d}",
            b"\\u002d",
            b"\\x70",
            b"\\u{xyz}",
            b"\\u{3c0",
            b"\\u03c",
            b"\\",
            b"\\n",
        ] {
            assert!(boundary(suffix), "{suffix:?}");
        }
    }

    #[test]
    fn escaped_identifier_continuations_are_not_boundaries() {
        for suffix in [
            b"\\u03c0".as_slice(),
            b"\\u0301",
            b"\\u200c",
            b"\\u200d",
            b"\\u0030",
            b"\\u005f",
            b"\\u0024",
            b"\\u{1D49C}",
            b"\\u{000003c0}",
        ] {
            assert!(!boundary(suffix), "{suffix:?}");
        }
    }

    /// The escape and the character it spells have to land on the same side of the boundary, so
    /// the parser lane keeps `identifier_continue_width`'s conservative reading of a lone
    /// surrogate: `\uD800` decodes to no scalar and ends the keyword, exactly as the raw bytes do.
    #[test]
    fn lone_surrogate_escapes_end_the_keyword() {
        assert!(boundary(b"\\uD800"));
    }

    #[test]
    fn keyword_checks_reject_escaped_identifier_suffixes() {
        for source in ["@for\\u03c0", "@for\u{03c0}", r"@try\u{1D49C}", "@try\u{1D49C}"] {
            assert!(!Scanner::new_for_parser(source).keyword_at(0, b"for"), "{source}");
            assert!(!Scanner::new_for_parser(source).keyword_at(0, b"try"), "{source}");
        }
        assert!(Scanner::new_for_parser("@for (").keyword_at(0, b"for"));

        for source in ["is\\u03c0", "is\u{03c0}"] {
            assert!(!Scanner::new_for_parser(source).bare_keyword_at(0, b"is"), "{source}");
        }
        assert!(Scanner::new_for_parser("is string").bare_keyword_at(0, b"is"));
    }

    /// `@await` is refused by name, so its boundary has to agree with every other keyword's:
    /// `@awaitπ` is a decorator, not an unsupported control.
    #[test]
    fn unsupported_construct_detection_shares_the_keyword_boundary() {
        for source in ["@await\\u03c0", "@await\u{03c0}", r"@await\u{1D49C}"] {
            assert!(unsupported_at_construct(source.as_bytes(), 0).is_none(), "{source}");
        }
        assert_eq!(unsupported_at_construct(b"@await (", 0), Some("@await control flow"));
    }
}

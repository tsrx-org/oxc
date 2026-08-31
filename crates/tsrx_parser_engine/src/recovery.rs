//! Bounded source repair for editor snapshots that cannot produce an OXC partial Program.
//!
//! The repair is deliberately outside the strict parser. It edits only incomplete syntax, keeps
//! an endpoint map for every inserted byte, and accepts a candidate only after the ordinary
//! fail-closed pipeline produces a complete authored TSRX tree.

use tsrx_syntax::{ProjectionError, scan_for_parser};
use tsrx_tape_schema::{ParseCompleteness, TapeSpan};

use crate::{
    TsrxParseError, TsrxParseResult,
    utf16_result::{program_reachable_objects, try_map_program_spans},
};

pub(super) struct RecoverySource {
    text: String,
    boundaries: Vec<u32>,
    diagnostic_offset: u32,
}

impl RecoverySource {
    fn new(source: &str) -> Result<Self, TsrxParseError> {
        let source_len = u32::try_from(source.len()).map_err(|_| {
            TsrxParseError::ResourceExhausted("TSRX source exceeds the 4 GiB span limit")
        })?;
        Ok(Self {
            text: source.to_string(),
            boundaries: (0..=source_len).collect(),
            diagnostic_offset: source_len,
        })
    }

    pub(super) fn source(&self) -> &str {
        &self.text
    }

    pub(super) const fn diagnostic_offset(&self) -> u32 {
        self.diagnostic_offset
    }

    fn replace(
        &mut self,
        start: usize,
        end: usize,
        replacement: &str,
    ) -> Result<(), TsrxParseError> {
        if start > end
            || !self.text.is_char_boundary(start)
            || !self.text.is_char_boundary(end)
            || end > self.text.len()
        {
            return Err(TsrxParseError::Unsupported(
                "editor recovery edit is outside authored source boundaries",
            ));
        }
        let original_start = *self
            .boundaries
            .get(start)
            .ok_or(TsrxParseError::Unsupported("editor recovery start has no authored boundary"))?;
        let original_end = *self
            .boundaries
            .get(end)
            .ok_or(TsrxParseError::Unsupported("editor recovery end has no authored boundary"))?;
        let old_length = end - start;
        let replacement_boundaries = if replacement.len() == old_length {
            self.boundaries[start..=end].to_vec()
        } else {
            let mut boundaries = vec![original_start; replacement.len() + 1];
            if let Some(last) = boundaries.last_mut() {
                *last = original_end;
            }
            boundaries
        };
        self.text.replace_range(start..end, replacement);
        self.boundaries.splice(start..=end, replacement_boundaries);
        self.diagnostic_offset = self.diagnostic_offset.min(original_start);
        Ok(())
    }

    fn insert(&mut self, at: usize, text: &str) -> Result<(), TsrxParseError> {
        self.replace(at, at, text)
    }

    fn map_endpoint(&self, offset: u32) -> Result<u32, TsrxParseError> {
        let index = usize::try_from(offset)
            .map_err(|_| TsrxParseError::Unsupported("recovered offset exceeds usize"))?;
        self.boundaries
            .get(index)
            .copied()
            .ok_or(TsrxParseError::Unsupported("recovered offset has no authored boundary"))
    }
}

pub(super) fn prepare(source: &str) -> Result<Option<RecoverySource>, TsrxParseError> {
    let mut recovered = RecoverySource::new(source)?;
    let mut changed = blank_bare_at_tokens(&mut recovered)?;

    for _ in 0..16 {
        match scan_for_parser(recovered.source()) {
            Ok(_) => break,
            Err(ProjectionError::UnterminatedSyntax { offset, construct: "JSX element" }) => {
                if !close_unterminated_jsx(&mut recovered, offset)? {
                    return Ok(None);
                }
                changed = true;
            }
            Err(
                ProjectionError::UnterminatedSyntax { offset, .. }
                | ProjectionError::MalformedSyntax { offset, .. },
            ) => {
                if !blank_incomplete_control(&mut recovered, offset)? {
                    return Ok(None);
                }
                changed = true;
            }
            Err(_) => return Ok(None),
        }
    }
    if scan_for_parser(recovered.source()).is_err() {
        return Ok(None);
    }
    changed |= complete_tail(&mut recovered)?;
    Ok(changed.then_some(recovered))
}

pub(super) fn finish(
    mut recovered: TsrxParseResult,
    failure: TsrxParseResult,
    source: &RecoverySource,
) -> Result<TsrxParseResult, TsrxParseError> {
    if recovered.status != ParseCompleteness::Complete {
        return Ok(failure);
    }
    let mut program = recovered
        .program
        .take()
        .ok_or(TsrxParseError::Unsupported("recovery candidate has no Program"))?;
    let reachable = program_reachable_objects(&program)?;
    try_map_program_spans(&mut program, &reachable, |offset| source.map_endpoint(offset))?;
    if let Some(module) = recovered.module.as_mut() {
        module.try_map_spans(|span| map_span(source, span))?;
    }
    recovered.comments.try_map_spans(|span| map_span(source, span))?;
    recovered.rejection_module_names.try_map_spans(|span| map_span(source, span))?;

    Ok(TsrxParseResult::recovered(
        program,
        recovered.module,
        recovered.comments,
        failure.errors,
        failure.suppressed_diagnostics.saturating_add(recovered.suppressed_diagnostics),
        recovered.needs_compaction,
        std::mem::take(&mut recovered.rejection_module_names),
    ))
}

fn map_span(source: &RecoverySource, span: TapeSpan) -> Result<TapeSpan, TsrxParseError> {
    Ok(TapeSpan::new(source.map_endpoint(span.start)?, source.map_endpoint(span.end)?))
}

fn blank_bare_at_tokens(source: &mut RecoverySource) -> Result<bool, TsrxParseError> {
    let mut offsets = Vec::new();
    let bytes = source.text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => index = skip_quoted(bytes, index, bytes[index]),
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index = skip_line_comment(bytes, index + 2);
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2);
            }
            b'@' => {
                let next = bytes.get(index + 1).copied();
                if !matches!(next, Some(b'{' | b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_')) {
                    offsets.push(index);
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    for offset in offsets.into_iter().rev() {
        source.replace(offset, offset + 1, " ")?;
    }
    Ok(source.diagnostic_offset != u32::try_from(source.text.len()).unwrap_or(u32::MAX))
}

fn blank_incomplete_control(
    source: &mut RecoverySource,
    failure_offset: u32,
) -> Result<bool, TsrxParseError> {
    let limit = usize::try_from(failure_offset).unwrap_or(usize::MAX).min(source.text.len());
    let Some(start) = last_control_start(&source.text, limit) else {
        return Ok(false);
    };
    let replacement = " ".repeat(source.text.len() - start);
    source.replace(start, source.text.len(), &replacement)?;
    Ok(true)
}

fn close_unterminated_jsx(
    source: &mut RecoverySource,
    opening_offset: u32,
) -> Result<bool, TsrxParseError> {
    let start = usize::try_from(opening_offset)
        .map_err(|_| TsrxParseError::Unsupported("JSX recovery offset exceeds usize"))?;
    let bytes = source.text.as_bytes();
    if bytes.get(start) != Some(&b'<') {
        return Ok(false);
    }
    let mut end = start + 1;
    while bytes.get(end).is_some_and(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'$')
    }) {
        end += 1;
    }
    if end == start + 1 {
        return Ok(false);
    }
    let name = source.text[start + 1..end].to_string();
    let insertion =
        source.text[start..].rfind('}').map_or(source.text.len(), |relative| start + relative);
    source.insert(insertion, &format!("</{name}>"))?;
    Ok(true)
}

fn complete_tail(source: &mut RecoverySource) -> Result<bool, TsrxParseError> {
    let bytes = source.text.as_bytes();
    let mut stack = Vec::new();
    let mut index = 0;
    let mut last_significant = None;
    while index < bytes.len() {
        match bytes[index] {
            byte @ (b'\'' | b'"' | b'`') => {
                index = skip_quoted(bytes, index, byte);
                last_significant = Some(byte);
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index = skip_line_comment(bytes, index + 2);
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2);
            }
            byte @ (b'(' | b'[' | b'{') => {
                stack.push(match byte {
                    b'(' => b')',
                    b'[' => b']',
                    b'{' => b'}',
                    _ => unreachable!(),
                });
                last_significant = Some(byte);
                index += 1;
            }
            byte @ (b')' | b']' | b'}') => {
                if stack.last() == Some(&byte) {
                    stack.pop();
                }
                last_significant = Some(byte);
                index += 1;
            }
            byte if byte.is_ascii_whitespace() => index += 1,
            byte => {
                last_significant = Some(byte);
                index += 1;
            }
        }
    }
    let mut suffix = String::new();
    if matches!(
        last_significant,
        Some(b'=' | b'.' | b'+' | b'-' | b'*' | b'/' | b'%' | b'?' | b':' | b',')
    ) {
        suffix.push_str(" undefined");
    }
    suffix.extend(stack.into_iter().rev().map(char::from));
    if suffix.is_empty() {
        return Ok(false);
    }
    source.insert(source.text.len(), &suffix)?;
    Ok(true)
}

fn last_control_start(source: &str, limit: usize) -> Option<usize> {
    ["@if", "@for", "@switch", "@try"]
        .into_iter()
        .filter_map(|keyword| source[..limit].rfind(keyword))
        .max()
}

fn skip_quoted(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut index = start + 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index = (index + 2).min(bytes.len());
        } else if bytes[index] == quote {
            return index + 1;
        } else {
            index += 1;
        }
    }
    bytes.len()
}

fn skip_line_comment(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
        index += 1;
    }
    index
}

fn skip_block_comment(bytes: &[u8], mut index: usize) -> usize {
    while index + 1 < bytes.len() {
        if bytes[index..index + 2] == *b"*/" {
            return index + 2;
        }
        index += 1;
    }
    bytes.len()
}

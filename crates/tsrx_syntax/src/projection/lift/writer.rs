use crate::{diagnostics::ProjectionError, model::ByteSpan};

use super::text::TextState;

pub(super) struct LiftWriter {
    output: Vec<u8>,
    state: TextState,
    escaped: bool,
    template_interpolations: Vec<usize>,
    line_start: bool,
    previous_byte: Option<u8>,
    /// Multi-line quoted JSX attribute values in the formatted text, as the scanner found them.
    /// Oxfmt prints these verbatim, so their continuation lines keep their indent.
    attribute_strings: Vec<ByteSpan>,
    next_attribute_string: usize,
}

impl LiftWriter {
    pub(super) fn new(capacity: usize, attribute_strings: Vec<ByteSpan>) -> Self {
        Self {
            output: Vec::with_capacity(capacity),
            state: TextState::Code,
            escaped: false,
            template_interpolations: Vec::with_capacity(4),
            line_start: true,
            previous_byte: None,
            attribute_strings,
            next_attribute_string: 0,
        }
    }

    /// Writes `source`, dropping up to `dedent` columns of indent from each line it starts.
    /// `origin` is the offset of `source` in the formatted text, or `None` for scaffold
    /// replacements, which never sit inside an attribute string.
    pub(super) fn write(&mut self, source: &str, origin: Option<usize>, dedent: usize) {
        let bytes = source.as_bytes();
        let mut index = 0usize;
        while index < bytes.len() {
            if self.line_start
                && !matches!(self.state, TextState::Template | TextState::BlockComment)
                && !origin.is_some_and(|origin| self.inside_attribute_string(origin + index))
            {
                let mut removed = 0usize;
                while removed < dedent
                    && bytes.get(index).is_some_and(|byte| matches!(byte, b' ' | b'\t'))
                {
                    index += 1;
                    removed += 1;
                }
                if index == bytes.len() {
                    return;
                }
            }
            self.line_start = false;
            let byte = bytes[index];
            self.output.push(byte);
            self.update_text_state(byte, bytes.get(index + 1).copied());
            self.line_start = byte == b'\n';
            self.previous_byte = Some(byte);
            index += 1;
        }
    }

    /// Whether `position`, the first byte of a line, continues a multi-line attribute string.
    /// Lines are visited in increasing order, so the cursor only moves forward.
    fn inside_attribute_string(&mut self, position: usize) -> bool {
        while self
            .attribute_strings
            .get(self.next_attribute_string)
            .is_some_and(|span| span.end as usize <= position)
        {
            self.next_attribute_string += 1;
        }
        self.attribute_strings
            .get(self.next_attribute_string)
            .is_some_and(|span| (span.start as usize) < position)
    }

    fn update_text_state(&mut self, byte: u8, next: Option<u8>) {
        match self.state {
            TextState::Code => match byte {
                b'\'' => self.state = TextState::Single,
                b'"' => self.state = TextState::Double,
                b'`' => self.state = TextState::Template,
                b'/' if next == Some(b'/') => self.state = TextState::LineComment,
                b'/' if next == Some(b'*') => self.state = TextState::BlockComment,
                b'{' => {
                    if let Some(depth) = self.template_interpolations.last_mut() {
                        if *depth == usize::MAX {
                            *depth = 0;
                        } else {
                            *depth = depth.saturating_add(1);
                        }
                    }
                }
                b'}' => {
                    if let Some(depth) = self.template_interpolations.last_mut() {
                        if *depth == 0 {
                            self.template_interpolations.pop();
                            self.state = TextState::Template;
                        } else if *depth != usize::MAX {
                            *depth -= 1;
                        }
                    }
                }
                _ => {}
            },
            TextState::Single => {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'\'' {
                    self.state = TextState::Code;
                }
            }
            TextState::Double => {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.state = TextState::Code;
                }
            }
            TextState::Template => {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'`' {
                    self.state = TextState::Code;
                } else if byte == b'$' && next == Some(b'{') {
                    self.template_interpolations.push(usize::MAX);
                    self.state = TextState::Code;
                }
            }
            TextState::LineComment => {
                if byte == b'\n' {
                    self.state = TextState::Code;
                }
            }
            TextState::BlockComment => {
                if byte == b'/' && self.previous_byte == Some(b'*') {
                    self.state = TextState::Code;
                }
            }
        }
    }

    pub(super) fn finish(self) -> Result<String, ProjectionError> {
        String::from_utf8(self.output).map_err(|_| ProjectionError::StructuralMismatch)
    }
}

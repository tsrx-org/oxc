//! A stack that keeps its first `N` entries inline, so ordinary nesting depths never allocate.

pub(super) struct TinyStack<T: Copy, const N: usize> {
    inline: [Option<T>; N],
    length: usize,
    spill: Vec<T>,
}

impl<T: Copy, const N: usize> TinyStack<T, N> {
    pub(super) fn new() -> Self {
        Self { inline: [None; N], length: 0, spill: Vec::new() }
    }

    pub(super) fn push(&mut self, value: T) {
        if self.length < N {
            self.inline[self.length] = Some(value);
        } else {
            self.spill.push(value);
        }
        self.length += 1;
    }

    pub(super) fn pop(&mut self) -> Option<T> {
        if self.length == 0 {
            return None;
        }
        self.length -= 1;
        if self.length < N {
            let value = self.inline[self.length];
            self.inline[self.length] = None;
            value
        } else {
            self.spill.pop()
        }
    }

    pub(super) fn last(&self) -> Option<T> {
        if self.length == 0 {
            None
        } else if self.length <= N {
            self.inline[self.length - 1]
        } else {
            self.spill.last().copied()
        }
    }

    pub(super) const fn len(&self) -> usize {
        self.length
    }

    pub(super) const fn is_empty(&self) -> bool {
        self.length == 0
    }
}

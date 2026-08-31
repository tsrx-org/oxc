//! Proof that every source substitution ends up with exactly one semantic owner. A fixup claimed
//! twice, or never claimed at all, is a defect in the repair lanes rather than in the input.

use tsrx_syntax::OpaqueSurrogateContext;
use tsrx_tape_schema::{ParseCompleteness, TapeSpan};

use crate::{TsrxParseError, source_bridge::PreparedSource};

pub(super) struct FixupLedger<'source, 'original> {
    source: &'source PreparedSource<'original>,
    states: Vec<u8>,
}

impl<'source, 'original> FixupLedger<'source, 'original> {
    pub(super) fn new(source: &'source PreparedSource<'original>) -> Self {
        Self { source, states: vec![0; source.fixups().len()] }
    }

    pub(super) fn claim(
        &mut self,
        span: TapeSpan,
        context: OpaqueSurrogateContext,
    ) -> Result<(), TsrxParseError> {
        let fixups = self.source.fixups();
        let first = fixups.partition_point(|fixup| fixup.byte_start < span.start);
        let last = fixups.partition_point(|fixup| fixup.byte_start < span.end);
        for (relative, fixup) in fixups[first..last].iter().enumerate() {
            if fixup.context != Some(context) {
                continue;
            }
            let index = first + relative;
            let state = self.states.get_mut(index).ok_or_else(|| {
                TsrxParseError::Adapter("fixup ledger index is invalid".to_string())
            })?;
            if *state != 0 {
                return Err(TsrxParseError::Adapter(format!(
                    "surrogate fixup at byte {} has duplicate semantic owners",
                    fixup.byte_start
                )));
            }
            *state = 1;
        }
        Ok(())
    }

    pub(super) fn claim_rejected(&mut self) -> Result<(), TsrxParseError> {
        for (index, fixup) in self.source.fixups().iter().enumerate() {
            if fixup.context.is_some() {
                continue;
            }
            let state = self.states.get_mut(index).ok_or_else(|| {
                TsrxParseError::Adapter("rejected fixup is absent from ledger".to_string())
            })?;
            if *state != 0 {
                return Err(TsrxParseError::Adapter(format!(
                    "rejected surrogate fixup at byte {} has duplicate owners",
                    fixup.byte_start
                )));
            }
            *state = 2;
        }
        Ok(())
    }

    pub(super) fn finish(mut self, status: ParseCompleteness) -> Result<(), TsrxParseError> {
        if status != ParseCompleteness::Complete {
            for state in &mut self.states {
                if *state == 0 {
                    // Failed results expose no Program, while recovered Programs may omit the
                    // malformed tail. Classify every unowned substitution as deliberately
                    // discarded rather than requiring a semantic owner.
                    *state = 3;
                }
            }
        }
        if let Some(index) = self.states.iter().position(|state| *state == 0) {
            return Err(TsrxParseError::Adapter(format!(
                "surrogate fixup at byte {} has no semantic owner",
                self.source.fixups()[index].byte_start
            )));
        }
        Ok(())
    }
}

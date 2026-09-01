//! What a caller gets back: the Program tape, the module, comment, and diagnostic tables, and
//! the completeness that says which of them are populated.

use oxc_adapter::parser::RejectionModuleNames;
use tsrx_tape_schema::{
    CommentTable, Completeness, CoordinateDomain, DiagnosticTable, FlatTape, ModuleTable,
    ParseCompleteness,
};

use crate::TsrxParseError;

#[derive(Debug)]
pub struct TsrxParseResult {
    pub status: ParseCompleteness,
    pub coordinate_domain: CoordinateDomain,
    pub completeness: Completeness,
    pub program: Option<FlatTape>,
    pub module: Option<ModuleTable>,
    pub comments: CommentTable,
    pub errors: DiagnosticTable,
    pub suppressed_diagnostics: u32,
    pub(super) needs_compaction: bool,
    pub(super) rejection_module_names: RejectionModuleNames,
}

impl TsrxParseResult {
    /// Returns the Program for callers that already require a populated result.
    ///
    /// # Panics
    ///
    /// Panics when called on a failed result.
    #[must_use]
    pub fn program(&self) -> &FlatTape {
        self.program.as_ref().expect("complete TSRX result must contain a Program")
    }

    pub(super) fn complete(
        program: FlatTape,
        module: Option<ModuleTable>,
        comments: CommentTable,
        errors: DiagnosticTable,
        suppressed_diagnostics: u32,
        needs_compaction: bool,
        rejection_module_names: RejectionModuleNames,
    ) -> Self {
        Self::populated(
            ParseCompleteness::Complete,
            Completeness::COMPLETE,
            program,
            module,
            comments,
            errors,
            suppressed_diagnostics,
            needs_compaction,
            rejection_module_names,
        )
    }

    pub(super) fn recovered(
        program: FlatTape,
        module: Option<ModuleTable>,
        comments: CommentTable,
        errors: DiagnosticTable,
        suppressed_diagnostics: u32,
        needs_compaction: bool,
        rejection_module_names: RejectionModuleNames,
    ) -> Self {
        debug_assert!(!errors.is_empty());
        Self::populated(
            ParseCompleteness::Recovered,
            Completeness::EMPTY,
            program,
            module,
            comments,
            errors,
            suppressed_diagnostics,
            needs_compaction,
            rejection_module_names,
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the constructor owns each independent result table and status field"
    )]
    fn populated(
        status: ParseCompleteness,
        initial_completeness: Completeness,
        program: FlatTape,
        module: Option<ModuleTable>,
        comments: CommentTable,
        errors: DiagnosticTable,
        suppressed_diagnostics: u32,
        needs_compaction: bool,
        rejection_module_names: RejectionModuleNames,
    ) -> Self {
        let mut completeness = initial_completeness.with(Completeness::HAS_PROGRAM);
        if module.is_some() {
            completeness = completeness.with(Completeness::HAS_MODULE);
        }
        if !comments.is_empty() {
            completeness = completeness.with(Completeness::HAS_COMMENTS);
        }
        if !errors.is_empty() {
            completeness = completeness.with(Completeness::HAS_ERRORS);
        }
        Self {
            status,
            coordinate_domain: CoordinateDomain::AuthoredUtf8Bytes,
            completeness,
            program: Some(program),
            module,
            comments,
            errors,
            suppressed_diagnostics,
            needs_compaction,
            rejection_module_names,
        }
    }

    pub(super) fn failed(
        comments: CommentTable,
        errors: DiagnosticTable,
        suppressed_diagnostics: u32,
    ) -> Result<Self, TsrxParseError> {
        if errors.is_empty() {
            return Err(TsrxParseError::Unsupported(
                "failed TSRX result has no authored diagnostic",
            ));
        }
        let mut completeness = Completeness::HAS_ERRORS;
        if !comments.is_empty() {
            completeness = completeness.with(Completeness::HAS_COMMENTS);
        }
        Ok(Self {
            status: ParseCompleteness::Failed,
            coordinate_domain: CoordinateDomain::AuthoredUtf8Bytes,
            completeness,
            program: None,
            module: None,
            comments,
            errors,
            suppressed_diagnostics,
            needs_compaction: false,
            rejection_module_names: RejectionModuleNames::default(),
        })
    }

    pub(super) fn failed_with_rejection_module_names(
        comments: CommentTable,
        errors: DiagnosticTable,
        suppressed_diagnostics: u32,
        rejection_module_names: RejectionModuleNames,
    ) -> Result<Self, TsrxParseError> {
        let mut result = Self::failed(comments, errors, suppressed_diagnostics)?;
        result.rejection_module_names = rejection_module_names;
        Ok(result)
    }
}

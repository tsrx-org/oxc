use std::sync::Arc;

use oxc_adapter::parser::{
    OrdinaryParseRequest, ProjectedParseRecovery, ProjectedParseRequest, RejectionMetadata,
    parse_failed_tsrx_metadata, parse_ordinary, parse_to_projected_tape,
    render_diagnostic_codeframes,
};
use oxc_allocator::Allocator;
use oxc_diagnostics::NamedSource;
use oxc_parser::Parser;
use oxc_span::SourceType;
use tsrx_tape_schema::{
    DiagnosticPhase, DiagnosticSeverity, ExportExportNameKind, ExportImportNameKind,
    ExportLocalNameKind, ImportNameKind,
};

fn assert_static<T: 'static>(_: &T) {}

fn request(source: &str, show_semantic_errors: bool) -> ProjectedParseRequest<'_> {
    ProjectedParseRequest {
        filename: "Result.tsrx",
        source,
        source_type: None,
        include_ts_fields: false,
        ranges: false,
        preserve_parens: None,
        show_semantic_errors,
        recovery: ProjectedParseRecovery::None,
        rejection_metadata: RejectionMetadata::None,
        dynamic_tags: None,
        synthetic_callee_spans: &[],
    }
}

#[test]
fn adapter_owns_complete_module_comment_and_error_tables_after_source_drop() {
    const SOURCE: &str = concat!(
        "/*top*/ import Default, { type T, value as local } from 'pkg';\n",
        "import * as ns from 'ns'; import 'side';\n",
        "export { local }; export { value as renamed } from 're';\n",
        "export * from 'all'; export type * from 'types';\n",
        "export * as everything from 'namespace'; const Named=()=>null; export default Named;\n",
        "const dynamic = import('dyn'); const meta = import.meta; //tail\n",
    );
    let result = {
        let source = String::from(SOURCE);
        parse_to_projected_tape(request(&source, false)).expect("owned projected result")
    };
    assert_static(&result);

    assert_eq!(result.parse_count, 1);
    assert!(!result.syntax_failed);
    assert!(!result.panicked);
    assert!(result.errors.is_empty());
    assert!(result.program.is_some());
    let module = result.module.as_ref().expect("complete module table");
    assert!(module.has_module_syntax());
    assert_eq!(module.static_imports().len(), 3);
    assert_eq!(module.static_exports().len(), 6);
    assert_eq!(module.dynamic_imports().len(), 1);
    assert_eq!(module.import_metas().len(), 1);

    let first = &module.static_imports()[0];
    assert_eq!(module.value(first.module_request), Some("pkg"));
    let entries = module.static_import_entries(first.entries).expect("first import entries");
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].import_name.kind, ImportNameKind::Default);
    assert!(entries[1].is_type);
    assert_eq!(entries[2].import_name.kind, ImportNameKind::Name);
    assert_eq!(module.name(entries[2].import_name), Some("value"));
    assert_eq!(module.value(entries[2].local_name), Some("local"));

    let star = module
        .static_exports()
        .iter()
        .flat_map(|group| {
            module.static_export_entries(group.entries).expect("export group entries")
        })
        .find(|entry| entry.import_name.kind == ExportImportNameKind::AllButDefault)
        .expect("star export");
    assert!(star.module_request.is_some());

    let exports = module
        .static_exports()
        .iter()
        .flat_map(|group| module.static_export_entries(group.entries).expect("export entries"))
        .collect::<Vec<_>>();
    let namespace = exports
        .iter()
        .find(|entry| entry.import_name.kind == ExportImportNameKind::All)
        .expect("namespace export");
    assert_eq!(module.name(namespace.export_name), Some("everything"));
    assert_eq!(
        module.value(namespace.module_request.get().expect("namespace request")),
        Some("namespace")
    );
    assert!(exports.iter().any(
        |entry| entry.is_type && entry.import_name.kind == ExportImportNameKind::AllButDefault
    ));
    let default = exports
        .iter()
        .find(|entry| entry.export_name.kind == ExportExportNameKind::Default)
        .expect("default export");
    assert_eq!(default.local_name.kind, ExportLocalNameKind::Default);
    assert_eq!(module.name(default.local_name), Some("Named"));
    assert!(module.static_exports().windows(2).all(|pair| pair[0].span.start < pair[1].span.start));

    let dynamic = module.dynamic_imports()[0];
    let dynamic_text = "import('dyn')";
    let dynamic_start =
        u32::try_from(SOURCE.find(dynamic_text).expect("dynamic import")).expect("dynamic start");
    let dynamic_length = u32::try_from(dynamic_text.len()).expect("dynamic length");
    assert_eq!(dynamic.span.start, dynamic_start);
    assert_eq!(dynamic.span.end, dynamic_start + dynamic_length);
    let request_start =
        u32::try_from(SOURCE.find("'dyn'").expect("dynamic request")).expect("request start");
    assert_eq!(dynamic.module_request.start, request_start);
    assert_eq!(dynamic.module_request.end, request_start + 5);
    let meta_start =
        u32::try_from(SOURCE.find("import.meta").expect("import.meta")).expect("meta start");
    assert_eq!(module.import_metas()[0].start, meta_start);
    assert_eq!(module.import_metas()[0].end, meta_start + 11);

    let comments = result.comments.records();
    assert_eq!(comments.len(), 2);
    assert_eq!(result.comments.value(&comments[0]), Some("top"));
    assert_eq!(result.comments.value(&comments[1]), Some("tail"));
}

#[test]
fn dynamic_import_alone_does_not_claim_module_syntax() {
    let source = "const load = import('only');";
    let result = parse_to_projected_tape(request(source, false)).expect("dynamic-only result");
    assert_eq!(result.parse_count, 1);
    let module = result.module.expect("dynamic-only module table");
    assert!(!module.has_module_syntax());
    assert!(module.static_imports().is_empty());
    assert!(module.static_exports().is_empty());
    assert_eq!(module.dynamic_imports().len(), 1);
}

#[test]
fn grammar_diagnostics_are_structured_and_remove_partial_program_and_module() {
    let source = "export const broken = ;";
    let result =
        parse_to_projected_tape(request(source, false)).expect("structured grammar result");
    assert_eq!(result.parse_count, 1);
    assert!(result.syntax_failed);
    assert!(result.program.is_none());
    assert!(result.module.is_none());
    assert_eq!(result.errors.len(), 1);
    let error = &result.errors.records()[0];
    assert_eq!(error.phase, DiagnosticPhase::Grammar);
    assert_eq!(error.severity, DiagnosticSeverity::Error);
    assert_eq!(result.errors.string(error.message), Some("Unexpected token"));
    assert!(result.errors.optional_string(error.help).is_none());
    let labels = result.errors.labels(error.labels).expect("diagnostic labels");
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0].span.start, 22);
    assert_eq!(labels[0].span.end, 23);
    assert!(!labels[0].primary);
    assert!(result.errors.optional_string(labels[0].message).is_none());
}

#[test]
fn explicit_recovery_serializes_only_usable_oxc_partial_programs() {
    let mut recoverable = request("const value; const after = 1;", false);
    recoverable.recovery = ProjectedParseRecovery::Editor;
    let recovered = parse_to_projected_tape(recoverable).expect("recoverable grammar result");
    assert_eq!(recovered.parse_count, 1);
    assert!(recovered.syntax_failed);
    assert!(!recovered.panicked);
    assert!(recovered.program.is_some());
    assert!(recovered.module.is_some());
    assert_eq!(recovered.errors.len(), 1);

    let mut panicked = request("export const broken = ;", false);
    panicked.recovery = ProjectedParseRecovery::Editor;
    let failed = parse_to_projected_tape(panicked).expect("unrecoverable grammar result");
    assert_eq!(failed.parse_count, 1);
    assert!(failed.syntax_failed);
    assert!(failed.panicked);
    assert!(failed.program.is_none());
    assert!(failed.module.is_none());
    assert_eq!(failed.errors.len(), 1);
}

#[test]
fn pinned_oxc_rejects_the_active_noncharacter_interval_in_every_frozen_family() {
    let cases = [
        ("expression", "const x=1\u{ffff};"),
        ("identifier", "const value\u{ffff}=1;"),
        ("JSX opening name", "const x=<A\u{ffff}/>;"),
        ("JSX closing name", "const x=<A></A\u{ffff}>;"),
        ("JSX attribute name", "const x=<A p\u{ffff}={1}/>;"),
        ("template expression", "const x=`${value\u{ffff}}`;"),
        ("regular-expression flag", "const x=/a/\u{ffff};"),
        ("control expression", "if(true\u{ffff}){}"),
    ];
    for (family, source) in cases {
        let result = parse_to_projected_tape(request(source, false)).expect("poison rejection");
        assert_eq!(result.parse_count, 1, "{family}");
        assert!(result.syntax_failed, "{family}");
        assert!(result.program.is_none(), "{family}");
        assert!(result.module.is_none(), "{family}");
        let start = u32::try_from(source.find('\u{ffff}').expect("poison interval"))
            .expect("fixture offset");
        let expected = (start, start + 3);
        assert!(
            result.errors.records().iter().any(|diagnostic| {
                result.errors.labels(diagnostic.labels).is_some_and(|labels| {
                    labels.iter().any(|label| (label.span.start, label.span.end) == expected)
                })
            }),
            "{family} did not reject the exact three-byte U+FFFF interval: {:?}",
            result.errors
        );
    }
}

#[test]
fn rebuilt_codeframe_is_byte_exact_with_the_pinned_oxc_diagnostic() {
    let filename = "Parity.tsrx";
    let source = "export const broken = ;";
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
    let expected = format!(
        "{:?}",
        parsed.diagnostics[0]
            .clone()
            .with_source_code(Arc::new(NamedSource::new(filename, source.to_owned())))
    );

    let mut result =
        parse_to_projected_tape(ProjectedParseRequest { filename, ..request(source, false) })
            .expect("structured grammar result");
    render_diagnostic_codeframes(filename, source, &mut result.errors)
        .expect("rebuilt authored codeframe");
    let diagnostic = &result.errors.records()[0];
    let actual = result.errors.optional_string(diagnostic.codeframe).expect("rebuilt codeframe");
    assert_eq!(actual, expected);
}

#[test]
fn private_rejection_name_spans_survive_a_missing_partial_program_without_publishing_it() {
    let source = "export { \"a\u{e000}\" as \"b\" } from \"m\"; export const broken = ;";
    let mut retained = request(source, false);
    retained.rejection_metadata = RejectionMetadata::ModuleNames;
    let result = parse_to_projected_tape(retained).expect("private rejection metadata");

    assert_eq!(result.parse_count, 1);
    assert!(result.syntax_failed);
    assert!(result.program.is_none());
    assert!(result.module.is_none());
    let quoted = "\"a\u{e000}\"";
    let start =
        u32::try_from(source.find(quoted).expect("quoted import name")).expect("fixture offset");
    let end = start + u32::try_from(quoted.len()).expect("fixture length");
    assert!(
        result
            .rejection_module_names
            .spans()
            .contains(&tsrx_tape_schema::TapeSpan::new(start, end)),
        "the raw public ModuleRecord name span survives even when Program.body is empty"
    );
}

#[test]
fn scanner_failure_metadata_is_one_parse_and_retains_earlier_grammar_evidence_only_on_request() {
    let source = "export { \"value\" as value } from \"m\"; const broken = ;";
    let retained = parse_failed_tsrx_metadata(source, RejectionMetadata::ModuleNames)
        .expect("retained failure metadata");
    assert_eq!(retained.parse_count, 1);
    assert!(!retained.errors.is_empty());
    assert!(!retained.rejection_module_names.spans().is_empty());

    let lean =
        parse_failed_tsrx_metadata(source, RejectionMetadata::None).expect("lean failure metadata");
    assert_eq!(lean.parse_count, 1);
    assert!(lean.errors.is_empty());
    assert!(lean.rejection_module_names.spans().is_empty());
}

#[test]
fn optional_semantic_errors_keep_the_complete_program_and_module() {
    let source = "let x; let x;";
    let without = parse_to_projected_tape(request(source, false)).expect("syntax-only result");
    assert_eq!(without.parse_count, 1);
    assert!(!without.syntax_failed);
    assert!(without.errors.is_empty());

    let with = parse_to_projected_tape(request(source, true)).expect("semantic result");
    assert_eq!(with.parse_count, 1);
    assert!(!with.syntax_failed);
    assert!(with.program.is_some());
    assert!(with.module.is_some());
    assert_eq!(with.errors.len(), 1);
    let error = &with.errors.records()[0];
    assert_eq!(error.phase, DiagnosticPhase::Semantic);
    assert_eq!(with.errors.string(error.message), Some("Identifier `x` has already been declared"));
    let labels = with.errors.labels(error.labels).expect("semantic labels");
    assert_eq!(labels.len(), 2);
    assert_eq!((labels[0].span.start, labels[0].span.end), (4, 5));
    assert_eq!((labels[1].span.start, labels[1].span.end), (11, 12));
}

#[test]
fn ordinary_public_oxc_route_remains_byte_for_byte_isolated() {
    let source = "import x from 'x'; export { x };";
    let before = parse_ordinary(OrdinaryParseRequest {
        filename: "plain.tsx",
        source,
        lang: None,
        source_type: None,
        ast_type: Some("js"),
        ranges: false,
        preserve_parens: None,
        show_semantic_errors: false,
    });
    let _projected = parse_to_projected_tape(request(source, false)).expect("projected result");
    let after = parse_ordinary(OrdinaryParseRequest {
        filename: "plain.tsx",
        source,
        lang: None,
        source_type: None,
        ast_type: Some("js"),
        ranges: false,
        preserve_parens: None,
        show_semantic_errors: false,
    });
    assert_eq!(before.program_and_fixes, after.program_and_fixes);
    assert_eq!(before.errors.len(), after.errors.len());
}

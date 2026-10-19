#![cfg(feature = "toolchain")]

use std::path::Path;

use oxc_adapter::{FormatRequest, SourceKind, count_expanded_objects, format};

#[test]
fn ambient_exports_format_and_reparse_for_all_declaration_extensions() {
    for extension in ["d.ts", "d.mts", "d.cts"] {
        let filename = format!("types/contracts/repro.{extension}");
        let kind = SourceKind::from_path(Path::new(&filename)).unwrap();
        for source in [
            "export const value: string",
            "export const contract: {\nvalue: string\n}\nexport function read(): string",
            "export declare const explicit: string",
        ] {
            let first = format(&FormatRequest {
                parse_source: source,
                source_kind: kind,
                dynamic_tags: None,
                options: None,
                tsrx: false,
            })
            .unwrap_or_else(|error| panic!("{filename}: {error}"));
            assert!(first.code.contains("export"), "{}", first.code);
            assert!(!first.code.contains("export declare const value"));
            assert_eq!(
                count_expanded_objects(&first.code, kind, false).unwrap(),
                first.expanded_objects,
            );
            let second = format(&FormatRequest {
                parse_source: &first.code,
                source_kind: kind,
                dynamic_tags: None,
                options: None,
                tsrx: false,
            })
            .unwrap();
            assert_eq!(second.code, first.code, "{filename}");
        }
    }
}

#[test]
fn ordinary_typescript_still_requires_const_initializers() {
    // Bare `d.ts` and filenames merely ending in `d.ts` are not declaration files.
    for filename in ["repro.ts", "repro.mts", "repro.cts", "d.ts", "valid.ts"] {
        let kind = SourceKind::from_path(Path::new(filename)).unwrap();
        assert_eq!(kind, SourceKind::TypeScript);
        let error = format(&FormatRequest {
            parse_source: "export const value: string",
            source_kind: kind,
            dynamic_tags: None,
            options: None,
            tsrx: false,
        })
        .unwrap_err();
        assert!(error.to_string().contains("Missing initializer in const declaration"));
        format(&FormatRequest {
            parse_source: "export const value: string = 'ok'",
            source_kind: kind,
            dynamic_tags: None,
            options: None,
            tsrx: false,
        })
        .unwrap();
    }
}

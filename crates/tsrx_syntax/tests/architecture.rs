use std::{fs, path::Path};

use tsrx_syntax::{
    ByteSpan, FormatProjection, MappedProjection, Overlay, ProjectionError, StructuralKind,
    StructuralToken, TypeProjection, lift_formatted, project, project_for_format, project_for_lint,
    project_for_types, scan,
};

#[test]
fn syntax_core_has_upstream_oriented_private_module_boundaries() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for path in [
        "src/diagnostics.rs",
        "src/model.rs",
        "src/scanner/mod.rs",
        "src/scanner/stack.rs",
        "src/scanner/control.rs",
        "src/scanner/header.rs",
        "src/scanner/jsx.rs",
        "src/scanner/lexical.rs",
        "src/scanner/overlay.rs",
        "src/projection/mod.rs",
        "src/projection/mapping.rs",
        "src/projection/builder.rs",
        "src/projection/lint.rs",
        "src/projection/types.rs",
        "src/projection/format.rs",
        "src/projection/marker.rs",
        "src/projection/lift/mod.rs",
        "src/projection/lift/embedded.rs",
        "src/projection/lift/scaffold.rs",
        "src/projection/lift/writer.rs",
        "src/projection/lift/tokens.rs",
        "src/projection/lift/text.rs",
    ] {
        assert!(crate_root.join(path).is_file(), "missing {path}");
    }

    for path in ["src/scanner.rs", "src/projection.rs"] {
        assert!(!crate_root.join(path).exists(), "legacy monolith remains: {path}");
    }
}

#[test]
fn the_parser_lanes_mirror_the_base_scanner_and_projection_module_boundaries() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for path in [
        "src/parser_scanner/mod.rs",
        "src/parser_scanner/stack.rs",
        "src/parser_scanner/state.rs",
        "src/parser_scanner/region.rs",
        "src/parser_scanner/control.rs",
        "src/parser_scanner/header.rs",
        "src/parser_scanner/jsx.rs",
        "src/parser_scanner/lexical.rs",
        "src/parser_scanner/overlay.rs",
        "src/parser_scanner/dynamic.rs",
        "src/parser_scanner/surrogates.rs",
        "src/parser_projection/mod.rs",
        "src/parser_projection/mapping.rs",
        "src/parser_projection/builder.rs",
        "src/parser_projection/actions.rs",
        "src/parser_projection/validate.rs",
        "src/parser_projection/marker.rs",
        "src/parser_projection/entry.rs",
    ] {
        assert!(crate_root.join(path).is_file(), "missing {path}");
    }

    for path in ["src/parser_scanner.rs", "src/parser_projection.rs"] {
        assert!(!crate_root.join(path).exists(), "legacy monolith remains: {path}");
    }

    // Every submodule the parser lanes share with the base lanes keeps the base lane's name, so a
    // reader who knows `scanner/jsx.rs` knows where to look in `parser_scanner/`.
    for shared in ["stack.rs", "control.rs", "header.rs", "jsx.rs", "lexical.rs", "overlay.rs"] {
        assert!(crate_root.join("src/scanner").join(shared).is_file(), "missing scanner/{shared}");
    }
    for shared in ["mapping.rs", "builder.rs", "marker.rs"] {
        assert!(
            crate_root.join("src/projection").join(shared).is_file(),
            "missing projection/{shared}"
        );
    }
}

#[test]
fn the_parser_lanes_carry_no_switch_between_a_configuration_they_are_never_built_in() {
    // `scan_for_parser` supplies the richer overlay used by the parser and tooling projections;
    // compatibility calls that pass a base `scan()` overlay to lint/format are upgraded before
    // projection. The parser lanes still only ever run in one configuration, and a switch naming
    // another one is dead code rustc cannot see, because a comparison counts as a use.
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for (lane, switch) in [
        ("src/parser_scanner", "parser_mode"),
        ("src/parser_projection", "ProjectionPurpose"),
        ("src/parser_projection", "BuiltProjection"),
    ] {
        for entry in fs::read_dir(crate_root.join(lane)).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "rs") {
                continue;
            }
            assert!(
                !fs::read_to_string(&path).unwrap().contains(switch),
                "{} names the removed fork switch `{switch}`",
                path.strip_prefix(crate_root).unwrap().display()
            );
        }
    }
}

#[test]
fn no_source_file_carries_a_module_wide_lint_suppression() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut pending = vec![crate_root.join("src")];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.extension().is_none_or(|extension| extension != "rs") {
                continue;
            }
            let source = fs::read_to_string(&path).unwrap();
            assert!(
                !source.contains("#![allow("),
                "module-wide allow in {}",
                path.strip_prefix(crate_root).unwrap().display()
            );
        }
    }
}

#[test]
fn syntax_core_uses_only_the_oxc_unicode_table_and_exposes_its_root_api() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(crate_root.join("Cargo.toml")).unwrap();
    let dependencies = manifest
        .split_once("[dependencies]")
        .and_then(|(_, rest)| rest.split_once("\n[").map(|(section, _)| section))
        .unwrap();
    assert_eq!(
        dependencies
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect::<Vec<_>>(),
        ["unicode-id-start = \"1\""]
    );
    assert!(!manifest.contains("[dev-dependencies]"));
    assert!(!dependencies.contains("git"));
    assert!(!dependencies.contains("oxc_"));

    let _: fn(&str) -> Result<Overlay, ProjectionError> = scan;
    let _: fn(&str, &Overlay) -> Result<String, ProjectionError> = project;
    let _: fn(&str, &Overlay) -> Result<MappedProjection, ProjectionError> = project_for_lint;
    let _: fn(&str, &Overlay) -> Result<TypeProjection, ProjectionError> = project_for_types;
    let _: fn(&str, &Overlay) -> Result<FormatProjection, ProjectionError> = project_for_format;
    let _: fn(&str, &str, &FormatProjection) -> Result<String, ProjectionError> = lift_formatted;
    let _: Option<ByteSpan> = None;
    let _: Option<StructuralKind> = None;
    let _: Option<StructuralToken> = None;

    let overlay = scan("function View() @{<main />} ").unwrap();
    assert_eq!(overlay.control_count(), 0);
    assert_eq!(overlay.tokens().len(), 1);
}

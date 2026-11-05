use std::path::Path;

#[test]
fn the_linter_keeps_one_concept_per_module_file() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for path in [
        "src/lib.rs",
        "src/error.rs",
        "src/fixes.rs",
        "src/imports.rs",
        "src/pipeline.rs",
        "src/report.rs",
        "src/session.rs",
        "src/translate.rs",
    ] {
        assert!(crate_root.join(path).is_file(), "missing {path}");
    }
}

#[test]
fn no_linter_source_file_exceeds_the_layout_cap() {
    for path in source_files() {
        let lines = std::fs::read_to_string(&path).expect("readable source file").lines().count();
        assert!(lines <= 1500, "{} carries {lines} lines", path.display());
    }
}

/// The crate root is the only place a public path may be minted. Every module under it is
/// private, so `cargo public-api` renders the whole 231-item surface at `tsrx_lint::<Item>` no
/// matter which file defines the item, and a submodule that grew a bare `pub` would be invisible
/// in the API diff while still being reachable from a future `pub mod`.
#[test]
fn only_the_crate_root_declares_public_paths() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for path in source_files() {
        if path == crate_root.join("src/lib.rs") {
            continue;
        }
        let source = std::fs::read_to_string(&path).expect("readable source file");
        assert!(
            !source.lines().any(|line| line.trim_start().starts_with("pub mod ")),
            "{} declares a public module",
            path.display()
        );
    }
    let root = std::fs::read_to_string(crate_root.join("src/lib.rs")).expect("crate root");
    assert!(
        !root.lines().any(|line| line.trim_start().starts_with("pub mod ")),
        "the crate root exports a module path instead of a flat `pub use` list"
    );
}

/// `cargo public-api` emits one `impl <Type>` line per inherent impl block, so splitting
/// `LintSession`'s to shorten `session.rs` would grow the frozen surface without adding a single
/// callable method.
#[test]
fn the_lint_session_inherent_surface_stays_in_one_impl_block() {
    let blocks: usize = source_files()
        .into_iter()
        .map(|path| {
            let source = std::fs::read_to_string(&path).expect("readable source file");
            source.lines().filter(|line| line.trim() == "impl LintSession {").count()
        })
        .sum();
    assert_eq!(blocks, 1, "`cargo public-api` reports one line per inherent impl block");
}

#[test]
fn no_source_file_carries_a_module_wide_lint_suppression() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for path in source_files() {
        let source = std::fs::read_to_string(&path).expect("readable source file");
        assert!(
            !source.contains("#![allow("),
            "module-wide allow in {}",
            path.strip_prefix(crate_root).expect("source file under the crate root").display()
        );
    }
}

fn source_files() -> Vec<std::path::PathBuf> {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    let mut pending = vec![crate_root.join("src")];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).expect("readable source directory") {
            let path = entry.expect("readable source entry").path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                files.push(path);
            }
        }
    }
    files
}

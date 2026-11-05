//! The `.tsrx` modules a type-aware batch imports but does not lint.
//!
//! tsgolint only sees a `.tsrx` module through its in-memory `X.tsrx.tsx` projection, and only the
//! batch's own files are projected. An import of any other `.tsrx` file then failed to resolve
//! (TS2307), was typed `any`, and every type-aware rule went blind across that boundary. Every
//! `.tsrx` file the batch imports, directly or through another imported `.tsrx` file, is projected
//! here so it can be sent as a read-only overlay: readable, so the import resolves, but not linted
//! and never reported.
//!
//! Only relative (`./`, `../`) and absolute specifiers that name the `.tsrx` file itself are
//! followed. A tsconfig `paths` alias or a package specifier is left to TypeScript, which cannot
//! see a projection for it. Imports inside ordinary `.ts`/`.tsx` files that are not themselves in
//! the batch are not followed either, because those files reach tsgolint from disk.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use oxc_adapter::{SourceKind, module_specifiers};
use tsrx_syntax::{TypeProjection, project_for_types, scan_for_parser};

use crate::pipeline::{normalize_path, type_lane_path};

/// One file of the batch whose imports are followed: the path it was named by, and the source the
/// type lane sends for it (the type projection for a `.tsrx` file).
pub(crate) struct Importer<'a> {
    pub(crate) path: &'a Path,
    pub(crate) source: &'a str,
    pub(crate) kind: SourceKind,
}

/// A `.tsrx` module outside the batch and the projection tsgolint reads at its virtual path.
pub(crate) struct ImportedProjection {
    pub(crate) virtual_path: PathBuf,
    pub(crate) projection: TypeProjection,
}

/// Every `.tsrx` module the importers reach, each projected once and none of them an importer.
/// A file that cannot be read or projected is skipped: the import stays unresolved, exactly as
/// before, and the file is not this run's to report on.
pub(crate) fn imported_projections(importers: &[Importer<'_>]) -> Vec<ImportedProjection> {
    imported_projections_with(importers, |path| fs::read_to_string(path).ok())
}

fn imported_projections_with(
    importers: &[Importer<'_>],
    read: impl Fn(&Path) -> Option<String>,
) -> Vec<ImportedProjection> {
    let cwd = std::env::current_dir().ok();
    let identity = |path: &Path| match &cwd {
        Some(cwd) if path.is_relative() => normalize_path(&cwd.join(path)),
        _ => normalize_path(path),
    };
    let mut seen = importers.iter().map(|importer| identity(importer.path)).collect::<HashSet<_>>();
    let mut pending = Vec::new();
    let mut enqueue = |importer: &Path, source: &str, kind: SourceKind, pending: &mut Vec<_>| {
        if !source.contains(".tsrx") {
            return;
        }
        for specifier in module_specifiers(source, kind) {
            if let Some(target) = resolve_tsrx_specifier(importer, &specifier)
                && seen.insert(identity(&target))
            {
                pending.push(target);
            }
        }
    };
    for importer in importers {
        enqueue(importer.path, importer.source, importer.kind, &mut pending);
    }
    let mut imported = Vec::new();
    while let Some(path) = pending.pop() {
        let Some(source) = read(&path) else { continue };
        let Ok(overlay) = scan_for_parser(&source) else { continue };
        let Ok(projection) = project_for_types(&source, &overlay) else { continue };
        enqueue(&path, projection.source(), SourceKind::TypeScriptReact, &mut pending);
        imported.push(ImportedProjection { virtual_path: type_lane_path(&path, true), projection });
    }
    imported
}

/// The `.tsrx` file a specifier names, resolved against the importing file's directory the way
/// TypeScript resolves a relative import. Anything else, a bare package or a `paths` alias, is
/// `None`.
fn resolve_tsrx_specifier(importer: &Path, specifier: &str) -> Option<PathBuf> {
    if Path::new(specifier).extension().is_none_or(|extension| extension != "tsrx") {
        return None;
    }
    if specifier.starts_with("./") || specifier.starts_with("../") {
        let directory = importer.parent().unwrap_or_else(|| Path::new(""));
        return Some(normalize_path(&directory.join(specifier)));
    }
    Path::new(specifier).is_absolute().then(|| normalize_path(Path::new(specifier)))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        path::{Path, PathBuf},
    };

    use oxc_adapter::SourceKind;

    use super::{Importer, imported_projections_with, resolve_tsrx_specifier};

    /// An in-memory file system, so discovery is tested without touching the disk.
    type Files = HashMap<&'static str, &'static str>;

    fn files(entries: &[(&'static str, &'static str)]) -> Files {
        entries.iter().copied().collect()
    }

    fn discovered(importers: &[Importer<'_>], files: &Files) -> Vec<PathBuf> {
        let mut paths = imported_projections_with(importers, |path| {
            files.get(path.to_str()?).map(|source| (*source).to_string())
        })
        .into_iter()
        .map(|imported| imported.virtual_path)
        .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    #[test]
    fn relative_and_absolute_tsrx_specifiers_resolve_against_the_importer() {
        let importer = Path::new("src/app/main.ts");
        assert_eq!(
            resolve_tsrx_specifier(importer, "./label.tsrx"),
            Some(PathBuf::from("src/app/label.tsrx"))
        );
        assert_eq!(
            resolve_tsrx_specifier(importer, "../shared/./view.tsrx"),
            Some(PathBuf::from("src/shared/view.tsrx"))
        );
        assert_eq!(
            resolve_tsrx_specifier(Path::new("main.ts"), "../outside.tsrx"),
            Some(PathBuf::from("../outside.tsrx"))
        );
        assert_eq!(
            resolve_tsrx_specifier(importer, "/abs/view.tsrx"),
            Some(PathBuf::from("/abs/view.tsrx"))
        );
    }

    #[test]
    fn non_tsrx_bare_and_alias_specifiers_are_not_followed() {
        let importer = Path::new("src/main.ts");
        for specifier in ["./label", "./label.ts", "react", "@/label.tsrx", "pkg/label.tsrx"] {
            assert_eq!(resolve_tsrx_specifier(importer, specifier), None, "{specifier}");
        }
    }

    #[test]
    fn an_import_chain_is_followed_and_a_cycle_terminates() {
        let files = files(&[
            ("src/a.tsrx", "import { b } from './b.tsrx';\nexport const a = b;\n"),
            (
                "src/b.tsrx",
                "import { a } from './a.tsrx';\nimport { c } from './nested/c.tsrx';\nexport const b = c;\n",
            ),
            ("src/nested/c.tsrx", "import { a } from '../a.tsrx';\nexport const c = 1;\n"),
        ]);
        let source = "import { a } from './a.tsrx';\nexport const main = a;\n";
        let importers =
            [Importer { path: Path::new("src/main.ts"), source, kind: SourceKind::TypeScript }];
        assert_eq!(
            discovered(&importers, &files),
            [
                PathBuf::from("src/a.tsrx.tsx"),
                PathBuf::from("src/b.tsrx.tsx"),
                PathBuf::from("src/nested/c.tsrx.tsx"),
            ]
        );
    }

    #[test]
    fn importers_are_not_overlaid_and_missing_or_broken_targets_are_skipped() {
        let files = files(&[
            ("src/label.tsrx", "export function Label() @{\n  <span>hi</span>\n}\n"),
            ("src/broken.tsrx", "export function Broken() @{\n  <main>\n}\n"),
        ]);
        let app = "import { Label } from './label.tsrx';\nimport './broken.tsrx';\nimport './missing.tsrx';\nimport './main.ts';\n";
        let importers = [
            Importer {
                path: Path::new("src/app.tsrx"),
                source: app,
                kind: SourceKind::TypeScriptReact,
            },
            Importer {
                path: Path::new("./src/label.tsrx"),
                source: "export const label = 1;\n",
                kind: SourceKind::TypeScriptReact,
            },
        ];
        assert_eq!(discovered(&importers, &files), Vec::<PathBuf>::new());
        assert_eq!(discovered(&importers[..1], &files), [PathBuf::from("src/label.tsrx.tsx")]);
    }
}

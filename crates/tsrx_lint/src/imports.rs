//! The `.tsrx` modules a type-aware batch imports but does not lint.
//!
//! tsgolint only sees a `.tsrx` module through its in-memory `X.tsrx.tsx` projection, and only the
//! batch's own files are projected. An import of any other `.tsrx` file then failed to resolve
//! (TS2307), was typed `any`, and every type-aware rule went blind across that boundary. Every
//! `.tsrx` file the batch reaches is projected here so it can be sent as a read-only overlay:
//! readable, so the import resolves, but not linted and never reported.
//!
//! A `.tsrx` module is reached when a batch file imports it, or imports a module that reaches it:
//! another `.tsrx` file, or an ordinary `.ts`/`.tsx`/`.js` module such as a barrel that re-exports
//! it. Ordinary modules are only read to find the `.tsrx` modules behind them; tsgolint reads them
//! from disk itself, so they are never overlaid.
//!
//! Only relative (`./`, `../`) specifiers are followed, plus absolute ones that name a `.tsrx`
//! file. A tsconfig `paths` alias, a `baseUrl` import, or a package specifier is left to
//! TypeScript, which cannot see a projection for it.

use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use memchr::memmem;
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

/// Whether `source` can request a module this discovery follows: every followed specifier holds
/// `./` (relative), ends in `.` right before its closing quote (`"."` and `".."`, a directory's
/// index), or holds `.tsrx` (an absolute `.tsrx` path). A byte search, so a file that requests
/// nothing is passed over without being decoded or parsed.
pub(crate) fn may_import_followed_module(source: &[u8]) -> bool {
    [&b"./"[..], b".tsrx", b".'", b".\"", b".`"]
        .iter()
        .any(|needle| memmem::find(source, needle).is_some())
}

/// Every `.tsrx` module the importers reach, each projected once and none of them an importer.
/// A file that cannot be read or projected is skipped: the import stays unresolved, exactly as
/// before, and the file is not this run's to report on.
pub(crate) fn imported_projections(importers: &[Importer<'_>]) -> Vec<ImportedProjection> {
    imported_projections_with(importers, &[], |path| fs::read_to_string(path).ok())
}

/// [`imported_projections`] reading every module through `load`. `known` names further files of
/// the batch that are not importers, because they were found to request nothing: they are never
/// read again, and an import of one is not followed.
pub(crate) fn imported_projections_with(
    importers: &[Importer<'_>],
    known: &[&Path],
    load: impl Fn(&Path) -> Option<String>,
) -> Vec<ImportedProjection> {
    let cwd = std::env::current_dir().ok();
    let identity = |path: &Path| match &cwd {
        Some(cwd) if path.is_relative() => normalize_path(&cwd.join(path)),
        _ => normalize_path(path),
    };
    let mut seen = importers
        .iter()
        .map(|importer| importer.path)
        .chain(known.iter().copied())
        .map(identity)
        .collect::<HashSet<_>>();
    let mut pending = Vec::<Module>::new();
    let mut follow = |importer: &Path, specifiers: Vec<String>, pending: &mut Vec<Module>| {
        for specifier in specifiers {
            if let Some(target) = resolve_tsrx_specifier(importer, &specifier) {
                if seen.insert(identity(&target)) {
                    pending.push(Module::Tsrx(target));
                }
                continue;
            }
            for candidate in ordinary_candidates(importer, &specifier) {
                // A module this run already has is followed (or proven irrelevant) exactly once.
                if seen.contains(&identity(&candidate)) {
                    break;
                }
                let Ok(kind) = SourceKind::from_path(&candidate) else { continue };
                if let Some(source) = load(&candidate) {
                    seen.insert(identity(&candidate));
                    pending.push(Module::Ordinary(candidate, kind, source));
                    break;
                }
            }
        }
    };
    // Parsing the batch's own files is nearly all of the work, and each is independent.
    let specifiers =
        parallel_map(importers, |importer| followed_specifiers(importer.source, importer.kind));
    for (importer, specifiers) in importers.iter().zip(specifiers) {
        follow(importer.path, specifiers, &mut pending);
    }
    let mut imported = Vec::new();
    while let Some(module) = pending.pop() {
        match module {
            Module::Tsrx(path) => {
                let Some(source) = load(&path) else { continue };
                let Ok(overlay) = scan_for_parser(&source) else { continue };
                let Ok(projection) = project_for_types(&source, &overlay) else { continue };
                let specifiers =
                    followed_specifiers(projection.source(), SourceKind::TypeScriptReact);
                follow(&path, specifiers, &mut pending);
                imported.push(ImportedProjection {
                    virtual_path: type_lane_path(&path, true),
                    projection,
                });
            }
            Module::Ordinary(path, kind, source) => {
                follow(&path, followed_specifiers(&source, kind), &mut pending);
            }
        }
    }
    imported
}

/// The specifiers of `source` this discovery may follow, without parsing a source that has none.
fn followed_specifiers(source: &str, kind: SourceKind) -> Vec<String> {
    if may_import_followed_module(source.as_bytes()) {
        module_specifiers(source, kind)
    } else {
        Vec::new()
    }
}

/// `items` mapped by `map` across the available cores, in order. A thread that cannot be started
/// leaves its share to the calling thread, so a host without threads still gets every answer.
pub(crate) fn parallel_map<T: Sync, R: Send>(items: &[T], map: impl Fn(&T) -> R + Sync) -> Vec<R> {
    const MIN_PER_THREAD: usize = 32;
    let threads = std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .min(items.len().div_ceil(MIN_PER_THREAD));
    if threads <= 1 {
        return items.iter().map(&map).collect();
    }
    let chunk = items.len().div_ceil(threads);
    let map = &map;
    std::thread::scope(|scope| {
        let handles = items
            .chunks(chunk)
            .map(|part| {
                let spawned = std::thread::Builder::new()
                    .spawn_scoped(scope, move || part.iter().map(map).collect::<Vec<_>>());
                (part, spawned)
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .flat_map(|(part, spawned)| match spawned.map(std::thread::ScopedJoinHandle::join) {
                Ok(Ok(results)) => results,
                Ok(Err(panic)) => std::panic::resume_unwind(panic),
                Err(_) => part.iter().map(map).collect(),
            })
            .collect()
    })
}

/// A module discovery has reached but not yet read for its own imports.
enum Module {
    Tsrx(PathBuf),
    Ordinary(PathBuf, SourceKind, String),
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

/// The files a relative specifier of an ordinary module may name, in the order TypeScript's
/// `bundler` and `node16` resolution try them: the TypeScript source a `.js`-family specifier
/// stands for, then the file itself, and for an extensionless specifier each extension in turn and
/// then the directory's `index`. A bare package or a `paths` alias yields nothing.
fn ordinary_candidates(importer: &Path, specifier: &str) -> Vec<PathBuf> {
    if !(specifier.starts_with("./")
        || specifier.starts_with("../")
        || specifier == "."
        || specifier == "..")
        || specifier.contains(['?', '#'])
    {
        return Vec::new();
    }
    let directory = importer.parent().unwrap_or_else(|| Path::new(""));
    let base = normalize_path(&directory.join(specifier));
    let index = |base: &Path| {
        let index = base.join("index");
        [".ts", ".tsx", ".d.ts", ".js", ".jsx"]
            .map(|suffix| {
                let mut path = OsString::from(index.as_os_str());
                path.push(suffix);
                PathBuf::from(path)
            })
            .to_vec()
    };
    // `.`, `..`, and a trailing `/` name a directory, which resolves only to its index.
    if specifier == "." || specifier == ".." || specifier.ends_with('/') {
        return index(&base);
    }
    let with = |suffix: &str| {
        let mut path = OsString::from(base.as_os_str());
        path.push(suffix);
        PathBuf::from(path)
    };
    let swapped = |extensions: &[&str]| {
        extensions.iter().map(|extension| base.with_extension(extension)).collect::<Vec<_>>()
    };
    match base.extension().and_then(|extension| extension.to_str()) {
        Some("ts" | "tsx" | "mts" | "cts") => vec![base],
        Some("js") => [swapped(&["ts", "tsx", "d.ts"]), vec![base]].concat(),
        Some("jsx") => [swapped(&["tsx", "ts", "d.ts"]), vec![base]].concat(),
        Some("mjs") => [swapped(&["mts", "d.mts"]), vec![base]].concat(),
        Some("cjs") => [swapped(&["cts", "d.cts"]), vec![base]].concat(),
        _ => {
            let mut candidates = [".ts", ".tsx", ".d.ts", ".js", ".jsx"].map(with).to_vec();
            candidates.extend(index(&base));
            candidates
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        path::{Path, PathBuf},
    };

    use oxc_adapter::SourceKind;

    use super::{Importer, imported_projections_with, ordinary_candidates, resolve_tsrx_specifier};

    /// An in-memory file system, so discovery is tested without touching the disk.
    type Files = HashMap<&'static str, &'static str>;

    fn files(entries: &[(&'static str, &'static str)]) -> Files {
        entries.iter().copied().collect()
    }

    fn discovered(importers: &[Importer<'_>], files: &Files) -> Vec<PathBuf> {
        let mut paths = imported_projections_with(importers, &[], |path| {
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

    #[test]
    fn a_tsrx_module_behind_ordinary_modules_is_reached_but_they_are_not_overlaid() {
        let files = files(&[
            ("src/barrel.ts", "export { loadLabel } from './label.tsrx';\nexport * from './ui';\n"),
            ("src/label.tsrx", "export async function loadLabel() { return 'hi'; }\n"),
            ("src/ui/index.ts", "export * from './button.js';\n"),
            ("src/ui/button.tsx", "export { Button } from './button.tsrx';\n"),
            ("src/ui/button.tsrx", "export function Button() @{\n  <button />\n}\n"),
            ("src/plain.ts", "export const plain = 1;\n"),
        ]);
        let source = "import { loadLabel } from './barrel';\nimport './plain.ts';\nimport 'react';\nimport '@/alias';\nimport './styles.css';\n";
        let importers =
            [Importer { path: Path::new("src/main.ts"), source, kind: SourceKind::TypeScript }];
        assert_eq!(
            discovered(&importers, &files),
            [PathBuf::from("src/label.tsrx.tsx"), PathBuf::from("src/ui/button.tsrx.tsx")]
        );
    }

    #[test]
    fn a_tsrx_module_behind_a_parent_or_own_directory_index_is_reached() {
        // Neither importer holds `./`; only the closing-quote check lets them be read.
        let files = files(&[
            ("src/index.ts", "export * from './label.tsrx';\n"),
            ("src/label.tsrx", "export const label = 1;\n"),
            ("src/nested/index.ts", "export * from \"../view.tsrx\";\n"),
            ("src/view.tsrx", "export const view = 1;\n"),
        ]);
        let parent = "import { label } from '..';\n";
        let own = "import { view } from \".\";\n";
        let importers = [
            Importer {
                path: Path::new("src/ui/main.ts"),
                source: parent,
                kind: SourceKind::TypeScript,
            },
            Importer {
                path: Path::new("src/nested/main.ts"),
                source: own,
                kind: SourceKind::TypeScript,
            },
        ];
        assert!(super::may_import_followed_module(parent.as_bytes()));
        assert!(super::may_import_followed_module(own.as_bytes()));
        assert!(!super::may_import_followed_module(
            b"import { x } from 'react';\nconst y = 1.5;\n"
        ));
        assert_eq!(
            discovered(&importers, &files),
            [PathBuf::from("src/label.tsrx.tsx"), PathBuf::from("src/view.tsrx.tsx")]
        );
    }

    #[test]
    fn a_known_file_is_neither_read_nor_followed() {
        let files = files(&[
            ("src/barrel.ts", "export { label } from './label.tsrx';\n"),
            ("src/label.tsrx", "export const label = 1;\n"),
        ]);
        let reads = std::cell::RefCell::new(Vec::new());
        let source = "import { label } from './barrel';\n";
        let importers =
            [Importer { path: Path::new("src/main.ts"), source, kind: SourceKind::TypeScript }];
        let imported =
            imported_projections_with(&importers, &[Path::new("src/barrel.ts")], |path| {
                reads.borrow_mut().push(path.to_path_buf());
                files.get(path.to_str()?).map(|source| (*source).to_string())
            });
        assert!(imported.is_empty());
        assert_eq!(reads.into_inner(), Vec::<PathBuf>::new());
    }

    #[test]
    fn ordinary_candidates_follow_typescript_resolution_order() {
        let importer = Path::new("src/main.ts");
        let names = |specifier| {
            ordinary_candidates(importer, specifier)
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names("./util.js"),
            ["src/util.ts", "src/util.tsx", "src/util.d.ts", "src/util.js"]
        );
        assert_eq!(names("../shared.mjs"), ["shared.mts", "shared.d.mts", "shared.mjs"]);
        assert_eq!(names("./view.tsx"), ["src/view.tsx"]);
        assert_eq!(
            names("./ui"),
            [
                "src/ui.ts",
                "src/ui.tsx",
                "src/ui.d.ts",
                "src/ui.js",
                "src/ui.jsx",
                "src/ui/index.ts",
                "src/ui/index.tsx",
                "src/ui/index.d.ts",
                "src/ui/index.js",
                "src/ui/index.jsx",
            ]
        );
        assert_eq!(names(".."), ["index.ts", "index.tsx", "index.d.ts", "index.js", "index.jsx"]);
        assert_eq!(names("./ui/")[0], "src/ui/index.ts");
        assert_eq!(names(".")[0], "src/index.ts");
        for specifier in ["react", "@/ui", "pkg/sub", "/abs/file", "./raw.ts?raw"] {
            assert_eq!(names(specifier), Vec::<String>::new(), "{specifier}");
        }
    }
}

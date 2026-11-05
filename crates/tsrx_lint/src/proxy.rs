//! The `.tsrx` overlay for a tsgolint payload another Oxlint composed.
//!
//! The drop-in `oxlint` command hands ordinary `.ts`/`.tsx`/`.js` files to canonical Oxlint, which
//! starts its own tsgolint. That payload names only files on disk, so an import of a `.tsrx` module
//! from one of them failed to resolve (TS2307), was typed `any`, and every type-aware rule went
//! blind across it. The drop-in points canonical Oxlint at this executable as its tsgolint, and the
//! payload passes through [`overlay_imported_tsrx`] on its way to the real one: every `.tsrx`
//! module the payload's files import is added to `source_overrides` as its type projection, the
//! same read-only overlay the TSRX lane sends for its own batches. Nothing else in the payload
//! changes, so the files linted, the rules run on them, and the diagnostics reported for them stay
//! canonical Oxlint's own.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use oxc_adapter::SourceKind;
use serde_json::{Map, Value};

use crate::imports::{
    Importer, imported_projections_with, may_import_followed_module, parallel_map,
};

/// A payload after [`overlay_imported_tsrx`].
#[derive(Debug, Default)]
pub struct OverlaidPayload {
    /// The payload to send instead, or `None` to forward the original bytes unchanged: it is not a
    /// payload this understands, or reaches no `.tsrx` module.
    pub payload: Option<Vec<u8>>,
    /// The first file the payload asks tsgolint to lint, which locates the project it belongs to.
    pub first_file: Option<PathBuf>,
}

/// `payload` with a `source_overrides` entry for every `.tsrx` module its files reach.
///
/// A file's source is the payload's own override for it when it has one (an editor's unsaved
/// buffer), otherwise the file on disk; the same holds for every module reached from it. A file is
/// read as bytes and decoded only if it can request a followed module at all, so a payload with no
/// relative or `.tsrx` import anywhere costs one byte search per file. An override already present
/// for a projection path is kept.
#[must_use]
pub fn overlay_imported_tsrx(payload: &[u8]) -> OverlaidPayload {
    let Ok(mut payload) = serde_json::from_slice::<Value>(payload) else {
        return OverlaidPayload::default();
    };
    let Some(object) = payload.as_object_mut() else { return OverlaidPayload::default() };
    let paths = object
        .get("configs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|config| config.get("file_paths")?.as_array())
        .flatten()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let first_file = paths.first().cloned();
    let buffers = object
        .get("source_overrides")
        .and_then(Value::as_object)
        .map(|overrides| {
            overrides
                .iter()
                .filter_map(|(path, source)| {
                    Some((PathBuf::from(path), source.as_str()?.to_owned()))
                })
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let load = |path: &Path| buffers.get(path).cloned().or_else(|| fs::read_to_string(path).ok());
    // Reading the payload's files is the rest of the work, so it is spread across cores too.
    let sources = parallel_map(&paths, |path| {
        let kind = SourceKind::from_path(path).ok()?;
        let source = if let Some(source) = buffers.get(path) {
            source.clone()
        } else {
            let bytes = fs::read(path).ok()?;
            if !may_import_followed_module(&bytes) {
                return None;
            }
            String::from_utf8(bytes).ok()?
        };
        Some((source, kind))
    })
    .into_iter()
    .zip(&paths)
    .filter_map(|(read, path)| read.map(|(source, kind)| (path.as_path(), source, kind)))
    .collect::<Vec<_>>();
    let importers = sources
        .iter()
        .map(|(path, source, kind)| Importer { path, source, kind: *kind })
        .collect::<Vec<_>>();
    let known = paths.iter().map(PathBuf::as_path).collect::<Vec<_>>();
    let imported = imported_projections_with(&importers, &known, load);
    if imported.is_empty() {
        return OverlaidPayload { payload: None, first_file };
    }
    let slot = object.entry("source_overrides").or_insert(Value::Null);
    if slot.is_null() {
        *slot = Value::Object(Map::new());
    }
    let Some(overrides) = slot.as_object_mut() else {
        return OverlaidPayload { payload: None, first_file };
    };
    for file in imported {
        overrides
            .entry(file.virtual_path.to_string_lossy().into_owned())
            .or_insert_with(|| Value::String(file.projection.source().to_string()));
    }
    OverlaidPayload { payload: serde_json::to_vec(&payload).ok(), first_file }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{Value, json};

    use super::overlay_imported_tsrx;

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory =
            std::env::temp_dir().join(format!("tsrx-lint-proxy-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(directory.join("nested")).unwrap();
        directory
    }

    fn overlaid(payload: &Value) -> Option<Value> {
        overlay_imported_tsrx(&serde_json::to_vec(payload).unwrap())
            .payload
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn an_imported_tsrx_module_and_its_own_imports_become_overlays() {
        let directory = scratch("chain");
        let main = directory.join("main.ts");
        fs::write(&main, "import { label } from './label.tsrx';\nexport const x = label;\n")
            .unwrap();
        fs::write(
            directory.join("label.tsrx"),
            "import { leaf } from './nested/leaf.tsrx';\nexport const label = leaf;\n",
        )
        .unwrap();
        fs::write(directory.join("nested").join("leaf.tsrx"), "export const leaf = 1;\n").unwrap();
        let main = main.to_string_lossy().into_owned();
        let rules = json!([{ "name": "no-floating-promises", "options": { "ignoreVoid": true } }]);
        let payload = json!({
            "version": 2,
            "configs": [{ "file_paths": [main], "rules": rules }],
            "source_overrides": null,
            "report_syntactic": true,
            "report_semantic": false,
        });
        let result = overlaid(&payload).expect("the import is overlaid");
        let overrides = result["source_overrides"].as_object().unwrap();
        let mut keys = overrides.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        let label = directory.join("label.tsrx.tsx").to_string_lossy().into_owned();
        let leaf = directory.join("nested").join("leaf.tsrx.tsx").to_string_lossy().into_owned();
        assert_eq!(keys, [label.clone(), leaf]);
        assert!(overrides[&label].as_str().unwrap().contains("export const label = leaf"));
        // Everything that is not an overlay passes through untouched.
        assert_eq!(result["configs"], payload["configs"]);
        assert_eq!(result["version"], 2);
        assert_eq!(result["report_syntactic"], true);
        assert_eq!(result["report_semantic"], false);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn an_unsaved_buffer_is_read_and_existing_overrides_are_kept() {
        let directory = scratch("buffer");
        let main = directory.join("main.ts").to_string_lossy().into_owned();
        // Nothing on disk imports anything; only the editor buffer does.
        fs::write(&main, "export {};\n").unwrap();
        fs::write(directory.join("label.tsrx"), "export const label = 1;\n").unwrap();
        fs::write(directory.join("other.tsrx"), "export const other = 1;\n").unwrap();
        fs::write(directory.join("edited.tsrx"), "export const edited = 1;\n").unwrap();
        let other = directory.join("other.tsrx.tsx").to_string_lossy().into_owned();
        // An imported module with an unsaved buffer of its own is projected from that buffer.
        let edited = directory.join("edited.tsrx").to_string_lossy().into_owned();
        let buffer = "import './label.tsrx';\nimport './other.tsrx';\nimport './edited.tsrx';\n";
        let payload = json!({
            "version": 2,
            "configs": [{ "file_paths": [main], "rules": [] }],
            "source_overrides": {
                main.clone(): buffer,
                other.clone(): "kept",
                edited: "export const edited = 2;\n",
            },
            "report_syntactic": false,
            "report_semantic": false,
        });
        let result = overlaid(&payload).expect("the buffer's import is overlaid");
        let overrides = result["source_overrides"].as_object().unwrap();
        assert_eq!(overrides[&main], buffer);
        assert_eq!(overrides[&other], "kept");
        let label = directory.join("label.tsrx.tsx").to_string_lossy().into_owned();
        assert!(overrides[&label].as_str().unwrap().contains("export const label = 1"));
        let projected = directory.join("edited.tsrx.tsx").to_string_lossy().into_owned();
        assert!(overrides[&projected].as_str().unwrap().contains("export const edited = 2"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_payload_with_nothing_to_overlay_or_not_understood_is_left_alone() {
        let directory = scratch("none");
        let main = directory.join("main.ts").to_string_lossy().into_owned();
        fs::write(&main, "import './missing.tsrx';\nimport './plain.ts';\n").unwrap();
        let payload = json!({
            "version": 2,
            "configs": [{ "file_paths": [main, "/nowhere/gone.ts"], "rules": [] }],
            "source_overrides": null,
            "report_syntactic": false,
            "report_semantic": false,
        });
        assert_eq!(overlaid(&payload), None);
        assert_eq!(overlay_imported_tsrx(b"not json").payload, None);
        assert_eq!(overlay_imported_tsrx(b"[1, 2]").payload, None);
        assert_eq!(overlaid(&json!({ "version": 3 })), None);
        fs::remove_dir_all(directory).unwrap();
    }
}

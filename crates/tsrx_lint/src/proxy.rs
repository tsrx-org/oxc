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

use std::{fs, path::Path};

use oxc_adapter::SourceKind;
use serde_json::{Map, Value};

use crate::imports::{Importer, imported_projections};

/// `payload` with a `source_overrides` entry for every `.tsrx` module its files import.
///
/// `None` when it is not a payload this understands or imports no `.tsrx` module, so the caller
/// forwards the original bytes unchanged.
///
/// A file's source is the payload's own override for it when it has one (an editor's unsaved
/// buffer), otherwise the file on disk. An override already present for a projection path is
/// kept.
#[must_use]
pub fn overlay_imported_tsrx(payload: &[u8]) -> Option<Vec<u8>> {
    let mut payload = serde_json::from_slice::<Value>(payload).ok()?;
    let object = payload.as_object_mut()?;
    let overrides = object.get("source_overrides").and_then(Value::as_object);
    let mut sources = Vec::new();
    for path in object
        .get("configs")?
        .as_array()?
        .iter()
        .filter_map(|config| config.get("file_paths")?.as_array())
        .flatten()
        .filter_map(Value::as_str)
    {
        let Ok(kind) = SourceKind::from_path(Path::new(path)) else { continue };
        let source = match overrides.and_then(|overrides| overrides.get(path)) {
            Some(Value::String(source)) => source.clone(),
            _ => match fs::read_to_string(path) {
                Ok(source) => source,
                Err(_) => continue,
            },
        };
        // Only a file that names a `.tsrx` module is parsed for its imports.
        if source.contains(".tsrx") {
            sources.push((path, source, kind));
        }
    }
    let importers = sources
        .iter()
        .map(|(path, source, kind)| Importer { path: Path::new(path), source, kind: *kind })
        .collect::<Vec<_>>();
    let imported = imported_projections(&importers);
    if imported.is_empty() {
        return None;
    }
    let overrides = match object.entry("source_overrides").or_insert(Value::Null) {
        Value::Object(overrides) => overrides,
        slot @ Value::Null => {
            *slot = Value::Object(Map::new());
            slot.as_object_mut()?
        }
        _ => return None,
    };
    for file in imported {
        overrides
            .entry(file.virtual_path.to_string_lossy().into_owned())
            .or_insert_with(|| Value::String(file.projection.source().to_string()));
    }
    serde_json::to_vec(&payload).ok()
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
        let other = directory.join("other.tsrx.tsx").to_string_lossy().into_owned();
        let buffer = "import './label.tsrx';\nimport './other.tsrx';\n";
        let payload = json!({
            "version": 2,
            "configs": [{ "file_paths": [main], "rules": [] }],
            "source_overrides": { main.clone(): buffer, other.clone(): "kept" },
            "report_syntactic": false,
            "report_semantic": false,
        });
        let result = overlaid(&payload).expect("the buffer's import is overlaid");
        let overrides = result["source_overrides"].as_object().unwrap();
        assert_eq!(overrides[&main], buffer);
        assert_eq!(overrides[&other], "kept");
        let label = directory.join("label.tsrx.tsx").to_string_lossy().into_owned();
        assert!(overrides[&label].as_str().unwrap().contains("export const label = 1"));
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
        assert_eq!(overlay_imported_tsrx(b"not json"), None);
        assert_eq!(overlay_imported_tsrx(b"[1, 2]"), None);
        assert_eq!(overlaid(&json!({ "version": 3 })), None);
        fs::remove_dir_all(directory).unwrap();
    }
}

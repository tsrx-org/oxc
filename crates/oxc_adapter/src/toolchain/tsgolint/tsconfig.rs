//! Putting every in-memory projection inside the tsconfig project that owns its authored file.
//!
//! tsgolint's source-override overlay answers `FileExists` and `ReadFile` for a projection, but
//! not directory listings. A tsconfig's `include` is expanded by listing directories, so no
//! project ever lists a `.tsrx.tsx` virtual path. Every projection then fell into tsgolint's
//! inferred project, which type-checks with default options: React JSX, no `types`, no `paths`.
//!
//! The same overlay is the fix. Each owning tsconfig is sent as one more source override whose
//! `files` names the projections it owns, so tsgolint assigns them to that project and checks
//! them with its `compilerOptions`, exactly as it would a `.ts` file next to them. Nothing is
//! written to disk.

use std::{
    collections::VecDeque,
    path::{Component, Path, PathBuf},
};

use globset::GlobBuilder;
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::Value;

/// The configs tsgolint looks for in each directory, in its own order.
const CONFIG_NAMES: [&str; 2] = ["tsconfig.json", "jsconfig.json"];
/// TypeScript's `exclude` when a config chain names none.
const DEFAULT_EXCLUDE: [&str; 3] = ["node_modules", "bower_components", "jspm_packages"];

/// One projection to place: the `.tsrx` file the user wrote and the virtual path sent to tsgolint.
pub(crate) struct ProjectedFile<'a> {
    pub(crate) authored: &'a Path,
    pub(crate) virtual_path: &'a Path,
}

/// The tsconfig source overrides that put each projection in its owning project, keyed by the
/// absolute config path. `explicit` names one tsconfig that owns every projection, the way
/// `--tsconfig` does; without it each file's owner is found the way tsgolint finds a `.ts` file's.
/// A projection that no config owns is left out, and tsgolint checks it in its inferred project.
pub(crate) fn tsconfig_overrides(
    cwd: &Path,
    explicit: Option<&Path>,
    files: &[ProjectedFile<'_>],
) -> FxHashMap<String, String> {
    let mut configs = ConfigCache::default();
    let mut by_owner = FxHashMap::<PathBuf, Vec<PathBuf>>::default();
    // tsgolint starts every search at the config nearest the file and only follows references
    // from there, so a named tsconfig is reached by referencing it from that config.
    let mut entries = FxHashSet::<PathBuf>::default();
    let explicit = explicit.map(|path| absolute(cwd, path));
    for file in files {
        let authored = absolute(cwd, file.authored);
        let virtual_path = absolute(cwd, file.virtual_path);
        let owner = match &explicit {
            Some(path) if configs.load(path).is_some() => {
                let entry = nearest_config(&authored)
                    .or_else(|| Some(authored.parent()?.join(CONFIG_NAMES[0])));
                if let Some(entry) = entry.filter(|entry| entry != path) {
                    entries.insert(entry);
                }
                Some(path.clone())
            }
            Some(_) => None,
            None => find_owner(&mut configs, &authored, &virtual_path),
        };
        if let Some(owner) = owner {
            by_owner.entry(owner).or_default().push(virtual_path);
        }
    }
    let mut overrides = by_owner
        .into_iter()
        .filter_map(|(owner, projections)| {
            let source = configs.override_source(&owner, &projections)?;
            Some((owner.to_string_lossy().into_owned(), source))
        })
        .collect::<FxHashMap<_, _>>();
    if let Some(explicit) = &explicit {
        for entry in entries {
            if let Some(source) = configs.reference_source(&entry, explicit) {
                overrides.insert(entry.to_string_lossy().into_owned(), source);
            }
        }
    }
    overrides
}

/// The config tsgolint begins its search at: the first `tsconfig.json` or `jsconfig.json` in the
/// file's directory or above it.
fn nearest_config(authored: &Path) -> Option<PathBuf> {
    authored.parent()?.ancestors().find_map(|directory| {
        CONFIG_NAMES.iter().map(|name| directory.join(name)).find(|candidate| candidate.is_file())
    })
}

/// tsgolint's search: the nearest `tsconfig.json`/`jsconfig.json`, then the projects it
/// references, breadth first; an ancestor directory's config when none of those include the file.
fn find_owner(configs: &mut ConfigCache, authored: &Path, virtual_path: &Path) -> Option<PathBuf> {
    for directory in authored.parent()?.ancestors() {
        let Some(root) = CONFIG_NAMES
            .iter()
            .map(|name| directory.join(name))
            .find(|candidate| candidate.is_file())
        else {
            continue;
        };
        let mut queue = VecDeque::from([root]);
        let mut visited = FxHashSet::default();
        while let Some(config) = queue.pop_front() {
            if !visited.insert(config.clone()) {
                continue;
            }
            let Some(references) = configs.load(&config).map(|loaded| loaded.references.clone())
            else {
                continue;
            };
            if configs.includes(&config, authored, virtual_path) {
                return Some(config);
            }
            queue.extend(references);
        }
    }
    None
}

struct LoadedConfig {
    raw: Value,
    directory: PathBuf,
    extends: Vec<PathBuf>,
    references: Vec<PathBuf>,
}

/// The `files`/`include`/`exclude` that apply to one config after its `extends` chain, each with
/// the directory its relative entries resolve against.
#[derive(Default)]
struct FileSpecs {
    files: Option<Vec<PathBuf>>,
    include: Option<(PathBuf, Vec<String>)>,
    exclude: Option<(PathBuf, Vec<String>)>,
}

#[derive(Default)]
struct ConfigCache {
    loaded: FxHashMap<PathBuf, Option<LoadedConfig>>,
}

impl ConfigCache {
    fn load(&mut self, path: &Path) -> Option<&LoadedConfig> {
        if !self.loaded.contains_key(path) {
            let loaded = read_config(path);
            self.loaded.insert(path.to_path_buf(), loaded);
        }
        self.loaded.get(path)?.as_ref()
    }

    fn specs(&mut self, path: &Path, depth: usize) -> FileSpecs {
        let Some(config) = self.load(path) else {
            return FileSpecs::default();
        };
        let directory = config.directory.clone();
        let own_files = string_array(&config.raw, "files")
            .map(|files| files.iter().map(|file| normalize(&directory.join(file))).collect());
        let own_include =
            string_array(&config.raw, "include").map(|specs| (directory.clone(), specs));
        let own_exclude =
            string_array(&config.raw, "exclude").map(|specs| (directory.clone(), specs));
        let extends = config.extends.clone();
        let mut specs = FileSpecs::default();
        // Later `extends` entries win, and the config's own fields win over all of them. A chain
        // deeper than any real project is a cycle, which TypeScript itself reports.
        if depth < 32 {
            for base in &extends {
                let inherited = self.specs(base, depth + 1);
                specs.files = inherited.files.or(specs.files);
                specs.include = inherited.include.or(specs.include);
                specs.exclude = inherited.exclude.or(specs.exclude);
            }
        }
        FileSpecs {
            files: own_files.or(specs.files),
            include: own_include.or(specs.include),
            exclude: own_exclude.or(specs.exclude),
        }
    }

    /// Whether `config` would own the file if tsgolint could see it. The authored `.tsrx` path is
    /// tried as well as the virtual one, so an `include` written for `.tsrx` sources counts.
    fn includes(&mut self, config: &Path, authored: &Path, virtual_path: &Path) -> bool {
        let Some(directory) = self.load(config).map(|loaded| loaded.directory.clone()) else {
            return false;
        };
        let specs = self.specs(config, 0);
        let candidates = [virtual_path, authored];
        if specs.files.as_ref().is_some_and(|files| {
            files.iter().any(|file| candidates.iter().any(|candidate| file == candidate))
        }) {
            return true;
        }
        let (include_base, include) = match specs.include {
            Some(include) => include,
            None if specs.files.is_some() => return false,
            None => (directory.clone(), vec!["**/*".to_string()]),
        };
        let (exclude_base, exclude) = specs.exclude.unwrap_or_else(|| {
            let mut exclude = DEFAULT_EXCLUDE.map(str::to_string).to_vec();
            if let Some(out_dir) = self
                .load(config)
                .and_then(|loaded| loaded.raw.get("compilerOptions"))
                .and_then(|options| options.get("outDir"))
                .and_then(Value::as_str)
            {
                exclude.push(out_dir.to_string());
            }
            (directory, exclude)
        });
        candidates.iter().any(|candidate| {
            include.iter().any(|spec| spec_matches(&include_base, spec, candidate, false))
                && !exclude.iter().any(|spec| spec_matches(&exclude_base, spec, candidate, true))
        })
    }

    /// The owning config's text with its projections appended to `files`. Adding `files` would
    /// switch off TypeScript's default `include`, so a chain without one is given it explicitly.
    fn override_source(&mut self, owner: &Path, projections: &[PathBuf]) -> Option<String> {
        let specs = self.specs(owner, 0);
        let mut raw = self.load(owner)?.raw.clone();
        let object = raw.as_object_mut()?;
        let mut files = specs.files.clone().unwrap_or_default();
        files.extend(projections.iter().cloned());
        object.insert(
            "files".to_string(),
            Value::Array(
                files
                    .iter()
                    .map(|file| Value::String(file.to_string_lossy().into_owned()))
                    .collect(),
            ),
        );
        if specs.files.is_none() && specs.include.is_none() {
            object.insert("include".to_string(), Value::Array(vec![Value::from("**/*")]));
        }
        serde_json::to_string(&raw).ok()
    }

    /// The text of the config tsgolint starts at, with `explicit` added to its `references`. A
    /// directory without a config gets one that owns no files and only references `explicit`.
    fn reference_source(&mut self, entry: &Path, explicit: &Path) -> Option<String> {
        let mut raw = match self.load(entry) {
            Some(loaded) => loaded.raw.clone(),
            None => serde_json::json!({ "files": [] }),
        };
        let object = raw.as_object_mut()?;
        let reference = serde_json::json!({ "path": explicit.to_string_lossy() });
        match object.get_mut("references").and_then(Value::as_array_mut) {
            Some(references) => references.insert(0, reference),
            None => {
                object.insert("references".to_string(), Value::Array(vec![reference]));
            }
        }
        serde_json::to_string(&raw).ok()
    }
}

fn read_config(path: &Path) -> Option<LoadedConfig> {
    let mut source = std::fs::read_to_string(path).ok()?;
    json_strip_comments::strip(&mut source).ok()?;
    let raw = serde_json::from_str::<Value>(&source).ok()?;
    if !raw.is_object() {
        return None;
    }
    let directory = path.parent()?.to_path_buf();
    let extends = match raw.get("extends") {
        Some(Value::String(base)) => vec![base.clone()],
        Some(Value::Array(bases)) => {
            bases.iter().filter_map(Value::as_str).map(str::to_string).collect()
        }
        _ => Vec::new(),
    }
    .iter()
    .filter_map(|base| resolve_extends(&directory, base))
    .collect();
    let references = raw
        .get("references")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|reference| reference.get("path").and_then(Value::as_str))
        .map(|reference| {
            let target = normalize(&directory.join(reference));
            if target.extension().is_some_and(|extension| extension == "json") {
                target
            } else {
                target.join("tsconfig.json")
            }
        })
        .collect();
    Some(LoadedConfig { raw, directory, extends, references })
}

/// A relative or absolute `extends` resolves against the config's directory; a package specifier
/// against each ancestor's `node_modules`, the way TypeScript's own lookup does.
fn resolve_extends(directory: &Path, base: &str) -> Option<PathBuf> {
    let with_json = |path: PathBuf| {
        if path.is_file() {
            return Some(path);
        }
        let mut named = path.clone().into_os_string();
        named.push(".json");
        let named = PathBuf::from(named);
        if named.is_file() {
            return Some(named);
        }
        let nested = path.join("tsconfig.json");
        nested.is_file().then_some(nested)
    };
    if base.starts_with('.') || Path::new(base).is_absolute() {
        return with_json(normalize(&directory.join(base)));
    }
    directory.ancestors().find_map(|ancestor| with_json(ancestor.join("node_modules").join(base)))
}

/// TypeScript's matching for one `include` or `exclude` entry. An entry whose last component has
/// no `.`, `*`, or `?` names a directory, so it is widened to everything under it. An `exclude`
/// entry also matches every path below a directory it names.
fn spec_matches(base: &Path, spec: &str, candidate: &Path, exclude: bool) -> bool {
    let mut pattern = normalize(&base.join(spec)).to_string_lossy().replace('\\', "/");
    let last = pattern.rsplit('/').next().unwrap_or_default();
    if !last.contains(['.', '*', '?']) {
        pattern.push_str("/**/*");
    }
    let candidate = candidate.to_string_lossy().replace('\\', "/");
    // The literal directories in front of the first wildcard are compared as text, so a project
    // directory whose name holds a glob metacharacter is never read as a pattern.
    let base_end = base
        .ancestors()
        .map(|ancestor| ancestor.to_string_lossy().replace('\\', "/"))
        .find(|ancestor| {
            pattern.strip_prefix(ancestor.as_str()).is_some_and(|rest| rest.starts_with('/'))
        })
        .map_or(0, |ancestor| ancestor.len());
    let literal_end =
        pattern[base_end..].find(['*', '?', '[', '{']).map_or(pattern.len(), |wildcard| {
            pattern[..base_end + wildcard].rfind('/').unwrap_or(base_end)
        });
    let (literal, rest) = pattern.split_at(literal_end);
    let Some(remainder) = strip_path_prefix(&candidate, literal) else {
        return false;
    };
    if rest.is_empty() {
        return remainder.is_empty() || (exclude && remainder.starts_with('/'));
    }
    let (Some(rest), Some(remainder)) = (rest.strip_prefix('/'), remainder.strip_prefix('/'))
    else {
        return false;
    };
    let matcher = |glob: &str| {
        GlobBuilder::new(glob)
            .literal_separator(true)
            .case_insensitive(cfg!(any(windows, target_os = "macos")))
            .build()
            .is_ok_and(|glob| glob.compile_matcher().is_match(remainder))
    };
    matcher(rest) || (exclude && matcher(&format!("{rest}/**")))
}

fn strip_path_prefix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    if cfg!(any(windows, target_os = "macos")) {
        let head = path.get(..prefix.len())?;
        head.eq_ignore_ascii_case(prefix).then(|| &path[prefix.len()..])
    } else {
        path.strip_prefix(prefix)
    }
}

fn string_array(raw: &Value, key: &str) -> Option<Vec<String>> {
    raw.get(key)?
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
}

fn absolute(cwd: &Path, path: &Path) -> PathBuf {
    normalize(&if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) })
}

/// Resolves `.` and `..` lexically. tsgolint compares the paths it is sent as text and never
/// follows symlinks, so neither does this.
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(spec: &str, candidate: &str) -> bool {
        spec_matches(Path::new("/project"), spec, Path::new(candidate), false)
    }

    #[test]
    fn a_directory_entry_includes_everything_under_it() {
        assert!(matches("./src/", "/project/src/View.tsrx.tsx"));
        assert!(matches("src", "/project/src/deep/View.tsrx.tsx"));
        assert!(!matches("src", "/project/test/View.tsrx.tsx"));
        assert!(!matches("src", "/project/srcs/View.tsrx.tsx"));
    }

    #[test]
    fn wildcards_follow_typescript_segments() {
        assert!(matches("src/**/*", "/project/src/a/b/View.tsrx.tsx"));
        assert!(matches("src/*.tsx", "/project/src/View.tsrx.tsx"));
        assert!(!matches("src/*.tsx", "/project/src/nested/View.tsrx.tsx"));
        assert!(matches("**/*.tsrx", "/project/src/View.tsrx"));
        assert!(!matches("src/**/*.ts", "/project/src/View.tsrx.tsx"));
    }

    #[test]
    fn an_exclude_entry_covers_its_directory() {
        let base = Path::new("/project");
        assert!(spec_matches(base, "dist", Path::new("/project/dist/View.tsrx.tsx"), true));
        assert!(spec_matches(base, "src/legacy", Path::new("/project/src/legacy/a/V.tsx"), true));
        assert!(!spec_matches(base, "dist", Path::new("/project/src/View.tsrx.tsx"), true));
    }

    #[test]
    fn a_metacharacter_in_the_project_directory_is_literal() {
        let base = Path::new("/work/[app]");
        assert!(spec_matches(base, "src", Path::new("/work/[app]/src/View.tsrx.tsx"), false));
        assert!(!spec_matches(base, "src", Path::new("/work/a/src/View.tsrx.tsx"), false));
    }
}

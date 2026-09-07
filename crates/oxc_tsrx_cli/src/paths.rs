//! The two channels that carry a file list into a leaf without going through
//! `argv`, and the discovery walk that produces one.
//!
//! The drop-in `oxlint`/`oxfmt` commands discover `.tsrx` files in Node and hand
//! the list to these leaves. A list on the command line has two failure modes
//! that only show up on real repositories: it exceeds the host's argument limit
//! (`E2BIG` on macOS and Linux past about a megabyte, a 32 KiB command line on
//! Windows, which a few hundred paths reach), and it is only as good as the
//! walk that produced it. Discovery that skipped nothing but `node_modules`
//! handed a monorepo's gitignored worktree copies to the leaf by the hundred
//! thousand. So the walk lives here, on the same `ignore` crate canonical Oxlint
//! walks with, and the list travels in a file.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

/// Reads a newline-separated path list. Empty lines are skipped and a trailing
/// carriage return is trimmed, so a list written on Windows reads the same.
pub(crate) fn read_paths_file(path: &Path) -> Result<Vec<PathBuf>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("unable to read --paths-file {}: {error}", path.display()))?;
    Ok(content
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect())
}

fn is_tsrx(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension == "tsrx")
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    std::path::absolute(path).map_err(|error| format!("{}: {error}", path.display()))
}

/// Every `.tsrx` file under `roots`, absolute and sorted. A root that is a file
/// is kept as named, exactly as canonical Oxlint keeps a file it was pointed at.
/// A root that is a directory is walked with `.gitignore`, `.ignore`, and the
/// repository's exclude file honoured, whether or not a `.git` directory exists,
/// which is canonical Oxlint's behaviour too; `node_modules` and `.git` are
/// never entered.
pub(crate) fn discover_tsrx(roots: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let mut files = BTreeSet::new();
    let mut directories = Vec::new();
    for root in roots {
        let metadata = fs::metadata(root)
            .map_err(|error| format!("cannot discover under {}: {error}", root.display()))?;
        if metadata.is_dir() {
            directories.push(root.clone());
        } else if metadata.is_file() && is_tsrx(root) {
            files.insert(absolute(root)?);
        }
    }
    if let Some((first, rest)) = directories.split_first() {
        let mut builder = ignore::WalkBuilder::new(first);
        for directory in rest {
            builder.add(directory);
        }
        builder
            .hidden(false)
            .follow_links(false)
            .require_git(false)
            .git_ignore(true)
            .git_exclude(true)
            .git_global(true)
            .ignore(true)
            .filter_entry(|entry| {
                let name = entry.file_name();
                name != "node_modules" && name != ".git"
            });
        for entry in builder.build() {
            let entry = entry.map_err(|error| format!("discovery failed: {error}"))?;
            if entry.file_type().is_some_and(|kind| !kind.is_dir()) && is_tsrx(entry.path()) {
                files.insert(absolute(entry.path())?);
            }
        }
    }
    Ok(files.into_iter().collect())
}

/// The `--discover` mode shared by the leaves: print `{"files":[...]}` for the
/// roots named on the command line or in a `--paths-file`, and nothing else.
pub(crate) fn run_discover(arguments: &[String]) -> Result<String, String> {
    let mut roots = Vec::new();
    let mut iterator = arguments.iter();
    while let Some(argument) = iterator.next() {
        match argument.as_str() {
            "--discover" => {}
            "--paths-file" => {
                let path = iterator.next().ok_or("--paths-file requires a path")?;
                roots.extend(read_paths_file(Path::new(path))?);
            }
            value if value.starts_with("--paths-file=") => {
                roots
                    .extend(read_paths_file(Path::new(value.trim_start_matches("--paths-file=")))?);
            }
            value if value.starts_with('-') => {
                return Err(format!("--discover takes paths only, not {value}"));
            }
            value => roots.push(PathBuf::from(value)),
        }
    }
    if roots.is_empty() {
        return Err("--discover requires at least one path".to_string());
    }
    let files = discover_tsrx(&roots)?
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    serde_json::to_string(&serde_json::json!({ "files": files }))
        .map_err(|error| format!("unable to encode the discovery report: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf, sync::atomic::AtomicU32, sync::atomic::Ordering};

    use super::{discover_tsrx, read_paths_file, run_discover};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch() -> PathBuf {
        let directory = env::temp_dir().join(format!(
            "oxc-tsrx-paths-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_paths_file_lists_one_path_per_line_and_tolerates_windows_line_ends() {
        let directory = scratch();
        let list = directory.join("paths.txt");
        fs::write(&list, "src/a.tsrx\r\n\nsrc/b.tsrx\n").unwrap();
        assert_eq!(
            read_paths_file(&list).unwrap(),
            vec![PathBuf::from("src/a.tsrx"), PathBuf::from("src/b.tsrx")]
        );
        let missing = read_paths_file(&directory.join("absent.txt")).unwrap_err();
        assert!(missing.contains("--paths-file"), "{missing}");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn discovery_honours_gitignore_without_a_git_directory_and_keeps_named_files() {
        let directory = scratch();
        fs::create_dir_all(directory.join("src/deep")).unwrap();
        fs::create_dir_all(directory.join("ignored/copy")).unwrap();
        fs::create_dir_all(directory.join("node_modules/dep")).unwrap();
        fs::create_dir_all(directory.join(".hidden")).unwrap();
        fs::write(directory.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(directory.join("src/a.tsrx"), "").unwrap();
        fs::write(directory.join("src/deep/b.tsrx"), "").unwrap();
        fs::write(directory.join("src/c.ts"), "").unwrap();
        fs::write(directory.join("ignored/copy/d.tsrx"), "").unwrap();
        fs::write(directory.join("node_modules/dep/e.tsrx"), "").unwrap();
        fs::write(directory.join(".hidden/f.tsrx"), "").unwrap();

        let found = discover_tsrx(std::slice::from_ref(&directory)).unwrap();
        let relative = found
            .iter()
            .map(|path| {
                path.strip_prefix(std::path::absolute(&directory).unwrap())
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect::<Vec<_>>();
        assert_eq!(relative, vec![".hidden/f.tsrx", "src/a.tsrx", "src/deep/b.tsrx"]);

        // A file named outright is kept even though its directory is ignored.
        let named = discover_tsrx(&[directory.join("ignored/copy/d.tsrx")]).unwrap();
        assert_eq!(named.len(), 1);
        assert!(named[0].ends_with("d.tsrx"));

        let report = run_discover(&[
            "--discover".to_string(),
            directory.join("src").to_string_lossy().into_owned(),
        ])
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&report).unwrap();
        assert_eq!(parsed["files"].as_array().unwrap().len(), 2);
        fs::remove_dir_all(directory).unwrap();
    }
}

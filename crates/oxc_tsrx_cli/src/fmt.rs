//! The `oxc-tsrx-fmt` formatter. Selected by `argv[0]` or the `fmt` subcommand.

use std::{
    collections::HashSet,
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Instant,
};

use rayon::prelude::*;
use tsrx_format::{FormatOutput, FormatSession};

const HELP: &str = "\
OXC for TSRX formatter

Usage: oxc-tsrx-fmt [--write | --check | --list-different] [--threads=INT] PATH...
       oxc-tsrx-fmt [--config=PATH] --stdin-filepath=PATH

Mode options:
    --write                 Format and write explicit files (default for files)
    --check                 Report every checked file, then exit 1 if any differ
    --list-different        List only the paths that differ; never write
    --stdin-filepath=PATH   Read stdin, infer the source type, and print formatted source
    -c, --config=PATH       Use an explicit JSON/JSONC Oxfmt configuration
    --threads=INT           Worker count for explicit multi-file formatting
    --paths-file=PATH       Read more paths from PATH, one per line, so a list
                            larger than the host's argument limit still arrives
    --discover              Print {files:[...]}: every .tsrx file under the named
                            paths, walked with .gitignore honoured and node_modules
                            skipped, exactly as the drop-in oxfmt discovers them
    -h, --help              Show this help
    -V, --version           Show the package and canonical OXC revision

The current TSRX grammar slice supports @{, if/else, for/empty, switch/case/default,
try/pending/catch controls, dynamic JSX tags, and lowercase raw <style> elements.
CSS payload bytes are preserved rather than CSS-formatted. Every unsupported or malformed
custom form is reported against its own file, beside the results of the files that did
parse, and exits 2. --write stays all-or-nothing: no file is changed unless every
requested file formatted.
";

/// Canonical Oxfmt's own `--check` preamble, verdicts, and summary lines. They are reproduced
/// verbatim so a `.tsrx` batch reads exactly like an ordinary one and so the drop-in `oxfmt`
/// wrapper can merge the two halves into a single report.
const CHECK_PREAMBLE: &str = "Checking formatting...\n\n";
const ALL_CLEAR: &str = "All matched files use the correct format.";
const CHECK_FAILED: &str = "Error occurred when checking code style in the above files.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileMode {
    Write,
    Check,
    ListDifferent,
}

impl FileMode {
    const fn flag(self) -> &'static str {
        match self {
            Self::Write => "--write",
            Self::Check => "--check",
            Self::ListDifferent => "--list-different",
        }
    }
}

#[derive(Debug)]
struct Args {
    file_mode: FileMode,
    stdin_filepath: Option<PathBuf>,
    files: Vec<PathBuf>,
    threads: Option<usize>,
    config_path: Option<PathBuf>,
    config_base: Option<PathBuf>,
}

#[derive(Debug)]
struct FormattedFile {
    path: PathBuf,
    output: FormatOutput,
    duration_ms: u128,
}

/// One batch of explicit paths: the files that formatted and the ones that did not.
///
/// A file that cannot be read or projected is a per-file failure rather than an abort of the
/// whole batch. That is what canonical Oxfmt does: a source it cannot parse is reported *beside*
/// the results of the files that parsed, never instead of them, and the run exits 2 either way.
/// (`--write` is the one place this formatter goes further than canonical Oxfmt; see `run`.)
///
/// A failure therefore stays plain rendered text. Unlike the lint lane, nothing here needs to
/// tell a user's own syntax error apart from a tool failure, because canonical Oxfmt gives both
/// the same exit code and the same summary sentence.
#[derive(Debug, Default)]
struct FormatBatch {
    formatted: Vec<FormattedFile>,
    /// Each entry is the exact text that follows the `oxc-tsrx-fmt: ` prefix on stderr.
    failures: Vec<String>,
}

impl FormatBatch {
    fn considered(&self) -> usize {
        self.formatted.len() + self.failures.len()
    }

    fn changed(&self) -> impl Iterator<Item = &FormattedFile> {
        self.formatted.iter().filter(|file| file.output.changed)
    }

    /// `path (Nms)` per differing file, in the order the paths were given.
    fn changed_report_lines(&self) -> Vec<String> {
        self.changed()
            .map(|file| format!("{} ({}ms)", file.path.display(), file.duration_ms))
            .collect()
    }

    fn changed_paths(&self) -> Vec<String> {
        self.changed().map(|file| file.path.display().to_string()).collect()
    }
}

#[derive(Debug)]
struct StagedFile {
    path: PathBuf,
    backup: PathBuf,
    temporary: PathBuf,
}

#[expect(
    clippy::print_stderr,
    reason = "oxc-tsrx-fmt reports errors on stderr; the text and the exit code are the CLI's contract"
)]
pub fn run_cli(arguments: Vec<String>) -> ExitCode {
    match run(arguments.into_iter()) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("oxc-tsrx-fmt: {error}");
            ExitCode::from(2)
        }
    }
}

#[expect(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "oxc-tsrx-fmt's help text, report and warnings are the CLI's contract"
)]
fn run(arguments: impl Iterator<Item = String>) -> Result<u8, String> {
    let arguments = arguments.collect::<Vec<_>>();
    if arguments.iter().any(|argument| matches!(argument.as_str(), "-h" | "--help")) {
        print!("{HELP}");
        return Ok(0);
    }
    if arguments.iter().any(|argument| matches!(argument.as_str(), "-V" | "--version")) {
        println!("oxc-tsrx-fmt {} (OXC {})", env!("CARGO_PKG_VERSION"), tsrx_format::OXC_REVISION);
        return Ok(0);
    }
    if arguments.iter().any(|argument| argument == "--discover") {
        println!("{}", crate::paths::run_discover(&arguments)?);
        return Ok(0);
    }
    let args = parse_args(arguments.into_iter())?;
    let cwd =
        env::current_dir().map_err(|error| format!("unable to read current directory: {error}"))?;
    let session = FormatSession::new_with_config_base(
        &cwd,
        args.config_path.as_deref(),
        args.config_base.as_deref(),
    )?;
    if let Some(path) = args.stdin_filepath {
        return run_stdin(&session, &path);
    }

    let threads = args.threads.unwrap_or_else(rayon::current_num_threads);
    let started = Instant::now();
    let batch = format_files(&session, args.files, args.threads)?;
    let failed = !batch.failures.is_empty();
    // Canonical Oxfmt writes the files that parsed even when a sibling did not. This formatter
    // deliberately keeps the stronger all-or-nothing transaction instead, so a batch never lands
    // half formatted; `commit_all`'s staging, backups, and restores exist for it, and
    // `tests/native-format.test.mjs` pins it. Only the *report* changed: every file that failed
    // is now named, where the first failure used to abort before the rest were even looked at.
    if args.file_mode == FileMode::Write && !failed {
        commit_all(&batch.formatted)?;
    }
    let elapsed_ms = started.elapsed().as_millis();

    let report = match args.file_mode {
        FileMode::Check => check_report(
            &batch.changed_report_lines(),
            batch.considered(),
            elapsed_ms,
            threads,
            failed,
        ),
        FileMode::ListDifferent => batch.changed_paths().join("\n"),
        FileMode::Write if failed => String::new(),
        FileMode::Write => format!("{}\n", finished_line(elapsed_ms, batch.considered(), threads)),
    };
    io::stdout()
        .write_all(report.as_bytes())
        .and_then(|()| io::stdout().flush())
        .map_err(|error| format!("unable to write stdout: {error}"))?;

    if failed {
        // A failing `--check` truncates stdout without a trailing newline, so the diagnostic
        // block opens with the blank line that terminates it. Canonical Oxfmt's block opens the
        // same way, which is why its two streams read as one report in a terminal.
        eprintln!();
        for failure in &batch.failures {
            eprintln!("oxc-tsrx-fmt: {failure}");
        }
        eprintln!("{CHECK_FAILED}");
        return Ok(2);
    }
    Ok(match args.file_mode {
        FileMode::Write => 0,
        FileMode::Check | FileMode::ListDifferent => u8::from(batch.changed().next().is_some()),
    })
}

fn issues_verdict(count: usize) -> String {
    format!("Format issues found in above {count} files. Run without `--check` to fix.")
}

fn finished_line(elapsed_ms: u128, considered: usize, threads: usize) -> String {
    format!("Finished in {elapsed_ms}ms on {considered} files using {threads} threads.")
}

/// Render canonical Oxfmt's `--check` report.
///
/// The verdict and the `Finished in ...` count are one statement about one batch, so a run that
/// could not read every file stops after the file list rather than claiming an all-clear above a
/// failure or publishing a count that silently excludes it. That truncation is canonical Oxfmt's
/// own behaviour, verified against the pinned stock binary.
fn check_report(
    changed: &[String],
    considered: usize,
    elapsed_ms: u128,
    threads: usize,
    failed: bool,
) -> String {
    let mut report = String::from(CHECK_PREAMBLE);
    report.push_str(&changed.join("\n"));
    if failed {
        return report;
    }
    if !changed.is_empty() {
        report.push_str("\n\n");
    }
    let verdict =
        if changed.is_empty() { ALL_CLEAR.to_string() } else { issues_verdict(changed.len()) };
    report.push_str(&verdict);
    report.push('\n');
    report.push_str(&finished_line(elapsed_ms, considered, threads));
    report.push('\n');
    report
}

fn parse_args(mut arguments: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut file_mode = None;
    let mut stdin_filepath = None;
    let mut files = Vec::new();
    let mut threads = None;
    let mut config_path = None;
    let mut config_base = None;

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--write" => set_mode(&mut file_mode, FileMode::Write)?,
            "--check" => set_mode(&mut file_mode, FileMode::Check)?,
            "--list-different" => set_mode(&mut file_mode, FileMode::ListDifferent)?,
            "--stdin-filepath" => {
                let value = arguments.next().ok_or("--stdin-filepath requires a path")?;
                set_once_path(&mut stdin_filepath, value, "--stdin-filepath")?;
            }
            "--threads" => {
                let value = arguments.next().ok_or("--threads requires a value")?;
                set_threads(&mut threads, &value)?;
            }
            "--config" | "-c" => {
                let value = arguments.next().ok_or("--config requires a path")?;
                set_once_path(&mut config_path, value, "--config")?;
            }
            "--config-base" => {
                let value = arguments.next().ok_or("--config-base requires a path")?;
                set_once_path(&mut config_base, value, "--config-base")?;
            }
            "--paths-file" => {
                let value = arguments.next().ok_or("--paths-file requires a path")?;
                files.extend(crate::paths::read_paths_file(Path::new(&value))?);
            }
            "-h" | "--help" | "-V" | "--version" => unreachable!("handled before parsing"),
            value if value.starts_with("--stdin-filepath=") => {
                let path = value.trim_start_matches("--stdin-filepath=");
                if path.is_empty() {
                    return Err("--stdin-filepath requires a path".to_string());
                }
                set_once_path(&mut stdin_filepath, path.to_string(), "--stdin-filepath")?;
            }
            value if value.starts_with("--threads=") => {
                set_threads(&mut threads, value.trim_start_matches("--threads="))?;
            }
            value if value.starts_with("--config=") => {
                let path = value.trim_start_matches("--config=");
                if path.is_empty() {
                    return Err("--config requires a path".to_string());
                }
                set_once_path(&mut config_path, path.to_string(), "--config")?;
            }
            value if value.starts_with("--config-base=") => {
                let path = value.trim_start_matches("--config-base=");
                if path.is_empty() {
                    return Err("--config-base requires a path".to_string());
                }
                set_once_path(&mut config_base, path.to_string(), "--config-base")?;
            }
            value if value.starts_with("--paths-file=") => {
                files.extend(crate::paths::read_paths_file(Path::new(
                    value.trim_start_matches("--paths-file="),
                ))?);
            }
            value if value.starts_with('-') => {
                return Err(format!("unsupported option: {value}"));
            }
            value => files.push(PathBuf::from(value)),
        }
    }

    if stdin_filepath.is_some() {
        if !files.is_empty() {
            return Err("stdin mode cannot be combined with file paths".to_string());
        }
        if file_mode.is_some() {
            return Err("stdin mode cannot be combined with --write or --check".to_string());
        }
    } else if files.is_empty() {
        return Err("at least one explicit source file is required".to_string());
    }

    Ok(Args {
        file_mode: file_mode.unwrap_or(FileMode::Write),
        stdin_filepath,
        files,
        threads,
        config_path,
        config_base,
    })
}

fn set_mode(mode: &mut Option<FileMode>, value: FileMode) -> Result<(), String> {
    if let Some(current) = *mode
        && current != value
    {
        // Canonical Oxfmt rejects any two of `--write`, `--check`, and `--list-different`
        // together, naming both flags.
        return Err(format!(
            "{} cannot be used at the same time as {}",
            value.flag(),
            current.flag()
        ));
    }
    *mode = Some(value);
    Ok(())
}

fn set_once_path(target: &mut Option<PathBuf>, value: String, option: &str) -> Result<(), String> {
    if target.is_some() {
        return Err(format!("{option} may be specified only once"));
    }
    *target = Some(PathBuf::from(value));
    Ok(())
}

fn set_threads(target: &mut Option<usize>, value: &str) -> Result<(), String> {
    if target.is_some() {
        return Err("--threads may be specified only once".to_string());
    }
    let parsed = value.parse::<usize>().map_err(|_| format!("invalid --threads value: {value}"))?;
    if parsed == 0 {
        return Err("--threads must be at least 1".to_string());
    }
    *target = Some(parsed);
    Ok(())
}

fn run_stdin(session: &FormatSession, path: &Path) -> Result<u8, String> {
    let mut source = String::new();
    io::stdin()
        .read_to_string(&mut source)
        .map_err(|error| format!("unable to read stdin: {error}"))?;
    let output = session.format_text(path, &source)?;
    io::stdout()
        .write_all(output.code.as_bytes())
        .and_then(|()| io::stdout().flush())
        .map_err(|error| format!("unable to write stdout: {error}"))?;
    Ok(0)
}

fn validate_unique_paths(paths: &[PathBuf]) -> Result<(), String> {
    let mut seen = HashSet::with_capacity(paths.len());
    for path in paths {
        if !seen.insert(path) {
            return Err(format!("duplicate source path: {}", path.display()));
        }
    }
    Ok(())
}

fn format_files(
    session: &FormatSession,
    mut paths: Vec<PathBuf>,
    threads: Option<usize>,
) -> Result<FormatBatch, String> {
    paths.retain(|path| !session.should_ignore(path));
    validate_unique_paths(&paths)?;
    let operation = || {
        paths
            .into_par_iter()
            .map(|path| {
                let started = Instant::now();
                let source = fs::read_to_string(&path)
                    .map_err(|error| format!("unable to read {}: {error}", path.display()))?;
                let output = session
                    .format_text(&path, &source)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                Ok(FormattedFile { path, output, duration_ms: started.elapsed().as_millis() })
            })
            // A per-path `Result` collected into a `Vec` rather than into a `Result<Vec<_>>`:
            // the short-circuiting collect discarded every other file's work as soon as one
            // path failed. `into_par_iter` preserves argument order, so a failed path still
            // sits between the files it was named between.
            .collect::<Vec<Result<FormattedFile, String>>>()
    };

    let results = if let Some(threads) = threads {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .map_err(|error| format!("unable to build formatter thread pool: {error}"))?
            .install(operation)
    } else {
        operation()
    };

    let mut batch = FormatBatch::default();
    for result in results {
        match result {
            Ok(file) => batch.formatted.push(file),
            Err(failure) => batch.failures.push(failure),
        }
    }
    Ok(batch)
}

/// Stages every changed output next to its source, then swaps all originals through backups.
/// Any recoverable staging or rename error restores the original bytes before returning.
#[expect(
    clippy::print_stderr,
    reason = "a failed backup cleanup is warned about on stderr without failing the run"
)]
fn commit_all(files: &[FormattedFile]) -> Result<(), String> {
    let changed = files.iter().filter(|file| file.output.changed).collect::<Vec<_>>();
    if changed.is_empty() {
        return Ok(());
    }

    let mut staged = Vec::with_capacity(changed.len());
    for (index, file) in changed.iter().enumerate() {
        if fs::symlink_metadata(&file.path)
            .map_err(|error| format!("unable to inspect {}: {error}", file.path.display()))?
            .file_type()
            .is_symlink()
        {
            cleanup_staged(&staged);
            return Err(format!("refusing to replace symbolic link {}", file.path.display()));
        }
        match stage_file(file, index) {
            Ok(value) => staged.push(value),
            Err(error) => {
                cleanup_staged(&staged);
                return Err(error);
            }
        }
    }

    for (backed_up, item) in staged.iter().enumerate() {
        if let Err(error) = fs::rename(&item.path, &item.backup) {
            restore_backups(&staged[..backed_up]);
            cleanup_staged(&staged);
            return Err(format!("unable to stage original {}: {error}", item.path.display()));
        }
    }

    for (installed, item) in staged.iter().enumerate() {
        if let Err(error) = fs::rename(&item.temporary, &item.path) {
            for installed_item in &staged[..installed] {
                let _ = fs::remove_file(&installed_item.path);
            }
            restore_backups(&staged);
            cleanup_staged(&staged);
            return Err(format!("unable to install formatted {}: {error}", item.path.display()));
        }
    }

    for item in &staged {
        if let Err(error) = fs::remove_file(&item.backup) {
            eprintln!(
                "oxc-tsrx-fmt: warning: unable to remove backup {}: {error}",
                item.backup.display()
            );
        }
    }
    Ok(())
}

fn stage_file(file: &FormattedFile, index: usize) -> Result<StagedFile, String> {
    let parent = file.path.parent().unwrap_or_else(|| Path::new("."));
    let name =
        file.path.file_name().and_then(|name| name.to_str()).ok_or_else(|| {
            format!("source path has no UTF-8 file name: {}", file.path.display())
        })?;
    let identity = format!("{}-{index}", std::process::id());
    let temporary = parent.join(format!(".{name}.oxc-tsrx-{identity}.tmp"));
    let backup = parent.join(format!(".{name}.oxc-tsrx-{identity}.bak"));
    if temporary.exists() || backup.exists() {
        return Err(format!(
            "formatter transaction path already exists beside {}",
            file.path.display()
        ));
    }

    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("unable to stage {}: {error}", file.path.display()))?;
    let result = output
        .write_all(file.output.code.as_bytes())
        .and_then(|()| output.flush())
        .and_then(|()| {
            let permissions = fs::metadata(&file.path)?.permissions();
            fs::set_permissions(&temporary, permissions)
        });
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("unable to stage {}: {error}", file.path.display()));
    }

    Ok(StagedFile { path: file.path.clone(), backup, temporary })
}

fn restore_backups(items: &[StagedFile]) {
    for item in items.iter().rev() {
        let _ = fs::rename(&item.backup, &item.path);
    }
}

fn cleanup_staged(items: &[StagedFile]) {
    for item in items {
        let _ = fs::remove_file(&item.temporary);
        if item.backup.exists() && !item.path.exists() {
            let _ = fs::rename(&item.backup, &item.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf, sync::atomic::AtomicU32, sync::atomic::Ordering};

    use tsrx_format::FormatSession;

    use super::{FileMode, check_report, format_files, set_mode};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch_directory(label: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory =
            env::temp_dir().join(format!("oxc-tsrx-fmt-{label}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&directory).expect("scratch directory");
        directory
    }

    #[test]
    fn a_clean_check_reports_the_all_clear_and_the_full_count() {
        assert_eq!(
            check_report(&[], 3, 12, 4, false),
            "Checking formatting...\n\nAll matched files use the correct format.\n\
             Finished in 12ms on 3 files using 4 threads.\n"
        );
    }

    #[test]
    fn a_differing_check_reports_every_path_and_counts_every_file() {
        let changed = ["a.tsrx (0ms)".to_string(), "b.tsrx (1ms)".to_string()];
        assert_eq!(
            check_report(&changed, 3, 12, 4, false),
            "Checking formatting...\n\na.tsrx (0ms)\nb.tsrx (1ms)\n\n\
             Format issues found in above 2 files. Run without `--check` to fix.\n\
             Finished in 12ms on 3 files using 4 threads.\n"
        );
    }

    #[test]
    fn a_failed_check_never_prints_an_all_clear_or_a_count_above_the_failure() {
        // The verdict and the count are one statement about one batch. A run that could not
        // read every file stops after the file list instead of contradicting itself.
        let report = check_report(&["a.tsrx (0ms)".to_string()], 2, 12, 4, true);
        assert_eq!(report, "Checking formatting...\n\na.tsrx (0ms)");
        assert!(!report.contains("All matched files"));
        assert!(!report.contains("Finished in"));
        assert_eq!(check_report(&[], 1, 12, 4, true), "Checking formatting...\n\n");
    }

    #[test]
    fn one_unparseable_file_keeps_every_other_result_in_the_batch() {
        let directory = scratch_directory("batch");
        let clean = directory.join("Clean.tsrx");
        let dirty = directory.join("Dirty.tsrx");
        let broken = directory.join("Broken.tsrx");
        fs::write(&clean, "export function Clean() @{\n  <p>a</p>;\n}\n").expect("clean");
        fs::write(&dirty, "export function Dirty( ) @{\n     let x   = 1;\n}\n").expect("dirty");
        fs::write(&broken, "export function Broken() @{\n  <main>\n}\n").expect("broken");

        let session = FormatSession::new_with_config_base(&directory, None, None).expect("session");
        let batch =
            format_files(&session, vec![clean.clone(), broken.clone(), dirty.clone()], Some(1))
                .expect("batch");

        assert_eq!(batch.failures.len(), 1, "{:?}", batch.failures);
        assert!(
            batch.failures[0].starts_with(&format!("{}: ", broken.display())),
            "{}",
            batch.failures[0]
        );
        assert_eq!(batch.considered(), 3);
        // Argument order survives, so the failed path still sits between its neighbours.
        assert_eq!(
            batch.formatted.iter().map(|file| file.path.clone()).collect::<Vec<_>>(),
            vec![clean, dirty.clone()]
        );
        assert_eq!(batch.changed_paths(), vec![dirty.display().to_string()]);

        fs::remove_dir_all(&directory).expect("cleanup");
    }

    #[test]
    fn two_file_modes_are_rejected_by_name() {
        let mut mode = None;
        set_mode(&mut mode, FileMode::Check).expect("first mode");
        assert_eq!(
            set_mode(&mut mode, FileMode::ListDifferent),
            Err("--list-different cannot be used at the same time as --check".to_string())
        );
        // Repeating the same flag stays accepted, as it was before the modes were split.
        assert_eq!(set_mode(&mut mode, FileMode::Check), Ok(()));
    }
}

//! The `oxc-tsrx` linter. Selected by default, or by the `lint` subcommand.

use std::{
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

use oxc_adapter::OXC_REVISION;
use serde_json::{Map, Value, json};
use tsrx_lint::{ConfigRuleFilter, ConfigRuleSeverity, LintSession, PluginLabel, PluginProjection};

const HELP: &str = "\
OXC for TSRX linter

Usage: oxc-tsrx-lint [--fix] [--format=json] [-D RULE] PATH...
       oxc-tsrx-lint --discover PATH...

Options:
    --fix                   Apply the safe fixes and write the changed files
    -A, --allow RULE        Report RULE at the allow severity
    -W, --warn RULE         Report RULE at the warn severity
    -D, --deny RULE         Report RULE at the deny severity
    -c, --config PATH       Use an explicit JSON/JSONC Oxlint configuration
    --type-aware            Enable the type-aware rules
    --type-check            Enable the type-aware rules and type checking
    --format json           Output format; json is the only value, and the default
    --paths-file PATH       Read more paths from PATH, one per line, so a list
                            larger than the host's argument limit still arrives
    --discover              Print {files:[...]}: every .tsrx file under the named
                            paths, walked with .gitignore honoured and node_modules
                            skipped, exactly as the drop-in oxlint discovers them
    -h, --help              Show this help
    -V, --version           Show the package and canonical OXC revision

JavaScript plugin lane (driven by the `oxlint` command, not by hand):
    --emit-plugin-projection    Print {projections:[{path,projected}]}: the legal
                                TSX projection of each named .tsrx file, which is
                                what the published Oxlint binary hosts JS plugins
                                over. Honours the same ignore rules as a lint run
    --map-plugin-diagnostics    Read {files:[{path,diagnostics}]} on stdin and
                                print it back with every label span moved from
                                projection bytes to authored bytes. A label
                                running to the end of the projected source is a
                                whole-file report and maps to the authored file
                                from the first authored byte it covers, however
                                much trivia precedes it. Any other diagnostic
                                whose labels do not all map is dropped, because a
                                position the user did not write is worse than no
                                diagnostic, and each file carries an `unmapped`
                                count of how many were dropped so the loss is
                                never silent

This is the internal capability target the oxc.provider metadata names for
linting .tsrx files. It takes explicit file paths only, never a directory or a
glob, and always prints one JSON report to stdout. Run `oxlint` instead for the
drop-in command a project installs: it discovers files, honours ignore files,
prints human-readable diagnostics, and covers .tsrx and ordinary files in one
run.
";

/// Print the legal-TSX projection of each authored `.tsrx` path.
const EMIT_PLUGIN_PROJECTION: &str = "--emit-plugin-projection";
/// Move Oxlint's plugin diagnostics from projection bytes back to authored bytes.
const MAP_PLUGIN_DIAGNOSTICS: &str = "--map-plugin-diagnostics";

#[expect(
    clippy::print_stderr,
    reason = "oxc-tsrx reports errors on stderr; the text and the exit code are the CLI's contract"
)]
pub fn run_cli(arguments: Vec<String>) -> ExitCode {
    match run(arguments.into_iter()) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("oxc-tsrx: {error}");
            ExitCode::from(2)
        }
    }
}

#[expect(
    clippy::print_stdout,
    reason = "oxc-tsrx's help text and diagnostic report are the CLI's contract"
)]
fn run(arguments: impl Iterator<Item = String>) -> Result<u8, String> {
    let arguments = arguments.collect::<Vec<_>>();
    if arguments.iter().any(|argument| matches!(argument.as_str(), "-h" | "--help")) {
        print!("{HELP}");
        return Ok(0);
    }
    if arguments.iter().any(|argument| matches!(argument.as_str(), "-V" | "--version")) {
        println!("oxc-tsrx {} (OXC {OXC_REVISION})", env!("CARGO_PKG_VERSION"));
        return Ok(0);
    }
    // The mapping mode needs no configuration and no positional file: every path it touches
    // arrives in the stdin request, so it is answered before argument parsing.
    if arguments.iter().any(|argument| argument == MAP_PLUGIN_DIAGNOSTICS) {
        return map_plugin_diagnostics();
    }
    // Discovery answers before parsing too: it takes paths and a paths file and nothing else.
    if arguments.iter().any(|argument| argument == "--discover") {
        println!("{}", crate::paths::run_discover(&arguments)?);
        return Ok(0);
    }
    // The projection flag is answered after parsing, but the parser has never heard of it, so it
    // is filtered out on the way in rather than taught as an option that takes no value.
    let emit_projection = arguments.iter().any(|argument| argument == EMIT_PLUGIN_PROJECTION);
    let ParsedArguments { filters, files, fix, config_path, config_base, type_aware, type_check } =
        parse_arguments(
            arguments.into_iter().filter(|argument| argument != EMIT_PLUGIN_PROJECTION),
        )?;

    let cwd =
        env::current_dir().map_err(|error| format!("unable to read current directory: {error}"))?;
    // The projection mode builds a session for one thing only: the config's ignore rules, so the
    // JavaScript plugin lane sees exactly the files a lint run would have reported on. It
    // evaluates no rule and prints no diagnostic, so the type-aware opt-in gate the engine
    // applies to a real run has nothing to protect here. Leaving the gate in front of it is what
    // made a stock `vp create` scaffold unlintable: that scaffold writes
    // `lint.options.typeAware`, the resolved Vite+ config carries it into the config this mode
    // loads, and the refusal came back as a hard failure that took the whole batch down before a
    // single `.tsrx` file was projected. The type-aware lane itself is unaffected: it is still
    // started only by `--type-aware`/`--type-check` on a run that actually lints, which is where
    // `reject_unavailable_lint_capabilities` still stands.
    let session = if type_aware || emit_projection {
        LintSession::new_type_aware_with_config_base(
            &cwd,
            config_path.as_deref(),
            config_base.as_deref(),
            &filters,
            fix,
            type_check,
        )?
    } else {
        LintSession::new_with_config_base(
            &cwd,
            config_path.as_deref(),
            config_base.as_deref(),
            &filters,
            fix,
        )?
    };
    let files = files
        .into_iter()
        .map(|path| if path.is_absolute() { path } else { cwd.join(path) })
        .filter(|path| !session.should_ignore(path))
        .collect::<Vec<_>>();
    // The projection mode reuses everything above it so the plugin lane sees exactly the files a
    // lint run would have reported on: the same config, the same ignore rules, the same order.
    if emit_projection {
        return emit_plugin_projection(&files);
    }
    let output = session.aggregate(session.lint_files(&files)?);
    let errors =
        output.diagnostics.iter().filter(|diagnostic| diagnostic.severity == "error").count();
    let warnings =
        output.diagnostics.iter().filter(|diagnostic| diagnostic.severity == "warning").count();
    println!(
        "{}",
        serde_json::to_string(&output).map_err(|error| format!("JSON output failed: {error}"))?
    );
    let warnings_fail = session.deny_warnings() && warnings > 0;
    let max_warnings_fail = session.max_warnings().is_some_and(|maximum| warnings > maximum);
    Ok(u8::from(errors > 0 || warnings_fail || max_warnings_fail))
}

/// Print the legal-TSX projection of every named `.tsrx` file.
///
/// This is the only way the projection text leaves the native process. The published Oxlint binary
/// lints these strings so a user's JavaScript rules see a source OXC can parse, and the offsets
/// they report come back through [`map_plugin_diagnostics`].
///
/// A file that cannot be scanned or projected is omitted rather than failing the command: the
/// ordinary lint lane already reports that syntax error as the file's own diagnostic, and a plugin
/// has nothing to say about a source that does not parse.
fn emit_plugin_projection(files: &[PathBuf]) -> Result<u8, String> {
    let mut projections = Vec::new();
    for path in files {
        if path.extension().is_none_or(|extension| extension != "tsrx") {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(projection) = PluginProjection::new(&source) else {
            continue;
        };
        projections.push(json!({
            "path": path.to_string_lossy(),
            "projected": projection.source(),
        }));
    }
    print_json(&json!({ "projections": projections }))
}

/// Move Oxlint's plugin diagnostics from projection bytes back to the bytes the user wrote.
///
/// The request is `{files:[{path, diagnostics:[...]}]}`, where each diagnostic is Oxlint's own JSON
/// passed through untouched apart from its label spans. Every field this process does not
/// understand survives, so the rule's message, code, severity, and help stay exactly as Oxlint
/// wrote them.
fn map_plugin_diagnostics() -> Result<u8, String> {
    let mut request = String::new();
    std::io::stdin()
        .read_to_string(&mut request)
        .map_err(|error| format!("unable to read the plugin diagnostic request: {error}"))?;
    let request: Value = serde_json::from_str(&request)
        .map_err(|error| format!("invalid plugin diagnostic request: {error}"))?;
    let files = request
        .get("files")
        .and_then(Value::as_array)
        .ok_or("plugin diagnostic request needs a files array")?;

    let mut mapped_files = Vec::with_capacity(files.len());
    for file in files {
        let path = file
            .get("path")
            .and_then(Value::as_str)
            .ok_or("every plugin diagnostic file needs a path")?;
        let diagnostics =
            file.get("diagnostics").and_then(Value::as_array).map_or_else(Vec::new, Clone::clone);
        let requested = diagnostics.len();
        let mapped = map_file_diagnostics(Path::new(path), diagnostics);
        mapped_files.push(json!({
            "path": path,
            "diagnostics": mapped,
            // What the projection could not place. A dropped diagnostic is invisible to the
            // developer by design, so the count of them is part of this mode's answer rather than
            // something a caller has to infer by comparing lengths.
            "unmapped": requested.saturating_sub(mapped.len()),
        }));
    }
    print_json(&json!({ "files": mapped_files }))
}

/// Map one file's diagnostics, dropping the file's whole contribution when it cannot be projected.
fn map_file_diagnostics(path: &Path, diagnostics: Vec<Value>) -> Vec<Value> {
    let Ok(source) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(projection) = PluginProjection::new(&source) else {
        return Vec::new();
    };
    let Ok(authored_length) = u32::try_from(source.len()) else {
        return Vec::new();
    };
    diagnostics
        .into_iter()
        .filter_map(|diagnostic| map_one_diagnostic(&projection, authored_length, diagnostic))
        .collect()
}

fn map_one_diagnostic(
    projection: &PluginProjection,
    authored_length: u32,
    mut diagnostic: Value,
) -> Option<Value> {
    let object = diagnostic.as_object_mut()?;
    let labels = object.get("labels")?.as_array()?.clone();
    let spans = labels.iter().map(label_span).collect::<Option<Vec<_>>>()?;
    // A diagnostic with no labels points at nothing, and mapping an empty list
    // succeeds vacuously, so the emptiness is rejected here rather than left to
    // the per-label mapping below.
    if spans.is_empty() {
        return None;
    }
    let authored = spans
        .iter()
        .map(|span| map_label(projection, authored_length, *span))
        .collect::<Option<Vec<_>>>()?;

    let mut mapped_labels = Vec::with_capacity(labels.len());
    for (label, span) in labels.into_iter().zip(&authored) {
        let mut label = label;
        let entry = label.as_object_mut()?;
        let mut mapped_span = Map::new();
        mapped_span.insert("offset".to_string(), json!(span.offset));
        mapped_span.insert("length".to_string(), json!(span.length));
        // Oxlint resolved `line` and `column` against the projection. Dropping them is what makes
        // the wrapper recompute both from the authored `.tsrx` file itself.
        if let Some(Value::Object(original)) = entry.get("span") {
            for (key, value) in original {
                if !matches!(key.as_str(), "offset" | "length" | "line" | "column") {
                    mapped_span.insert(key.clone(), value.clone());
                }
            }
        }
        entry.insert("span".to_string(), Value::Object(mapped_span));
        mapped_labels.push(label);
    }
    object.insert("labels".to_string(), Value::Array(mapped_labels));
    // Related spans carry projection offsets this mode does not map. Shipping them unmapped would
    // point a user at a position in a file they never wrote, so they are dropped instead.
    if object.get("related").and_then(Value::as_array).is_some_and(|related| !related.is_empty()) {
        object.remove("related");
    }
    Some(diagnostic)
}

/// Move one label from projection bytes to authored bytes.
///
/// Every label goes through [`PluginProjection::map_labels`] first, which is the same
/// all-or-nothing rejection the native lane applies: a label that lies inside one stretch of
/// copied text keeps its exact authored position.
///
/// That rejection gets one shape wrong. A rule that reports on the whole `Program` gets a span
/// covering everything Oxlint linted, and what Oxlint linted for a `.tsrx` file is the projection,
/// markers and synthetic wrappers included. That range can never lie inside one authored segment,
/// so such a rule used to fire on an ordinary `.tsx` and vanish without a trace on the
/// byte-identical `.tsrx`. The earlier attempt at this recognised the shape by
/// `label.offset == 0`, which a `Program` only satisfies in a file with no leading trivia: one
/// blank line, comment, or `// @ts-nocheck` above the first token put the whole report back in the
/// bin. [`PluginProjection::map_whole_file_label`] uses the projection's own copied-byte bounds
/// instead, so leading trivia cannot hide the shape, and a report that covers no authored bytes at
/// all is still dropped.
pub(crate) fn map_label(
    projection: &PluginProjection,
    authored_length: u32,
    label: PluginLabel,
) -> Option<PluginLabel> {
    projection
        .map_labels(&[label])
        .and_then(|mut mapped| mapped.pop())
        .or_else(|| projection.map_whole_file_label(label, authored_length))
}

fn label_span(label: &Value) -> Option<PluginLabel> {
    let span = label.get("span")?;
    Some(PluginLabel {
        offset: u32::try_from(span.get("offset")?.as_u64()?).ok()?,
        length: u32::try_from(span.get("length")?.as_u64().unwrap_or(0)).ok()?,
    })
}

fn print_json(value: &Value) -> Result<u8, String> {
    let rendered =
        serde_json::to_string(value).map_err(|error| format!("JSON output failed: {error}"))?;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{rendered}").map_err(|error| format!("JSON output failed: {error}"))?;
    Ok(0)
}

struct ParsedArguments {
    filters: Vec<ConfigRuleFilter>,
    files: Vec<PathBuf>,
    fix: bool,
    config_path: Option<PathBuf>,
    config_base: Option<PathBuf>,
    type_aware: bool,
    type_check: bool,
}

fn parse_arguments(mut arguments: impl Iterator<Item = String>) -> Result<ParsedArguments, String> {
    let mut filters = Vec::new();
    let mut files = Vec::new();
    let mut fix = false;
    let mut config_path = None;
    let mut config_base = None;
    let mut type_aware = false;
    let mut type_check = false;

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--format=json" => {}
            "--format" => {
                let format = arguments.next().ok_or("--format requires a value")?;
                if format != "json" {
                    return Err("the current native CLI supports --format=json only".to_string());
                }
            }
            "--allow" | "-A" => filters.push(ConfigRuleFilter {
                severity: ConfigRuleSeverity::Allow,
                name: arguments.next().ok_or("--allow requires a rule")?,
            }),
            "--warn" | "-W" => filters.push(ConfigRuleFilter {
                severity: ConfigRuleSeverity::Warn,
                name: arguments.next().ok_or("--warn requires a rule")?,
            }),
            "--deny" | "-D" => filters.push(ConfigRuleFilter {
                severity: ConfigRuleSeverity::Deny,
                name: arguments.next().ok_or("--deny requires a rule")?,
            }),
            "--config" | "-c" => {
                if config_path.is_some() {
                    return Err("--config may be specified only once".to_string());
                }
                config_path =
                    Some(PathBuf::from(arguments.next().ok_or("--config requires a path")?));
            }
            "--config-base" => {
                if config_base.is_some() {
                    return Err("--config-base may be specified only once".to_string());
                }
                config_base =
                    Some(PathBuf::from(arguments.next().ok_or("--config-base requires a path")?));
            }
            "--fix" => fix = true,
            "--paths-file" => {
                let path = arguments.next().ok_or("--paths-file requires a path")?;
                files.extend(crate::paths::read_paths_file(Path::new(&path))?);
            }
            "--type-aware" => type_aware = true,
            "--type-check" => {
                type_aware = true;
                type_check = true;
            }
            "-h" | "--help" | "-V" | "--version" => unreachable!("handled before parsing"),
            value if value.starts_with("--paths-file=") => {
                files.extend(crate::paths::read_paths_file(Path::new(
                    value.trim_start_matches("--paths-file="),
                ))?);
            }
            value if value.starts_with('-') => {
                return Err(format!("unsupported option in the current native CLI: {value}"));
            }
            value => files.push(PathBuf::from(value)),
        }
    }

    if files.is_empty() {
        return Err("at least one explicit source file is required".to_string());
    }

    Ok(ParsedArguments { filters, files, fix, config_path, config_base, type_aware, type_check })
}

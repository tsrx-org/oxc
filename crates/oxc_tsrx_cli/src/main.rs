//! One executable, three tools.
//!
//! `oxc-tsrx`, `oxc-tsrx-fmt`, and `oxc-tsrx-lsp` were three separate release
//! binaries built from this crate. Each statically linked essentially the same
//! oxc parser, linter, and formatter, so a platform package carried the same
//! code three times. They are now one multi-call executable in the busybox
//! style, and the per-tool logic in [`fmt`], [`lint`], and [`lsp`] is unchanged.
//!
//! A tool is selected two ways, and both must keep working:
//!
//! * **`argv[0]`.** Invoked through any path whose file stem is `oxc-tsrx-fmt`
//!   or `oxc-tsrx-lsp` — a `node_modules/.bin` symlink, a copy under the old
//!   name, a VSIX-embedded server — the matching tool runs and the remaining
//!   arguments are passed through exactly as the old binary saw them.
//! * **A leading subcommand.** `oxc-tsrx fmt ...`, `oxc-tsrx lsp ...`, and
//!   `oxc-tsrx lint ...` select the tool explicitly. This is the form the npm
//!   launchers use, because `argv[0]` is not dependable everywhere: Windows
//!   `.cmd` shims and anything that resolves a symlink before exec both hand
//!   this process its real file name.
//!
//! `argv[0]` wins when it names a tool, and no subcommand is stripped in that
//! case, so `oxc-tsrx-fmt fmt` still treats `fmt` as a path exactly as before.
//! With no tool in `argv[0]` and no leading subcommand the linter runs, which
//! keeps `oxc-tsrx FILE...` byte-identical to the old lint-only binary.

mod fmt;
mod lint;
mod lsp;
mod paths;

use std::{env, path::Path, process::ExitCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    Lint,
    Format,
    Server,
}

impl Tool {
    /// The tool an old binary name selects, or `None` for anything else.
    fn from_program_name(program: &str) -> Option<Self> {
        match program {
            "oxc-tsrx-fmt" => Some(Self::Format),
            "oxc-tsrx-lsp" => Some(Self::Server),
            _ => None,
        }
    }

    /// The tool an explicit leading subcommand selects, or `None`.
    fn from_subcommand(argument: &str) -> Option<Self> {
        match argument {
            "lint" => Some(Self::Lint),
            "fmt" => Some(Self::Format),
            "lsp" => Some(Self::Server),
            _ => None,
        }
    }

    fn run(self, arguments: Vec<String>) -> ExitCode {
        match self {
            Self::Lint => lint::run_cli(arguments),
            Self::Format => fmt::run_cli(arguments),
            Self::Server => lsp::run_cli(&arguments),
        }
    }
}

/// The file stem of `argv[0]`, with any executable suffix removed.
fn program_name(argv0: Option<String>) -> Option<String> {
    let argv0 = argv0?;
    let path = Path::new(&argv0);
    let stem = path.file_stem().or_else(|| path.file_name())?;
    Some(stem.to_string_lossy().into_owned())
}

fn main() -> ExitCode {
    let mut raw = env::args();
    let program = program_name(raw.next());
    let arguments = raw.collect::<Vec<_>>();

    if let Some(tool) = program.as_deref().and_then(Tool::from_program_name) {
        return tool.run(arguments);
    }
    if let Some((first, rest)) = arguments.split_first()
        && let Some(tool) = Tool::from_subcommand(first)
    {
        return tool.run(rest.to_vec());
    }
    Tool::Lint.run(arguments)
}

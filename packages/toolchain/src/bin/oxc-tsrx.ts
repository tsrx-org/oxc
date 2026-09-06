#!/usr/bin/env node

function usage() {
  return `oxc-tsrx

Usage:
  oxc-tsrx providers [--project <directory>] [--json]
  oxc-tsrx setup [--project <directory>] [--dry-run] [--write-tsconfig]
                 [--workspace-root <directory>] [--json]
  oxc-tsrx status [--project <directory>] [--json]
  oxc-tsrx remove [--project <directory>] [--dry-run] [--json]

providers reports the OXC language providers the project root's direct
dependencies declare through their static oxc.provider metadata. It reads
package manifests only: it writes nothing, mutates no node_modules directory,
and imports, requires, or spawns no dependency. It exits non-zero when a
provider claims a reserved extension or when two providers collide.

setup, status, and remove are the temporary compatibility bridge for consumers
whose resolver is not provider-aware yet. The bridge creates the exact
oxc-parser, oxlint, and oxfmt package-name facades those consumers need, and one
fourth slot for the editor. Transitive official packages in those exact slots are
preserved and restored; direct or unrecognized packages are never replaced. An
official oxlint or oxfmt you declare yourself keeps its slot and its command
name (reported as a collision, with what that means); setup still writes the
editor slot so the official OXC extension serves .tsrx through this package.

The editor slot is the one thing setup writes outside node_modules. When
node_modules/.bin/oxlint belongs to another tool, the official OXC extension
finds that tool and serves no .tsrx diagnostics, so setup merges the single key
"oxc.path.oxlint" into your .vscode/settings.json. Everything else in that file
is preserved, an existing "oxc.path.oxlint" is reported rather than overwritten,
and remove takes back only that key. It never edits package.json, and it never
edits tsconfig.json unless you ask.

VS Code reads .vscode/settings.json only from the folder you open as the
workspace root, never from a subfolder of it, and setup writes at your project
root, meaning the nearest package.json. In a monorepo those are different
folders, so setup and status name every folder above your project root that
looks like a workspace root, and the file that made each one look like one,
rather than quietly writing a key nothing reads.

--workspace-root <directory> is the only way to write above your project root,
and it is never implied. The value is written relative to the folder you name.
Note that a multi-root window resolves a relative "oxc.path.oxlint" against its
first folder, not against the folder holding the settings file.

setup also reports the TSRX editor prerequisites it deliberately does not own:
@tsrx/typescript-plugin, a framework binding, the tsconfig.json plugins entry,
and a TypeScript version the plugin supports. It installs none of them.

--write-tsconfig is the one exception, and it is opt-in for that reason. It adds
"plugins": [{ "name": "@tsrx/typescript-plugin" }] under compilerOptions in the
tsconfig that owns your source, keeping every comment and every other byte in
the file. A solution-style root is skipped in favour of the referenced project
that includes your source, and an existing "plugins" list is reported rather
than appended to. Without the flag, setup only tells you the entry is missing.
`;
}

// `--help` and `--version` are the first two flags anyone tries, and they are
// not subcommands, so reaching the subcommand switch reported them as unknown
// commands and exited 2. Accept them wherever they appear, exactly like the
// `oxc-tsrx-fmt` and `oxc-tsrx-lsp` leaves already do.
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-V"]);

function parseArguments(argv) {
  const [first = "help", ...rest] = argv;
  const command = HELP_FLAGS.has(first)
    ? "help"
    : VERSION_FLAGS.has(first)
      ? "version"
      : first;
  const options: any = { command, projectRoot: undefined, dryRun: false, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--project") {
      options.projectRoot = rest[++index];
      if (!options.projectRoot) throw new Error("--project requires a directory");
    } else if (argument.startsWith("--project=")) {
      options.projectRoot = argument.slice("--project=".length);
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--write-tsconfig") {
      options.writeTsconfig = true;
    } else if (argument === "--workspace-root") {
      options.workspaceRoot = rest[++index];
      if (!options.workspaceRoot) throw new Error("--workspace-root requires a directory");
    } else if (argument.startsWith("--workspace-root=")) {
      options.workspaceRoot = argument.slice("--workspace-root=".length);
      if (!options.workspaceRoot) throw new Error("--workspace-root requires a directory");
    } else if (argument === "--json") {
      options.json = true;
    } else if (HELP_FLAGS.has(argument)) {
      options.command = "help";
    } else if (VERSION_FLAGS.has(argument)) {
      options.command = "version";
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

function printResult(result, json, format) {
  process.stdout.write(
    json ? `${JSON.stringify(result, null, 2)}\n` : format(result),
  );
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(usage());
  } else if (options.command === "version") {
    // `<command> <version>`, the shape the native `oxc-tsrx-fmt` and
    // `oxc-tsrx-lint` leaves already print. Read from this package's own
    // manifest so it can never drift from what is installed.
    const { createRequire } = await import("node:module");
    const manifest = createRequire(import.meta.url)("../../package.json");
    process.stdout.write(`oxc-tsrx ${manifest.version}\n`);
  } else if (options.command === "providers") {
    const { collectProviderReport, formatProviderReport } = await import(
      "../providers-report.js"
    );
    const report = await collectProviderReport(options);
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : formatProviderReport(report),
    );
    if (!report.ok) process.exitCode = 1;
  } else {
    const {
      compatibilityStatus,
      formatCompatibilityReport,
      removeCompatibility,
      setupCompatibility,
    } = await import("../compat.js");
    if (options.command === "setup" || options.command === "activate") {
      printResult(await setupCompatibility(options), options.json, formatCompatibilityReport);
    } else if (options.command === "status") {
      printResult(await compatibilityStatus(options), options.json, formatCompatibilityReport);
    } else if (options.command === "remove" || options.command === "deactivate") {
      printResult(await removeCompatibility(options), options.json, formatCompatibilityReport);
    } else {
      throw new Error(`unknown command: ${options.command}\n\n${usage()}`);
    }
  }
} catch (error) {
  console.error(`oxc-tsrx: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}

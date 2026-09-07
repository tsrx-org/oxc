---
title: CLI Reference
description: Every flag the @tsrx/oxc CLI accepts (oxc-tsrx and oxc-tsrx-fmt), with exit codes and environment variables.
---

# CLI Reference

## Build a command

Pick a command, tick what you want, and copy the line. Every flag here is a real
flag, and the sentence underneath says what that combination does.

<!-- cli-builder -->

At least one file is required, and files matching your `ignorePatterns` are
skipped. Calling a native binary directly means explicit file paths only:
directory walking and glob expansion belong to the `@tsrx/oxc` npm commands and
to Vite+. An unsupported option is an error, never an ignored flag.

## What a plain install puts on your path

`npm install --save-dev @tsrx/oxc@latest` is the whole setup for the command line
and for the editor. Vite+ needs one more command; see
[the minimum steps per host](/guide/getting-started#the-minimum-steps-per-host).
The install links seven commands into `node_modules/.bin`:

| Command | Kind | What it is |
| --- | --- | --- |
| `oxlint` | you type it | The linter. Sends `.tsrx` to the TSRX engine and everything else to official Oxlint. |
| `oxfmt` | you type it | The formatter, with the same split. |
| `oxc-tsrx` | you type it | `providers`, `status`, `setup`, `remove`. Described in the next section. |
| `oxc-tsrx-lint` | leaf executor | The native linter, given explicit files, a `--paths-file`, or `--discover PATH...` to list the `.tsrx` files under a path with `.gitignore` honoured. `oxlint` dispatches to it. It prints JSON. |
| `oxc-tsrx-fmt` | leaf executor | The native formatter. `oxfmt` dispatches to it. `--help` works here. |
| `oxc-tsrx-lsp` | leaf executor | The native language server. Editors launch it through `oxlint --lsp`. |
| `tsgolint` | not this project | It arrives with the `oxlint-tsgolint` dependency, the official type-aware runner used by `--type-aware` and `--type-check`. You never call it directly, and calling it prints upstream's own "unsupported entrypoint" warning. |

Reach for a leaf executor directly only when your project pins official `oxlint`
or `oxfmt`, because those command names then belong to the pinned package. Note
that the `oxc-tsrx` sections further down describe the **native binary** of the
same name, which comes from a source build. It is a different program from the
`oxc-tsrx` npm command above.

### `npx oxlint` with no path also lints `node_modules`

A bare `npx oxlint` walks the current directory, `node_modules` included, and so
does `--fix`, which will rewrite files in there. In a scratch `npm init -y`
project that was 9260 warnings, 9257 of them from `node_modules`.

Name a path (`npx oxlint src`) or list `node_modules` in a `.gitignore`. `oxfmt`
is unaffected: it skips `node_modules` unless you pass `--with-node-modules`.
Official Oxlint behaves identically, so this is upstream behavior.

## `oxc-tsrx` (npm command)

```text
Usage: oxc-tsrx providers [--project <directory>] [--json]
       oxc-tsrx setup     [--project <directory>] [--dry-run] [--write-tsconfig]
                          [--workspace-root <directory>] [--json]
       oxc-tsrx status    [--project <directory>] [--json]
       oxc-tsrx remove    [--project <directory>] [--dry-run] [--json]
```

| Subcommand | What it does |
| --- | --- |
| `providers` | Reads the `oxc.provider` block of your direct dependencies and prints the index. It writes nothing and spawns nothing. `routed extensions: .tsrx -> oxc-tsrx` is the line that proves your install works. |
| `setup` | Writes the project-local `oxlint`, `oxfmt`, and `oxc-parser` facades that Vite+ resolves, plus the editor slot below. Vite+ needs it, and so does a project that declares the official `oxlint` or `oxfmt` package directly: that package keeps its slot and its command (reported as `collision`), and `setup` still writes the editor slot so the official OXC extension serves `.tsrx`. |
| `status` | Reports whether those four slots are present, and for the editor slot whether your editor would really read the key. |
| `remove` | Removes them and restores any transitive official package it displaced. |

Running it with no subcommand prints the usage block, and so do `--help`, `-h`,
and `help`. `--version`, `-V`, and `version` print `oxc-tsrx 0.1.3`. A wrong
subcommand names the bad word, prints the usage block, and exits 2.

### What `setup` writes, and what it only checks

Three of the four slots are packages in `node_modules`. The fourth is one
setting in your own tree: `"oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/oxlint"`
in `.vscode/settings.json`, written only when `node_modules/.bin/oxlint` does not
already resolve into this package. The key is merged without disturbing another
key or a comment, never overwrites a value you set, and `remove` takes back
exactly it. `package.json` is never edited, and neither is `tsconfig.json`
unless you pass `--write-tsconfig`.

`setup` and `status` also report four TSRX editor prerequisites they never
install:

- `@tsrx/typescript-plugin`
- a framework binding
- the nearest `tsconfig.json`, which has to declare that plugin
- TypeScript at `>=5.9 <6`

### The editor slot has eight states

Only the first two mean the editor is already wired up. The last two exist so
that the report never calls wiring `active` that it cannot prove.

| State | What it means |
| --- | --- |
| `active (editor)` | The key is written at your project root, and the extension would resolve and run it. |
| `unnecessary (editor)` | The extension's own lookup reaches this package from your project root and from every folder above it that looks like a workspace root, so no key was written. |
| `missing (editor)` | The shim does not reach this package and no key is written yet. `setup` writes one. |
| `stale (editor)` | A key this package wrote no longer resolves here. `setup` refreshes it. |
| `collision (editor)` | The key is already set to a value you wrote. It is left alone and reported. |
| `unreadable (editor)` | `.vscode/settings.json` is not a single top-level JSON object, so nothing was written. |
| `inert (editor)` | Two shapes, one meaning: what is right for this folder is not what the folder you open would do. Either the value is right here and a folder above it looks like the workspace root you actually open, or no key was needed here and a folder above it would run a different `oxlint`. VS Code reads `.vscode/settings.json` only from the folder you open. |
| `unresolvable (editor)` | The key is written and the extension would not run it, because the file is missing, the value contains a character the extension rejects, or it is not spawnable on this platform. A configured value replaces the extension's own lookup rather than adding to it, so this is worse than no key. |

When a key is written and any folder above your project root looks like a
workspace root, `setup`, `status`, and `remove` print a `!` note naming each one
and the file that made it a candidate, in order: `.code-workspace`,
`pnpm-workspace.yaml`, a `workspaces` field, `turbo.json`, `nx.json`,
`lerna.json`, then `.git`. When no key is written, the same note appears only
for a folder that would really run a different `oxlint`, and it names that
binary too. Nothing is reported for a folder that would still reach this
package, because a false alarm costs more than it is worth. Either way the note
lists the two remedies, in order: open the project folder itself, or rerun
`setup --workspace-root <directory>`.

### `setup --workspace-root <directory>`

The only way to write the key above your project root, and it is never implied.
Use it when the folder you open in your editor is a monorepo root rather than
the project that has the `package.json`.

<!-- pm-exec -->
```sh
npx oxc-tsrx setup --workspace-root .
```

The path is resolved from your working directory, like `--project`, and it has
to be a real directory that contains your project. The value is written relative
to the folder you name, so a root two levels up gets
`packages/app/node_modules/@tsrx/oxc/bin/oxlint` rather than
`node_modules/@tsrx/oxc/bin/oxlint`. `remove` follows the receipt back to that
same folder.

One caveat the command prints for you: a multi-root window resolves a relative
`oxc.path.oxlint` against its **first** folder, not against the folder holding
the settings file. `oxc.path.oxlint` is window-scoped, so a multi-root workspace
is not a way to rescue a folder-scoped value. [Editor
integration](/integrations/editor#when-the-key-does-not-take-effect) has the
rest.

### `setup --write-tsconfig`

The one flag that edits a tsconfig, opt-in so that the default stays
report-only. It adds `"plugins": [{ "name": "@tsrx/typescript-plugin" }]` under
`compilerOptions`, splicing in that single entry and leaving every other byte,
comments included, exactly as written. A solution-style root owns no files, so a
plugin declared there is inert; the flag follows the reference to the project
that includes your source and writes there instead. It refuses rather than
guesses in two cases: a `compilerOptions.plugins` list it did not write is
reported instead of appended to, and a file whose `compilerOptions` object
cannot be located is left alone. Running it twice is a no-op.

See [Vite and
Vite+](/guide/getting-started#if-something-goes-wrong).

### `status` says `missing` in a healthy project

```text
$ npx oxc-tsrx status
oxc-tsrx 0.1.5 compatibility (npm)

  oxc-parser:       missing
  oxlint:           missing
  oxfmt:            missing
  oxc.path.oxlint:  unnecessary (editor)
      …/node_modules/.bin/oxlint already resolves into this package, so the
      editor needs no setting and none was written.
```

That output is correct and the exit code is 0: `status` only ever talks about the
Vite+ compatibility slots, so `missing` means "not installed" and `unnecessary`
means the ordinary lookup reaches this package from every folder you might open,
checked rather than assumed. Run `setup` only if you use Vite+, and run `npx
oxc-tsrx providers` to confirm TSRX support is wired up.

## Exit codes

Both native commands use the same three codes:

| Code | `oxc-tsrx` (lint) | `oxc-tsrx-fmt` (format) |
| --- | --- | --- |
| `0` | No errors, warning policy satisfied. | Formatted successfully, or `--check` found no differences. |
| `1` | At least one error diagnostic, or `options.denyWarnings`/`options.maxWarnings` failed. | `--check` found files that differ. |
| `2` | Usage, configuration, or engine error. | Usage, configuration, or engine error. |

## `oxc-tsrx-lsp` (language server)

The third binary hosts the same Rust lint and format sessions behind OXC's
language-server transport. An editor client launches it, not you: `oxlint --lsp`
starts it beside official Oxlint and registers `.tsrx`. You get live diagnostics
on the spans you wrote, whole-document formatting, validated quick fixes, and
opt-in type-aware diagnostics. See [Editor
integration](/integrations/editor).

## npm direct upstream route

Some invocations never need TSRX at all: the delegate-only flags below, and
explicit batches of ordinary JS/JSX/TS/TSX files. Those load the pinned package's
own launcher in the same Node process, so upstream diagnostics, config, fixes,
stdin, and signals are preserved with no second process.

| Command | Delegate-only flags |
| --- | --- |
| `oxlint` | `--help`, `-h`, `--version`, `-V`, `--rules`, `--init` |
| `oxfmt` | `--help`, `-h`, `--version`, `-V`, `--init`, `--migrate`, `--lsp` |

Ambiguous paths, directories, globs, unknown options, and any `.tsrx` input stay
on the TSRX-aware bridge. `oxlint --lsp` is the deliberate exception: it
multiplexes official Oxlint and `oxc-tsrx-lsp` over one connection, keeping
ordinary documents with official Oxlint and isolating both directions' request
IDs. Non-LSP invocations never enter that multiplexer.

## Environment variables

The linter, the formatter, and the language server are one native binary that
dispatches on a leading subcommand (`fmt`, `lsp`, or `lint`, the default) and on
the name it was invoked under. The toolchain normally locates it through platform
packages; during source development these three overrides name a release binary
explicitly, and all three point at that same executable:

| Variable | Description |
| --- | --- |
| `OXC_TSRX_LINT_BIN` | Absolute path to the native `oxc-tsrx` binary. |
| `OXC_TSRX_FORMAT_BIN` | The same path; the wrapper selects the formatter with its `fmt` subcommand. |
| `OXC_TSRX_LSP_BIN` | The same path, used by the editor test harness. The editor client starts it with `lsp`. |

A missing native artifact is an error; `.tsrx` is never silently delegated to
the official tools.

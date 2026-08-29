# Rust/OXC core architecture

## Decision and ownership

The language core is Rust and uses the official OXC crates as-is: no fork, no
snapshot, no Cargo patch. The JavaScript side is only thin launchers for npm,
Vite+, configuration, and the editor.

`crates/oxc_adapter` is the only crate that imports OXC, pinned to commit
`8e0ed2ebb96137fb1611cdbd5742d5cb46037d40`. Every adapter dependency comes
from that one Git source so Cargo never mixes two incompatible copies of the
same crate. Upgrading OXC means bumping this adapter and the lockfile, then
passing the full behavior and performance suites.

## Compact TSRX overlay

`tsrx_syntax::scan` reads the source bytes once and records the TSRX
structure in a few compact arrays instead of building a full syntax tree,
which keeps scanning fast and memory-light. Its only direct dependency is
`unicode-id-start = "1"` (no direct OXC dependency).

The overlay recognizes:

- control blocks: `@{ }`, `@if`/`@else if`/`@else`,
  `@for`/`@for await`/`@empty`, `@switch`/`@case`/`@default`, and
  `@try`/`@pending` with a headerless or bound `@catch`;
- loop detail: declaration and assignment bindings, `index` and `key`
  annotations;
- dynamic JSX tags, where the opening and closing names must refer to the
  same expression;
- lowercase `<style>` elements, whose raw contents are carried through
  untouched; and
- the context each of those appears in: statement, expression, direct JSX
  child, or nested.

Strings, comments, regex literals, template text, JSX text and attributes,
and Unicode identifiers and escapes are never misread as TSRX syntax. When
the scanner is not sure, it stops with a clear error instead of guessing.
That covers stale scan results, orphan or reordered clauses, mismatched
closing tags, and unsupported grammar.

## Native lint path

<!-- diagram:native-lint -->

- Ordinary `.js`, `.jsx`, `.ts`, and `.tsx` files skip the TSRX scanner
  entirely, and each run's metadata proves zero scan and TSX copy cost for
  them.
- TSRX control syntax is projected (translated) into legal TSX that OXC can
  parse. Your code is copied in byte-for-byte, with a map of exactly which
  output ranges are your original bytes, so OXC lints the exact bytes you
  wrote.
- A diagnostic must land entirely on your bytes or it is suppressed and
  counted. A fix must be marked safe, land in one exact authored range, and
  survive a rescan, TSX copy, and reparse of the edited file before
  anything is written. A fix that would touch the generated glue code, or
  cross between authored and generated ranges, is rejected.
- Dynamic tag names are validated as real expressions during the single OXC
  parse of the file.
- Raw `<style>` payloads stay outside the JavaScript AST, so this path does
  not claim CSS linting.

End-to-end tests cover `no-debugger` and `no-unused-vars` labels plus
`no-var` fixes across the branch, loop, switch, and try families. The project
does not claim every rule behaves identically over the generated glue code.

## Opt-in type-aware lint path

When type-aware linting is off (the default), each TSRX file gets one
official OXC parse and no TypeScript-Go process starts. `--type-aware` and
`--type-check` add a separate project lane:

<!-- diagram:type-aware-lint -->

- A second, type-focused TSX copy emits legal TypeScript/TSX that keeps
  loop element types, variable scopes, `.tsrx` imports, catch-parameter
  context, and component callability. Declarations are appended after your
  code so byte offsets never move.
- Rules resolve against your file name, and the whole mixed project
  goes to the type checker over stdin in one request. Nothing is written
  into your project.
- The adapter verifies the official binary from `oxlint-tsgolint` 0.24.0. A
  missing or mismatched binary fails with an actionable error instead of
  silently downgrading.
- Fixes obey the same safety rule as the native path. Everything else stays
  visible as a non-applicable diagnostic.

## Native formatter path

<!-- diagram:native-formatter -->

`tsrx_format::format_text` is the default-options library entry point,
`tsrx_format::FormatSession::format_text` is the configured editor and batch
entry point, and ordinary files call `oxc_adapter::format` directly.

Formatting a `.tsrx` file is a three-step round trip:

- TSX copy turns the TSRX-specific pieces into tagged comment markers
  inside one legal TSX buffer.
- Official  formats that buffer exactly once.
- A lift pass (the reverse of TSX copy) removes the scaffolding and
  restores the authored `@` syntax, then checks its own work: every marker
  present, unique, and in order, no scaffolding left behind, and a rescan
  must find the same TSRX structure the original had.

Dynamic closing tag names are rebuilt from the formatted opening expression, and
each raw `<style>` payload is copied from the original source rather than
reformatted, until OXC exposes its CSS formatter publicly. The indexed lift
renderer holds 18.99 MiB/s on the stress corpus and 121.55 MiB/s on the fast
path for pure statement controls.

`oxc-tsrx-fmt` supports stdin, check mode, transactional writes, explicit
multi-file input, and an optional thread count. Every file must format before
any write is staged, recoverable staging failures restore the originals, and
symbolic links are rejected.

## Configured session layer

Configuration lives above the per-file hot path. A command or editor host
builds configured `LintSession` and `FormatSession` values, loads JSON/JSONC
configuration once, and reuses it for every file. The editor keeps its
diagnostic session separate from its fix-enabled session, so an editor
request can never reach a disk-writing CLI path:

<!-- diagram:configured-session -->

The npm and Vite+ hosts may resolve your `vite.config.*` once through Vite+'s
public `resolveConfig` API, extract the `lint` or `fmt` field, and hand the
native process disposable JSON. None of this creates files in your project.

Unsupported capabilities are rejected before any source work:

- JS/TS config modules on the direct-native path;
- JavaScript lint plugins, `.editorconfig`, and callback-backed or unknown
  formatter options; and
- type-aware lint without its explicit CLI opt-in, which the Vite+ companion
  supplies from a resolved `typeAware` or `typeCheck` option.

[Configuration](/integrations/configuration) has the full matrix.

## Performance evidence

Performance is a release gate: every release build must pass a frozen set of
budgets, and every report keeps enough detail to re-check later. The headline
results:

- Linting and formatting ordinary JS/TS/TSX files adds no measurable
  overhead over plain OXC. TSRX scanning and TSX copy run in the hundreds
  of MiB/s.
- On a matched 1,000-file corpus the CLI finishes in about 49 ms, where
  official Oxlint takes about 42 ms and ESLint takes about 648 ms.
- Type-aware lint costs roughly 26 ms per file, and editor responses stay
  well under a millisecond after a fresh open of about 2.5 ms.

All the tables, budgets, methodology, and report files live on the
[Benchmarks](/reference/benchmarks) page; this page does not duplicate them.

## Current boundary

This is tested against a real TSRX codebase, checked out read-only. What is
proven today:

- All 179 valid files format, reparse, and settle, all 12 broken files are
  rejected, and every raw `<style>` block comes out identical. That covers the
  grammar and the formatter, not the framework's own compiler or runtime.
- Real Vite builds, the dev watcher and HMR, and the `vp` commands all pass,
  with no OXC for TSRX transform running during compilation.
- A real VS Code session proves activation, diagnostics on your own lines,
  config refresh, format-on-save, and one validated quick fix. A protocol
  suite covers malformed buffers and recovery.

Known gaps:

- Nested dynamic JSX inside a dynamic-name expression is unsupported.
- Raw CSS is passed through, never formatted or validated.
- Nested configuration and alternate reporters are unimplemented, on top of
  what the [configured session layer](#configured-session-layer) rejects.
- Hosted production of all eight platform candidates, external publication,
  and deployment remain approval-gated release operations.

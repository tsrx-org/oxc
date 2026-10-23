---
title: Limitations
description: What OXC for TSRX does not support yet, and why each gap fails loudly instead of quietly.
---

# Limitations

Everything on this page fails loudly: you get a clear error, never a silently
skipped file or a wrong-but-plausible result.

## This package does not compile `.tsrx`

`@tsrx/oxc` lints, formats, parses, and powers your editor. Turning `.tsrx` into
something a browser runs is a separate job, and it belongs to your framework's
TSRX plugin. That plugin already exists for React, Preact, Solid, Vue, Ripple,
and Octane, across Vite, Rspack, Turbopack, and Bun. For React on Vite:

```sh
npm install @tsrx/react @tsrx/vite-plugin-react
```

The [TSRX getting started guide](https://tsrx.dev/getting-started) has the other
framework and bundler combinations. Without one of them your bundler reads
`.tsrx` as ordinary TypeScript and fails on the first `@{`, and installing
`@tsrx/oxc` will not fix that. The public API is not a substitute either:
`@tsrx/oxc/parser` gives you an AST and `@tsrx/oxc/format` gives you formatted
TSRX, and neither is code a bundler can consume.

## Formatting

- **CSS inside `<style>` is never reformatted.** The surrounding TSRX and JSX
  gets full Oxfmt layout, and style contents are preserved byte for byte. See
  [the embedded CSS boundary](/architecture/embedded-css-boundary).
- `.editorconfig` and formatter options that take callbacks are rejected, and
  `--disable-nested-config` is not supported for `.tsrx`.

## Syntax

- A dynamic tag whose name expression contains more dynamic JSX, meaning a
  dynamic tag inside a dynamic tag's name, is not supported.

## Linting

- **JavaScript lint plugins see the projection, not your authored tree.** Your
  `jsPlugins` rules do run on `.tsrx`, but the native path is Rust with no
  Node.js runtime, so they lint a legal-TSX copy of your file, at the cost of
  one extra parse per file, which is announced every time.
  `settings.oxcTsrx.jsPluginsOnTsrx: false` turns the lane off.
  - `@if`, `@for`, `@switch`, and `@try` arrive as the ordinary statements they
    project to.
  - A report landing on projected-only text is counted and dropped, never placed
    at an invented location.
  - [Custom JavaScript plugins](/integrations/custom-js-plugins) has the details
    and the measurements.
- **Type-aware rules need an explicit `--type-aware` or `--type-check`** and the
  supported `oxlint-tsgolint` executable, 7.0.2002 or a later 7.0 release. Any
  other version fails rather than guess at the protocol, which is what a fresh Vite+ scaffold runs into when
  it resolves Vite+'s own runner instead. See [the type-aware template
  default](/guide/getting-started#if-something-goes-wrong).
- **`vp lint` and your editor read different config files.** Vite+ owns lint
  configuration in the `lint` block of `vite.config.ts`, and the language server
  reads `.oxlintrc.json`, so a rule you want on both surfaces has to be declared
  twice, in the two shapes those files use.
- Not every OXC rule is guaranteed to behave identically around the TSRX
  placeholders. Anything that would report inside placeholder code is suppressed.
- On a run that includes `.tsrx`, lint output comes out as `default`, `agent`,
  `github`, or `json`. Any other Oxlint format is refused.

## Commands and configuration

- **`setup` reports the TSRX editor prerequisites and never acts on them.** It
  does not install `@tsrx/typescript-plugin` or a framework binding, and does not
  edit `package.json` or any `tsconfig.json`, so every `!` line it prints is work
  left for you. TSRX language support in the editor belongs to the TSRX
  toolchain.
- **Vite+ needs `oxc-tsrx setup` again after every clean install.** Vite+ finds
  its lint and format tools by the literal package names `oxlint` and `oxfmt`, so
  `setup` writes those slots inside `node_modules`, and a clean install wipes
  them. That rerun is real and is not scheduled to go away. See [the one extra
  step Vite+ needs](/guide/getting-started#try-it-with-vite).
- **A project that pins official `oxlint` or `oxfmt` keeps official behavior for
  those command names.** Breaking a pinned setup would be worse. `.tsrx` is then
  reachable through `oxc-tsrx-lint` and `oxc-tsrx-fmt`, which are always
  installed.
- The native binaries take explicit file paths only. Directory walking and globs
  come from the `@tsrx/oxc` npm commands and Vite+.
- Config files must be JSON or JSONC. JS and TS config modules are rejected,
  except through Vite+, where the toolchain resolves your `vite.config.*` once
  and hands both engines the same extracted settings. Values that cannot be
  serialized, like callbacks, fail with a clear error.

## Editor and platform coverage

- **The released official OXC extension does not start on a `.tsrx` file.** It
  activates only on `onLanguage:` events and none of them is TSRX's language, so
  a `.tsrx` file opened first in a session does not start it. Open an ordinary
  JavaScript, TypeScript, or JSON file once and the rest of the session works.
  See [Editor
  integration](/integrations/editor#what-a-plain-install-actually-covers).
- **Three lanes run in CI on Linux only:** the editor server, the type-aware
  lane, and the JavaScript plugin lane. Windows and macOS get a real lint, a real
  format, live `--lsp` sessions, and a parser addon load on every pull request,
  so treat those three as unverified there rather than known-good.
- Publishing a platform is a weaker promise than testing one, and the two musl
  targets have never run on a musl system.
  [Platform support](/reference/platform-support) has the per-target split.

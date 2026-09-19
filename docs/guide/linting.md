---
title: Linting
description: How @tsrx/oxc runs real OXC lint rules on .tsrx files and reports errors at your actual code.
---

# Linting

`@tsrx/oxc` lints `.tsrx` files, and ordinary JS/TS files too, with OXC's real
lint rules. The code you wrote goes through the same rule engine Oxlint uses. If
a diagnostic or a fix would land on the placeholder code the tool generates
instead of on yours, it is dropped rather than shown.

## How a lint run works

<!-- pipeline:lint -->

Four steps:

1. **Scan.** Read the file once and find the TSRX-only syntax.
2. **Copy.** Build a valid TSX copy in memory, the *projection*. Your code is
   copied over unchanged, and only the TSRX controls become placeholders.
3. **Lint.** OXC parses and lints that copy, once.
4. **Map back.** Move every error onto your file, so the line and column point
   at what you wrote.

Step 2 also records which piece of the copy came from which piece of your file,
and that record is what makes step 4 exact.

Ordinary `.js`, `.jsx`, `.ts`, and `.tsx` files skip steps 1 and 2 entirely.
They go straight to OXC, exactly like running `oxlint` yourself.

Here is one real file at each of those stages, with the actual copy the tool
built and the actual diagnostics it returned:

<!-- projection-explorer -->

## Usage

<!-- terminal-demo:linting-usage -->

CLI severity flags (`--allow`/`-A`, `--warn`/`-W`, `--deny`/`-D`) override
whatever the config file says for that rule. Exit codes: `0` clean, `1` when
there are errors (or the configured warning policy fails), `2` for usage or
engine errors.

## Why you never see errors in code you didn't write

The copy OXC reads contains placeholder code you never typed, and now and then a
rule fires on a placeholder instead of on your code.

When that happens the diagnostic is dropped rather than shown, and the run
counts it so nothing disappears silently. The rule is simple: if an error does
not sit entirely inside code you wrote, you never see it.

## Safe fixes

`--fix` applies fixes directly to your original TSRX file, but only fixes
that touch purely your own code. After applying, the tool re-scans and
re-parses the result to confirm it's still valid before writing anything. A
fix that would touch the TSRX control syntax or span a placeholder boundary
is rejected.

## Configuration

Your `.oxlintrc.json` works as usual. `@tsrx/oxc` searches upward from the
current directory to find it, or takes a `--config` path, and the ordinary
Oxlint fields all apply: rules, plugins, `env`, `globals`, `settings`,
`extends`, `overrides`, and `ignorePatterns`.

Three things behave differently here:

- **The config has to be JSON or JSONC.** A `.js` or `.ts` config is rejected up
  front rather than half-working.
- **Your own JavaScript lint plugins do run on `.tsrx`**, but they see the TSX
  copy rather than the code you wrote. Read
  [Custom JavaScript plugins](/integrations/custom-js-plugins) before relying on
  them.
- **Type-aware lint is opt-in** and needs exactly `oxlint-tsgolint` 7.0.2002. A
  missing or mismatched version fails loudly instead of quietly switching
  itself off.

[Configuration](/integrations/configuration) lists every supported field.

## What is tested

Tests prove that `no-debugger` and `no-unused-vars` report at the right line and
column in your file, and that `no-var` fixes apply correctly, inside every
control-flow form (`@if`, `@for`, `@switch`, `@try`). Type-aware linting has its
own suite covering the same ground.

What is *not* claimed: that every OXC rule behaves identically around the
placeholders. That stays unclaimed until it is proven.

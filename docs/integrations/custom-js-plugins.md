---
title: Custom JavaScript plugins
description: Write a custom lint rule with the oxlint that @tsrx/oxc installs and run it on .tsrx files, with positions in your authored source.
---

# Custom JavaScript plugins

Installing `@tsrx/oxc` puts an `oxlint` on your PATH that already lints `.tsrx`.
Write one ordinary Oxlint JavaScript plugin, list it in `.oxlintrc.json`, and it
runs on `.js`, `.ts`, `.jsx`, and `.tsx` directly and on `.tsrx` through a TSX
copy, reporting at the line and column you wrote. Two things to know first:

- The `.tsrx` half costs one extra parse per file, and `oxlint` says so on
  stderr. See [turning the extra parse off](#turning-the-extra-parse-off).
- Your rule sees TSRX control syntax as the JavaScript it compiles to, not as
  `@if` and `@for` nodes. See [what your rule sees on
  `.tsrx`](#what-your-rule-sees-on-tsrx).

On a Vite+ app, read [in a Vite+ project](#in-a-vite-project) as well: the
`oxlint` on your PATH there is Vite+'s, not this package's.

## Set up the project

You need Node.js 20.19 or newer, and one install
([Getting Started](/guide/getting-started#install) has the per-host details):

<!-- pm-install -->
```sh
npm install @tsrx/oxc@latest
```

Save this as `src/TaskList.tsrx`:

```tsrx
type Task = { id: string; label: string; done: boolean };

export function TaskList({ tasks, ready }: { tasks: Task[]; ready: boolean }) @{
  debugger;

  @if (ready) {
    <ul class="tasks">
      @for (const task of tasks) {
        <li>{task.label}</li>;
      }
    </ul>;
  } @else {
    <p>Loading tasks</p>;
  }
}
```

<!-- terminal-demo:custom-plugins-first-run -->

The missing `key` and the `debugger` are both there on purpose. With no config
file and no build step, `oxlint` reported a built-in OXC rule at the line you
wrote. Those rules are Rust, so you cannot add one. What you can add is a plugin.

## What are the nodes called?

A lint rule is a set of callbacks named after node types. Every TSRX control
block has its own node type, shaped like the JSX nodes you already know:

| You write | The node you visit |
| --- | --- |
| `@if` / `@else` | `JSXIfExpression` |
| `@for` / `@empty` | `JSXForExpression` |
| `@switch` / `@case` / `@default` | `JSXSwitchExpression` |
| `@try` / `@pending` / `@catch` | `JSXTryExpression` |
| `@{ }` statement containers | `JSXCodeBlock` |

Everything else uses the same shapes as `oxc-parser`; the [Parsing
guide](/guide/parsing) covers the tree, and
[`explore-tsrx-ast.mjs`](https://github.com/tsrx-org/oxc/blob/main/examples/custom-js-plugins/explore-tsrx-ast.mjs)
prints the node types in a file of your own.

## Write an oxlint JavaScript plugin

An Oxlint plugin is an ES module exporting `{ meta, rules }`, where each rule's
`create(context)` returns a visitor keyed by node type. Pass `node` to
`context.report` to put the diagnostic on the code you wrote, and `meta.name` is
the prefix the rules are configured under.

Copy
[`oxlint-demo-plugin.mjs`](https://github.com/tsrx-org/oxc/blob/main/examples/custom-js-plugins/oxlint-demo-plugin.mjs)
into your project. It has one rule, `require-keyed-map`, which visits
`CallExpression` and reports JSX returned from `.map()` without a `key`.

Oxlint only loads a plugin you list, and only enables a rule you turn on. Save
this as `.oxlintrc.json`:

```json
{
  "jsPlugins": ["./oxlint-demo-plugin.mjs"],
  "rules": {
    "tsrx-demo/require-keyed-map": "error"
  }
}
```

The rule needs an ordinary file to run on, so add
[`src/TaskRow.tsx`](https://github.com/tsrx-org/oxc/blob/main/examples/custom-js-plugins/src/TaskRow.tsx),
a React component whose `.map()` call has the missing-key problem.

<!-- terminal-demo:custom-plugins-oxlint-plugin -->

## The same plugin on `.tsrx`

Leave everything as it is and point the same command at the `.tsrx` file:

<!-- terminal-demo:custom-plugins-tsrx-plugin -->

That `oxlint (oxc-tsrx):` line is the disclosure: the `.tsrx` half costs one
more parse, and the command says so every time, naming the setting that turns it
off. Your rule found nothing here, because `require-keyed-map` wants a `.map()`
call and this file has an `@for` block. Give it something to find, as
`src/TaskFeed.tsrx`:

```tsrx
type Task = { id: string; label: string; done: boolean };

export function TaskFeed({ tasks }: { tasks: Task[] }) @{
  const rows = tasks.map((task) => <li>{task.label}</li>);

  <ul class="feed">{rows}</ul>;
}
```

<!-- terminal-demo:custom-plugins-tsrx-map -->

Your own rule, at line 4, column 36: the column of the `<li>` you wrote. One
command over a directory does both halves, and the editor needs nothing extra,
since the language server runs the same plugin on the buffer. [Editor
integration](/integrations/editor#your-own-javascript-rules-in-the-editor) names
its one activation step.

## In a Vite+ project

Two things differ, and both are Vite+'s doing rather than this package's.

**`node_modules/.bin/oxlint` belongs to Vite+.** Running it exits 1 and tells
you to run `vp lint`. Do that, or use this package's own
`node_modules/@tsrx/oxc/bin/oxlint`. The editor needs nothing further: `setup`
points the extension at this package.

**`vp lint` does not read `.oxlintrc.json`.** Vite+ keeps lint configuration in
the `lint` block of `vite.config.ts`, so a rule you want on both surfaces is
declared twice. Add `{ name: "house-rules", specifier: "./house-rules.mjs" }` to
`lint.jsPlugins` and your rule to `lint.rules`, deleting nothing the scaffold
wrote. [The finished
file](https://github.com/tsrx-org/oxc/blob/main/examples/custom-js-plugins/vite-plus/vite.config.ts)
is in the examples directory.

Making `.tsrx` a *language* in the editor is a separate job owned by the TSRX
toolchain. [Vite and
Vite+](/guide/getting-started#if-something-goes-wrong) has that
list and the type-aware dependency the scaffold needs.

## What your rule sees on `.tsrx`

A `.tsrx` file is linted by a Rust process with no Node.js runtime, so `oxlint`
runs the published Oxlint binary over a legal TSX copy of your file, with your
own `.oxlintrc.json`. Severities, rule options, `extends`, and `overrides`
resolve as they do elsewhere, and an installed Oxlint outside `>=1.74.0 <2.0.0`
is refused rather than used.

Your rule sees that copy. Four things follow from it:

<!-- rule-sees -->

For a rule that must report on TSRX control flow itself, see
[the ESLint route](#when-your-rule-must-see-if-and-for-as-tsrx-nodes).

## Turning the extra parse off

To stop paying the second parse, add `"settings": { "oxcTsrx": {
"jsPluginsOnTsrx": false } }` to `.oxlintrc.json`. Your plugins keep running on
ordinary files, and on `.tsrx` the command now refuses out loud rather than
dropping your rule and reporting success:

<!-- terminal-demo:custom-plugins-tsrx-opt-out -->

The same setting turns the editor's half off, where the refusal arrives as one
`lint-unavailable` diagnostic carrying the same text. The [configuration
guide](/integrations/configuration#jsplugins-and-the-two-lanes) has the full
support matrix for the native `.tsrx` path.

## When your rule must see `@if` and `@for` as TSRX nodes

There is no released route for that today. Your rule always sees the TSX copy,
where the control blocks have already become ordinary statements.

The repository carries a local ESLint adapter that does hand a rule the authored
tree, in
[`examples/custom-js-plugins`](https://github.com/tsrx-org/oxc/tree/main/examples/custom-js-plugins).
It is AST-only, since the parser API exposes no token stream. Running the same
rule inside Oxlint waits on OXC PR
[#24262](https://github.com/oxc-project/oxc/pull/24262), a draft as of
2026-07-26.

The runnable version of this page is in
[`examples/custom-js-plugins`](https://github.com/tsrx-org/oxc/tree/main/examples/custom-js-plugins).
Oxlint is pinned and tested at 1.83.0. Last audited: 2026-09-18.

<p align="center">
  <a href="https://compiled.run/oxc-tsrx">
    <img alt="OXC for TSRX" width="600" src="https://raw.githubusercontent.com/tsrx-org/oxc/HEAD/.github/assets/readme-hero.png">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tsrx/oxc"><img alt="npm version" src="https://img.shields.io/npm/v/@tsrx/oxc"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img alt="supported Node.js versions" src="https://img.shields.io/node/v/@tsrx/oxc"></a>
  <a href="https://github.com/tsrx-org/oxc/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/tsrx-org/oxc/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://discord.gg/HCYpT5QHQR"><img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20the%20community-7289da?logo=discord&logoColor=white"></a>
  <a href="https://github.com/tsrx-org/oxc/blob/HEAD/LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/@tsrx/oxc"></a>
</p>

The official OXC integration for TSRX. `@tsrx/oxc` gives you three tools for
`.tsrx` files:

- a **linter**, which warns you about likely mistakes before you run your code
- a **formatter**, which fixes spacing and punctuation so every file matches
- a **parser**, which reads a file into a form your own tools can work with

A `.tsrx` file is TypeScript with HTML-like markup in it, plus blocks like `@if`
and `@for` for showing something only sometimes, or once per item in a list.
[OXC](https://oxc.rs) is a set of fast tools for JavaScript and TypeScript,
written in Rust. This package teaches them to read `.tsrx` too.

_OXC for TSRX is the official OXC integration maintained by the TSRX project._

[**Docs**](https://compiled.run/oxc-tsrx) &nbsp;·&nbsp; [**Getting started**](https://compiled.run/oxc-tsrx/guide/getting-started) &nbsp;·&nbsp; [**Playground**](https://compiled.run/oxc-tsrx/playground)

## Install

```sh
npm install --save-dev @tsrx/oxc
```

That is the whole setup, for the command line and for your editor. You get
`oxlint` and `oxfmt`, the real [OXC](https://oxc.rs) commands, now able to read
`.tsrx`, with no config file, no ignore file, and no install script. [Vite+ needs
one more command](https://compiled.run/oxc-tsrx/guide/getting-started#try-it-with-vite).

You do not need Rust installed: the install downloads a ready-built program for
your machine, one of eight published for macOS, Linux, and Windows. See
[Platform support](https://compiled.run/oxc-tsrx/reference/platform-support).

## Usage

```sh
npx oxlint src/Cart.tsrx        # Lint the file.
npx oxfmt --check src/Cart.tsrx # Show what formatting would change.
npx oxfmt --write src/Cart.tsrx # Apply it.
```

Always give these commands a path. A bare `npx oxlint` also checks
`node_modules`, and `--fix` (the flag that lets `oxlint` edit your files) will
rewrite files in there.

Your `.js`, `.jsx`, `.ts`, and `.tsx` files go straight to OXC, exactly as they
would without this package. Only `.tsrx` files do anything TSRX-specific.

## What works today

These are the TSRX blocks the linter and formatter understand: `@{` blocks,
`@if` / `@else if` / `@else`, `@for` / `@empty`, `@switch` / `@case` /
`@default`, `@try` / `@pending` / `@catch`, tags whose name is an expression,
`<{expression}>`, and plain `<style>` blocks
([TSRX syntax](https://compiled.run/oxc-tsrx/guide/tsrx-syntax) shows each one). Anything
outside that list **fails closed**: the command stops and says what it found and
where, rather than guessing and maybe producing wrong output.

**This package compiles nothing.** It never builds or runs your app. Turning
`.tsrx` into something a browser can run is your framework's TSRX plugin's job,
such as `@tsrx/vite-plugin-react`. See
[tsrx.dev/getting-started](https://tsrx.dev/getting-started). Without one, your
build tool reads `.tsrx` as plain TypeScript and stops at the first `@{`.

## In your editor

Install the official OXC extension, `oxc.oxc-vscode`. With `@tsrx/oxc` in the
project there is nothing else to install or configure, and your editor
underlines the same problems the terminal reports. One catch: the TSRX
toolchain's own extension owns `.tsrx`, and the OXC extension lists no
activation event for it, so it does not start on its own. Open any JavaScript,
TypeScript, or JSON file in the project once, and `.tsrx` works for the rest of
the session. See the [editor guide](https://compiled.run/oxc-tsrx/integrations/editor).

## Using it from your own code

```js
import { parseSync } from "@tsrx/oxc/parser";
import { defineConfig } from "@tsrx/oxc/lint";
import { format } from "@tsrx/oxc/format";
```

The parser hands back the structure of your file and the formatter hands back
tidied text, so you can build your own tools on the same reader the commands
use. [Parsing](https://compiled.run/oxc-tsrx/guide/parsing) has the shape it returns.
None of these compiles `.tsrx` either; that stays your framework's TSRX
plugin's job.

Framework compilers that currently call `@tsrx/core`'s parser can use the
compatibility facade from the same package:

```js
import { parseModule } from "@tsrx/oxc/tsrx-core-compat";
```

It preserves TypeScript fields and supplies the source locations, directive
keyword origins, comments, and complete scoped-CSS tree expected by
`@tsrx/core` consumers.

## Your own JavaScript lint plugins

A plugin listed in `jsPlugins` runs on `.tsrx` from the `oxlint` command and
inside your editor, but it sees a translated copy of your file rather than the
TSRX you wrote, so each `.tsrx` file is read once more. The command and the
editor both say when they have done that, and
`settings.oxcTsrx.jsPluginsOnTsrx: false` turns it off.

`oxc-tsrx-lint`, the standalone Rust command, has no Node.js to run a plugin in,
so it refuses `jsPlugins` and names `oxlint` as the command that can.
`@tsrx/oxc/lint/plugins-dev` is for *writing* a plugin, since it re-exports the
`RuleTester` from `oxlint`. See [Custom JavaScript
plugins](https://compiled.run/oxc-tsrx/integrations/custom-js-plugins).

## Documentation

- [Getting started](https://compiled.run/oxc-tsrx/guide/getting-started): install, first file, first run.
- [Configuration](https://compiled.run/oxc-tsrx/integrations/configuration): every supported setting.
- [CLI reference](https://compiled.run/oxc-tsrx/reference/cli): commands, flags, and exit codes.
- [Platform support](https://compiled.run/oxc-tsrx/reference/platform-support): which of the eight published platforms are tested on every change.
- [Limitations](https://compiled.run/oxc-tsrx/reference/limitations): what is not claimed yet.
- [Provider protocol](https://compiled.run/oxc-tsrx/architecture/provider-protocol): the `oxc.provider` block, what reads it today, and how a plain install reaches released hosts.

`@tsrx/oxc` is the only package to depend on. The eight `@tsrx/oxc-*`
packages are platform binaries in `optionalDependencies`, and you never name one
yourself.

## License

[MIT](https://github.com/tsrx-org/oxc/blob/HEAD/LICENSE).

<p align="center">
  <a href="https://compiled.run/oxc-tsrx"><img alt="OXC for TSRX" width="600" src="https://raw.githubusercontent.com/tsrx-org/oxc/HEAD/.github/assets/readme-hero.png"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tsrx/oxc"><img alt="npm version" src="https://img.shields.io/npm/v/@tsrx/oxc"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img alt="supported Node.js versions" src="https://img.shields.io/node/v/@tsrx/oxc"></a>
  <a href="https://github.com/tsrx-org/oxc/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/tsrx-org/oxc/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://discord.gg/HCYpT5QHQR"><img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20the%20community-7289da?logo=discord&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/@tsrx/oxc"></a>
</p>

The official OXC integration for TSRX. It gives you three tools for `.tsrx`
files:

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
npm install --save-dev @tsrx/oxc@latest
```

That is the whole setup, for the command line and for your editor. There is no
config file to write and no install script to run. [Vite+ needs one more
command](https://compiled.run/oxc-tsrx/guide/getting-started#try-it-with-vite).

You do not need Rust. Installing downloads one ready-built program for your
computer, one of eight built for macOS, Linux, and Windows. Anything else has
to build from source. [Platform
support](https://compiled.run/oxc-tsrx/reference/platform-support) lists all eight
targets. You need Node.js 20.19+ (in the 20.x line) or 22.12+.

## Usage

Save this as `src/Cart.tsrx`. `Props`, `Row`, and `Empty` stand in for your own
type and components. `var total` and `debugger` are there on purpose, to give
the linter something to complain about on your first run.

```tsx
export function Cart({ items }: Props) @{
  var total = 0;
  debugger;

  <section class="cart">
    @if (items.length > 0) {
      @for (const item of items; key item.id) {
        <Row item={item} />
      }
    } @else {
      <Empty />
    }
  </section>
}
```

```sh
npx oxlint src/Cart.tsrx        # Check the file for mistakes.
npx oxfmt --check src/Cart.tsrx # Show what would be tidied up.
npx oxfmt --write src/Cart.tsrx # Tidy it up.
```

Give `oxlint` a path. Without one it also checks `node_modules`, the folder your
installed packages live in, and `--fix` (the flag that lets `oxlint` edit your
files) will rewrite files in there. The [CLI
reference](https://compiled.run/oxc-tsrx/reference/cli#npx-oxlint-with-no-path-also-lints-nodemodules)
has every flag.

Your `.js`, `.ts`, `.jsx`, and `.tsx` files are left alone, and go to OXC just
as they would without this package ([the numbers](docs/acceptance/matrix.md)).

## Reading a file yourself

```js
import { parseSync } from "@tsrx/oxc/parser";
```

The parser hands back the structure of your file, so you can build your own
tools on the same reader the commands use. [Parsing](https://compiled.run/oxc-tsrx/guide/parsing) has the shape it returns.

## What works today

The linter and formatter understand these TSRX blocks: `@{` blocks, `@if` /
`@else if` / `@else`, `@for` / `@empty`, `@switch` / `@case` / `@default`,
`@try` / `@pending` / `@catch`, tags whose name is an expression,
`<{expression}>`, and plain `<style>` blocks. Anything else **fails closed**:
the command stops and tells you what it found and where, rather than guessing
and maybe giving you wrong output.

**This package compiles nothing.** It never builds or runs your app. Turning
`.tsrx` into something a browser can run is a separate job, and it belongs to
your framework's TSRX plugin. See
[tsrx.dev/getting-started](https://tsrx.dev/getting-started). Without one, your
build tool reads `.tsrx` as plain TypeScript and stops at the first `@{`.

Three smaller limits: CSS inside a `<style>` block is left alone rather than
tidied, your own JavaScript lint rules see a translated copy of the file so each
one is read once more, and a tag name that itself contains markup is not
supported yet. [Limitations](https://compiled.run/oxc-tsrx/reference/limitations)
explains each one.

## In your editor

Install the official OXC extension, `oxc.oxc-vscode`. There is nothing else to
set up, and your editor underlines the same problems the terminal reports. One
catch: the TSRX toolchain's own extension owns `.tsrx`, and the OXC extension
lists no activation event for it, so it does not start on its own. Open any
JavaScript, TypeScript, or JSON file once, and `.tsrx` works for the rest of the
session. The [editor guide](https://compiled.run/oxc-tsrx/integrations/editor) has the
settings.

## Documentation

- [Introduction](https://compiled.run/oxc-tsrx/guide/introduction): what this is, in plain terms.
- [Getting started](https://compiled.run/oxc-tsrx/guide/getting-started): install, first file, first run.
- [TSRX syntax](https://compiled.run/oxc-tsrx/guide/tsrx-syntax): every supported block.
- [Configuration](https://compiled.run/oxc-tsrx/integrations/configuration): every supported setting.

## Contributing

Issues and pull requests are welcome at [the issue
tracker](https://github.com/tsrx-org/oxc/issues). The source layout and
the OXC boundary are described in [the Rust and OXC
core](https://compiled.run/oxc-tsrx/architecture/rust-oxc-core).

Join the [TSRX Discord community](https://discord.gg/HCYpT5QHQR).

## License

[MIT](LICENSE).

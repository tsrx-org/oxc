---
title: The oxc.provider protocol
description: A proposed static package.json block that would let a host find a language provider from the install alone, with the calling convention a host would follow. Implemented in this repository only.
status: proposal
---

# The `oxc.provider` protocol

A host tool cannot lint a file type it has never heard of. This page proposes
the smallest fix: one static block in a package's own `package.json`, naming the
extensions it owns and the files that handle them.

**You never have to touch any of this to use `@tsrx/oxc`.** Your `.tsrx` files
reach your linter, formatter, and editor through the `oxlint` and `oxfmt`
command names, which work whether or not a host ever reads a provider block.
[How a plain install reaches released
hosts](#how-a-plain-install-reaches-released-hosts) is that path.

What is real here is a reference implementation: `@tsrx/oxc` declares the block,
`@tsrx/oxc/provider-resolve` reads it, and this repository's editor client and
`oxlint --lsp` use it.

## Install-only discovery

Installing the package is the whole consumer action: no activation command, no
alias, no `overrides` block, no `postinstall`, and nothing written into
`node_modules` afterwards.

A host reads your direct dependencies, resolves each `package.json`, and keeps
the ones declaring an `oxc.provider` block. Direct only, because a package deep
in your tree should never change how your source is parsed, and nothing is
imported or spawned, so a malicious dependency does not get executed by being
discovered. To see the index:

```sh
npx oxc-tsrx providers --json
```

It writes nothing, and exits non-zero on a conflict.

## The contract

Nothing in the protocol knows about TSRX. If you maintain a package for another
file type, this is the whole thing:

```jsonc
{
  "oxc": {
    "provider": {
      "protocol": 1,
      "id": "tsrx",
      "languages": [
        {
          "id": "tsrx",
          "extensions": [".tsrx"],
          "capabilities": {
            "parse":  { "module": "./parser" },
            "lint":   { "bin": "oxc-tsrx-lint" },
            "format": { "bin": "oxc-tsrx-fmt" },
            "lsp":    { "bin": "oxc-tsrx-lsp" }
          }
        }
      ]
    }
  }
}
```

Four rules bound it:

- **Point only at what you publish.** `{ "module": "./sub" }` must be your own
  export subpath and `{ "bin": "name" }` your own `bin` key. No
  `node_modules/.bin` lookup, no `PATH` lookup, no alias.
- **Reserved extensions belong to the core toolchain.** Claiming
  `.js .cjs .mjs .jsx .ts .cts .mts .tsx .json .jsonc .json5 .vue .svelte .astro`
  is a hard error. That is what keeps ordinary files off provider code paths.
- **Conflicts fail loudly.** Two providers claiming one extension, or one `id`,
  is an error. Discovery never breaks a tie by install order or package name.
- **A capability target must be a leaf executor.** It handles exactly the files
  it is given and never discovers providers itself. That is why `lint` points at
  `oxc-tsrx-lint` and not at this package's `oxlint` wrapper, which would
  rediscover the same provider and recurse.

### Capability calling convention

The block says *which* file implements a capability, not how to run it. Read
this literally: **no host calls `lint` or `format` through discovery today**,
only `lsp`. What follows is what the two executors this package ships do.

Two modes, differing only in who renders the output. **Pass-through** hands over
the files, lets the executor print, and reads nothing but the exit code; every
host must support it, because the Oxlint npm wrapper cannot do better. **Collected** asks for JSON and merges it into the host's own report, and is
optional.

#### argv

```text
<executor> <file> [<file> ...]
```

An executor forwards `process.argv.slice(2)` byte for byte.

- A host **must** pass only the files the index routed here, as explicit paths.
  Walking directories is the host's job, and an executor given no file exits 2.
- A host **must not** pass its own rendering, reporting, or config flags. An
  unknown option is a hard error rather than an ignored flag, so forwarding a
  host command line breaks providers at random.

#### Output

An executor inherits the stdio it is handed and does not buffer or reshape it.
In pass-through the host reads nothing, so expect two report footers, one per
engine, and a provider half that ignores the host's format flag.

In collected mode the host adds one format flag and parses stdout. This
package's `lint` executor answers `--format json` with one JSON document:

```jsonc
{
  "diagnostics": [
    {
      "filename": "/abs/path/View.tsrx",
      "rule": "no-debugger",
      "code": "eslint(no-debugger)",
      "severity": "error",
      "message": "…",
      "labels": [{ "span": { "offset": 120, "length": 8 }, "message": "…" }]
    }
  ],
  "number_of_files": 1,
  "number_of_rules": 97,
  "oxcTsrx": { }
}
```

Merge by concatenating `diagnostics` and summing `number_of_files`. Spans are
byte offsets into the file you wrote, so line and column are the host's to
resolve. Collected mode is optional, so a host that wants it falls back when the
flag is rejected.

#### Exit codes

In pass-through mode this is the only thing the host reads.

| Code | Meaning | What a host should do |
| --- | --- | --- |
| `0` | Ran to completion with nothing that fails the run | Nothing. In collected mode, parse and merge stdout |
| `1` | Findings: an `error` diagnostic, a promoted warning, or `--check` differences | Fail the run, and still merge stdout |
| `2` | The executor or its tool broke | Fail the run. Do not parse stdout. Surface stderr |
| other | Passed through from the native tool | Treat as breakage, not findings |

Several capabilities means the worst outcome wins, and exit `0` does not mean
"no diagnostics", since warnings alone exit `0`.
`tests/packaging/toolchain-package.test.mjs` pins all of it.

## Using the resolver

The resolver mentions no individual provider, so another host can vendor it
unchanged.

```js
import {
  discoverProviders,
  resolveCapability,
} from "@tsrx/oxc/provider-resolve";

const index = await discoverProviders({ root: process.cwd() });
const server = resolveCapability(index, "src/View.tsrx", "lsp");
```

`resolveCapability` returns `null` for every extension the index does not own,
which is the fast path ordinary `.ts` and `.js` files take.

**If you inject `resolve`, inject `readFile` from the same layer.** This is the
one thing adopters get wrong. Under Yarn Plug'n'Play packages stay zipped, and
`.pnp.cjs` answers with a path *into* the archive that an ordinary `fs.readFile`
cannot open, so a host that injects `pnp.resolveRequest` and reads with plain
`fs` resolves every manifest and reads none of them. Each one records an
`unreadable-manifest` warning and skips only that package.

Every package manager lane installs from a local registry, builds the index,
deletes the install tree, reinstalls frozen, and requires a byte-identical
index: npm, pnpm, Bun, and Yarn Berry with both linkers, in
`tests/packaging/provider-matrix.test.mjs`. Yarn Classic and Windows are not
covered.

## Which hosts read the index

None of these are released OXC builds.

| Host | Capability | What it does |
| --- | --- | --- |
| `oxc-tsrx-vscode`, this repository's editor client | `lsp` | Discovers once per workspace folder, and starts one language client per discovered capability, lazily, on the first document that provider claims. |
| `oxlint --lsp` from this package | `lsp` | Registers only the discovered extensions, keeps every other document on official Oxlint. |
| `oxc-tsrx providers` | none | Reports the index. |

The `parse`, `lint`, and `format` targets are correct but unused. Do not read
four declared capabilities as four working integrations.

## How a plain install reaches released hosts

No released host discovers providers, so nothing here is part of the protocol,
and a new provider should not copy it.

**The `oxlint` and `oxfmt` bin names** are how a plain install works today.
Your installer links them into `node_modules/.bin`, and released
`oxc.oxc-vscode` 1.59.0 probes `<folder>/node_modules/.bin/oxlint` first.

Two packages cannot own one command name, and installers disagree about the
winner: with `@tsrx/oxc` and official `oxlint` in one project, npm 11 links this
package's launcher and pnpm 10 links the official one. So the launcher reads the
nearest `package.json` and decides for itself.

<!-- chooser -->

| What your project's `package.json` says | What `oxlint` and `oxfmt` then run |
| --- | --- |
| It declares `oxlint` or `oxfmt` itself | That pinned binary, unchanged. Adding `@tsrx/oxc` cannot alter what a pinned project's lint command does. To lint `.tsrx` there, run `oxc-tsrx-lint` and `oxc-tsrx-fmt` |
| It declares neither | TSRX support, through this package. Ordinary files run canonical Oxlint or Oxfmt: the newer of the official package installed in the project, whether or not it is declared, and the copy this package vendors. A configuration written for the project's Oxlint is never rejected by an older pin ([#105](https://github.com/tsrx-org/oxc/issues/105)). A transitive official `oxlint`, such as the one Vite+ brings, is still not a declaration of the command name |
| It declares one that is not installed | Nothing. The launcher exits 2 rather than guess which binary you meant |

**`oxc-tsrx setup`** is the genuine shim, and only Vite+ needs it: Vite+ resolves
a *package* named `oxlint`, which a bin name cannot answer. Having to rerun it
after a clean install is the clearest sign it is a shim rather than the target
design, because install-only discovery has nothing to rerun.
[Try it with Vite+](/guide/getting-started#try-it-with-vite) has the command.

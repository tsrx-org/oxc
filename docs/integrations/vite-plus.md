---
title: Walkthrough (Vite+)
description: From an empty folder to a .tsrx file caught by a lint rule you wrote, with your editor flagging the same thing.
---

# Walkthrough (Vite+)

Your framework's TSRX plugin runs your app, so `vp build` and `vp dev` use that,
not this package. `@tsrx/oxc` does the other job, checking your code rather than
running it, so `vp lint`, `vp fmt`, and `vp check --fix` read `.tsrx` instead of
skipping past it.

Five steps, one command each.

## 1. Get the `vp` command

`vp` is the Vite+ command line, and it ships in the `vite-plus` package. Install
it in an empty folder, since step 2 creates the project inside it. Do not reach
for `npx vp`: `vp` on npm is somebody else's package.

<!-- pm-install -->
```sh
mkdir tsrx-vp-demo && cd tsrx-vp-demo
npm install vite-plus
export PATH="$PWD/node_modules/.bin:$PATH"
```

Keep the `export`. `vp create` calls `vp` again by bare name, so without it you
get a scaffolded app and no `node_modules`.

## 2. Example React app

```sh
vp create vite --no-git --no-agent --no-editor --no-interactive --approve-builds \
  -- my-app --template react-ts --no-eslint
cd my-app
```

What you get is an ordinary React and TypeScript app that knows nothing about
`.tsrx` yet.

## 3. Add the linter and the editor toolchain

```sh
vp install -D @tsrx/oxc@latest oxlint-tsgolint@latest \
  @tsrx/typescript-plugin @tsrx/react
```

`vp install`, not `npm install`: inside a Vite+ project your own package manager
often refuses to run at all.
[`EBADDEVENGINES`](#when-something-goes-wrong) is why.

Four packages. The first two are what lints `.tsrx`; the last two
belong to the TSRX toolchain rather than to `@tsrx/oxc`, and without them
`vp lint` still works while your editor stays blank.

- **[`@tsrx/oxc`](https://github.com/tsrx-org/oxc "brand:oxc-tsrx")** is
  this package, and it is what teaches `oxlint` and `oxfmt` to read `.tsrx` at
  all.
- **[`oxlint-tsgolint`](https://github.com/oxc-project/tsgolint "brand:oxc")** is
  the type-aware lint engine a `vp create` React project turns on. `@tsrx/oxc`
  speaks one protocol version, and [a mismatch](#when-something-goes-wrong)
  stops `.tsrx` linting.
- **[`@tsrx/typescript-plugin`](https://tsrx.dev "brand:tsrx")** is what gives
  your editor types inside `.tsrx`. Step 4 is where you declare it.
- **[`@tsrx/react`](https://tsrx.dev "brand:react")** is this template's
  framework binding. Swap it for `@tsrx/vue`, `@tsrx/solid`, `@tsrx/preact`,
  `@tsrx/ripple`, or `octane` if you scaffolded something else.

One command, not four: step 4 writes inside `node_modules`, and anything
installed after it quietly undoes what it did.

<!-- details:If the install stops over peer dependencies -->

`@tsrx/typescript-plugin` declares peers a current scaffold does not satisfy,
starting with [`typescript`](https://www.typescriptlang.org "brand:typescript")
`^5.9.3` against the TypeScript 6 the scaffold just gave you. What happens next
depends on which package manager `vp install` forwards to — it uses your
project's own manager, not a fixed one:

- **pnpm** (and Bun) record the mismatch as a warning and finish the install.
  Measured with pnpm 10: all four packages land, exit 0, nothing else to do.
- **npm** stops the whole install with `ERESOLVE`. Re-run with the flag npm's
  own error message names, forwarded through the bare `--` so `vp install`
  hands it to npm instead of reading it itself:

  ```sh
  vp install -D @tsrx/oxc@latest oxlint-tsgolint@latest \
    @tsrx/typescript-plugin @tsrx/react -- --legacy-peer-deps
  ```

  `--legacy-peer-deps` is npm's, not pnpm's: under pnpm it fails as an unknown
  option, which is why the command above does not carry it.

Keeping TypeScript 6 is the point either way. Every step here was run on 6.0.3,
and `vp lint` reports both files exactly as step 5 shows. `setup` does mention
that 6 is outside the plugin's declared range; that note is expected rather
than something to fix.

<!-- /details -->

## 4. Run `setup`, and let it declare the plugin

One command does two things:

```sh
vp exec oxc-tsrx setup --write-tsconfig
```

Vite+ finds its linter and formatter by package name, and `setup` puts
`@tsrx/oxc` in those two slots. `--write-tsconfig` adds the
[TypeScript](https://www.typescriptlang.org "brand:typescript") plugin your
editor needs to the tsconfig that owns your source. It prints what it did:

<!-- setup-report -->
```text
- oxc-parser: active
- oxlint: active
- oxfmt: active
- oxc.path.oxlint: unnecessary (editor)
- tsconfig.app.json: written (tsconfig)
```

Run this after every install, never before one. If an install does land on top
of it, see [when something goes wrong](#when-something-goes-wrong).

<!-- details:What --write-tsconfig writes, and where -->

It adds this under `compilerOptions`:

```json
"plugins": [{ "name": "@tsrx/typescript-plugin" }],
```

The line above says `tsconfig.app.json` rather than `tsconfig.json` because a
scaffold's root config only points at other configs and owns no files itself, so
a plugin declared there does nothing. `--write-tsconfig` follows the reference to
the project that actually holds your source.

It splices that one entry in and leaves every other byte alone, comments
included. Drop the flag and `setup` goes back to only telling you the entry is
missing. If your `compilerOptions` already has a `plugins` list, it says so
instead of appending to a list it did not write.

<!-- /details -->

## 5. Add a `.tsrx` file and lint it

Five files: two components, a lint rule of your own that catches both, and the
two config files that point at it. `tar` only writes them, nothing is executed,
and every one of them is listed below:

```sh
curl -sL https://github.com/tsrx-org/oxc/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=4 oxc-main/examples/custom-js-plugins/vite-plus

vp lint
```

<!-- filetree:examples/custom-js-plugins/vite-plus -->

A working setup reports your own rule twice, once from each component:

<!-- terminal-demo:custom-plugins-vp-cli -->

The `.tsrx` line is the one that proves it: without `@tsrx/oxc` that file is not
linted at all. If only the `.tsx` line appears, see [`vp lint` reports `.tsx` and
skips `.tsrx`](#when-something-goes-wrong).

The five files live in
[`examples/custom-js-plugins/vite-plus`](https://github.com/tsrx-org/oxc/tree/main/examples/custom-js-plugins/vite-plus),
where CI runs four of them on every change. [Custom JavaScript
plugins](/integrations/custom-js-plugins#in-a-vite-project) builds them up one
at a time.

<!-- details:Why the recording runs oxlint rather than vp lint -->

Recordings on this site are captured when the site is built, and that build has
no Vite+ in it, so the run above calls `@tsrx/oxc`'s own `oxlint` on the same
files instead. `vp lint` reaches the same linter through Vite+ and prints the
same two diagnostics at the same positions. That was measured on a real
scaffold; it is just not something the build can record for you.

<!-- /details -->

## 6. Make the editor agree

Steps 3 and 4 install and declare what the editor needs. Two things are left,
and both are outside `@tsrx/oxc`. They are the same two extensions [Getting
Started](/guide/getting-started#in-your-editor) asks for, repeated here so you
do not have to go back. **If you installed them there, you are already done.**

Install the official OXC extension. That is what gives `.tsrx` diagnostics,
formatting, and quick fixes:

<!-- extension:oxc -->

One catch: it does not start on a `.tsrx` file. Open any JavaScript, TypeScript,
or JSON file once, and `.tsrx` works for the rest of the session.

Syntax highlighting and types are a different job, owned by the TSRX toolchain
rather than by `@tsrx/oxc`. Its extension is what provides them:

<!-- extension:tsrx -->

That is the whole setup. The TSRX extension brings its own language server and
finds a TypeScript to run it against on its own, so there is nothing to point at
and no setting to add.

If the editor still shows nothing, `oxc-tsrx status` lists every prerequisite it
can see. An empty list means the gap is on the editor's side, not your
project's. [The editor page](/integrations/editor) covers both extensions in
full.

The `setup` report back in step 4 says `unnecessary (editor)` because this
walkthrough's tree needs no setting at all. `setup` checks that rather than
assuming it: it replays the extension's own lookup from `my-app` and from every
folder above it that looks like a workspace root, and if one of them would run a
different `oxlint` the report says `inert (editor)` and names it. When `setup`
does write `oxc.path.oxlint`, open the folder holding that
`.vscode/settings.json`, meaning `my-app` itself: VS Code reads the file only
from the folder you open, so opening a folder above it makes the key inert and
`status` says so. [When the key does not take
effect](/integrations/editor#when-the-key-does-not-take-effect) has the rest.

<!-- details:When typescript.tsdk actually matters -->

Not for `.tsrx` files. Version 2.0.69 of the TSRX extension ships its own
language server and picks a TypeScript through Volar's usual lookup, falling
back to the copy bundled with VS Code when your workspace has no
`typescript.tsdk` set. It registers no TypeScript server plugin, so nothing
about `.tsrx` editing depends on which TypeScript your editor chose.

The setting matters for the other direction: an ordinary `.ts` or `.tsx` file
importing a `.tsrx` module is typed by VS Code's own TypeScript service, and a
plugin declared in `tsconfig.json` loads there only when the editor runs your
project's TypeScript rather than its bundled copy. If those imports come back
untyped, set `"typescript.tsdk"` to `"node_modules/typescript/lib"` in
`.vscode/settings.json` and run *TypeScript: Select TypeScript Version*.
`setup` merges only its own key into that file, so the two coexist.

<!-- /details -->

## Adding this to a project you already have

If your project is not on Vite+ yet, these two lines add Vite+ and this package,
and the walkthrough above is the rest:

<!-- pm-install -->
```sh
npm install --save-dev vite-plus @tsrx/oxc@latest
npx oxc-tsrx setup
```

If it is already a Vite+ project, use `vp install -D` and `vp exec` instead.

## When something goes wrong

Three things go wrong often enough to name. Pick what you saw rather than
reading all three.

<!-- chooser -->

| What did you see? | What it means |
| --- | --- |
| `EBADDEVENGINES` | A `vp create` scaffold pins the exact version of whichever package manager made it, in `devEngines`, and a switcher like fnm or nvm makes it easy to be on a different one. Installs and `npx` in that directory then stop before doing anything. `onFail: "download"` reads like it should fetch the right version; it does not. Use `vp install` and `vp exec` rather than your own manager: they run against the manager Vite+ manages, so the pin is always satisfied. |
| `vp lint` reports `.tsx` and skips `.tsrx` | This package speaks one `oxlint-tsgolint` protocol version and refuses the rest, so your ordinary files keep linting while your `.tsrx` files quietly stop. The last line of the run names both versions: `unsupported tsgolint version <theirs>; OXC for TSRX requires oxlint-tsgolint <ours> for protocol v2`. Install the version it names, in the same `vp install` as `@tsrx/oxc` and before `setup`. |
| `refusing to replace unowned package slot(s)` | An install landed after `setup` and rewrote `node_modules`, taking the slots with it. `setup` will not silently reclaim a slot it no longer owns, and installing on top of the old tree does not free it. Rebuild the tree with `rm -rf node_modules`, then `vp install`, then `vp exec oxc-tsrx setup`. An official `oxlint` or `oxfmt` you declare yourself is never refused: it is reported as `collision`, left alone, and `setup` goes on to write the editor slot. |

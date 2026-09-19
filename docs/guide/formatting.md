---
title: Formatting
description: How @tsrx/oxc formats .tsrx files with real Oxfmt layout and converts the result back to TSRX.
---

# Formatting

`oxfmt` formats your `.tsrx` files with OXC's real formatter, then converts the
result back into TSRX. Ordinary JS/TS files go straight to Oxfmt, and the output
is byte-for-byte identical to running `oxfmt` yourself.

## Input and output

Here is one of the files this project tests against, exactly as it is committed
before formatting:

```tsrx
type Item={id:string;label:string};export function Rows({items}:{items:Item[]})@{<ul>@for(item of items;index i;key item.id){<li data-index={i}>{item.label}</li>}@empty{<li>Empty</li>}</ul>}
```

becomes:

```tsrx
type Item = { id: string; label: string };
export function Rows({ items }: { items: Item[] }) @{
  <ul>
    @for (item of items; index i; key item.id) {
      <li data-index={i}>{item.label}</li>;
    } @empty {
      <li>Empty</li>;
    }
  </ul>;
}
```

Both files are committed fixtures, and the test suite formats the first one and
compares it against the second on every run, so this is real output rather than
a hand-written example. You can read them in
[tests/fixtures/control](https://github.com/tsrx-org/oxc/tree/main/tests/fixtures/control).

## How a format run works

<!-- pipeline:format -->

Four steps:

1. **Copy.** Build a valid TSX copy, the same idea as
   [linting](/guide/linting), except the placeholders here are markers designed
   to survive formatting.
2. **Format.** Oxfmt parses and formats that copy, once per pass.
3. **Convert back.** Markers become `@if`, `@for`, `@switch`, and `@try` again,
   and your code keeps its new formatting.
4. **Check.** The result is re-read and compared against the original. If the
   structure does not match, the tool errors out instead of writing a broken
   file.

If a pass changed the file, the result is formatted once more before it is
returned, and the settled output wins. Oxfmt is not idempotent on every input:
with the default `objectWrap: "preserve"`, an object literal that the first
pass breaks leaves a newline after `{` that a second pass reads as an authored
expansion, and an enclosing member chain can then pick a different layout
([#93](https://github.com/tsrx-org/oxc/issues/93),
[oxc#23852](https://github.com/oxc-project/oxc/issues/23852)). Settling means
one `--write` leaves nothing for `--check` to find. An already-formatted file
costs one pass; a file that changed costs two, and `pass_count` in the format
metadata says how many were taken. The one exception is CR-terminated output,
which is returned as the single pass produced it, because Oxfmt reads a lone CR
inside JSX text as ordinary whitespace and re-formatting would insert `{" "}`
around expression children.

Two things are carried over rather than reformatted: dynamic closing tags are
rebuilt from their opening expression, and whatever is inside a raw `<style>`
block is copied from your file untouched.

## Usage

<!-- terminal-demo:formatting-usage -->

Writes are transactional: every file in the batch must format successfully
before the first one is replaced on disk, so a crash or bad file never leaves
your project half-formatted. Symbolic links are rejected.

## Configuration

Your `.oxfmtrc.json` works as usual. `oxfmt` searches upward from the current
directory to find it, or takes a `--config` path, and the layout options you
already use all apply: `printWidth`, `singleQuote`, `semi`, `tabWidth`,
`trailingComma`, and the rest, plus `overrides` and `ignorePatterns`.
[Configuration](/integrations/configuration) has the full list.

A few options are refused with a clear error before anything is written,
because they would change `.tsrx` output in ways this project cannot yet
guarantee: `sortTailwindcss`, embedded-language formatting, experimental
flags apart from the `experimentalSortImports` alias, `.editorconfig`,
and JS or TS config files.

### Sorting imports and formatting JSDoc

`sortImports` and `jsdoc` both work on `.tsrx`, with the same values Oxfmt
already takes: `true`, `false`, or an object of sub-options.

`sortImports` reorders your import statements. It sorts each run of
back-to-back imports on its own, so a run that sits below a component never
climbs above it. `true` gets Oxfmt's defaults, and the object form takes
`groups`, `customGroups`, `newlinesBetween`, `order`, `ignoreCase`,
`internalPattern`, and the rest. Oxfmt's older `experimentalSortImports`
spelling is read as an alias for the same option.

`jsdoc` reflows your `/** ... */` doc comments: it collapses runs of spaces,
capitalizes descriptions, and lines up `@param` and `@returns` tags. `true`
gets Oxfmt's defaults, and the object form takes `commentLineStrategy`,
`lineWrappingStyle`, `descriptionWithDot`, `separateTagGroups`, and the rest.

```json
{
  "sortImports": true,
  "jsdoc": { "commentLineStrategy": "multiline" }
}
```

Both options work the same way on `.ts` and `.tsx` files, where the output is
byte-for-byte what stock Oxfmt produces. A misspelled sub-option or an
unusable value is refused with an error rather than quietly ignored.

A dynamic tag's expression is restored from the bytes you wrote, not
reprinted. A comment written inside a closing tag's braces (`</{Tag /* note */}>`)
has no home there once the tag is restored, so it is moved in front of the tag
as a comment-only child, `{/* note */}`, and formatted like any other comment,
including by `jsdoc`.

## CSS inside `<style>` is preserved, not formatted

Bytes inside a raw `<style>` element are copied through exactly as you wrote
them. The upstream OXC CSS formatter currently can't be used without patching
OXC's dependency graph, and this project's core rule is *no patches*, so CSS
formatting waits until upstream exposes a clean package boundary.

## How we know it is safe

This is tested against a real TSRX codebase, not just fixtures. All 179 valid
files format, re-parse, and settle, meaning formatting an already-formatted file
changes nothing. All 12 broken files are rejected rather than mangled, and every
raw `<style>` block comes out byte for byte identical.

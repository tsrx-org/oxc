// The oracle for the "Try in playground" button.
//
// docs/build.mjs puts that button on every ```tsrx fence, and clicking it
// hands the fence bytes straight to the same native binaries the playground
// runs (docs/serve.mjs apiLint and apiFormat). So a fence the engines reject
// is a button that lands the reader on a parse error, which is exactly how
// `@catch (error; reset)` shipped on the syntax page: a one-character typo no
// test could see, because nothing ever ran the samples.
//
// This file runs them. A sample that is deliberately not a whole file, or is
// showing what invalid TSRX looks like, opts out of the button with
// ```tsrx no-playground and is skipped here too.
//
// It lives in `pnpm test` rather than `test:site:unit` because it needs the
// release binary, and the site workflow deliberately builds no Rust
// (.github/workflows/site-artifact.yml).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const docs = join(root, "docs");
// Same resolution order as tests/plugins/custom-js-plugins-doc.test.mjs.
const binary = resolve(process.env.OXLINT_BIN ?? join(root, "target/release/oxc-tsrx"));
// Build output, not source: docs/dist holds a copy of every page.
const skipped = new Set(["dist", "node_modules"]);

function run(args, input) {
  return new Promise((resolveRun) => {
    const child = execFile(
      binary,
      args,
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolveRun({ code: error?.code ?? 0, stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

async function markdownFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}

// The fence rule build.mjs applies: the info string's first word is the
// language, the rest are flags.
async function playgroundFences() {
  const found = [];
  for (const file of await markdownFiles(docs)) {
    const text = await readFile(file, "utf8");
    const pattern = /^```([^\n]*)\r?\n([\s\S]*?)^```[ \t]*$/gm;
    for (const match of text.matchAll(pattern)) {
      const [language, ...flags] = match[1].trim().split(/\s+/);
      if (language !== "tsrx" || flags.includes("no-playground")) continue;
      found.push({
        where: `${relative(root, file)}:${text.slice(0, match.index).split("\n").length}`,
        source: match[2],
      });
    }
  }
  return found;
}

const fences = await playgroundFences();

test("the native binary the playground runs is built", () => {
  assert.ok(
    existsSync(binary),
    `missing ${binary}. Build it with:\n  cargo build --release --locked -p oxc_tsrx_cli --bins\nor point OXLINT_BIN at an existing binary.`,
  );
});

test("the docs still carry samples for the button to send", () => {
  assert.ok(fences.length > 0, "no ```tsrx fence in docs/ offers the button");
});

for (const fence of fences) {
  test(`the playground lints ${fence.where}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "oxc-tsrx-snippet-"));
    try {
      // Byte-for-byte what the playground does with the pasted fence.
      const file = join(dir, "demo.tsrx");
      await writeFile(file, fence.source);
      const { code, stdout, stderr } = await run(["--format=json", file]);
      assert.ok(
        code !== 2 && stdout.trim().startsWith("{"),
        `${fence.where} carries the "Try in playground" button but the engine refuses it:\n` +
          `  ${(stderr.trim() || stdout.trim() || "lint failed").split("\n")[0]}\n` +
          "Fix the sample, or drop the button with ```tsrx no-playground.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`the playground formats ${fence.where}`, async () => {
    const { code, stderr } = await run(
      ["fmt", "--stdin-filepath=demo.tsrx"],
      fence.source,
    );
    assert.equal(
      code,
      0,
      `${fence.where} reaches the playground's Format button but the formatter refuses it:\n` +
        `  ${(stderr.trim() || "format failed").split("\n")[0]}\n` +
        "Fix the sample, or drop the button with ```tsrx no-playground.",
    );
  });
}

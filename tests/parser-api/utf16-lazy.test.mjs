import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { scriptNode } from "../helpers/script-node.mjs";
import { removeAddonFixture } from "./addon-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");

function run(executable, args) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      args,
      { cwd: root, env: process.env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
        else resolveRun({ stdout, stderr });
      },
    );
  });
}

async function withParser(callback) {
  const temporary = await mkdtemp(join(tmpdir(), "oxc-tsrx-utf16-lazy-"));
  const previous = process.env.OXC_TSRX_PARSER_ADDON;
  try {
    const addon = join(temporary, "parser.node");
    await run(scriptNode(), [
      "scripts/build-parser-native.ts",
      "--skip-build",
      "--out",
      addon,
    ]);
    process.env.OXC_TSRX_PARSER_ADDON = addon;
    const parser = await import(`../../packages/toolchain/dist/parser.js?utf16=${Date.now()}`);
    return await callback(parser);
  } finally {
    if (previous === undefined) delete process.env.OXC_TSRX_PARSER_ADDON;
    else process.env.OXC_TSRX_PARSER_ADDON = previous;
    await removeAddonFixture(temporary);
  }
}

function findNode(rootValue, type) {
  const pending = [rootValue];
  const seen = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (value.type === type) return value;
    if (Array.isArray(value)) pending.push(...value);
    else pending.push(...Object.values(value));
  }
  return null;
}

test("the Node boundary preserves astral offsets and opaque lone surrogate halves exactly", async () => {
  await withParser(async ({ parse, parseSync }) => {
    const unicode = "/*😀*/ import x from \"m😀\";\r\nexport function Viéw() @{ <main title=\"é😀\">T😀</main> }";
    const unicodeResult = parseSync("Unicode.tsrx", unicode);
    assert.equal(unicodeResult.errors.length, 0);
    assert.equal(unicodeResult.program.start, 0);
    assert.equal(unicodeResult.program.end, unicode.length);
    assert.equal(unicodeResult.comments[0].start, 0);
    assert.equal(unicodeResult.comments[0].end, 6);
    assert.equal(unicodeResult.comments[0].value, "😀");
    assert.equal(unicodeResult.module.staticImports[0].moduleRequest.value, "m😀");
    assert.equal(findNode(unicodeResult.program, "JSXText").value, "T😀");

    for (const unit of [0xd800, 0xdc00]) {
      const surrogate = String.fromCharCode(unit);
      const source = `/*c${surrogate}*/ const value="q${surrogate}"; function View() @{ <main>x${surrogate}<style>.x{content:"s${surrogate}"}</style></main> }`;
      const sync = parseSync("Opaque.tsrx", source);
      const asyncResult = await parse("Opaque.tsrx", source);
      assert.equal(sync.errors.length, 0);
      assert.equal(asyncResult.errors.length, 0);
      assert.equal(sync.comments[0].value.charCodeAt(1), unit);
      assert.equal(findNode(sync.program, "Literal").value.charCodeAt(1), unit);
      assert.equal(findNode(sync.program, "JSXText").value.charCodeAt(1), unit);
      assert.ok(findNode(sync.program, "JSXStyleElement").css.includes(surrogate));
      assert.deepEqual(asyncResult.program, sync.program);
      assert.deepEqual(asyncResult.module, sync.module);
      assert.deepEqual(asyncResult.comments, sync.comments);
      assert.deepEqual(asyncResult.errors, sync.errors);
    }
  });
});

test("TypeScript fields reconstructed inside TSRX bodies keep authored UTF-16 spans", async () => {
  await withParser(async ({ parseSync }) => {
    const source =
      "/*😀*/ export function View(props: { value: string }) @{ const label: string = props.value; <p>{label}</p> }";
    const result = parseSync("TypedUnicode.tsrx", source, {
      lang: "tsrx",
      astType: "ts",
    });

    assert.equal(result.errors.length, 0);
    const annotation = findNode(result.program, "TSTypeAnnotation");
    const labelStart = source.indexOf("label: string");
    const annotationStart = labelStart + "label".length;
    assert.deepEqual(
      [annotation.start, annotation.end],
      [annotationStart, annotationStart + ": string".length],
    );
    const keyword = findNode(annotation, "TSStringKeyword");
    assert.deepEqual(
      [keyword.start, keyword.end],
      [annotationStart + ": ".length, annotationStart + ": string".length],
    );
  });
});

test("JSX block comments inside keyed TSRX loops have authored spans", async () => {
  await withParser(async ({ parseSync }) => {
    const source =
      "function ItemList({ items }) @{\n\t<ul>\n\t\t@for (const item of items; key item.id) {\n\t\t\t{\n\t\t\t\t/* distinct */\n\t\t\t}\n\t\t\t<li>x</li>\n\t\t}\n\t</ul>\n}";
    const result = parseSync("CommentedLoop.tsrx", source, {
      lang: "tsrx",
      astType: "ts",
    });

    assert.equal(result.errors.length, 0);
    const commentStart = source.indexOf("/* distinct */");
    assert.equal(findNode(result.program, "EmptyStatement"), null);
    assert.equal(result.comments.length, 1);
    assert.deepEqual(
      [result.comments[0].start, result.comments[0].end],
      [commentStart, commentStart + "/* distinct */".length],
    );
  });
});

test("active lone surrogates fail closed at their exact UTF-16 unit and null is cached", async () => {
  await withParser(async ({ parse, parseSync }) => {
    for (const unit of [0xd800, 0xdc00]) {
      const surrogate = String.fromCharCode(unit);
      const source = `const value=${surrogate};`;
      const result = parseSync("Active.tsrx", source);
      const descriptorsBefore = Object.fromEntries(
        ["program", "module", "comments", "errors"].map((name) => [
          name,
          Object.getOwnPropertyDescriptor(result, name),
        ]),
      );
      const errors = result.errors;
      assert.equal(result.program, null);
      assert.equal(result.program, null);
      assert.equal(result.module, null);
      assert.equal(result.module, null);
      assert.equal(result.errors, errors);
      assert.equal(errors[0].message, "unexpected unpaired UTF-16 surrogate in active syntax");
      assert.deepEqual(
        [errors[0].labels[0].start, errors[0].labels[0].end],
        [12, 13],
      );
      assert.ok(errors[0].codeframe.includes(surrogate));
      for (const descriptor of Object.values(descriptorsBefore)) {
        assert.equal(descriptor.enumerable, true);
        assert.equal(descriptor.configurable, true);
        assert.equal(typeof descriptor.get, "function");
        assert.equal(descriptor.set, undefined);
        assert.equal(Object.hasOwn(descriptor, "writable"), false);
      }

      const asyncResult = await parse("Active.tsrx", source);
      assert.equal(asyncResult.program, null);
      assert.equal(asyncResult.module, null);
      assert.deepEqual(asyncResult.errors, errors);
    }
  });
});

test("unavailable raw transport fails before parsing with a stable operational code", async () => {
  await withParser(async ({ ParserOperationalError, parseSync }) => {
    assert.throws(
      () => parseSync("x.js", "let x", { experimentalRawTransfer: true }),
      (error) =>
        error instanceof ParserOperationalError &&
        error.code === "ERR_TSRX_CAPABILITY_RAW_TRANSFER",
    );
  });
});

test("editor recovery returns authored partial programs through sync and async APIs", async () => {
  await withParser(async ({ parse, parseSync }) => {
    const source = "export function View() @{";
    const sync = parseSync("View.tsrx", source, { recovery: "editor" });
    assert.notEqual(sync.program, null);
    assert.equal(sync.program.end, source.length);
    assert.ok(sync.errors.length > 0);

    const asyncResult = await parse("View.tsrx", source, { recovery: "editor" });
    assert.deepEqual(asyncResult, sync);
  });
});

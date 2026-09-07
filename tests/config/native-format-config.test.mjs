import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
// One multi-call native binary carries the linter, the formatter, and the
// language server; `fmt` selects the formatter.
const binary = resolve(process.env.OXFMT_BIN ?? join(root, "target/release/oxc-tsrx"));
// pnpm installs `oxfmt-current` under the package that declares it, so it is
// resolved from this file's own package instead of from a hoisted
// repository-root `node_modules`.
const stock = join(
  dirname(createRequire(import.meta.url).resolve("oxfmt-current/package.json")),
  "bin/oxfmt",
);

function run(executable, cwd, args, input = null) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    // Several tests here assert that the command rejects a config *before* it
    // reads stdin, so the child is expected to be gone by the time this write
    // lands. Losing that race is the behaviour under test, not a harness
    // failure: report what the child did and let the assertions judge it. Any
    // other stdin error is real and still rejects.
    child.stdin.once("error", (error) => {
      if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_DESTROYED") reject(error);
    });
    child.stdin.end(input ?? undefined);
  });
}

function runFormat(cwd, args, input = null) {
  return run(binary, cwd, ["fmt", ...args], input);
}

// The published drop-in `oxfmt` command, which runs canonical Oxfmt and the
// native TSRX formatter and has to merge their two reports into one.
const companion = resolve(join(root, "packages/toolchain/bin/oxfmt"));

function runCompanion(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [companion, ...args], {
      cwd,
      env: { ...process.env, OXC_TSRX_FORMAT_BIN: binary },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

// The same command with stdin attached, which is the editor format-on-save path.
function runCompanionStdin(cwd, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [companion, ...args], {
      cwd,
      env: { ...process.env, OXC_TSRX_FORMAT_BIN: binary },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

// --- Comparing a TSRX report against a live stock Oxfmt control -----------
//
// Nothing below hardcodes a canonical sentence. Every fixture is written twice,
// once as `.tsrx` and once as an ordinary `.ts` file of the same base name and
// the same cleanliness, so the two reports are the same report about the same
// batch and can be compared field by field. Durations, thread counts, and the
// extension are the only things normalised away.

function normalizeSummary(line) {
  return line
    .replace(/\bin [0-9.]+\s*(?:ms|s|m)\b/u, "in <duration>")
    .replace(/\busing \d+ threads\b/u, "using <threads> threads");
}

function normalizeReportPath(line) {
  return basename(line.replace(/ \(\d+ms\)$/u, "")).replace(/\.(?:tsrx|ts)$/u, "");
}

/// Split an Oxfmt report into its parts. A report truncated by a failing file
/// carries the paths that differ and nothing else: no verdict, no file count.
function parseReport(stdout) {
  const separator = stdout.indexOf("\n\n");
  if (separator <= 0 || stdout.slice(0, separator).includes("\n")) return null;
  const preamble = stdout.slice(0, separator);
  const body = stdout.slice(separator + 2);
  let files;
  let verdict = null;
  let summary = null;
  if (body.endsWith("\n")) {
    const lines = body.slice(0, -1).split("\n");
    summary = normalizeSummary(lines.pop());
    verdict = lines.pop();
    if (lines.at(-1) === "") lines.pop();
    files = lines;
  } else {
    files = body === "" ? [] : body.split("\n");
  }
  return { preamble, verdict, summary, files: files.map(normalizeReportPath).sort() };
}

function lastLine(text) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.at(-1) ?? "";
}

const FIXTURES = {
  clean: { ts: "export const value = 1;\n", tsrx: "export function Clean() @{\n  <p>a</p>;\n}\n" },
  dirty: {
    ts: "export   const  other=2\n",
    tsrx: "export function Dirty( ) @{\n     let x   = 1;\n  <p>b</p>;\n}\n",
  },
  broken: {
    ts: "const unclosed = ((\n",
    tsrx: "export function Broken() @{\n  let x = 1;\n  <main>\n    <h1>hi</h1>\n}\n",
  },
};

/// Write `names` into a fresh directory, choosing the `.tsrx` spelling for the
/// names listed in `tsrx` and the ordinary `.ts` spelling for the rest.
async function fixtureDirectory(label, names, tsrx = []) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), `oxc-tsrx-format-${label}-`)));
  await mkdir(join(cwd, "src"));
  const paths = {};
  for (const [name, kind] of Object.entries(names)) {
    const extension = tsrx.includes(name) ? "tsrx" : "ts";
    paths[name] = join(cwd, "src", `${name}.${extension}`);
    await writeFile(paths[name], FIXTURES[kind][extension]);
  }
  return { cwd, paths };
}

test("one unparseable .tsrx leaves the rest of the batch reported, as canonical Oxfmt does", async () => {
  const control = await fixtureDirectory("batch-control", {
    a: "clean",
    b: "dirty",
    c: "broken",
  });
  const candidate = await fixtureDirectory(
    "batch-candidate",
    { a: "clean", b: "dirty", c: "broken" },
    ["a", "b", "c"],
  );
  const order = (paths) => [paths.a, paths.b, paths.c];

  const [stockResult, nativeResult] = await Promise.all([
    run(stock, control.cwd, ["--check", ...order(control.paths)]),
    runFormat(candidate.cwd, ["--check", ...order(candidate.paths)]),
  ]);

  // Canonical Oxfmt reports the file it could not parse next to the results of
  // the files it could, and exits 2. Before this fix the whole TSRX batch was
  // discarded on the first failure, so `b` never appeared at all.
  assert.equal(stockResult.code, 2, stockResult.stderr || stockResult.stdout);
  assert.equal(nativeResult.code, stockResult.code, nativeResult.stderr || nativeResult.stdout);

  const expected = parseReport(stockResult.stdout);
  const actual = parseReport(nativeResult.stdout);
  assert.ok(expected, JSON.stringify(stockResult.stdout));
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.files, ["b"]);
  // A report truncated by a failure states nothing about the batch as a whole.
  assert.equal(actual.verdict, null);
  assert.equal(actual.summary, null);

  // The summary sentence is taken from the live control rather than pinned.
  assert.equal(lastLine(nativeResult.stderr), lastLine(stockResult.stderr));
  // A truncated report ends without a newline, so canonical Oxfmt's diagnostic
  // block opens with the blank line that terminates it. Otherwise the first
  // diagnostic runs on from the last path in the report.
  assert.equal(stockResult.stderr.startsWith("\n"), true);
  assert.equal(nativeResult.stderr.startsWith("\n"), true);
  // The failure names its own file, and it is the file that could not be parsed.
  assert.match(nativeResult.stderr, /c\.tsrx/u);
  assert.equal(nativeResult.stderr.includes("b.tsrx"), false);
});

test("--write reports every file it could not parse and keeps its all-or-nothing transaction", async () => {
  const names = { b: "dirty", c: "broken", d: "broken" };
  const control = await fixtureDirectory("write-control", names);
  const candidate = await fixtureDirectory("write-candidate", names, ["b", "c", "d"]);
  const before = await readFile(candidate.paths.b, "utf8");
  const order = (paths) => [paths.b, paths.c, paths.d];

  const [stockResult, nativeResult] = await Promise.all([
    run(stock, control.cwd, ["--write", ...order(control.paths)]),
    runFormat(candidate.cwd, ["--write", ...order(candidate.paths)]),
  ]);

  // Canonical Oxfmt prints no summary at all once a file in the batch failed.
  assert.equal(stockResult.code, 2, stockResult.stderr || stockResult.stdout);
  assert.equal(nativeResult.code, stockResult.code, nativeResult.stderr || nativeResult.stdout);
  assert.equal(stockResult.stdout, "");
  assert.equal(nativeResult.stdout, "");
  assert.equal(lastLine(nativeResult.stderr), lastLine(stockResult.stderr));

  // Both unparseable files are named. The batch used to abort on the first one,
  // so `d` was never even looked at.
  assert.match(nativeResult.stderr, /c\.tsrx/u);
  assert.match(nativeResult.stderr, /d\.tsrx/u);

  // The one deliberate divergence from canonical Oxfmt, which writes the files
  // that parsed: this formatter keeps `--write` all-or-nothing so a batch never
  // lands half formatted. `tests/native-format.test.mjs` pins the same rule.
  assert.equal(await readFile(candidate.paths.b, "utf8"), before);
  assert.notEqual(await readFile(control.paths.b, "utf8"), FIXTURES.dirty.ts);
});

test("the merged oxfmt report counts every file and never claims an all-clear above a failure", async () => {
  const names = { a: "clean", b: "dirty", c: "clean", d: "dirty" };
  const control = await fixtureDirectory("merge-control", names);
  const candidate = await fixtureDirectory("merge-candidate", names, ["c", "d"]);

  const [stockResult, mergedResult] = await Promise.all([
    run(stock, control.cwd, ["--check", "src"]),
    runCompanion(candidate.cwd, ["--check", "src"]),
  ]);
  assert.equal(stockResult.code, 1, stockResult.stderr || stockResult.stdout);
  assert.equal(mergedResult.code, stockResult.code, mergedResult.stderr || mergedResult.stdout);

  // One report about four files, two of which differ, whichever tool handled
  // them. The count used to exclude the whole `.tsrx` half.
  const expected = parseReport(stockResult.stdout);
  assert.ok(expected, JSON.stringify(stockResult.stdout));
  assert.deepEqual(parseReport(mergedResult.stdout), expected);
  assert.deepEqual(expected.files, ["b", "d"]);
  assert.match(expected.summary, /\bon 4 files\b/u);

  // Now break one file in each half, so both tools have something to report.
  await writeFile(join(control.cwd, "src/e.ts"), FIXTURES.broken.ts);
  await writeFile(join(candidate.cwd, "src/e.tsrx"), FIXTURES.broken.tsrx);
  await writeFile(join(control.cwd, "src/f.ts"), FIXTURES.broken.ts);
  await writeFile(join(candidate.cwd, "src/f.ts"), FIXTURES.broken.ts);
  const [stockFailure, mergedFailure] = await Promise.all([
    run(stock, control.cwd, ["--check", "src"]),
    runCompanion(candidate.cwd, ["--check", "src"]),
  ]);
  assert.equal(stockFailure.code, 2, stockFailure.stderr || stockFailure.stdout);
  assert.equal(mergedFailure.code, stockFailure.code, mergedFailure.stderr || mergedFailure.stdout);

  const failed = parseReport(mergedFailure.stdout);
  assert.deepEqual(failed, parseReport(stockFailure.stdout));
  assert.deepEqual(failed.files, ["b", "d"]);
  assert.equal(failed.verdict, null);
  assert.equal(failed.summary, null);
  // The all-clear sentence comes from the live control's clean run, not a literal.
  const clearControl = await run(stock, control.cwd, ["--check", control.paths.a]);
  assert.equal(clearControl.code, 0, clearControl.stderr || clearControl.stdout);
  const allClear = parseReport(clearControl.stdout).verdict;
  assert.ok(allClear);
  assert.equal(mergedFailure.stdout.includes(allClear), false);

  // Both halves failed here, and each closes with the same sentence about its
  // own files. One report states it once, and names both broken files.
  const closing = lastLine(stockFailure.stderr);
  assert.equal(lastLine(mergedFailure.stderr), closing);
  assert.equal(mergedFailure.stderr.split(closing).length - 1, 1, mergedFailure.stderr);
  assert.match(mergedFailure.stderr, /e\.tsrx/u);
  assert.match(mergedFailure.stderr, /f\.ts\b/u);
  // Both halves spell the same directory the same way.
  assert.equal(mergedFailure.stderr.includes(candidate.cwd), false, mergedFailure.stderr);
});

test("a .tsrx-only oxfmt run prints the same summary an ordinary run prints", async () => {
  const names = { a: "clean", b: "dirty" };
  const control = await fixtureDirectory("solo-control", names);
  const candidate = await fixtureDirectory("solo-candidate", names, ["a", "b"]);

  for (const name of ["a", "b"]) {
    const [expected, actual] = await Promise.all([
      run(stock, control.cwd, ["--check", control.paths[name]]),
      runCompanion(candidate.cwd, ["--check", candidate.paths[name]]),
    ]);
    assert.equal(actual.code, expected.code, actual.stderr || actual.stdout);
    const report = parseReport(expected.stdout);
    assert.ok(report, JSON.stringify(expected.stdout));
    // Before this fix a `.tsrx`-only check printed nothing at all: a user could
    // not tell "checked and clean" from "skipped the file".
    assert.deepEqual(parseReport(actual.stdout), report);
    assert.match(report.summary, /\bon 1 files\b/u);
  }

  const [expectedWrite, actualWrite] = await Promise.all([
    run(stock, control.cwd, ["--write", control.paths.b]),
    runCompanion(candidate.cwd, ["--write", candidate.paths.b]),
  ]);
  assert.equal(actualWrite.code, expectedWrite.code, actualWrite.stderr || actualWrite.stdout);
  assert.equal(normalizeSummary(actualWrite.stdout), normalizeSummary(expectedWrite.stdout));
  assert.match(actualWrite.stdout, /\bon 1 files\b/u);
});

test("discovers JSONC Oxfmt options for TSRX and preserves ordinary TSX parity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-format-config-"));
  await writeFile(
    join(cwd, ".oxfmtrc.jsonc"),
    `{
      // Public core JS/TSX options are shared with Oxfmt.
      "useTabs": false,
      "tabWidth": 4,
      "printWidth": 48,
      "singleQuote": true,
      "jsxSingleQuote": true,
      "semi": false,
      "trailingComma": "none",
      "arrowParens": "avoid"
    }\n`,
  );
  const tsrx =
    'export function View({label}:{label:string}) @{ const message="hello"; <button title="world">{label}{message}</button>; <style>.button{color:red}</style>; }\n';
  const tsx =
    'export function View({label}:{label:string}) { const message="hello"; return <button title="world">{label}{message}</button>; }\n';

  const [tsrxResult, candidateTsx, stockTsx] = await Promise.all([
    runFormat(cwd, ["--stdin-filepath=View.tsrx"], tsrx),
    runFormat(cwd, ["--stdin-filepath=View.tsx"], tsx),
    run(stock, cwd, ["--stdin-filepath=View.tsx"], tsx),
  ]);
  assert.equal(tsrxResult.code, 0, tsrxResult.stderr || tsrxResult.stdout);
  assert.match(tsrxResult.stdout, /const message = 'hello'/);
  assert.match(tsrxResult.stdout, /title='world'/);
  assert.doesNotMatch(tsrxResult.stdout, /const message = 'hello';/);
  assert.match(tsrxResult.stdout, /\n {4}const message/);
  assert.match(tsrxResult.stdout, /<style>\.button\{color:red\}<\/style>/);
  assert.equal(candidateTsx.code, 0, candidateTsx.stderr || candidateTsx.stdout);
  assert.equal(stockTsx.code, 0, stockTsx.stderr || stockTsx.stdout);
  assert.equal(candidateTsx.stdout, stockTsx.stdout);

  const converged = await runFormat(cwd, ["--stdin-filepath=View.tsrx"], tsrxResult.stdout);
  assert.equal(converged.code, 0, converged.stderr || converged.stdout);
  assert.equal(converged.stdout, tsrxResult.stdout);
});

test("an explicit config applies per-file TSRX overrides without changing ordinary TSX options", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-format-override-"));
  const config = join(cwd, "custom-format.json");
  await writeFile(
    config,
    `{
      "singleQuote": false,
      "jsxSingleQuote": false,
      "semi": true,
      "overrides": [{
        "files": ["**/*.tsrx"],
        "options": { "singleQuote": true, "jsxSingleQuote": true, "semi": false }
      }]
    }\n`,
  );
  const tsrx = 'export function View() @{ const label="hello"; <p title="world">{label}</p>; }\n';
  const tsx =
    'export function View() { const label="hello"; return <p title="world">{label}</p>; }\n';

  const [tsrxResult, candidateTsx, stockTsx] = await Promise.all([
    runFormat(cwd, ["--config", config, "--stdin-filepath=src/View.tsrx"], tsrx),
    runFormat(cwd, ["--config", config, "--stdin-filepath=src/View.tsx"], tsx),
    run(stock, cwd, ["--config", config, "--stdin-filepath=src/View.tsx"], tsx),
  ]);
  assert.equal(tsrxResult.code, 0, tsrxResult.stderr || tsrxResult.stdout);
  assert.match(tsrxResult.stdout, /'hello'/);
  assert.match(tsrxResult.stdout, /title='world'/);
  assert.doesNotMatch(tsrxResult.stdout, /const label = 'hello';/);
  assert.equal(candidateTsx.stdout, stockTsx.stdout);
  assert.match(candidateTsx.stdout, /"hello";/);
  assert.match(candidateTsx.stdout, /title="world"/);
});

test("a materialized Vite format config keeps overrides and ignores rooted at its authored base", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-format-materialized-base-")));
  const materialized = await realpath(
    await mkdtemp(join(tmpdir(), "oxc-tsrx-format-materialized-config-")),
  );
  await mkdir(join(cwd, "src"), { recursive: true });
  const active = join(cwd, "src/active.tsrx");
  const ignored = join(cwd, "src/ignored.tsrx");
  const config = join(materialized, ".oxfmtrc.json");
  const source = 'export function View() @{const value="hello";<p>{value}</p>}\n';
  await writeFile(
    config,
    JSON.stringify({
      semi: true,
      singleQuote: false,
      ignorePatterns: ["src/ignored.tsrx"],
      overrides: [
        {
          files: ["src/**/*.tsrx"],
          options: { semi: false, singleQuote: true },
        },
      ],
    }),
  );
  await writeFile(active, source);
  await writeFile(ignored, source);

  const result = await runFormat(cwd, [
    "--write",
    "--config",
    config,
    "--config-base",
    cwd,
    active,
    ignored,
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const formatted = await readFile(active, "utf8");
  assert.match(formatted, /const value = 'hello'/);
  assert.doesNotMatch(formatted, /const value = 'hello';/);
  assert.equal(await readFile(ignored, "utf8"), source);

  const outside = join(materialized, "outside.tsrx");
  await writeFile(outside, source);
  const outsideResult = await runFormat(cwd, [
    "--check",
    "--config",
    config,
    "--config-base",
    cwd,
    outside,
  ]);
  assert.equal(outsideResult.signal, null, outsideResult.stderr || outsideResult.stdout);
  assert.equal(outsideResult.code, 1, outsideResult.stderr || outsideResult.stdout);
});

test("remaining public JS/TSX layout options retain stock parity and apply in one TSRX pass", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-format-core-options-"));
  await writeFile(
    join(cwd, ".oxfmtrc.json"),
    `{
      "endOfLine": "crlf",
      "printWidth": 40,
      "quoteProps": "consistent",
      "trailingComma": "all",
      "bracketSpacing": false,
      "bracketSameLine": true,
      "objectWrap": "collapse",
      "singleAttributePerLine": true,
      "htmlWhitespaceSensitivity": "ignore",
      "insertFinalNewline": false
    }\n`,
  );
  const tsx =
    'const data={plain:1,"needs-dash":2}; export function View({first,second}:{first:string;second:string}) { const props={plain:data.plain}; return <section alpha="one" beta="two" gamma="three"><span>{first}</span> <span>{second}</span>{props.plain}</section>; }\n';
  const tsrx =
    'const data={plain:1,"needs-dash":2}; export function View({first,second}:{first:string;second:string}) @{ const props={plain:data.plain}; <section alpha="one" beta="two" gamma="three"><span>{first}</span> <span>{second}</span>{props.plain}</section>; }\n';

  const [candidateTsx, stockTsx, candidateTsrx] = await Promise.all([
    runFormat(cwd, ["--stdin-filepath=View.tsx"], tsx),
    run(stock, cwd, ["--stdin-filepath=View.tsx"], tsx),
    runFormat(cwd, ["--stdin-filepath=View.tsrx"], tsrx),
  ]);
  assert.equal(candidateTsx.code, 0, candidateTsx.stderr || candidateTsx.stdout);
  assert.equal(stockTsx.code, 0, stockTsx.stderr || stockTsx.stdout);
  assert.equal(candidateTsrx.code, 0, candidateTsrx.stderr || candidateTsrx.stdout);
  assert.equal(candidateTsx.stdout, stockTsx.stdout);
  assert.match(candidateTsrx.stdout, /\r\n/);
  assert.doesNotMatch(candidateTsrx.stdout, /[\r\n]$/);
  assert.match(candidateTsrx.stdout, /\{plain:/);
  assert.match(candidateTsrx.stdout, /<section\r\n\s+alpha=/);
});

test("ignorePatterns leave ignored files byte-identical while formatting the rest transactionally", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-format-ignore-"));
  const included = join(cwd, "included.tsrx");
  const ignored = join(cwd, "ignored.tsrx");
  const source = 'export function View() @{const value="hello";<p>{value}</p>}\n';
  await writeFile(
    join(cwd, ".oxfmtrc.json"),
    '{ "singleQuote": true, "ignorePatterns": ["ignored.tsrx"] }\n',
  );
  await writeFile(included, source);
  await writeFile(ignored, source);

  const result = await runFormat(cwd, ["--write", included, ignored]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.notEqual(await readFile(included, "utf8"), source);
  assert.match(await readFile(included, "utf8"), /'hello'/);
  assert.equal(await readFile(ignored, "utf8"), source);
});

test("a discovered jsdoc config formats .tsrx files, and one override turns it back off", async () => {
  // Overrides match the path an authored file has under the config root, so this directory is
  // resolved through its real path the way every other override test here does.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-format-jsdoc-")));
  await mkdir(join(cwd, "legacy"), { recursive: true });
  const authored =
    '/**    counts   things   */\nexport function View() @{const value="hello";<p>{value}</p>}\n';
  const documented = join(cwd, "View.tsrx");
  const legacy = join(cwd, "legacy", "View.tsrx");
  await writeFile(
    join(cwd, ".oxfmtrc.json"),
    `${JSON.stringify(
      {
        semi: false,
        jsdoc: true,
        overrides: [{ files: ["legacy/**"], options: { jsdoc: false } }],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(documented, authored);
  await writeFile(legacy, authored);

  // Before this option was implemented the same config exited 2 without writing anything.
  const result = await runFormat(cwd, ["--write", documented, legacy]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /not available for TSRX/i);

  const formatted = await readFile(documented, "utf8");
  assert.match(formatted, /^\/\*\* Counts things \*\//);
  assert.match(formatted, /const value = "hello"\n/);

  // The override matched, so this file was formatted with JSDoc formatting off.
  const overridden = await readFile(legacy, "utf8");
  assert.match(overridden, /^\/\*\*    counts   things   \*\//);
  assert.match(overridden, /const value = "hello"\n/);

  const check = await runFormat(cwd, ["--check", documented, legacy]);
  assert.equal(check.code, 0, check.stderr || check.stdout);
});

test("one discovered sortImports policy covers a mixed .ts and .tsrx batch, and an override lifts it", async () => {
  // Overrides match the path an authored file has under the config root, so this directory is
  // resolved through its real path the way every other override test here does.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-format-sort-imports-")));
  await mkdir(join(cwd, "legacy"), { recursive: true });
  const imports = ['import {z} from "zebra";', 'import {a} from "apple";'].join("\n");
  const authoredTsrx = `${imports}\nexport function View() @{<p>{a}{z}</p>}\n`;
  const authoredTs = `${imports}\nexport function view(){return a+z}\n`;
  const sorted = ['import { a } from "apple";', 'import { z } from "zebra";'].join("\n");
  const component = join(cwd, "View.tsrx");
  const ordinary = join(cwd, "view.ts");
  const legacy = join(cwd, "legacy", "View.tsrx");
  await writeFile(
    join(cwd, ".oxfmtrc.json"),
    `${JSON.stringify(
      {
        sortImports: true,
        overrides: [{ files: ["legacy/**"], options: { sortImports: false } }],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(component, authoredTsrx);
  await writeFile(ordinary, authoredTs);
  await writeFile(legacy, authoredTsrx);

  // Before this option was implemented the same config exited 2 without writing anything, so a
  // project that sorted its imports could not have a single .tsrx file in it.
  const result = await runFormat(cwd, ["--write", component, ordinary, legacy]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /not available for TSRX/i);

  const formatted = await readFile(component, "utf8");
  assert.ok(formatted.startsWith(`${sorted}\n`), formatted);
  assert.match(formatted, /export function View\(\) @\{/);

  // The ordinary TypeScript file in the same batch took the canonical lane, so stock Oxfmt run
  // over the authored bytes with the same config is the oracle for what it now holds.
  const stockOrdinary = await run(stock, cwd, ["--stdin-filepath=view.ts"], authoredTs);
  assert.equal(stockOrdinary.code, 0, stockOrdinary.stderr || stockOrdinary.stdout);
  assert.equal(await readFile(ordinary, "utf8"), stockOrdinary.stdout);

  // The override matched, so this file was formatted with import sorting off.
  const overridden = await readFile(legacy, "utf8");
  assert.ok(overridden.startsWith('import { z } from "zebra";\n'), overridden);

  const check = await runFormat(cwd, ["--check", component, ordinary, legacy]);
  assert.equal(check.code, 0, check.stderr || check.stdout);
});

test("unsupported callback-backed options, editorconfig, and JS config modules fail before output or writes", async () => {
  const cases = [
    {
      name: "tailwind",
      configName: ".oxfmtrc.json",
      config: '{ "sortTailwindcss": true }\n',
      pattern: /sortTailwindcss|Tailwind|callback|unsupported/i,
    },
    {
      name: "embedded-language",
      configName: ".oxfmtrc.json",
      config: '{ "embeddedLanguageFormatting": "auto" }\n',
      pattern: /embeddedLanguageFormatting|embedded-language|callback|unsupported/i,
    },
    {
      name: "editorconfig",
      configName: ".editorconfig",
      config: "root = true\n[*]\nindent_size = 2\n",
      pattern: /editorconfig|unsupported|silently ignored/i,
    },
    {
      name: "js-config",
      configName: "oxfmt.config.js",
      config: "export default { singleQuote: true };\n",
      pattern: /JavaScript|TypeScript|config.*module|JSON/i,
    },
  ];

  for (const fixture of cases) {
    const cwd = await mkdtemp(join(tmpdir(), `oxc-tsrx-format-${fixture.name}-`));
    const source = 'export function View() @{const value="hello";<p>{value}</p>}\n';
    await writeFile(join(cwd, fixture.configName), fixture.config);
    const result = await runFormat(cwd, ["--stdin-filepath=View.tsrx"], source);
    assert.equal(result.code, 2, `${fixture.name}: ${result.stderr || result.stdout}`);
    assert.equal(result.stdout, "", fixture.name);
    assert.match(result.stderr, fixture.pattern, fixture.name);
  }
});

// --- Saying what actually happened, to the command the user actually typed ---
//
// Every expectation below is taken from a live stock Oxfmt run over the same
// fixture, never from a sentence written into this file.

test("a flag canonical Oxfmt does not know reads as unknown beside a .tsrx path too", async () => {
  const names = { a: "clean" };
  const control = await fixtureDirectory("unknown-option-control", names);
  const candidate = await fixtureDirectory("unknown-option-candidate", names, ["a"]);

  const expected = await run(stock, control.cwd, ["--frobnicate", control.paths.a]);
  assert.equal(expected.code, 1, expected.stderr || expected.stdout);
  assert.match(expected.stderr, /--frobnicate/u, expected.stderr);
  assert.doesNotMatch(expected.stderr, /not yet supported/u, expected.stderr);

  const tsrx = await runCompanion(candidate.cwd, ["--frobnicate", candidate.paths.a]);
  assert.equal(tsrx.stderr, expected.stderr, `stderr diverged:\n${tsrx.stderr}`);
  assert.equal(tsrx.code, expected.code, tsrx.stderr || tsrx.stdout);
  assert.equal(tsrx.stdout, "", tsrx.stdout);

  const directory = await runCompanion(candidate.cwd, ["--frobnicate", "src"]);
  assert.equal(directory.stderr, expected.stderr, directory.stderr);
  assert.equal(directory.code, expected.code, directory.stderr || directory.stdout);

  // The stdin route is the editor's, and it reached the native leaf without
  // ever checking the option against the tool it stands in for.
  const expectedStdin = await run(stock, control.cwd, ["--stdin", "--stdin-filepath=a.ts"], "");
  assert.equal(expectedStdin.code, 1, expectedStdin.stderr || expectedStdin.stdout);
  const stdin = await runCompanionStdin(
    candidate.cwd,
    ["--stdin", "--stdin-filepath=a.tsrx"],
    FIXTURES.clean.tsrx,
  );
  assert.equal(stdin.stderr, expectedStdin.stderr, stdin.stderr);
  assert.equal(stdin.code, expectedStdin.code, stdin.stderr || stdin.stdout);

  // The ordinary-only route still reaches canonical Oxfmt itself, so its
  // rejection cannot drift from the tool that produces it.
  const ordinary = await runCompanion(control.cwd, ["--frobnicate", control.paths.a]);
  assert.equal(ordinary.stderr, expected.stderr, ordinary.stderr);
  assert.equal(ordinary.code, expected.code, ordinary.stderr || ordinary.stdout);
});

test("a real Oxfmt flag the TSRX lane has not implemented still says so", async () => {
  const names = { a: "clean" };
  const control = await fixtureDirectory("unsupported-option-control", names);
  const candidate = await fixtureDirectory("unsupported-option-candidate", names, ["a"]);

  // Prove against the live control that `--disable-nested-config` really is an
  // Oxfmt option rather than a typo.
  const expected = await run(stock, control.cwd, [
    "--check",
    "--disable-nested-config",
    control.paths.a,
  ]);
  assert.equal(expected.code, 0, expected.stderr || expected.stdout);
  assert.doesNotMatch(expected.stderr, /is not expected in this context/u, expected.stderr);

  const unsupported = await runCompanion(candidate.cwd, [
    "--check",
    "--disable-nested-config",
    candidate.paths.a,
  ]);
  assert.equal(unsupported.code, 2, unsupported.stderr || unsupported.stdout);
  assert.match(unsupported.stderr, /--disable-nested-config is not yet supported for \.tsrx/u);
  assert.doesNotMatch(unsupported.stderr, /is not expected in this context/u);
});

test("a native format failure is attributed to the command the user ran", async () => {
  const names = { a: "clean", b: "broken" };
  const candidate = await fixtureDirectory("error-attribution", names, ["b"]);

  // The leaf labels itself `oxc-tsrx-fmt:`, which is correct when it is run
  // directly as the capability target the provider metadata names. Reached
  // through this command the user typed `oxfmt`.
  const batch = await runCompanion(candidate.cwd, ["--check", "src"]);
  assert.equal(batch.code, 2, batch.stdout);
  assert.match(batch.stderr, /unterminated/u, batch.stderr);
  assert.doesNotMatch(batch.stderr, /^oxc-tsrx-fmt: /mu, batch.stderr);
  assert.match(batch.stderr, /^oxfmt \(oxc-tsrx\): /mu, batch.stderr);

  const stdin = await runCompanionStdin(
    candidate.cwd,
    ["--stdin-filepath=Broken.tsrx"],
    FIXTURES.broken.tsrx,
  );
  assert.equal(stdin.code, 2, stdin.stdout);
  assert.doesNotMatch(stdin.stderr, /^oxc-tsrx-fmt: /mu, stdin.stderr);
  assert.match(stdin.stderr, /^oxfmt \(oxc-tsrx\): /mu, stdin.stderr);
});

test("the drop-in oxfmt checks a file list past the argument limit and skips gitignored trees", async () => {
  // The same discovery and paths-file channel the linter uses (see native-lint-config): a long
  // list travels in a file instead of argv, and a gitignored copy of the tree is never visited.
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-format-discovery-"));
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(join(directory, "ignored/copy"), { recursive: true });
  await mkdir(join(directory, "many"), { recursive: true });
  await writeFile(join(directory, ".gitignore"), "ignored/\n");
  await writeFile(join(directory, ".oxfmtrc.json"), "{}\n");
  await writeFile(join(directory, "src/a.ts"), "export const a = 1;\n");
  await writeFile(join(directory, "ignored/copy/b.tsrx"), "export function B(){<p>x</p>}\n");
  const count = 1500;
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeFile(join(directory, "many", `component-number-${index}.tsrx`), "export function Ok(){<p>ok</p>}\n"),
    ),
  );
  const result = await runCompanion(directory, ["--check", "."]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal((result.stdout.match(/^many\/component-number-\d+\.tsrx/gmu) ?? []).length, count, result.stdout.slice(0, 400));
  assert.doesNotMatch(result.stdout, /ignored\//u);
  // Every .tsrx file, plus src/a.ts and .oxfmtrc.json, which canonical Oxfmt formats too.
  assert.match(result.stdout, new RegExp(`on ${count + 2} files`, "u"));
  await rm(directory, { recursive: true, force: true });
});

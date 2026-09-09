import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveOxlintBytePositions } from "../../packages/toolchain/dist/lint-cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const binary = resolve(process.env.OXLINT_BIN ?? join(root, "target/release/oxc-tsrx"));
// pnpm installs `oxlint-current` under the package that declares it, so it is
// resolved from this file's own package instead of from a hoisted
// repository-root `node_modules`.
const stock = join(
  dirname(createRequire(import.meta.url).resolve("oxlint-current/package.json")),
  "bin/oxlint",
);
const companion = resolve(join(root, "packages/toolchain/bin/oxlint"));
// The `oxc-tsrx` command itself: providers, status, and the standard flags.
const provider = resolve(join(root, "packages/toolchain/bin/oxc-tsrx"));

function run(cwd, args, executable = binary, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
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

function runCompanion(cwd, args) {
  return run(cwd, [companion, ...args], process.execPath, {
    ...process.env,
    OXC_TSRX_LINT_BIN: binary,
  });
}

function json(result) {
  assert.equal(result.signal, null);
  const start = result.stdout.indexOf("{");
  assert.notEqual(start, -1, result.stderr || result.stdout);
  return JSON.parse(result.stdout.slice(start));
}

// Stock Oxlint prints a diagnostic filename relative to its working directory
// whenever the linted file sits under it, while the TSRX binary echoes back the
// path it was handed. Passing `base` compares the two spellings as the same
// file instead of as the same string. macOS hides the difference because
// `mkdtemp` returns a symlinked `/var/folders/...` path that Oxlint cannot
// strip its real `/private/var/folders/...` working directory from, so it falls
// back to the absolute argument; on Linux CI `/tmp` is real and the same run
// reports `view.tsx`.
function diagnostic(output, filename, rule, base) {
  const sameFile = base
    ? (candidate) => resolve(base, candidate) === resolve(base, filename)
    : (candidate) => candidate === filename;
  return output.diagnostics.find(
    (item) => sameFile(item.filename) && (item.rule === rule || item.code.includes(`(${rule})`)),
  );
}

// --- Which reporter this environment gets ---
//
// Canonical Oxlint picks a reporter for itself when the command line does not
// name one, so the same command prints a different shape on a laptop, inside a
// coding agent, and on a runner. The rules, restated here independently of
// packages/toolchain/dist/lint-cli.js so the two have to agree:
//
//   * any coding-agent variable selects `agent`, the compact
//     `file:line:col: severity code: message` form, and it outranks Actions;
//   * GITHUB_ACTIONS set to exactly `true` selects `github`, the workflow
//     annotations;
//   * otherwise `default`, the graphical report with source excerpts.
//
// A composed batch is rendered by the wrapper instead of by canonical Oxlint,
// so it has to reach the same reporter. These tests therefore run in whatever
// environment they are given and compare the wrapper against a live canonical
// run in it, rather than pinning the reporter and hiding a divergence.
const AGENT_ENVIRONMENT_VARIABLES = [
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "COPILOT_CLI",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "JUNIE_DATA",
  "JUNIE_SHIM_PATH",
  "OPENCODE",
  "REPL_ID",
];

function ambientReporter(env = process.env) {
  if (AGENT_ENVIRONMENT_VARIABLES.some((name) => (env[name] ?? "") !== "")) return "agent";
  if ((env.EDITOR ?? "").includes("devin")) return "agent";
  if (env.TERM_PROGRAM === "kiro") return "agent";
  if (env.GITHUB_ACTIONS === "true") return "github";
  return "default";
}

// The graphical reporter draws source excerpts, carets, and box rules that
// cannot be rebuilt from the JSON the two halves of a composed batch hand back,
// so the wrapper falls back to the compact reporter for it. Ask the control for
// that same reporter in that one environment, so a comparison stays a byte-for-
// byte comparison of one reporter instead of a comparison of two.
const composedReporter = ambientReporter() === "default" ? "agent" : ambientReporter();
const controlFormat = ambientReporter() === "default" ? ["--format=agent"] : [];

// Which reporter really produced this output, read off the output itself. Every
// comparison below asserts this against the rule restated above, so the day
// canonical Oxlint changes when it switches, these fail instead of drifting.
function reporterOf(stdout) {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (lines.some((line) => line.startsWith("::"))) return "github";
  if (lines.some((line) => /^\S+:\d+:\d+: (?:warning|error)\b/u.test(line))) return "agent";
  return "default";
}

// Both summary lines report one process's own counts, elapsed time, rule count,
// and thread count. A one-file control run and a three-file composed batch can
// never share them, so a line-for-line comparison is about the diagnostics.
function diagnosticLines(stdout) {
  return stdout
    .split("\n")
    .filter(
      (line) =>
        line.length > 0 && !/^Found \d+ /u.test(line) && !/^Finished in /u.test(line),
    );
}

// The same diagnostic, spelled the way the reporter in play spells it.
function diagnosticPattern(reporter, { file, line = "\\d+", column = "\\d+", severity, code }) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (reporter === "github") {
    return new RegExp(
      `^::${severity} file=${escaped},line=${line},endLine=\\d+,col=${column},endColumn=\\d+,title=${code.replace(/[()]/gu, "\\$&")}::`,
      "mu",
    );
  }
  return new RegExp(
    `^${escaped}:${line}:${column}: ${severity} ${code.replace(/[()]/gu, "\\$&")}: `,
    "mu",
  );
}

test("Oxlint byte-position resolver handles CR, LF, CRLF, EOF, duplicates, and bad offsets", () => {
  const bytes = Buffer.from("a\rβ\r\n🍄\nz");
  const positions = resolveOxlintBytePositions(
    bytes,
    [12, 0, 5, 6, 2, 1, 10, 4, 11, 6],
    "edge.tsrx",
  );
  assert.deepEqual(
    Object.fromEntries(positions),
    {
      0: { line: 1, column: 1 },
      1: { line: 1, column: 2 },
      2: { line: 2, column: 1 },
      4: { line: 2, column: 3 },
      5: { line: 3, column: 1 },
      6: { line: 3, column: 1 },
      10: { line: 3, column: 5 },
      11: { line: 4, column: 1 },
      12: { line: 4, column: 2 },
    },
  );
  for (const offset of [-1, 1.5, bytes.length + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => resolveOxlintBytePositions(bytes, [offset], "edge.tsrx"),
      /invalid diagnostic byte offset/u,
    );
  }
  for (const offset of [3, 7, 8, 9]) {
    assert.throws(
      () => resolveOxlintBytePositions(bytes, [offset], "edge.tsrx"),
      /splits UTF-8/u,
    );
  }
});

test("npm wrapper matches canonical Oxlint line and UTF-8 byte columns after Unicode", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-lint-unicode-location-")));
  const unicode = [
    "export function View() @{",
    '  const prior = "π";',
    "  void prior;",
    '  void "🍄"; var total = 0; debugger; void total;',
    "}",
    "",
  ].join("\n");
  const cases = [
    { name: "unicode", source: unicode },
    { name: "ascii", source: unicode.replace("π", "p").replace("🍄", "m") },
  ];
  for (const fixture of cases) {
    fixture.sourcePath = join(cwd, `${fixture.name}.tsrx`);
    fixture.controlPath = join(cwd, `${fixture.name}.tsx`);
    fixture.controlFilename = `${fixture.name}.tsx`;
    await writeFile(fixture.sourcePath, fixture.source);
    await writeFile(fixture.controlPath, fixture.source.replace("@{", "{"));
  }

  const expected = new Map([
    ["no-var", { token: "var", label: "var" }],
    ["no-debugger", { token: "debugger", label: "debugger;" }],
  ]);
  const ruleArgs = ["--deny", "no-var", "--deny", "no-debugger"];
  const args = [...ruleArgs, ...cases.map((fixture) => fixture.sourcePath)];

  const structured = await runCompanion(cwd, ["--format=json", ...args]);
  assert.equal(structured.code, 1, structured.stderr || structured.stdout);
  const output = json(structured);
  const controlResult = await run(
    cwd,
    ["--format=json", ...ruleArgs, ...cases.map((fixture) => fixture.controlPath)],
    stock,
  );
  assert.equal(controlResult.code, 1, controlResult.stderr || controlResult.stdout);
  const control = json(controlResult);

  const human = await runCompanion(cwd, args);
  assert.equal(human.code, 1, human.stderr || human.stdout);
  for (const fixture of cases) {
    for (const [rule, location] of expected) {
      const item = diagnostic(output, fixture.sourcePath, rule);
      const controlItem = diagnostic(control, fixture.controlFilename, rule);
      assert.ok(item, `${fixture.name}: ${rule}`);
      assert.ok(controlItem, `${fixture.name} control: ${rule}`);
      const span = item.labels[0].span;
      const controlSpan = controlItem.labels[0].span;
      const characterIndex = fixture.source.indexOf(location.token);
      assert.equal(
        span.offset,
        Buffer.byteLength(fixture.source.slice(0, characterIndex)),
        `${fixture.name} ${rule}: byte offset`,
      );
      assert.equal(
        span.length,
        Buffer.byteLength(location.label),
        `${fixture.name} ${rule}: byte length`,
      );
      assert.deepEqual(
        { line: span.line, column: span.column },
        { line: controlSpan.line, column: controlSpan.column },
        `${fixture.name} ${rule}: canonical line/byte-column parity`,
      );
      assert.match(
        human.stdout,
        // Canonical Oxlint separates the code from the message, and puts the
        // position in the same place, whichever reporter this environment
        // selects. The merged report must too. See the fidelity test below.
        diagnosticPattern(composedReporter, {
          file: `${fixture.name}.tsrx`,
          line: controlSpan.line,
          column: controlSpan.column,
          severity: "error",
          code: `eslint(${rule})`,
        }),
        `${fixture.name}: ${rule}\n${human.stdout}`,
      );
    }
  }
});

test("npm wrapper matches canonical Oxlint across CR, LF, and CRLF line starts", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-lint-line-endings-")));
  const sourcePath = join(cwd, "lines.tsrx");
  const controlPath = join(cwd, "lines.tsx");
  const source =
    'export function Lines() @{ void "π";\rdebugger;\r\nvar value = 0;\nvoid value;\r}';
  await writeFile(sourcePath, source);
  await writeFile(controlPath, source.replace("@{", "{"));
  const ruleArgs = ["--deny", "no-debugger", "--deny", "no-var"];
  const wrappedResult = await runCompanion(cwd, ["--format=json", ...ruleArgs, sourcePath]);
  const controlResult = await run(cwd, ["--format=json", ...ruleArgs, controlPath], stock);
  assert.equal(wrappedResult.code, 1, wrappedResult.stderr || wrappedResult.stdout);
  assert.equal(controlResult.code, 1, controlResult.stderr || controlResult.stdout);
  const wrapped = json(wrappedResult);
  const control = json(controlResult);
  for (const [rule, exact] of [
    ["no-debugger", { line: 2, column: 1 }],
    ["no-var", { line: 3, column: 1 }],
  ]) {
    const span = diagnostic(wrapped, sourcePath, rule)?.labels[0].span;
    const controlSpan = diagnostic(control, "lines.tsx", rule)?.labels[0].span;
    assert.deepEqual({ line: span?.line, column: span?.column }, exact, rule);
    assert.deepEqual(
      { line: span?.line, column: span?.column },
      { line: controlSpan?.line, column: controlSpan?.column },
      `${rule}: canonical line-ending parity`,
    );
  }
});

test("discovers one JSONC Oxlint config and applies rules, severities, and per-file overrides", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-lint-config-")));
  const tsrx = join(cwd, "view.tsrx");
  const tsx = join(cwd, "view.tsx");
  const config = join(cwd, ".oxlintrc.jsonc");
  await writeFile(
    config,
    `{
      // The same config governs TSRX and ordinary TSX.
      "plugins": ["react"],
      "rules": {
        "no-debugger": "error",
        "no-console": "warn",
        "eqeqeq": ["error", "always"],
        "no-undef": "error",
        "react/jsx-no-undef": "error"
      },
      "env": { "browser": true },
      "globals": { "projectGlobal": "readonly" },
      "settings": { "react": { "version": "19.0.0" } },
      "overrides": [{
        "files": ["**/*.tsx"],
        "rules": { "no-debugger": "off" }
      }]
    }\n`,
  );
  await writeFile(
    tsrx,
    "export function Tsrx(value: unknown) @{ debugger; console.log(window, projectGlobal, missingGlobal, value == null); <Missing />; }\n",
  );
  await writeFile(
    tsx,
    "export function Tsx(value: unknown) { debugger; console.log(value == null); return <Missing />; }\n",
  );

  const result = await run(cwd, ["--format=json", tsrx, tsx]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = json(result);

  assert.equal(diagnostic(output, tsrx, "no-debugger")?.severity, "error");
  assert.equal(diagnostic(output, tsrx, "no-console")?.severity, "warning");
  assert.equal(diagnostic(output, tsrx, "eqeqeq")?.severity, "error");
  const undefinedDiagnostics = output.diagnostics.filter(
    (item) => item.filename === tsrx && item.rule === "no-undef",
  );
  assert.ok(undefinedDiagnostics.some((item) => /missingGlobal/.test(item.message)));
  assert.ok(undefinedDiagnostics.every((item) => !/window|projectGlobal/.test(item.message)));
  assert.equal(diagnostic(output, tsrx, "jsx-no-undef")?.severity, "error");
  assert.equal(diagnostic(output, tsx, "jsx-no-undef")?.severity, "error");
  assert.equal(diagnostic(output, tsx, "no-debugger"), undefined);
  assert.equal(diagnostic(output, tsx, "no-console")?.severity, "warning");
  assert.equal(diagnostic(output, tsx, "eqeqeq")?.severity, "error");
  assert.equal(output.number_of_files, 2);
  assert.equal(output.oxcTsrx.files.tsrx, 1);
  assert.equal(output.oxcTsrx.files.standard, 1);
  assert.equal(output.oxcTsrx.parseCount, 2);
  assert.equal(output.oxcTsrx.configLoads, 1);
  assert.equal(output.oxcTsrx.configPath, await realpath(config));

  const stockTsxResult = await run(cwd, ["--format=json", tsx], stock);
  assert.equal(stockTsxResult.code, 1, stockTsxResult.stderr || stockTsxResult.stdout);
  const stockTsx = json(stockTsxResult);
  assert.equal(diagnostic(stockTsx, tsx, "no-debugger", cwd), undefined);
  for (const rule of ["no-console", "eqeqeq", "no-undef", "jsx-no-undef"]) {
    const candidate = diagnostic(output, tsx, rule);
    const control = diagnostic(stockTsx, tsx, rule, cwd);
    assert.ok(control, `${rule}: stock Oxlint control diagnostic`);
    assert.equal(candidate?.severity, control?.severity, rule);
    assert.equal(candidate?.labels[0]?.span.offset, control?.labels[0]?.span.offset, rule);
    assert.equal(candidate?.labels[0]?.span.length, control?.labels[0]?.span.length, rule);
  }

  const stockTsrxResult = await run(cwd, ["--format=json", tsrx], stock);
  assert.equal(stockTsrxResult.code, 1);
  assert.equal(json(stockTsrxResult).number_of_files, 0);
});

test("explicit config extends files and CLI filters override configured severities", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-lint-extends-"));
  const source = join(cwd, "source.tsrx");
  const base = join(cwd, "base.json");
  const config = join(cwd, "lint.json");
  await writeFile(base, '{ "rules": { "no-var": "error", "no-debugger": "off" } }\n');
  await writeFile(config, '{ "extends": ["./base.json"], "rules": { "no-debugger": "warn" } }\n');
  await writeFile(source, "export function View() @{ var value = 1; debugger; void value; }\n");

  const denied = await run(cwd, [
    "--format=json",
    "--config",
    config,
    "--allow",
    "no-debugger",
    "--deny",
    "no-var",
    source,
  ]);
  assert.equal(denied.code, 1, denied.stderr || denied.stdout);
  const deniedOutput = json(denied);
  assert.equal(diagnostic(deniedOutput, source, "no-debugger"), undefined);
  assert.equal(diagnostic(deniedOutput, source, "no-var")?.severity, "error");

  const warned = await run(cwd, [
    "--format=json",
    "-c",
    config,
    "--warn",
    "no-debugger",
    "--allow",
    "no-var",
    source,
  ]);
  assert.equal(warned.code, 0, warned.stderr || warned.stdout);
  const warnedOutput = json(warned);
  assert.equal(diagnostic(warnedOutput, source, "no-var"), undefined);
  assert.equal(diagnostic(warnedOutput, source, "no-debugger")?.severity, "warning");
});

test("a materialized Vite config keeps object extends, overrides, and ignores rooted at its authored base", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-lint-materialized-base-")));
  const materialized = await realpath(
    await mkdtemp(join(tmpdir(), "oxc-tsrx-lint-materialized-config-")),
  );
  await mkdir(join(cwd, "src"), { recursive: true });
  const active = join(cwd, "src/active.tsrx");
  const ignored = join(cwd, "src/ignored.tsrx");
  const config = join(materialized, ".oxlintrc.json");
  await writeFile(
    config,
    JSON.stringify({
      extends: [{ rules: { "no-debugger": "error" } }],
      ignorePatterns: ["src/ignored.tsrx"],
      overrides: [
        {
          files: ["src/**/*.tsrx"],
          rules: { "no-console": "error" },
        },
      ],
    }),
  );
  await writeFile(
    active,
    'export function Active() @{ debugger; console.log("active"); <div />; }\n',
  );
  await writeFile(
    ignored,
    'export function Ignored() @{ debugger; console.log("ignored"); <div />; }\n',
  );

  const result = await run(cwd, [
    "--format=json",
    "--config",
    config,
    "--config-base",
    cwd,
    active,
    ignored,
  ]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = json(result);
  assert.equal(output.number_of_files, 1);
  assert.equal(diagnostic(output, active, "no-debugger")?.severity, "error");
  assert.equal(diagnostic(output, active, "no-console")?.severity, "error");
  assert.equal(
    output.diagnostics.some((item) => item.filename === ignored),
    false,
  );
});

test("ignorePatterns filter a batch and configured safe fixes reparse both TSRX and TSX", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-lint-fix-config-"));
  const tsrx = join(cwd, "fix.tsrx");
  const tsx = join(cwd, "fix.tsx");
  const ignored = join(cwd, "ignored.tsrx");
  await writeFile(
    join(cwd, ".oxlintrc.json"),
    `{
      "ignorePatterns": ["ignored.tsrx"],
      "rules": { "no-var": "error", "no-debugger": "error" }
    }\n`,
  );
  await writeFile(tsrx, "export function Tsrx() @{ var value = 1; void value; }\n");
  await writeFile(tsx, "export function Tsx() { var value = 1; void value; }\n");
  await writeFile(ignored, "export function Ignored() @{ debugger; }\n");

  const result = await run(cwd, ["--format=json", "--fix", tsrx, tsx, ignored]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = json(result);
  assert.equal(output.number_of_files, 2);
  assert.equal(output.diagnostics.length, 0);
  assert.equal(output.oxcTsrx.fixes.applied, 2);
  assert.equal(output.oxcTsrx.reparseCount, 2);
  assert.doesNotMatch(await readFile(tsrx, "utf8"), /\bvar\b/);
  assert.doesNotMatch(await readFile(tsx, "utf8"), /\bvar\b/);
  assert.match(await readFile(ignored, "utf8"), /debugger/);
});

test("denyWarnings and maxWarnings preserve Oxlint warning exit policy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-lint-warning-policy-"));
  const source = join(cwd, "source.tsrx");
  const denyWarnings = join(cwd, "deny-warnings.json");
  const maxWarnings = join(cwd, "max-warnings.json");
  await writeFile(source, "export function View() @{ debugger; }\n");
  await writeFile(
    denyWarnings,
    '{ "rules": { "no-debugger": "warn" }, "options": { "denyWarnings": true } }\n',
  );
  await writeFile(
    maxWarnings,
    '{ "rules": { "no-debugger": "warn" }, "options": { "maxWarnings": 0 } }\n',
  );

  for (const config of [denyWarnings, maxWarnings]) {
    const result = await run(cwd, ["--format=json", "--config", config, source]);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.equal(diagnostic(json(result), source, "no-debugger")?.severity, "warning");
  }
});

test("unsupported JS plugins, type-aware mode, and JS config modules fail before linting", async () => {
  const cases = [
    {
      name: "js-plugin",
      configName: ".oxlintrc.json",
      config: '{ "jsPlugins": ["./plugin.js"], "rules": {} }\n',
      pattern: /JS|JavaScript.*plugin|plugin.*unsupported/i,
    },
    {
      name: "type-aware",
      configName: ".oxlintrc.json",
      config: '{ "options": { "typeAware": true }, "rules": {} }\n',
      pattern: /type.?aware|tsgolint/i,
    },
    {
      name: "js-config",
      configName: "oxlint.config.ts",
      config: 'export default { rules: { "no-debugger": "error" } };\n',
      pattern: /JavaScript|TypeScript|config.*module|JSON/i,
    },
  ];

  for (const fixture of cases) {
    const cwd = await mkdtemp(join(tmpdir(), `oxc-tsrx-lint-${fixture.name}-`));
    const source = join(cwd, "source.tsrx");
    await writeFile(join(cwd, fixture.configName), fixture.config);
    await writeFile(source, "export function View() @{ debugger; }\n");
    const result = await run(cwd, ["--format=json", source]);
    assert.equal(result.code, 2, `${fixture.name}: ${result.stderr || result.stdout}`);
    assert.equal(result.stdout, "", fixture.name);
    assert.match(result.stderr, fixture.pattern, fixture.name);
  }
});

// The three tests below pin one property: composing a `.tsrx` file into a batch
// must leave the report a report. Each of them reproduces a specific way the
// merged output stopped being one.

/** A project with one ordinary file, one TSRX file, and one unparseable TSRX file. */
async function mixedProject(name) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), `oxc-tsrx-lint-${name}-`)));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(
    join(cwd, "src/util.ts"),
    "export function total() {\n  let unusedTotal = 0;\n  debugger;\n}\n",
  );
  await writeFile(
    join(cwd, "src/Counter.tsrx"),
    "export function Counter() @{\n  var legacy = 1;\n  <div>hi</div>\n}\n",
  );
  await writeFile(
    join(cwd, "src/Broken.tsrx"),
    "export function Broken() @{\n  let x = 1;\n  <main>\n    <h1>hi</h1>\n}\n",
  );
  return cwd;
}

test("a .tsrx file in the batch leaves ordinary diagnostics byte-identical to canonical Oxlint", async () => {
  const cwd = await mixedProject("report-fidelity");

  // The control is what the user saw before they adopted TSRX: canonical Oxlint
  // on the ordinary file alone, in this environment's own reporter.
  const control = await run(cwd, [...controlFormat, "src/util.ts"], stock);
  assert.equal(control.code, 0, control.stderr || control.stdout);
  assert.equal(
    reporterOf(control.stdout),
    composedReporter,
    `canonical Oxlint no longer picks the reporter this environment was expected to give it:\n${control.stdout}`,
  );
  const controlLines = diagnosticLines(control.stdout);
  assert.ok(controlLines.length >= 2, control.stdout);
  const shape =
    composedReporter === "github"
      ? /^::warning file=\S+,line=\d+,endLine=\d+,col=\d+,endColumn=\d+,title=eslint\([a-z-]+\)::./u
      : /: warning eslint\([a-z-]+\): .* help: /u;
  assert.ok(
    controlLines.every((line) => shape.test(line)),
    `the control lost its own code separator, position, or help text:\n${control.stdout}`,
  );

  const merged = await runCompanion(cwd, ["src/util.ts", "src/Counter.tsrx"]);
  assert.equal(merged.code, 0, merged.stderr || merged.stdout);
  assert.equal(
    reporterOf(merged.stdout),
    composedReporter,
    `adding a .tsrx file changed which reporter answered:\n${merged.stdout}`,
  );
  const mergedLines = merged.stdout.split("\n");
  for (const line of controlLines) {
    assert.ok(
      mergedLines.includes(line),
      `adding a .tsrx file changed an ordinary file's diagnostic.\nexpected line: ${line}\ngot:\n${merged.stdout}`,
    );
  }
  // The TSRX half has no help text of its own to print yet, but it must still
  // carry its position and separate its code from its message the way every
  // other diagnostic in the same report does.
  assert.match(
    merged.stdout,
    diagnosticPattern(composedReporter, {
      file: "src/Counter.tsrx",
      line: 2,
      column: 7,
      severity: "warning",
      code: "eslint(no-unused-vars)",
    }),
    merged.stdout,
  );
  assert.match(merged.stdout, /Variable 'legacy'/u, merged.stdout);
});

test("a .tsrx syntax error is a positioned diagnostic that leaves the rest of the batch reporting", async () => {
  const cwd = await mixedProject("report-syntax-error");

  const control = await run(cwd, [...controlFormat, "src/util.ts"], stock);
  assert.equal(control.code, 0, control.stderr || control.stdout);
  const controlLines = diagnosticLines(control.stdout);

  // The invocation that used to be the worst case: a good ordinary file, a good
  // `.tsrx` file, and one `.tsrx` file that cannot be projected. It exited 2 with
  // empty stdout and a bare stderr line naming no file, so one typo discarded
  // every other file's diagnostics.
  const result = await runCompanion(cwd, ["src/util.ts", "src/Counter.tsrx", "src/Broken.tsrx"]);
  // Exit 1 is canonical Oxlint's "diagnostics were found", the code a `.ts`
  // parse error already produced. Exit 2 stays reserved for the tool failing.
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "", result.stderr);
  assert.doesNotMatch(
    result.stdout,
    /"diagnostics"|"number_of_files"|"start_time"/u,
    `the batch dumped the internally forced --format=json output:\n${result.stdout}`,
  );

  const lines = result.stdout.split("\n");
  for (const line of controlLines) {
    assert.ok(
      lines.includes(line),
      `the batch dropped an ordinary file's diagnostic.\nexpected line: ${line}\ngot:\n${result.stdout}`,
    );
  }
  // The good `.tsrx` file's own diagnostics survive its broken sibling too. This
  // is the half no wrapper change could ever have reached.
  assert.match(
    result.stdout,
    diagnosticPattern(composedReporter, {
      file: "src/Counter.tsrx",
      line: 2,
      column: 7,
      severity: "warning",
      code: "eslint(no-unused-vars)",
    }),
    result.stdout,
  );
  assert.match(result.stdout, /Variable 'legacy'/u, result.stdout);

  // The syntax error names its own file and carries a real line:col. Derive the
  // expected position from the byte offset the native leaf emitted rather than
  // hardcoding it, so this fails if the offset ever stops being an authored
  // UTF-8 index.
  const brokenPath = join(cwd, "src/Broken.tsrx");
  const native = await run(cwd, ["--format=json", brokenPath]);
  assert.equal(native.code, 1, native.stderr || native.stdout);
  const failures = json(native).diagnostics;
  assert.equal(failures.length, 1, native.stdout);
  assert.equal(failures[0].filename, brokenPath);
  assert.equal(failures[0].severity, "error");
  const offset = failures[0].labels[0].span.offset;
  const bytes = await readFile(brokenPath);
  const position = resolveOxlintBytePositions(bytes, [offset], brokenPath).get(offset);
  // Independent of the resolver: that line and column really do land on the
  // element that was never closed.
  const sourceLines = bytes.toString("utf8").split("\n");
  assert.equal(
    sourceLines[position.line - 1].slice(position.column - 1, position.column + 5),
    "<main>",
  );
  // A diagnostic that carries no rule code is titled `oxlint` by the annotation
  // reporter, which is what canonical Oxlint titles its own parse errors.
  assert.match(
    result.stdout,
    composedReporter === "github"
      ? new RegExp(
          `^::error file=src/Broken\\.tsrx,line=${position.line},endLine=\\d+,col=${position.column},endColumn=\\d+,title=oxlint::.*unterminated`,
          "mu",
        )
      : new RegExp(
          `^src/Broken\\.tsrx:${position.line}:${position.column}: error: .*unterminated`,
          "mu",
        ),
    `the syntax error did not render as a positioned diagnostic:\n${result.stdout}`,
  );

  // Canonical Oxlint closes a report with two lines, and the tools that read
  // its output read the pair: Vite+ reports `Linting could not start` and fails
  // the run whenever the second one is missing, however the first is worded.
  // Both lines are asserted here, in canonical Oxlint's own spelling - warnings
  // first, nouns pluralised by count, never `warning(s)` - because a composed
  // batch that words its summary its own way is a batch no Oxlint consumer can
  // read. The elapsed time and the counts are this run's own, so the shapes are
  // pinned and the numbers are not.
  assert.match(result.stdout, /^Found 3 warnings and 1 error\.$/mu, result.stdout);
  assert.match(
    result.stdout,
    /^Finished in [0-9.]+(?:ms|s) on \d+ files? with \d+ rules? using \d+ threads?\.$/mu,
    result.stdout,
  );
  assert.doesNotMatch(result.stdout, /warning\(s\)|error\(s\)/u, result.stdout);
});

test("a batch of nothing but .tsrx files still closes with both summary lines", async () => {
  const cwd = await mixedProject("report-tsrx-only");

  // The invocation shape that kept the second summary line missing after the
  // rest of it was fixed. Every positional a `.tsrx` path is the one shape that
  // never starts canonical Oxlint, and canonical Oxlint was the only half
  // reporting a thread count, so this batch printed its counts and stopped -
  // which is exactly the missing line Vite+ answers with `error: Linting could
  // not start`. It is also the shape a `staged: {'*': 'vp check --fix'}`
  // pre-commit hook produces on a commit that stages only `.tsrx` files, so it
  // is the shape the fix mattered most on and the one it reached last.
  const result = await runCompanion(cwd, ["src/Counter.tsrx"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^Found 1 warning and 0 errors\.$/mu, result.stdout);
  const finished =
    /^Finished in [0-9.]+(?:ms|s) on 1 file with \d+ rules using (\d+) threads?\.$/mu.exec(
      result.stdout,
    );
  assert.ok(
    finished,
    `a batch of nothing but .tsrx files stopped after the counts:\n${result.stdout}`,
  );
  // The count comes from the native leaf, which counts the threads it really
  // linted on. Any positive integer is that measurement working; what must
  // never come back is a batch with no number at all, or a number pinned here
  // that the leaf never took.
  assert.ok(
    Number.parseInt(finished[1], 10) >= 1,
    `the .tsrx-only batch reported an unmeasured thread count:\n${result.stdout}`,
  );
  assert.doesNotMatch(result.stdout, /warning\(s\)|error\(s\)/u, result.stdout);
});

test("a nonexistent .tsrx positional reports canonical Oxlint's unmatched-pattern error", async () => {
  const cwd = await mixedProject("report-unmatched");

  // Canonical Oxlint on a nonexistent ordinary file is the precedent: this
  // message on stdout and exit 1. What it prints *after* the message is its
  // reporter's business rather than this path's, and the reporters disagree -
  // `agent` closes with the message alone, while `default` and `github` add
  // `Finished in <elapsed> on 0 files with <n> rules using <n> threads.` for
  // the empty run canonical started anyway. That is the same stock 1.74.0
  // binary on the same machine, so comparing the streams whole compares
  // whichever reporter the ambient environment happened to pick: green under a
  // coding agent, red under GITHUB_ACTIONS.
  //
  // The streams are therefore compared with the summary held apart from the
  // message. The message must still match canonical byte for byte, in
  // canonical's own live wording rather than a sentence copied into this file;
  // the wrapper's own summary must be empty, and that is asserted directly on
  // the wrapper instead of by filtering both sides.
  //
  // Empty is the point of the test, not a concession to make it pass. This
  // wrapper answers the invocation before starting either half, so it has no
  // elapsed run, no rule count and no thread count: a `Found ...` or `Finished
  // in ...` line here could only be numbers nobody measured, which is exactly
  // what the rest of this file spends its effort making impossible. Filtering
  // `Finished in ` out of both streams, as this test once did, would let such a
  // line through unseen - hence the positive assertion below, which fails on
  // any summary line at all rather than only on a mismatched one.
  const summaryOf = (stdout) =>
    stdout.split("\n").filter((line) => /^(?:Found |Finished in )/u.test(line));
  const messageOf = (stdout) =>
    stdout
      .split("\n")
      .filter((line) => !/^(?:Found |Finished in )/u.test(line))
      .join("\n");

  const control = await run(cwd, ["src/Missing.ts"], stock);
  assert.equal(control.code, 1, control.stderr || control.stdout);
  assert.match(control.stdout, /No files found to lint/u, control.stdout);

  const missing = await runCompanion(cwd, ["src/Missing.tsrx"]);
  assert.equal(
    missing.code,
    control.code,
    `a mistyped .tsrx filename exited ${missing.code} with stdout:\n${missing.stdout}`,
  );
  assert.equal(messageOf(missing.stdout), messageOf(control.stdout));
  assert.deepEqual(
    summaryOf(missing.stdout),
    [],
    `a run that never started summarised itself:\n${missing.stdout}`,
  );

  // The opt-out canonical Oxlint already publishes keeps working.
  const controlAllowed = await run(
    cwd,
    ["--no-error-on-unmatched-pattern", "src/Missing.ts"],
    stock,
  );
  assert.equal(controlAllowed.code, 0, controlAllowed.stderr || controlAllowed.stdout);
  const allowed = await runCompanion(cwd, ["--no-error-on-unmatched-pattern", "src/Missing.tsrx"]);
  assert.equal(allowed.code, controlAllowed.code, allowed.stderr || allowed.stdout);
  assert.equal(messageOf(allowed.stdout), messageOf(controlAllowed.stdout));
  assert.deepEqual(
    summaryOf(allowed.stdout),
    [],
    `an opted-out run that never started summarised itself:\n${allowed.stdout}`,
  );

  // Canonical Oxlint only errors when the whole invocation matched nothing, so a
  // batch that still has work to do must keep exiting on that work alone.
  const controlMixed = await run(cwd, ["src/Missing.ts", "src/util.ts"], stock);
  const mixed = await runCompanion(cwd, ["src/Missing.tsrx", "src/util.ts"]);
  assert.equal(controlMixed.code, 0, controlMixed.stderr || controlMixed.stdout);
  assert.equal(mixed.code, controlMixed.code, mixed.stderr || mixed.stdout);
  assert.match(
    mixed.stdout,
    diagnosticPattern(composedReporter, {
      file: "src/util.ts",
      line: 2,
      column: 7,
      severity: "warning",
      code: "eslint(no-unused-vars)",
    }),
    mixed.stdout,
  );
});

// --- Saying what actually happened, to the command the user actually typed ---
//
// Every expectation below is taken from a live stock Oxlint run in the same
// fixture, never from a sentence written into this file, so the day canonical
// Oxlint rewords one of them these fail instead of silently drifting.

test("a flag canonical Oxlint does not know reads as unknown beside a .tsrx path too", async () => {
  const cwd = await mixedProject("unknown-option");

  // The control: the same bogus flag on the ordinary path a user would have
  // typed before adopting TSRX.
  const control = await run(cwd, ["--frobnicate", "src/util.ts"], stock);
  assert.equal(control.code, 1, control.stderr || control.stdout);
  assert.match(control.stderr, /--frobnicate/u, control.stderr);
  assert.doesNotMatch(control.stderr, /not yet supported/u, control.stderr);

  const tsrx = await runCompanion(cwd, ["--frobnicate", "src/Counter.tsrx"]);
  assert.equal(tsrx.stderr, control.stderr, `stderr diverged:\n${tsrx.stderr}`);
  assert.equal(tsrx.code, control.code, tsrx.stderr || tsrx.stdout);
  assert.equal(tsrx.stdout, "", tsrx.stdout);

  // A directory that happens to contain a `.tsrx` file must answer the same way.
  const directory = await runCompanion(cwd, ["--frobnicate", "src"]);
  assert.equal(directory.stderr, control.stderr, directory.stderr);
  assert.equal(directory.code, control.code, directory.stderr || directory.stdout);

  // An inline value names the option, not the whole token, exactly as the
  // control does.
  const controlInline = await run(cwd, ["--frobnicate=1", "src/util.ts"], stock);
  const inline = await runCompanion(cwd, ["--frobnicate=1", "src/Counter.tsrx"]);
  assert.equal(inline.stderr, controlInline.stderr, inline.stderr);
  assert.equal(inline.code, controlInline.code, inline.stderr || inline.stdout);

  // The ordinary-only route still reaches canonical Oxlint itself, so its
  // rejection cannot drift from the tool that produces it.
  const ordinary = await runCompanion(cwd, ["--frobnicate", "src/util.ts"]);
  assert.equal(ordinary.stderr, control.stderr, ordinary.stderr);
  assert.equal(ordinary.code, control.code, ordinary.stderr || ordinary.stdout);
});

test("a real Oxlint flag the TSRX lane has not implemented still says so", async () => {
  const cwd = await mixedProject("unsupported-option");

  // Prove against the live control that `--fix-suggestions` really is an Oxlint
  // option: it is accepted, and it is not rejected the way `--frobnicate` is.
  const control = await run(
    cwd,
    ["--fix-suggestions", "--no-error-on-unmatched-pattern", "src/Missing.ts"],
    stock,
  );
  assert.equal(control.code, 0, control.stderr || control.stdout);
  assert.doesNotMatch(control.stderr, /is not expected in this context/u, control.stderr);

  const unsupported = await runCompanion(cwd, ["--fix-suggestions", "src/Counter.tsrx"]);
  assert.equal(unsupported.code, 2, unsupported.stderr || unsupported.stdout);
  assert.match(unsupported.stderr, /--fix-suggestions is not yet supported for \.tsrx/u);
  assert.doesNotMatch(unsupported.stderr, /is not expected in this context/u);
});

test("a native lint failure is attributed to the command the user ran", async () => {
  const cwd = await mixedProject("error-attribution");

  const failure = await runCompanion(cwd, ["--config", "no-such-config.json", "src/Counter.tsrx"]);
  assert.equal(failure.code, 2, failure.stdout);
  // The leaf labels itself `oxc-tsrx:` because that is correct when it is run
  // directly as the capability target. The user typed `oxlint`.
  assert.doesNotMatch(failure.stderr, /^oxc-tsrx(?:-lint)?: /mu, failure.stderr);
  assert.match(failure.stderr, /^oxlint \(oxc-tsrx\): /mu, failure.stderr);
  assert.match(failure.stderr, /no-such-config\.json/u, failure.stderr);
});

test("oxc-tsrx accepts --help and --version instead of calling them unknown commands", async () => {
  const cwd = await mixedProject("oxc-tsrx-flags");
  const manifest = JSON.parse(
    await readFile(join(root, "packages/toolchain/package.json"), "utf8"),
  );
  const runProvider = (args) => run(cwd, [provider, ...args], process.execPath);

  const subcommand = await runProvider(["help"]);
  assert.equal(subcommand.code, 0, subcommand.stderr);
  assert.match(subcommand.stdout, /^oxc-tsrx\n\nUsage:/u, subcommand.stdout);

  for (const flag of ["--help", "-h"]) {
    const result = await runProvider([flag]);
    assert.equal(result.code, 0, `${flag}: ${result.stderr}`);
    assert.equal(result.stdout, subcommand.stdout, flag);
    assert.equal(result.stderr, "", flag);
  }

  for (const flag of ["--version", "-V"]) {
    const result = await runProvider([flag]);
    assert.equal(result.code, 0, `${flag}: ${result.stderr}`);
    assert.equal(result.stdout, `oxc-tsrx ${manifest.version}\n`, flag);
    assert.equal(result.stderr, "", flag);
  }

  // A genuinely wrong subcommand keeps naming itself and exiting 2.
  const unknown = await runProvider(["lint"]);
  assert.equal(unknown.code, 2, unknown.stdout);
  assert.match(unknown.stderr, /unknown command: lint/u, unknown.stderr);
});

test("the drop-in oxlint skips gitignored trees and survives a file list past the argument limit", async () => {
  // A monorepo that keeps gitignored copies of itself (agent worktrees, build output) used to
  // hand every copy to the native leaf on the command line: hundreds of thousands of paths,
  // then spawn E2BIG. Discovery now walks with .gitignore honoured, and a long list travels in
  // a file, which is also what keeps a few hundred paths under Windows's 32 KiB command line.
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-discovery-launcher-"));
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(join(directory, "ignored/copy"), { recursive: true });
  await mkdir(join(directory, "many"), { recursive: true });
  await writeFile(join(directory, ".gitignore"), "ignored/\n");
  await writeFile(join(directory, ".oxlintrc.json"), '{ "rules": { "no-debugger": "error" } }\n');
  const offending = "export function View() @{\n  debugger;\n  <p>hi</p>;\n}\n";
  await writeFile(join(directory, "src/a.tsrx"), offending);
  await writeFile(join(directory, "src/ordinary.ts"), "export const ordinary = 1;\n");
  await writeFile(join(directory, "ignored/copy/b.tsrx"), offending);
  const count = 1500;
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeFile(join(directory, "many", `component-number-${index}.tsrx`), "export function Ok() @{\n  <p>ok</p>;\n}\n"),
    ),
  );
  const listBytes = count * (join(directory, "many", "component-number-0000.tsrx").length + 1);
  assert.ok(listBytes > 24_000, `the list must exceed the inline budget (${listBytes} bytes)`);

  const result = await runCompanion(directory, ["--format=json", "."]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = json(result);
  assert.equal(output.number_of_files, count + 2, "every discovered file, and nothing from ignored/");
  const files = new Set(output.diagnostics.map((item) => item.filename));
  assert.equal(files.size, 1);
  assert.ok([...files][0].endsWith("src/a.tsrx"), [...files][0]);
  await rm(directory, { recursive: true, force: true });
});

test("the drop-in oxlint names and positions a file OXC cannot parse and keeps the batch", async () => {
  // tsrx-org/oxc#79: the whole run used to exit 2 with an unattributed parse failure.
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-parse-failure-launcher-"));
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, ".oxlintrc.json"), '{ "rules": { "no-debugger": "error" } }\n');
  await writeFile(
    join(directory, "src/Probe.tsrx"),
    "export function Probe() @{\n\tconst element = document.createElement('div');\n\tdocument./*completion*/;\n\t<div>{element.dataset}</div>\n}\n",
  );
  await writeFile(join(directory, "src/Clean.tsrx"), "export function Clean() @{\n\tdebugger;\n\t<p>hi</p>\n}\n");
  await writeFile(join(directory, "src/ordinary.ts"), "export const ordinary = 1;\n");

  const result = await runCompanion(directory, ["."]);
  assert.equal(result.code, 1, `errors exit 1, never the tool-failure 2: ${result.stderr || result.stdout}`);
  assert.doesNotMatch(result.stderr, /OXC parse failed/u, "the failure is a diagnostic, not a stderr abort");
  assert.match(result.stdout, /src\/Probe\.tsrx:3:\d+: error: OXC parse failed: /u, result.stdout);
  assert.match(result.stdout, /src\/Clean\.tsrx:2:\d+: error eslint\(no-debugger\)/u, result.stdout);
  assert.match(result.stdout, /on 3 files/u, result.stdout);
  await rm(directory, { recursive: true, force: true });
});

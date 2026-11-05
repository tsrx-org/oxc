import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installPhysicalToolPackages } from "../vite/physical-consumer.mjs";
import { resolveTsgolintExecutable } from "../helpers/tsgolint-path.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const binary = resolve(process.env.OXLINT_BIN ?? join(root, "target/release/oxc-tsrx"));
// `node_modules/.bin/tsgolint` is a pnpm command shim, and the adapter verifies
// the tsgolint version by reading the manifest above the executable, which a
// shim has no path to. The platform package is the real binary.
const tsgolint = resolveTsgolintExecutable(root);
if (!tsgolint) throw new Error("tsgolint is not installed for this host: run pnpm install");
const singleRoot = join(root, "tests/fixtures/type-aware/single");
const singleSource = join(singleRoot, "View.tsrx");
const projectRoot = join(root, "tests/fixtures/type-aware/project");
const projectView = join(projectRoot, "View.tsrx");
const projectService = join(projectRoot, "service.tsrx");
const typeCheckRoot = join(root, "tests/fixtures/type-aware/type-check");
const typeCheckSource = join(typeCheckRoot, "View.tsrx");
const fixRoot = join(root, "tests/fixtures/type-aware/fix");
const fixSource = join(fixRoot, "View.tsrx");
const controlRoot = join(root, "tests/fixtures/type-aware/control");
const controlSource = join(controlRoot, "View.tsrx");
const componentRoot = join(root, "tests/fixtures/type-aware/component-project");
const componentView = join(componentRoot, "View.tsrx");
const componentApp = join(componentRoot, "App.tsx");
const consistentReturnRoot = join(root, "tests/fixtures/type-aware/consistent-return");
const consistentReturnSource = join(consistentReturnRoot, "View.tsrx");
const unreachableEndRoot = join(root, "tests/fixtures/type-aware/unreachable-end");
const unreachableEndSource = join(unreachableEndRoot, "View.tsrx");

function run(cwd, args, env = process.env, executable = binary) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function parseJson(result) {
  assert.equal(result.signal, null);
  const start = result.stdout.indexOf("{");
  assert.notEqual(start, -1, result.stderr || result.stdout);
  return JSON.parse(result.stdout.slice(start));
}

function byteOffset(source, needle) {
  const characterOffset = source.indexOf(needle);
  assert.notEqual(characterOffset, -1, `Missing ${needle}`);
  return Buffer.byteLength(source.slice(0, characterOffset));
}

test("type-aware lint maps a real tsgolint diagnostic to authored TSRX", async () => {
  const source = await readFile(singleSource, "utf8");
  const result = await run(singleRoot, ["--format=json", "--type-aware", singleSource]);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  const diagnostic = output.diagnostics.find(
    (item) => item.rule === "no-floating-promises",
  );
  assert.ok(diagnostic, result.stdout);
  assert.equal(diagnostic.filename, singleSource);
  assert.equal(diagnostic.code, "typescript(no-floating-promises)");
  assert.equal(diagnostic.severity, "error");
  assert.equal(
    diagnostic.labels.some(
      (label) =>
        // tsgolint 7.x labels the awaited expression, not the statement's semicolon.
        label.span.offset === byteOffset(source, "save();") &&
        label.span.length === Buffer.byteLength("save()"),
    ),
    true,
    result.stdout,
  );
  assert.equal(output.oxcTsrx.parseCount, 1);
  assert.equal(output.oxcTsrx.typeAware, true);
  assert.equal(output.oxcTsrx.typeAwareFiles, 1);
  assert.equal(output.oxcTsrx.typeAwareProcesses, 1);
});

test("a project batch preserves explicit .tsrx imports and authored override intent", async () => {
  const source = await readFile(projectView, "utf8");
  const result = await run(projectRoot, [
    "--format=json",
    "--type-aware",
    projectView,
    projectService,
  ]);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  const diagnostics = output.diagnostics.filter(
    (item) => item.rule === "no-floating-promises",
  );
  assert.equal(diagnostics.length, 1, result.stdout);
  assert.equal(diagnostics[0].filename, projectView);
  assert.equal(diagnostics[0].labels[0].span.offset, byteOffset(source, "save();"));
  assert.equal(output.number_of_files, 2);
  assert.equal(output.oxcTsrx.parseCount, 2);
  assert.equal(output.oxcTsrx.typeAwareFiles, 2);
  assert.equal(output.oxcTsrx.typeAwareProcesses, 1);
});

test("--type-check maps TypeScript compiler diagnostics to authored bytes", async () => {
  const source = await readFile(typeCheckSource, "utf8");
  const result = await run(typeCheckRoot, [
    "--format=json",
    "--type-check",
    typeCheckSource,
  ]);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  const diagnostic = output.diagnostics.find((item) => item.code === "typescript(TS2322)");
  assert.ok(diagnostic, result.stdout);
  assert.equal(diagnostic.filename, typeCheckSource);
  assert.equal(
    diagnostic.labels.some(
      (label) => label.span.offset === byteOffset(source, "count: number"),
    ),
    true,
    result.stdout,
  );
  assert.equal(output.oxcTsrx.typeCheck, true);
  assert.equal(output.oxcTsrx.typeAwareProcesses, 1);
});

test("--fix applies an identity-safe type-aware edit and validates TSRX", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-type-fix-"));
  const sourcePath = join(cwd, "View.tsrx");
  await copyFile(fixSource, sourcePath);
  await copyFile(join(fixRoot, ".oxlintrc.json"), join(cwd, ".oxlintrc.json"));
  await copyFile(join(fixRoot, "tsconfig.json"), join(cwd, "tsconfig.json"));
  const before = await readFile(sourcePath, "utf8");
  const result = await run(
    cwd,
    ["--format=json", "--type-aware", "--fix", sourcePath],
    { ...process.env, OXLINT_TSGOLINT_PATH: tsgolint },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = parseJson(result);
  const after = await readFile(sourcePath, "utf8");
  assert.match(before, /identity<string>/);
  assert.doesNotMatch(after, /identity<string>/);
  assert.match(after, /identity\("saved"\)/);
  assert.match(after, /export function View\(\) @\{/);
  assert.equal(output.oxcTsrx.fixes.applied, 1);
  assert.equal(output.oxcTsrx.reparseCount, 1);
});

test("--fix rejects type-aware suggestions that may change meaning", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-type-suggestion-"));
  const sourcePath = join(cwd, "View.tsrx");
  await copyFile(singleSource, sourcePath);
  await copyFile(join(singleRoot, ".oxlintrc.json"), join(cwd, ".oxlintrc.json"));
  await copyFile(join(singleRoot, "tsconfig.json"), join(cwd, "tsconfig.json"));
  const before = await readFile(sourcePath, "utf8");
  const result = await run(
    cwd,
    ["--format=json", "--type-aware", "--fix", sourcePath],
    { ...process.env, OXLINT_TSGOLINT_PATH: tsgolint },
  );

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  assert.equal(await readFile(sourcePath, "utf8"), before);
  assert.ok(output.oxcTsrx.fixes.rejected > 0, result.stdout);
  assert.ok(output.diagnostics.some((item) => item.rule === "no-floating-promises"));
});

test("missing and unsupported tsgolint binaries fail without a silent downgrade", async () => {
  const missing = await run(
    singleRoot,
    ["--format=json", "--type-aware", singleSource],
    { ...process.env, OXLINT_TSGOLINT_PATH: join(tmpdir(), "missing-tsgolint") },
  );
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /OXLINT_TSGOLINT_PATH|executable/i);

  const packageRoot = await mkdtemp(join(tmpdir(), "oxc-tsrx-old-tsgolint-"));
  const binDirectory = join(packageRoot, "bin");
  const executable = join(binDirectory, "tsgolint");
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "oxlint-tsgolint", version: "0.23.0" }),
  );
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  const unsupported = await run(
    singleRoot,
    ["--format=json", "--type-aware", singleSource],
    { ...process.env, OXLINT_TSGOLINT_PATH: executable },
  );
  assert.equal(unsupported.code, 2);
  assert.equal(unsupported.stdout, "");
  assert.match(unsupported.stderr, /unsupported.*0\.23\.0.*7\.0\.2002/i);
});

test("type projection preserves loop and branch scopes without synthetic type errors", async () => {
  const source = await readFile(controlSource, "utf8");
  const result = await run(controlRoot, [
    "--format=json",
    "--type-check",
    controlSource,
  ]);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  const floating = output.diagnostics.filter((item) => item.rule === "no-floating-promises");
  assert.equal(floating.length, 2, result.stdout);
  assert.ok(floating.every((item) => item.filename === controlSource));
  assert.deepEqual(
    floating.map((item) => item.labels[0].span.offset).sort((left, right) => left - right),
    [byteOffset(source, "item.save();"), byteOffset(source, "saveAll();")],
  );
  const compilerDiagnostics = output.diagnostics.filter((item) =>
    item.code.startsWith("typescript(TS"),
  );
  assert.deepEqual(compilerDiagnostics, [], result.stdout);
});

test("cross-file component inference remains usable from ordinary TSX", async () => {
  const result = await run(componentRoot, [
    "--format=json",
    "--type-check",
    componentView,
    componentApp,
  ]);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  assert.deepEqual(
    output.diagnostics.filter((item) => item.code.startsWith("typescript(TS")),
    [],
    result.stdout,
  );
  const floating = output.diagnostics.filter((item) => item.rule === "no-floating-promises");
  assert.equal(floating.length, 1, result.stdout);
  assert.equal(floating[0].filename, componentApp);
  assert.equal(output.oxcTsrx.typeAwareProcesses, 1);
  assert.equal(output.oxcTsrx.parseCount, 2);
});

// Issue #224: the projection used to open every `@{` body with a placeholder return, so each
// component returned a value first and then fell off its end, and `consistent-return` reported
// the component itself.
test("consistent-return reports only the returns the author wrote", async () => {
  const source = await readFile(consistentReturnSource, "utf8");
  const result = await run(consistentReturnRoot, [
    "--format=json",
    "--type-check",
    consistentReturnSource,
  ]);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  assert.deepEqual(
    output.diagnostics.filter((item) => item.code.startsWith("typescript(TS")),
    [],
    result.stdout,
  );
  const reports = output.diagnostics
    .filter((item) => item.rule === "consistent-return")
    .map((item) => ({ message: item.message, offset: item.labels[0].span.offset }))
    .sort((left, right) => left.offset - right.offset);
  // `Label`, `Guarded`, and `Badge` are not reported. `Mixed` is, at the bare `return;` that
  // disagrees with its earlier `return 1;`, and so is the ordinary function `pick`.
  assert.deepEqual(
    reports,
    [
      {
        message: "Function 'Mixed' expected a return value.",
        offset: byteOffset(source, "return;\n  <span>{props.text}</span>\n}\n\nexport function pick"),
      },
      {
        message: "Function 'pick' expected a return value.",
        offset: byteOffset(source, "export function pick"),
      },
    ],
    result.stdout,
  );
});

// The return that ends each `@{` body is unreachable after an authored `return` or `throw`, and
// `allowUnreachableCode: false` makes TypeScript report it. Only authored code may be reported.
test("unreachable-code reports cover authored statements and never the body's own return", async () => {
  const source = await readFile(unreachableEndSource, "utf8");
  const result = await run(unreachableEndRoot, [
    "--format=json",
    "--type-check",
    unreachableEndSource,
  ]);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  const compilerDiagnostics = output.diagnostics
    .filter((item) => item.code.startsWith("typescript(TS"))
    .map((item) => ({ code: item.code, labels: item.labels.map((label) => label.span) }));
  // TypeScript reports `Authored`'s dead markup and the synthetic return as one run. The report
  // keeps its authored part, ending where the authored statement does.
  assert.deepEqual(
    compilerDiagnostics,
    [
      {
        code: "typescript(TS7027)",
        labels: [
          {
            offset: byteOffset(source, "<span>never</span>"),
            length: Buffer.byteLength("<span>never</span>"),
          },
        ],
      },
    ],
    result.stdout,
  );
  // `Returns`, `Throws`, `Branches`, and `Loops` each get a report on the synthetic return only.
  assert.equal(output.oxcTsrx.diagnosticsSuppressed, 4, result.stdout);
  assert.equal(
    output.diagnostics.filter((item) => item.rule === "consistent-return").length,
    0,
    result.stdout,
  );
});

// Issue #223. A `.tsrx` module only reaches tsgolint as an in-memory
// `X.tsrx.tsx` projection, and only the files being linted were projected, so
// an import of any other `.tsrx` file failed with TS2307 and was typed `any`.
// Every `.tsrx` file the run imports is now projected as a read-only overlay:
// the import resolves, but the imported file is neither linted nor reported.
// `label.tsrx` plants its own floating promise and TS2322 to prove the latter.
const importedRoot = join(root, "tests/fixtures/type-aware/imported-tsrx");

async function importedRun(files) {
  const result = await run(
    importedRoot,
    ["--format=json", "--type-check", ...files],
    { ...process.env, OXLINT_TSGOLINT_PATH: tsgolint },
  );
  assert.equal(result.code, 1, result.stderr || result.stdout);
  return { output: parseJson(result), stdout: result.stdout };
}

for (const [importer, call] of [
  ["src/app.tsrx", "loadLabel();"],
  ["src/main.ts", "loadLabel();"],
  ["src/chain/entry.tsrx", "middle();"],
  ["src/cycle/a.tsrx", "pingB();"],
  // Through an ordinary barrel that re-exports the `.tsrx` module and is not linted.
  ["src/viaBarrel.ts", "loadLabel();"],
  ["src/viaBarrelView.tsrx", "loadLabel();"],
]) {
  test(`a .tsrx import outside the run resolves from ${importer}`, async () => {
    const source = await readFile(join(importedRoot, importer), "utf8");
    const { output, stdout } = await importedRun([importer]);
    assert.deepEqual(
      output.diagnostics.map((item) => [item.filename, item.code]),
      [[join(importedRoot, importer), "typescript(no-floating-promises)"]],
      stdout,
    );
    assert.equal(output.diagnostics[0].labels[0].span.offset, byteOffset(source, call), stdout);
    assert.equal(output.number_of_files, 1);
    assert.equal(output.oxcTsrx.typeAwareProcesses, 1);
  });
}

test("an imported .tsrx file is reported only when it is itself linted", async () => {
  const { output, stdout } = await importedRun(["src/main.ts", "src/label.tsrx"]);
  const codes = output.diagnostics
    .map((item) => [item.filename.slice(importedRoot.length + 1), item.code])
    .sort();
  assert.deepEqual(
    codes,
    [
      ["src/label.tsrx", "typescript(TS2322)"],
      ["src/label.tsrx", "typescript(no-floating-promises)"],
      ["src/main.ts", "typescript(no-floating-promises)"],
    ],
    stdout,
  );
});

test("the @tsrx/oxc lint bridge enables type awareness from resolved Vite+ config", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-type-vite-plus-"));
  const source = join(cwd, "View.tsrx");
  const modules = join(cwd, "node_modules");
  await mkdir(modules, { recursive: true });
  // installPhysicalToolPackages records `@tsrx/oxc` in the consumer's manifest,
  // so the consumer needs one. Every other caller copies a fixture that already
  // has it; this one builds its project by hand.
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "oxc-tsrx-type-aware-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  await installPhysicalToolPackages(modules, "vite-plus-current");
  await copyFile(singleSource, source);
  await copyFile(join(singleRoot, "tsconfig.json"), join(cwd, "tsconfig.json"));
  await copyFile(join(singleRoot, "vite.config.ts"), join(cwd, "vite.config.ts"));
  const result = await run(
    cwd,
    ["--format=json", source],
    {
      ...process.env,
      OXC_TSRX_LINT_BIN: binary,
      OXLINT_TSGOLINT_PATH: tsgolint,
      NODE_PATH: [modules, join(root, "node_modules")].join(delimiter),
      VP_COMMAND: "lint",
      VP_VERSION: "0.3.3",
    },
    join(modules, "oxlint/bin/oxlint"),
  );

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  assert.ok(output.diagnostics.some((item) => item.rule === "no-floating-promises"));
  assert.equal(output.oxcTsrx.typeAware, true);
  assert.equal(output.oxcTsrx.typeAwareProcesses, 1);
});

// The shape a `vp create` scaffold really has: Vite+ writes
// `lint.options: { typeAware: true, typeCheck: true }` and a `jsPlugins` entry
// for its own Oxlint plugin into the same `lint` block, so a stock project asks
// for both lanes at once. Both lanes then ask the native binary for something:
// the type-aware lane lints, and the JavaScript plugin lane asks for each
// `.tsrx` file's TSX projection. The projection request used to be refused for
// carrying a type-aware config without the `--type-aware` opt-in, even though it
// starts no rule and prints no diagnostic, and that refusal took the whole batch
// down: a stock scaffold reported nothing at all on any run that contained a
// `.tsrx` file.
test("a stock scaffold's type-aware and jsPlugins lanes both report on .tsrx", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-type-stock-scaffold-"));
  const source = join(cwd, "View.tsrx");
  const modules = join(cwd, "node_modules");
  await mkdir(modules, { recursive: true });
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "oxc-tsrx-stock-scaffold-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  await installPhysicalToolPackages(modules, "vite-plus-current");
  await copyFile(singleSource, source);
  await copyFile(join(singleRoot, "tsconfig.json"), join(cwd, "tsconfig.json"));
  // An ordinary Oxlint JavaScript plugin, in the project's own directory, the
  // way a scaffold's `jsPlugins` entry points at one.
  await writeFile(
    join(cwd, "house-rules.mjs"),
    `const noJsxMain = {
  meta: {
    type: "suggestion",
    docs: { description: "Prefer a section over a main element" },
    messages: { main: "Use <section> instead of <main>." },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name?.name !== "main") return;
        context.report({ node, messageId: "main" });
      },
    };
  },
};

export default {
  meta: { name: "house-rules", version: "1.0.0" },
  rules: { "no-jsx-main": noJsxMain },
};
`,
  );
  await writeFile(
    join(cwd, "vite.config.ts"),
    `export default {
  lint: {
    plugins: ["typescript"],
    rules: {
      "typescript/no-floating-promises": "error",
      "house-rules/no-jsx-main": "warn",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "house-rules",
        specifier: "./house-rules.mjs",
      },
    ],
  },
};
`,
  );
  const result = await run(
    cwd,
    ["--format=json", source],
    {
      ...process.env,
      OXC_TSRX_LINT_BIN: binary,
      OXLINT_TSGOLINT_PATH: tsgolint,
      NODE_PATH: [modules, join(root, "node_modules")].join(delimiter),
      VP_COMMAND: "lint",
      VP_VERSION: "0.3.3",
    },
    join(modules, "oxlint/bin/oxlint"),
  );

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJson(result);
  assert.equal(output.oxcTsrx.typeAware, true);
  assert.equal(output.oxcTsrx.typeAwareProcesses, 1);
  const typeAware = output.diagnostics.filter((item) => item.rule === "no-floating-promises");
  assert.equal(typeAware.length, 1, result.stdout);
  assert.equal(typeAware[0].filename, source);
  const plugin = output.diagnostics.filter((item) =>
    String(item.code ?? "").startsWith("house-rules("),
  );
  assert.equal(plugin.length, 1, result.stdout);
  assert.equal(plugin[0].filename, source);
  assert.equal(output.oxcTsrx.jsPluginProjection.files, 1, result.stdout);
  assert.equal(output.oxcTsrx.jsPluginProjection.unmapped, 0, result.stdout);
});

// The opt-in gate itself is unchanged: it guards a run that evaluates rules, and
// only the projection request is exempt from it. Both halves are asserted here
// so a future change cannot buy the projection fix by dropping the gate.
test("the projection request is exempt from the type-aware opt-in, a lint run is not", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oxc-tsrx-projection-opt-in-"));
  const source = join(cwd, "View.tsrx");
  await copyFile(singleSource, source);
  const config = join(cwd, ".oxlintrc.json");
  await writeFile(
    config,
    `${JSON.stringify({ options: { typeAware: true, typeCheck: true } }, null, 2)}\n`,
  );

  const projection = await run(cwd, [
    "--emit-plugin-projection",
    "--config",
    config,
    "--config-base",
    cwd,
    source,
  ]);
  assert.equal(projection.code, 0, projection.stderr || projection.stdout);
  const projections = parseJson(projection).projections;
  assert.equal(projections.length, 1, projection.stdout);
  assert.equal(projections[0].path, source);
  assert.match(projections[0].projected, /save\(\)/u);

  const linting = await run(cwd, [
    "--format=json",
    "--config",
    config,
    "--config-base",
    cwd,
    source,
  ]);
  assert.equal(linting.code, 2, linting.stdout);
  assert.equal(linting.stdout, "");
  assert.match(
    linting.stderr,
    /type-aware tsgolint\/type-check mode requires the explicit --type-aware or --type-check opt-in/u,
  );
});

// Issue #218. A `.tsrx` projection reaches tsgolint as an in-memory
// `View.tsrx.tsx`, and tsgolint expands `include` by listing directories, which
// never shows it. Every projection was checked in tsgolint's inferred project
// instead: React JSX, no `paths`, no `types`. Each fixture's tsconfig points JSX
// at a runtime that is not React, so a projection outside its project reports
// TS2875/TS7016 for `react/jsx-runtime` next to the one planted TS2322.
const ownerRoot = join(root, "tests/fixtures/type-aware/tsconfig-owner");

async function typeCheckCodes(cwd, extra = [], file = "src/View.tsrx") {
  const result = await run(
    cwd,
    ["--format=json", "--type-check", "-c", join(ownerRoot, ".oxlintrc.json"), ...extra, file],
    { ...process.env, OXLINT_TSGOLINT_PATH: tsgolint },
  );
  assert.equal(result.code, 1, result.stderr || result.stdout);
  return parseJson(result).diagnostics.map((diagnostic) => diagnostic.code);
}

for (const [fixture, shape] of [
  ["include-directory", `"include": ["./src/"]`],
  ["extends", "an include inherited through extends"],
  ["solution", "a solution tsconfig whose reference includes **/*.tsrx"],
]) {
  test(`--type-check applies the owning tsconfig: ${shape}`, async () => {
    assert.deepEqual(await typeCheckCodes(join(ownerRoot, fixture)), ["typescript(TS2322)"]);
  });
}

test("--tsconfig names the project every .tsrx file is type-checked in", async () => {
  const cwd = join(ownerRoot, "explicit");
  // The nearest tsconfig includes only `other/`, so without the flag the file has no project.
  assert.ok((await typeCheckCodes(cwd)).length > 1);
  assert.deepEqual(await typeCheckCodes(cwd, ["--tsconfig", "tsconfig.tsrx.json"]), [
    "typescript(TS2322)",
  ]);
});

// tsgolint panics on a config path it derives from an unnormalized file path,
// and `./src/View.tsrx` is how a shell completion or a script names a file.
test("a ./ or ../ path still reaches the owning tsconfig", async () => {
  const cwd = join(ownerRoot, "include-directory");
  for (const file of ["./src/View.tsrx", "src/../src/View.tsrx"]) {
    assert.deepEqual(await typeCheckCodes(cwd, [], file), ["typescript(TS2322)"], file);
  }
});

test("an unreadable --tsconfig fails instead of falling back to defaults", async () => {
  const result = await run(
    join(ownerRoot, "explicit"),
    ["--format=json", "--type-check", "--tsconfig", "missing.json", "src/View.tsrx"],
    { ...process.env, OXLINT_TSGOLINT_PATH: tsgolint },
  );
  assert.equal(result.code, 2, result.stdout);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--tsconfig does not name a readable tsconfig: .*missing\.json/u);
});

// A project on current Oxlint installs a later 7.0 tsgolint, and under pnpm its
// platform binary lives in the store beside `oxlint-tsgolint`, not in the
// project's `node_modules`. Discovery follows the package link to it, and the
// version check accepts every later 7.0 release.
test("a later 7.0 tsgolint in a pnpm store layout is found and accepted", async () => {
  const project = await mkdtemp(join(tmpdir(), "oxc-tsrx-pnpm-tsgolint-"));
  const store = join(project, "node_modules/.pnpm/oxlint-tsgolint@7.0.2099/node_modules");
  const platform = basename(dirname(tsgolint));
  const nativeDirectory = join(store, "@oxlint-tsgolint", platform);
  const executable = join(nativeDirectory, basename(tsgolint));
  await mkdir(join(store, "oxlint-tsgolint"), { recursive: true });
  await mkdir(nativeDirectory, { recursive: true });
  await writeFile(
    join(store, "oxlint-tsgolint/package.json"),
    JSON.stringify({ name: "oxlint-tsgolint", version: "7.0.2099" }),
  );
  await writeFile(
    join(nativeDirectory, "package.json"),
    JSON.stringify({ name: `@oxlint-tsgolint/${platform}`, version: "7.0.2099" }),
  );
  await copyFile(tsgolint, executable);
  await chmod(executable, 0o755);
  await symlink(
    join(store, "oxlint-tsgolint"),
    join(project, "node_modules/oxlint-tsgolint"),
    "junction",
  );
  const source = join(project, "View.tsrx");
  await copyFile(singleSource, source);
  await copyFile(join(singleRoot, ".oxlintrc.json"), join(project, ".oxlintrc.json"));
  await copyFile(join(singleRoot, "tsconfig.json"), join(project, "tsconfig.json"));
  const environment = { ...process.env };
  delete environment.OXLINT_TSGOLINT_PATH;
  delete environment.OXC_TSRX_BUNDLED_TSGOLINT;
  const result = await run(project, ["--format=json", "--type-aware", source], environment);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.ok(
    parseJson(result).diagnostics.some((item) => item.rule === "no-floating-promises"),
    result.stdout,
  );
});

test("the drop-in oxlint passes --tsconfig to the .tsrx lane", async () => {
  const result = await run(
    join(ownerRoot, "explicit"),
    [
      "--format=json",
      "--type-check",
      "-c",
      join(ownerRoot, ".oxlintrc.json"),
      "--tsconfig",
      "tsconfig.tsrx.json",
      "src/View.tsrx",
    ],
    { ...process.env, OXC_TSRX_LINT_BIN: binary, OXLINT_TSGOLINT_PATH: tsgolint },
    join(root, "packages/toolchain/bin/oxlint"),
  );
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.deepEqual(
    parseJson(result).diagnostics.map((diagnostic) => diagnostic.code),
    ["typescript(TS2322)"],
  );
});

// tsrx-org/oxc#223. The drop-in `oxlint` command hands `.ts` files to canonical
// Oxlint, whose own tsgolint read them from disk with no TSRX projection, so
// `main.ts`'s `import { loadLabel } from "./label.tsrx"` was TS2307, typed
// `any`, and `loadLabel()` was not a floating promise. Canonical Oxlint now runs
// the native tsgolint proxy, which overlays the imported projection. Each route
// the drop-in takes to canonical Oxlint is covered: a directory (composed
// batch), an ordinary file alone (Oxlint in this process), and an ordinary file
// beside a `.tsrx` file (canonical Oxlint prestarted before the batch).
// `vp lint` runs the same command under a Vite+ host, which composes the batch
// without a prestart.
const vitePlusHost = { VP_COMMAND: "lint", VP_VERSION: "0.3.3" };
// A `.tsrx` module reached through an ordinary barrel that is not linted is
// followed as well, which is all the language server ever has: one file.
for (const [route, files, host, importer] of [
  ["a directory", ["src"], {}, "src/main.ts"],
  ["an ordinary file alone", ["src/main.ts"], {}, "src/main.ts"],
  ["an ordinary file beside a .tsrx file", ["src/main.ts", "src/app.tsrx"], {}, "src/main.ts"],
  ["a directory under vp lint", ["src"], vitePlusHost, "src/main.ts"],
  ["an ordinary file through a barrel", ["src/viaBarrel.ts"], {}, "src/viaBarrel.ts"],
  [
    "an ordinary file through a barrel beside a .tsrx file",
    ["src/viaBarrel.ts", "src/app.tsrx"],
    {},
    "src/viaBarrel.ts",
  ],
]) {
  test(`the drop-in oxlint resolves a .tsrx import from a .ts file: ${route}`, async () => {
    const source = await readFile(join(importedRoot, importer), "utf8");
    const result = await run(
      importedRoot,
      ["--format=json", "--type-aware", "--type-check", ...files],
      { ...process.env, ...host, OXC_TSRX_LINT_BIN: binary, OXLINT_TSGOLINT_PATH: tsgolint },
      join(root, "packages/toolchain/bin/oxlint"),
    );
    assert.equal(result.code, 1, result.stderr || result.stdout);
    const diagnostics = parseJson(result).diagnostics;
    assert.deepEqual(
      diagnostics.filter((item) => item.code === "typescript(TS2307)"),
      [],
      result.stdout,
    );
    const reported = diagnostics.filter(
      (item) => resolve(importedRoot, item.filename) === join(importedRoot, importer),
    );
    assert.deepEqual(
      reported.map((item) => item.code),
      ["typescript(no-floating-promises)"],
      result.stdout,
    );
    assert.equal(
      reported[0].labels[0].span.offset,
      byteOffset(source, "loadLabel();"),
      result.stdout,
    );
    // The imported module is read, never reported, unless it is itself linted,
    // as it is when the whole directory is.
    if (!files.includes("src")) {
      assert.ok(
        diagnostics.every((item) => !item.filename.endsWith("label.tsrx")),
        result.stdout,
      );
    }
  });
}

// The proxy itself, as canonical Oxlint starts it: `headless`, the payload on
// stdin. A stand-in tsgolint records what it was handed. The language server
// serves several roots from one process, and each root's own
// `node_modules/.bin/tsgolint` is the one its payloads go to.
test(
  "the native tsgolint proxy overlays a barrel's .tsrx import and finds each root's tsgolint",
  { skip: process.platform === "win32" ? "the stand-in tsgolint is a shell script" : false },
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oxc-tsrx-proxy-roots-"));
    const roots = [join(workspace, "a"), join(workspace, "b")];
    for (const [index, project] of roots.entries()) {
      await mkdir(join(project, "src"), { recursive: true });
      await mkdir(join(project, "node_modules/.bin"), { recursive: true });
      const recorder = join(project, "node_modules/.bin/tsgolint");
      await writeFile(
        recorder,
        `#!/bin/sh\necho "$@" > "${project}/args"\ncat > "${project}/payload.json"\nexit ${index + 3}\n`,
      );
      await chmod(recorder, 0o755);
      for (const file of ["label.tsrx", "barrel.ts", "viaBarrel.ts"]) {
        await copyFile(join(importedRoot, "src", file), join(project, "src", file));
      }
    }
    for (const [index, project] of roots.entries()) {
      const importer = join(project, "src/viaBarrel.ts");
      const payload = JSON.stringify({
        version: 2,
        configs: [{ file_paths: [importer], rules: [{ name: "no-floating-promises" }] }],
        source_overrides: { [importer]: await readFile(importer, "utf8") },
        report_syntactic: false,
        report_semantic: false,
      });
      const child = spawn(binary, ["headless", "-fix"], {
        cwd: workspace,
        env: {
          ...process.env,
          OXC_TSRX_TSGOLINT_PROXY: "",
          OXC_TSRX_TSGOLINT_PROXY_SEARCH: "1",
        },
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin.end(payload);
      const code = await new Promise((resolveCode) => child.once("close", resolveCode));
      assert.equal(code, index + 3);
      assert.equal((await readFile(join(project, "args"), "utf8")).trim(), "headless -fix");
      const handed = JSON.parse(await readFile(join(project, "payload.json"), "utf8"));
      assert.deepEqual(
        Object.keys(handed.source_overrides).sort(),
        [importer, join(project, "src/label.tsrx.tsx")].sort(),
      );
      assert.deepEqual(handed.configs, JSON.parse(payload).configs);
    }
  },
);

test("the tsgolint proxy stands in only when canonical Oxlint would have found a tsgolint", async () => {
  const { TSGOLINT_PROXY_ENV, canonicalTsgolintExecutable, withTsgolintProxy } = await import(
    "../../packages/toolchain/dist/tsgolint-proxy.js"
  );
  const native = { resolveNative: () => binary };
  const environment = { PATH: "", OXLINT_TSGOLINT_PATH: tsgolint };
  assert.deepEqual(withTsgolintProxy(environment, importedRoot, native), {
    PATH: "",
    OXLINT_TSGOLINT_PATH: binary,
    [TSGOLINT_PROXY_ENV]: tsgolint,
  });
  // Already proxied by an outer run, a configured tsgolint Oxlint would refuse,
  // an unavailable native executable, and a native executable that is the
  // tsgolint itself all leave Oxlint's environment alone.
  const proxied = { OXLINT_TSGOLINT_PATH: binary, [TSGOLINT_PROXY_ENV]: tsgolint };
  assert.equal(withTsgolintProxy(proxied, importedRoot, native), proxied);
  const missing = { PATH: "", OXLINT_TSGOLINT_PATH: join(importedRoot, "no-such-tsgolint") };
  assert.equal(withTsgolintProxy(missing, importedRoot, native), missing);
  const unavailable = {
    resolveNative: () => {
      throw new Error("no native package");
    },
  };
  assert.equal(withTsgolintProxy(environment, importedRoot, unavailable), environment);
  assert.equal(
    withTsgolintProxy(environment, importedRoot, { resolveNative: () => tsgolint }),
    environment,
  );
  // For the language server, with no configured tsgolint, the proxy looks one
  // up per payload, so it stands in even where `cwd` has none to fall back to.
  const unconfigured = { PATH: "" };
  assert.deepEqual(
    withTsgolintProxy(unconfigured, tmpdir(), { ...native, perRoot: true }),
    {
      PATH: "",
      OXLINT_TSGOLINT_PATH: binary,
      [TSGOLINT_PROXY_ENV]: "",
      OXC_TSRX_TSGOLINT_PROXY_SEARCH: "1",
    },
  );
  assert.equal(withTsgolintProxy(unconfigured, tmpdir(), native), unconfigured);
  // A configured tsgolint is every root's tsgolint, for Oxlint and the proxy alike.
  assert.equal(
    withTsgolintProxy(environment, importedRoot, { ...native, perRoot: true })
      .OXC_TSRX_TSGOLINT_PROXY_SEARCH,
    undefined,
  );
  // An outer proxied run, even one with nothing to fall back to, is not proxied again.
  const searching = { [TSGOLINT_PROXY_ENV]: "", OXLINT_TSGOLINT_PATH: binary };
  assert.equal(withTsgolintProxy(searching, importedRoot, native), searching);

  // Canonical Oxlint run inside this process sees the proxy only while it runs.
  const { withProcessTsgolintProxy } = await import(
    "../../packages/toolchain/dist/tsgolint-proxy.js"
  );
  const before = process.env.OXLINT_TSGOLINT_PATH;
  process.env.OXLINT_TSGOLINT_PATH = tsgolint;
  try {
    const seen = await withProcessTsgolintProxy(
      importedRoot,
      async () => [process.env.OXLINT_TSGOLINT_PATH, process.env[TSGOLINT_PROXY_ENV]],
      native,
    );
    assert.deepEqual(seen, [binary, tsgolint]);
    assert.equal(process.env.OXLINT_TSGOLINT_PATH, tsgolint);
    assert.equal(process.env[TSGOLINT_PROXY_ENV], undefined);
    await assert.rejects(
      withProcessTsgolintProxy(importedRoot, async () => {
        throw new Error("lint failed");
      }, native),
      /lint failed/u,
    );
    assert.equal(process.env.OXLINT_TSGOLINT_PATH, tsgolint);
    assert.equal(process.env[TSGOLINT_PROXY_ENV], undefined);
  } finally {
    if (before === undefined) delete process.env.OXLINT_TSGOLINT_PATH;
    else process.env.OXLINT_TSGOLINT_PATH = before;
  }

  // Without the variable, Oxlint's own search: `node_modules/.bin` upwards, then PATH.
  const project = await mkdtemp(join(tmpdir(), "oxc-tsrx-tsgolint-search-"));
  const nested = join(project, "packages/app");
  const bin = join(project, "node_modules/.bin");
  await mkdir(nested, { recursive: true });
  await mkdir(bin, { recursive: true });
  const name = process.platform === "win32" ? "tsgolint.exe" : "tsgolint";
  assert.equal(canonicalTsgolintExecutable(nested, { PATH: "" }), null);
  await writeFile(join(project, name), "");
  assert.equal(canonicalTsgolintExecutable(nested, { PATH: project }), join(project, name));
  await writeFile(join(bin, name), "");
  assert.equal(canonicalTsgolintExecutable(nested, { PATH: project }), join(bin, name));
  assert.equal(
    canonicalTsgolintExecutable(nested, { OXLINT_TSGOLINT_PATH: bin, PATH: "" }),
    process.platform === "win32" ? null : join(bin, name),
  );
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
      VP_VERSION: "0.2.4",
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
      VP_VERSION: "0.2.4",
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

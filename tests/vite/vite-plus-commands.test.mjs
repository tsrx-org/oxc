import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { installPhysicalToolPackages } from "./physical-consumer.mjs";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(root, "tests/fixtures/vite/toolchain");
const lintBin = process.env.OXC_TSRX_LINT_BIN ?? join(root, "target/release/oxc-tsrx");
const formatBin = process.env.OXC_TSRX_FORMAT_BIN ?? join(root, "target/release/oxc-tsrx");
const versions = [
  { label: "current", packageName: "vite-plus-current", version: "0.3.3" },
];

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (status, signal) => resolveRun({ status, signal, stdout, stderr }));
  });
}

async function makeConsumer(fixtureName, vitePlusPackage) {
  const project = await mkdtemp(join(tmpdir(), `oxc-tsrx-${fixtureName}-`));
  await cp(join(fixtureRoot, fixtureName), project, { recursive: true });
  const modules = join(project, "node_modules");
  await mkdir(modules, { recursive: true });
  await installPhysicalToolPackages(modules, vitePlusPackage);
  return realpath(project);
}

async function runVp(project, args) {
  const vitePlusRoot = join(project, "node_modules/vite-plus");
  const vitePlusBin = join(vitePlusRoot, "dist/bin.js");
  return run(process.execPath, [vitePlusBin, ...args], {
    cwd: project,
    env: {
      ...process.env,
      NO_COLOR: "1",
      NODE_PATH: [join(project, "node_modules"), join(root, "node_modules")]
        .filter(Boolean)
        .join(delimiter),
      OXC_TSRX_LINT_BIN: lintBin,
      OXC_TSRX_FORMAT_BIN: formatBin,
    },
  });
}

for (const version of versions) {
  test(`${version.label} Vite+ ${version.version} resolves drop-in lint and format companions`, async () => {
    const project = await makeConsumer("diagnostics", version.packageName);
    try {
      const lint = await runVp(project, ["lint", "src"]);
      assert.equal(lint.status, 1, lint.stderr || lint.stdout);
      assert.match(lint.stdout + lint.stderr, /ordinary\.tsx/);
      assert.match(lint.stdout + lint.stderr, /view\.tsrx/);
      assert.match(lint.stdout + lint.stderr, /no-debugger/);

      const format = await runVp(project, ["fmt", "--check", "src"]);
      assert.equal(format.status, 1, format.stderr || format.stdout);
      assert.match(format.stdout + format.stderr, /ordinary\.tsx/);
      assert.match(format.stdout + format.stderr, /view\.tsrx/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test(`${version.label} Vite+ ${version.version} check --fix converges ordinary TSX and TSRX`, async () => {
    const project = await makeConsumer("fixable", version.packageName);
    try {
      const fixed = await runVp(project, ["check", "--fix", "src"]);
      assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
      const [ordinary, tsrx] = await Promise.all([
        readFile(join(project, "src/ordinary.tsx"), "utf8"),
        readFile(join(project, "src/view.tsrx"), "utf8"),
      ]);
      assert.doesNotMatch(ordinary, /\bvar\b/);
      assert.doesNotMatch(tsrx, /\bvar\b/);
      assert.match(tsrx, /function View\(\) @\{/);

      const checked = await runVp(project, ["check", "src"]);
      assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test(`${version.label} Vite+ ${version.version} preserves the authored config base for both lanes`, async () => {
    const project = await makeConsumer("relative-config", version.packageName);
    try {
      const lint = await runVp(project, ["lint", "src"]);
      const lintOutput = lint.stdout + lint.stderr;
      assert.equal(lint.status, 1, lintOutput);
      assert.match(lintOutput, /active\.tsrx/);
      assert.match(lintOutput, /ordinary\.tsx/);
      assert.doesNotMatch(lintOutput, /ignored\.tsrx/);
      assert.equal(lintOutput.match(/no-console/g)?.length, 2, lintOutput);
      assert.equal(lintOutput.match(/no-debugger/g)?.length, 1, lintOutput);

      const ignoredBefore = await readFile(join(project, "src/ignored.tsrx"), "utf8");
      const format = await runVp(project, ["fmt", "--write", "src"]);
      assert.equal(format.status, 0, format.stderr || format.stdout);
      const [active, ordinary, ignoredAfter] = await Promise.all([
        readFile(join(project, "src/active.tsrx"), "utf8"),
        readFile(join(project, "src/ordinary.tsx"), "utf8"),
        readFile(join(project, "src/ignored.tsrx"), "utf8"),
      ]);
      assert.match(active, /const label = 'active'\n/);
      assert.doesNotMatch(active, /const label = 'active';/);
      assert.match(ordinary, /const label = "ordinary";/);
      assert.equal(ignoredAfter, ignoredBefore);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
}

// Vite+ 0.2.4 and 0.3.x hand the linter `-c vite.config.mjs`, but Vite+ 1.x
// passes no `-c` at all and leaves the Vite config for the linter to find.
// Canonical Oxlint only discovers `vite.config.ts` by itself, so the bridge has
// to hand the config it discovered to the ordinary-file half as well, or the
// authored `extends`, `overrides`, and `ignorePatterns` silently stop applying
// to every file that is not `.tsrx`. These drive the bridge the way each host
// does, so no Vite+ 1.x install is needed to hold the line.
async function runBridgeLint(project, args) {
  const bridge = join(project, "node_modules/@tsrx/oxc/bin/oxlint");
  return run(process.execPath, [bridge, ...args], {
    cwd: project,
    env: {
      ...process.env,
      NO_COLOR: "1",
      VP_VERSION: "1.2.0",
      VP_COMMAND: "lint",
      OXC_TSRX_LINT_BIN: lintBin,
      OXC_TSRX_FORMAT_BIN: formatBin,
    },
  });
}

for (const [label, args] of [
  ["without -c, as Vite+ 1.x invokes it", ["src"]],
  ["with -c vite.config.mjs, as Vite+ 0.x invokes it", ["-c", "vite.config.mjs", "src"]],
]) {
  test(`the lint bridge applies the authored vite.config.mjs to ordinary files ${label}`, async () => {
    const project = await makeConsumer("relative-config", versions[0].packageName);
    try {
      const lint = await runBridgeLint(project, args);
      const lintOutput = lint.stdout + lint.stderr;
      assert.equal(lint.status, 1, lintOutput);
      assert.match(lintOutput, /active\.tsrx/);
      assert.match(lintOutput, /ordinary\.tsx/);
      assert.doesNotMatch(lintOutput, /ignored\.tsrx/);
      assert.equal(lintOutput.match(/no-console/g)?.length, 2, lintOutput);
      assert.equal(lintOutput.match(/no-debugger/g)?.length, 1, lintOutput);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
}

// An ordinary-only file list never reaches the TSRX bridge: canonical Oxlint
// runs it in-process. The authored config has to reach that route too, or
// `vp lint src/ordinary.tsx` (what lint-staged runs) loses it under Vite+ 1.x.
for (const [label, args] of [
  ["without -c, as Vite+ 1.x invokes it", ["src/ordinary.tsx"]],
  ["with -c vite.config.mjs, as Vite+ 0.x invokes it", ["-c", "vite.config.mjs", "src/ordinary.tsx"]],
]) {
  test(`the canonical route applies the authored vite.config.mjs to an ordinary-only file list ${label}`, async () => {
    const project = await makeConsumer("relative-config", versions[0].packageName);
    try {
      const lint = await runBridgeLint(project, args);
      const lintOutput = lint.stdout + lint.stderr;
      assert.equal(lint.status, 1, lintOutput);
      assert.match(lintOutput, /ordinary\.tsx/);
      assert.equal(lintOutput.match(/no-console/g)?.length, 1, lintOutput);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
}

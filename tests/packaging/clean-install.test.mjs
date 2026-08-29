import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";
import { scriptNode } from "../helpers/script-node.mjs";
import { startLocalRegistry } from "./local-registry.mjs";

const root = resolve(import.meta.dirname, "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const reportPath = join(import.meta.dirname, "clean-install-report.json");

function hostTarget() {
  if (process.platform === "darwin") {
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  }
  if (process.platform === "win32") {
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
  }
  if (process.platform === "linux" && ["arm64", "x64"].includes(process.arch)) {
    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
    return `${architecture}-unknown-linux-${libc}`;
  }
  throw new Error(`unsupported clean-install host ${process.platform}-${process.arch}`);
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (status, signal) => resolveRun({ status, signal, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function mustRun(executable, args, options = {}) {
  const result = await run(executable, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function pack(packageRoot, artifacts, cache) {
  const result = await mustRun(
    npm,
    ["pack", "--json", "--pack-destination", artifacts, resolve(root, packageRoot)],
    { cwd: root, env: { ...process.env, npm_config_cache: cache } },
  );
  const packed = parseNpmPackResponse(result.stdout);
  return {
    ...packed,
    manifest: JSON.parse(
      await readFile(join(root, packageRoot, "package.json"), "utf8"),
    ),
    tarball: join(artifacts, packed.filename),
  };
}

function cleanEnvironment(consumer, registry) {
  const environment = {
    ...process.env,
    NO_COLOR: "1",
    npm_config_cache: join(consumer, ".npm-cache"),
    npm_config_registry: registry,
  };
  for (const key of Object.keys(environment)) {
    if (
      key === "NODE_PATH" ||
      key.startsWith("OXC_TSRX_") ||
      key.startsWith("OXLINT_TSGOLINT")
    ) {
      delete environment[key];
    }
  }
  return environment;
}

test("untouched tarballs run the complete supported workflow from an empty consumer", async (context) => {
  const startedAt = new Date().toISOString();
  const npmVersion = (await mustRun(npm, ["--version"], { cwd: root })).stdout.trim();
  const artifacts = await mkdtemp(join(tmpdir(), "oxc-tsrx-clean-artifacts-"));
  const cache = join(artifacts, ".npm-cache");
  const nativeResult = await mustRun(
    scriptNode(),
    [
      "scripts/package-native.ts",
      "--allow-missing-parser-addon",
      "--target",
      hostTarget(),
      "--bin-dir",
      "target/release",
      "--out-dir",
      artifacts,
    ],
    { cwd: root, env: { ...process.env, npm_config_cache: cache } },
  );
  const native = JSON.parse(nativeResult.stdout);
  const toolchainPackage = await pack("packages/toolchain", artifacts, cache);
  const registry = await startLocalRegistry([
    toolchainPackage,
    {
      manifest: { name: native.packageName, version: native.version },
      tarball: native.tarball,
      integrity: native.integrity,
      shasum: native.shasum,
    },
  ]);
  context.after(() => registry.close());

  const consumer = await mkdtemp(join(tmpdir(), "oxc-tsrx-clean-consumer-"));
  const packageJson = {
    name: "oxc-tsrx-clean-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@tsrx/oxc": "0.8.0",
      "vite-plus": "0.2.4",
    },
  };
  await writeFile(join(consumer, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const environment = cleanEnvironment(consumer, registry.url);
  await mustRun(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer, env: environment },
  );
  const installedTree = await mustRun(npm, ["ls", "--all", "--json"], {
    cwd: consumer,
    env: environment,
  });
  const audit = await run(
    npm,
    ["audit", "--omit=dev", "--audit-level=high", "--json"],
    { cwd: consumer, env: environment },
  );
  const auditReport = JSON.parse(audit.stdout);
  assert.equal(audit.status, 0, audit.stderr || audit.stdout);
  assert.equal(auditReport.metadata.vulnerabilities.high, 0);
  assert.equal(auditReport.metadata.vulnerabilities.critical, 0);

  assert.deepEqual(Object.keys(packageJson.dependencies), ["@tsrx/oxc", "vite-plus"]);
  const toolchainRoot = join(consumer, "node_modules/@tsrx/oxc");
  const activate = await mustRun(
    process.execPath,
    [join(toolchainRoot, "bin/oxc-tsrx"), "setup", "--json"],
    { cwd: consumer, env: environment },
  );
  assert.deepEqual(JSON.parse(activate.stdout).changed, [
    "oxc-parser",
    "oxlint",
    "oxfmt",
  ]);
  const reactivate = await mustRun(
    process.execPath,
    [join(toolchainRoot, "bin/oxc-tsrx"), "setup", "--json"],
    { cwd: consumer, env: environment },
  );
  assert.deepEqual(JSON.parse(reactivate.stdout).changed, []);
  const toolchainRequire = createRequire(join(toolchainRoot, "package.json"));
  const consumerRoot = await realpath(consumer);
  // The native resolution logic is the installed package's own, and it is the
  // only first-party code under `@tsrx/oxc` now: there is no wrapper package
  // between the toolchain and its platform artifact.
  const runtime = await import(pathToFileURL(join(toolchainRoot, "dist/runtime.js")).href);
  const nativeRoot = resolve(
    toolchainRequire.resolve(`${runtime.platformPackage()}/package.json`),
    "..",
  );
  assert.equal((await realpath(toolchainRoot)).startsWith(consumerRoot), true);
  assert.equal((await realpath(nativeRoot)).startsWith(consumerRoot), true);
  const resolutions = {};
  for (const kind of ["lint", "format", "server"]) {
    const resolved = await realpath(runtime.resolveNativeBinary(kind));
    assert.equal(resolved.startsWith(consumerRoot), true);
    resolutions[kind] = resolved.slice(consumerRoot.length + 1);
  }

  await writeFile(
    join(consumer, ".oxlintrc.json"),
    `${JSON.stringify({ rules: { "no-var": "error" } }, null, 2)}\n`,
  );
  await writeFile(
    join(consumer, ".oxfmtrc.json"),
    `${JSON.stringify({ singleQuote: true, semi: true }, null, 2)}\n`,
  );
  await writeFile(
    join(consumer, "vite.config.mjs"),
    `export default {
  lint: { rules: { "no-var": "error" } },
  fmt: { singleQuote: true, semi: true },
};
`,
  );
  await writeFile(
    join(consumer, "View.tsrx"),
    `export function View( ) @{var count=0;<button>{count}</button>}`,
  );
  await writeFile(join(consumer, "ordinary.tsx"), `export var ordinary={value:1}\n`);
  await writeFile(
    join(consumer, "TypeView.tsrx"),
    `export function TypeView() @{\n  Promise.resolve(1);\n  <div />;\n}\n`,
  );

  const bin = (name) => join(consumer, "node_modules/.bin", name);
  const lint = await run(
    bin("oxlint"),
    ["--format=json", "View.tsrx", "ordinary.tsx"],
    { cwd: consumer, env: environment },
  );
  assert.equal(lint.status, 1, lint.stderr || lint.stdout);
  const lintOutput = JSON.parse(lint.stdout);
  assert.equal(lintOutput.oxcTsrx.parseCount, 1);
  assert.ok(lintOutput.diagnostics.some((diagnostic) => diagnostic.filename.endsWith("View.tsrx")));
  assert.ok(
    lintOutput.diagnostics.some((diagnostic) => diagnostic.filename.endsWith("ordinary.tsx")),
  );

  const formatCheck = await run(
    bin("oxfmt"),
    ["--check", "View.tsrx", "ordinary.tsx"],
    { cwd: consumer, env: environment },
  );
  assert.equal(formatCheck.status, 1, formatCheck.stderr || formatCheck.stdout);
  await mustRun(bin("oxfmt"), ["--write", "View.tsrx", "ordinary.tsx"], {
    cwd: consumer,
    env: environment,
  });
  await mustRun(bin("oxfmt"), ["--check", "View.tsrx", "ordinary.tsx"], {
    cwd: consumer,
    env: environment,
  });

  const formatter = await import(
    pathToFileURL(join(toolchainRoot, "dist/format.js")).href
  );
  const api = await formatter.format(
    "Api.tsrx",
    `export function Api( ) @{<div title="api"/>}`,
  );
  assert.deepEqual(api.errors, []);
  assert.match(api.code, /function Api\(\) @\{/);

  const typeConfig = join(consumer, "type-lint.json");
  await writeFile(
    typeConfig,
    `${JSON.stringify({
      plugins: ["typescript"],
      rules: { "typescript/no-floating-promises": "error" },
    })}\n`,
  );
  const typeAware = await run(
    bin("oxlint"),
    ["--format=json", "--type-aware", "--config", typeConfig, "TypeView.tsrx"],
    { cwd: consumer, env: environment },
  );
  assert.equal(typeAware.status, 1, typeAware.stderr || typeAware.stdout);
  assert.ok(
    JSON.parse(typeAware.stdout).diagnostics.some(
      (diagnostic) => diagnostic.rule === "no-floating-promises",
    ),
  );

  await writeFile(
    join(consumer, "View.tsrx"),
    `export function View( ) @{var count=0;<button>{count}</button>}`,
  );
  await writeFile(join(consumer, "ordinary.tsx"), `export var ordinary={value:1}\n`);
  const vp = bin("vp");
  const vpLint = await run(vp, ["lint", "View.tsrx", "ordinary.tsx"], {
    cwd: consumer,
    env: environment,
  });
  assert.equal(vpLint.status, 1, vpLint.stderr || vpLint.stdout);
  assert.match(vpLint.stdout + vpLint.stderr, /View\.tsrx/);
  assert.match(vpLint.stdout + vpLint.stderr, /ordinary\.tsx/);
  await mustRun(vp, ["check", "--fix", "View.tsrx", "ordinary.tsx"], {
    cwd: consumer,
    env: environment,
  });
  await mustRun(vp, ["check", "View.tsrx", "ordinary.tsx"], {
    cwd: consumer,
    env: environment,
  });
  assert.doesNotMatch(await readFile(join(consumer, "View.tsrx"), "utf8"), /\bvar\b/);
  assert.doesNotMatch(await readFile(join(consumer, "ordinary.tsx"), "utf8"), /\bvar\b/);

  const failClosedTsrx = `export function View( ) @{var count=0;<button>{count}</button>}`;
  const failClosedTsx = `export var ordinary={value:1}\n`;
  await rm(nativeRoot, { recursive: true, force: true });
  for (const [command, args] of [
    [bin("oxfmt"), ["--write", "View.tsrx", "ordinary.tsx"]],
    [bin("oxlint"), ["--fix", "View.tsrx", "ordinary.tsx"]],
  ]) {
    await writeFile(join(consumer, "View.tsrx"), failClosedTsrx);
    await writeFile(join(consumer, "ordinary.tsx"), failClosedTsx);
    const missingNative = await run(command, args, { cwd: consumer, env: environment });
    assert.notEqual(missingNative.status, 0, "missing native artifact must fail");
    assert.match(
      missingNative.stdout + missingNative.stderr,
      /native package .* unavailable|native artifact is missing/,
    );
    assert.equal(await readFile(join(consumer, "View.tsrx"), "utf8"), failClosedTsrx);
    assert.equal(await readFile(join(consumer, "ordinary.tsx"), "utf8"), failClosedTsx);
  }

  assert.equal(environment.NODE_PATH, undefined);
  assert.equal(
    Object.keys(environment).some((key) => key.startsWith("OXC_TSRX_")),
    false,
  );
  assert.equal(
    Object.keys(environment).some((key) => key.startsWith("OXLINT_TSGOLINT")),
    false,
  );
  assert.equal((environment.PATH ?? "").split(delimiter).includes(join(root, "target/release")), false);

  const installed = JSON.parse(installedTree.stdout);
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        completedAt: new Date().toISOString(),
        host: { platform: process.platform, arch: process.arch, rustTarget: hostTarget() },
        install: {
          packageManager: `npm ${npmVersion}`,
          ignoreScripts: true,
          environmentOverrides: false,
          oneDirectTsrxPackage: true,
          explicitCompatibilitySetup: true,
        },
        packages: {
          toolchain: {
            name: toolchainPackage.name,
            version: toolchainPackage.version,
            integrity: toolchainPackage.integrity,
          },
          native: {
            name: native.packageName,
            version: native.version,
            target: native.target,
            integrity: native.integrity,
          },
          vitePlus: installed.dependencies["vite-plus"].version,
        },
        resolutions,
        audit: auditReport.metadata.vulnerabilities,
        assertions: {
          mixedLintAuthoredDiagnostics: true,
          mixedFormatCheckWriteCheck: true,
          formatterApi: true,
          typeAwareTsgolint: true,
          vitePlusLint: true,
          vitePlusCheckFix: true,
          missingNativeMixedWritesFailClosed: true,
          noSourceTreeBinaryOverride: true,
          noInstallScripts: true,
          oneDirectTsrxPackage: true,
          compatibilitySetupIdempotent: true,
        },
      },
      null,
      2,
    )}\n`,
  );
});

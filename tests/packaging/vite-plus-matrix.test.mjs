/**
 * Clean-install compatibility matrix for published Vite+ releases: it installs
 * real Vite+ versions from a local registry, runs the compatibility activation
 * step, and drives `vp lint`, `vp fmt`, `vp check`, `vp build`, and `vp dev`
 * end to end.
 *
 * This file covers the *compatibility* route, where TSRX owns the `oxlint` and
 * `oxfmt` package names. The provider-discovery route, where Vite+ is asked to
 * reach a wrapper it did not install, is a separate lane in
 * tests/packaging/vite-plus-provider.test.mjs. That lane also records the
 * `"oxlint": "=1.72.0"` exact pin that bounds what Vite+ 0.2.4 can resolve.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";
import { scriptNode } from "../helpers/script-node.mjs";
import { startLocalRegistry } from "./local-registry.mjs";

const root = resolve(import.meta.dirname, "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const supportedLanes = [
  { name: "minimum", vitePlusVersion: "0.1.24" },
  { name: "current", vitePlusVersion: "0.2.4" },
];
const legacyLane = { name: "legacy", vitePlusVersion: "0.1.20" };
const legacyMode = process.env.OXC_TSRX_VITE_PLUS_LEGACY;
const lanes =
  legacyMode === "only"
    ? [legacyLane]
    : [...(legacyMode === "1" ? [legacyLane] : []), ...supportedLanes];

function hostTarget() {
  if (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)) {
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  }
  if (process.platform === "win32" && ["arm64", "x64"].includes(process.arch)) {
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
  }
  if (process.platform === "linux" && ["arm64", "x64"].includes(process.arch)) {
    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
    return `${architecture}-unknown-linux-${libc}`;
  }
  throw new Error(`unsupported Vite+ matrix host ${process.platform}-${process.arch}`);
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(file)));
    else files.push(file);
  }
  return files;
}

async function removeTreeEventually(directory) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!new Set(["EBUSY", "ENOTEMPTY", "EPERM"]).has(error?.code)) throw error;
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw lastError;
}

async function eventually(factory, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await factory();
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message ?? "unknown error"}`);
}

async function proveViteDev(vp, consumer, environment) {
  const port = await freePort();
  const child = spawn(
    vp,
    ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort", "--logLevel", "silent"],
    {
      cwd: consumer,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolveExit) =>
    child.once("exit", (status, signal) => resolveExit({ status, signal })),
  );
  const origin = `http://127.0.0.1:${port}`;
  const appPath = join(consumer, "src/App.tsrx");
  try {
    await eventually(async () => {
      const response = await fetch(origin);
      assert.equal(response.ok, true);
    }, "vp dev server");
    const appRequest = await eventually(async () => {
      const response = await fetch(`${origin}/src/main.jsx`);
      assert.equal(response.ok, true);
      const source = await response.text();
      const match = /["']([^"']*App\.tsrx[^"']*)["']/u.exec(source);
      assert.ok(match, source);
      return new URL(match[1], origin).href;
    }, "Vite-transformed entry import");
    const initial = await eventually(async () => {
      const response = await fetch(`${appRequest}${appRequest.includes("?") ? "&" : "?"}t=${Date.now()}`);
      assert.equal(response.ok, true);
      const source = await response.text();
      assert.match(source, /VITE PLUS BUILD/);
      assert.doesNotMatch(source, /@if|@\{/u);
      return source;
    }, "initial TSRX transform");
    const authored = await readFile(appPath, "utf8");
    await writeFile(appPath, authored.replace("VITE PLUS BUILD", "VITE PLUS DEV"));
    const updated = await eventually(async () => {
      const response = await fetch(`${appRequest}${appRequest.includes("?") ? "&" : "?"}t=${Date.now()}`);
      assert.equal(response.ok, true);
      const source = await response.text();
      assert.match(source, /VITE PLUS DEV/);
      assert.doesNotMatch(source, /@if|@\{/u);
      return source;
    }, "updated TSRX transform");
    assert.notEqual(updated, initial);
  } finally {
    if (process.platform === "win32") {
      await run("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        cwd: consumer,
        env: environment,
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    const result = await Promise.race([
      exited,
      new Promise((resolveExit) => setTimeout(() => resolveExit(null), 5_000)),
    ]);
    if (!result) {
      if (process.platform === "win32") child.kill("SIGKILL");
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      await exited;
    }
  }
}

async function mustRun(executable, args, options = {}) {
  const result = await run(executable, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function cleanEnvironment(cache) {
  const environment = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    npm_config_cache: cache,
  };
  for (const key of Object.keys(environment)) {
    if (
      key === "NODE_PATH" ||
      key.startsWith("OXC_TSRX_") ||
      key.startsWith("OXLINT_TSGOLINT") ||
      key.startsWith("VP_")
    ) {
      delete environment[key];
    }
  }
  return environment;
}

async function pack(packageRoot, artifacts, environment) {
  const result = await mustRun(
    npm,
    ["pack", "--json", "--pack-destination", artifacts, resolve(root, packageRoot)],
    { cwd: root, env: environment },
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

async function readResolvedManifest(consumer, parent, packageName) {
  const require = createRequire(join(consumer, "node_modules", parent, "package.json"));
  return JSON.parse(await readFile(require.resolve(`${packageName}/package.json`), "utf8"));
}

async function installArtifacts(artifacts, environment) {
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
    { cwd: root, env: environment },
  );
  const native = JSON.parse(nativeResult.stdout);
  return {
    native,
    toolchain: await pack("packages/toolchain", artifacts, environment),
  };
}

async function exerciseLane(lane, artifacts, environment) {
  const consumer = await mkdtemp(join(tmpdir(), `oxc-tsrx-vite-plus-${lane.name}-`));
  try {
    const packageJson = {
      name: `oxc-tsrx-vite-plus-${lane.name}`,
      private: true,
      type: "module",
      dependencies: {
        "@tsrx/vite-plugin-react": "0.0.72",
        "@tsrx/oxc": "0.9.0",
        react: "19.2.7",
        "react-dom": "19.2.7",
        "vite-plus": lane.vitePlusVersion,
      },
    };
    await writeFile(join(consumer, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    await mustRun(
      npm,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: consumer, env: environment },
    );
    await mustRun(npm, ["ls", "--all"], { cwd: consumer, env: environment });
    const toolchainRoot = join(consumer, "node_modules/@tsrx/oxc");
    const activation = await mustRun(
      process.execPath,
      [join(toolchainRoot, "bin/oxc-tsrx"), "setup", "--json"],
      { cwd: consumer, env: environment },
    );
    assert.deepEqual(JSON.parse(activation.stdout).changed, [
      "oxc-parser",
      "oxlint",
      "oxfmt",
    ]);
    let audit = null;
    if (lane.name !== "legacy") {
      const auditResult = await run(
        npm,
        ["audit", "--audit-level=high", "--json"],
        { cwd: consumer, env: environment },
      );
      audit = JSON.parse(auditResult.stdout).metadata.vulnerabilities;
      assert.equal(auditResult.status, 0, auditResult.stderr || auditResult.stdout);
      assert.equal(audit.high, 0);
      assert.equal(audit.critical, 0);
    }

    const consumerRoot = await realpath(consumer);
    const toolchainRequire = createRequire(join(toolchainRoot, "package.json"));
    const runtime = await import(
      pathToFileURL(join(toolchainRoot, "dist/runtime.js")).href
    );
    const nativeRoot = dirname(
      toolchainRequire.resolve(`${runtime.platformPackage()}/package.json`),
    );
    for (const packagePath of [
      "node_modules/vite-plus",
      "node_modules/@tsrx/oxc",
      "node_modules/oxlint",
      "node_modules/oxfmt",
    ]) {
      assert.equal(
        (await realpath(join(consumer, packagePath))).startsWith(consumerRoot),
        true,
        `${packagePath} escaped the clean consumer`,
      );
    }
    assert.equal((await realpath(nativeRoot)).startsWith(consumerRoot), true);
    assert.deepEqual(
      Object.keys(packageJson.dependencies).filter((name) =>
        name.includes("tsrx") || ["oxlint", "oxfmt", "oxc-parser"].includes(name),
      ),
      ["@tsrx/vite-plugin-react", "@tsrx/oxc"],
    );

    await writeFile(
      join(consumer, "vite.config.mjs"),
      `import { tsrxReact } from "@tsrx/vite-plugin-react";

export default {
  plugins: [tsrxReact()],
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
    await mkdir(join(consumer, "src"), { recursive: true });
    await writeFile(
      join(consumer, "index.html"),
      '<!doctype html><div id="root"></div><script type="module" src="/src/main.jsx"></script>\n',
    );
    await writeFile(
      join(consumer, "src/main.jsx"),
      'import { createRoot } from "react-dom/client"; import { App } from "./App.tsrx"; createRoot(document.querySelector("#root")).render(<App />);\n',
    );
    await writeFile(
      join(consumer, "src/App.tsrx"),
      'export function App() @{ const label = "VITE PLUS BUILD"; <main>@if (label) { <h1>{label}</h1> }</main> }\n',
    );

    const bin = (name) => join(consumer, "node_modules/.bin", name);
    const lint = await run(bin("vp"), ["lint", "View.tsrx", "ordinary.tsx"], {
      cwd: consumer,
      env: environment,
    });
    assert.equal(lint.status, 1, lint.stderr || lint.stdout);
    assert.match(lint.stdout + lint.stderr, /View\.tsrx/);
    assert.match(lint.stdout + lint.stderr, /ordinary\.tsx/);
    assert.match(lint.stdout + lint.stderr, /no-var/);

    const format = await run(bin("vp"), ["fmt", "--check", "View.tsrx", "ordinary.tsx"], {
      cwd: consumer,
      env: environment,
    });
    assert.equal(format.status, 1, format.stderr || format.stdout);
    assert.match(format.stdout + format.stderr, /View\.tsrx/);
    assert.match(format.stdout + format.stderr, /ordinary\.tsx/);

    await mustRun(bin("vp"), ["check", "--fix", "View.tsrx", "ordinary.tsx"], {
      cwd: consumer,
      env: environment,
    });
    await mustRun(bin("vp"), ["check", "View.tsrx", "ordinary.tsx"], {
      cwd: consumer,
      env: environment,
    });
    const [tsrx, tsx] = await Promise.all([
      readFile(join(consumer, "View.tsrx"), "utf8"),
      readFile(join(consumer, "ordinary.tsx"), "utf8"),
    ]);
    assert.doesNotMatch(tsrx, /\bvar\b/);
    assert.doesNotMatch(tsx, /\bvar\b/);
    assert.match(tsrx, /function View\(\) @\{/);

    await mustRun(bin("vp"), ["build", "--logLevel", "silent"], {
      cwd: consumer,
      env: environment,
    });
    const built = (
      await Promise.all(
        (await filesUnder(join(consumer, "dist")))
          .filter((file) => file.endsWith(".js"))
          .map((file) => readFile(file, "utf8")),
      )
    ).join("\n");
    assert.match(built, /VITE PLUS BUILD/);
    assert.doesNotMatch(built, /@if|@\{/u);
    await proveViteDev(bin("vp"), consumer, environment);

    const vitePlus = JSON.parse(
      await readFile(join(consumer, "node_modules/vite-plus/package.json"), "utf8"),
    );
    const lintCompanion = JSON.parse(
      await readFile(join(consumer, "node_modules/oxlint/package.json"), "utf8"),
    );
    const formatCompanion = JSON.parse(
      await readFile(join(consumer, "node_modules/oxfmt/package.json"), "utf8"),
    );
    // The lint and format implementations are the toolchain package itself now,
    // and it pins the official delegates by npm alias from its own root.
    const toolchainManifestPath = join(toolchainRoot, "package.json");
    const [officialLint, officialFormat] = await Promise.all([
      readResolvedManifest(
        consumer,
        relative(join(consumer, "node_modules"), dirname(toolchainManifestPath)),
        "oxlint-current",
      ),
      readResolvedManifest(
        consumer,
        relative(join(consumer, "node_modules"), dirname(toolchainManifestPath)),
        "oxfmt-current",
      ),
    ]);
    assert.equal(vitePlus.version, lane.vitePlusVersion);
    assert.equal(lintCompanion.name, "oxlint");
    assert.equal(formatCompanion.name, "oxfmt");
    assert.equal(lintCompanion.oxcTsrxCompatibility.provider, "oxc-tsrx");
    assert.equal(formatCompanion.oxcTsrxCompatibility.provider, "oxc-tsrx");

    return {
      lane: lane.name,
      vitePlus: {
        version: vitePlus.version,
        core: vitePlus.dependencies?.["@voidzero-dev/vite-plus-core"],
        bundledOxlint: vitePlus.dependencies?.oxlint,
        bundledOxfmt: vitePlus.dependencies?.oxfmt,
        bundledTsgolint: vitePlus.dependencies?.["oxlint-tsgolint"],
      },
      companions: {
        provider: "oxc-tsrx",
        providerVersion: artifacts.toolchain.manifest.version,
        delegatedOxlint: officialLint.version,
        delegatedOxfmt: officialFormat.version,
      },
      proof: {
        supported: lane.name !== "legacy",
        cleanInstall: true,
        mixedLint: true,
        mixedFormatCheck: true,
        convergentCheckFix: true,
        viteBuild: true,
        viteDev: true,
        viteDevRetransform: true,
        audit,
        environmentOverrides: false,
      },
    };
  } finally {
    await removeTreeEventually(consumer);
  }
}

test(
  legacyMode === "only"
    ? "legacy Vite+ passes its isolated clean-install compatibility control"
    : "published Vite+ minimum and current releases pass a clean mixed TSRX toolchain matrix",
  { timeout: 240_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-vite-plus-matrix-"));
    const artifactsDirectory = join(directory, "artifacts");
    const cache = join(directory, "npm-cache");
    await mkdir(artifactsDirectory, { recursive: true });
    const environment = cleanEnvironment(cache);
    let registry;
    try {
      const artifacts = await installArtifacts(artifactsDirectory, environment);
      registry = await startLocalRegistry([
        artifacts.toolchain,
        {
          manifest: {
            name: artifacts.native.packageName,
            version: artifacts.native.version,
          },
          tarball: artifacts.native.tarball,
          integrity: artifacts.native.integrity,
          shasum: artifacts.native.shasum,
        },
      ]);
      environment.npm_config_registry = registry.url;
      const results = [];
      for (const lane of lanes) {
        results.push(await exerciseLane(lane, artifacts, environment));
      }

      assert.equal(environment.NODE_PATH, undefined);
      assert.equal(
        Object.keys(environment).some(
          (key) => key.startsWith("OXC_TSRX_") || key.startsWith("OXLINT_TSGOLINT"),
        ),
        false,
      );
      assert.equal(
        (environment.PATH ?? "").split(delimiter).includes(join(root, "target/release")),
        false,
      );

      const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        host: {
          platform: process.platform,
          architecture: process.arch,
          node: process.version,
          nativeTarget: hostTarget(),
        },
        native: {
          packageName: artifacts.native.packageName,
          version: artifacts.native.version,
          target: artifacts.native.target,
          oxcRevision: (await readFile(join(root, "crates/oxc_adapter/src/lib.rs"), "utf8")).match(
            /pub const OXC_REVISION:\s*&str\s*=\s*"([0-9a-f]{40})"/,
          )?.[1],
          integrity: artifacts.native.integrity,
          shasum: artifacts.native.shasum,
        },
        policy: {
          legacy: "0.1.20 isolated opt-in control; not supported for new installs",
          minimum: "0.1.24",
          current: "0.2.4",
          next: "advisory only until published and separately qualified",
        },
        lanes: results,
      };
      if (process.env.OXC_TSRX_RETAIN_MATRIX_REPORT === "1") {
        await writeFile(
          join(root, "tests/packaging/vite-plus-matrix-report.json"),
          `${JSON.stringify(report, null, 2)}\n`,
        );
      }
    } finally {
      await registry?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

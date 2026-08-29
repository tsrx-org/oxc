/**
 * What the *real* installed Vite+ binary does when a project holds a language
 * provider.
 *
 * Vite+ needs no change of its own to reach a provider-aware Oxlint wrapper,
 * because it resolves the `oxlint` package, joins `bin/oxlint`, and executes
 * whatever it finds. Until now that was checked by re-implementing its rule
 * in a scratch script. This file checks it by running the real
 * `vite-plus-current` 0.2.4 binary that is already installed in this repository
 * and recording where it actually lands.
 *
 * Nothing here is a stand-in for Vite+. The one thing the fixture supplies is
 * the *target* of the resolution: a probe package published under the name
 * `oxlint` whose `bin/oxlint` records the path it was invoked as, its argv, and
 * the environment Vite+ injected, then writes a line and exits. That is exactly
 * the position a patched wrapper would occupy, and it keeps the test about
 * Vite+'s behaviour rather than about Oxlint's.
 *
 * The finding this file exists to make honest: installed Vite+ 0.2.4 pins
 * `"oxlint": "=1.72.0"` exactly. See the last test for what that costs.
 *
 * No network. Every package comes from the workspace install.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(join(root, "package.json"));

/** The installed Vite+ under test. Aliased in tests/package.json to vite-plus@0.2.4. */
const VITE_PLUS_PACKAGE = "vite-plus-current";
const VITE_PLUS_VERSION = "0.2.4";

/** The version Vite+ 0.2.4 pins exactly, and therefore the only one it ships with. */
const PINNED_OXLINT = "1.72.0";
/** The version the locally built dispatch patch was compiled at. */
const PATCHED_OXLINT = "1.74.0";

function platformSuffix() {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `win32-${process.arch}-msvc`;
  if (process.platform === "linux") {
    const report = process.report?.getReport?.();
    return `linux-${process.arch}-${report?.header?.glibcVersionRuntime ? "gnu" : "musl"}`;
  }
  throw new Error(`unsupported Vite+ provider host: ${process.platform}-${process.arch}`);
}

/** Locate a package root even when its `exports` hides `./package.json`. */
async function packageRoot(packageRequire, name) {
  try {
    return dirname(packageRequire.resolve(`${name}/package.json`));
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  let directory = dirname(packageRequire.resolve(name));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name === name) return directory;
    } catch {
      // Keep walking out of the package's internal entry directories.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`unable to locate the package root for ${name}`);
    directory = parent;
  }
}

async function copyEntries(source, destination, entries) {
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    try {
      await stat(join(source, entry));
    } catch {
      continue;
    }
    await cp(join(source, entry), join(destination, entry), { recursive: true });
  }
}

async function link(modules, name, target) {
  const destination = join(modules, ...name.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await symlink(target, destination, "dir");
}

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

/**
 * A package named `oxlint` whose bin records how it was reached.
 *
 * `label` says which copy this is, so a run can name the winner without
 * comparing absolute paths. `PROBE_EXIT` lets one fixture exercise both the
 * clean and the failing exit path.
 */
async function writeOxlintProbe(directory, { version, label }) {
  await mkdir(join(directory, "bin"), { recursive: true });
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "oxlint",
        version,
        type: "module",
        main: "./dist/cli.js",
        exports: { ".": "./dist/cli.js", "./package.json": "./package.json" },
        bin: { oxlint: "./bin/oxlint" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(directory, "dist/cli.js"), "export {};\n");
  const source = [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    `const label = ${JSON.stringify(label)};`,
    `const version = ${JSON.stringify(version)};`,
    "const record = {",
    "  label,",
    "  version,",
    "  entry: process.argv[1],",
    "  argv: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  vpVersion: process.env.VP_VERSION ?? null,",
    "  tsgolint: Boolean(process.env.OXLINT_TSGOLINT_PATH),",
    "};",
    'appendFileSync(process.env.OXC_TSRX_PROBE_LOG, JSON.stringify(record) + "\\n");',
    'process.stdout.write("oxlint probe " + label + " handled: " + record.argv.join(" ") + "\\n");',
    "process.exitCode = Number(process.env.OXC_TSRX_PROBE_EXIT ?? 0);",
    "",
  ].join("\n");
  await writeFile(join(directory, "bin/oxlint"), source);
  await chmod(join(directory, "bin/oxlint"), 0o755);
}

/** A minimal, vendor-neutral language provider. Nothing here mentions TSRX. */
async function writeProvider(modules) {
  const directory = join(modules, "acme-widget-lang");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "acme-widget-lang",
        version: "1.0.0",
        bin: { "acme-widget-lint": "./bin/acme-widget-lint" },
        oxc: {
          provider: {
            protocol: 1,
            id: "acme-widget-lang",
            languages: [{ id: "widget", extensions: [".wdgt"] }],
            capabilities: { lint: { bin: "acme-widget-lint" } },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, "bin/acme-widget-lint"),
    "#!/usr/bin/env node\nprocess.stdout.write(`acme-widget-lint: ${process.argv.slice(2).join(\" \")}\\n`);\n",
  );
  await chmod(join(directory, "bin/acme-widget-lint"), 0o755);
}

/**
 * Build a project that holds a provider, plus a physical Vite+ install.
 *
 * `projectOxlint` places a probe at the project root, which is where npm puts a
 * project's own `oxlint` dependency. `nestedOxlint` places one inside the Vite+
 * package, which is where npm puts Vite+'s pinned copy when the project already
 * claims the root name. Both layouts are things a real `npm install` produces.
 */
async function makeProject({ projectOxlint, nestedOxlint }) {
  // realpath, because macOS hands back /var/... while a spawned child reports
  // /private/var/..., and every assertion below compares absolute paths.
  const project = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-vp-provider-")));
  const modules = join(project, "node_modules");
  await mkdir(modules, { recursive: true });

  const source = await packageRoot(require, VITE_PLUS_PACKAGE);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const vitePlus = join(modules, "vite-plus");
  await copyEntries(source, vitePlus, ["package.json", "bin", "binding", "dist"]);

  const vitePlusRequire = createRequire(join(source, "package.json"));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    // The three tool packages are supplied by this fixture, not by the workspace.
    if (["oxlint", "oxfmt", "oxlint-tsgolint"].includes(dependency)) continue;
    await link(modules, dependency, await packageRoot(vitePlusRequire, dependency));
  }
  const suffix = platformSuffix();
  await link(
    modules,
    `@voidzero-dev/vite-plus-${suffix}`,
    await packageRoot(vitePlusRequire, `@voidzero-dev/vite-plus-${suffix}`),
  );
  await link(modules, "oxlint-tsgolint", await packageRoot(require, "oxlint-tsgolint"));

  // Vite+'s native core requires the bare specifier `vite-plus/binding`, and it
  // is reached here through a symlink whose real path is the workspace install,
  // so its own lookup never sees this fixture. A NODE_PATH directory holding
  // exactly one entry answers that and nothing else. It deliberately does not
  // contain `oxlint`, so the workspace's real Oxlint can never win a lookup.
  const shim = join(project, ".vite-plus-shim");
  await mkdir(shim, { recursive: true });
  await symlink(vitePlus, join(shim, "vite-plus"), "dir");

  if (projectOxlint) {
    await writeOxlintProbe(join(modules, "oxlint"), {
      version: PATCHED_OXLINT,
      label: "project-root",
    });
  }
  if (nestedOxlint) {
    await writeOxlintProbe(join(vitePlus, "node_modules/oxlint"), {
      version: PINNED_OXLINT,
      label: "vite-plus-pinned",
    });
  }
  await writeProvider(modules);

  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "vite-plus-provider-fixture",
        private: true,
        type: "module",
        dependencies: {
          "acme-widget-lang": "1.0.0",
          ...(projectOxlint ? { oxlint: PATCHED_OXLINT } : {}),
          "vite-plus": VITE_PLUS_VERSION,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(project, "vite.config.js"), "export default { lint: {} };\n");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src/main.ts"), "export const value = 1;\n");
  await writeFile(join(project, "src/Widget.wdgt"), "widget Demo {}\n");
  return { project, shim, probeLog: join(project, "probe.jsonl") };
}

async function readProbe(probeLog) {
  let raw;
  try {
    raw = await readFile(probeLog, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function runVp({ project, shim, probeLog }, args, extra = {}) {
  await rm(probeLog, { force: true });
  const result = await run(process.execPath, [join(project, "node_modules/vite-plus/dist/bin.js"), ...args], {
    cwd: project,
    env: {
      ...process.env,
      NO_COLOR: "1",
      CI: "1",
      NODE_PATH: shim,
      OXC_TSRX_PROBE_LOG: probeLog,
      ...extra,
    },
  });
  return { ...result, probe: await readProbe(probeLog) };
}

async function runVitePlusLspWrapper({ project, shim, probeLog }) {
  await rm(probeLog, { force: true });
  const result = await run(
    process.execPath,
    [join(project, "node_modules/vite-plus/bin/oxlint"), "--lsp"],
    {
      cwd: project,
      env: {
        ...process.env,
        NO_COLOR: "1",
        NODE_PATH: shim,
        OXC_TSRX_PROBE_LOG: probeLog,
      },
    },
  );
  return { ...result, probe: await readProbe(probeLog) };
}

test("installed Vite+ 0.2.4 pins oxlint to exactly =1.72.0, which bounds the zero-line claim", async () => {
  const manifest = JSON.parse(
    await readFile(join(await packageRoot(require, VITE_PLUS_PACKAGE), "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "vite-plus");
  assert.equal(manifest.version, VITE_PLUS_VERSION);

  // The exact pin is the whole caveat. `=1.72.0` accepts one version and no
  // other, so the Oxlint copy Vite+ 0.2.4 installs for itself can never be a
  // build carrying provider dispatch, which exists only at 1.74.0 and only as a
  // local build. "Zero lines" is a statement about Vite+'s code, not a claim
  // that a released Vite+ can pick up a patched wrapper today.
  assert.equal(manifest.dependencies.oxlint, `=${PINNED_OXLINT}`);
  assert.equal(manifest.dependencies.oxfmt, "=0.57.0");
  assert.notEqual(PINNED_OXLINT, PATCHED_OXLINT);
});

test(
  "the real vp binary runs the project's own oxlint wrapper when the project declares one",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await makeProject({ projectOxlint: true, nestedOxlint: true });
    try {
      await t.test("the fixture really holds a discoverable provider", async () => {
        const { discoverProviders } = await import(
          "../../packages/toolchain/dist/provider-resolve.js"
        );
        const index = await discoverProviders({ root: fixture.project });
        assert.deepEqual(Object.keys(index.extensions), [".wdgt"]);
        assert.equal(index.extensions[".wdgt"].package, "acme-widget-lang");
      });

      await t.test("vp lint reaches the project's copy, not Vite+'s pinned copy", async () => {
        const result = await runVp(fixture, ["lint", "src/main.ts", "src/Widget.wdgt"]);
        assert.equal(result.probe.length, 1, result.stderr || result.stdout);
        const [record] = result.probe;
        assert.equal(record.label, "project-root");
        assert.equal(record.version, PATCHED_OXLINT);
        assert.equal(record.entry, join(fixture.project, "node_modules/oxlint/bin/oxlint"));
        // Vite+ tells the wrapper which config to read and nothing else about
        // the files, so it cannot filter an extension it has never heard of.
        assert.ok(record.argv.includes("src/main.ts"));
        assert.ok(record.argv.includes("src/Widget.wdgt"));
        assert.equal(record.vpVersion, VITE_PLUS_VERSION);
        assert.equal(record.tsgolint, true);
        // Whatever the wrapper prints is what the user sees.
        assert.match(result.stdout, /oxlint probe project-root handled/);
        assert.equal(result.status, 0, result.stderr);
      });

      await t.test("vp lint propagates the wrapper's failing exit code", async () => {
        const result = await runVp(fixture, ["lint", "src/Widget.wdgt"], {
          OXC_TSRX_PROBE_EXIT: "1",
        });
        assert.equal(result.probe.length, 1, result.stderr || result.stdout);
        assert.equal(result.probe[0].label, "project-root");
        assert.equal(result.status, 1);
      });

      await t.test("a directory argument stays a directory argument", async () => {
        // This is the honest limit of a JavaScript-only dispatch patch. When the
        // user names a directory, the wrapper receives the directory and the
        // native file walker decides what to open, so a provider extension is
        // never enumerated. Recorded here so nobody has to rediscover it.
        const result = await runVp(fixture, ["lint", "src"]);
        assert.equal(result.probe.length, 1, result.stderr || result.stdout);
        assert.ok(result.probe[0].argv.includes("src"));
        assert.equal(result.probe[0].argv.includes("src/Widget.wdgt"), false);
      });

      await t.test(
        "Vite+'s LSP-only oxlint wrapper resolves package-relative, so it keeps the pinned copy",
        async () => {
          // node_modules/vite-plus/bin/oxlint uses createRequire(import.meta.url),
          // so it looks inside its own package first. The project's copy is
          // invisible to it. This seam and the `vp lint` seam disagree, and the
          // disagreement is what the editor path inherits.
          const result = await runVitePlusLspWrapper(fixture);
          assert.equal(result.probe.length, 1, result.stderr || result.stdout);
          assert.equal(result.probe[0].label, "vite-plus-pinned");
          assert.equal(result.probe[0].version, PINNED_OXLINT);
        },
      );
    } finally {
      await rm(fixture.project, { recursive: true, force: true });
    }
  },
);

test(
  "the real vp binary runs Vite+'s own pinned oxlint when the project declares none",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await makeProject({ projectOxlint: false, nestedOxlint: true });
    try {
      await t.test("vp lint lands on the =1.72.0 copy Vite+ installed for itself", async () => {
        const result = await runVp(fixture, ["lint", "src/main.ts", "src/Widget.wdgt"]);
        assert.equal(result.probe.length, 1, result.stderr || result.stdout);
        const [record] = result.probe;
        assert.equal(record.label, "vite-plus-pinned");
        assert.equal(record.version, PINNED_OXLINT);
        assert.equal(
          record.entry,
          join(fixture.project, "node_modules/vite-plus/node_modules/oxlint/bin/oxlint"),
        );
        // This is the ordinary case: a project installs Vite+ and nothing else.
        // Every Oxlint invocation goes to a version the exact pin freezes, so no
        // provider is ever discovered no matter what the project has installed.
        assert.equal(result.status, 0, result.stderr);
      });

      await t.test("the workspace's real Oxlint never wins the lookup", async () => {
        const result = await runVp(fixture, ["lint", "src/main.ts"]);
        assert.equal(result.probe.length, 1, result.stderr || result.stdout);
        assert.equal(result.probe[0].entry.startsWith(fixture.project), true);
        assert.equal(result.probe[0].entry.includes(root), false);
      });
    } finally {
      await rm(fixture.project, { recursive: true, force: true });
    }
  },
);

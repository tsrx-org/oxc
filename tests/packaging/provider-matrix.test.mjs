/**
 * The package-manager matrix for install-only provider discovery.
 *
 * Every lane answers the same question with the same evidence: a consumer whose
 * only dependency is `@tsrx/oxc`, installed from a local registry serving the
 * real `npm pack` tarball, runs **no command other than its package manager's
 * install** and still yields the same provider index; then a frozen reinstall
 * from the unchanged manifest and lockfile — after the whole install tree is
 * deleted — reproduces that index byte for byte.
 *
 * The lanes differ only in where the package manager physically puts the
 * provider: hoisted `node_modules` (npm, Bun, Yarn with the node-modules
 * linker), an isolated store linked in as a direct dependency (pnpm, and Deno
 * under `node_modules/.deno`), or no `node_modules` at all (Yarn Plug'n'Play,
 * where the provider lives inside a zip in `.yarn/cache` and only `.pnp.cjs`
 * can say where). Discovery never depends on
 * that layout because it resolves only direct dependencies, through an injected
 * `(request, issuer)` resolver.
 *
 * A lane whose package manager cannot be provisioned inside the fixture is
 * reported as blocked with its reason, printed in the lane matrix at the end of
 * the run. It is never a silent pass.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import {
  NATIVE_TARGETS,
  nativePackageName,
} from "../../packages/toolchain/dist/native-targets.js";
import { RESERVED_EXTENSIONS } from "../../packages/toolchain/dist/provider-resolve.js";
import {
  resolveCommandInvocation,
  spawnCommand,
} from "../../packages/toolchain/dist/spawn-command.js";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";
import { startLocalRegistry } from "./local-registry.mjs";
import { transpileCts } from "../helpers/require-cts.mjs";

const root = resolve(import.meta.dirname, "../..");
const toolchainRoot = join(root, "packages/toolchain");
const repositoryResolver = join(toolchainRoot, "dist/provider-resolve.js");
const providerClientArtifact = await transpileCts(
  join(root, "packages/vscode/src/provider-client.cts"),
);
test.after(() => providerClientArtifact.dispose());
const providerClient = providerClientArtifact.modulePath;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const bun = process.platform === "win32" ? "bun.exe" : "bun";
const deno = process.platform === "win32" ? "deno.exe" : "deno";
const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";

/**
 * Lanes are skipped when their package manager is not on the machine, which is
 * right for a laptop and wrong for CI: a runner that quietly lost Bun would
 * turn "covered" into "skipped" without failing anything. The workflow names
 * the lanes it provisions here, and a named lane that cannot run is an error.
 */
const REQUIRED_LANES = new Set(
  (process.env.OXC_TSRX_REQUIRE_PM_LANES ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** Pinned so a lane result names an exact Yarn build rather than "whatever was latest". */
const YARN_VERSION = "4.9.2";

/**
 * What an ordinary `fs` reports when it is asked to read a path that continues
 * *through* Yarn's zip archive. The errno differs by host and the lane must
 * pin both spellings rather than only the one this machine happens to produce.
 */
const UNREADABLE_ARCHIVE_CODES = ["unreadable:ENOTDIR", "unreadable:ENOENT"];
const UNREADABLE_ARCHIVE_MESSAGE = /ENOTDIR|ENOENT/u;

/** Ordinary sources every lane must leave on the official OXC path. */
const ORDINARY_DOCUMENTS = [
  "src/app.ts",
  "src/App.tsx",
  "src/legacy.js",
  "src/legacy.jsx",
  "src/module.mjs",
  "src/module.cjs",
  "tsconfig.json",
];

/** Sources the provider must claim. */
const PROVIDER_DOCUMENTS = ["src/View.tsrx", "src/nested/Panel.tsrx"];

const DOCUMENTS = [...ORDINARY_DOCUMENTS, ...PROVIDER_DOCUMENTS];

/**
 * The host, run out of process so that every lane is measured the same way and
 * so the Plug'n'Play lane can be given a real PnP runtime with `--require`.
 *
 * It is deliberately the shipped editor decision module (`provider-client.cts`)
 * driving the shipped resolver: `loadFolderResolver` picks up a folder's
 * `.pnp.cjs` when there is one and hands its `resolveRequest` straight to
 * discovery, which is the whole reason the protocol is package-manager neutral.
 */
const HOST_HARNESS = `"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const [folder, resolverPath, clientPath, outFile, documentsJson] = process.argv.slice(2);

function fingerprint(target) {
  if (typeof target !== "string" || target.startsWith("unresolvable:")) return null;
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  } catch (error) {
    return "unreadable:" + String(error.code || error.message);
  }
}

(async () => {
  const resolver = await import(pathToFileURL(resolverPath).href);
  const client = require(clientPath);
  const documents = JSON.parse(documentsJson);
  const manifest = path.join(folder, "package.json");
  const resolveRequest =
    client.loadFolderResolver(folder) ||
    ((request, issuer) => createRequire(issuer).resolve(request));
  const readFile = (target) => fs.promises.readFile(target, "utf8");

  let installedResolver;
  try {
    installedResolver = resolveRequest("@tsrx/oxc/provider-resolve", manifest);
  } catch (error) {
    installedResolver = "unresolvable:" + String(error.code || error.message);
  }

  const state = await client.discoverWorkspaceFolder(folder, {
    discover: resolver.discoverProviders,
    resolve: resolveRequest,
    readFile,
  });

  const capabilities = {};
  for (const extension of Object.keys(state.index.extensions).sort()) {
    const entry = state.index.extensions[extension];
    for (const capability of Object.keys(entry.capabilities).sort()) {
      const target = entry.capabilities[capability];
      capabilities[extension + " " + capability] = {
        kind: target.kind,
        path: target.path === undefined ? null : target.path,
        specifier: target.specifier === undefined ? null : target.specifier,
        present: target.path ? fs.existsSync(target.path) : null,
      };
    }
  }

  const routed = documents.map((document) => {
    const absolute = path.join(folder, document);
    const owner = client.clientForDocument(state, absolute);
    const lint = resolver.resolveCapability(state.index, absolute, "lint");
    return {
      document,
      client: owner === null ? null : owner.id,
      lint: lint === null ? null : lint.path,
    };
  });

  const starts = client
    .plannedClientStarts(
      [state],
      documents.map((document) => ({ folder, path: path.join(folder, document) })),
    )
    .map((start) => start.client.id);

  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        plugAndPlay: Boolean(process.versions.pnp),
        nodeModules: fs.existsSync(path.join(folder, "node_modules")),
        installedResolver,
        installedResolverFingerprint: fingerprint(installedResolver),
        root: state.index.root,
        providers: state.index.providers,
        extensions: state.index.extensions,
        diagnostics: state.index.diagnostics,
        selector: state.selector,
        clients: state.clients,
        failure: state.failure === null ? null : String(state.failure.message),
        capabilities,
        routed,
        starts,
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  fs.writeFileSync(
    outFile,
    JSON.stringify({ harnessError: String((error && error.stack) || error) }, null, 2),
  );
  process.exitCode = 1;
});
`;

/**
 * The command name to record, independent of how this host spells the launcher.
 * On Windows the package manager on PATH is `npm.cmd`, and a lane must not be
 * able to pass the "nothing but an install ran here" assertion by being spelled
 * differently, nor fail it for the same reason.
 */
function commandName(executable) {
  const name = basename(executable);
  return name.slice(0, name.length - extname(name).length) || name;
}

/**
 * `path.relative` compares case-insensitively on Windows and speaks the host's
 * own separator, so containment holds for `C:\...\node_modules` without any
 * platform branch and without a `startsWith("/")` that only POSIX satisfies.
 */
function isInside(directory, path) {
  const offset = relative(directory, path);
  return offset.length > 0 && !offset.startsWith("..") && !isAbsolute(offset);
}

/** Every process this fixture starts, so a lane cannot smuggle in a setup step. */
const spawned = [];

function run(executable, args, options = {}) {
  spawned.push({ executable: commandName(executable), args, cwd: options.cwd });
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnCommand(executable, args, {
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

async function mustRun(executable, args, options = {}) {
  const result = await run(executable, args, options);
  assert.equal(
    result.status,
    0,
    `${commandName(executable)} ${args.join(" ")}\n${result.stderr}${result.stdout}`,
  );
  return result;
}

function available(executable) {
  const invocation = resolveCommandInvocation(executable, ["--version"]);
  return (
    spawnSync(invocation.file, invocation.args, {
      stdio: "ignore",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }).status === 0
  );
}

async function writePackage(directory, manifest, files = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  return directory;
}

async function pack(packageRoot, artifacts, cache) {
  const result = await mustRun(npm, ["pack", "--json", "--pack-destination", artifacts, packageRoot], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cache },
  });
  const packed = parseNpmPackResponse(result.stdout);
  return {
    manifest: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
    tarball: join(artifacts, packed.filename),
    integrity: packed.integrity,
    shasum: packed.shasum,
  };
}

function cleanEnvironment(temporary, registry) {
  const environment = {
    ...process.env,
    NO_COLOR: "1",
    npm_config_cache: join(temporary, "npm-cache"),
    npm_config_registry: registry,
    XDG_CACHE_HOME: join(temporary, "xdg-cache"),
    XDG_DATA_HOME: join(temporary, "xdg-data"),
    XDG_STATE_HOME: join(temporary, "xdg-state"),
    PNPM_HOME: join(temporary, "pnpm-home"),
    BUN_INSTALL_CACHE_DIR: join(temporary, "bun-cache"),
    // Deno takes the registry from the environment rather than a flag, and
    // DENO_DIR keeps its npm cache inside the fixture like every other lane.
    NPM_CONFIG_REGISTRY: registry,
    DENO_DIR: join(temporary, "deno-dir"),
    DENO_NO_UPDATE_CHECK: "1",
    // Corepack materialises the pinned Yarn here. Nothing global or user-level
    // is written, and `corepack enable` (which installs shims onto PATH) is
    // never run.
    COREPACK_HOME: join(temporary, "corepack-home"),
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_NPM_REGISTRY: registry.replace(/\/$/u, ""),
    // Yarn is configured entirely through the environment so the consumer keeps
    // exactly the files it declared: no `.yarnrc.yml`, no `yarn config set`.
    YARN_NPM_REGISTRY_SERVER: registry,
    YARN_UNSAFE_HTTP_WHITELIST: "127.0.0.1",
    YARN_ENABLE_GLOBAL_CACHE: "0",
    YARN_ENABLE_TELEMETRY: "0",
    YARN_ENABLE_SCRIPTS: "0",
    YARN_ENABLE_IMMUTABLE_INSTALLS: "0",
  };
  delete environment.NODE_PATH;
  // Yarn defaults `enableImmutableInstalls` to "am I on CI", which would make
  // the first install of a lockfile-less consumer fail for the wrong reason.
  delete environment.CI;
  for (const key of Object.keys(environment)) {
    if (key.startsWith("OXC_TSRX_") || key.startsWith("OXLINT_TSGOLINT")) {
      delete environment[key];
    }
  }
  return environment;
}

const lanes = [
  {
    id: "npm",
    label: "npm install / npm ci",
    executable: npm,
    required: true,
    install: (registry) => [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${registry}`,
    ],
    frozen: (registry) => [
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${registry}`,
    ],
    tracked: ["package-lock.json", "package.json"],
    installTree: ["node_modules"],
  },
  {
    id: "pnpm",
    label: "pnpm install / pnpm install --frozen-lockfile",
    executable: pnpm,
    install: (registry) => ["install", "--ignore-scripts", `--registry=${registry}`],
    frozen: (registry) => [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      `--registry=${registry}`,
    ],
    tracked: ["package.json", "pnpm-lock.yaml"],
    installTree: ["node_modules"],
  },
  {
    id: "bun",
    label: "bun install / bun install --frozen-lockfile",
    executable: bun,
    install: (registry) => ["install", "--ignore-scripts", `--registry=${registry}`],
    frozen: (registry) => [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      `--registry=${registry}`,
    ],
    tracked: ["bun.lock", "package.json"],
    installTree: ["node_modules"],
  },
  {
    id: "deno",
    label: "deno install / deno install --frozen",
    executable: deno,
    // Deno's npm compatibility writes a pnpm-shaped store: every package lives
    // in `node_modules/.deno/<name>@<version>/node_modules/<name>`, and only
    // the direct dependency is linked at the top level.
    install: () => ["install", "--node-modules-dir=auto"],
    frozen: () => ["install", "--node-modules-dir=auto", "--frozen"],
    tracked: ["deno.lock", "package.json"],
    installTree: ["node_modules"],
  },
  {
    id: "yarn_node_modules",
    label: `yarn ${YARN_VERSION} (node-modules linker): install / install --immutable`,
    executable: corepack,
    yarn: true,
    manifest: { packageManager: `yarn@${YARN_VERSION}` },
    environment: { YARN_NODE_LINKER: "node-modules" },
    install: () => ["yarn", "install"],
    frozen: () => ["yarn", "install", "--immutable"],
    tracked: ["package.json", "yarn.lock"],
    installTree: ["node_modules", ".yarn"],
  },
  {
    id: "yarn_pnp",
    label: `yarn ${YARN_VERSION} (Plug'n'Play linker): install / install --immutable`,
    executable: corepack,
    yarn: true,
    plugAndPlay: true,
    manifest: { packageManager: `yarn@${YARN_VERSION}` },
    environment: { YARN_NODE_LINKER: "pnp" },
    install: () => ["yarn", "install"],
    frozen: () => ["yarn", "install", "--immutable"],
    tracked: ["package.json", "yarn.lock"],
    // Under Plug'n'Play the entire install lives in `.yarn` plus the two
    // generated PnP manifests; there is no `node_modules` to delete.
    installTree: [".yarn", ".pnp.cjs", ".pnp.loader.mjs"],
  },
];

const laneStatus = new Map(
  lanes.map((lane) => [lane.id, { install: "not run", frozen: "not run", notes: "" }]),
);

function record(lane, patch) {
  Object.assign(laneStatus.get(lane.id), patch);
}

/** Files the consumer owns, excluding whatever the package manager installed. */
async function trackedFiles(app, lane) {
  const entries = await readdir(app, { withFileTypes: true, recursive: true });
  const files = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    const offset = relative(app, path).split(sep).join("/");
    if (lane.installTree.some((tree) => offset === tree || offset.startsWith(`${tree}/`))) {
      continue;
    }
    files[offset] = await readFile(path, "utf8");
  }
  return files;
}

/**
 * Replace every absolute path in a report with a stable token, so two lanes that
 * put the provider in physically different places can be compared for the one
 * thing that must not differ: the index they produce.
 */
function rewrite(value, replacements) {
  if (typeof value === "string") {
    let result = value;
    for (const [from, to] of replacements) {
      if (from) result = result.split(from).join(to);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((entry) => rewrite(entry, replacements));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewrite(entry, replacements)]),
    );
  }
  return value;
}

function normalize(report, folder) {
  const providerRoot = report.providers?.[0]?.root ?? "";
  const { plugAndPlay, nodeModules, installedResolverFingerprint, ...rest } = report;
  return rewrite(rest, [
    [providerRoot, "<provider>"],
    [folder, "<app>"],
    [process.execPath, "<node>"],
  ]);
}

async function fingerprintFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

test(
  "every package manager reaches the same provider index from an install alone",
  { timeout: 1_800_000 },
  async (context) => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-provider-matrix-")));
    const artifacts = join(temporary, "artifacts");
    const sources = join(temporary, "sources");
    const reports = join(temporary, "reports");
    const harness = join(temporary, "provider-host.cjs");
    await mkdir(artifacts, { recursive: true });
    await mkdir(reports, { recursive: true });
    await writeFile(harness, HOST_HARNESS);

    let registry;
    context.after(async () => {
      await registry?.close();
      await rm(temporary, { recursive: true, force: true });
      const matrix = [...laneStatus]
        .map(([id, status]) => `  ${id.padEnd(18)} install=${status.install} frozen=${status.frozen} ${status.notes}`)
        .join("\n");
      process.stderr.write(`provider matrix lanes:\n${matrix}\n`);
    });

    // Stubs for the toolchain's own third-party dependencies so no lane needs a
    // native artifact or a network fetch. Nothing first-party is stubbed: the
    // published package has no first-party dependency left to stub.
    const stubs = await Promise.all(
      [
        ["oxlint-current", "oxlint", "1.74.0"],
        ["oxfmt-current", "oxfmt", "0.59.0"],
        ["types", "@oxc-project/types", "0.140.0"],
        ["tsgolint", "oxlint-tsgolint", "0.24.0"],
        ["pathe", "pathe", "2.0.3"],
        ["tinyglobby", "tinyglobby", "0.2.17"],
        // The eight-platform split is declared by `@tsrx/oxc` itself. Yarn
        // resolves optional dependencies for every platform, not just this
        // host's, so all eight names have to exist in the lane's registry.
        ...NATIVE_TARGETS.map((platform) => [
          `native-${platform.packageSuffix}`,
          nativePackageName(platform),
          "0.9.0",
        ]),
      ].map(([directory, name, version]) =>
        writePackage(
          join(sources, directory),
          {
            name,
            version,
            type: "module",
            exports: {
              ".": "./index.js",
              "./plugins-dev": "./index.js",
              "./package.json": "./package.json",
            },
          },
          { "index.js": "export const stub = true;\n" },
        ),
      ),
    );
    const packages = await Promise.all(
      [toolchainRoot, ...stubs].map((packageRoot) =>
        pack(packageRoot, artifacts, join(temporary, "pack-cache")),
      ),
    );
    registry = await startLocalRegistry(packages);
    const baseEnvironment = cleanEnvironment(temporary, registry.url);
    const resolverFingerprint = await fingerprintFile(repositoryResolver);

    const consumers = new Set();
    async function consumer(name, manifest, files = {}) {
      const directory = join(temporary, name);
      await writePackage(
        directory,
        { name, private: true, type: "module", ...manifest, dependencies: { "@tsrx/oxc": "0.9.0" } },
        files,
      );
      consumers.add(directory);
      return directory;
    }

    /** Run the out-of-process host against one installed consumer. */
    async function host(lane, app, label) {
      const folder = await realpath(app);
      const outFile = join(reports, `${lane.id}-${label}.json`);
      const args = [];
      if (lane.plugAndPlay) args.push("--require", join(folder, ".pnp.cjs"));
      args.push(
        harness,
        folder,
        lane.plugAndPlay
          ? repositoryResolver
          : join(folder, "node_modules/@tsrx/oxc/dist/provider-resolve.js"),
        providerClient,
        outFile,
        JSON.stringify(DOCUMENTS),
      );
      // cwd is the fixture root, never the consumer: the consumer directory only
      // ever sees its own package manager.
      const result = await run(process.execPath, args, { cwd: temporary, env: baseEnvironment });
      const text = await readFile(outFile, "utf8");
      const report = JSON.parse(text);
      assert.equal(
        result.status,
        0,
        `${lane.id} host failed: ${report.harnessError ?? result.stderr}`,
      );
      return { text, report, folder };
    }

    /**
     * One lane's whole proof: install, index, frozen reinstall from the deleted
     * install tree, and byte-identical reproduction.
     */
    async function proveLane(lane, subtest) {
      const app = await consumer(`${lane.id}-consumer`, lane.manifest ?? {});
      const environment = { ...baseEnvironment, ...(lane.environment ?? {}) };

      const installArguments = lane.install(registry.url);
      await mustRun(lane.executable, installArguments, { cwd: app, env: environment });
      record(lane, { install: "pass" });

      const declared = await trackedFiles(app, lane);
      assert.deepEqual(
        Object.keys(declared).sort(),
        lane.tracked,
        `${lane.id}: the install must leave the consumer with its manifest and one lockfile`,
      );

      const { text, report, folder } = await host(lane, app, "install");
      assert.equal(report.failure, null, `${lane.id}: ${report.failure}`);
      assert.deepEqual(
        report.diagnostics.filter((entry) => entry.severity === "error"),
        [],
        `${lane.id} discovery diagnostics`,
      );
      assert.deepEqual(
        Object.keys(report.extensions),
        [".tsrx"],
        `${lane.id}: the declared dependency is the only routed provider`,
      );
      assert.deepEqual(
        report.providers.map(({ name, id, protocol }) => ({ name, id, protocol })),
        [{ name: "@tsrx/oxc", id: "tsrx", protocol: 1 }],
        lane.id,
      );

      // The provider physically lives inside the consumer, wherever the manager
      // decided to put it, and every capability is a real file in that package.
      const providerRoot = report.providers[0].root;
      assert.equal(
        isInside(folder, providerRoot),
        true,
        `${lane.id}: provider root ${providerRoot} must be inside the consumer`,
      );
      assert.deepEqual(
        Object.keys(report.capabilities),
        [".tsrx format", ".tsrx lint", ".tsrx lsp", ".tsrx parse"],
        `${lane.id}: every declared capability must be indexed`,
      );
      for (const [name, capability] of Object.entries(report.capabilities)) {
        assert.equal(capability.present, true, `${lane.id}: ${name} is missing on disk`);
        assert.equal(
          isInside(providerRoot, capability.path),
          true,
          `${lane.id}: ${name} resolved outside the provider package`,
        );
        assert.equal(
          capability.path.split(/[/\\]/u).includes(".bin"),
          false,
          `${lane.id}: ${name} resolved through a bin shim directory`,
        );
      }

      // The code that produced the index is the code the consumer installed.
      assert.equal(
        report.installedResolverFingerprint,
        resolverFingerprint,
        `${lane.id}: the installed provider resolver must be the published file`,
      );

      // Ordinary sources stay on the official OXC path; only .tsrx is claimed.
      for (const entry of report.routed) {
        const claimed = PROVIDER_DOCUMENTS.includes(entry.document);
        assert.equal(entry.client, claimed ? "tsrx" : null, `${lane.id}: ${entry.document}`);
        assert.equal(
          entry.lint === null,
          !claimed,
          `${lane.id}: ${entry.document} lint capability`,
        );
      }
      assert.deepEqual(report.starts, ["tsrx"], `${lane.id}: one client, started once`);

      record(lane, { notes: `provider at ${relative(folder, providerRoot)}` });

      // Frozen reinstall: delete everything the install produced, then rebuild
      // from the untouched manifest and lockfile alone.
      for (const tree of lane.installTree) {
        await rm(join(app, tree), { recursive: true, force: true });
        assert.equal(
          existsSync(join(app, tree)),
          false,
          `${lane.id}: ${tree} must really be gone before the frozen reinstall`,
        );
      }
      assert.deepEqual(
        Object.keys(await trackedFiles(app, lane)).sort(),
        lane.tracked,
        `${lane.id}: the frozen reinstall starts from the manifest and lockfile alone`,
      );
      const frozenArguments = lane.frozen(registry.url);
      await mustRun(lane.executable, frozenArguments, {
        cwd: app,
        env: { ...environment, YARN_ENABLE_IMMUTABLE_INSTALLS: "1" },
      });
      record(lane, { frozen: "pass" });

      assert.deepEqual(
        await trackedFiles(app, lane),
        declared,
        `${lane.id}: the frozen reinstall must leave the manifest and lockfile byte-unchanged`,
      );
      const frozen = await host(lane, app, "frozen");
      assert.equal(
        frozen.text,
        text,
        `${lane.id}: the frozen reinstall must reproduce a byte-identical index`,
      );

      // Exactly two processes ever ran in this consumer directory, and both are
      // the package manager's own install. No setup command, no lifecycle hook,
      // no post-install fix-up.
      assert.deepEqual(
        spawned
          .filter(({ cwd }) => cwd === app)
          .map(({ executable, args }) => [executable, ...args]),
        [
          [commandName(lane.executable), ...installArguments],
          [commandName(lane.executable), ...frozenArguments],
        ],
        `${lane.id}: a consumer runs nothing but its package manager install`,
      );

      subtest.diagnostic(`${lane.id}: provider resolved at ${relative(folder, providerRoot)}`);
      return { normalized: normalize(report, folder), report, app, folder };
    }

    const results = new Map();

    for (const lane of lanes) {
      await context.test(lane.label, async (subtest) => {
        if (!available(lane.executable)) {
          const reason = `${lane.executable} is not installed on this machine`;
          record(lane, { install: "blocked", frozen: "blocked", notes: reason });
          process.stderr.write(`BLOCKED lane ${lane.id}: ${reason}\n`);
          assert.equal(
            lane.required !== true && !REQUIRED_LANES.has(lane.id),
            true,
            `${lane.id} is a required lane`,
          );
          subtest.skip(reason);
          return;
        }
        if (lane.yarn) {
          // Materialise the pinned Yarn into the fixture-local COREPACK_HOME.
          // This writes nothing outside the temp directory and installs no shim.
          const probe = await run(corepack, [`yarn@${YARN_VERSION}`, "--version"], {
            cwd: temporary,
            env: baseEnvironment,
          });
          if (probe.status !== 0 || probe.stdout.trim() !== YARN_VERSION) {
            const lines = `${probe.stderr}\n${probe.stdout}`
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            const reason = `corepack could not provision yarn@${YARN_VERSION} into the fixture: ${
              lines.find((line) => /error/iu.test(line)) ?? lines[0] ?? "unknown failure"
            }`;
            record(lane, { install: "blocked", frozen: "blocked", notes: reason });
            process.stderr.write(`BLOCKED lane ${lane.id}: ${reason}\n`);
            assert.equal(REQUIRED_LANES.has(lane.id), false, `${lane.id} is a required lane`);
            subtest.skip(reason);
            return;
          }
        }
        results.set(lane.id, await proveLane(lane, subtest));
      });
    }

    assert.ok(results.has("npm"), "the npm lane is the baseline and must run");
    const baseline = results.get("npm").normalized;
    for (const [id, result] of results) {
      if (id === "npm") continue;
      assert.deepEqual(
        result.normalized,
        baseline,
        `${id} must produce the same provider index as npm`,
      );
    }

    // Physical layouts genuinely differ, or the comparison above proved nothing.
    const layouts = [...results].map(([id, result]) => [
      id,
      relative(result.report.root, result.report.providers[0].root),
    ]);
    assert.equal(
      new Set(layouts.map(([, layout]) => layout)).size > 1,
      true,
      `the lanes must not all resolve the provider to the same physical path: ${JSON.stringify(layouts)}`,
    );

    await context.test(
      "a Plug'n'Play consumer is discovered without any node_modules",
      async (subtest) => {
        const result = results.get("yarn_pnp");
        if (result === undefined) {
          subtest.skip("the Yarn Plug'n'Play lane did not run");
          return;
        }
        assert.equal(result.report.nodeModules, false, "PnP installs no node_modules");
        assert.equal(result.report.plugAndPlay, true, "the host ran under a PnP runtime");
        assert.match(
          result.report.providers[0].root,
          /\.yarn[/\\]cache[/\\][^/\\]+\.zip[/\\]node_modules[/\\]@tsrx[/\\]oxc$/u,
          "the provider is only reachable through the PnP map",
        );
      },
    );

    await context.test(
      "a Plug'n'Play host must read through the PnP filesystem, not only resolve through it",
      async (subtest) => {
        const result = results.get("yarn_pnp");
        if (result === undefined) {
          subtest.skip("the Yarn Plug'n'Play lane did not run");
          return;
        }
        // Same consumer, same `.pnp.cjs`, same resolver — but the host process is
        // not running a PnP runtime, so `fs` is not layered over the zip cache.
        // This is the shape released `oxc.oxc-vscode` 1.59.0 has today: it calls
        // `.pnp.cjs` `resolveRequest` and then reads with an ordinary `fs`.
        const outFile = join(reports, "yarn_pnp-unpatched.json");
        const attempt = await run(
          process.execPath,
          [
            harness,
            result.folder,
            repositoryResolver,
            providerClient,
            outFile,
            JSON.stringify(DOCUMENTS),
          ],
          { cwd: temporary, env: baseEnvironment },
        );
        const report = JSON.parse(await readFile(outFile, "utf8"));
        assert.equal(attempt.status, 0, report.harnessError ?? attempt.stderr);

        assert.equal(report.plugAndPlay, false, "no PnP runtime is loaded in this host");
        // Resolution itself is fine: the injected resolver answers with the real
        // location of the provider inside the zip cache.
        assert.match(
          report.installedResolver,
          /\.zip[/\\]node_modules[/\\]@tsrx[/\\]oxc[/\\]dist[/\\]provider-resolve\.js$/u,
        );
        // Reading it is not. An unpatched `fs` cannot see inside the archive:
        // POSIX reports ENOTDIR for a path that walks through a regular file,
        // Windows reports ENOENT for the same walk. Both are the read failure
        // this lane is about, and neither may be silently tolerated.
        assert.equal(
          UNREADABLE_ARCHIVE_CODES.includes(report.installedResolverFingerprint),
          true,
          report.installedResolverFingerprint,
        );

        // Nothing is indexed, which is correct: the host genuinely could not read
        // the manifest, so it must not guess. What it must not do is stay silent.
        assert.deepEqual(Object.keys(report.extensions), []);
        assert.deepEqual(report.clients, []);

        // The host is told, by package name and by manifest path, that this is a
        // read failure rather than "no providers are installed".
        assert.ok(report.diagnostics.length > 0, "an unreadable manifest must be reported");
        for (const entry of report.diagnostics) {
          assert.equal(entry.severity, "warning", JSON.stringify(entry));
          assert.equal(entry.code, "unreadable-manifest", JSON.stringify(entry));
        }
        const named = report.diagnostics.filter((entry) =>
          (entry.packages ?? []).includes("@tsrx/oxc"),
        );
        assert.equal(named.length > 0, true, "the diagnostic must name the package");
        assert.match(named[0].manifest, /\.zip[/\\]node_modules[/\\]@tsrx[/\\]oxc[/\\]package\.json$/u);
        assert.match(named[0].message, /oxc-tsrx/u);
        assert.match(named[0].message, UNREADABLE_ARCHIVE_MESSAGE);

        // A warning, not an error: one unreadable dependency must not throw for a
        // project whose other providers resolved fine.
        assert.equal(report.failure, null);
        record(lanes.find((lane) => lane.id === "yarn_pnp"), {
          notes: `${laneStatus.get("yarn_pnp").notes}; needs a PnP-aware fs, and an unpatched reader is reported as unreadable-manifest`,
        });
      },
    );

    await context.test("no consumer directory ever saw another process", async () => {
      const insideConsumers = spawned.filter(({ cwd }) => consumers.has(cwd));
      assert.equal(insideConsumers.length, results.size * 2, "two installs per proven lane");
      for (const command of insideConsumers) {
        const verbs = command.args.filter((argument) => !argument.startsWith("-"));
        assert.equal(
          ["install", "ci"].includes(verbs.at(-1)),
          true,
          `${command.executable} ${command.args.join(" ")}`,
        );
      }
    });
  },
);

test(
  "a consumer of ordinary sources and provider sources keeps them apart",
  { timeout: 900_000 },
  async (context) => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oxc-tsrx-provider-mixed-")));
    const artifacts = join(temporary, "artifacts");
    const sources = join(temporary, "sources");
    const harness = join(temporary, "provider-host.cjs");
    await mkdir(artifacts, { recursive: true });
    await writeFile(harness, HOST_HARNESS);
    let registry;
    context.after(async () => {
      await registry?.close();
      await rm(temporary, { recursive: true, force: true });
    });

    const stubs = await Promise.all(
      [
        ["oxlint-current", "oxlint", "1.74.0"],
        ["oxfmt-current", "oxfmt", "0.59.0"],
        ["types", "@oxc-project/types", "0.140.0"],
        ["tsgolint", "oxlint-tsgolint", "0.24.0"],
        ["pathe", "pathe", "2.0.3"],
        ["tinyglobby", "tinyglobby", "0.2.17"],
        // The eight-platform split is declared by `@tsrx/oxc` itself. Yarn
        // resolves optional dependencies for every platform, not just this
        // host's, so all eight names have to exist in the lane's registry.
        ...NATIVE_TARGETS.map((platform) => [
          `native-${platform.packageSuffix}`,
          nativePackageName(platform),
          "0.9.0",
        ]),
      ].map(([directory, name, version]) =>
        writePackage(
          join(sources, directory),
          {
            name,
            version,
            type: "module",
            exports: {
              ".": "./index.js",
              "./plugins-dev": "./index.js",
              "./package.json": "./package.json",
            },
          },
          { "index.js": "export const stub = true;\n" },
        ),
      ),
    );
    const packages = await Promise.all(
      [toolchainRoot, ...stubs].map((packageRoot) =>
        pack(packageRoot, artifacts, join(temporary, "pack-cache")),
      ),
    );
    registry = await startLocalRegistry(packages);
    const environment = cleanEnvironment(temporary, registry.url);

    // A realistic application: mostly ordinary TypeScript and JavaScript, with a
    // few provider files mixed into the same directories.
    const files = Object.fromEntries([
      ...ORDINARY_DOCUMENTS.map((path) => [
        path,
        path.endsWith(".json") ? "{}\n" : "export const ordinary = true;\n",
      ]),
      ...PROVIDER_DOCUMENTS.map((path) => [path, "export const view = true;\n"]),
    ]);
    const app = join(temporary, "mixed-consumer");
    await writePackage(
      app,
      { name: "mixed-consumer", private: true, type: "module", dependencies: { "@tsrx/oxc": "0.9.0" } },
      files,
    );

    await mustRun(
      npm,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry.url}`],
      { cwd: app, env: environment },
    );

    const folder = await realpath(app);
    const outFile = join(temporary, "mixed.json");
    const result = await run(
      process.execPath,
      [
        harness,
        folder,
        join(folder, "node_modules/@tsrx/oxc/dist/provider-resolve.js"),
        providerClient,
        outFile,
        JSON.stringify(DOCUMENTS),
      ],
      { cwd: temporary, env: environment },
    );
    const report = JSON.parse(await readFile(outFile, "utf8"));
    assert.equal(result.status, 0, report.harnessError ?? result.stderr);

    assert.deepEqual(Object.keys(report.extensions), [".tsrx"]);
    assert.deepEqual(report.selector, [{ scheme: "file", pattern: "**/*.tsrx" }]);

    for (const document of ORDINARY_DOCUMENTS) {
      const entry = report.routed.find((route) => route.document === document);
      assert.equal(entry.client, null, `${document} must not be claimed by a provider`);
      assert.equal(entry.lint, null, `${document} must keep the official OXC lint path`);
      // Structural, not conventional: the protocol reserves these extensions, so
      // no provider can claim one however it declares itself.
      const extension = document.slice(document.lastIndexOf("."));
      assert.equal(
        RESERVED_EXTENSIONS.includes(extension),
        true,
        `${extension} must be reserved for the core toolchain`,
      );
    }

    for (const document of PROVIDER_DOCUMENTS) {
      const entry = report.routed.find((route) => route.document === document);
      assert.equal(entry.client, "tsrx", document);
      assert.equal(
        entry.lint,
        join(folder, "node_modules/@tsrx/oxc/bin/oxc-tsrx-lint"),
        document,
      );
    }

    assert.deepEqual(
      report.starts,
      ["tsrx"],
      "a mixed session starts exactly one provider client, for the provider files only",
    );
  },
);

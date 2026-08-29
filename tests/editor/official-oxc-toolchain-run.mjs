import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";
import { scriptNode } from "../helpers/script-node.mjs";
import { startLocalRegistry } from "../packaging/local-registry.mjs";

/**
 * Real VS Code sessions run against the released `oxc.oxc-vscode` build.
 *
 * 1. The compatibility session: `oxc-tsrx setup` runs, the official extension
 *    finds `node_modules/.bin/oxlint`, and TSRX is served because this package
 *    owns the canonical `oxlint` bin name. That is how adoption works today and
 *    its assertions are unchanged.
 * 2. The install-only discovery session: nothing but `npm install` runs, the
 *    whole of `node_modules/.bin` is deleted, the facades `setup` writes are
 *    absent, and every tool name is shadowed first on `PATH` by a decoy that
 *    records being executed. The official extension is pointed at the general
 *    Oxlint host with an absolute path inside the installed package, because no
 *    released OXC build discovers providers yet — that pointer names a host, not
 *    a language, an extension, or a server. Everything the session then proves
 *    happens strictly below it: the provider block in the installed package's
 *    own `package.json` is discovered, and the `lsp` bin it declares is started
 *    as a real process that answers real editor requests.
 * 3. The patched-host session, which only runs when
 *    `OXC_TSRX_PATCHED_OXLINT_PACKAGE` points at a locally built upstream Oxlint
 *    npm wrapper carrying the provider-dispatch patch. It is the same
 *    install-only workspace with **no `oxc.path.oxlint` setting at all**: the
 *    released extension resolves the literal `oxlint` package by ordinary Node
 *    resolution, and that package — upstream's, not this repository's — is what
 *    reads the provider block and starts the declared server. The patch is
 *    built and verified locally. It has never been submitted, merged, or
 *    released, and this lane must never be described as evidence that it was.
 * 4. The setup-value session, which is the only lane that runs the artifact a
 *    consumer actually gets. A synthetic Vite+ takes `node_modules/.bin/oxlint`,
 *    `oxc-tsrx setup` writes its own key, and this file never writes any
 *    `oxc.path.*` or `oxc.useExecPath` of its own. It runs twice on the same
 *    workspace: once with the workspace-trust feature on and the folder not
 *    trusted, where the key must be invisible to the extension, and once with
 *    the window trusted, where `.tsrx` diagnostics, formatting and a quick fix
 *    must all work.
 */

const root = resolve(import.meta.dirname, "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";

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
  throw new Error(`unsupported official-extension host ${process.platform}-${process.arch}`);
}

function run(executablePath, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executablePath, args, {
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
    child.on("close", (status, signal) => {
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

async function mustRun(executablePath, args, options = {}) {
  const result = await run(executablePath, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function pack(packageRoot, artifacts, cache) {
  // `resolve` so a caller may pass either a repository-relative directory or an
  // absolute one, which is how the synthetic collider below is packed.
  const directory = resolve(root, packageRoot);
  const result = await mustRun(
    npm,
    ["pack", "--json", "--pack-destination", artifacts, directory],
    { cwd: root, env: { ...process.env, npm_config_cache: cache } },
  );
  const packed = parseNpmPackResponse(result.stdout);
  return {
    ...packed,
    manifest: JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    tarball: join(artifacts, packed.filename),
  };
}

async function resolveOfficialExtension() {
  if (process.env.OXC_OFFICIAL_VSCODE_EXTENSION) {
    const configured = resolve(process.env.OXC_OFFICIAL_VSCODE_EXTENSION);
    await access(join(configured, "package.json"));
    return configured;
  }
  const directory = join(process.env.HOME, ".vscode", "extensions");
  const candidates = (await readdir(directory))
    .filter((name) => name.startsWith("oxc.oxc-vscode-"))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  assert.ok(
    candidates.length > 0,
    "Install the released OXC extension (oxc.oxc-vscode) before running this proof",
  );
  return join(directory, candidates[0]);
}

function cleanEnvironment(consumer, registry, extra = {}) {
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
  return { ...environment, ...extra };
}

/**
 * Launch the released extension under a real VS Code, the way
 * `@vscode/test-electron`'s `runTests` does, except that the caller decides
 * whether the workspace-trust feature stays on.
 *
 * `runTests` appends `--disable-workspace-trust` to every launch it makes
 * (`@vscode/test-electron/out/runTest.js`), so no lane built on it can observe
 * what the extension does when trust is enabled. That flag is not "run
 * untrusted": it turns the feature off, and `isWorkspaceTrustEnabled()` false
 * makes every folder trusted, which is why the three sessions above see their
 * `oxc.path.*` settings at all.
 *
 * `trustFeature: "on"` leaves the flag off, so the window is a genuine
 * Restricted Mode window: VS Code drops every value the extension lists in
 * `capabilities.untrustedWorkspaces.restrictedConfigurations`, which includes
 * `oxc.path.oxlint`.
 */
function launchEditor({
  executable: editor,
  workspace,
  officialExtension,
  extensionDirectory,
  userDirectory,
  suiteEnvironment,
  trustFeature,
}) {
  const args = [
    workspace,
    `--extensions-dir=${extensionDirectory}`,
    `--user-data-dir=${userDirectory}`,
    "--disable-extensions",
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--no-cached-data",
    "--skip-welcome",
    "--skip-release-notes",
    `--extensionDevelopmentPath=${officialExtension}`,
    `--extensionTestsPath=${join(root, "tests/editor/official-oxc-toolchain-suite.cjs")}`,
  ];
  if (trustFeature === "bypassed") args.push("--disable-workspace-trust");
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(editor, args, {
      env: { ...process.env, ...suiteEnvironment },
      stdio: "inherit",
    });
    child.on("error", rejectLaunch);
    child.on("close", (status, signal) => {
      if (status === 0) resolveLaunch(0);
      else rejectLaunch(new Error(`VS Code exited with ${status ?? signal}`));
    });
  });
}

async function assertMissing(path, message) {
  let present = true;
  try {
    await access(path);
  } catch {
    present = false;
  }
  assert.equal(present, false, message);
}

/** The workspace both sessions author, byte for byte. */
async function writeWorkspaceFixtures(directory, settings) {
  const ordinaryPath = join(directory, "ordinary.ts");
  const tsrxPath = join(directory, "View.tsrx");
  await mkdir(join(directory, ".vscode"), { recursive: true });
  await Promise.all([
    writeFile(
      join(directory, ".oxlintrc.json"),
      `${JSON.stringify(
        { rules: { "no-debugger": "error", "no-var": "error" } },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(directory, ".oxfmtrc.json"),
      `${JSON.stringify({ semi: true, singleQuote: true }, null, 2)}\n`,
    ),
    writeFile(
      join(directory, ".vscode/settings.json"),
      `${JSON.stringify(settings, null, 2)}\n`,
    ),
    writeFile(
      ordinaryPath,
      "export function ordinary() {\n  debugger;\n  return 1;\n}\n",
    ),
    writeFile(
      tsrxPath,
      [
        "export function View( ) @{",
        "var count=0;",
        "debugger;",
        "<button>{count}</button>",
        "}",
        "",
      ].join("\n"),
    ),
  ]);
  return { ordinaryPath, tsrxPath };
}

/**
 * Shadow every tool name this toolchain publishes with a script that records
 * being run and fails. Placed first on `PATH`, it turns "no PATH lookup" into a
 * falsifiable claim: a lookup by tool name leaves a file behind.
 */
const DECOY_TOOL_NAMES = Object.freeze([
  "oxc-tsrx",
  "oxc-tsrx-fmt",
  "oxc-tsrx-lint",
  "oxc-tsrx-lsp",
  "oxfmt",
  "oxfmt-tsrx",
  "oxlint",
  "oxlint-tsrx",
]);
const DECOY_STATUS = 87;

async function writePathDecoys(directory, marker) {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    DECOY_TOOL_NAMES.map((name) =>
      writeFile(
        join(directory, name),
        [
          "#!/bin/sh",
          `printf '%s %s\\n' "$0" "$*" >> '${marker}'`,
          `exit ${DECOY_STATUS}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      ),
    ),
  );
}

/**
 * The install-only session again, with the pointer removed and a **patched
 * upstream Oxlint** in the place an ordinary `npm install oxlint` would put it.
 *
 * Session 2 has to name the host with `oxc.path.oxlint` because no released OXC
 * build can locate a provider host on its own. This session removes that
 * setting entirely. The released extension's own resolution chain
 * (`node_modules/.bin` — deleted, workspace `package.json` scan, then
 * `require.resolve("oxlint")`) is what finds the host, and the host is
 * upstream's wrapper carrying the locally built provider-dispatch patch.
 *
 * The patch is a local source build. It is not published, not submitted, and
 * not merged, so this lane is opt-in: without
 * `OXC_TSRX_PATCHED_OXLINT_PACKAGE` it reports that it was skipped and the two
 * released-software sessions above stand on their own.
 */
async function runPatchedHostSession({
  root: temporary,
  registry,
  executable,
  officialExtension,
  decoys,
  decoyMarker,
  search,
  toolchainVersion,
}) {
  const patchedPackage = process.env.OXC_TSRX_PATCHED_OXLINT_PACKAGE;
  if (!patchedPackage) {
    process.stdout.write(
      "[patched-host] SKIP set OXC_TSRX_PATCHED_OXLINT_PACKAGE to a locally built patched upstream oxlint package\n",
    );
    return;
  }
  const patchedRoot = resolve(patchedPackage);
  const patchedManifest = JSON.parse(
    await readFile(join(patchedRoot, "package.json"), "utf8"),
  );
  assert.equal(
    patchedManifest.name,
    "oxlint",
    "OXC_TSRX_PATCHED_OXLINT_PACKAGE must point at a package named oxlint",
  );
  assert.equal(
    patchedManifest.oxc?.provider,
    undefined,
    "the host must be a host, not a provider",
  );

  const patched = join(temporary, "patched-host");
  await mkdir(patched, { recursive: true });
  const environment = cleanEnvironment(patched, registry.url);

  await writeFile(
    join(patched, "package.json"),
    `${JSON.stringify(
      {
        name: "oxc-tsrx-patched-host-discovery-proof",
        private: true,
        type: "module",
        dependencies: { "@tsrx/oxc": "0.8.0" },
      },
      null,
      2,
    )}\n`,
  );
  await mustRun(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: patched, env: environment },
  );

  // Same install-only conditions as session 2: no `.bin`, no `setup`.
  await rm(join(patched, "node_modules/.bin"), { recursive: true, force: true });
  await assertMissing(
    join(patched, "node_modules/.bin"),
    "node_modules/.bin survived in the patched-host workspace",
  );
  for (const facade of ["oxfmt", "oxc-parser"]) {
    await assertMissing(
      join(patched, "node_modules", facade),
      `${facade} exists without oxc-tsrx setup`,
    );
  }

  // The patched wrapper is placed exactly where `npm install oxlint` would put
  // it. It is a local source build of upstream, so it cannot come from the
  // local registry; the copy is the only thing this session does by hand, and
  // it is a *host*, carrying no TSRX knowledge of any kind.
  const hostRoot = join(patched, "node_modules/oxlint");
  await cp(patchedRoot, hostRoot, { recursive: true, dereference: true });
  const hostBin = join(hostRoot, "bin/oxlint");
  await access(hostBin);

  const fixtures = await writeWorkspaceFixtures(patched, {
    "oxc.enable.oxlint": true,
    "oxc.enable.oxfmt": false,
    "oxc.requireConfig": false,
    // No `oxc.path.oxlint`, and no `oxc.path.*` of any kind. `useExecPath` is
    // kept for the same reason session 2 keeps it: it stops the extension
    // rebuilding the child `PATH`, which is what makes the decoy contrast
    // falsifiable rather than decorative.
    "oxc.useExecPath": true,
  });

  const manifestBefore = await readFile(join(patched, "package.json"), "utf8");
  const lockfileBefore = await readFile(join(patched, "package-lock.json"), "utf8");

  await runTests({
    vscodeExecutablePath: executable,
    reuseMachineInstall: false,
    extensionDevelopmentPath: officialExtension,
    extensionTestsPath: join(root, "tests/editor/official-oxc-toolchain-suite.cjs"),
    extensionTestsEnv: cleanEnvironment(patched, registry.url, {
      PATH: search,
      SHELL: join(temporary, "absent-login-shell"),
      OXC_TSRX_SUITE_MODE: "patched-host",
      OXC_TSRX_DISCOVERY_ROOT: patched,
      OXC_TSRX_EXPECTED_DEPENDENCIES: JSON.stringify({ "@tsrx/oxc": toolchainVersion }),
      OXC_TSRX_PATH_DECOY_DIR: decoys,
      OXC_TSRX_PATH_DECOY_MARKER: decoyMarker,
      OXC_TSRX_EDITOR_FILE: fixtures.tsrxPath,
      OXC_TSRX_ORDINARY_EDITOR_FILE: fixtures.ordinaryPath,
      OXC_TSRX_EXPECTED_EXTENSION_PATH: officialExtension,
      OXC_TSRX_EXPECTED_HOST_BIN: hostBin,
    }),
    launchArgs: [
      patched,
      `--extensions-dir=${join(temporary, "patched-host-extensions")}`,
      `--user-data-dir=${join(temporary, "patched-host-user")}`,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
  });

  await assertMissing(
    decoyMarker,
    "a tool name was resolved from PATH during the patched-host session",
  );
  await assertMissing(
    join(patched, "node_modules/.bin"),
    "node_modules/.bin was recreated during the patched-host session",
  );
  assert.equal(await readFile(join(patched, "package.json"), "utf8"), manifestBefore);
  assert.equal(await readFile(join(patched, "package-lock.json"), "utf8"), lockfileBefore);
}

/**
 * A synthetic Vite+. It publishes the two bin names Vite+ publishes and sorts
 * after `@tsrx/oxc`, which is the shape `tests/packaging/reinstall-survival`
 * measured taking both names under pnpm 10.33. Both of its shims fail loudly,
 * so a `.tsrx` request that ever reached one would be unmistakable rather than
 * merely diagnostic free.
 */
const COLLIDER = "vite-plus-bin-collider";
const COLLIDER_VERSION = "9.9.9";
/** Exactly what `oxc-tsrx setup` writes, and the only thing that may write it. */
const EDITOR_KEY = "oxc.path.oxlint";
const EDITOR_VALUE = "node_modules/@tsrx/oxc/bin/oxlint";

async function writeBinCollider(directory) {
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: COLLIDER,
        version: COLLIDER_VERSION,
        description: "Stands in for Vite+, which owns node_modules/.bin/oxlint in a real scaffold",
        type: "module",
        bin: { oxlint: "./bin/oxlint", oxfmt: "./bin/oxfmt" },
        files: ["bin"],
        license: "MIT",
      },
      null,
      2,
    )}\n`,
  );
  for (const name of ["oxlint", "oxfmt"]) {
    const shim = join(directory, "bin", name);
    await writeFile(
      shim,
      `#!/usr/bin/env node\nconsole.error("${COLLIDER} owns ${name}; it knows nothing about .tsrx");\nprocess.exit(3);\n`,
    );
    await chmod(shim, 0o755);
  }
  return directory;
}

/**
 * Whatever the package manager last wrote into `node_modules/.bin/oxlint`, and
 * whether it belongs to this package. Read twice: once to prove the collider
 * really took the name, and once at the end to prove it still has it, so a
 * green session can never be explained by the shim quietly becoming ours.
 */
async function linterShimOwner(consumer, providerReal) {
  const shim = join(consumer, "node_modules/.bin/oxlint");
  const info = await lstat(shim).catch(() => null);
  if (!info) return { present: false, ours: false, detail: "absent" };
  const target = await realpath(shim).catch(() => null);
  if (target && target.startsWith(`${providerReal}${sep}`)) {
    return { present: true, ours: true, detail: `symlink -> ${target}` };
  }
  const source =
    info.isFile() && !info.isSymbolicLink() ? await readFile(shim, "utf8").catch(() => "") : "";
  if (/@tsrx[\\/]oxc[\\/]bin[\\/]oxlint/u.test(source)) {
    return { present: true, ours: true, detail: "text shim naming @tsrx/oxc" };
  }
  return { present: true, ours: false, detail: target ?? "text shim naming another package" };
}

/**
 * The session this whole board exists for: the exact artifact `setup` writes,
 * in a real editor, in a tree where auto-detection would land on the wrong
 * binary.
 *
 * Everything the other three sessions do to make the extension find our linter,
 * this one refuses to do. It writes no `oxc.path.*`; `oxc-tsrx setup` writes
 * its own key and the assertions read it back off disk. It writes no
 * `oxc.useExecPath`, so the extension spawns the value as written rather than
 * handing it to the editor's Node. And a synthetic Vite+ owns
 * `node_modules/.bin/oxlint`, so the extension's own lookup would find a binary
 * that exits 3 if the key were ignored.
 *
 * It runs the same workspace twice:
 *
 * - `setup-value-untrusted` keeps the workspace-trust feature on and does not
 *   trust the folder. `oxc.path.oxlint` is a restricted configuration, so VS
 *   Code drops it and the extension cannot see it. This is the measurement
 *   behind the claim that the written key is worth nothing in Restricted Mode.
 * - `setup-value` is the proof: a trusted window, the key visible, and `.tsrx`
 *   diagnostics, formatting and a quick fix all served by the file the relative
 *   value names.
 */
async function runSetupValueSession({
  root: temporary,
  registry,
  executable: editor,
  officialExtension,
  toolchainVersion,
}) {
  assert.equal(
    spawnSync(pnpm, ["--version"], { stdio: "ignore" }).status,
    0,
    "this session is about the tree pnpm builds, where another package owns .bin/oxlint, so pnpm is required rather than skipped",
  );

  const consumer = join(temporary, "setup-value");
  await mkdir(consumer, { recursive: true });
  const environment = cleanEnvironment(consumer, registry.url, {
    XDG_CACHE_HOME: join(temporary, "setup-value-xdg-cache"),
    XDG_DATA_HOME: join(temporary, "setup-value-xdg-data"),
    XDG_STATE_HOME: join(temporary, "setup-value-xdg-state"),
    PNPM_HOME: join(temporary, "setup-value-pnpm-home"),
  });

  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "oxc-tsrx-setup-value-proof",
        private: true,
        type: "module",
        devDependencies: {
          "@tsrx/oxc": toolchainVersion,
          [COLLIDER]: COLLIDER_VERSION,
        },
      },
      null,
      2,
    )}\n`,
  );
  // `pnpm remove` and `pnpm rebuild` reject `--registry` outright, so every
  // command in this file carries the registry in `npm_config_registry` too.
  await mustRun(
    pnpm,
    ["install", "--no-frozen-lockfile", "--ignore-scripts", `--registry=${registry.url}`],
    { cwd: consumer, env: environment },
  );

  const providerReal = await realpath(join(consumer, "node_modules/@tsrx/oxc"));
  const initialShim = await linterShimOwner(consumer, providerReal);
  assert.equal(
    initialShim.present && !initialShim.ours,
    true,
    `${COLLIDER} must take node_modules/.bin/oxlint, otherwise the extension's own lookup would find us and this session proves nothing: ${JSON.stringify(initialShim)}`,
  );

  // The workspace is authored first, with nothing but the enable flags, and
  // then `setup` merges its own key into it. That ordering is the point: the
  // key under test is the one the shipped command produced.
  const fixtures = await writeWorkspaceFixtures(consumer, {
    "oxc.enable.oxlint": true,
    "oxc.enable.oxfmt": false,
    "oxc.requireConfig": false,
  });
  await mustRun(
    process.execPath,
    [join(consumer, "node_modules/@tsrx/oxc/bin/oxc-tsrx"), "setup"],
    { cwd: consumer, env: environment },
  );

  const settingsPath = join(consumer, ".vscode/settings.json");
  const written = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(
    written,
    {
      "oxc.enable.oxlint": true,
      "oxc.enable.oxfmt": false,
      "oxc.requireConfig": false,
      [EDITOR_KEY]: EDITOR_VALUE,
    },
    "setup must merge exactly one key into the settings this session authored",
  );
  assert.equal(
    isAbsolute(written[EDITOR_KEY]),
    false,
    "the value under test is the relative one setup writes, not an absolute path",
  );
  assert.equal(
    Object.keys(written).some((key) => key === "oxc.useExecPath"),
    false,
    "this session must never add oxc.useExecPath: the point is whether the value is spawnable as written",
  );

  const suiteEnvironment = (mode) =>
    cleanEnvironment(consumer, registry.url, {
      OXC_TSRX_SUITE_MODE: mode,
      OXC_TSRX_SETUP_VALUE_ROOT: consumer,
      OXC_TSRX_EXPECTED_EDITOR_VALUE: EDITOR_VALUE,
      OXC_TSRX_EDITOR_FILE: fixtures.tsrxPath,
      OXC_TSRX_ORDINARY_EDITOR_FILE: fixtures.ordinaryPath,
      OXC_TSRX_EXPECTED_EXTENSION_PATH: officialExtension,
    });

  await launchEditor({
    executable: editor,
    workspace: consumer,
    officialExtension,
    extensionDirectory: join(temporary, "setup-value-untrusted-extensions"),
    userDirectory: join(temporary, "setup-value-untrusted-user"),
    suiteEnvironment: suiteEnvironment("setup-value-untrusted"),
    trustFeature: "on",
  });

  // A trusted window. `--disable-workspace-trust` is the only way to get one
  // here: VS Code answers `useInMemoryStorage: !!extensionTestsLocationURI`
  // when it builds its storage services, so a run driven by
  // `--extensionTestsPath` cannot read a persisted grant out of
  // `<shared-data-dir>/sharedStorage/state.vscdb`, and there is no API or
  // command an extension can call to trust a folder without a modal. What the
  // extension sees is what a real grant produces: the feature reports every
  // folder trusted, `vscode.workspace.isTrusted` is true, and restricted
  // configurations are handed over. The lane above is what proves the
  // difference is being enforced at all.
  await launchEditor({
    executable: editor,
    workspace: consumer,
    officialExtension,
    extensionDirectory: join(temporary, "setup-value-extensions"),
    userDirectory: join(temporary, "setup-value-user"),
    suiteEnvironment: suiteEnvironment("setup-value"),
    trustFeature: "bypassed",
  });

  // Nothing about the mechanism moved while the editor was running: the key is
  // still the one `setup` wrote, and the shim is still not ours.
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), written);
  const finalShim = await linterShimOwner(consumer, providerReal);
  assert.equal(
    finalShim.ours,
    false,
    `node_modules/.bin/oxlint became ours during the session, so this run would not prove the setting carried it: ${JSON.stringify(finalShim)}`,
  );
}

/**
 * Drive the real VS Code sessions.
 *
 * Everything above is exported harness: `tests/editor/vscode-run.mjs` reuses it
 * to build the same install-only workspace for this repository's own client, so
 * the packing, local registry, decoy, and fixture machinery has one definition.
 */
async function main() {
  const officialExtension = await resolveOfficialExtension();
  const temporary = await mkdtemp(join(tmpdir(), "otx-"));
  const artifacts = join(temporary, "artifacts");
  const consumer = join(temporary, "consumer");
  const discovery = join(temporary, "discovery");
  const decoys = join(temporary, "path-decoys");
  const decoyMarker = join(temporary, "path-decoy-invocations.log");
  const cache = join(temporary, ".pack-cache");
  const extensionDirectory = join(temporary, "extensions");
  const userDirectory = join(temporary, "user");
  const collider = join(temporary, "sources", COLLIDER);
  await Promise.all([
    mkdir(artifacts, { recursive: true }),
    mkdir(consumer, { recursive: true }),
    mkdir(discovery, { recursive: true }),
    mkdir(extensionDirectory, { recursive: true }),
    mkdir(join(consumer, ".vscode"), { recursive: true }),
    writeBinCollider(collider),
  ]);

  let registry;
  try {
    const nativeResult = await mustRun(
      scriptNode(),
      [
        "scripts/package-native.ts",
        // The editor lanes never import `@tsrx/oxc/parser`, and building the
        // addon is a separate `build:parser-native` step this proof does not
        // ask for. `tests/packaging/clean-install.test.mjs` opts out the same
        // way.
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
    const packages = await Promise.all([
      pack("packages/toolchain", artifacts, cache),
      pack(collider, artifacts, cache),
    ]);
    const toolchainVersion = packages[0].manifest.version;
    registry = await startLocalRegistry([
      ...packages,
      {
        manifest: { name: native.packageName, version: native.version },
        tarball: native.tarball,
        integrity: native.integrity,
        shasum: native.shasum,
      },
    ]);
    const environment = cleanEnvironment(consumer, registry.url);

    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "oxc-tsrx-official-extension-proof",
          private: true,
          type: "module",
          dependencies: { "@tsrx/oxc": "0.8.0" },
        },
        null,
        2,
      )}\n`,
    );
    await mustRun(
      npm,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: consumer, env: environment },
    );
    await mustRun(
      process.execPath,
      [join(consumer, "node_modules/@tsrx/oxc/bin/oxc-tsrx"), "setup"],
      { cwd: consumer, env: environment },
    );

    const installedOxlint = await realpath(join(consumer, "node_modules/.bin/oxlint"));
    assert.equal(
      installedOxlint,
      await realpath(join(consumer, "node_modules/@tsrx/oxc/bin/oxlint")),
      "the official extension must discover the public package's oxlint launcher",
    );
    const directDependencies = JSON.parse(
      await readFile(join(consumer, "package.json"), "utf8"),
    ).dependencies;
    assert.deepEqual(directDependencies, { "@tsrx/oxc": "0.8.0" });

    const { ordinaryPath, tsrxPath } = await writeWorkspaceFixtures(consumer, {
      "oxc.enable.oxlint": true,
      "oxc.enable.oxfmt": false,
      "oxc.requireConfig": false,
    });

    await runTests({
      vscodeExecutablePath: executable,
      reuseMachineInstall: false,
      extensionDevelopmentPath: officialExtension,
      extensionTestsPath: join(root, "tests/editor/official-oxc-toolchain-suite.cjs"),
      extensionTestsEnv: cleanEnvironment(consumer, registry.url, {
        OXC_TSRX_EDITOR_FILE: tsrxPath,
        OXC_TSRX_ORDINARY_EDITOR_FILE: ordinaryPath,
        OXC_TSRX_EXPECTED_EXTENSION_PATH: officialExtension,
      }),
      launchArgs: [
        consumer,
        `--extensions-dir=${extensionDirectory}`,
        `--user-data-dir=${userDirectory}`,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });

    // ---------------------------------------------------------------------------
    // The install-only discovery session.
    // ---------------------------------------------------------------------------

    const discoveryEnvironment = cleanEnvironment(discovery, registry.url);
    await writeFile(
      join(discovery, "package.json"),
      `${JSON.stringify(
        {
          name: "oxc-tsrx-install-only-discovery-proof",
          private: true,
          type: "module",
          dependencies: { "@tsrx/oxc": "0.8.0" },
        },
        null,
        2,
      )}\n`,
    );
    await mustRun(
      npm,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: discovery, env: discoveryEnvironment },
    );

    // Nothing else runs in this workspace. `.bin` is removed outright so the
    // compatibility route the official extension normally takes cannot exist, and
    // `oxc-tsrx setup` is never invoked, so none of its facades are installed.
    await rm(join(discovery, "node_modules/.bin"), { recursive: true, force: true });
    await assertMissing(
      join(discovery, "node_modules/.bin"),
      "node_modules/.bin survived in the install-only workspace",
    );
    for (const facade of ["oxlint", "oxfmt", "oxc-parser"]) {
      await assertMissing(
        join(discovery, "node_modules", facade),
        `${facade} exists without oxc-tsrx setup`,
      );
    }

    const discoveredHost = join(discovery, "node_modules/@tsrx/oxc/bin/oxlint");
    const discoveredServer = join(discovery, "node_modules/@tsrx/oxc/bin/oxc-tsrx-lsp");
    await access(discoveredHost);
    await access(discoveredServer);

    await writePathDecoys(decoys, decoyMarker);
    const search = [
      decoys,
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(delimiter);

    // Contrast: prove the decoys really do answer a lookup by tool name, so the
    // "no decoy ran" assertion below cannot pass vacuously.
    const control = await run("/bin/sh", ["-c", "oxlint --lsp"], {
      cwd: discovery,
      env: { PATH: search },
    });
    assert.equal(control.status, DECOY_STATUS, control.stderr || control.stdout);
    assert.ok(
      (await readFile(decoyMarker, "utf8")).includes(`${join(decoys, "oxlint")} --lsp`),
      "the PATH decoy did not record its own invocation",
    );
    await rm(decoyMarker, { force: true });

    const discoveryFixtures = await writeWorkspaceFixtures(discovery, {
      "oxc.enable.oxlint": true,
      "oxc.enable.oxfmt": false,
      "oxc.requireConfig": false,
      // No released OXC build discovers providers, so the host still has to be
      // named. This is an absolute path to the general Oxlint host inside the
      // installed package: it is not `.bin`, not `PATH`, not an alias, and it
      // carries no language, extension, or server information.
      "oxc.path.oxlint": discoveredHost,
      // Run that host under the editor's own Node so the extension does not
      // prepend the package's `bin` directory to `PATH`, which would put the real
      // tool names ahead of the decoys and make the PATH claim unfalsifiable.
      "oxc.useExecPath": true,
    });

    const manifestBefore = await readFile(join(discovery, "package.json"), "utf8");
    const lockfileBefore = await readFile(join(discovery, "package-lock.json"), "utf8");

    await runTests({
      vscodeExecutablePath: executable,
      reuseMachineInstall: false,
      extensionDevelopmentPath: officialExtension,
      extensionTestsPath: join(root, "tests/editor/official-oxc-toolchain-suite.cjs"),
      extensionTestsEnv: cleanEnvironment(discovery, registry.url, {
        PATH: search,
        // The official extension otherwise replaces the child environment with a
        // login shell's, which would discard the shadowed `PATH` above. Pointing
        // `SHELL` at a path that does not exist makes it keep this one.
        SHELL: join(temporary, "absent-login-shell"),
        OXC_TSRX_SUITE_MODE: "discovery",
        OXC_TSRX_DISCOVERY_ROOT: discovery,
        OXC_TSRX_EXPECTED_DEPENDENCIES: JSON.stringify({ "@tsrx/oxc": toolchainVersion }),
        OXC_TSRX_PATH_DECOY_DIR: decoys,
        OXC_TSRX_PATH_DECOY_MARKER: decoyMarker,
        OXC_TSRX_EDITOR_FILE: discoveryFixtures.tsrxPath,
        OXC_TSRX_ORDINARY_EDITOR_FILE: discoveryFixtures.ordinaryPath,
        OXC_TSRX_EXPECTED_EXTENSION_PATH: officialExtension,
      }),
      launchArgs: [
        discovery,
        `--extensions-dir=${join(temporary, "discovery-extensions")}`,
        `--user-data-dir=${join(temporary, "discovery-user")}`,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });

    await assertMissing(
      decoyMarker,
      "a tool name was resolved from PATH during the install-only session",
    );
    await assertMissing(
      join(discovery, "node_modules/.bin"),
      "node_modules/.bin was recreated during the install-only session",
    );
    for (const facade of ["oxlint", "oxfmt", "oxc-parser"]) {
      await assertMissing(
        join(discovery, "node_modules", facade),
        `${facade} was installed during the install-only session`,
      );
    }
    assert.equal(await readFile(join(discovery, "package.json"), "utf8"), manifestBefore);
    assert.equal(
      await readFile(join(discovery, "package-lock.json"), "utf8"),
      lockfileBefore,
    );

    // ---------------------------------------------------------------------------
    // The setup-value session: the artifact `setup` writes, in a tree where the
    // extension's own lookup would find someone else's binary.
    // ---------------------------------------------------------------------------

    await runSetupValueSession({
      root: temporary,
      registry,
      executable,
      officialExtension,
      toolchainVersion,
    });

    // ---------------------------------------------------------------------------
    // The patched-host session: the same workspace with no pointer at all.
    // ---------------------------------------------------------------------------

    await runPatchedHostSession({
      root: temporary,
      registry,
      executable,
      officialExtension,
      decoys,
      decoyMarker,
      search,
      toolchainVersion,
    });
  } finally {
    await registry?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();

export {
  DECOY_STATUS,
  DECOY_TOOL_NAMES,
  assertMissing,
  cleanEnvironment,
  hostTarget,
  launchEditor,
  main,
  mustRun,
  pack,
  run,
  runPatchedHostSession,
  runSetupValueSession,
  writeBinCollider,
  writePathDecoys,
  writeWorkspaceFixtures,
};

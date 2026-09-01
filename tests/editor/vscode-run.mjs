import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";
import { scriptNode } from "../helpers/script-node.mjs";
import { startLocalRegistry } from "../packaging/local-registry.mjs";
import {
  DECOY_STATUS,
  assertMissing,
  cleanEnvironment,
  hostTarget,
  mustRun,
  pack,
  run,
  writePathDecoys,
  writeWorkspaceFixtures,
} from "./official-oxc-toolchain-run.mjs";

await import("../../packages/vscode/build.mjs");

const root = resolve(import.meta.dirname, "../..");
const markless = resolve(
  process.env.MARKLESS_ROOT ?? "/Users/jacksm5pro/dev/open-source/markless",
);
const marklessSource = join(
  markless,
  "packages/vitest-browser/browser/fixtures/arm-try-events.tsrx",
);
const marklessExtension = join(markless, "packages/vscode-plugin");
const extension = join(root, "packages/vscode");
// The one multi-call native binary; the extension starts it with `lsp`.
const server = join(root, "target/release/oxc-tsrx");
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";

function externalFingerprint() {
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
    cwd: markless,
  });
  const diff = execFileSync("git", ["diff", "--binary"], { cwd: markless });
  return createHash("sha256").update(status).update(diff).digest("hex");
}

const before = externalFingerprint();
const marklessHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: markless,
  encoding: "utf8",
}).trim();
const sourceSha256 = createHash("sha256")
  .update(await readFile(marklessSource))
  .digest("hex");
const workspace = await mkdtemp(join(tmpdir(), "oxc-tsrx-vscode-"));
await mkdir(join(workspace, ".vscode"), { recursive: true });
await mkdir(join(workspace, "config"), { recursive: true });
const sourcePath = join(workspace, "App.tsrx");
await cp(marklessSource, sourcePath);
let source = await readFile(sourcePath, "utf8");
source = source
  .replace(
    "export function App() @{",
    "export function App() @{\nvar editorProbe=0;\nvoid editorProbe;\ndebugger;",
  )
  .replace("let saved = state('none');", "let saved=state('none');");
await writeFile(sourcePath, source);
await writeFile(
  join(workspace, ".oxlintrc.json"),
  `${JSON.stringify({ rules: { "no-debugger": "off", "no-var": "off" } }, null, 2)}\n`,
);
await writeFile(
  join(workspace, "config/strict.json"),
  `${JSON.stringify({ rules: { "no-debugger": "error", "no-var": "error" } }, null, 2)}\n`,
);
await writeFile(
  join(workspace, "config/no-var-only.json"),
  `${JSON.stringify({ rules: { "no-debugger": "off", "no-var": "error" } }, null, 2)}\n`,
);
await writeFile(
  join(workspace, ".oxfmtrc.json"),
  `${JSON.stringify({ semi: true, singleQuote: true }, null, 2)}\n`,
);
await writeFile(
  join(workspace, ".vscode/settings.json"),
  `${JSON.stringify(
    {
      "oxcTsrx.lint.configPath": "config/strict.json",
      "[markless-tsrx]": {
        "editor.defaultFormatter": "thejackshelton.oxc-tsrx-vscode",
        "editor.formatOnSave": true,
      },
    },
    null,
    2,
  )}\n`,
);

/**
 * Session 2: this repository's own VS Code client, with no pointer at all.
 *
 * The workspace above hands the extension `OXC_TSRX_LSP_BIN`, so it only ever
 * exercises the compatibility fallback in `packages/vscode/src/extension.cts`.
 * This second session removes every pointer: the packed toolchain is installed
 * as an ordinary dependency from a local registry, `node_modules/.bin` is
 * deleted, every tool name is shadowed on `PATH` by a decoy proven to fire
 * beforehand, `oxc-tsrx setup` never runs, and neither `OXC_TSRX_LSP_BIN` nor
 * `oxcTsrx.server.path` nor any `oxc.path.*` setting exists. The only way a
 * language server can exist is the `discoverProviders` branch reading the
 * installed package's own `oxc.provider` block, and the process table has to
 * agree.
 *
 * This proves our own client and the provider protocol. It proves nothing about
 * any released OXC build: no released Oxlint, Oxfmt, Vite+, or `oxc.oxc-vscode`
 * reads `oxc.provider`.
 */
async function runInstallOnlyDiscoverySession() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const temporary = await mkdtemp(join(tmpdir(), "oxc-tsrx-vscode-discovery-"));
  const artifacts = join(temporary, "artifacts");
  const discovery = join(temporary, "workspace");
  const decoys = join(temporary, "path-decoys");
  const decoyMarker = join(temporary, "path-decoy-invocations.log");
  const cache = join(temporary, ".pack-cache");
  await Promise.all([
    mkdir(artifacts, { recursive: true }),
    mkdir(discovery, { recursive: true }),
  ]);

  let registry;
  try {
    const nativeResult = await mustRun(
      scriptNode(),
      [
        "scripts/package-native.ts",
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
    const packages = await Promise.all([pack("packages/toolchain", artifacts, cache)]);
    registry = await startLocalRegistry([
      ...packages,
      {
        manifest: { name: native.packageName, version: native.version },
        tarball: native.tarball,
        integrity: native.integrity,
        shasum: native.shasum,
      },
    ]);

    const environment = cleanEnvironment(discovery, registry.url);
    await writeFile(
      join(discovery, "package.json"),
      `${JSON.stringify(
        {
          name: "oxc-tsrx-own-client-discovery-proof",
          private: true,
          type: "module",
          dependencies: { "@tsrx/oxc": "0.9.0" },
        },
        null,
        2,
      )}\n`,
    );
    await mustRun(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: discovery,
      env: environment,
    });

    // Nothing else runs in this workspace. `.bin` is deleted outright and
    // `oxc-tsrx setup` is never invoked, so none of its facades exist.
    await rm(join(discovery, "node_modules/.bin"), { recursive: true, force: true });
    await assertMissing(
      join(discovery, "node_modules/.bin"),
      "node_modules/.bin survived in the pointer-free workspace",
    );
    for (const facade of ["oxlint", "oxfmt", "oxc-parser"]) {
      await assertMissing(
        join(discovery, "node_modules", facade),
        `${facade} exists without oxc-tsrx setup`,
      );
    }
    await access(join(discovery, "node_modules/@tsrx/oxc/bin/oxc-tsrx-lsp"));

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
    const control = await run("/bin/sh", ["-c", "oxc-tsrx-lsp --stdio"], {
      cwd: discovery,
      env: { PATH: search },
    });
    assert.equal(control.status, DECOY_STATUS, control.stderr || control.stdout);
    assert.ok(
      (await readFile(decoyMarker, "utf8")).includes(
        `${join(decoys, "oxc-tsrx-lsp")} --stdio`,
      ),
      "the PATH decoy did not record its own invocation",
    );
    await rm(decoyMarker, { force: true });

    // No settings at all: no `oxcTsrx.server.path`, no `oxc.path.*`, nothing.
    const fixtures = await writeWorkspaceFixtures(discovery, {});

    const manifestBefore = await readFile(join(discovery, "package.json"), "utf8");
    const lockfileBefore = await readFile(join(discovery, "package-lock.json"), "utf8");

    await runTests({
      vscodeExecutablePath: executable,
      reuseMachineInstall: false,
      extensionDevelopmentPath: extension,
      extensionTestsPath: join(root, "tests/editor/vscode-suite.cjs"),
      extensionTestsEnv: cleanEnvironment(discovery, registry.url, {
        PATH: search,
        // VS Code otherwise replaces the extension host environment with a login
        // shell's, which would discard the shadowed `PATH` above. Pointing
        // `SHELL` at a path that does not exist makes it keep this one.
        SHELL: join(temporary, "absent-login-shell"),
        OXC_TSRX_SUITE_MODE: "discovery",
        OXC_TSRX_DISCOVERY_ROOT: discovery,
        OXC_TSRX_PATH_DECOY_DIR: decoys,
        OXC_TSRX_PATH_DECOY_MARKER: decoyMarker,
        OXC_TSRX_EDITOR_FILE: fixtures.tsrxPath,
        OXC_TSRX_ORDINARY_EDITOR_FILE: fixtures.ordinaryPath,
      }),
      launchArgs: [
        discovery,
        `--extensions-dir=${join(temporary, "extensions")}`,
        `--user-data-dir=${join(temporary, "user")}`,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });

    await assertMissing(
      decoyMarker,
      "a tool name was resolved from PATH during the pointer-free session",
    );
    await assertMissing(
      join(discovery, "node_modules/.bin"),
      "node_modules/.bin was recreated during the pointer-free session",
    );
    for (const facade of ["oxlint", "oxfmt", "oxc-parser"]) {
      await assertMissing(
        join(discovery, "node_modules", facade),
        `${facade} was installed during the pointer-free session`,
      );
    }
    assert.equal(await readFile(join(discovery, "package.json"), "utf8"), manifestBefore);
    assert.equal(
      await readFile(join(discovery, "package-lock.json"), "utf8"),
      lockfileBefore,
    );
  } finally {
    await registry?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

let passed = false;
try {
  await runTests({
    vscodeExecutablePath: executable,
    reuseMachineInstall: false,
    extensionDevelopmentPath: [extension, marklessExtension],
    extensionTestsPath: join(root, "tests/editor/vscode-suite.cjs"),
    extensionTestsEnv: {
      ...process.env,
      OXC_TSRX_SUITE_MODE: "markless",
      OXC_TSRX_LSP_BIN: server,
      OXC_TSRX_EDITOR_FILE: sourcePath,
    },
    launchArgs: [
      workspace,
      `--extensions-dir=${join(workspace, ".vscode-extensions")}`,
      `--user-data-dir=${join(workspace, ".vscode-user")}`,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
  });
  passed = true;
} finally {
  const after = externalFingerprint();
  assert.equal(after, before, "the read-only Markless worktree changed");
  if (passed) {
    const vscodeManifest = JSON.parse(
      await readFile(
        "/Applications/Visual Studio Code.app/Contents/Resources/app/package.json",
        "utf8",
      ),
    );
    await writeFile(
      join(root, "tests/editor/markless-vscode-walkthrough.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          recordedAt: new Date().toISOString(),
          vscodeVersion: vscodeManifest.version,
          markless: {
            head: marklessHead,
            source: "packages/vitest-browser/browser/fixtures/arm-try-events.tsrx",
            sourceSha256,
            beforeFingerprint: before,
            afterFingerprint: after,
            externalWrites: false,
          },
          extension: {
            id: "thejackshelton.oxc-tsrx-vscode",
            frameworkLanguageId: "markless-tsrx",
            nativeServer: "target/release/oxc-tsrx lsp",
            bundledClient: true,
          },
          assertions: {
            automaticActivation: true,
            liveAuthoredDiagnostics: true,
            configurationLifecycle: true,
            realFormatOnSave: true,
            safeCodeAction: true,
            diagnosticsUpdatedAfterAction: true,
          },
        },
        null,
        2,
      )}\n`,
    );
  }
}

await runInstallOnlyDiscoverySession();

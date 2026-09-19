import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";
import { scriptNode } from "../helpers/script-node.mjs";

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
const harness = join(root, "tests/packaging/vscode-harness");
// VS Code 1.136 renamed the app binary from `Electron` to `Code`; older builds
// still ship the former. Either is the real editor, so take whichever exists.
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  ["Code", "Electron"]
    .map((name) => `/Applications/Visual Studio Code.app/Contents/MacOS/${name}`)
    .find((candidate) => existsSync(candidate)) ??
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const cli =
  process.env.VSCODE_CLI_PATH ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

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
  throw new Error(`unsupported installed-VSIX host ${process.platform}-${process.arch}`);
}

function externalFingerprint() {
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: markless });
  const diff = execFileSync("git", ["diff", "--binary"], { cwd: markless });
  return createHash("sha256").update(status).update(diff).digest("hex");
}

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  for (const key of [
    "OXC_TSRX_LSP_BIN",
    "OXC_TSRX_LINT_BIN",
    "OXC_TSRX_FORMAT_BIN",
    "OXLINT_TSGOLINT_PATH",
    "OXC_TSRX_TSGOLINT_VERSION",
  ]) {
    delete environment[key];
  }
  return environment;
}

const before = externalFingerprint();
const workspace = await mkdtemp(join(tmpdir(), "oxc-tsrx-installed-vscode-"));
const artifacts = join(workspace, "artifacts");
const extensionDirectory = await realpath(await mkdir(join(workspace, "extensions"), { recursive: true }).then(() => join(workspace, "extensions")));
const userDirectory = join(workspace, "user");
await mkdir(join(workspace, ".vscode"), { recursive: true });
await mkdir(artifacts, { recursive: true });
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
  `${JSON.stringify({ rules: { "no-debugger": "error", "no-var": "error" } }, null, 2)}\n`,
);
await writeFile(
  join(workspace, ".oxfmtrc.json"),
  `${JSON.stringify({ semi: true, singleQuote: true }, null, 2)}\n`,
);
await writeFile(
  join(workspace, ".vscode/settings.json"),
  `${JSON.stringify(
    {
      "[markless-tsrx]": {
        "editor.defaultFormatter": "thejackshelton.oxc-tsrx-vscode",
        "editor.formatOnSave": true,
      },
    },
    null,
    2,
  )}\n`,
);

const packageResult = execFileSync(
  scriptNode(),
  [
    join(root, "scripts/package-vscode.ts"),
    "--target",
    hostTarget(),
    "--lsp-bin",
    join(root, "target/release", process.platform === "win32" ? "oxc-tsrx.exe" : "oxc-tsrx"),
    "--out-dir",
    artifacts,
  ],
  { cwd: root, encoding: "utf8" },
);
const packaged = JSON.parse(packageResult);
execFileSync(
  cli,
  [
    "--install-extension",
    packaged.vsix,
    "--extensions-dir",
    extensionDirectory,
    "--user-data-dir",
    userDirectory,
    "--force",
  ],
  { cwd: workspace, env: cleanEnvironment(), stdio: "pipe" },
);
const installed = (await readdir(extensionDirectory)).filter((name) =>
  name.startsWith("thejackshelton.oxc-tsrx-vscode-"),
);
assert.equal(installed.length, 1, JSON.stringify(await readdir(extensionDirectory)));

let passed = false;
try {
  await runTests({
    vscodeExecutablePath: executable,
    reuseMachineInstall: false,
    extensionDevelopmentPath: [harness, marklessExtension],
    extensionTestsPath: join(root, "tests/packaging/vscode-installed-suite.cjs"),
    extensionTestsEnv: cleanEnvironment({
      OXC_TSRX_EDITOR_FILE: sourcePath,
      OXC_TSRX_INSTALLED_EXTENSIONS_DIR: extensionDirectory,
    }),
    launchArgs: [
      workspace,
      `--extensions-dir=${extensionDirectory}`,
      `--user-data-dir=${userDirectory}`,
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
    await writeFile(
      join(root, "tests/packaging/installed-vsix-report.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          recordedAt: new Date().toISOString(),
          target: hostTarget(),
          vscodeTarget: packaged.vscodeTarget,
          extensionId: packaged.extensionId,
          installedDirectory: installed[0],
          embeddedLspSha256: packaged.lspSha256,
          environmentOverrides: false,
          markless: {
            source: "packages/vitest-browser/browser/fixtures/arm-try-events.tsrx",
            beforeFingerprint: before,
            afterFingerprint: after,
            externalWrites: false,
          },
          assertions: {
            installedFromVsix: true,
            embeddedServer: true,
            automaticActivation: true,
            exactAuthoredDiagnostics: true,
            realFormatOnSave: true,
            safeCodeAction: true,
          },
        },
        null,
        2,
      )}\n`,
    );
    await rm(workspace, { recursive: true, force: true });
  }
}

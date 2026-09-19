import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const root = resolve(import.meta.dirname, "../..");
const workspace = join(root, "examples/vscode-lints");
const sourcePath = join(workspace, "LintDemo.tsrx");
const officialExtension = join(
  process.env.HOME,
  ".vscode/extensions/oxc.oxc-vscode-1.58.0",
);
// VS Code 1.136 renamed the app binary from `Electron` to `Code`; older builds
// still ship the former. Either is the real editor, so take whichever exists.
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  ["Code", "Electron"]
    .map((name) => `/Applications/Visual Studio Code.app/Contents/MacOS/${name}`)
    .find((candidate) => existsSync(candidate)) ??
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const state = await mkdtemp(join(tmpdir(), "official-oxc-tsrx-js-plugins-"));

await runTests({
  vscodeExecutablePath: executable,
  reuseMachineInstall: false,
  extensionDevelopmentPath: officialExtension,
  extensionTestsPath: join(root, "tests/editor/official-oxc-js-plugins-suite.cjs"),
  extensionTestsEnv: {
    ...process.env,
    OXC_TSRX_EDITOR_FILE: sourcePath,
  },
  launchArgs: [
    workspace,
    `--extensions-dir=${join(state, "extensions")}`,
    `--user-data-dir=${join(state, "user")}`,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
  ],
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const packageRoot = join(root, "packages/vscode");

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
      else resolveRun({ stdout, stderr });
    });
  });
}

test("editor package is additive, workspace-native, bundled, and VSIX-packaged", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "oxc-tsrx-vscode");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
  assert.ok(manifest.activationEvents.includes("onLanguage:markless-tsrx"));
  assert.ok(manifest.activationEvents.includes("workspaceContains:**/*.tsrx"));
  assert.equal(manifest.contributes.languages, undefined);
  assert.equal(manifest.main, "./dist/extension.bundle.cjs");
  // Generalising activation is a separate, contentious change; this slice
  // generalises resolution only.
  assert.deepEqual(manifest.activationEvents, [
    "onLanguage:markless-tsrx",
    "onLanguage:ripple",
    "onLanguage:tsrx",
    "workspaceContains:**/*.tsrx",
  ]);
  assert.equal(manifest.dependencies["@tsrx/oxc"], "0.9.0");

  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-vsix-"));
  const output = join(directory, "oxc-tsrx-vscode.vsix");
  await run(join(root, "node_modules/.bin/vsce"), [
    "package",
    "--no-dependencies",
    "--out",
    output,
  ], { cwd: packageRoot });
  const { stdout: listing } = await run("unzip", ["-Z1", output]);
  assert.match(listing, /extension\/dist\/extension\.bundle\.cjs/);
  assert.match(listing, /extension\/package\.json/);
  assert.match(listing, /extension\/README\.md/i);
  assert.doesNotMatch(listing, /node_modules/);
});

test("the extension host is provider-driven and never routes ordinary documents", async () => {
  const [host, decisions] = await Promise.all([
    readFile(join(packageRoot, "src/extension.cts"), "utf8"),
    readFile(join(packageRoot, "src/provider-client.cts"), "utf8"),
  ]);

  // Resolution comes from the shipped provider protocol, per workspace folder.
  assert.match(host, /require\("@tsrx\/oxc\/provider-resolve"\)/u);
  assert.match(host, /require\("\.\/provider-client\.cts"\)/u);
  assert.match(host, /discoverWorkspaceFolders/u);
  assert.doesNotMatch(
    host,
    /documentSelector:\s*\[\{[^}]*\*\*\/\*\.tsrx/u,
    "the document selector must come from the index, not a literal",
  );
  assert.doesNotMatch(host, /node_modules[/\\]\.bin/u);
  assert.doesNotMatch(host, /process\.env\.PATH/u);
  assert.doesNotMatch(host, /\bsetup\b/u, "the editor must never invoke the compatibility bridge");

  // The decision module is the transposable half and stays vendor-neutral.
  assert.doesNotMatch(decisions, /tsrx/iu);
  assert.doesNotMatch(decisions, /require\(\s*["']vscode/u);
  assert.doesNotMatch(decisions, /child_process/u);

  // Both files are part of the committed bundle the VSIX ships.
  const bundle = await readFile(join(packageRoot, "dist/extension.bundle.cjs"), "utf8");
  for (const region of ["packages/vscode/src/extension.cts", "packages/vscode/src/provider-client.cts"]) {
    assert.ok(bundle.includes(`//#region ${region}`), region);
  }
  assert.ok(bundle.includes("//#region packages/toolchain/dist/provider-resolve.js"));
  assert.equal(
    /require\(["']@tsrx\/oxc\/provider-resolve["']\)/u.test(bundle),
    false,
    "the resolver must be bundled, not resolved from the user's workspace at runtime",
  );
});

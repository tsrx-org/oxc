import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const version = "0.8.0";
const revision = "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40";

function run(executable, args) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(executable, args, { cwd: root, timeout: 2000 }, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
      else resolveRun({ stdout, stderr });
    });
  });
}

const executable = join(
  root,
  "target/release",
  process.platform === "win32" ? "oxc-tsrx.exe" : "oxc-tsrx",
);

// One multi-call binary answers to all three tool identities. Each is reachable
// two ways, and both have to keep working: an explicit subcommand, and `argv[0]`
// for anything that still execs the old file name.
const tools = [
  { name: "oxc-tsrx", subcommand: [] },
  { name: "oxc-tsrx-fmt", subcommand: ["fmt"] },
  { name: "oxc-tsrx-lsp", subcommand: ["lsp"] },
];

for (const tool of tools) {
  test(`${tool.name} exposes the package and exact canonical OXC revision`, async () => {
    const { stdout, stderr } = await run(executable, [...tool.subcommand, "--version"]);
    assert.equal(stderr, "");
    assert.equal(stdout, `${tool.name} ${version} (OXC ${revision})\n`);
  });
}

test("the explicit lint subcommand selects the same tool as no subcommand", async () => {
  const { stdout, stderr } = await run(executable, ["lint", "--version"]);
  assert.equal(stderr, "");
  assert.equal(stdout, `oxc-tsrx ${version} (OXC ${revision})\n`);
});

test("argv[0] selects a tool for anything that still execs an old binary name", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows shims resolve to the real file name; the subcommand form covers it");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-argv0-"));
  try {
    for (const tool of tools) {
      const alias = join(directory, tool.name);
      await symlink(executable, alias);
      const { stdout, stderr } = await run(alias, ["--version"]);
      assert.equal(stderr, "");
      assert.equal(stdout, `${tool.name} ${version} (OXC ${revision})\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

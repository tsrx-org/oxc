// scripts/fetch-docs-wasm.ts installs the demo engine for the one build that
// cannot compile it (oxc.tsrx.dev, built on Vercel's image with no cargo). This
// file pins the single decision that build gets wrong most expensively: what to
// do when website-oxc/wasm-pin.json describes an engine older than the checkout.
//
// It used to install nothing. That is not a rare case -- the pin goes stale on
// every merge touching crates/tsrx_* or docs/tools/demo-wasm, because the
// workflow's pin-refresh push is rejected by branch protection -- and it took
// the live playground down to mode:"static" with nothing red anywhere to say
// so. The policy now is: a stale pin still installs, loudly; only bytes that
// fail their sha256 or byte length are refused.
//
// The script is exercised as the process the site build actually runs, not by
// importing pieces of it, because the behaviour under test is exactly its exit
// code and what it leaves on disk. To keep that honest without touching this
// repository's real pin or dist directory, each case builds a throwaway root:
//
//   <tmp>/package.json                 type: module, so node reads the script as ESM
//   <tmp>/scripts/fetch-docs-wasm.ts   a copy -- the script derives its root from here
//   <tmp>/node_modules/tinyglobby      symlink, the one dependency it imports
//   <tmp>/rust-toolchain.toml + docs/tools/demo-wasm/...   stand-in engine sources
//   <tmp>/website-oxc/wasm-pin.json    doctored per case
//
// and serves the release bytes from a loopback HTTP server through
// OXC_TSRX_WASM_RELEASE_BASE, so no case reaches the network.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const scriptSource = join(repoRoot, "scripts", "fetch-docs-wasm.ts");

// Stand-ins for the two published files. Their content is irrelevant -- the
// script only ever compares bytes to the pin -- but they must differ from each
// other so a swap could not pass.
const engineBytes = {
  "demo-wasm.wasm": Buffer.from("\0asm\0\0\0 not a real engine, just bytes to pin"),
  "wasi-worker-browser.mjs": Buffer.from("// stand-in worker\nexport {}\n"),
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The script imports tinyglobby to hash the engine sources. Resolving it here
// rather than assuming a layout keeps this test working under pnpm's symlinked
// node_modules and under a flat one.
function tinyglobbyPackageDir() {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve("tinyglobby"));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    assert.notEqual(parent, dir, "tinyglobby resolved outside any package");
    dir = parent;
  }
  return dir;
}

async function makeFixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "stale-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(scriptSource, join(root, "scripts", "fetch-docs-wasm.ts"));
  await writeFile(join(root, "package.json"), '{ "type": "module" }\n');

  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(tinyglobbyPackageDir(), join(root, "node_modules", "tinyglobby"), "dir");

  // Enough of the hashed input set to give computeInputsHash something real to
  // hash; the patterns it globs are crates/tsrx_*, docs/tools/demo-wasm and the
  // toolchain file.
  await mkdir(join(root, "docs", "tools", "demo-wasm", "src"), { recursive: true });
  await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n');
  await writeFile(join(root, "docs", "tools", "demo-wasm", "src", "lib.rs"), "// engine source\n");

  return root;
}

async function writePin(root, overrides = {}) {
  const pin = {
    tag: "wasm-demo-latest",
    inputsHash: "0".repeat(64),
    sourceCommit: "4575dc4f20ea6a88347596be81f68a38c6df4f2d",
    wasm: {
      sha256: sha256(engineBytes["demo-wasm.wasm"]),
      bytes: engineBytes["demo-wasm.wasm"].length,
    },
    worker: {
      sha256: sha256(engineBytes["wasi-worker-browser.mjs"]),
      bytes: engineBytes["wasi-worker-browser.mjs"].length,
    },
    ...overrides,
  };
  await mkdir(join(root, "website-oxc"), { recursive: true });
  await writeFile(join(root, "website-oxc", "wasm-pin.json"), `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

// One release, served from loopback. Anything the script asks for that is not
// <tag>/<asset name> is a 404, which is also what the real release gives.
async function serveRelease(t, { tag = "wasm-demo-latest" } = {}) {
  const requested = [];
  const server = createServer((request, response) => {
    requested.push(request.url);
    const bytes = engineBytes[request.url.replace(`/${tag}/`, "")];
    if (!request.url.startsWith(`/${tag}/`) || !bytes) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not Found");
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(bytes);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return { base: `http://127.0.0.1:${server.address().port}`, requested };
}

function runScript(root, { args = [], base } = {}) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [join(root, "scripts", "fetch-docs-wasm.ts"), ...args],
      {
        cwd: root,
        env: { ...process.env, OXC_TSRX_WASM_RELEASE_BASE: base ?? "http://127.0.0.1:1/nowhere" },
      },
      (error, stdout, stderr) => {
        done({ code: error?.code ?? 0, stdout, stderr, output: `${stdout}${stderr}` });
      },
    );
  });
}

function installedPath(root, name) {
  return join(root, "docs", "tools", "demo-wasm", "dist", name);
}

async function assertEngineInstalled(root) {
  for (const [name, bytes] of Object.entries(engineBytes)) {
    const onDisk = await readFile(installedPath(root, name));
    assert.deepEqual(onDisk, bytes, `${name} was not installed byte for byte`);
  }
}

function assertNothingInstalled(root) {
  for (const name of Object.keys(engineBytes)) {
    assert.equal(existsSync(installedPath(root, name)), false, `${name} must not be installed`);
  }
}

test("a stale pin installs the pinned engine and says so loudly", async (t) => {
  const root = await makeFixtureRoot(t);
  // The default fixture hash is deliberately wrong for this tree, which is the
  // shape of every post-merge checkout before the pin refresh lands.
  await writePin(root);
  const release = await serveRelease(t);

  const run = await runScript(root, { base: release.base });

  assert.equal(run.code, 0, `exit 0 or the Vercel build's && chain fails: ${run.output}`);
  await assertEngineInstalled(root);
  assert.match(run.output, /WARNING -- stale pin/);
  // Named precisely enough that a reader knows which engine is live and how
  // far behind it is, per the owner's report of the silent outage.
  assert.match(run.output, /engine built from 4575dc4/);
  assert.match(run.output, /checkout is [0-9a-f]{12}/);
  assert.match(run.output, /demo engine in place from wasm-demo-latest/);
  assert.doesNotMatch(run.output, /no demo engine/);
  assert.doesNotMatch(run.output, /static preview/);
});

test("a stale pin whose bytes do not match their sha256 installs nothing", async (t) => {
  const root = await makeFixtureRoot(t);
  await writePin(root, { wasm: { sha256: "b".repeat(64), bytes: 41 } });
  const release = await serveRelease(t);

  const run = await runScript(root, { base: release.base });

  assert.equal(run.code, 0, `a refusal is still a green build: ${run.output}`);
  assertNothingInstalled(root);
  assert.match(run.output, /no demo engine/);
  assert.match(run.output, /static preview/);
  assert.doesNotMatch(run.output, /demo engine in place/);
});

test("a fresh pin whose bytes are the wrong length installs nothing", async (t) => {
  const root = await makeFixtureRoot(t);
  const inputsHash = (await runScript(root, { args: ["--print-inputs-hash"] })).stdout.trim();
  await writePin(root, {
    inputsHash,
    wasm: { sha256: sha256(engineBytes["demo-wasm.wasm"]), bytes: 999_999 },
  });
  const release = await serveRelease(t);

  const run = await runScript(root, { base: release.base });

  assert.equal(run.code, 0);
  assertNothingInstalled(root);
  assert.match(run.output, /bytes, the pin says 999999/);
});

test("a pin whose release will not serve the bytes installs nothing", async (t) => {
  const root = await makeFixtureRoot(t);
  await writePin(root, { tag: "wasm-demo-missing" });
  const release = await serveRelease(t);

  const run = await runScript(root, { base: release.base });

  assert.equal(run.code, 0);
  assertNothingInstalled(root);
  assert.match(run.output, /responded 404/);
});

test("a matching pin installs with no staleness warning at all", async (t) => {
  const root = await makeFixtureRoot(t);
  const printed = await runScript(root, { args: ["--print-inputs-hash"] });
  // --print-inputs-hash is the workflow's half of the contract: one hash on
  // stdout, nothing else, exit 0.
  assert.equal(printed.code, 0, printed.output);
  assert.match(printed.stdout, /^[0-9a-f]{64}\n$/);

  await writePin(root, { inputsHash: printed.stdout.trim() });
  const release = await serveRelease(t);

  const run = await runScript(root, { base: release.base });

  assert.equal(run.code, 0, run.output);
  await assertEngineInstalled(root);
  assert.doesNotMatch(run.output, /WARNING/);
  assert.match(run.output, /demo engine in place from wasm-demo-latest/);
});

test("an engine whose sources cannot be hashed still installs, flagged as unverified", async (t) => {
  const root = await makeFixtureRoot(t);
  await writePin(root);
  // No files match the hash patterns any more, so computeInputsHash throws.
  // Before the fallback that was a refusal too, which meant a hashing accident
  // could take the demo down as surely as a stale pin.
  await rm(join(root, "rust-toolchain.toml"));
  await rm(join(root, "docs", "tools", "demo-wasm"), { recursive: true });
  const release = await serveRelease(t);

  const run = await runScript(root, { base: release.base });

  assert.equal(run.code, 0, run.output);
  await assertEngineInstalled(root);
  assert.match(run.output, /WARNING -- freshness unknown/);
});

test("the release URL is built from the pinned tag and asset names", async (t) => {
  const root = await makeFixtureRoot(t);
  await writePin(root);
  const release = await serveRelease(t);

  await runScript(root, { base: release.base });

  assert.deepEqual(release.requested, [
    "/wasm-demo-latest/demo-wasm.wasm",
    "/wasm-demo-latest/wasi-worker-browser.mjs",
  ]);
});

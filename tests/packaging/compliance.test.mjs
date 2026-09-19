import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveNpmInvocation } from "../helpers/npm-invocation.mjs";
import { scriptNode } from "../helpers/script-node.mjs";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
const root = resolve(import.meta.dirname, "../..");
const revision = "5a6e37e5cf895143a5b34050c50109c46e2ae96a";
const legalFiles = [
  "README.md",
  "RUST_DEPENDENCIES.md",
  "allowed-rust-license-expressions.json",
  "rust-dependencies.json",
  "oxc/LICENSE",
  "oxc/PROVENANCE.json",
  "oxc/THIRD-PARTY-LICENSE",
];

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
  throw new Error(`unsupported compliance-test host ${process.platform}-${process.arch}`);
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
        else resolveRun({ stdout, stderr });
      },
    );
  });
}

function readZip(path) {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError) return rejectZip(openError);
      const entries = new Map();
      zip.on("error", rejectZip);
      zip.on("end", () => resolveZip(entries));
      zip.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return rejectZip(streamError);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", rejectZip);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function assertLegalTree(read) {
  for (const path of legalFiles) {
    const [expected, actual] = await Promise.all([
      readFile(join(root, "licenses", path)),
      read(path),
    ]);
    assert.equal(sha256(actual), sha256(expected), `legal file drifted in artifact: ${path}`);
  }
  const inventory = JSON.parse(await read("rust-dependencies.json"));
  assert.equal(inventory.oxcRevision, revision);
  assert.equal(inventory.packageCount, inventory.packages.length);
  assert.ok(inventory.packageCount > 150);
  assert.ok(inventory.packages.filter((dependency) => dependency.sourceKind === "oxc-git").length >= 12);
  const selfCell = inventory.packages.find((dependency) => dependency.name === "self_cell");
  assert.deepEqual(
    {
      expression: selfCell?.license,
      selected: selfCell?.selectedDistributionLicense,
    },
    {
      expression: "Apache-2.0 OR GPL-2.0-only",
      selected: "Apache-2.0",
    },
  );
  const provenance = JSON.parse(await read("oxc/PROVENANCE.json"));
  assert.equal(provenance.revision, revision);
  assert.equal(provenance.files.LICENSE.sha256, sha256(await read("oxc/LICENSE")));
  assert.equal(
    provenance.files["THIRD-PARTY-LICENSE"].sha256,
    sha256(await read("oxc/THIRD-PARTY-LICENSE")),
  );
}

test("locked Rust license inventory and canonical OXC legal files are deterministic", async () => {
  const result = await run(scriptNode(), [
    "scripts/generate-rust-license-inventory.ts",
    "--check",
  ]);
  assert.match(result.stdout, /^verified \d+ locked shipping dependency licenses\n$/u);
  assert.equal(result.stderr, "");
});

test("every npm package region in the Rolldown extension bundle has its exact license text", async () => {
  const result = await run(scriptNode(), [
    "scripts/generate-vscode-license-inventory.ts",
    "--check",
  ]);
  assert.match(result.stdout, /^verified \d+ bundled VS Code dependency licenses\n$/u);
  assert.equal(result.stderr, "");

  const [bundle, inventory] = await Promise.all([
    readFile(join(root, "packages/vscode/dist/extension.bundle.cjs"), "utf8"),
    readFile(join(root, "packages/vscode/licenses/bundle-dependencies.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const regions = new Set();
  for (const match of bundle.matchAll(/^\/\/#region (\S+)/gmu)) {
    const modulePath = match[1];
    const marker = "node_modules/";
    const markerIndex = modulePath.lastIndexOf(marker);
    if (markerIndex === -1) continue;
    const prefix = modulePath.slice(0, markerIndex + marker.length);
    const segments = modulePath.slice(markerIndex + marker.length).split("/");
    const name = segments[0].startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
    regions.add(`${prefix}${name}`);
  }
  assert.deepEqual(
    [...regions].sort(),
    inventory.packages.map((dependency) => dependency.installPath).sort(),
  );
  assert.equal(inventory.packageCount, 12);
  assert.equal(
    inventory.packages.find((dependency) => dependency.name === "minimatch")?.license,
    "BlueOak-1.0.0",
  );
  assert.equal(
    inventory.packages.find((dependency) => dependency.name === "semver")?.license,
    "ISC",
  );
  for (const dependency of inventory.packages) {
    assert.ok(dependency.legalTexts.length >= 1);
    for (const legalText of dependency.legalTexts) {
      const text = await readFile(join(root, "packages/vscode/licenses", legalText.path));
      assert.equal(sha256(text), legalText.sha256, dependency.name);
    }
  }
});

test("native npm artifact ships the exact legal tree and independent-project notice", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "oxc-tsrx-compliance-native-"));
  const packaged = JSON.parse(
    (
      await run(scriptNode(), [
        "scripts/package-native.ts",
        "--allow-missing-parser-addon",
        "--target",
        hostTarget(),
        "--bin-dir",
        "target/release",
        "--out-dir",
        artifacts,
      ])
    ).stdout,
  );
  const consumer = await mkdtemp(join(tmpdir(), "oxc-tsrx-compliance-consumer-"));
  // npm is reached the way the product reaches it: its manifest-declared
  // JavaScript entry, run by Node. Spelling it `npm.cmd` on Windows is not just
  // the shim this repository's boundary forbids, it cannot run at all, because
  // Node refuses to spawn a `.cmd` file without `shell: true` and fails the
  // whole test with `spawn EINVAL`.
  const npmInvocation = resolveNpmInvocation([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    packaged.tarball,
  ]);
  await run(npmInvocation.executable, npmInvocation.args, {
    cwd: consumer,
    env: { ...process.env, npm_config_cache: join(consumer, ".npm-cache") },
  });
  const packageRoot = join(consumer, "node_modules", ...packaged.packageName.split("/"));
  await assertLegalTree((path) => readFile(join(packageRoot, "licenses", path)));
  const notice = await readFile(join(packageRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notice, new RegExp(revision, "u"));
  assert.match(notice, /independent community integration/u);
  assert.match(notice, /not affiliated with or endorsed/u);
});

test("platform VSIX ships the exact native legal tree", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "oxc-tsrx-compliance-vsix-"));
  const executable = join(
    root,
    "target/release",
    process.platform === "win32" ? "oxc-tsrx.exe" : "oxc-tsrx",
  );
  const packaged = JSON.parse(
    (
      await run(scriptNode(), [
        "scripts/package-vscode.ts",
        "--target",
        hostTarget(),
        "--lsp-bin",
        executable,
        "--out-dir",
        artifacts,
      ])
    ).stdout,
  );
  const entries = await readZip(packaged.vsix);
  const prefix = "extension/dist/native/licenses/";
  await assertLegalTree(async (path) => {
    const contents = entries.get(`${prefix}${path}`);
    assert.ok(contents, `VSIX is missing ${prefix}${path}`);
    return contents;
  });
  const notice = entries.get("extension/THIRD_PARTY_NOTICES.md")?.toString("utf8");
  assert.match(notice, /generated locked Rust dependency license inventory/u);
  assert.match(notice, /not affiliated with or endorsed/u);

  const bundleInventoryPath = "extension/licenses/bundle-dependencies.json";
  assert.ok(entries.has(bundleInventoryPath));
  assert.ok(entries.has("extension/licenses/BUNDLE_DEPENDENCIES.md"));
  const bundleInventory = JSON.parse(entries.get(bundleInventoryPath));
  const bundledClient = entries.get("extension/dist/extension.bundle.cjs");
  assert.ok(bundledClient, "VSIX is missing the bundled extension client");
  assert.equal(sha256(bundledClient), bundleInventory.bundleSha256);
  assert.equal(bundleInventory.packageCount, 12);
  for (const dependency of bundleInventory.packages) {
    for (const legalText of dependency.legalTexts) {
      const path = `extension/licenses/${legalText.path}`;
      const contents = entries.get(path);
      assert.ok(contents, `VSIX is missing ${path}`);
      assert.equal(sha256(contents), legalText.sha256);
    }
  }
});

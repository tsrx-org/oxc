import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_VSIX_LIMITS, readVsixEntries } from "../../scripts/vsix-archive.ts";
import { scriptNode } from "../helpers/script-node.mjs";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
const root = resolve(import.meta.dirname, "../..");

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
  throw new Error(`unsupported VSIX-test host ${process.platform}-${process.arch}`);
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(executable, args, { cwd: options.cwd ?? root }, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
      else resolveRun({ stdout, stderr });
    });
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

test("platform VSIX embeds exactly the matching native language server and notices", async () => {
  const output = await mkdtemp(join(tmpdir(), "oxc-tsrx-vsix-artifacts-"));
  const executable = join(
    root,
    "target/release",
    process.platform === "win32" ? "oxc-tsrx.exe" : "oxc-tsrx",
  );
  const result = await run(scriptNode(), [
    "scripts/package-vscode.ts",
    "--target",
    hostTarget(),
    "--lsp-bin",
    executable,
    "--out-dir",
    output,
  ]);
  const packaged = JSON.parse(result.stdout);
  assert.equal(packaged.target, hostTarget());
  assert.equal(packaged.extensionId, "thejackshelton.oxc-tsrx-vscode");
  assert.equal(packaged.vsixVerification.extensionId, packaged.extensionId);
  assert.equal(packaged.vsixVerification.version, "0.8.0");
  assert.equal(packaged.vsixVerification.target, packaged.target);
  assert.equal(packaged.vsixVerification.vscodeTarget, packaged.vscodeTarget);
  assert.equal(packaged.vsixVerification.nativeLspSha256, packaged.lspSha256);
  assert.equal(packaged.vsixVerification.nativeLspBytes, packaged.lspBytes);
  assert.ok((await stat(packaged.vsix)).size <= 12 * 1024 * 1024);
  await assert.rejects(
    readVsixEntries(packaged.vsix, { ...DEFAULT_VSIX_LIMITS, maxEntries: 1 }),
    /entry verification limit/iu,
  );

  const entries = await readZip(packaged.vsix);
  const bundledClient = entries.get("extension/dist/extension.bundle.cjs");
  const bundledInventoryContents = entries.get("extension/licenses/bundle-dependencies.json");
  const bundledReport = entries.get("extension/licenses/BUNDLE_DEPENDENCIES.md");
  assert.ok(bundledClient);
  assert.ok(bundledInventoryContents);
  assert.ok(bundledReport);
  const bundledInventory = JSON.parse(bundledInventoryContents);
  assert.equal(
    packaged.vsixVerification.bundleSha256,
    createHash("sha256").update(bundledClient).digest("hex"),
  );
  assert.equal(packaged.vsixVerification.bundleSha256, bundledInventory.bundleSha256);
  assert.equal(
    packaged.vsixVerification.inventorySha256,
    createHash("sha256").update(bundledInventoryContents).digest("hex"),
  );
  assert.equal(
    packaged.vsixVerification.reportSha256,
    createHash("sha256").update(bundledReport).digest("hex"),
  );
  assert.equal(packaged.vsixVerification.packageCount, bundledInventory.packageCount);
  assert.equal(
    packaged.vsixVerification.legalTextCount,
    bundledInventory.packages.reduce(
      (count, dependency) => count + dependency.legalTexts.length,
      0,
    ),
  );
  const suffix = process.platform === "win32" ? ".exe" : "";
  // One multi-call executable, started with the `lsp` subcommand, replaced the
  // three separate release binaries. The VSIX embeds that one file and nothing
  // under the retired per-tool names.
  assert.equal(packaged.vsixVerification.nativeBinary, `oxc-tsrx${suffix}`);
  const nativePath = `extension/dist/native/oxc-tsrx${suffix}`;
  assert.ok(entries.has(nativePath));
  assert.ok(entries.has("extension/dist/native/manifest.json"));
  assert.ok(entries.has("extension/dist/native/LICENSE"));
  assert.ok(entries.has("extension/dist/native/THIRD_PARTY_NOTICES.md"));
  assert.ok(entries.has("extension/THIRD_PARTY_NOTICES.md"));
  assert.equal(
    [...entries.keys()].some((name) => name.includes("node_modules/")),
    false,
  );
  assert.equal(
    [...entries.keys()].some((name) => /dist\/native\/oxc-tsrx-(?:fmt|lsp)/.test(name)),
    false,
  );
  assert.deepEqual(
    [...entries.keys()].filter((name) => /dist\/native\/oxc-tsrx[^/]*$/.test(name)),
    [nativePath],
  );
  assert.match(
    entries.get("extension.vsixmanifest").toString("utf8"),
    new RegExp(`TargetPlatform="${packaged.vscodeTarget}"`),
  );

  const packageManifest = JSON.parse(entries.get("extension/package.json"));
  for (const setting of [
    "oxcTsrx.typeAware",
    "oxcTsrx.typeCheck",
    "oxcTsrx.lint.configPath",
    "oxcTsrx.format.configPath",
  ]) {
    assert.equal(packageManifest.contributes.configuration.properties[setting].scope, "resource");
  }

  const manifest = JSON.parse(entries.get("extension/dist/native/manifest.json"));
  assert.equal(manifest.target, hostTarget());
  assert.equal(manifest.oxcRevision, "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40");
  assert.equal(manifest.binary, `oxc-tsrx${suffix}`);
  const sourceHash = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  const packagedHash = createHash("sha256").update(entries.get(nativePath)).digest("hex");
  assert.equal(manifest.sha256, sourceHash);
  assert.equal(packagedHash, sourceHash);
});

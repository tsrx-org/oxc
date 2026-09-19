import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { NATIVE_TARGETS, nativePackageName } from "../../packages/toolchain/dist/native-targets.js";
import {
  DEFAULT_VSIX_LIMITS,
  readVsixEntries,
  verifyAndPromoteVsix,
  verifyVsixEntries,
} from "../../scripts/vsix-archive.ts";
import { scriptNode } from "../helpers/script-node.mjs";

const require = createRequire(import.meta.url);
const { ZipFile } = require("yazl");

const root = resolve(import.meta.dirname, "../..");
const bundlePath = "extension/dist/extension.bundle.cjs";
const inventoryPath = "extension/licenses/bundle-dependencies.json";
const reportPath = "extension/licenses/BUNDLE_DEPENDENCIES.md";
const packagePath = "extension/package.json";
const vsixManifestPath = "extension.vsixmanifest";
const nativeManifestPath = "extension/dist/native/manifest.json";
const nativeBinaryPath = "extension/dist/native/oxc-tsrx";
const target = "aarch64-apple-darwin";
const vscodeTarget = "darwin-arm64";
const oxcRevision = "5a6e37e5cf895143a5b34050c50109c46e2ae96a";

const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

function run(executable, args) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(executable, args, { cwd: root }, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
      else resolveRun({ stdout, stderr });
    });
  });
}

async function createZip(entries) {
  const zip = new ZipFile();
  const chunks = [];
  const archive = new Promise((resolveArchive, rejectArchive) => {
    zip.on("error", rejectArchive);
    zip.outputStream.on("error", rejectArchive);
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolveArchive(Buffer.concat(chunks)));
  });
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.contents), entry.path, {
      compress: entry.compress ?? true,
      mtime: new Date("2020-01-01T00:00:00.000Z"),
    });
  }
  zip.end();
  return archive;
}

async function writeZip(path, entries) {
  const archive = await createZip(entries);
  await writeFile(path, archive);
  return archive;
}

function replaceAllArchiveBytes(archive, source, replacement) {
  const sourceBytes = Buffer.from(source);
  const replacementBytes = Buffer.from(replacement);
  assert.equal(sourceBytes.length, replacementBytes.length, "ZIP patch must preserve byte length");
  const changed = Buffer.from(archive);
  let count = 0;
  let offset = 0;
  while ((offset = changed.indexOf(sourceBytes, offset)) !== -1) {
    replacementBytes.copy(changed, offset);
    offset += replacementBytes.length;
    count += 1;
  }
  assert.equal(count, 2, "expected one local and one central ZIP filename");
  return changed;
}

function markFirstEntryEncrypted(archive) {
  const changed = Buffer.from(archive);
  const records = [
    { signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]), flagsOffset: 6 },
    { signature: Buffer.from([0x50, 0x4b, 0x01, 0x02]), flagsOffset: 8 },
  ];
  for (const { signature, flagsOffset } of records) {
    const recordOffset = changed.indexOf(signature);
    assert.notEqual(recordOffset, -1, "expected ZIP header while setting encryption flag");
    const flags = changed.readUInt16LE(recordOffset + flagsOffset);
    changed.writeUInt16LE(flags | 0x1, recordOffset + flagsOffset);
  }
  return changed;
}

function corruptFirstEntryData(archive) {
  const changed = Buffer.from(archive);
  const localSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const recordOffset = changed.indexOf(localSignature);
  assert.notEqual(recordOffset, -1, "expected ZIP local header");
  const compressedBytes = changed.readUInt32LE(recordOffset + 18);
  const fileNameBytes = changed.readUInt16LE(recordOffset + 26);
  const extraBytes = changed.readUInt16LE(recordOffset + 28);
  assert.ok(compressedBytes > 0, "expected compressed ZIP entry data");
  const dataOffset = recordOffset + 30 + fileNameBytes + extraBytes;
  changed.fill(0xff, dataOffset, dataOffset + compressedBytes);
  return changed;
}

const limits = (overrides) => ({ ...DEFAULT_VSIX_LIMITS, ...overrides });

async function validFixture() {
  const [bundle, inventoryContents, report, packageContents] = await Promise.all([
    readFile(join(root, "packages/vscode/dist/extension.bundle.cjs")),
    readFile(join(root, "packages/vscode/licenses/bundle-dependencies.json")),
    readFile(join(root, "packages/vscode/licenses/BUNDLE_DEPENDENCIES.md")),
    readFile(join(root, "packages/vscode/package.json")),
  ]);
  const packageManifest = JSON.parse(packageContents);
  const nativeBinary = Buffer.from("fixture native language server");
  const nativeManifest = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        extensionVersion: packageManifest.version,
        target,
        vscodeTarget,
        binary: "oxc-tsrx",
        bytes: nativeBinary.length,
        sha256: sha256(nativeBinary),
        oxcRevision,
        rustc: "rustc fixture",
      },
      null,
      2,
    )}\n`,
  );
  const vsixManifest = Buffer.from(
    `<PackageManifest><Metadata><Identity Id="${packageManifest.name}" Version="${packageManifest.version}" Publisher="${packageManifest.publisher}" TargetPlatform="${vscodeTarget}"/></Metadata></PackageManifest>`,
  );
  const inventory = JSON.parse(inventoryContents);
  const entries = [
    { path: bundlePath, contents: bundle },
    { path: inventoryPath, contents: inventoryContents },
    { path: reportPath, contents: report },
    { path: packagePath, contents: packageContents },
    { path: vsixManifestPath, contents: vsixManifest },
    { path: nativeManifestPath, contents: nativeManifest },
    { path: nativeBinaryPath, contents: nativeBinary },
  ];
  for (const dependency of inventory.packages) {
    for (const legalText of dependency.legalTexts) {
      entries.push({
        path: `extension/licenses/${legalText.path}`,
        contents: await readFile(join(root, "packages/vscode/licenses", legalText.path)),
      });
    }
  }
  return {
    entries,
    inventory,
    expected: {
      bundleSha256: sha256(bundle),
      inventorySha256: sha256(inventoryContents),
      reportSha256: sha256(report),
      packageSha256: sha256(packageContents),
      extensionName: packageManifest.name,
      publisher: packageManifest.publisher,
      version: packageManifest.version,
      target,
      vscodeTarget,
      nativeBinary: "oxc-tsrx",
      nativeLspSha256: sha256(nativeBinary),
      nativeLspBytes: nativeBinary.length,
      oxcRevision,
    },
  };
}

function replaceEntry(entries, path, contents) {
  return entries.map((entry) => (entry.path === path ? { path, contents } : entry));
}

test("production VSIX entry verification binds bundle, inventory, and legal texts", async () => {
  const fixture = await validFixture();
  const result = verifyVsixEntries(fixture.entries, fixture.expected);
  assert.deepEqual(result, {
    bundleSha256: fixture.expected.bundleSha256,
    inventorySha256: fixture.expected.inventorySha256,
    reportSha256: fixture.expected.reportSha256,
    extensionId: `${fixture.expected.publisher}.${fixture.expected.extensionName}`,
    version: fixture.expected.version,
    target: fixture.expected.target,
    vscodeTarget: fixture.expected.vscodeTarget,
    nativeBinary: fixture.expected.nativeBinary,
    nativeLspSha256: fixture.expected.nativeLspSha256,
    nativeLspBytes: fixture.expected.nativeLspBytes,
    packageCount: fixture.inventory.packageCount,
    legalTextCount: fixture.inventory.packages.reduce(
      (count, dependency) => count + dependency.legalTexts.length,
      0,
    ),
  });
});

test("production VSIX verification requires complete extension and native identity", async () => {
  const fixture = await validFixture();
  for (const [path, label] of [
    [packagePath, "extension package manifest"],
    [vsixManifestPath, "VSIX manifest"],
    [nativeManifestPath, "native manifest"],
    [nativeBinaryPath, "native language server"],
  ]) {
    assert.throws(
      () =>
        verifyVsixEntries(
          fixture.entries.filter((entry) => entry.path !== path),
          fixture.expected,
        ),
      new RegExp(`missing.*${label}`, "iu"),
    );
  }
});

test("production VSIX verification rejects target and native substitution", async () => {
  const fixture = await validFixture();
  const wrongTargetManifest = Buffer.from(
    `<PackageManifest><Metadata><Identity Id="${fixture.expected.extensionName}" Version="${fixture.expected.version}" Publisher="${fixture.expected.publisher}" TargetPlatform="win32-x64"/></Metadata></PackageManifest>`,
  );
  assert.throws(
    () =>
      verifyVsixEntries(
        replaceEntry(fixture.entries, vsixManifestPath, wrongTargetManifest),
        fixture.expected,
      ),
    /VSIX manifest.*target/iu,
  );
  assert.throws(
    () =>
      verifyVsixEntries(
        replaceEntry(fixture.entries, nativeBinaryPath, Buffer.from("substituted native binary")),
        fixture.expected,
      ),
    /native language server.*hash/iu,
  );
});

test("production VSIX entry verification fails closed on missing and duplicate entries", async () => {
  const fixture = await validFixture();
  const legalPath = fixture.entries.find((entry) =>
    entry.path.startsWith("extension/licenses/texts/"),
  ).path;
  for (const [path, label] of [
    [bundlePath, "extension bundle"],
    [inventoryPath, "dependency inventory"],
    [reportPath, "dependency-license report"],
    [legalPath, "legal text"],
  ]) {
    assert.throws(
      () =>
        verifyVsixEntries(
          fixture.entries.filter((entry) => entry.path !== path),
          fixture.expected,
        ),
      new RegExp(`missing.*${label}`, "iu"),
    );
    assert.throws(
      () =>
        verifyVsixEntries(
          [...fixture.entries, { ...fixture.entries.find((entry) => entry.path === path) }],
          fixture.expected,
        ),
      /duplicate entry/iu,
    );
  }
});

test("production VSIX entry verification rejects malformed or unbound inventories", async () => {
  const fixture = await validFixture();
  assert.throws(
    () =>
      verifyVsixEntries(
        replaceEntry(fixture.entries, inventoryPath, Buffer.from("{not-json")),
        fixture.expected,
      ),
    /malformed.*inventory/iu,
  );

  const changedInventory = Buffer.from(
    `${JSON.stringify({ ...fixture.inventory, generatedBy: "unexpected-generator" }, null, 2)}\n`,
  );
  assert.throws(
    () =>
      verifyVsixEntries(
        replaceEntry(fixture.entries, inventoryPath, changedInventory),
        fixture.expected,
      ),
    /inventory.*source/iu,
  );

  const invalidContract = Buffer.from(
    `${JSON.stringify({ ...fixture.inventory, schemaVersion: 2 }, null, 2)}\n`,
  );
  assert.throws(
    () =>
      verifyVsixEntries(replaceEntry(fixture.entries, inventoryPath, invalidContract), {
        ...fixture.expected,
        inventorySha256: sha256(invalidContract),
      }),
    /malformed.*inventory contract/iu,
  );
});

test("production VSIX entry verification rejects bundle and source identity mismatches", async () => {
  const fixture = await validFixture();
  const changedBundle = Buffer.concat([
    fixture.entries.find((entry) => entry.path === bundlePath).contents,
    Buffer.from("\n// corrupt\n"),
  ]);
  assert.throws(
    () =>
      verifyVsixEntries(replaceEntry(fixture.entries, bundlePath, changedBundle), fixture.expected),
    /bundle.*inventory/iu,
  );
  assert.throws(
    () =>
      verifyVsixEntries(fixture.entries, {
        ...fixture.expected,
        bundleSha256: "0".repeat(64),
      }),
    /bundle.*source/iu,
  );
});

test("production VSIX entry verification rejects corrupt or unsafe legal texts", async () => {
  const fixture = await validFixture();
  const [dependency] = fixture.inventory.packages;
  const [legalText] = dependency.legalTexts;
  const legalPath = `extension/licenses/${legalText.path}`;
  assert.throws(
    () =>
      verifyVsixEntries(
        replaceEntry(fixture.entries, legalPath, Buffer.from("corrupt legal text")),
        fixture.expected,
      ),
    /legal text.*hash/iu,
  );

  const unsafeInventory = structuredClone(fixture.inventory);
  unsafeInventory.packages[0].legalTexts[0].path = "../outside.txt";
  unsafeInventory.packages[0].licenseTextPath = "../outside.txt";
  const unsafeContents = Buffer.from(`${JSON.stringify(unsafeInventory, null, 2)}\n`);
  assert.throws(
    () =>
      verifyVsixEntries(replaceEntry(fixture.entries, inventoryPath, unsafeContents), {
        ...fixture.expected,
        inventorySha256: sha256(unsafeContents),
      }),
    /unsafe legal-text path/iu,
  );

  assert.throws(
    () =>
      verifyVsixEntries(
        [
          ...fixture.entries,
          {
            path: "extension/licenses/texts/unlisted/LICENSE",
            contents: Buffer.from("unlisted"),
          },
        ],
        fixture.expected,
      ),
    /unlisted legal text/iu,
  );
});

test("production VSIX entry verification binds the generated legal report", async () => {
  const fixture = await validFixture();
  assert.throws(
    () =>
      verifyVsixEntries(
        replaceEntry(fixture.entries, reportPath, Buffer.from("corrupt report")),
        fixture.expected,
      ),
    /report.*source/iu,
  );
});

test("VSIX archive reader rejects malformed and oversized archives before verification", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-invalid-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "invalid.vsix");
  await writeFile(path, "not a zip archive");
  await assert.rejects(readVsixEntries(path), /central directory|invalid|zip/iu);
  await assert.rejects(
    readVsixEntries(path, {
      maxArchiveBytes: 1,
      maxEntries: 4096,
      maxEntryBytes: 32 * 1024 * 1024,
      maxFileNameBytes: 1024,
      maxTotalBytes: 64 * 1024 * 1024,
    }),
    /archive verification limit/iu,
  );
});

test("VSIX archive reader rejects duplicate paths in an actual ZIP", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-duplicate-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "duplicate.vsix");
  await writeZip(path, [
    { path: "extension/duplicate.txt", contents: "first" },
    { path: "extension/duplicate.txt", contents: "second" },
  ]);

  await assert.rejects(readVsixEntries(path), /duplicate entry/iu);
});

test("VSIX archive reader rejects unsafe names in actual ZIPs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-unsafe-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const backslashPath = join(directory, "backslash.vsix");
  const backslashArchive = await createZip([
    { path: "extension/safe/name.txt", contents: "backslash fixture" },
  ]);
  await writeFile(
    backslashPath,
    replaceAllArchiveBytes(backslashArchive, "extension/safe/name.txt", "extension/safe\\name.txt"),
  );
  await assert.rejects(readVsixEntries(backslashPath), /invalid characters.*fileName/iu);

  const traversalPath = join(directory, "traversal.vsix");
  const traversalArchive = await createZip([
    { path: "extension/xx/name.txt", contents: "traversal fixture" },
  ]);
  await writeFile(
    traversalPath,
    replaceAllArchiveBytes(traversalArchive, "extension/xx/name.txt", "extension/../name.txt"),
  );
  await assert.rejects(readVsixEntries(traversalPath), /invalid relative path/iu);
});

test("VSIX archive reader rejects an encrypted flag in an actual ZIP", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-encrypted-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "encrypted.vsix");
  const archive = await createZip([
    { path: "extension/encrypted.txt", contents: "not really encrypted, deliberately flagged" },
  ]);
  await writeFile(path, markFirstEntryEncrypted(archive));

  await assert.rejects(readVsixEntries(path), /encrypted/iu);
});

test("VSIX archive reader enforces entry, filename, count, and total bounds on actual ZIPs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-bounded-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const entryPath = join(directory, "entry-size.vsix");
  await writeZip(entryPath, [{ path: "extension/entry.txt", contents: "0123456789" }]);
  await assert.rejects(
    readVsixEntries(entryPath, limits({ maxEntryBytes: 9 })),
    /entry.*exceeds.*size limit/iu,
  );

  const filenamePath = join(directory, "filename-size.vsix");
  await writeZip(filenamePath, [{ path: "extension/a-name-that-is-too-long.txt", contents: "x" }]);
  await assert.rejects(
    readVsixEntries(filenamePath, limits({ maxFileNameBytes: 8 })),
    /entry name longer than.*limit/iu,
  );

  const aggregatePath = join(directory, "aggregate.vsix");
  await writeZip(aggregatePath, [
    { path: "extension/one.txt", contents: "123456" },
    { path: "extension/two.txt", contents: "abcdef" },
  ]);
  await assert.rejects(
    readVsixEntries(aggregatePath, limits({ maxEntries: 1 })),
    /entry verification limit/iu,
  );
  await assert.rejects(
    readVsixEntries(aggregatePath, limits({ maxTotalBytes: 11 })),
    /total verification size limit/iu,
  );
});

test("VSIX archive reader rejects corrupt compressed content in an actual ZIP", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-corrupt-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "corrupt.vsix");
  const archive = await createZip([
    { path: "extension/corrupt.txt", contents: "corrupt compressed content fixture" },
  ]);
  await writeFile(path, corruptFirstEntryData(archive));

  await assert.rejects(readVsixEntries(path), /invalid|compressed|block|stream/iu);
});

test("VSIX packaging removes an invalid candidate and never leaves a final artifact", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-candidate-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = join(directory, ".candidate-extension.vsix");
  const finalPath = join(directory, "extension.vsix");
  const fixture = await validFixture();
  await writeZip(candidate, [{ path: "extension/incomplete.txt", contents: "invalid candidate" }]);
  await writeFile(finalPath, "stale final artifact");

  await assert.rejects(
    verifyAndPromoteVsix(candidate, finalPath, fixture.expected),
    /missing.*extension bundle/iu,
  );
  await assert.rejects(stat(candidate), /ENOENT/u);
  await assert.rejects(stat(finalPath), /ENOENT/u);
});

test("release verification rejects eight target names backed by one substituted VSIX", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oxc-tsrx-substituted-matrix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await validFixture();
  const archive = await createZip(fixture.entries);
  const verification = verifyVsixEntries(fixture.entries, fixture.expected);
  const paths = [];

  for (const platform of NATIVE_TARGETS) {
    const vsixName = `oxc-tsrx-vscode-${fixture.expected.version}-${platform.vscodeTarget}.vsix`;
    const vsix = join(directory, vsixName);
    paths.push(vsix);
    await Promise.all([
      writeFile(vsix, archive),
      writeFile(
        join(directory, `native-package-${platform.packageSuffix}.json`),
        `${JSON.stringify({
          packageName: nativePackageName(platform),
          version: fixture.expected.version,
          target: platform.target,
          vscodeTarget: platform.vscodeTarget,
          filename: `tsrx-oxc-${platform.packageSuffix}-${fixture.expected.version}.tgz`,
          lspSha256: fixture.expected.nativeLspSha256,
          lspBytes: fixture.expected.nativeLspBytes,
        })}\n`,
      ),
      writeFile(
        join(directory, `vscode-package-${platform.packageSuffix}.json`),
        `${JSON.stringify({
          extensionId: `${fixture.expected.publisher}.${fixture.expected.extensionName}`,
          version: fixture.expected.version,
          target: platform.target,
          vscodeTarget: platform.vscodeTarget,
          vsix: vsixName,
          lspSha256: fixture.expected.nativeLspSha256,
          lspBytes: fixture.expected.nativeLspBytes,
          vsixVerification: verification,
        })}\n`,
      ),
    ]);
  }

  await assert.rejects(
    run(scriptNode(), [join(root, "scripts/vsix-archive.ts"), ...paths]),
    /VSIX manifest target|native manifest/iu,
  );
});

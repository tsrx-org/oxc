import { createHash } from "node:crypto";
import { close as closeFile, fstat, open as openFile } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TARGETS, nativePackageName } from "../packages/toolchain/dist/native-targets.js";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");

const BUNDLE_PATH = "extension/dist/extension.bundle.cjs";
const INVENTORY_PATH = "extension/licenses/bundle-dependencies.json";
const REPORT_PATH = "extension/licenses/BUNDLE_DEPENDENCIES.md";
const PACKAGE_PATH = "extension/package.json";
const VSIX_MANIFEST_PATH = "extension.vsixmanifest";
const NATIVE_MANIFEST_PATH = "extension/dist/native/manifest.json";
const HASH = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^[a-f0-9]{40}$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const OXC_REVISION = "5a6e37e5cf895143a5b34050c50109c46e2ae96a";

export const DEFAULT_VSIX_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxFileNameBytes: 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

function openVsix(path, limits, callback) {
  openFile(path, "r", (openError, descriptor) => {
    if (openError) {
      callback(openError);
      return;
    }
    const closeWith = (error) => {
      closeFile(descriptor, (closeError) => callback(closeError ?? error));
    };
    fstat(descriptor, (statError, metadata) => {
      if (statError) {
        closeWith(statError);
        return;
      }
      if (!metadata.isFile()) {
        closeWith(new Error(`VSIX is not a file: ${path}`));
        return;
      }
      if (metadata.size > limits.maxArchiveBytes) {
        closeWith(
          new Error(`VSIX exceeds the ${limits.maxArchiveBytes}-byte archive verification limit`),
        );
        return;
      }
      try {
        yauzl.fromFd(
          descriptor,
          {
            lazyEntries: true,
            autoClose: true,
            decodeStrings: true,
            validateEntrySizes: true,
            strictFileNames: true,
          },
          (zipError, zip) => {
            if (zipError) closeWith(zipError);
            else callback(null, zip);
          },
        );
      } catch (error) {
        closeWith(error);
      }
    });
  });
}

const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

function entryMap(entries) {
  const mapped = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error("VSIX contains an entry without a valid path");
    }
    if (mapped.has(entry.path)) throw new Error(`VSIX contains duplicate entry ${entry.path}`);
    if (!Buffer.isBuffer(entry.contents) && !(entry.contents instanceof Uint8Array)) {
      throw new Error(`VSIX entry ${entry.path} does not contain bytes`);
    }
    mapped.set(entry.path, Buffer.from(entry.contents));
  }
  return mapped;
}

function requiredEntry(entries, path, label) {
  const contents = entries.get(path);
  if (!contents) throw new Error(`VSIX is missing ${label} at ${path}`);
  return contents;
}

function legalArchivePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath.startsWith("texts/") ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`VSIX inventory has unsafe legal-text path: ${String(relativePath)}`);
  }
  return `extension/licenses/${relativePath}`;
}

function parseInventory(contents) {
  let inventory;
  try {
    inventory = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error(`VSIX contains a malformed dependency inventory: ${error.message}`);
  }
  if (
    inventory?.schemaVersion !== 1 ||
    inventory.bundle !== "packages/vscode/dist/extension.bundle.cjs" ||
    !Array.isArray(inventory.packages) ||
    !Number.isSafeInteger(inventory.packageCount) ||
    inventory.packageCount !== inventory.packages.length ||
    inventory.packageCount < 1 ||
    inventory.packageCount > 1024 ||
    !HASH.test(inventory.bundleSha256 ?? "")
  ) {
    throw new Error("VSIX contains a malformed dependency inventory contract");
  }
  return inventory;
}

function parseJson(contents, label) {
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error(`VSIX contains a malformed ${label}: ${error.message}`);
  }
}

function validateExpectedIdentity(expected) {
  if (
    !HASH.test(expected?.bundleSha256 ?? "") ||
    !HASH.test(expected?.inventorySha256 ?? "") ||
    !HASH.test(expected?.reportSha256 ?? "") ||
    !HASH.test(expected?.packageSha256 ?? "") ||
    !HASH.test(expected?.nativeLspSha256 ?? "") ||
    !SAFE_NAME.test(expected?.extensionName ?? "") ||
    !SAFE_NAME.test(expected?.publisher ?? "") ||
    typeof expected?.version !== "string" ||
    expected.version.length === 0 ||
    typeof expected?.target !== "string" ||
    expected.target.length === 0 ||
    typeof expected?.vscodeTarget !== "string" ||
    expected.vscodeTarget.length === 0 ||
    !/^oxc-tsrx(?:\.exe)?$/u.test(expected?.nativeBinary ?? "") ||
    !Number.isSafeInteger(expected?.nativeLspBytes) ||
    expected.nativeLspBytes < 1 ||
    !GIT_REVISION.test(expected?.oxcRevision ?? "")
  ) {
    throw new Error(
      "VSIX verification requires complete expected source, extension, target, and native identity",
    );
  }
  const windowsBinary = expected.nativeBinary.endsWith(".exe");
  if (windowsBinary !== expected.vscodeTarget.startsWith("win32-")) {
    throw new Error("VSIX verification expected target and native binary identity disagree");
  }
}

function parsePackageManifest(contents, expected) {
  if (sha256(contents) !== expected.packageSha256) {
    throw new Error("VSIX extension package manifest does not match the verified source manifest");
  }
  const manifest = parseJson(contents, "extension package manifest");
  if (
    manifest?.name !== expected.extensionName ||
    manifest?.publisher !== expected.publisher ||
    manifest?.version !== expected.version ||
    manifest?.main !== "./dist/extension.bundle.cjs"
  ) {
    throw new Error("VSIX extension package manifest has an unexpected extension identity");
  }
  return manifest;
}

function parseVsixIdentity(contents) {
  const xml = contents.toString("utf8");
  const identityElements = [...xml.matchAll(/<Identity\b([^>]*)\/?\s*>/gu)];
  if (identityElements.length !== 1) {
    throw new Error("VSIX contains a malformed VSIX manifest identity");
  }
  const attributes = new Map();
  for (const match of identityElements[0][1].matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/gu)) {
    if (attributes.has(match[1])) {
      throw new Error(`VSIX manifest identity repeats attribute ${match[1]}`);
    }
    attributes.set(match[1], match[2]);
  }
  for (const name of ["Id", "Version", "Publisher", "TargetPlatform"]) {
    if (!attributes.get(name)) throw new Error(`VSIX manifest identity is missing ${name}`);
  }
  return attributes;
}

function verifyExtensionIdentity(mapped, expected) {
  parsePackageManifest(requiredEntry(mapped, PACKAGE_PATH, "extension package manifest"), expected);
  const identity = parseVsixIdentity(requiredEntry(mapped, VSIX_MANIFEST_PATH, "VSIX manifest"));
  if (
    identity.get("Id") !== expected.extensionName ||
    identity.get("Publisher") !== expected.publisher ||
    identity.get("Version") !== expected.version
  ) {
    throw new Error("VSIX manifest does not match the expected extension identity");
  }
  if (identity.get("TargetPlatform") !== expected.vscodeTarget) {
    throw new Error("VSIX manifest target does not match the expected VS Code target");
  }
}

function verifyNativeIdentity(mapped, expected) {
  const manifestContents = requiredEntry(mapped, NATIVE_MANIFEST_PATH, "native manifest");
  const manifest = parseJson(manifestContents, "native manifest");
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.extensionVersion !== expected.version ||
    manifest?.target !== expected.target ||
    manifest?.vscodeTarget !== expected.vscodeTarget ||
    manifest?.binary !== expected.nativeBinary ||
    manifest?.bytes !== expected.nativeLspBytes ||
    manifest?.sha256 !== expected.nativeLspSha256 ||
    manifest?.oxcRevision !== expected.oxcRevision ||
    typeof manifest?.rustc !== "string" ||
    manifest.rustc.trim().length === 0
  ) {
    throw new Error("VSIX native manifest does not match the expected target and language server");
  }
  const nativePath = `extension/dist/native/${expected.nativeBinary}`;
  const nativeLsp = requiredEntry(mapped, nativePath, "native language server");
  const nativeLspSha256 = sha256(nativeLsp);
  if (nativeLspSha256 !== expected.nativeLspSha256) {
    throw new Error("VSIX native language server hash does not match the expected source binary");
  }
  if (nativeLsp.length !== expected.nativeLspBytes) {
    throw new Error("VSIX native language server size does not match the expected source binary");
  }
  for (const path of mapped.keys()) {
    // One multi-call `oxc-tsrx` executable replaced the separate `-fmt` and
    // `-lsp` binaries, so a VSIX carrying either retired name, or the same name
    // twice under both executable suffixes, is a second language server.
    if (
      path !== nativePath &&
      /^extension\/dist\/native\/oxc-tsrx(?:-fmt|-lsp)?(?:\.exe)?$/u.test(path)
    ) {
      throw new Error(`VSIX contains a second native language server at ${path}`);
    }
  }
  return nativeLspSha256;
}

export function verifyVsixEntries(entries, expected) {
  validateExpectedIdentity(expected);
  const mapped = entryMap(entries);
  const bundle = requiredEntry(mapped, BUNDLE_PATH, "extension bundle");
  const inventoryContents = requiredEntry(mapped, INVENTORY_PATH, "dependency inventory");
  const report = requiredEntry(mapped, REPORT_PATH, "dependency-license report");
  const inventory = parseInventory(inventoryContents);
  verifyExtensionIdentity(mapped, expected);
  const nativeLspSha256 = verifyNativeIdentity(mapped, expected);

  const bundleSha256 = sha256(bundle);
  if (bundleSha256 !== inventory.bundleSha256) {
    throw new Error("VSIX extension bundle hash does not match its embedded inventory");
  }
  if (bundleSha256 !== expected.bundleSha256) {
    throw new Error("VSIX extension bundle does not match the freshness-checked source bundle");
  }

  const inventorySha256 = sha256(inventoryContents);
  if (inventorySha256 !== expected.inventorySha256) {
    throw new Error("VSIX dependency inventory does not match the verified source inventory");
  }
  const reportSha256 = sha256(report);
  if (reportSha256 !== expected.reportSha256) {
    throw new Error("VSIX dependency-license report does not match the verified source report");
  }

  const legalPaths = new Set();
  let legalTextCount = 0;
  for (const dependency of inventory.packages) {
    if (
      !dependency ||
      typeof dependency.name !== "string" ||
      !Array.isArray(dependency.legalTexts) ||
      dependency.legalTexts.length === 0
    ) {
      throw new Error("VSIX contains a malformed dependency legal-text record");
    }
    const primaryLicense = dependency.legalTexts.find(
      (legalText) => legalText.path === dependency.licenseTextPath,
    );
    if (!primaryLicense || primaryLicense.sha256 !== dependency.licenseTextSha256) {
      throw new Error(`VSIX inventory has no primary license text for ${dependency.name}`);
    }
    for (const legalText of dependency.legalTexts) {
      const archivePath = legalArchivePath(legalText?.path);
      if (!HASH.test(legalText?.sha256 ?? "")) {
        throw new Error(`VSIX inventory has a malformed legal-text hash for ${dependency.name}`);
      }
      if (legalPaths.has(archivePath)) {
        throw new Error(`VSIX inventory repeats legal-text path ${legalText.path}`);
      }
      legalPaths.add(archivePath);
      const contents = requiredEntry(mapped, archivePath, `legal text for ${dependency.name}`);
      if (sha256(contents) !== legalText.sha256) {
        throw new Error(
          `VSIX legal text hash does not match for ${dependency.name}: ${legalText.path}`,
        );
      }
      legalTextCount += 1;
    }
  }
  for (const path of mapped.keys()) {
    if (path.startsWith("extension/licenses/texts/") && !legalPaths.has(path)) {
      throw new Error(`VSIX contains unlisted legal text ${path}`);
    }
  }

  return {
    bundleSha256,
    inventorySha256,
    reportSha256,
    extensionId: `${expected.publisher}.${expected.extensionName}`,
    version: expected.version,
    target: expected.target,
    vscodeTarget: expected.vscodeTarget,
    nativeBinary: expected.nativeBinary,
    nativeLspSha256,
    nativeLspBytes: expected.nativeLspBytes,
    packageCount: inventory.packageCount,
    legalTextCount,
  };
}

export async function readVsixEntries(path, limits = DEFAULT_VSIX_LIMITS) {
  return new Promise((resolveEntries, rejectEntries) => {
    openVsix(path, limits, (openError, zip) => {
      if (openError) {
        rejectEntries(openError);
        return;
      }
      const entries = [];
      const seen = new Set();
      let totalBytes = 0;
      let settled = false;
      let closed = false;
      let ended = false;
      let terminalError = null;

      const settle = () => {
        if (settled) return;
        if (terminalError && closed) {
          settled = true;
          rejectEntries(terminalError);
        } else if (ended && closed) {
          settled = true;
          resolveEntries(entries);
        }
      };
      const fail = (error) => {
        if (settled || terminalError) return;
        terminalError = error;
        zip.close();
        settle();
      };
      zip.on("error", (error) => {
        if (terminalError) {
          settled = true;
          rejectEntries(error);
        } else {
          fail(error);
        }
      });
      zip.on("close", () => {
        closed = true;
        settle();
      });
      zip.on("end", () => {
        ended = true;
        settle();
      });
      zip.on("entry", (entry) => {
        if (seen.has(entry.fileName)) {
          fail(new Error(`VSIX contains duplicate entry ${entry.fileName}`));
          return;
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          fail(new Error(`VSIX entry ${entry.fileName} is encrypted`));
          return;
        }
        if (Buffer.byteLength(entry.fileName, "utf8") > limits.maxFileNameBytes) {
          fail(new Error("VSIX contains an entry name longer than the verification limit"));
          return;
        }
        seen.add(entry.fileName);
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 ||
          entry.uncompressedSize > limits.maxEntryBytes
        ) {
          fail(new Error(`VSIX entry ${entry.fileName} exceeds the verification size limit`));
          return;
        }
        totalBytes += entry.uncompressedSize;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
          fail(new Error("VSIX exceeds the total verification size limit"));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            fail(streamError);
            return;
          }
          const chunks = [];
          let bytes = 0;
          stream.on("error", fail);
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > limits.maxEntryBytes) {
              stream.destroy(
                new Error(`VSIX entry ${entry.fileName} exceeds the verification size limit`),
              );
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            if (settled) return;
            if (bytes !== entry.uncompressedSize) {
              fail(
                new Error(`VSIX entry ${entry.fileName} size does not match its archive metadata`),
              );
              return;
            }
            entries.push({ path: entry.fileName, contents: Buffer.concat(chunks, bytes) });
            zip.readEntry();
          });
        });
      });
      if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount > limits.maxEntries) {
        fail(new Error(`VSIX exceeds the ${limits.maxEntries}-entry verification limit`));
        return;
      }
      zip.readEntry();
    });
  });
}

async function verifyVsixArchive(path, expected, options: any = {}) {
  const entries = await readVsixEntries(path, options.limits ?? DEFAULT_VSIX_LIMITS);
  return verifyVsixEntries(entries, expected);
}

export async function verifyAndPromoteVsix(candidate, finalPath, expected, options: any = {}) {
  try {
    await rm(finalPath, { force: true });
    const verification = await verifyVsixArchive(candidate, expected, options);
    await rename(candidate, finalPath);
    return verification;
  } catch (error) {
    await Promise.all([rm(candidate, { force: true }), rm(finalPath, { force: true })]);
    throw error;
  }
}

async function readReport(path, label) {
  try {
    return parseJson(await readFile(path), label);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`missing ${label} at ${path}`);
    throw error;
  }
}

function requireReport(condition, message) {
  if (!condition) throw new Error(`release report identity mismatch: ${message}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length === 0)
    throw new Error("usage: node scripts/vsix-archive.ts <artifact.vsix> [...]");
  const root = resolve(import.meta.dirname, "..");
  const [sourcePackage, bundle, inventory, report] = await Promise.all([
    readFile(resolve(root, "packages/vscode/package.json")),
    readFile(resolve(root, "packages/vscode/dist/extension.bundle.cjs")),
    readFile(resolve(root, "packages/vscode/licenses/bundle-dependencies.json")),
    readFile(resolve(root, "packages/vscode/licenses/BUNDLE_DEPENDENCIES.md")),
  ]);
  const sourceManifest = parseJson(sourcePackage, "source extension package manifest");
  const sourceExpected = {
    bundleSha256: sha256(bundle),
    inventorySha256: sha256(inventory),
    reportSha256: sha256(report),
    packageSha256: sha256(sourcePackage),
    extensionName: sourceManifest.name,
    publisher: sourceManifest.publisher,
    version: sourceManifest.version,
    oxcRevision: OXC_REVISION,
  };
  if (paths.length !== NATIVE_TARGETS.length) {
    throw new Error(
      `complete VSIX verification requires ${NATIVE_TARGETS.length} target artifacts, found ${paths.length}`,
    );
  }
  const seenTargets = new Set();
  for (const path of paths) {
    const absolutePath = resolve(root, path);
    const artifactName = basename(absolutePath);
    const platform = NATIVE_TARGETS.find(
      ({ vscodeTarget }) =>
        artifactName === `oxc-tsrx-vscode-${sourceManifest.version}-${vscodeTarget}.vsix`,
    );
    if (!platform) throw new Error(`unexpected VSIX release artifact name: ${artifactName}`);
    if (seenTargets.has(platform.target)) {
      throw new Error(`duplicate VSIX release target: ${platform.target}`);
    }
    seenTargets.add(platform.target);

    const reportDirectory = dirname(absolutePath);
    const [nativeReport, vscodeReport] = await Promise.all([
      readReport(
        resolve(reportDirectory, `native-package-${platform.packageSuffix}.json`),
        `${platform.target} native package report`,
      ),
      readReport(
        resolve(reportDirectory, `vscode-package-${platform.packageSuffix}.json`),
        `${platform.target} VSIX package report`,
      ),
    ]);
    // npm pack flattens `@tsrx/oxc-<suffix>` to `tsrx-oxc-<suffix>-<version>.tgz`.
    const expectedNativeFilename = `tsrx-oxc-${platform.packageSuffix}-${sourceManifest.version}.tgz`;
    requireReport(
      nativeReport.packageName === nativePackageName(platform),
      `${platform.target} package`,
    );
    requireReport(
      nativeReport.version === sourceManifest.version,
      `${platform.target} native version`,
    );
    requireReport(nativeReport.target === platform.target, `${platform.target} native target`);
    requireReport(
      nativeReport.vscodeTarget === platform.vscodeTarget,
      `${platform.target} native VS Code target`,
    );
    requireReport(
      nativeReport.filename === expectedNativeFilename,
      `${platform.target} tarball name`,
    );
    requireReport(HASH.test(nativeReport.lspSha256 ?? ""), `${platform.target} LSP hash`);
    requireReport(
      Number.isSafeInteger(nativeReport.lspBytes) && nativeReport.lspBytes > 0,
      `${platform.target} LSP size`,
    );

    const nativeBinary = platform.os === "win32" ? "oxc-tsrx.exe" : "oxc-tsrx";
    const expected = {
      ...sourceExpected,
      target: platform.target,
      vscodeTarget: platform.vscodeTarget,
      nativeBinary,
      nativeLspSha256: nativeReport.lspSha256,
      nativeLspBytes: nativeReport.lspBytes,
    };
    const verification = await verifyVsixArchive(absolutePath, expected);
    requireReport(
      vscodeReport.extensionId === `${sourceManifest.publisher}.${sourceManifest.name}`,
      `${platform.target} extension ID`,
    );
    requireReport(
      vscodeReport.version === sourceManifest.version,
      `${platform.target} VSIX version`,
    );
    requireReport(vscodeReport.target === platform.target, `${platform.target} VSIX target`);
    requireReport(
      vscodeReport.vscodeTarget === platform.vscodeTarget,
      `${platform.target} VSIX platform`,
    );
    requireReport(
      basename(vscodeReport.vsix ?? "") === artifactName,
      `${platform.target} VSIX name`,
    );
    requireReport(vscodeReport.lspSha256 === nativeReport.lspSha256, `${platform.target} LSP hash`);
    requireReport(vscodeReport.lspBytes === nativeReport.lspBytes, `${platform.target} LSP size`);
    for (const [field, value] of Object.entries(verification)) {
      requireReport(
        vscodeReport.vsixVerification?.[field] === value,
        `${platform.target} VSIX verification field ${field}`,
      );
    }
    process.stdout.write(`${JSON.stringify({ vsix: path, ...verification })}\n`);
  }
  requireReport(seenTargets.size === NATIVE_TARGETS.length, "complete unique target matrix");
}

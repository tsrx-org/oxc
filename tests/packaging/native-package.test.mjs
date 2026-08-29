import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { nativePackageName } from "../../packages/toolchain/dist/native-targets.js";
import { resolveNpmInvocation } from "../helpers/npm-invocation.mjs";
import { scriptNode } from "../helpers/script-node.mjs";

const root = resolve(import.meta.dirname, "../..");

function hostTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return "aarch64-pc-windows-msvc";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  if (process.platform === "linux" && ["arm64", "x64"].includes(process.arch)) {
    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
    return `${architecture}-unknown-linux-${libc}`;
  }
  throw new Error(`unsupported packaging-test host ${process.platform}-${process.arch}`);
}

function differentArchitectureTarget() {
  const target = hostTarget();
  return target.startsWith("aarch64-")
    ? target.replace(/^aarch64-/, "x86_64-")
    : target.replace(/^x86_64-/, "aarch64-");
}

function hostObjectFormat() {
  if (process.platform === "darwin") return "mach-o";
  if (process.platform === "linux") return "elf";
  if (process.platform === "win32") return "pe";
  throw new Error(`unsupported packaging-test platform ${process.platform}`);
}

function oppositeArchitecture() {
  return process.arch === "arm64" ? "x64" : "arm64";
}

function fixtureTarget(os) {
  const cpu = process.platform === os ? oppositeArchitecture() : "arm64";
  const architecture = cpu === "arm64" ? "aarch64" : "x86_64";
  if (os === "darwin") return `${architecture}-apple-darwin`;
  if (os === "linux") return `${architecture}-unknown-linux-gnu`;
  if (os === "win32") return `${architecture}-pc-windows-msvc`;
  throw new Error(`unsupported executable fixture OS ${os}`);
}

function executableHeader(format, cpu, bits = 64) {
  if (format === "mach-o") {
    const contents = Buffer.alloc(32);
    contents.writeUInt32LE(bits === 64 ? 0xfeedfacf : 0xfeedface, 0);
    contents.writeUInt32LE(cpu === "arm64" ? 0x0100000c : 0x01000007, 4);
    contents.writeUInt32LE(2, 12);
    return contents;
  }
  if (format === "elf") {
    const contents = Buffer.alloc(64);
    contents.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, 1, 1, 0]);
    contents.writeUInt16LE(3, 16);
    contents.writeUInt16LE(cpu === "arm64" ? 183 : 62, 18);
    return contents;
  }
  if (format === "pe") {
    const contents = Buffer.alloc(0x100);
    contents.write("MZ", 0, "ascii");
    contents.writeUInt32LE(0x80, 0x3c);
    contents.set([0x50, 0x45, 0, 0], 0x80);
    contents.writeUInt16LE(cpu === "arm64" ? 0xaa64 : 0x8664, 0x84);
    contents.writeUInt16LE(0x0002, 0x96);
    contents.writeUInt16LE(bits === 64 ? 0x020b : 0x010b, 0x98);
    return contents;
  }
  throw new Error(`unsupported executable fixture format ${format}`);
}

async function writeExecutableFixtures(directory, target, format, bits = 64) {
  await mkdir(directory, { recursive: true });
  const cpu = target.startsWith("aarch64-") ? "arm64" : "x64";
  const suffix = format === "pe" ? ".exe" : "";
  const contents = executableHeader(format, cpu, bits);
  await writeFile(join(directory, `oxc-tsrx${suffix}`), contents);
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      args,
      { cwd: options.cwd ?? root, env: options.env ?? process.env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
        else resolveRun({ stdout, stderr });
      },
    );
  });
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * A stand-in for npm that prints one recorded `npm pack --json` response.
 *
 * `npm pack --json` has printed two different shapes: npm 11 and earlier printed
 * an array of packed entries, npm 12 prints an object keyed by package name.
 * Release runners and developer machines are split across that boundary, so the
 * packager has to read both, and a test that only ever sees the npm this machine
 * happens to have installed cannot say so.
 *
 * The stub is resolved the same way real npm is: `resolveNpmInvocation` follows
 * `npm_execpath` to a package manifest named `npm` whose declared `bin` is a
 * JavaScript file, and runs that file through Node. So this exercises the real
 * script over the real invocation path, with only npm's stdout substituted.
 */
async function stubNpm(directory, { stdout, filename }) {
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "npm", version: "12.0.1", bin: { npm: "bin/npm-cli.js" } }, null, 2)}\n`,
  );
  await writeFile(join(directory, "pack-response.txt"), stdout);
  const entry = join(binDirectory, "npm-cli.js");
  await writeFile(
    entry,
    [
      'const { readFileSync, writeFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      "const args = process.argv.slice(2);",
      'if (args[0] !== "pack") {',
      "  process.stderr.write(`stub npm was asked for ${JSON.stringify(args)}\\n`);",
      "  process.exit(1);",
      "}",
      'const destination = args[args.indexOf("--pack-destination") + 1];',
      // A placeholder, so the tarball path the packager reports names a real
      // file. Nothing downstream of the pack step reads its bytes.
      ...(filename ? [`writeFileSync(join(destination, ${JSON.stringify(filename)}), "");`] : []),
      'process.stdout.write(readFileSync(join(__dirname, "..", "pack-response.txt"), "utf8"));',
      "",
    ].join("\n"),
  );
  return entry;
}

async function packWithStubbedNpm(response) {
  const temporary = await mkdtemp(join(tmpdir(), "oxc-tsrx-pack-shape-"));
  const target = fixtureTarget("linux");
  const binaries = join(temporary, "bin-dir");
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeExecutableFixtures(binaries, target, "elf");
  const entry = await stubNpm(join(temporary, "npm"), response);
  return {
    artifacts,
    target,
    result: run(
      scriptNode(),
      [
        "scripts/package-native.ts",
        "--target",
        target,
        "--bin-dir",
        binaries,
        "--out-dir",
        artifacts,
        // These cases assert binary-staging failures, so they must reach the
        // staging code rather than stopping at the addon requirement.
        "--allow-missing-parser-addon",
      ],
      { env: { ...process.env, npm_execpath: entry } },
    ),
  };
}

/** The per-entry fields are identical in both shapes; only the container moved. */
function packedEntry(target) {
  return {
    id: `${nativePackageName(target)}@0.1.0`,
    name: nativePackageName(target),
    version: "0.8.0",
    size: 6426070,
    unpackedSize: 14097905,
    shasum: "62e463f312886399ada17ae8cbbc6b0288856690",
    integrity: "sha512-2dc/qYe+0lY6dzFWPYbUE/XcdnYBC548tMzjNXFBVC7AV5xVfJGDbAmgaZ2rJd3VJrf/tDi11ucXp974CRRQrw==",
    filename: "tsrx-oxc-native-recorded-pack-0.1.0.tgz",
    files: [{ path: "package.json", size: 1123, mode: 420 }],
    entryCount: 13,
    bundled: [],
  };
}

test("the packager reads npm 11's array pack report and npm 12's package-keyed object", async () => {
  for (const [npmMajor, container] of [
    // npm 11 and earlier.
    ["11", (entry) => [entry]],
    // npm 12.0.1.
    ["12", (entry) => ({ [entry.name]: entry })],
  ]) {
    const target = fixtureTarget("linux");
    const entry = packedEntry(target);
    const { artifacts, result } = await packWithStubbedNpm({
      stdout: `${JSON.stringify(container(entry), null, 2)}\n`,
      filename: entry.filename,
    });
    const packaged = JSON.parse((await result).stdout);
    assert.equal(packaged.target, target, `npm ${npmMajor} pack report`);
    assert.equal(packaged.filename, entry.filename, `npm ${npmMajor} pack report`);
    assert.equal(
      packaged.tarball,
      join(artifacts, entry.filename).replaceAll("\\", "/"),
      `npm ${npmMajor} pack report`,
    );
    assert.equal(packaged.integrity, entry.integrity, `npm ${npmMajor} pack report`);
    assert.equal(packaged.shasum, entry.shasum, `npm ${npmMajor} pack report`);
    assert.equal(packaged.unpackedSize, entry.unpackedSize, `npm ${npmMajor} pack report`);
  }
});

test("a pack report that is not exactly one packed entry still fails with npm's own output", async () => {
  const entry = packedEntry(fixtureTarget("linux"));
  const second = { ...entry, name: `${entry.name}-2`, filename: "second-0.1.0.tgz" };
  for (const stdout of [
    // Neither container may be read as "take whatever came back".
    "[]",
    JSON.stringify([entry, second]),
    "{}",
    JSON.stringify({ [entry.name]: entry, [second.name]: second }),
    // npm's own failure report is a one-key object that names no file.
    JSON.stringify({ error: { summary: "Invalid package, must have name and version", detail: "" } }),
    JSON.stringify({ [entry.name]: { ...entry, filename: undefined } }),
    JSON.stringify("tsrx-oxc-native-recorded-pack-0.1.0.tgz"),
    "not json at all",
  ]) {
    const { result } = await packWithStubbedNpm({ stdout });
    await assert.rejects(result, /unexpected npm pack response/u, stdout);
    // The raw stdout is the only evidence of what npm did, so it stays in the message.
    await assert.rejects(result, new RegExp(stdout.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("current native release stages a complete, checksummed, npm-installable platform package", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "oxc-tsrx-native-artifacts-"));
  const { stdout } = await run(scriptNode(), [
    "scripts/package-native.ts",
    "--target",
    hostTarget(),
    "--bin-dir",
    "target/release",
    "--out-dir",
    artifacts,
    // This case covers executable staging only. The addon-bearing package is
    // asserted by the canonical parser packaging test below.
    "--allow-missing-parser-addon",
  ]);
  const packaged = JSON.parse(stdout);
  assert.equal(packaged.version, "0.8.0");
  assert.equal(packaged.target, hostTarget());
  assert.match(packaged.packageName, /^@tsrx\/oxc-/);
  assert.equal(resolve(packaged.tarball).startsWith(resolve(artifacts)), true);

  const consumer = await mkdtemp(join(tmpdir(), "oxc-tsrx-native-consumer-"));
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
  assert.equal((await realpath(packageRoot)).startsWith(await realpath(consumer)), true);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.8.0");
  assert.equal(manifest.oxcTsrx.target, hostTarget());
  assert.equal(manifest.oxcTsrx.oxcRevision, "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40");
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.preferUnplugged, true);

  const checksums = JSON.parse(await readFile(join(packageRoot, "checksums.json"), "utf8"));
  // One multi-call executable carries the linter, the formatter, and the
  // language server. Three separate binaries linked the same oxc code three
  // times, so this is the single largest item in the platform download.
  const expected = process.platform === "win32" ? ["oxc-tsrx.exe"] : ["oxc-tsrx"];
  const [server] = expected;
  assert.equal(packaged.lspSha256, checksums.binaries[server].sha256);
  assert.equal(packaged.lspBytes, checksums.binaries[server].bytes);
  assert.equal(manifest.oxcTsrx.nativeProtocolVersion, 2);
  assert.deepEqual(manifest.oxcTsrx.binaries, expected);
  assert.deepEqual((await readdir(join(packageRoot, "bin"))).sort(), expected.sort());
  for (const binary of expected) {
    const path = join(packageRoot, "bin", binary);
    const metadata = await stat(path);
    assert.equal(metadata.isFile(), true);
    if (process.platform !== "win32") assert.notEqual(metadata.mode & 0o111, 0);
    assert.equal(checksums.binaries[binary].bytes, metadata.size);
    assert.equal(checksums.binaries[binary].sha256, await sha256(path));
    assert.equal(checksums.binaries[binary].object.format, hostObjectFormat());
    assert.equal(checksums.binaries[binary].object.os, process.platform);
    assert.equal(checksums.binaries[binary].object.bits, 64);
    assert.ok(checksums.binaries[binary].object.architectures.includes(process.arch));
  }
  assert.equal(checksums.objectVerification, "executable-header");
  assert.ok((await readdir(packageRoot)).includes("LICENSE"));
  assert.ok((await readdir(packageRoot)).includes("README.md"));
  assert.ok((await readdir(packageRoot)).includes("THIRD_PARTY_NOTICES.md"));
  assert.equal(
    basename(packaged.tarball),
    `${packaged.packageName.slice(1).replace("/", "-")}-${packaged.version}.tgz`,
  );
});

test("packaging refuses to build a native package without the parser addon", async () => {
  // 0.1.0 published all eight native packages with no parser.node: the addon
  // was optional, the release never passed it, npm honoured the generated
  // `files` list and dropped it from every tarball, and `@tsrx/oxc/parser` then
  // threw ERR_TSRX_NATIVE_INTEGRITY on every consumer. Nothing failed at build
  // time, so the only defence is refusing to produce such a package at all.
  const artifacts = await mkdtemp(join(tmpdir(), "oxc-tsrx-native-noaddon-"));
  await assert.rejects(
    () =>
      run(scriptNode(), [
        "scripts/package-native.ts",
        "--target",
        hostTarget(),
        "--bin-dir",
        "target/release",
        "--out-dir",
        artifacts,
      ]),
    /--parser-addon is required/,
  );
  assert.deepEqual(await readdir(artifacts), []);
});

test("canonical parser packaging adds one verified schema-2 addon without changing the executable family", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "oxc-tsrx-parser-native-package-"));
  const addon = join(temporary, "parser.node");
  await run(scriptNode(), [
    "scripts/build-parser-native.ts",
    "--skip-build",
    "--out",
    addon,
  ]);
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const { stdout } = await run(scriptNode(), [
    "scripts/package-native.ts",
    "--target",
    hostTarget(),
    "--bin-dir",
    "target/release",
    "--parser-addon",
    addon,
    "--out-dir",
    artifacts,
  ]);
  const packaged = JSON.parse(stdout);

  const consumer = join(temporary, "consumer");
  await mkdir(consumer, { recursive: true });
  const npmInvocation = resolveNpmInvocation([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    packaged.tarball,
  ]);
  await run(npmInvocation.executable, npmInvocation.args, {
    cwd: consumer,
    env: { ...process.env, npm_config_cache: join(temporary, ".npm-cache") },
  });

  const packageRoot = join(consumer, "node_modules", ...packaged.packageName.split("/"));
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const checksums = JSON.parse(await readFile(join(packageRoot, "checksums.json"), "utf8"));
  assert.equal(manifest.oxcTsrx.schemaVersion, 2);
  assert.deepEqual(manifest.oxcTsrx.binaries, checksums.binaries ? Object.keys(checksums.binaries) : []);
  assert.deepEqual(Object.keys(manifest.oxcTsrx.addons), ["parser.node"]);
  assert.deepEqual(Object.keys(checksums.addons), ["parser.node"]);
  assert.deepEqual(manifest.oxcTsrx.addons["parser.node"], checksums.addons["parser.node"]);

  const record = checksums.addons["parser.node"];
  const installedAddon = join(packageRoot, "parser.node");
  assert.equal(record.role, "canonical-parser");
  assert.equal(record.file, "parser.node");
  assert.equal(record.apiVersion, 1);
  assert.equal(record.transportAbi, 1);
  assert.equal(record.nodeApi, 8);
  assert.equal(record.packageVersion, "0.8.0");
  assert.equal(record.target, hostTarget());
  assert.equal(record.oxcRevision, "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40");
  assert.deepEqual(record.capabilities, {
    lazy: true,
    async: true,
    editorRecovery: false,
    cssMaterialization: false,
    rawTransfer: false,
  });
  assert.equal(record.object.imageKind, "dynamic-library");
  assert.equal(record.object.bits, 64);
  assert.deepEqual(record.object.architectures, [process.arch]);
  assert.equal(record.object.os, process.platform);
  assert.equal(record.bytes, (await stat(installedAddon)).size);
  assert.equal(record.sha256, await sha256(installedAddon));

  const binding = (await import("node:module")).createRequire(import.meta.url)(installedAddon);
  assert.deepEqual(Object.keys(binding).sort(), ["nodeApi", "parse", "parseSync"]);
  assert.equal(binding.nodeApi(), 8);
});

test("native packaging rejects current-host object files labeled as another architecture", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "oxc-tsrx-native-wrong-target-"));
  await assert.rejects(
    run(scriptNode(), [
      "scripts/package-native.ts",
      "--allow-missing-parser-addon",
      "--target",
      differentArchitectureTarget(),
      "--bin-dir",
      "target/release",
      "--out-dir",
      artifacts,
    ]),
    /object target mismatch.*expected .* found /s,
  );
});

test("cross-package verification recognizes Mach-O, ELF, and PE headers without host tools", async () => {
  for (const [os, format] of [
    ["darwin", "mach-o"],
    ["linux", "elf"],
    ["win32", "pe"],
  ]) {
    const target = fixtureTarget(os);
    const binaries = await mkdtemp(join(tmpdir(), `oxc-tsrx-${format}-fixtures-`));
    const artifacts = await mkdtemp(join(tmpdir(), `oxc-tsrx-${format}-artifacts-`));
    await writeExecutableFixtures(binaries, target, format);
    const { stdout } = await run(scriptNode(), [
      "scripts/package-native.ts",
      "--allow-missing-parser-addon",
      "--target",
      target,
      "--bin-dir",
      binaries,
      "--out-dir",
      artifacts,
    ]);
    assert.equal(JSON.parse(stdout).target, target);
  }
});

test("all supported packages reject 32-bit executable headers", async () => {
  for (const [os, format] of [
    ["darwin", "mach-o"],
    ["linux", "elf"],
    ["win32", "pe"],
  ]) {
    const target = fixtureTarget(os);
    const binaries = await mkdtemp(join(tmpdir(), `oxc-tsrx-${format}-32-bit-`));
    const artifacts = await mkdtemp(join(tmpdir(), `oxc-tsrx-${format}-32-artifacts-`));
    await writeExecutableFixtures(binaries, target, format, 32);
    await assert.rejects(
      run(scriptNode(), [
        "scripts/package-native.ts",
        "--allow-missing-parser-addon",
        "--target",
        target,
        "--bin-dir",
        binaries,
        "--out-dir",
        artifacts,
      ]),
      /object target mismatch.*32-bit/s,
    );
  }
});

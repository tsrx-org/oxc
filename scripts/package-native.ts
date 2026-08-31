import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { NATIVE_TARGETS, nativePackageName } from "../packages/toolchain/dist/native-targets.js";
import { resolveNpmInvocation } from "../tests/helpers/npm-invocation.mjs";
import { parseNpmPackResponse } from "../tests/helpers/npm-pack-response.mjs";

const root = resolve(import.meta.dirname, "..");
const revision = "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40";
// One multi-call executable carries all three tools. Three separate binaries
// linked the same oxc parser, linter, and formatter three times, so a platform
// package was a little over twice the download it needed to be.
const binaryStems = ["oxc-tsrx"];
// Every tool the single binary still answers to, and the subcommand that
// selects it. `--version` prints the old per-tool identity for each, so the
// staged artifact is checked for all three before it is packed.
const tools = [
  { name: "oxc-tsrx", subcommand: [] },
  { name: "oxc-tsrx-fmt", subcommand: ["fmt"] },
  { name: "oxc-tsrx-lsp", subcommand: ["lsp"] },
];

function parseArguments(argv): any {
  const options = { "allow-missing-parser-addon": false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-missing-parser-addon") {
      options["allow-missing-parser-addon"] = true;
      continue;
    }
    if (!["--target", "--bin-dir", "--out-dir", "--parser-addon"].includes(argument)) {
      throw new Error(`unsupported option: ${argument}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    options[argument.slice(2)] = value;
  }
  for (const name of ["target", "bin-dir", "out-dir"]) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
  // 0.1.0 shipped every native package without parser.node because this was
  // optional and the release never passed it. npm honoured the generated
  // `files` list, dropped the addon from the tarball, and `oxc-tsrx/parser`
  // then failed ERR_TSRX_NATIVE_INTEGRITY on every consumer machine. A package
  // missing the addon is not installable, so refuse to build one by default.
  if (!options["parser-addon"] && !options["allow-missing-parser-addon"]) {
    throw new Error(
      "--parser-addon is required: a native package without parser.node fails " +
        "the loader's integrity check on every consumer. Pass " +
        "--allow-missing-parser-addon only for local binary-only experiments, " +
        "never for anything published.",
    );
  }
  return options;
}

function run(executable, args, options: any = {}) {
  return new Promise<any>((resolveRun, rejectRun) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
        else resolveRun({ stdout, stderr });
      },
    );
  });
}

function rustHost(verboseVersion) {
  return /^host:\s*(\S+)$/mu.exec(verboseVersion)?.[1] ?? null;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function requireBytes(contents, length, format) {
  if (contents.length < length) {
    throw new Error(`invalid ${format} executable: expected at least ${length} header bytes`);
  }
}

function cpuName(value, format) {
  const architectures = {
    "mach-o": new Map([
      [0x01000007, "x64"],
      [0x0100000c, "arm64"],
    ]),
    elf: new Map([
      [62, "x64"],
      [183, "arm64"],
    ]),
    pe: new Map([
      [0x8664, "x64"],
      [0xaa64, "arm64"],
    ]),
  };
  return architectures[format].get(value) ?? `unknown-0x${value.toString(16)}`;
}

function inspectMachO(contents, magic, imageKind) {
  const thin = new Map([
    ["cefaedfe", { endian: "little", bits: 32 }],
    ["cffaedfe", { endian: "little", bits: 64 }],
    ["feedface", { endian: "big", bits: 32 }],
    ["feedfacf", { endian: "big", bits: 64 }],
  ]);
  const thinHeader = thin.get(magic);
  if (thinHeader) {
    requireBytes(contents, 16, "Mach-O");
    const readU32 =
      thinHeader.endian === "little"
        ? contents.readUInt32LE.bind(contents)
        : contents.readUInt32BE.bind(contents);
    const cpu = readU32(4);
    const fileType = readU32(12);
    const valid = imageKind === "dynamic-library" ? [6, 8] : [2];
    if (!valid.includes(fileType)) {
      throw new Error(
        imageKind === "dynamic-library"
          ? `invalid Mach-O dynamic library: file type ${fileType} is not MH_DYLIB or MH_BUNDLE`
          : `invalid Mach-O executable: file type ${fileType} is not MH_EXECUTE`,
      );
    }
    return {
      format: "mach-o",
      ...(imageKind === "dynamic-library" ? { imageKind } : {}),
      os: "darwin",
      bits: thinHeader.bits,
      architectures: [cpuName(cpu, "mach-o")],
    };
  }

  const fat = new Map([
    ["cafebabe", { endian: "big", recordBytes: 20 }],
    ["bebafeca", { endian: "little", recordBytes: 20 }],
    ["cafebabf", { endian: "big", recordBytes: 32 }],
    ["bfbafeca", { endian: "little", recordBytes: 32 }],
  ]).get(magic);
  if (!fat) return null;
  requireBytes(contents, 8, "fat Mach-O");
  const readU32 =
    fat.endian === "little"
      ? contents.readUInt32LE.bind(contents)
      : contents.readUInt32BE.bind(contents);
  const count = readU32(4);
  if (count === 0 || count > 64) {
    throw new Error(`invalid fat Mach-O executable: architecture count ${count}`);
  }
  requireBytes(contents, 8 + count * fat.recordBytes, "fat Mach-O");
  const architectures = new Set();
  for (let index = 0; index < count; index += 1) {
    architectures.add(cpuName(readU32(8 + index * fat.recordBytes), "mach-o"));
  }
  return {
    format: "mach-o",
    ...(imageKind === "dynamic-library" ? { imageKind } : {}),
    os: "darwin",
    bits: 64,
    architectures: [...architectures],
  };
}

function inspectElf(contents, imageKind) {
  if (contents.subarray(0, 4).toString("hex") !== "7f454c46") return null;
  requireBytes(contents, 20, "ELF");
  if (![1, 2].includes(contents[4])) {
    throw new Error(`invalid ELF executable: unsupported class ${contents[4]}`);
  }
  const endian = contents[5];
  if (![1, 2].includes(endian)) {
    throw new Error(`invalid ELF executable: unsupported byte order ${endian}`);
  }
  const readU16 =
    endian === 1 ? contents.readUInt16LE.bind(contents) : contents.readUInt16BE.bind(contents);
  const fileType = readU16(16);
  const valid = imageKind === "dynamic-library" ? fileType === 3 : [2, 3].includes(fileType);
  if (!valid) {
    throw new Error(
      imageKind === "dynamic-library"
        ? `invalid ELF dynamic library: file type ${fileType} is not ET_DYN`
        : `invalid ELF executable: file type ${fileType} is not executable`,
    );
  }
  return {
    format: "elf",
    ...(imageKind === "dynamic-library" ? { imageKind } : {}),
    os: "linux",
    bits: contents[4] === 2 ? 64 : 32,
    architectures: [cpuName(readU16(18), "elf")],
  };
}

function inspectPe(contents, imageKind) {
  if (contents.subarray(0, 2).toString("ascii") !== "MZ") return null;
  requireBytes(contents, 0x40, "PE");
  const header = contents.readUInt32LE(0x3c);
  requireBytes(contents, header + 26, "PE");
  if (contents.subarray(header, header + 4).toString("hex") !== "50450000") {
    throw new Error("invalid PE executable: missing PE signature");
  }
  const characteristics = contents.readUInt16LE(header + 22);
  if ((characteristics & 0x0002) === 0) {
    throw new Error("invalid PE executable: executable-image flag is missing");
  }
  if (imageKind === "dynamic-library" && (characteristics & 0x2000) === 0) {
    throw new Error("invalid PE dynamic library: DLL flag is missing");
  }
  return {
    format: "pe",
    ...(imageKind === "dynamic-library" ? { imageKind } : {}),
    os: "win32",
    bits: contents.readUInt16LE(header + 24) === 0x20b ? 64 : 32,
    architectures: [cpuName(contents.readUInt16LE(header + 4), "pe")],
  };
}

function inspectExecutable(contents) {
  requireBytes(contents, 4, "native");
  const magic = contents.subarray(0, 4).toString("hex");
  const identity =
    inspectMachO(contents, magic, "executable") ??
    inspectElf(contents, "executable") ??
    inspectPe(contents, "executable");
  if (!identity) throw new Error(`unsupported executable header 0x${magic}`);
  return identity;
}

function inspectAddon(contents) {
  requireBytes(contents, 4, "native");
  const magic = contents.subarray(0, 4).toString("hex");
  const identity =
    inspectMachO(contents, magic, "dynamic-library") ??
    inspectElf(contents, "dynamic-library") ??
    inspectPe(contents, "dynamic-library");
  if (!identity) throw new Error(`unsupported dynamic-library header 0x${magic}`);
  return identity;
}

function assertObjectTarget(name, identity, platform) {
  const format = { darwin: "mach-o", linux: "elf", win32: "pe" }[platform.os];
  if (
    identity.format !== format ||
    identity.os !== platform.os ||
    identity.bits !== 64 ||
    !identity.architectures.includes(platform.cpu)
  ) {
    throw new Error(
      `${name} object target mismatch: expected ${platform.target} ` +
        `(${format}/${platform.os}/${platform.cpu}), found ` +
        `${identity.format}/${identity.os}/${identity.bits}-bit/${identity.architectures.join("+")}`,
    );
  }
}

function assertAddonTarget(name, identity, platform) {
  assertObjectTarget(name, identity, platform);
  if (
    identity.imageKind !== "dynamic-library" ||
    identity.architectures.length !== 1 ||
    identity.architectures[0] !== platform.cpu
  ) {
    throw new Error(
      `${name} addon target mismatch: expected one ${platform.cpu} dynamic library, found ` +
        `${identity.imageKind ?? "unknown"}/${identity.architectures.join("+")}`,
    );
  }
}

const options = parseArguments(process.argv.slice(2));
const platform = NATIVE_TARGETS.find((candidate) => candidate.target === options.target);
if (!platform) throw new Error(`unsupported Rust target: ${options.target}`);

const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const runtimeManifest = JSON.parse(
  await readFile(join(root, "packages/toolchain/package.json"), "utf8"),
);
if (rootManifest.version !== runtimeManifest.version) {
  throw new Error(
    `root/runtime version mismatch: ${rootManifest.version} != ${runtimeManifest.version}`,
  );
}
const version = rootManifest.version;
const packageName = nativePackageName(platform);
const binDirectory = resolve(root, options["bin-dir"]);
const outDirectory = resolve(root, options["out-dir"]);
await mkdir(outDirectory, { recursive: true });
const stage = await mkdtemp(join(tmpdir(), "oxc-tsrx-native-package-"));

try {
  const rustc = await run("rustc", ["-vV"]);
  const executableSuffix = platform.os === "win32" ? ".exe" : "";
  const binaries = {};
  await mkdir(join(stage, "bin"), { recursive: true });
  for (const stem of binaryStems) {
    const name = `${stem}${executableSuffix}`;
    const source = join(binDirectory, name);
    const metadata = await stat(source).catch(() => null);
    if (!metadata?.isFile()) {
      throw new Error(`required release binary is missing: ${source}`);
    }
    const destination = join(stage, "bin", name);
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
    if (platform.os !== "win32") await chmod(destination, 0o755);
    const staged = await stat(destination);
    const contents = await readFile(destination);
    const object = inspectExecutable(contents);
    assertObjectTarget(name, object, platform);
    binaries[name] = {
      sha256: sha256(contents),
      bytes: staged.size,
      object,
    };
  }

  const host = rustHost(rustc.stdout);
  const executable = join(stage, "bin", `oxc-tsrx${executableSuffix}`);
  if (host === platform.target) {
    for (const tool of tools) {
      const { stdout, stderr } = await run(executable, [...tool.subcommand, "--version"]);
      if (stderr || stdout !== `${tool.name} ${version} (OXC ${revision})\n`) {
        throw new Error(`unexpected ${tool.name} version identity: ${stdout}${stderr}`);
      }
    }
  }

  let addonRecord = null;
  if (options["parser-addon"]) {
    const source = resolve(root, options["parser-addon"]);
    const sourceStat = await lstat(source).catch(() => null);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`required parser addon must be a regular non-symlink file: ${source}`);
    }
    const destination = join(stage, "parser.node");
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
    const contents = await readFile(destination);
    const object = { ...inspectAddon(contents), libc: platform.libc ?? null };
    assertAddonTarget("parser.node", object, platform);
    const capabilities = {
      lazy: true,
      async: true,
      editorRecovery: true,
      cssMaterialization: false,
      rawTransfer: false,
    };
    addonRecord = {
      packageVersion: version,
      target: platform.target,
      bytes: contents.length,
      sha256: sha256(contents),
      object,
      nodeApi: 8,
      oxcRevision: revision,
      capabilities,
      role: "canonical-parser",
      file: "parser.node",
      apiVersion: 1,
      transportAbi: 1,
    };
    if (host === platform.target) {
      // Load the addon in a child process, never in this one. Windows keeps a
      // native module mapped for the lifetime of the process that required it,
      // so requiring it here made the staging cleanup below fail with EPERM and
      // Windows parser-addon packaging could never succeed. A child also means a
      // broken addon cannot take the packager down with it.
      const probe = [
        "const binding = require(process.argv[1]);",
        "process.stdout.write(JSON.stringify({",
        "  keys: Object.keys(binding).sort(),",
        "  nodeApi: binding.nodeApi(),",
        "}));",
      ].join("\n");
      const { stdout } = await run(process.execPath, ["-e", probe, destination]);
      const binding = JSON.parse(stdout);
      const keys = binding.keys;
      if (JSON.stringify(keys) !== JSON.stringify(["nodeApi", "parse", "parseSync"])) {
        throw new Error(`unexpected parser.node exports: ${keys.join(",")}`);
      }
      if (binding.nodeApi !== addonRecord.nodeApi) {
        throw new Error(`unexpected parser.node Node-API identity: ${binding.nodeApi}`);
      }
    }
  }

  const manifest = {
    name: packageName,
    version,
    description: `OXC for TSRX native binaries${addonRecord ? " and parser addon" : ""} for ${platform.target}`,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/tsrx-org/oxc.git",
      directory: "packages/native",
    },
    homepage: "https://github.com/tsrx-org/oxc#readme",
    bugs: { url: "https://github.com/tsrx-org/oxc/issues" },
    keywords: ["oxc", "oxlint", "oxfmt", "tsrx", "native"],
    files: [
      "bin",
      ...(addonRecord ? ["parser.node"] : []),
      "checksums.json",
      "licenses",
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
    ],
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc ? { libc: [platform.libc] } : {}),
    engines: { node: "^20.19.0 || >=22.12.0" },
    preferUnplugged: true,
    publishConfig: { access: "public", provenance: true },
    oxcTsrx: {
      schemaVersion: addonRecord ? 2 : 1,
      // Protocol 2 is the single multi-call executable. A protocol-1 consumer
      // would spawn `bin/oxc-tsrx-fmt`, which no longer exists.
      nativeProtocolVersion: 2,
      target: platform.target,
      vscodeTarget: platform.vscodeTarget,
      oxcRevision: revision,
      binaries: binaryStems.map((stem) => `${stem}${executableSuffix}`),
      ...(addonRecord ? { addons: { "parser.node": addonRecord } } : {}),
    },
  };
  const checksums = {
    schemaVersion: addonRecord ? 2 : 1,
    packageName,
    version,
    target: platform.target,
    oxcRevision: revision,
    rustc: rustc.stdout.trim(),
    objectVerification: addonRecord ? "executable-and-dynamic-library-header" : "executable-header",
    verification: host === platform.target ? "host-executed" : "cross-artifact",
    binaries,
    ...(addonRecord ? { addons: { "parser.node": addonRecord } } : {}),
  };
  await Promise.all([
    writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(stage, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`),
    copyFile(join(root, "LICENSE"), join(stage, "LICENSE")),
    copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(stage, "THIRD_PARTY_NOTICES.md")),
    copyFile(join(root, "packages/native/README.md"), join(stage, "README.md")),
    cp(join(root, "licenses"), join(stage, "licenses"), { recursive: true }),
  ]);

  const npmEnvironment = { ...process.env, npm_config_cache: join(stage, ".npm-cache") };
  const npmInvocation = resolveNpmInvocation(
    ["pack", "--json", "--pack-destination", outDirectory],
    { cwd: stage, env: npmEnvironment },
  );
  const { stdout } = await run(npmInvocation.executable, npmInvocation.args, {
    cwd: stage,
    env: npmEnvironment,
  });
  const packed = parseNpmPackResponse(stdout);
  const tarball = join(outDirectory, packed.filename);
  // The language server is the multi-call binary under its `lsp` subcommand, so
  // the identity the VSIX and the release assembly cross-check is that binary.
  const lsp = binaries[`oxc-tsrx${executableSuffix}`];
  process.stdout.write(
    `${JSON.stringify({
      packageName,
      version,
      target: platform.target,
      vscodeTarget: platform.vscodeTarget,
      lspSha256: lsp.sha256,
      lspBytes: lsp.bytes,
      // POSIX separators, always: see the same note in package-vscode.ts. The
      // filename is derived here, on the host that owns the native path.
      tarball: tarball.replaceAll("\\", "/"),
      filename: basename(tarball),
      integrity: packed.integrity,
      shasum: packed.shasum,
      unpackedSize: packed.unpackedSize,
      parserAddon: addonRecord !== null,
    })}\n`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}

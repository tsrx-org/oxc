import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NATIVE_TARGETS, nativeTargetForHost } from "../packages/toolchain/dist/native-targets.js";

const root = resolve(import.meta.dirname, "..");
const OXC_REVISION = "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40";

function parseArguments(argv) {
  const options = {
    out: "packages/toolchain/parser.node",
    record: null,
    "target-dir": "target",
    "skip-build": false,
    // Defaults to the host. The release matrix cross-compiles, so it passes an
    // explicit triple and the addon must follow the binary it ships beside.
    target: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skip-build") {
      options["skip-build"] = true;
      continue;
    }
    if (!["--out", "--record", "--target-dir", "--target"].includes(argument)) {
      throw new Error(`unsupported option: ${argument}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    options[argument.slice(2)] = value;
  }
  return options;
}

function run(executable, args, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      args,
      { cwd: root, env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
        else resolveRun({ stdout, stderr });
      },
    );
  });
}

function releaseLibrary(os) {
  if (os === "darwin") return "libparser_napi_binding.dylib";
  if (os === "linux") return "libparser_napi_binding.so";
  if (os === "win32") return "parser_napi_binding.dll";
  throw new Error(`unsupported parser addon target os ${os}`);
}

function linuxLibc() {
  if (process.platform !== "linux") return undefined;
  const report = process.report?.getReport?.() as any;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function expectedObject(target) {
  return {
    format: { darwin: "mach-o", linux: "elf", win32: "pe" }[target.os],
    imageKind: "dynamic-library",
    bits: 64,
    architectures: [target.cpu],
    os: target.os,
    libc: target.libc ?? null,
  };
}

const options = parseArguments(process.argv.slice(2));
if (!options.out.endsWith(".node")) throw new Error("--out must end in .node");

// An explicit --target must name a triple this project actually publishes,
// otherwise the addon would be built for a platform no native package exists
// for and the mismatch would only surface at require() time on a user machine.
const target = options.target === null
  ? nativeTargetForHost(process.platform, process.arch, linuxLibc())
  : NATIVE_TARGETS.find((candidate) => candidate.target === options.target);
if (target === undefined) {
  throw new Error(`unsupported parser addon target: ${options.target}`);
}

// Rust's musl targets default to a fully static CRT, and a static target cannot
// produce a cdylib at all: cargo refuses with "does not support these crate
// types". A Node addon has to be a dynamic library, so the musl addon is built
// against the dynamic musl CRT instead. Node on Alpine is itself musl-linked and
// supplies that loader. This applies only to the addon: the shipped executables
// are a separate cargo invocation and stay statically linked, which the release
// workflow verifies with its own ABI policy check.
const cargoEnvironment = target.libc === "musl"
  ? {
      ...process.env,
      RUSTFLAGS: `${process.env.RUSTFLAGS ?? ""} -C target-feature=-crt-static`.trim(),
    }
  : process.env;

if (!options["skip-build"]) {
  await run(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--offline",
      "-p",
      "parser_napi_binding",
      ...(options.target === null ? [] : ["--target", options.target]),
    ],
    cargoEnvironment,
  );
}

const targetDirectory = isAbsolute(options["target-dir"])
  ? options["target-dir"]
  : resolve(root, options["target-dir"]);
// Cargo nests cross-compiled output under the triple; a host build does not.
const source = join(
  targetDirectory,
  ...(options.target === null ? [] : [options.target]),
  "release",
  releaseLibrary(target.os),
);
const sourceStat = await stat(source).catch(() => null);
if (!sourceStat?.isFile()) {
  throw new Error(`release parser addon is missing: ${source}`);
}

const destination = isAbsolute(options.out) ? options.out : resolve(root, options.out);
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination, constants.COPYFILE_FICLONE);
const contents = await readFile(destination);
const parserManifest = JSON.parse(
  await readFile(resolve(root, "packages/toolchain/package.json"), "utf8"),
);
const record = {
  packageVersion: parserManifest.version,
  target: target.target,
  bytes: contents.length,
  sha256: createHash("sha256").update(contents).digest("hex"),
  object: expectedObject(target),
  nodeApi: 8,
  oxcRevision: OXC_REVISION,
  capabilities: {
    lazy: true,
    async: true,
    editorRecovery: true,
    cssMaterialization: false,
    rawTransfer: false,
  },
  role: "canonical-parser",
  file: "parser.node",
  apiVersion: 1,
  transportAbi: 1,
};
const recordDestination = options.record === null
  ? `${destination}.json`
  : isAbsolute(options.record)
    ? options.record
    : resolve(root, options.record);
await mkdir(dirname(recordDestination), { recursive: true });
await writeFile(recordDestination, `${JSON.stringify(record, null, 2)}\n`, "utf8");

process.stdout.write(
  `${JSON.stringify({
    target: target.target,
    source,
    out: destination,
    record: recordDestination,
    bytes: record.bytes,
    sha256: record.sha256,
  })}\n`,
);

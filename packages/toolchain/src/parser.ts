import { createRequire } from "node:module";
import {
  isTsrxBinaryProgram,
  parseTrustedTsrxProgram,
  parseTsrxProgram,
} from "./tsrx-transfer.js";
import { NATIVE_TARGETS, nativePackageName, nativeTargetForHost } from "./native-targets.js";

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = "0.8.0";
const parserManifest = Object.freeze({
  name: "@tsrx/oxc",
  version: PACKAGE_VERSION,
  dependencies: Object.freeze({ "@oxc-project/types": "0.140.0" }),
  optionalDependencies: Object.freeze(
    Object.fromEntries(
      NATIVE_TARGETS.map((target) => [nativePackageName(target), PACKAGE_VERSION]),
    ),
  ),
});

const API_VERSION = 1;
const TRANSPORT_ABI = 1;
const NODE_API = 8;
// Protocol 2 is the single multi-call native executable that replaced the
// separate `oxc-tsrx`, `oxc-tsrx-fmt`, and `oxc-tsrx-lsp` binaries.
const NATIVE_PROTOCOL_VERSION = 2;
const OXC_REVISION = "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40";
const NODE_ENGINE = "^20.19.0 || >=22.12.0";
const ADDON_FILE = "parser.node";
const ADDON_ROLE = "canonical-parser";
const NATIVE_FILES = Object.freeze([
  "bin",
  "parser.node",
  "checksums.json",
  "licenses",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
]);
const NATIVE_KEYS = Object.freeze(["nodeApi", "parse", "parseSync"]);
const LANGUAGES = Object.freeze(["js", "jsx", "ts", "tsx", "dts", "tsrx"]);
const ERROR_CODES = new Set([
  "ERR_TSRX_INVALID_ARGUMENT",
  "ERR_TSRX_UNSUPPORTED_TARGET",
  "ERR_TSRX_NATIVE_NOT_INSTALLED",
  "ERR_TSRX_NATIVE_INTEGRITY",
  "ERR_TSRX_NATIVE_VERSION",
  "ERR_TSRX_CAPABILITY_RECOVERY",
  "ERR_TSRX_CAPABILITY_CSS",
  "ERR_TSRX_CAPABILITY_RAW_TRANSFER",
  "ERR_TSRX_RESOURCE_EXHAUSTED",
  "ERR_TSRX_CANCELLED",
]);

const ROUTE_INFER_ORDINARY = 0;
const ROUTE_JAVASCRIPT = 1;
const ROUTE_JAVASCRIPT_REACT = 2;
const ROUTE_TYPESCRIPT = 3;
const ROUTE_TYPESCRIPT_REACT = 4;
const ROUTE_TYPESCRIPT_DEFINITION = 5;
const ROUTE_TSRX = 6;
const ROUTE_TSRX_CORE_COMPAT = 7;
const TSRX_CORE_COMPAT_EAGER = Symbol.for("@oxc-tsrx/parser/tsrx-core-compat-eager");
const ASCII_SOURCE = /^[\x00-\x7f]+$/u;

const ROUTES = Object.freeze({
  js: ROUTE_JAVASCRIPT,
  jsx: ROUTE_JAVASCRIPT_REACT,
  ts: ROUTE_TYPESCRIPT,
  tsx: ROUTE_TYPESCRIPT_REACT,
  dts: ROUTE_TYPESCRIPT_DEFINITION,
  tsrx: ROUTE_TSRX,
});

export class ParserOperationalError extends Error {
  constructor(code, message, options) {
    super(message, options);
    Object.defineProperties(this, {
      name: {
        value: "ParserOperationalError",
        configurable: true,
        writable: true,
      },
      code: {
        value: code,
        enumerable: true,
      },
    });
  }
}

function linuxLibc() {
  if (process.platform !== "linux") return undefined;
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function selectedHostTarget() {
  try {
    return nativeTargetForHost(process.platform, process.arch, linuxLibc());
  } catch {
    return null;
  }
}

const hostTarget = selectedHostTarget();

export const capabilities = Object.freeze({
  apiVersion: API_VERSION,
  languages: LANGUAGES,
  target: hostTarget?.target ?? `${process.platform}-${process.arch}`,
  nodeApi: NODE_API,
  nodeEngine: NODE_ENGINE,
  oxcRevision: OXC_REVISION,
  lazy: true,
  async: true,
  editorRecovery: false,
  cssMaterialization: false,
  rawTransfer: false,
});

function describe(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function operational(code, subject, expected, actual, cause) {
  return new ParserOperationalError(
    code,
    `${subject}: expected ${describe(expected)}; actual ${describe(actual)}`,
    cause === undefined ? undefined : { cause },
  );
}

function fail(code, subject, expected, actual, cause?: any) {
  throw operational(code, subject, expected, actual, cause);
}

function exactKeys(value, expected, subject, code = "ERR_TSRX_NATIVE_VERSION") {
  const actual =
    value !== null && typeof value === "object" ? Object.keys(value).sort() : typeof value;
  const sortedExpected = [...expected].sort();
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    fail(code, subject, sortedExpected, actual);
  }
}

function exactValue(actual, expected, subject, code = "ERR_TSRX_NATIVE_VERSION") {
  const { isDeepStrictEqual } = require("node:util");
  if (!isDeepStrictEqual(actual, expected)) {
    fail(code, subject, expected, actual);
  }
}

function requireBytes(contents, length, subject) {
  if (contents.length < length) {
    fail("ERR_TSRX_NATIVE_INTEGRITY", subject, `at least ${length} header bytes`, contents.length);
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

function inspectMachO(contents, magic) {
  const thin = new Map([
    ["cefaedfe", { endian: "little", bits: 32 }],
    ["cffaedfe", { endian: "little", bits: 64 }],
    ["feedface", { endian: "big", bits: 32 }],
    ["feedfacf", { endian: "big", bits: 64 }],
  ]).get(magic);
  if (thin === undefined) return null;
  requireBytes(contents, 16, "Mach-O parser addon");
  const readU32 =
    thin.endian === "little"
      ? contents.readUInt32LE.bind(contents)
      : contents.readUInt32BE.bind(contents);
  const fileType = readU32(12);
  if (fileType !== 6 && fileType !== 8) {
    fail(
      "ERR_TSRX_NATIVE_INTEGRITY",
      "Mach-O parser addon image kind",
      "MH_DYLIB or MH_BUNDLE",
      fileType,
    );
  }
  return {
    format: "mach-o",
    imageKind: "dynamic-library",
    bits: thin.bits,
    architectures: [cpuName(readU32(4), "mach-o")],
    os: "darwin",
  };
}

function inspectElf(contents) {
  if (contents.subarray(0, 4).toString("hex") !== "7f454c46") return null;
  requireBytes(contents, 20, "ELF parser addon");
  const bits = contents[4] === 2 ? 64 : contents[4] === 1 ? 32 : null;
  const endian = contents[5];
  if (bits === null || (endian !== 1 && endian !== 2)) {
    fail(
      "ERR_TSRX_NATIVE_INTEGRITY",
      "ELF parser addon header",
      "supported class and byte order",
      { class: contents[4], endian },
    );
  }
  const readU16 =
    endian === 1 ? contents.readUInt16LE.bind(contents) : contents.readUInt16BE.bind(contents);
  if (readU16(16) !== 3) {
    fail("ERR_TSRX_NATIVE_INTEGRITY", "ELF parser addon image kind", "ET_DYN", readU16(16));
  }
  return {
    format: "elf",
    imageKind: "dynamic-library",
    bits,
    architectures: [cpuName(readU16(18), "elf")],
    os: "linux",
  };
}

function inspectPe(contents) {
  if (contents.subarray(0, 2).toString("ascii") !== "MZ") return null;
  requireBytes(contents, 0x40, "PE parser addon");
  const header = contents.readUInt32LE(0x3c);
  requireBytes(contents, header + 26, "PE parser addon");
  if (contents.subarray(header, header + 4).toString("hex") !== "50450000") {
    fail("ERR_TSRX_NATIVE_INTEGRITY", "PE parser addon signature", "PE\\0\\0", "missing");
  }
  const characteristics = contents.readUInt16LE(header + 22);
  if ((characteristics & 0x0002) === 0 || (characteristics & 0x2000) === 0) {
    fail(
      "ERR_TSRX_NATIVE_INTEGRITY",
      "PE parser addon image kind",
      "executable DLL",
      `0x${characteristics.toString(16)}`,
    );
  }
  return {
    format: "pe",
    imageKind: "dynamic-library",
    bits: contents.readUInt16LE(header + 24) === 0x020b ? 64 : 32,
    architectures: [cpuName(contents.readUInt16LE(header + 4), "pe")],
    os: "win32",
  };
}

function inspectAddon(contents, target) {
  requireBytes(contents, 4, "parser addon");
  const magic = contents.subarray(0, 4).toString("hex");
  const object = inspectMachO(contents, magic) ?? inspectElf(contents) ?? inspectPe(contents);
  if (object === null) {
    fail("ERR_TSRX_NATIVE_INTEGRITY", "parser addon object format", "Mach-O, ELF, or PE", magic);
  }
  return { ...object, libc: target.libc ?? null };
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

function expectedCapabilities() {
  return {
    lazy: true,
    async: true,
    editorRecovery: false,
    cssMaterialization: false,
    rawTransfer: false,
  };
}

function expectedBinaries(target) {
  const suffix = target.os === "win32" ? ".exe" : "";
  return [`oxc-tsrx${suffix}`];
}

function validateAddonRecord(record, target, subject) {
  exactKeys(
    record,
    [
      "packageVersion",
      "target",
      "bytes",
      "sha256",
      "object",
      "nodeApi",
      "oxcRevision",
      "capabilities",
      "role",
      "file",
      "apiVersion",
      "transportAbi",
    ],
    `${subject} fields`,
  );
  exactValue(record.packageVersion, parserManifest.version, `${subject} package version`);
  exactValue(record.target, target.target, `${subject} target`);
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) {
    fail("ERR_TSRX_NATIVE_INTEGRITY", `${subject} byte length`, "a positive safe integer", record.bytes);
  }
  if (!/^[0-9a-f]{64}$/u.test(record.sha256 ?? "")) {
    fail("ERR_TSRX_NATIVE_INTEGRITY", `${subject} SHA-256`, "64 lowercase hex characters", record.sha256);
  }
  exactValue(record.object, expectedObject(target), `${subject} object identity`, "ERR_TSRX_NATIVE_INTEGRITY");
  exactValue(record.nodeApi, NODE_API, `${subject} Node-API`);
  exactValue(record.oxcRevision, OXC_REVISION, `${subject} OXC revision`);
  exactValue(record.capabilities, expectedCapabilities(), `${subject} capabilities`);
  exactValue(record.role, ADDON_ROLE, `${subject} role`);
  exactValue(record.file, ADDON_FILE, `${subject} filename`);
  exactValue(record.apiVersion, API_VERSION, `${subject} API version`);
  exactValue(record.transportAbi, TRANSPORT_ABI, `${subject} transport ABI`);
}

function validateParserManifest(target) {
  const expectedName = nativePackageName(target);
  exactValue(
    parserManifest.optionalDependencies?.[expectedName],
    parserManifest.version,
    "parser optional native dependency version",
  );
  const dependencyNames = Object.keys(parserManifest.dependencies ?? {});
  if (dependencyNames.some((name) => name.includes("compat"))) {
    fail(
      "ERR_TSRX_NATIVE_INTEGRITY",
      "parser dependency family",
      "no compatibility dependency",
      dependencyNames,
    );
  }
}

function readJson(path, subject) {
  const { readFileSync } = require("node:fs");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail("ERR_TSRX_NATIVE_INTEGRITY", subject, "readable valid JSON", cause?.message, cause);
  }
}

function loadAddon(path, target, expectedRecord = null) {
  const { createHash } = require("node:crypto");
  const { lstatSync, readFileSync } = require("node:fs");
  let stat;
  let contents;
  try {
    stat = lstatSync(path);
    contents = readFileSync(path);
  } catch (cause) {
    fail("ERR_TSRX_NATIVE_INTEGRITY", "parser addon file", "a readable regular file", cause?.message, cause);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(
      "ERR_TSRX_NATIVE_INTEGRITY",
      "parser addon file kind",
      "a regular non-symbolic-link file",
      { file: stat.isFile(), symlink: stat.isSymbolicLink() },
    );
  }
  const object = inspectAddon(contents, target);
  exactValue(object, expectedObject(target), "parser addon object identity", "ERR_TSRX_NATIVE_INTEGRITY");
  if (expectedRecord !== null) {
    exactValue(contents.length, expectedRecord.bytes, "parser addon byte length", "ERR_TSRX_NATIVE_INTEGRITY");
    exactValue(
      createHash("sha256").update(contents).digest("hex"),
      expectedRecord.sha256,
      "parser addon SHA-256",
      "ERR_TSRX_NATIVE_INTEGRITY",
    );
  }

  let binding;
  try {
    binding = require(path);
  } catch (cause) {
    fail("ERR_TSRX_NATIVE_INTEGRITY", "parser addon load", "a loadable Node-API addon", cause?.message, cause);
  }
  exactValue(Object.keys(binding).sort(), NATIVE_KEYS, "parser addon exports");
  let actualNodeApi;
  try {
    actualNodeApi = binding.nodeApi();
  } catch (cause) {
    fail("ERR_TSRX_NATIVE_VERSION", "parser addon Node-API export", NODE_API, cause?.message, cause);
  }
  exactValue(actualNodeApi, NODE_API, "parser addon Node-API export");
  return binding;
}

function loadAdjacentAddon(path, target) {
  const record = readJson(`${path}.json`, "adjacent parser addon identity record");
  validateAddonRecord(record, target, "adjacent parser addon");
  return loadAddon(path, target, record);
}

function validateNativePackage(packageName, manifestPath, target) {
  const { dirname, join } = require("node:path");
  const manifest = readJson(manifestPath, `${packageName} manifest`);
  exactValue(manifest.name, packageName, "native package name");
  exactValue(manifest.version, parserManifest.version, "native package version");
  exactValue(manifest.os, [target.os], "native package OS");
  exactValue(manifest.cpu, [target.cpu], "native package CPU");
  exactValue(manifest.libc, target.libc === undefined ? undefined : [target.libc], "native package libc");
  exactValue(manifest.files, NATIVE_FILES, "native package files", "ERR_TSRX_NATIVE_INTEGRITY");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const names = Object.keys(manifest[field] ?? {});
    if (names.length !== 0) {
      fail("ERR_TSRX_NATIVE_INTEGRITY", `native package ${field}`, [], names);
    }
  }

  const metadata = manifest.oxcTsrx;
  exactKeys(
    metadata,
    [
      "schemaVersion",
      "nativeProtocolVersion",
      "target",
      "vscodeTarget",
      "oxcRevision",
      "binaries",
      "addons",
    ],
    "native package metadata fields",
  );
  exactValue(metadata.schemaVersion, 2, "native package schema version");
  exactValue(metadata.nativeProtocolVersion, NATIVE_PROTOCOL_VERSION, "native protocol version");
  exactValue(metadata.target, target.target, "native package Rust target");
  exactValue(metadata.vscodeTarget, target.vscodeTarget, "native package VS Code target");
  exactValue(metadata.oxcRevision, OXC_REVISION, "native package OXC revision");
  exactValue(metadata.binaries, expectedBinaries(target), "native package binaries");
  exactKeys(metadata.addons, [ADDON_FILE], "native package addon entries");
  validateAddonRecord(metadata.addons[ADDON_FILE], target, "native manifest addon");

  const packageRoot = dirname(manifestPath);
  const checksums = readJson(join(packageRoot, "checksums.json"), `${packageName} checksums`);
  exactValue(checksums.schemaVersion, 2, "native checksum schema version");
  exactValue(checksums.packageName, packageName, "native checksum package name");
  exactValue(checksums.version, parserManifest.version, "native checksum package version");
  exactValue(checksums.target, target.target, "native checksum Rust target");
  exactValue(checksums.oxcRevision, OXC_REVISION, "native checksum OXC revision");
  exactKeys(checksums.addons, [ADDON_FILE], "native checksum addon entries", "ERR_TSRX_NATIVE_INTEGRITY");
  const checksumRecord = checksums.addons[ADDON_FILE];
  validateAddonRecord(checksumRecord, target, "native checksum addon");

  for (const field of ["bytes", "sha256", "object"]) {
    exactValue(
      checksumRecord[field],
      metadata.addons[ADDON_FILE][field],
      `native addon ${field} metadata agreement`,
      "ERR_TSRX_NATIVE_INTEGRITY",
    );
  }
  for (const field of [
    "packageVersion",
    "target",
    "nodeApi",
    "oxcRevision",
    "capabilities",
    "role",
    "file",
    "apiVersion",
    "transportAbi",
  ]) {
    exactValue(
      checksumRecord[field],
      metadata.addons[ADDON_FILE][field],
      `native addon ${field} metadata agreement`,
    );
  }
  return loadAddon(join(packageRoot, ADDON_FILE), target, checksumRecord);
}

let nativeBinding;

function binding() {
  if (nativeBinding !== undefined) return nativeBinding;
  if (hostTarget === null) {
    fail(
      "ERR_TSRX_UNSUPPORTED_TARGET",
      "parser host target",
      "one of the eight supported Node targets",
      `${process.platform}-${process.arch}${linuxLibc() ? `-${linuxLibc()}` : ""}`,
    );
  }

  const { existsSync } = require("node:fs");
  const { dirname, join, resolve } = require("node:path");
  const { fileURLToPath } = require("node:url");
  const explicit = process.env.OXC_TSRX_PARSER_ADDON;
  if (explicit) {
    nativeBinding = loadAdjacentAddon(resolve(explicit), hostTarget);
    return nativeBinding;
  }
  // Avoid a dynamic `new URL(..., import.meta.url)` here. Vite treats that form as
  // an asset glob and attempts to import every string constant in this module,
  // including native-package inventory entries such as `LICENSE`.
  const adjacent = join(dirname(fileURLToPath(import.meta.url)), "..", ADDON_FILE);
  if (existsSync(adjacent)) {
    nativeBinding = loadAdjacentAddon(adjacent, hostTarget);
    return nativeBinding;
  }

  validateParserManifest(hostTarget);
  const packageName = nativePackageName(hostTarget);
  let manifestPath;
  try {
    manifestPath = require.resolve(`${packageName}/package.json`);
  } catch (cause) {
    fail(
      "ERR_TSRX_NATIVE_NOT_INSTALLED",
      "canonical parser native package",
      `${packageName}@${parserManifest.version}`,
      cause?.code ?? cause?.message,
      cause,
    );
  }
  nativeBinding = validateNativePackage(packageName, manifestPath, hostTarget);
  return nativeBinding;
}

function translateNativeError(error) {
  if (error instanceof ParserOperationalError) return error;
  const message = typeof error?.message === "string" ? error.message : String(error);
  const match = /\b(ERR_TSRX_[A-Z_]+):\s*([^\n]*)/u.exec(message);
  if (match !== null && ERROR_CODES.has(match[1])) {
    return new ParserOperationalError(match[1], match[2] || message, { cause: error });
  }
  return error;
}

function route(filename, options) {
  if (options?.experimentalRawTransfer) {
    fail(
      "ERR_TSRX_CAPABILITY_RAW_TRANSFER",
      "experimental raw transfer capability",
      true,
      capabilities.rawTransfer,
    );
  }
  if (options?.experimentalLazy) {
    fail(
      "ERR_TSRX_CAPABILITY_RAW_TRANSFER",
      "experimental lazy transport capability",
      true,
      capabilities.rawTransfer,
    );
  }
  const explicit = options?.lang;
  const explicitRoute = ROUTES[explicit];
  if (explicitRoute !== undefined) {
    return explicitRoute === ROUTE_TSRX && options?.[TSRX_CORE_COMPAT_EAGER] === true
      ? ROUTE_TSRX_CORE_COMPAT
      : explicitRoute;
  }
  return typeof filename === "string" && filename.endsWith(".tsrx")
    ? options?.[TSRX_CORE_COMPAT_EAGER] === true
      ? ROUTE_TSRX_CORE_COMPAT
      : ROUTE_TSRX
    : ROUTE_INFER_ORDINARY;
}

function applyFix(program, path) {
  let node = program;
  for (const key of path) node = node[key];
  if (node.bigint) {
    node.value = BigInt(node.bigint);
  } else {
    try {
      node.value = RegExp(node.regex.pattern, node.regex.flags);
    } catch {
      // Preserve OXC's JSON value when the host cannot construct this RegExp.
    }
  }
}

function parseOrdinaryProgram(programJson) {
  const { node: program, fixes } = JSON.parse(programJson);
  for (const path of fixes) applyFix(program, path);
  return program;
}

const RESULT_STATE = Symbol("@oxc-tsrx/parser result state");
const PROGRAM_READY = 1;
const MODULE_READY = 2;
const COMMENTS_READY = 4;
const ERRORS_READY = 8;

function initializeResult(state, ready, property, convert) {
  if ((state.ready & ready) === 0) {
    try {
      state[property] = convert(state.nativeResult[property]);
    } catch (error) {
      throw translateNativeError(error);
    }
    state.ready |= ready;
  }
  return state[property];
}

function programGetter() {
  const state = this[RESULT_STATE];
  return initializeResult(
    state,
    PROGRAM_READY,
    "program",
    state.ordinary ? parseOrdinaryProgram : parseTsrxProgram,
  );
}

function moduleGetter() {
  return initializeResult(this[RESULT_STATE], MODULE_READY, "module", (value) => value);
}

function commentsGetter() {
  return initializeResult(this[RESULT_STATE], COMMENTS_READY, "comments", (value) => value);
}

function errorsGetter() {
  return initializeResult(this[RESULT_STATE], ERRORS_READY, "errors", (value) => value);
}

const RESULT_DESCRIPTORS = Object.freeze({
  [RESULT_STATE]: Object.freeze({
    configurable: false,
    enumerable: false,
    writable: true,
    value: undefined,
  }),
  program: Object.freeze({ configurable: true, enumerable: true, get: programGetter }),
  module: Object.freeze({ configurable: true, enumerable: true, get: moduleGetter }),
  comments: Object.freeze({ configurable: true, enumerable: true, get: commentsGetter }),
  errors: Object.freeze({ configurable: true, enumerable: true, get: errorsGetter }),
});

function wrap(nativeResult, ordinary) {
  const result = Object.create(Object.prototype, RESULT_DESCRIPTORS);
  result[RESULT_STATE] = {
    nativeResult,
    ordinary,
    ready: 0,
    program: undefined,
    module: undefined,
    comments: undefined,
    errors: undefined,
  };
  return result;
}

function invoke(method, filename, sourceText, options, selectedRoute) {
  const native = binding();
  if (selectedRoute === ROUTE_TSRX || selectedRoute === ROUTE_TSRX_CORE_COMPAT) {
    const nativeOptions =
      selectedRoute === ROUTE_TSRX_CORE_COMPAT ? undefined : options;
    if (ASCII_SOURCE.test(sourceText)) {
      return native[method](filename, sourceText, undefined, nativeOptions, selectedRoute);
    }
    return native[method](filename, "", sourceText, nativeOptions, selectedRoute);
  }
  return native[method](filename, sourceText, undefined, options, selectedRoute);
}

export function parseSync(filename, sourceText, options) {
  try {
    const selectedRoute = route(filename, options);
    const nativeResult = invoke("parseSync", filename, sourceText, options, selectedRoute);
    if (selectedRoute === ROUTE_TSRX_CORE_COMPAT) {
      if (
        typeof nativeResult === "string" ||
        isTsrxBinaryProgram(nativeResult)
      ) {
        return parseTrustedTsrxProgram(nativeResult, true);
      }
      return {
        program: parseTsrxProgram(nativeResult.program),
        errors: nativeResult.errors,
      };
    }
    return wrap(
      nativeResult,
      selectedRoute !== ROUTE_TSRX,
    );
  } catch (error) {
    throw translateNativeError(error);
  }
}

export async function parse(filename, sourceText, options) {
  try {
    const routed = route(filename, options);
    const selectedRoute =
      routed === ROUTE_TSRX_CORE_COMPAT ? ROUTE_TSRX : routed;
    return wrap(
      await invoke("parse", filename, sourceText, options, selectedRoute),
      selectedRoute !== ROUTE_TSRX,
    );
  } catch (error) {
    throw translateNativeError(error);
  }
}

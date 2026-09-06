import { createRequire } from "node:module";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSpawnable, rejectConfiguredValue, resolveEditorLinter } from "./editor-resolution.js";

const COMPATIBILITY_SCHEMA = 1;

/**
 * The provider id, which is also this package's command name. It is written
 * into every facade's `oxcTsrxCompatibility.provider`, compared against on the
 * way back out, and named in the prose a user is told to type. It is *not* the
 * npm package name and never was: renaming the package left the id alone so
 * that facades a previous release wrote are still recognised as ours.
 */
const PROVIDER = "oxc-tsrx";

/** The published npm package name, which is what resolution and install paths speak. */
const PACKAGE_NAME = "@tsrx/oxc";

/** `PACKAGE_NAME` as path segments: a scoped name is two directories under `node_modules`. */
const PACKAGE_DIRECTORY = Object.freeze(PACKAGE_NAME.split("/"));

const DIRECT_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];
const SLOTS = Object.freeze([
  Object.freeze({
    name: "oxc-parser",
    capability: "parser",
    exportPath: "@tsrx/oxc/parser",
    binary: null,
  }),
  Object.freeze({
    name: "oxlint",
    capability: "lint",
    exportPath: "@tsrx/oxc/lint",
    binary: "oxlint",
  }),
  Object.freeze({
    name: "oxfmt",
    capability: "format",
    exportPath: "@tsrx/oxc/format",
    binary: "oxfmt",
  }),
]);

/**
 * The fourth slot. It is not a package: it is one key in the user's own
 * `.vscode/settings.json`, and it exists because `setup` fixing *package*
 * resolution does not fix the editor. The official OXC extension finds its
 * linter through `node_modules/.bin/oxlint`, and in a Vite+ project that shim
 * belongs to Vite+, which knows nothing about `.tsrx`. The result is an editor
 * with no diagnostics and nothing anywhere saying why.
 *
 * This is the one place `setup` writes outside `node_modules`, so every report
 * names the file it touched.
 */
const EDITOR_SLOT = Object.freeze({
  name: "oxc.path.oxlint",
  capability: "editor",
  key: "oxc.path.oxlint",
  directory: ".vscode",
  file: "settings.json",
});

/** Where `setup` records what it did to the user's settings file. */
const EDITOR_RECEIPT = [".oxc-tsrx-compat", "editor-slot.json"];

/**
 * The folder-scoping gap, which is the reason writing the key is not the same
 * thing as wiring the editor.
 *
 * `setup` writes at the project root, meaning the nearest `package.json`. VS
 * Code reads `.vscode/settings.json` only from a folder that is a workspace
 * root, never from a subfolder of one. Every monorepo and every nested app puts
 * a workspace root *above* the project root, and in that window the key that was
 * written is simply not read: the extension auto-detects, finds whichever tool
 * owns `node_modules/.bin/oxlint`, and says nothing.
 *
 * Nothing here writes into an ancestor on its own. A relative value is joined
 * onto the window's *first* folder rather than onto the folder holding the
 * settings file, the extension rejects any value containing `..`, and a
 * configured value replaces its own lookup with no fallback, so a value written
 * for a folder the user did not open leaves the linter dead rather than
 * degrading to auto-detection. Guessing wrong is strictly worse than not
 * guessing. So the ancestors are named, the evidence that made each one a
 * candidate is named with it, and `setup --workspace-root <dir>` is the single
 * explicit way to write above the project root.
 *
 * The order below is the order the evidence is trusted in, most deliberate
 * first: a `.code-workspace` file is someone stating the root outright, a
 * `.git` directory is the weakest hint and comes last.
 */
const WORKSPACE_ROOT_EVIDENCE = Object.freeze([
  "pnpm-workspace.yaml",
  "package.json",
  "turbo.json",
  "nx.json",
  "lerna.json",
  ".git",
  // Weakest evidence, ranked last: an installed project with no workspace
  // declaration at all. A folder holding a package.json next to a lockfile or
  // node_modules is still a folder someone opens in the editor - the Vite+
  // walkthrough manufactures exactly this shape above the project, with
  // --no-git so nothing stronger exists to notice it by.
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "node_modules",
]);

const LOCKFILE_EVIDENCE = Object.freeze([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
]);

const CODE_WORKSPACE_SUFFIX = ".code-workspace";

function evidenceRank(evidence) {
  if (evidence.endsWith(CODE_WORKSPACE_SUFFIX)) return -1;
  return WORKSPACE_ROOT_EVIDENCE.indexOf(evidence);
}

/**
 * The single file in `directory` that makes it look like a workspace root, or
 * `null`. Only the strongest one is reported: a repository root usually carries
 * three or four of these and listing them all buries the folder itself.
 */
async function workspaceRootEvidence(directory) {
  const entries = await readdir(directory).catch(() => []);
  const declared = entries
    .filter((name) => name.endsWith(CODE_WORKSPACE_SUFFIX))
    .sort();
  if (declared.length > 0) return declared[0];
  if (await exists(join(directory, "pnpm-workspace.yaml"))) return "pnpm-workspace.yaml";
  const manifest = await readJson(join(directory, "package.json")).catch(() => null);
  if (manifest && manifest.workspaces !== undefined) return "package.json";
  for (const name of ["turbo.json", "nx.json", "lerna.json", ".git"]) {
    if (await exists(join(directory, name))) return name;
  }
  // An installed project that declares nothing: a manifest sitting next to a
  // lockfile or node_modules. No marker above catches it (a scaffold made with
  // --no-git has no .git), yet it is precisely the folder a reader opens in
  // the editor, and opened there the project's own settings key does nothing.
  if (manifest) {
    for (const name of LOCKFILE_EVIDENCE) {
      if (await exists(join(directory, name))) return name;
    }
    if (await exists(join(directory, "node_modules"))) return "node_modules";
  }
  return null;
}

/**
 * Every folder strictly above `root` that looks like a workspace root, ordered
 * by how deliberate the evidence is and then nearest first.
 *
 * The walk stops at the user's home directory rather than at the filesystem
 * root. A dotfiles repository puts `.git` in `$HOME`, and reporting `$HOME` as a
 * candidate workspace root for every project on the machine would turn this
 * detection into noise that readers learn to skip.
 */
async function candidateWorkspaceRoots(root) {
  const home = homedir();
  const candidates = [];
  let directory = dirname(root);
  while (directory !== dirname(directory)) {
    if (directory === home) break;
    const evidence = await workspaceRootEvidence(directory);
    if (evidence) candidates.push({ path: directory, evidence });
    directory = dirname(directory);
  }
  return candidates.sort(
    (left, right) =>
      evidenceRank(left.evidence) - evidenceRank(right.evidence) ||
      right.path.length - left.path.length,
  );
}

/**
 * TSRX editor support that this package deliberately does not own. `.tsrx` as a
 * *language* belongs to the TSRX toolchain, so `setup` detects and reports these
 * and changes none of them.
 */
const TSRX_TYPESCRIPT_PLUGIN = "@tsrx/typescript-plugin";
const TSRX_FRAMEWORK_BINDINGS = Object.freeze([
  "@tsrx/react",
  "@tsrx/vue",
  "@tsrx/solid",
  "@tsrx/preact",
  "@tsrx/ripple",
  "octane",
]);
/**
 * `@tsrx/typescript-plugin` declares `peerDependencies.typescript: ^5.9.3`, and
 * `vp create` scaffolds TypeScript 6, so a stock Vite+ project sits outside the
 * plugin's supported range. That is a fact from the plugin's own manifest.
 *
 * What that mismatch actually causes is NOT asserted here. A stock scaffold with
 * TypeScript 6.0.3 was measured answering `hover: const legacy: number` three
 * times out of three, so this is reported as an unsupported combination rather
 * than as a known failure. Nothing here changes the version.
 */
const TYPESCRIPT_REQUIREMENT = ">=5.9 <6";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function toPosix(path) {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}

function within(root, candidate) {
  const offset = relative(root, candidate);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

async function realPathOrNull(path) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

// --- A tolerant reader for the user's own JSON --------------------------------
//
// `.vscode/settings.json` and `tsconfig.json` are JSON with comments, and VS
// Code also accepts trailing commas. This repository has no JSON5/JSONC
// dependency and this file must not acquire one, so the scanner below is the
// smallest thing that reads those two shapes: it knows strings, `//` and `/* */`
// comments, and structural punctuation, and nothing else. It is used two ways:
// to locate a top-level key by byte offset, so the settings file can be edited
// surgically and keep every comment and every byte this package does not own,
// and to strip comments and trailing commas before `JSON.parse` when only a
// value is wanted. Anything it cannot classify makes it return `null`, and every
// caller treats `null` as "refuse to touch this file".

const JSONC_PUNCTUATION = new Set(["{", "}", "[", "]", ",", ":"]);

function tokenizeJsonc(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === '"') {
          closed = true;
          break;
        }
        if (text[cursor] === "\n") break;
        cursor += 1;
      }
      if (!closed) return null;
      tokens.push({
        kind: "string",
        start: index,
        end: cursor + 1,
        text: text.slice(index, cursor + 1),
      });
      index = cursor + 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close === -1) return null;
      index = close + 2;
      continue;
    }
    if (JSONC_PUNCTUATION.has(character)) {
      tokens.push({ kind: character, start: index, end: index + 1, text: character });
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    let cursor = index;
    while (
      cursor < text.length &&
      !/[\s{}[\],:"]/u.test(text[cursor]) &&
      !(text[cursor] === "/" && (text[cursor + 1] === "/" || text[cursor + 1] === "*"))
    ) {
      cursor += 1;
    }
    if (cursor === index) return null;
    tokens.push({
      kind: "literal",
      start: index,
      end: cursor,
      text: text.slice(index, cursor),
    });
    index = cursor;
  }
  return tokens;
}

/** Comments and trailing commas removed, so `JSON.parse` can read the rest. */
function stripJsonc(text) {
  const tokens = tokenizeJsonc(text);
  if (!tokens) return null;
  let output = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === ",") {
      const next = tokens[index + 1];
      if (next && (next.kind === "}" || next.kind === "]")) continue;
    }
    output += token.text;
  }
  return output;
}

function parseJsoncValue(text) {
  const stripped = stripJsonc(text);
  if (stripped === null) return null;
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Every top-level entry of the document's object, with byte offsets. Returns
 * `null` for anything that is not a single top-level object, which is the shape
 * both settings files always have and the only shape this package will edit.
 */
// Reads the object whose opening `{` is `tokens[start]`. The top-level document
// is just the case where that is token 0, so `readTopLevelObject` is a wrapper
// that additionally insists the object is the whole file. Splitting it this way
// is what lets `compilerOptions` be edited as surgically as the top level:
// `plugins` has to be written one level down, and rewriting the document
// through `JSON.parse` would throw away every comment a scaffold ships.
function readObjectAt(tokens, start) {
  if (!tokens || tokens[start]?.kind !== "{") return null;
  const entries = [];
  let position = start + 1;
  while (position < tokens.length && tokens[position].kind !== "}") {
    const key = tokens[position];
    if (key.kind !== "string" || tokens[position + 1]?.kind !== ":") return null;
    const valueStart = position + 2;
    if (valueStart >= tokens.length) return null;
    let depth = 0;
    let valueEnd = -1;
    for (let scan = valueStart; scan < tokens.length; scan += 1) {
      const token = tokens[scan];
      if (token.kind === "{" || token.kind === "[") depth += 1;
      else if (token.kind === "}" || token.kind === "]") {
        depth -= 1;
        if (depth < 0) return null;
      }
      if (depth === 0) {
        valueEnd = scan;
        break;
      }
    }
    if (valueEnd === -1) return null;
    const comma = tokens[valueEnd + 1]?.kind === "," ? tokens[valueEnd + 1] : null;
    if (!comma && tokens[valueEnd + 1]?.kind !== "}") return null;
    let name;
    try {
      name = JSON.parse(key.text);
    } catch {
      return null;
    }
    entries.push({
      key: name,
      keyStart: key.start,
      valueStart: tokens[valueStart].start,
      valueEnd: tokens[valueEnd].end,
      valueTokens: tokens.slice(valueStart, valueEnd + 1),
      valueStartToken: valueStart,
      valueEndToken: valueEnd,
      commaEnd: comma ? comma.end : null,
    });
    position = comma ? valueEnd + 2 : valueEnd + 1;
  }
  if (tokens[position]?.kind !== "}") return null;
  return {
    entries,
    openEnd: tokens[start].end,
    closeStart: tokens[position].start,
    endToken: position,
  };
}

function readTopLevelObject(text) {
  const tokens = tokenizeJsonc(text);
  if (!tokens || tokens.length === 0) return null;
  const object = readObjectAt(tokens, 0);
  return object && object.endToken === tokens.length - 1 ? object : null;
}

// The `compilerOptions` object inside a tsconfig, located the same way, so
// `plugins` can be inserted into it without disturbing anything else in the
// file. Returns null unless the document is one object and `compilerOptions`
// is an object literal inside it, which is the only shape worth editing.
function readCompilerOptions(text) {
  const tokens = tokenizeJsonc(text);
  if (!tokens || tokens.length === 0) return null;
  const root = readObjectAt(tokens, 0);
  if (!root || root.endToken !== tokens.length - 1) return null;
  const entry = root.entries.find((candidate) => candidate.key === "compilerOptions");
  if (!entry) return null;
  const object = readObjectAt(tokens, entry.valueStartToken);
  return object && object.endToken === entry.valueEndToken ? object : null;
}

function stringEntryValue(entry) {
  if (entry.valueTokens.length !== 1 || entry.valueTokens[0].kind !== "string") return null;
  try {
    return JSON.parse(entry.valueTokens[0].text);
  } catch {
    return null;
  }
}

function detectIndent(text, structure) {
  const anchor = structure.entries[0]?.keyStart;
  if (anchor === undefined) return "  ";
  const lineStart = text.lastIndexOf("\n", anchor - 1) + 1;
  const prefix = text.slice(lineStart, anchor);
  return prefix.length > 0 && /^[\t ]*$/u.test(prefix) ? prefix : "  ";
}

function insertTopLevelEntry(text, structure, key, value) {
  return insertObjectEntry(text, structure, key, JSON.stringify(value));
}

// `rawValue` is already-rendered JSON rather than a value to stringify, because
// the tsconfig entry is written the way the documentation prints it rather than
// the way `JSON.stringify` would compact it.
function insertObjectEntry(text, structure, key, rawValue) {
  const indent = detectIndent(text, structure);
  const literal = `${JSON.stringify(key)}: ${rawValue}`;
  if (structure.entries.length === 0) {
    const inner = text.slice(structure.openEnd, structure.closeStart);
    if (inner.trim().length === 0) {
      return `${text.slice(0, structure.openEnd)}\n${indent}${literal}\n${text.slice(structure.closeStart)}`;
    }
  }
  const separator = structure.entries.length > 0 ? "," : "";
  return `${text.slice(0, structure.openEnd)}\n${indent}${literal}${separator}${text.slice(structure.openEnd)}`;
}

function removeTopLevelEntry(text, structure, key) {
  const index = structure.entries.findIndex((entry) => entry.key === key);
  if (index === -1) return text;
  const entry = structure.entries[index];
  let start = entry.keyStart;
  let end = entry.commaEnd ?? entry.valueEnd;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (/^[\t ]*$/u.test(text.slice(lineStart, start))) start = lineStart;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end += 1;
  if (text[end] === "\r") end += 1;
  if (text[end] === "\n") end += 1;
  const output = text.slice(0, start) + text.slice(end);
  // A last entry carries no comma of its own, so the previous entry's comma has
  // to go with it or the document gains a trailing comma it did not have. That
  // one character is deleted on its own rather than as part of the span, so any
  // comment written between the two entries survives.
  if (entry.commaEnd === null && index > 0) {
    const comma = structure.entries[index - 1].commaEnd;
    if (comma !== null && comma <= start) {
      return output.slice(0, comma - 1) + output.slice(comma);
    }
  }
  return output;
}

export async function findProjectRoot(start = process.cwd()) {
  let directory = resolve(start);
  try {
    if (!(await lstat(directory)).isDirectory()) directory = dirname(directory);
  } catch {
    throw new Error(`project path does not exist: ${directory}`);
  }
  for (;;) {
    if (await exists(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      // The same condition provider-resolve.js reports, in its wording, so
      // `oxc-tsrx status` and `oxc-tsrx providers` no longer describe one
      // failure two ways, plus the next step neither of them offered. `--project`
      // is already a documented flag on every subcommand that reaches here.
      throw new Error(
        `no package.json was found at or above ${resolve(start)}; run oxc-tsrx from your project root, or pass --project <directory>`,
      );
    }
    directory = parent;
  }
}

async function detectPackageManager(projectRoot, userAgent = process.env.npm_config_user_agent) {
  for (const [lockfile, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["deno.lock", "deno"],
    ["deno.json", "deno"],
    ["deno.jsonc", "deno"],
  ]) {
    if (await exists(join(projectRoot, lockfile))) return manager;
  }
  const agent = userAgent?.split("/")[0];
  if (["npm", "pnpm", "yarn", "bun", "deno"].includes(agent)) return agent;
  return "unknown";
}

function providerSelection(manifest) {
  return DIRECT_DEPENDENCY_FIELDS.find(
    (field) => typeof manifest[field]?.[PACKAGE_NAME] === "string",
  );
}

function directlySelected(manifest, packageName) {
  return DIRECT_DEPENDENCY_FIELDS.some(
    (field) => typeof manifest[field]?.[packageName] === "string",
  );
}

function compatibilityMetadata(manifest) {
  const metadata = manifest?.oxcTsrxCompatibility;
  if (
    metadata?.schemaVersion === COMPATIBILITY_SCHEMA &&
    metadata?.provider === PROVIDER &&
    typeof metadata.providerVersion === "string"
  ) {
    return metadata;
  }
  return null;
}

async function installedProvider(projectRoot) {
  const projectManifestPath = join(projectRoot, "package.json");
  const projectManifest = await readJson(projectManifestPath);
  const selectedFrom = providerSelection(projectManifest);
  if (!selectedFrom) {
    throw new Error(
      `${PACKAGE_NAME} must be a direct dependency or devDependency in ${projectManifestPath}`,
    );
  }
  const require = createRequire(projectManifestPath);
  let providerManifestPath;
  try {
    providerManifestPath = require.resolve(`${PACKAGE_NAME}/package.json`);
  } catch {
    throw new Error(
      `${PACKAGE_NAME} is declared but not installed under ${projectRoot}; install dependencies first`,
    );
  }
  const manifest = await readJson(providerManifestPath);
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== "string") {
    throw new Error(`resolved ${providerManifestPath} is not a valid ${PACKAGE_NAME} package`);
  }
  return {
    manifest,
    manifestPath: providerManifestPath,
    projectManifest,
    root: dirname(providerManifestPath),
    selectedFrom,
  };
}

function facadeManifest(slot, providerVersion, replacedPackage) {
  const manifest: any = {
    name: slot.name,
    version: providerVersion,
    private: true,
    description: `${slot.name} compatibility facade generated by ${PROVIDER}`,
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
      "./package.json": "./package.json",
    },
    oxcTsrxCompatibility: {
      schemaVersion: COMPATIBILITY_SCHEMA,
      provider: PROVIDER,
      providerVersion,
      capability: slot.capability,
      ...(replacedPackage ? { replacedPackage } : {}),
    },
  };
  if (slot.binary) {
    manifest.bin = { [slot.binary]: `./bin/${slot.binary}` };
  }
  return manifest;
}

function binarySource(binary) {
  return `#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

try {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@tsrx/oxc/package.json");
  const manifest = require(manifestPath);
  const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[${JSON.stringify(binary)}];
  if (typeof declared !== "string" || declared.length === 0) {
    throw new Error("@tsrx/oxc does not declare the ${binary} binary");
  }
  await import(pathToFileURL(resolve(dirname(manifestPath), declared)).href);
} catch (error) {
  console.error("${binary} (oxc-tsrx compatibility): " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
}
`;
}

function backupPath(modules, slot) {
  return join(
    modules,
    ".oxc-tsrx-compat",
    "originals",
    slot.name.replaceAll("/", "__"),
  );
}

async function inspectSlot(modules, slot, providerVersion, projectManifest) {
  const destination = join(modules, ...slot.name.split("/"));
  if (!(await exists(destination))) {
    return { slot, destination, state: "missing", metadata: null };
  }
  const manifest = await readJson(join(destination, "package.json")).catch(() => null);
  const metadata = compatibilityMetadata(manifest);
  // Every collision names what is in the slot and why it is left there. The
  // kinds are not equal: a package the project declares itself is a statement
  // about what that name means, and `setup` works around it; the other kinds
  // are trees `setup` will not touch and reports as before.
  const occupant = {
    name: typeof manifest?.name === "string" ? manifest.name : null,
    version: typeof manifest?.version === "string" ? manifest.version : null,
  };
  const collision = (kind) => ({ slot, destination, state: "collision", metadata: null, collision: kind, occupant });
  if (!metadata || metadata.capability !== slot.capability) {
    if (manifest?.name === slot.name && typeof manifest.version === "string") {
      if (directlySelected(projectManifest, slot.name)) return collision("direct-dependency");
      if (await exists(backupPath(modules, slot))) return collision("reinstalled-over-facade");
      return {
        slot,
        destination,
        state: "replaceable",
        metadata: null,
        replacedPackage: { name: manifest.name, version: manifest.version },
      };
    }
    return collision("foreign-package");
  }
  if (metadata.replacedPackage && !(await exists(backupPath(modules, slot)))) {
    return collision("facade-without-backup");
  }
  return {
    slot,
    destination,
    state: metadata.providerVersion === providerVersion ? "active" : "stale",
    metadata,
    replacedPackage: metadata.replacedPackage ?? null,
  };
}

async function writeFacade(directory, slot, providerVersion, replacedPackage) {
  await mkdir(join(directory, "dist"), { recursive: true });
  await Promise.all([
    writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(facadeManifest(slot, providerVersion, replacedPackage), null, 2)}\n`,
    ),
    writeFile(
      join(directory, "dist/index.js"),
      `export * from ${JSON.stringify(slot.exportPath)};\n`,
    ),
    writeFile(
      join(directory, "dist/index.d.ts"),
      `export * from ${JSON.stringify(slot.exportPath)};\n`,
    ),
  ]);
  if (slot.binary) {
    const binDirectory = join(directory, "bin");
    const bin = join(binDirectory, slot.binary);
    await mkdir(binDirectory, { recursive: true });
    await writeFile(bin, binarySource(slot.binary), { mode: 0o755 });
    await chmod(bin, 0o755);
  }
}

async function replaceOwnedFacade(status, providerVersion, modules) {
  const { destination, slot } = status;
  const parent = dirname(destination);
  const temporary = join(parent, `.oxc-tsrx-${slot.name}-new-${process.pid}`);
  const previous = join(parent, `.oxc-tsrx-${slot.name}-old-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  await rm(previous, { recursive: true, force: true });
  await writeFacade(temporary, slot, providerVersion, status.replacedPackage);
  if (status.state === "replaceable") {
    const backup = backupPath(modules, slot);
    if (await exists(backup)) {
      throw new Error(
        `refusing to replace ${slot.name}: preserved package already exists at ${backup}`,
      );
    }
    await mkdir(dirname(backup), { recursive: true });
    await rename(destination, backup);
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rename(backup, destination);
      throw error;
    }
    return;
  }
  if (status.state === "stale") {
    await rename(destination, previous);
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rename(previous, destination);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
  } else {
    await rename(temporary, destination);
  }
}

// --- Does this package already win the editor's lookup? ----------------------

/**
 * A launcher that names this package's binary in its own text.
 *
 * pnpm 10 writes `node_modules/.bin/<name>` as a shell script rather than a
 * symlink, and npm and pnpm both write `.cmd` and `.ps1` launchers on Windows.
 * For all of those the file that stats *is* the launcher, so nothing above it
 * belongs to this package and its target is only readable inline. Measured on a
 * real pnpm install: the shim is a script whose `exec` line names
 * `@tsrx/oxc/bin/oxlint`.
 *
 * Both spellings are accepted. The package moved from `oxc-tsrx` to
 * `@tsrx/oxc`, and an upgrade in place leaves the old launcher sitting in
 * `.bin` until the next full install rewrites it. That launcher still runs this
 * package, so reading it as foreign would make every report cry wolf at a tree
 * that is correctly wired - which is the exact failure this text match exists
 * to prevent.
 */
const PROVIDER_LAUNCHER_TEXT = /(?:@tsrx[\\/]oxc|oxc-tsrx)[\\/]bin[\\/]oxlint/u;

/** Nothing a package manager writes into `.bin` is anywhere near this big. */
const LAUNCHER_TEXT_LIMIT = 64 * 1024;

/**
 * Does running this path end up in this package?
 *
 * Three readings, because three package managers answer differently and only
 * one of them can be answered by `realpath`: inside the installed package,
 * inside the compatibility facade this package generated, or a text launcher
 * that names the package's binary inline. The last one is why this exists: a
 * pnpm shim that *is* ours resolves to a file under `.bin`, whose nearest
 * `package.json` is the consumer's own, so every path-shaped test calls it
 * foreign and a report built on that would cry wolf at a correctly wired tree.
 */
async function leadsIntoProvider(candidate, providerReal, facadeReal) {
  if (!candidate) return false;
  const real = (await realPathOrNull(candidate)) ?? candidate;
  if (within(providerReal, real)) return true;
  if (facadeReal && within(facadeReal, real)) return true;
  const info = await lstat(real).catch(() => null);
  if (!info?.isFile() || info.size > LAUNCHER_TEXT_LIMIT) return false;
  return PROVIDER_LAUNCHER_TEXT.test(await readFile(real, "utf8").catch(() => ""));
}

/**
 * The official OXC extension resolves its linter through
 * `node_modules/.bin/oxlint`. If that shim already lands inside this package
 * there is nothing to write and the slot is reported `unnecessary`; if another
 * tool owns it — Vite+ is the case this exists for — the setting is the only
 * thing that reaches the editor.
 *
 * Resolution differs per package manager, so this reads the shim three ways.
 * npm, pnpm, Yarn (node-modules linker) and Bun all publish a POSIX symlink,
 * which `realpath` answers directly. npm and pnpm on Windows publish `.cmd` and
 * `.ps1` text shims that name their target inline, which the text check reads.
 * Anything that classifies as neither is reported `unknown` and treated as *not*
 * ours, because writing the setting when it was not needed still points the
 * extension at the right binary, while skipping it when it was needed is the
 * silent dead editor this slot exists to prevent.
 */
async function inspectLinterShim(modules, providerRoot) {
  const binDirectory = join(modules, ".bin");
  const names = process.platform === "win32"
    ? ["oxlint.cmd", "oxlint.ps1", "oxlint"]
    : ["oxlint"];
  const providerReal = (await realPathOrNull(providerRoot)) ?? providerRoot;
  const facadeReal = await realPathOrNull(join(modules, "oxlint"));
  const facadeIsOurs = facadeReal
    ? Boolean(
        compatibilityMetadata(
          await readJson(join(modules, "oxlint", "package.json")).catch(() => null),
        ),
      )
    : false;
  for (const name of names) {
    const shim = join(binDirectory, name);
    const info = await lstat(shim).catch(() => null);
    if (!info) continue;
    const target = await realPathOrNull(shim);
    if (target && within(providerReal, target)) {
      return { path: shim, target, owner: PACKAGE_NAME, resolvedBy: "symlink" };
    }
    if (target && facadeIsOurs && facadeReal && within(facadeReal, target)) {
      return { path: shim, target, owner: PACKAGE_NAME, resolvedBy: "compatibility-facade" };
    }
    if (info.isFile() && !info.isSymbolicLink()) {
      const source = await readFile(shim, "utf8").catch(() => "");
      if (PROVIDER_LAUNCHER_TEXT.test(source)) {
        return { path: shim, target: target ?? null, owner: PACKAGE_NAME, resolvedBy: "shim-text" };
      }
      return { path: shim, target: target ?? null, owner: "other", resolvedBy: "shim-text" };
    }
    return {
      path: shim,
      target: target ?? null,
      owner: target ? "other" : "unknown",
      resolvedBy: target ? "symlink" : "unresolved",
    };
  }
  return { path: join(binDirectory, "oxlint"), target: null, owner: "none", resolvedBy: "absent" };
}

/**
 * The value to write, always relative to the folder the settings file sits in,
 * because that is the folder the editor has to have open for the file to be read
 * at all. With no `--workspace-root` that folder is the project root and this is
 * the installed copy at `node_modules/@tsrx/oxc/bin/oxlint`.
 */
async function editorSettingValue(settingsRoot, projectRoot, providerRoot) {
  const linked = join(projectRoot, "node_modules", ...PACKAGE_DIRECTORY, "bin", "oxlint");
  if (await exists(linked)) return toPosix(relative(settingsRoot, linked));
  const offset = relative(settingsRoot, join(providerRoot, "bin", "oxlint"));
  return offset.startsWith("..") || isAbsolute(offset)
    ? join(providerRoot, "bin", "oxlint")
    : toPosix(offset);
}

async function readEditorReceipt(modules) {
  const receipt = await readJson(join(modules, ...EDITOR_RECEIPT)).catch(() => null);
  if (
    receipt?.schemaVersion === COMPATIBILITY_SCHEMA &&
    receipt?.provider === PROVIDER &&
    receipt?.key === EDITOR_SLOT.key
  ) {
    return receipt;
  }
  return null;
}

/**
 * The durable form of the receipt: the key already sitting in a settings file.
 *
 * The receipt lives under `node_modules`, and every reinstall wipes it - which
 * is routine, because the walkthroughs themselves tell readers to reinstall and
 * re-run `setup`. The `.vscode` key survives the wipe, so when the receipt is
 * gone the project root and every candidate workspace root are asked directly:
 * a settings file whose key resolves back into THIS project's installed copy is
 * a placement a previous `setup` made, and plain `setup`/`remove` keep serving
 * it instead of silently reverting to the project root and leaving the old key
 * behind in a file nothing takes back. A key resolving anywhere else is someone
 * else's wiring and is left alone. Nearest placement wins: the project root is
 * checked before any ancestor.
 */
async function recoverWrittenSettingsRoot(projectRoot) {
  const candidates = [
    projectRoot,
    ...(await candidateWorkspaceRoots(projectRoot)).map((candidate) => candidate.path),
  ];
  const installed = join(projectRoot, "node_modules", ...PACKAGE_DIRECTORY);
  for (const directory of candidates) {
    const settings = await readJson(
      join(directory, EDITOR_SLOT.directory, EDITOR_SLOT.file),
    ).catch(() => null);
    const value = settings?.[EDITOR_SLOT.key];
    if (typeof value !== "string" || value.length === 0) continue;
    const target = isAbsolute(value) ? value : resolve(directory, value);
    const offset = relative(installed, target);
    if (!offset.startsWith("..") && !isAbsolute(offset)) return directory;
  }
  return null;
}

/**
 * Which folder's `.vscode/settings.json` this run is talking about.
 *
 * An explicit `--workspace-root` wins, then whatever a previous `setup`
 * recorded, then the project root. The receipt is what keeps `remove` symmetric
 * across a `--workspace-root` write: it stores the settings file relative to the
 * project root, so `../../.vscode/settings.json` still finds its way home.
 *
 * Naming a *different* folder than the one already written to is refused rather
 * than obeyed, because obeying it would rewrite the receipt and orphan the key
 * that is already out there in a file nothing would take back.
 */
async function editorSettingsRoot(projectRoot, receipt, workspaceRoot) {
  const written = receipt?.settingsPath
    ? dirname(dirname(resolve(projectRoot, receipt.settingsPath)))
    : await recoverWrittenSettingsRoot(projectRoot);
  if (workspaceRoot === undefined || workspaceRoot === null) return written ?? projectRoot;
  // Relative to the working directory, exactly like `--project`, so the two
  // flags on one command line never mean two different things by `../..`.
  const named = resolve(workspaceRoot);
  const directory = await lstat(named).catch(() => null);
  if (!directory?.isDirectory()) {
    throw new Error(`--workspace-root ${named} is not a directory`);
  }
  if (!within(named, projectRoot)) {
    throw new Error(
      `--workspace-root ${named} does not contain ${projectRoot}. The editor resolves a relative "${EDITOR_SLOT.key}" against the folder you open, and the official OXC extension rejects any value containing "..", so the folder has to be at or above your project root`,
    );
  }
  if (written && written !== named) {
    throw new Error(
      `${PROVIDER} already wrote "${EDITOR_SLOT.key}" into ${join(written, EDITOR_SLOT.directory, EDITOR_SLOT.file)}. Run ${PROVIDER} remove first, then setup --workspace-root ${named}, so the key is never left behind in a file nothing takes back`,
    );
  }
  return named;
}

/**
 * The one capability the resolution oracle is given: does this path exist, what
 * does it really point at, and, for a `package.json`, what does it say.
 *
 * `realPath` is what makes the answer honest through a text shim: the file that
 * will really execute is the one whose package decides whether `.tsrx` is
 * understood. Both replays below share this seam so `status` and the oracle can
 * never be answering from two different views of the same tree.
 */
async function editorResolutionStat(candidate) {
  const real = await realPathOrNull(candidate);
  if (!real) return null;
  const content =
    basename(candidate) === "package.json"
      ? await readFile(candidate, "utf8").catch(() => null)
      : null;
  return { realPath: real, content };
}

/** The folders above this one that look like a workspace root, named with their evidence. */
function workspaceRootsNote(settingsRoot, workspaceRoots) {
  const listed = workspaceRoots
    .map((candidate) => `${candidate.path} (${candidate.evidence})`)
    .join(", ");
  return workspaceRoots.length === 1
    ? `VS Code reads .vscode/settings.json only from the folder you open as the workspace root, never from a subfolder of it. This folder above ${settingsRoot} looks like a workspace root: ${listed}. Open that one instead and this key is never read.`
    : `VS Code reads .vscode/settings.json only from the folder you open as the workspace root, never from a subfolder of it. These folders above ${settingsRoot} look like a workspace root: ${listed}. Open any of them instead and this key is never read.`;
}

/**
 * Deliberate workspace markers earn the full inert-plus-remedies treatment: a
 * declared monorepo root or a repository root is a folder people open by
 * default. The weak tier - a lockfile or node_modules next to a plain manifest,
 * the shape every scaffold-inside-a-demo-folder walkthrough manufactures - is a
 * folder someone MIGHT open, and a happy-path setup drowning that maybe in a
 * warning wall teaches readers to skip the report entirely. Weak-only ancestors
 * keep the slot active and get one line naming the folder and the one command.
 */
function strongWorkspaceRoots(workspaceRoots) {
  return workspaceRoots.filter(
    (candidate) =>
      candidate.evidence.endsWith(CODE_WORKSPACE_SUFFIX) ||
      WORKSPACE_ROOT_EVIDENCE.indexOf(candidate.evidence) <=
        WORKSPACE_ROOT_EVIDENCE.indexOf(".git"),
  );
}

/**
 * The other settings files a window might actually read, each with the value
 * that is correct for its own folder. VS Code reads settings only from the
 * opened folder, so full coverage means one correct key per folder someone
 * plausibly opens: the project root, and every WEAK candidate above it - an
 * installed folder that declares no workspace and carries no VCS, the shape a
 * scaffold-inside-a-demo-folder walkthrough manufactures. `setup` writes these
 * automatically. Strong roots (a declared monorepo, a repository root, a
 * `.code-workspace`) stay behind the explicit `--workspace-root` flag: writing
 * into a checked-in tree's settings uninvited is the footgun the flag exists
 * for. An explicit flag also disables the automatic placements, because naming
 * a folder is choosing it.
 */
async function editorAncestorPlacements(
  projectRoot,
  providerRoot,
  settingsRoot,
  workspaceRoots,
  explicitWorkspaceRoot,
) {
  if (explicitWorkspaceRoot !== undefined && explicitWorkspaceRoot !== null) return [];
  const strong = new Set(strongWorkspaceRoots(workspaceRoots).map((c) => c.path));
  const roots = [projectRoot, ...workspaceRoots.map((c) => c.path)].filter(
    (root) => root !== settingsRoot && !strong.has(root),
  );
  const placements = [];
  for (const root of roots) {
    const path = join(root, EDITOR_SLOT.directory, EDITOR_SLOT.file);
    const settings = await readJson(path).catch(() => null);
    placements.push({
      root,
      path,
      value: await editorSettingValue(root, projectRoot, providerRoot),
      current: typeof settings?.[EDITOR_SLOT.key] === "string" ? settings[EDITOR_SLOT.key] : null,
    });
  }
  return placements;
}

/**
 * The two remedies, in the order to try them, worded identically for a key that
 * was written into a folder nobody opens and for a lookup that only wins in a
 * folder nobody opens. The reader's move is the same in both cases.
 */
function editorRemediesNote(projectRoot) {
  return `Two remedies, in order: open ${projectRoot} as the folder in your editor, or - from ${projectRoot} - run npx ${PROVIDER} setup --workspace-root <folder> to write the key into that folder's .vscode/settings.json instead. setup never writes above your project root without that flag, because a key written for a folder you did not open disables the extension's own lookup and leaves the linter dead.`;
}

/**
 * Would the editor actually run this value?
 *
 * Written is not wired. This replays the official extension's own handling of
 * `oxc.path.oxlint` through the resolution oracle and reports every reason the
 * value would not reach a linter, so `status` can refuse to call a written key
 * active. All four refusals are collected rather than short-circuited: a value
 * can be both in a file the editor never reads and unspawnable once it does.
 */
async function judgeEditorReach({
  settingsRoot,
  projectRoot,
  value,
  workspaceRoots,
  ancestorPlacements = [],
  platform,
}) {
  const notes = [];
  const rejection = value === null ? null : rejectConfiguredValue(value);
  if (rejection === "configured-rejected-traversal") {
    notes.push(
      `The official OXC extension refuses any "${EDITOR_SLOT.key}" containing ".." or ".\\" before it looks at the filesystem, so "${value}" never reaches a linter. There is no relative escape hatch: the value has to name a path inside the folder you open.`,
    );
  } else if (rejection === "configured-rejected-metacharacter") {
    notes.push(
      `The official OXC extension refuses any "${EDITOR_SLOT.key}" containing $ & ; | \` > < ! % ^, so "${value}" never reaches a linter. Point the key at a path with none of those characters in it.`,
    );
  }

  // Resolution runs on the host's own path semantics, because these are the
  // host's own real paths. Spawnability is asked separately, of the target
  // platform, because it is a question about the shape of the path rather than
  // about the filesystem: it is what lets this machine answer "would Windows run
  // this" without a Windows filesystem to stat.
  const resolution =
    value === null
      ? null
      : await resolveEditorLinter({
          name: "oxlint",
          configured: value,
          // The folder holding the settings file is the folder the editor has to
          // have open, so it is also the folder a relative value resolves
          // against. In a multi-root window that is only true while it is first.
          workspaceFolders: [settingsRoot],
          trusted: true,
          stat: editorResolutionStat,
        });
  const spawnable =
    resolution === null || resolution.reason !== "resolved"
      ? false
      : isSpawnable(resolution.path, resolution.loader, platform);

  if (resolution && !rejection && resolution.reason !== "resolved") {
    notes.push(
      `${resolution.attempted ?? value} does not exist, so the extension would find no linter at all. A configured "${EDITOR_SLOT.key}" replaces the extension's own node_modules lookup instead of adding to it, with no fallback, so a value that does not resolve is worse than no value. Run ${PROVIDER} setup to refresh it.`,
    );
  }
  if (resolution?.reason === "resolved" && !spawnable) {
    notes.push(
      `On Windows the extension spawns a value like this through cmd.exe, which can only run .exe, .com, .bat and .cmd. "${value}" has no file extension, so the spawn fails and the editor stays silent with no error anywhere. Add "oxc.useExecPath": true to the same settings file to have it launched with Node instead.`,
    );
  }

  const strong = strongWorkspaceRoots(workspaceRoots);
  if (strong.length > 0) {
    notes.push(workspaceRootsNote(settingsRoot, strong));
    notes.push(editorRemediesNote(projectRoot));
  }
  const covered = ancestorPlacements.filter((p) => p.current === p.value);
  if (covered.length > 0) {
    notes.push(
      `Also covered: ${covered.map((p) => p.path).join(", ")}. A window opened at ${
        covered.length === 1 ? "that folder" : "any of those folders"
      } reads its own copy of the key.`,
    );
  }
  if (settingsRoot !== projectRoot) {
    notes.push(
      `"${value}" is relative to ${settingsRoot}. A multi-root window resolves a relative "${EDITOR_SLOT.key}" against its FIRST folder, not against the folder holding the settings file, so keep ${settingsRoot} first in the window or the editor looks for the linter in the wrong tree.`,
    );
  }

  const unresolvable = Boolean(rejection) || (resolution !== null && !spawnable);
  return {
    state: unresolvable ? "unresolvable" : strong.length > 0 ? "inert" : "ok",
    value,
    windowRoot: settingsRoot,
    platform,
    rejection,
    resolution: resolution
      ? {
          source: resolution.source,
          path: resolution.path,
          reason: resolution.reason,
          loader: resolution.loader,
          spawnable,
          tsrxAware: resolution.tsrxAware,
        }
      : null,
    notes,
  };
}

/**
 * Would the extension's *own* lookup reach this package from every folder the
 * consumer might plausibly open?
 *
 * `node_modules/.bin/oxlint` being ours is the reason nothing is written, so it
 * had better be the reason that survives being asked from the folder the editor
 * is actually opened at. It often does not. `.bin` is searched per workspace
 * folder, first hit wins, so a monorepo whose root carries a competing
 * `.bin/oxlint` resolves *there* and never looks at the package below it. The
 * report used to say "the editor needs no setting" for exactly that tree: a
 * green line over a silent editor.
 *
 * So auto-detection is replayed with `configured: null`, once from the folder
 * holding the settings file and once from every candidate workspace root, and
 * `unnecessary` is only kept when all of them land in this package.
 *
 * Two deliberate conservatisms, because a false alarm here would be worse than
 * the gap it closes:
 *
 * - Only a candidate that *resolves* to a foreign binary demotes. A candidate
 *   that resolves to nothing at all does not, because this replay is given a
 *   subset of the real chain (no `require.resolve`, no global roots, no `PATH`),
 *   so "found nothing" is this process's ignorance rather than a measurement.
 * - The `package.json` glob step is given the project's own directory only. The
 *   extension globs the whole workspace and the order of those hits is not
 *   knowable from here, so a sibling package that might shadow this one is left
 *   unclaimed rather than guessed at.
 */
async function judgeAutoDetection({
  settingsRoot,
  projectRoot,
  modules,
  providerRoot,
  shim,
  workspaceRoots,
  platform,
}) {
  const providerReal = (await realPathOrNull(providerRoot)) ?? providerRoot;
  const facadeReal = await realPathOrNull(join(modules, "oxlint"));
  const folders = [{ path: settingsRoot, evidence: null }, ...workspaceRoots];
  const candidates = [];
  for (const folder of folders) {
    const resolution = await resolveEditorLinter({
      name: "oxlint",
      configured: null,
      workspaceFolders: [folder.path],
      packageJsonDirectories: [projectRoot],
      trusted: true,
      stat: editorResolutionStat,
    });
    const reaches =
      resolution.reason === "resolved" &&
      (resolution.tsrxAware ||
        (await leadsIntoProvider(
          resolution.realPath ?? resolution.path,
          providerReal,
          facadeReal,
        )));
    candidates.push({
      root: folder.path,
      evidence: folder.evidence,
      path: resolution.path,
      reason: resolution.reason,
      source: resolution.source,
      tsrxAware: resolution.tsrxAware,
      reaches,
    });
  }
  const diverging = candidates.filter(
    (candidate) => candidate.reason === "resolved" && !candidate.reaches,
  );
  const notes = [];
  if (diverging.length > 0) {
    const listed = diverging
      .map(
        (candidate) =>
          `${candidate.root}${candidate.evidence ? ` (${candidate.evidence})` : ""} finds ${candidate.path}`,
      )
      .join("; ");
    notes.push(
      `${shim.path} does resolve into this package, but that only decides what a window opened at ${projectRoot} finds. VS Code reads .vscode/settings.json only from the folder you open as the workspace root, and the extension searches each opened folder's own node_modules/.bin first, so a folder above this one finds a different linter: ${listed}. That binary does not understand .tsrx, so opening it gives no .tsrx diagnostics and nothing anywhere says why.`,
    );
    notes.push(editorRemediesNote(projectRoot));
  }
  return {
    state: diverging.length > 0 ? "inert" : "ok",
    value: null,
    windowRoot: settingsRoot,
    platform,
    rejection: null,
    resolution: null,
    autoDetection: candidates,
    notes,
  };
}

async function inspectEditorSlot(projectRoot, providerRoot, modules, options: any = {}) {
  const receipt = await readEditorReceipt(modules);
  const settingsRoot = await editorSettingsRoot(projectRoot, receipt, options.workspaceRoot);
  const platform = options.platform ?? process.platform;
  const path = join(settingsRoot, EDITOR_SLOT.directory, EDITOR_SLOT.file);
  const shim = await inspectLinterShim(modules, providerRoot);
  const value = await editorSettingValue(settingsRoot, projectRoot, providerRoot);
  const workspaceRoots = await candidateWorkspaceRoots(settingsRoot);
  const ancestorPlacements = await editorAncestorPlacements(
    projectRoot,
    providerRoot,
    settingsRoot,
    workspaceRoots,
    options.workspaceRoot,
  );
  const base = {
    name: EDITOR_SLOT.name,
    capability: EDITOR_SLOT.capability,
    key: EDITOR_SLOT.key,
    path,
    settingsRoot,
    value,
    linterShim: shim,
    workspaceRoots,
    ancestorPlacements,
  };
  // The value the reader is being told about: whatever is in the file when there
  // is something in it, and otherwise the value `setup` would write. Both are
  // judged, so the folder-scoping warning arrives before the write rather than
  // after it.
  const judge = async (state, currentValue) => ({
    ...base,
    state,
    currentValue,
    reach: await judgeEditorReach({
      settingsRoot,
      projectRoot,
      value:
        ["active", "collision"].includes(state) && typeof currentValue === "string"
          ? currentValue
          : value,
      workspaceRoots,
      ancestorPlacements,
      platform,
    }),
  });
  const reported = async (state, currentValue) => {
    const slot = await judge(state, currentValue);
    return {
      ...slot,
      // Only a state that claims the wiring works can be demoted. `missing`,
      // `stale`, `collision` and `unreadable` already say it does not.
      state: state === "active" && slot.reach.state !== "ok" ? slot.reach.state : state,
      notes: slot.reach.notes,
    };
  };

  // No key in the file. The extension auto-detects, so what it would find is the
  // whole answer, and `unnecessary` has to be earned by asking rather than
  // assumed from `.bin/oxlint` being ours in this one folder.
  const unwritten = async () => {
    if (shim.owner !== PACKAGE_NAME) return reported("missing", null);
    const reach = await judgeAutoDetection({
      settingsRoot,
      projectRoot,
      modules,
      providerRoot,
      shim,
      workspaceRoots,
      platform,
    });
    return {
      ...base,
      state: reach.state === "ok" ? "unnecessary" : "inert",
      currentValue: null,
      reach,
      notes: reach.notes,
    };
  };

  if (!(await exists(path))) return unwritten();
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return reported("unreadable", null);
  const structure = readTopLevelObject(text);
  if (!structure) return reported("unreadable", null);
  const entry = structure.entries.find((candidate) => candidate.key === EDITOR_SLOT.key);
  if (!entry) return unwritten();
  const current = stringEntryValue(entry);
  if (typeof current === "string") {
    const resolved = await realPathOrNull(
      isAbsolute(current) ? current : join(settingsRoot, current),
    );
    const providerReal = (await realPathOrNull(providerRoot)) ?? providerRoot;
    if (resolved && within(providerReal, resolved)) {
      return reported("active", current);
    }
    if (receipt && receipt.value === current) {
      // This package wrote it and it no longer resolves here, which is what a
      // clean reinstall or a hoisting change looks like. Ours to refresh.
      return reported("stale", current);
    }
  }
  return reported("collision", current);
}

/**
 * Merge the key into one settings file, replacing a stale copy when asked, and
 * report whether the file or its directory had to be created so `remove` can
 * take back exactly what `setup` made.
 */
async function mergeEditorKey(path, value, { replaceStale = false } = {}) {
  const directory = dirname(path);
  const createdDirectory = !(await exists(directory));
  if (createdDirectory) await mkdir(directory, { recursive: true });
  const createdFile = !(await exists(path));
  const previous = createdFile ? "{}\n" : await readFile(path, "utf8");
  const structure = readTopLevelObject(previous);
  if (!structure) {
    throw new Error(`refusing to edit ${path}: its top-level JSON object could not be located`);
  }
  const cleaned = replaceStale ? removeTopLevelEntry(previous, structure, EDITOR_SLOT.key) : previous;
  const target = replaceStale ? readTopLevelObject(cleaned) : structure;
  if (!target) {
    throw new Error(`refusing to edit ${path}: rewriting it would not round-trip`);
  }
  await writeFile(path, insertTopLevelEntry(cleaned, target, EDITOR_SLOT.key, value));
  return { createdFile, createdDirectory };
}

async function writeEditorSlot(projectRoot, modules, slot) {
  // `dirname(slot.path)`, not the project root's `.vscode`: with
  // `--workspace-root` the settings file lives in a named ancestor, and the
  // receipt has to describe the file that was really touched or `remove` gives
  // back the wrong one.
  const existing = await readEditorReceipt(modules);
  let created = { createdFile: false, createdDirectory: false };
  if (slot.currentValue !== slot.value) {
    created = await mergeEditorKey(slot.path, slot.value, {
      replaceStale: slot.state === "stale",
    });
  }
  // The automatic placements: one correct key per folder someone plausibly
  // opens. Each is written only when absent or wrong, each remembers whether
  // its file existed before, and each lands in the receipt so `remove` is
  // symmetric with the whole of `setup`, not just its primary write.
  const placements = [];
  const existingPlacements = new Map<string, any>(
    (existing?.placements ?? []).map((placement) => [placement.settingsPath, placement]),
  );
  for (const placement of slot.ancestorPlacements ?? []) {
    const settingsPath = toPosix(relative(projectRoot, placement.path));
    const previous = existingPlacements.get(settingsPath);
    let placementCreated = {
      createdFile: previous?.createdFile === true,
      createdDirectory: previous?.createdDirectory === true,
    };
    if (placement.current !== placement.value) {
      const written = await mergeEditorKey(placement.path, placement.value, {
        replaceStale: placement.current !== null,
      });
      placementCreated = {
        createdFile: placementCreated.createdFile || written.createdFile,
        createdDirectory: placementCreated.createdDirectory || written.createdDirectory,
      };
    }
    placements.push({ settingsPath, value: placement.value, ...placementCreated });
  }
  await mkdir(join(modules, EDITOR_RECEIPT[0]), { recursive: true });
  await writeFile(
    join(modules, ...EDITOR_RECEIPT),
    `${JSON.stringify(
      {
        schemaVersion: COMPATIBILITY_SCHEMA,
        provider: PROVIDER,
        key: EDITOR_SLOT.key,
        value: slot.value,
        settingsPath: toPosix(relative(projectRoot, slot.path)),
        createdFile: existing?.createdFile === true ? true : created.createdFile,
        createdDirectory:
          existing?.createdDirectory === true ? true : created.createdDirectory,
        placements,
      },
      null,
      2,
    )}\n`,
  );
}

async function removeEditorKeyFrom(path, { createdFile = false, createdDirectory = false }: any = {}) {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return;
  const structure = readTopLevelObject(text);
  if (!structure) {
    throw new Error(`refusing to edit ${path}: its top-level JSON object could not be located`);
  }
  const next = removeTopLevelEntry(text, structure, EDITOR_SLOT.key);
  const remaining = readTopLevelObject(next);
  const emptied =
    remaining !== null &&
    remaining.entries.length === 0 &&
    next.slice(remaining.openEnd, remaining.closeStart).trim().length === 0;
  if (emptied && createdFile === true) {
    await rm(path, { force: true });
    if (createdDirectory === true) {
      const directory = dirname(path);
      const left = await readdir(directory).catch(() => ["keep"]);
      if (left.length === 0) await rmdir(directory).catch(() => {});
    }
  } else {
    await writeFile(path, next);
  }
}

async function revertEditorSlot(modules, slot) {
  const receipt = await readEditorReceipt(modules);
  await removeEditorKeyFrom(slot.path, {
    createdFile: receipt?.createdFile === true,
    createdDirectory: receipt?.createdDirectory === true,
  });
  // Every automatic placement setup made comes back too: those in the receipt
  // with their created-file provenance, and - when a reinstall wiped the
  // receipt - those the inspection recovered from the settings files
  // themselves, with conservative file retention since nothing can prove who
  // created them.
  const receiptPlacements = new Map<string, any>(
    (receipt?.placements ?? []).map((placement) => [placement.settingsPath, placement]),
  );
  const seen = new Set([slot.path]);
  for (const placement of receipt?.placements ?? []) {
    const path = resolve(join(modules, ".."), placement.settingsPath);
    if (seen.has(path)) continue;
    seen.add(path);
    await removeEditorKeyFrom(path, placement);
  }
  for (const placement of slot.ancestorPlacements ?? []) {
    // Only a key carrying exactly the value setup would write is provably ours
    // to take back; anything else is someone's deliberate configuration.
    if (seen.has(placement.path) || placement.current !== placement.value) continue;
    seen.add(placement.path);
    await removeEditorKeyFrom(placement.path, receiptPlacements.get(placement.path) ?? {});
  }
  await rm(join(modules, ...EDITOR_RECEIPT), { force: true });
}

// --- What this package deliberately does not own -----------------------------

async function resolveDependencyManifest(fromRequire, modules, name) {
  try {
    return await readJson(fromRequire.resolve(`${name}/package.json`));
  } catch {
    // Not every package exports `./package.json`, and a package can be present
    // without being importable from the project root.
  }
  const direct = join(modules, ...name.split("/"), "package.json");
  return (await exists(direct)) ? readJson(direct).catch(() => null) : null;
}

async function nearestTsconfig(projectRoot) {
  let directory = projectRoot;
  for (;;) {
    const candidate = join(directory, "tsconfig.json");
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function declaresTsrxPlugin(tsconfig) {
  const plugins = tsconfig?.compilerOptions?.plugins;
  return (
    Array.isArray(plugins) &&
    plugins.some((plugin) => plugin?.name === TSRX_TYPESCRIPT_PLUGIN)
  );
}

/**
 * A solution-style tsconfig owns no files: it is `{ "files": [], "references": [...] }`,
 * the shape `vp create` scaffolds. Naming it in the advice below is worse than useless,
 * because a plugin declared there is inert. Measured on a stock Vite+ React app with
 * TypeScript 5.9.3: the plugin in the solution root answers `hover: any`, the same
 * plugin in the referenced project that owns `src` answers `hover: const legacy: number`.
 * So point at the project that actually contains the source.
 */
function isSolutionStyle(tsconfig) {
  const files = tsconfig?.files;
  const references = tsconfig?.references;
  return (
    Array.isArray(references) &&
    references.length > 0 &&
    Array.isArray(files) &&
    files.length === 0 &&
    tsconfig?.include === undefined
  );
}

/** The referenced project a solution-style root delegates source files to. */
async function referencedSourceProject(tsconfigPath, tsconfig) {
  const references = Array.isArray(tsconfig?.references) ? tsconfig.references : [];
  const directory = dirname(tsconfigPath);
  for (const reference of references) {
    const target = typeof reference?.path === "string" ? reference.path : null;
    if (target === null) continue;
    const candidate = target.endsWith(".json") ? join(directory, target) : join(directory, target, "tsconfig.json");
    const text = await readFile(candidate, "utf8").catch(() => null);
    if (text === null) continue;
    const parsed = parseJsoncValue(text);
    // The one that includes source, not the one describing build tooling.
    const include = parsed?.include;
    if (Array.isArray(include) && include.some((entry) => typeof entry === "string" && entry.includes("src"))) {
      return { path: candidate, declaresPlugin: declaresTsrxPlugin(parsed) };
    }
  }
  return null;
}

// `setup --write-tsconfig` is the one thing that edits a tsconfig, and it is
// opt-in for that reason: without the flag this package still never touches the
// file, it only reports the gap. The entry is written to match what the
// documentation prints, so a reader who ran the flag and a reader who typed it
// by hand end up with the same line.
const TSCONFIG_PLUGIN_LITERAL = `[{ "name": ${JSON.stringify(TSRX_TYPESCRIPT_PLUGIN)} }]`;

async function writeTsconfigPlugin(tsconfigPath) {
  const text = await readFile(tsconfigPath, "utf8").catch(() => null);
  if (text === null) {
    throw new Error(`refusing to edit ${tsconfigPath}: it could not be read`);
  }
  const options = readCompilerOptions(text);
  if (!options) {
    throw new Error(
      `refusing to edit ${tsconfigPath}: its "compilerOptions" object could not be located, so add "plugins": ${TSCONFIG_PLUGIN_LITERAL} yourself`,
    );
  }
  const existing = options.entries.find((entry) => entry.key === "plugins");
  if (existing) {
    // An existing list is somebody else's, and TypeScript takes several
    // plugins, so the right edit is an append. Appending inside an array by
    // text surgery is a good way to quietly corrupt a config, so this refuses
    // and says what to add instead, the same way a taken package slot does.
    const already = text
      .slice(existing.valueStart, existing.valueEnd)
      .includes(TSRX_TYPESCRIPT_PLUGIN);
    if (already) return "present";
    throw new Error(
      `refusing to edit ${tsconfigPath}: "compilerOptions.plugins" already exists, so add { "name": ${JSON.stringify(TSRX_TYPESCRIPT_PLUGIN)} } to it yourself`,
    );
  }
  await writeFile(
    tsconfigPath,
    insertObjectEntry(text, options, "plugins", TSCONFIG_PLUGIN_LITERAL),
  );
  return "written";
}

function typescriptSupported(version) {
  const [major, minor] = String(version ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return major === 5 && minor >= 9;
}

/**
 * Read-only. `.tsrx` as a language belongs to the TSRX toolchain, and `setup`
 * must not silently configure another project's tooling. It still has to say
 * what is missing, because a green bridge plus a dead editor otherwise gives a
 * user no way to tell which half is broken.
 */
async function inspectLanguageSupport(projectRoot, modules) {
  const fromProject = createRequire(join(projectRoot, "package.json"));
  const pluginManifest = await resolveDependencyManifest(
    fromProject,
    modules,
    TSRX_TYPESCRIPT_PLUGIN,
  );
  const bindings = await Promise.all(
    TSRX_FRAMEWORK_BINDINGS.map(async (name) => ({
      name,
      manifest: await resolveDependencyManifest(fromProject, modules, name),
    })),
  );
  const binding = bindings.find((candidate) => candidate.manifest !== null) ?? null;
  const tsconfigPath = await nearestTsconfig(projectRoot);
  const tsconfigText = tsconfigPath ? await readFile(tsconfigPath, "utf8").catch(() => null) : null;
  const tsconfig = tsconfigText === null ? null : parseJsoncValue(tsconfigText);
  const typescriptManifest = await resolveDependencyManifest(fromProject, modules, "typescript");
  const typescriptVersion = typescriptManifest?.version ?? null;
  const supported = typescriptSupported(typescriptVersion);

  const report: any = {
    typescriptPlugin: {
      package: TSRX_TYPESCRIPT_PLUGIN,
      present: pluginManifest !== null,
      version: pluginManifest?.version ?? null,
    },
    frameworkBinding: {
      candidates: [...TSRX_FRAMEWORK_BINDINGS],
      present: binding !== null,
      name: binding?.name ?? null,
      version: binding?.manifest?.version ?? null,
    },
    tsconfig: {
      path: tsconfigPath,
      readable: tsconfig !== null,
      declaresPlugin: tsconfig !== null && declaresTsrxPlugin(tsconfig),
      solutionStyle: tsconfig !== null && isSolutionStyle(tsconfig),
      delegate: null,
    },
    typescript: {
      requirement: TYPESCRIPT_REQUIREMENT,
      present: typescriptVersion !== null,
      version: typescriptVersion,
      supported,
    },
    notes: [],
  };

  if (!report.typescriptPlugin.present) {
    report.notes.push(
      `install ${TSRX_TYPESCRIPT_PLUGIN} yourself: it is what gives an editor TSRX language support, and oxc-tsrx never installs it`,
    );
  }
  if (!report.frameworkBinding.present) {
    report.notes.push(
      `install a TSRX framework binding yourself (one of ${TSRX_FRAMEWORK_BINDINGS.join(", ")}); oxc-tsrx does not choose one for you`,
    );
  }
  if (!report.tsconfig.path) {
    report.notes.push(
      `no tsconfig.json was found at or above ${projectRoot}; add one declaring "plugins": [{ "name": "${TSRX_TYPESCRIPT_PLUGIN}" }]`,
    );
  } else if (!report.tsconfig.readable) {
    report.notes.push(
      `${report.tsconfig.path} could not be read as JSON, so its "plugins" list was not checked; oxc-tsrx never edits it`,
    );
  } else if (report.tsconfig.solutionStyle) {
    const delegate = await referencedSourceProject(report.tsconfig.path, tsconfig);
    report.tsconfig.delegate = delegate?.path ?? null;
    if (delegate === null) {
      report.notes.push(
        `${report.tsconfig.path} is solution-style ("files": [], "references": [...]), so a plugin declared there is inert. Add "plugins": [{ "name": "${TSRX_TYPESCRIPT_PLUGIN}" }] to whichever referenced project includes your source; setup --write-tsconfig cannot pick one for you here`,
      );
    } else if (!delegate.declaresPlugin) {
      report.notes.push(
        `add "plugins": [{ "name": "${TSRX_TYPESCRIPT_PLUGIN}" }] under compilerOptions in ${delegate.path}, or rerun setup with --write-tsconfig to have it added for you. Not ${report.tsconfig.path}: that one is solution-style ("files": [], "references": [...]) and a plugin declared there is inert`,
      );
    }
  } else if (!report.tsconfig.declaresPlugin) {
    report.notes.push(
      `add "plugins": [{ "name": "${TSRX_TYPESCRIPT_PLUGIN}" }] under compilerOptions in ${report.tsconfig.path}, or rerun setup with --write-tsconfig to have it added for you`,
    );
  }
  if (!report.typescript.present) {
    report.notes.push(
      `typescript is not resolvable from ${projectRoot}; ${TSRX_TYPESCRIPT_PLUGIN} needs typescript ${TYPESCRIPT_REQUIREMENT}`,
    );
  } else if (!supported) {
    report.notes.push(
      `typescript ${typescriptVersion} is outside ${TSRX_TYPESCRIPT_PLUGIN}'s declared peer range (${TYPESCRIPT_REQUIREMENT}). It may still work; if the editor misbehaves, pinning typescript into that range is the first thing to try. oxc-tsrx never changes your typescript version`,
    );
  }
  report.ok = report.notes.length === 0;
  return report;
}

export async function compatibilityStatus(options: any = {}) {
  const projectRoot = await findProjectRoot(options.projectRoot);
  const provider = await installedProvider(projectRoot);
  const modules = join(projectRoot, "node_modules");
  const slots = await Promise.all(
    SLOTS.map((slot) =>
      inspectSlot(modules, slot, provider.manifest.version, provider.projectManifest),
    ),
  );
  return {
    projectRoot,
    packageManager: await detectPackageManager(projectRoot, options.userAgent),
    providerVersion: provider.manifest.version,
    selectedFrom: provider.selectedFrom,
    slots: slots.map(({ slot, destination, state, replacedPackage, collision, occupant }) => ({
      name: slot.name,
      capability: slot.capability,
      binary: slot.binary,
      path: destination,
      state,
      ...(replacedPackage ? { replacedPackage } : {}),
      ...(collision ? { collision, occupant } : {}),
    })),
    editorSlot: await inspectEditorSlot(projectRoot, provider.root, modules, options),
    languageSupport: await inspectLanguageSupport(projectRoot, modules),
  };
}

export async function setupCompatibility(options: any = {}) {
  const status = await compatibilityStatus(options);
  // A slot holding the official package the project declares directly is left
  // exactly as it is: that package owns the name, and the bridge is not for
  // overriding a choice the project made. Everything else `setup` can still do
  // for that project, above all the editor key, it goes on to do, and the report
  // says what the collision means (tsrx-org/oxc#69). The other collision kinds
  // are trees this bridge no longer owns and are refused as before.
  const refused = status.slots.filter(
    (slot) => slot.state === "collision" && slot.collision !== "direct-dependency",
  );
  if (refused.length > 0) {
    throw new Error(
      `refusing to replace unowned package slot(s): ${refused.map((slot) => slot.name).join(", ")}. Installing on top of the existing node_modules does not free the slot, so run rm -rf node_modules, install again, and run ${PROVIDER} setup again`,
    );
  }
  const modules = join(status.projectRoot, "node_modules");
  if (!(await exists(modules))) {
    throw new Error(`node_modules is missing under ${status.projectRoot}; install dependencies first`);
  }
  // Before the slots, so a refusal here aborts without having half-bridged
  // `node_modules`. A solution-style root owns no files, so the plugin has to
  // land in the referenced project that includes your source instead.
  let tsconfigWrite = null;
  if (options.writeTsconfig) {
    const { path: rootPath, solutionStyle, delegate } = status.languageSupport.tsconfig;
    if (!rootPath) {
      throw new Error(
        `no tsconfig.json was found at or above ${status.projectRoot}, so there is nothing to write`,
      );
    }
    if (solutionStyle && !delegate) {
      throw new Error(
        `refusing to edit ${rootPath}: it is solution-style ("files": [], "references": [...]), so a plugin declared there is inert, and no referenced project including your source was found`,
      );
    }
    const target = delegate ?? rootPath;
    tsconfigWrite = {
      path: target,
      state: options.dryRun ? "preview" : await writeTsconfigPlugin(target),
    };
  }
  // The status was read before the write, so its prerequisite notes still say
  // the entry is missing. Re-reading is what stops the report telling you to
  // add by hand the line it just added for you.
  const languageSupport = tsconfigWrite && tsconfigWrite.state === "written"
    ? await inspectLanguageSupport(status.projectRoot, modules)
    : status.languageSupport;
  const changed = status.slots
    .filter((slot) => ["missing", "replaceable", "stale"].includes(slot.state))
    .map((slot) => slot.name);
  if (!options.dryRun) {
    for (const slotStatus of status.slots) {
      if (!changed.includes(slotStatus.name)) continue;
      const slot = SLOTS.find((candidate) => candidate.name === slotStatus.name);
      await replaceOwnedFacade(
        {
          slot,
          destination: slotStatus.path,
          state: slotStatus.state,
          replacedPackage: slotStatus.replacedPackage,
        },
        status.providerVersion,
        modules,
      );
    }
  }
  // The editor slot is the one thing `setup` writes outside `node_modules`, so
  // it is decided and reported separately from the package slots rather than
  // folded into them. A collision is left exactly as the user wrote it: this
  // refuses to overwrite the key, the same way the package slots refuse a
  // direct or unrecognized package, and reports it instead of failing the
  // bridge that did work.
  // `inert` with no key in the file is the auto-detection divergence: the
  // ordinary lookup wins here and loses in the folder above. Writing at the
  // project root would not change which linter that folder finds, so it is only
  // written when the reader takes the second remedy and names the folder.
  const placementsPending = (status.editorSlot.ancestorPlacements ?? []).some(
    (placement) => placement.current !== placement.value,
  );
  const editorWritten =
    ["missing", "stale"].includes(status.editorSlot.state) ||
    placementsPending ||
    (status.editorSlot.state === "inert" &&
      status.editorSlot.currentValue === null &&
      options.workspaceRoot !== undefined &&
      options.workspaceRoot !== null);
  if (editorWritten) {
    if (!options.dryRun) {
      await writeEditorSlot(status.projectRoot, modules, status.editorSlot);
    }
    changed.push(status.editorSlot.name);
  }
  // Re-read rather than assert. Declaring the slot `active` because a write
  // returned is exactly the silence this goal exists to end: the key can be
  // written into a file the editor never opens, or hold a value the extension
  // refuses, and only re-inspecting it says so.
  const editorSlot = editorWritten && !options.dryRun
    ? await inspectEditorSlot(
        status.projectRoot,
        (await installedProvider(status.projectRoot)).root,
        modules,
        options,
      )
    : status.editorSlot;
  if (editorWritten && !options.dryRun) {
    // The extension reads this key once, when a window starts its server, and
    // never watches it. A key written into an already-open window changes
    // nothing until that window reloads - which is exactly how a freshly
    // written correct key and a dead editor coexist.
    editorSlot.notes = [
      ...(editorSlot.notes ?? []),
      `The editor reads "${EDITOR_SLOT.key}" only when a window starts its lint server. Any window that is already open keeps its current server: reload it (Developer: Reload Window) for this change to take effect.`,
    ];
  }
  return {
    ...status,
    action: options.dryRun ? "preview" : "setup",
    slots: status.slots.map((slot) =>
      !options.dryRun && changed.includes(slot.name) ? { ...slot, state: "active" } : slot,
    ),
    editorSlot,
    languageSupport,
    ...(tsconfigWrite ? { tsconfigWrite } : {}),
    changed,
    unchanged: [
      ...status.slots
        .filter((slot) => slot.state === "active" || slot.state === "collision")
        .map((slot) => slot.name),
      ...(editorWritten ? [] : [status.editorSlot.name]),
    ],
  };
}

export async function removeCompatibility(options: any = {}) {
  const status = await compatibilityStatus(options);
  const removed = [];
  for (const slot of status.slots) {
    if (!["active", "stale"].includes(slot.state)) continue;
    removed.push(slot.name);
    if (!options.dryRun) {
      if (slot.replacedPackage) {
        const candidate = SLOTS.find((entry) => entry.name === slot.name);
        const backup = backupPath(join(status.projectRoot, "node_modules"), candidate);
        if (!(await exists(backup))) {
          throw new Error(
            `cannot remove ${slot.name}: preserved ${slot.replacedPackage.name}@${slot.replacedPackage.version} is missing at ${backup}`,
          );
        }
        const temporary = `${slot.path}.oxc-tsrx-remove-${process.pid}`;
        await rm(temporary, { recursive: true, force: true });
        await rename(slot.path, temporary);
        try {
          await rename(backup, slot.path);
        } catch (error) {
          await rename(temporary, slot.path);
          throw error;
        }
        await rm(temporary, { recursive: true, force: true });
      } else {
        await rm(slot.path, { recursive: true, force: true });
      }
    }
  }
  // `inert` and `unresolvable` are keys this package wrote or adopted, they are
  // just keys that do not work. Leaving them behind would leave a value that
  // disables the extension's own lookup with nothing to take it back.
  // `currentValue` is what says there is a key in a file to take back. An
  // `inert` slot with none is a lookup this package never wrote anything for.
  const editorRemoved =
    ["active", "stale", "inert", "unresolvable"].includes(status.editorSlot.state) &&
    status.editorSlot.currentValue !== null;
  if (editorRemoved) {
    if (!options.dryRun) {
      await revertEditorSlot(join(status.projectRoot, "node_modules"), status.editorSlot);
    }
    removed.push(status.editorSlot.name);
  }
  return {
    ...status,
    action: options.dryRun ? "preview-remove" : "remove",
    slots: status.slots.map((slot) =>
      !options.dryRun && removed.includes(slot.name)
        ? { ...slot, state: slot.replacedPackage ? "replaceable" : "missing" }
        : slot,
    ),
    editorSlot: editorRemoved && !options.dryRun
      ? { ...status.editorSlot, state: "missing", currentValue: null }
      : status.editorSlot,
    removed,
  };
}

/**
 * What a package-slot collision means for the reader, by kind. Only the direct
 * dependency gets prose in the report, because it is the one a reader can act on
 * two different ways and the one that used to be a silent failure: the command
 * names stay with their package, so the drop-in `oxlint`/`oxfmt` skip `.tsrx`
 * with nothing on the command line saying so under pnpm.
 */
const SLOT_COLLISION_EXPLANATION = Object.freeze({
  "direct-dependency": (slot) => {
    const version = slot.occupant?.version ? ` ${slot.occupant.version}` : "";
    if (!slot.binary) {
      return `${slot.name}${version} is declared in your package.json, so that slot is yours and was left alone. Import @tsrx/oxc/parser for .tsrx.`;
    }
    const leaf = slot.name === "oxlint" ? "oxc-tsrx-lint" : "oxc-tsrx-fmt";
    return `${slot.name}${version} is declared in your package.json, so the ${slot.binary} command belongs to it: on the command line it runs exactly as it did before ${PROVIDER} was installed, and it does not read .tsrx files. Run ${leaf} for .tsrx, or remove the direct ${slot.name} dependency and let this package serve both (it bundles ${slot.name} and formats or lints .js, .ts and .tsx unchanged). The editor is wired separately: with "${EDITOR_SLOT.key}" written, the official OXC extension serves .tsrx through this package and keeps ordinary files on your own ${slot.name}.`;
  },
});

const EDITOR_SLOT_EXPLANATION = Object.freeze({
  active: (slot, projectRoot) =>
    `${toPosix(relative(projectRoot, slot.path))} carries "${slot.key}": "${slot.value}". This is the one file setup writes outside node_modules; it merges that single key and never edits package.json or tsconfig.json.`,
  stale: (slot, projectRoot) =>
    `${toPosix(relative(projectRoot, slot.path))} carries a "${slot.key}" this package wrote that no longer resolves here; setup refreshes it to "${slot.value}".`,
  missing: (slot, projectRoot) =>
    `${slot.linterShim.path} does not resolve into this package, so the official OXC extension would find no .tsrx support and say nothing about it. setup writes "${slot.key}": "${slot.value}" into ${toPosix(relative(projectRoot, slot.path))}, which is your tree, not node_modules.`,
  unnecessary: (slot) =>
    `${slot.linterShim.path} already resolves into this package, so the editor needs no setting and none was written.`,
  collision: (slot, projectRoot) =>
    `${toPosix(relative(projectRoot, slot.path))} already sets "${slot.key}" to "${slot.currentValue}". That is yours, so it was left alone; the editor will not use this package until it reads "${slot.value}".`,
  unreadable: (slot, projectRoot) =>
    `${toPosix(relative(projectRoot, slot.path))} could not be read as a single top-level JSON object, so nothing was written. Set "${slot.key}": "${slot.value}" there yourself.`,
  // Two ways to be inert, and they are not the same file. A key was written and
  // may never be read, or no key was needed here and the folder above resolves
  // somewhere else entirely. Only the first one has a value to quote.
  inert: (slot, projectRoot) =>
    slot.currentValue === null
      ? `${slot.linterShim.path} resolves into this package, so a window opened at ${projectRoot} needs no setting and none was written. A folder above it resolves elsewhere, so this is reported rather than called unnecessary.`
      : `${toPosix(relative(projectRoot, slot.path))} carries "${slot.key}": "${slot.currentValue}", and that value is right for this folder. Whether the editor ever reads it depends on which folder you open, so this is reported rather than claimed active.`,
  unresolvable: (slot, projectRoot) =>
    `${toPosix(relative(projectRoot, slot.path))} carries "${slot.key}": "${slot.currentValue}", and the official OXC extension would not run it. A configured value replaces the extension's own lookup instead of adding to it, so this is worse than no key at all.`,
});

/**
 * The width the report wraps to. A terminal reports its own; anything else,
 * including the pipe a transcript is captured through, gets a fixed 80 so the
 * recorded output is identical on every machine.
 */
function reportWidth() {
  const columns = process.stdout?.columns;
  if (!Number.isInteger(columns) || columns <= 0) return 80;
  return Math.min(Math.max(columns, 60), 100);
}

/**
 * Colour is for a human at a terminal and nobody else. A pipe, a CI log, a
 * captured transcript, or `NO_COLOR` all get plain text, so the only consumer
 * that ever sees an escape sequence is the one that can render it.
 * `FORCE_COLOR` is honoured because that is how you ask for it through a pipe.
 */
function reportColorEnabled() {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  return process.stdout?.isTTY === true;
}

const REPORT_STYLES = {
  bold: "1",
  dim: "2",
  green: "32",
  yellow: "33",
  cyan: "36",
};

function paint(text, style, enabled) {
  if (!enabled || !REPORT_STYLES[style]) return text;
  return `[${REPORT_STYLES[style]}m${text}[0m`;
}

/**
 * `missing` is the healthy answer outside Vite+, so no state here is coloured
 * as an error. Green marks a slot this package has taken over, dim marks one
 * that needs nothing, and yellow marks the states that are asking the reader
 * to look at something.
 */
const SLOT_STATE_STYLE = {
  active: "green",
  unnecessary: "dim",
  missing: "yellow",
  collision: "yellow",
  unreadable: "yellow",
  inert: "yellow",
  unresolvable: "yellow",
  removed: "dim",
};

/**
 * Wraps at spaces only. A path, a version range, or a `"plugins": [{ ... }]`
 * fragment must survive intact, because the reader's next move is to copy it
 * out of the terminal.
 */
function wrapReportText(text, firstPrefix, restPrefix, width) {
  const limit = Math.max(width - restPrefix.length, 24);
  const lines = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= limit) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.map((line, index) => `${index === 0 ? firstPrefix : restPrefix}${line}`);
}

/**
 * One text report for `status`, `setup`, and `remove`, so all three describe the
 * same four slots and the same unowned editor prerequisites in the same words.
 *
 * The states are padded into a column and every prose line is wrapped: this
 * report is read in a terminal after an install has already scrolled past, and
 * an unwrapped wall of it hid a single `missing` among three `active`.
 */
export function formatCompatibilityReport(result) {
  const width = reportWidth();
  const color = reportColorEnabled();
  const lines = [];
  const changes = result.changed ?? result.removed ?? null;
  if (changes) {
    const verb = result.action === "remove" ? "removed" : result.action;
    const noun = changes.length === 1 ? "slot" : "slots";
    lines.push(
      paint(
        `${verb} ${changes.length} compatibility ${noun} for ${PROVIDER} ${result.providerVersion} (${result.packageManager})`,
        "bold",
        color,
      ),
    );
  } else {
    lines.push(
      paint(
        `${PROVIDER} ${result.providerVersion} compatibility (${result.packageManager})`,
        "bold",
        color,
      ),
    );
  }

  const editor = result.editorSlot;
  const rows = result.slots.map((slot) => [slot.name, slot.state, slot.state]);
  if (editor) rows.push([editor.name, `${editor.state} (editor)`, editor.state]);
  if (result.tsconfigWrite) {
    const { path, state } = result.tsconfigWrite;
    rows.push([basename(path), `${state} (tsconfig)`, state === "preview" ? "stale" : "active"]);
  }
  const nameWidth = Math.max(...rows.map(([name]) => name.length));
  lines.push("");
  for (const [name, label, state] of rows) {
    const gutter = `  ${`${name}:`.padEnd(nameWidth + 1)}  `;
    lines.push(`${gutter}${paint(label, SLOT_STATE_STYLE[state] ?? "cyan", color)}`);
  }
  for (const slot of result.slots) {
    const explain = slot.state === "collision" ? SLOT_COLLISION_EXPLANATION[slot.collision] : null;
    if (!explain) continue;
    lines.push("");
    for (const line of wrapReportText(explain(slot), "      ", "      ", width)) {
      lines.push(paint(line, "dim", color));
    }
  }
  if (editor) {
    const explain = EDITOR_SLOT_EXPLANATION[editor.state];
    if (explain) {
      lines.push("");
      for (const line of wrapReportText(
        explain(editor, result.projectRoot),
        "      ",
        "      ",
        width,
      )) {
        lines.push(paint(line, "dim", color));
      }
    }
    // Everything the editor slot cannot claim: the folders above this one that
    // look like workspace roots, the two remedies, and any reason the value
    // itself would not start. Same shape as the prerequisite notes below,
    // because they ask the same thing of the reader: go and do this.
    for (const note of editor.notes ?? []) {
      lines.push("");
      const [first, ...rest] = wrapReportText(note, "", "    ", width);
      lines.push(`  ${paint("!", "yellow", color)} ${first}`);
      lines.push(...rest);
    }
  }

  const support = result.languageSupport;
  if (support && !support.ok) {
    lines.push("");
    lines.push(
      ...wrapReportText(
        "TSRX language support in the editor belongs to the TSRX toolchain, not to this package. Nothing below was installed, changed, or configured:",
        "",
        "",
        width,
      ).map((line) => paint(line, "dim", color)),
    );
    // A blank line between the notes, not just around the block. Four of these
    // run together as one paragraph otherwise, and each one is a separate thing
    // the reader has to go and do.
    for (const note of support.notes) {
      lines.push("");
      const [first, ...rest] = wrapReportText(note, "", "    ", width);
      lines.push(`  ${paint("!", "yellow", color)} ${first}`);
      lines.push(...rest);
    }
  }
  return `${lines.join("\n")}\n`;
}

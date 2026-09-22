import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEPENDENCY_FIELDS, extensionOf, findProjectRoot } from "./provider-resolve.js";
import { spawnCommand } from "./spawn-command.js";

/**
 * Arbitration for the canonical command names this package also publishes.
 *
 * `oxc-tsrx` ships `oxlint` and `oxfmt` bins because that is the only thing
 * that makes a plain `npm install @tsrx/oxc` reach released hosts: the installer
 * links `node_modules/.bin/oxlint`, and the released `oxc.oxc-vscode`
 * extension probes exactly that path first. Nothing else about the shipped
 * artifact reaches an unmodified host.
 *
 * The cost is a name collision. When a project *also* declares the official
 * `oxlint` or `oxfmt` package, whichever package wins `node_modules/.bin` is
 * decided by the installer, and installers disagree: npm 11 links this
 * package's launcher and pnpm 10 links the official one. Measured for T016.
 *
 * So the launcher decides for itself instead of inheriting the race. A direct
 * dependency on the official package in the project's own manifest is an
 * explicit statement about what that command name means, and it wins: the
 * launcher hands the whole invocation to the exact binary that package
 * declares. The observable behaviour of `oxlint`/`oxfmt` in such a project is
 * then identical under every installer, and identical to what it was before
 * `oxc-tsrx` was added.
 *
 * A transitive official package (Vite+ depends on `oxlint`, for instance) is
 * not such a statement, so it does not take the command name away.
 */

const OWNED_COMMANDS = Object.freeze({
  oxlint: Object.freeze({ leafBin: "oxc-tsrx-lint" }),
  oxfmt: Object.freeze({ leafBin: "oxc-tsrx-fmt" }),
});

/** The extension this package's provider block claims. */
const PROVIDED_EXTENSION = ".tsrx";

/** The exact official package this package vendors for each command it owns. */
const VENDORED_PACKAGES = Object.freeze({ oxlint: "oxlint-current", oxfmt: "oxfmt-current" });

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaresDirectly(manifest, name) {
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest?.[field];
    if (isPlainObject(declared) && typeof declared[name] === "string") return field;
  }
  return null;
}

function declaredBin(manifest, command) {
  if (typeof manifest.bin === "string") {
    return manifest.name === command ? manifest.bin : null;
  }
  if (!isPlainObject(manifest.bin)) return null;
  const declared = manifest.bin[command];
  return typeof declared === "string" && declared.length > 0 ? declared : null;
}

/** True for the package-name facade `oxc-tsrx setup` writes into that slot. */
function isCompatibilityFacade(manifest) {
  return manifest?.oxcTsrxCompatibility?.provider === "oxc-tsrx";
}

/**
 * Decide who owns `command` for the project `cwd` belongs to.
 *
 * Never throws for an ordinary project: an unreadable or absent manifest simply
 * means nothing took the name away. It throws only for the one genuinely
 * ambiguous case — the project declares the official package and that package
 * is not installed — because guessing there would silently change which linter
 * or formatter a pinned project runs.
 */
export async function decideCanonicalCommand(command, options: any = {}) {
  const owned = OWNED_COMMANDS[command];
  if (owned === undefined) throw new Error(`unknown canonical command: ${command}`);
  const cwd = options.cwd ?? process.cwd();

  let projectRoot;
  let manifest;
  try {
    projectRoot = await findProjectRoot(cwd);
    manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  } catch {
    return { command, owner: "@tsrx/oxc", reason: "no-project-manifest", projectRoot: null };
  }

  const field = declaresDirectly(manifest, command);
  if (field === null) {
    return { command, owner: "@tsrx/oxc", reason: "not-directly-declared", projectRoot };
  }

  let manifestPath;
  try {
    manifestPath = createRequire(join(projectRoot, "package.json")).resolve(
      `${command}/package.json`,
    );
  } catch {
    throw new Error(
      `${projectRoot}/package.json declares the official ${command} package in ${field}, ` +
        `but ${command} is not installed. Install dependencies, or remove that ` +
        `dependency to let oxc-tsrx own the ${command} command.`,
    );
  }

  const officialManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (isCompatibilityFacade(officialManifest)) {
    // `oxc-tsrx setup` already put this package in that slot on purpose.
    // Delegating would re-enter this launcher without bound.
    return {
      command,
      owner: "@tsrx/oxc",
      reason: "compatibility-facade",
      projectRoot,
      officialRoot: dirname(manifestPath),
    };
  }

  const declared = declaredBin(officialManifest, command);
  if (declared === null) {
    throw new Error(
      `${projectRoot}/package.json declares the official ${command} package in ${field}, ` +
        `but the installed ${officialManifest.name ?? command} does not declare a ` +
        `${command} binary. Remove that dependency to let oxc-tsrx own the ${command} command.`,
    );
  }

  return {
    command,
    owner: "project",
    reason: `declared-in-${field}`,
    projectRoot,
    officialRoot: dirname(manifestPath),
    officialVersion:
      typeof officialManifest.version === "string" ? officialManifest.version : null,
    binPath: resolve(dirname(manifestPath), declared),
  };
}

function versionParts(version) {
  return String(version)
    .split(/[-+]/u, 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const first = Number.isInteger(a[index]) ? a[index] : 0;
    const second = Number.isInteger(b[index]) ? b[index] : 0;
    if (first !== second) return first < second ? -1 : 1;
  }
  return 0;
}

function findProjectRootSync(start) {
  let directory = resolve(start);
  const filesystemRoot = parsePath(directory).root;
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    if (directory === filesystemRoot) return null;
    directory = dirname(directory);
  }
}

/** The declared `command` binary of the package whose manifest is at `manifestPath`, if any. */
function declaredBinaryOf(manifestPath, command) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (isCompatibilityFacade(manifest)) return null;
  const declared = declaredBin(manifest, command);
  if (declared === null) return null;
  const binPath = resolve(dirname(manifestPath), declared);
  let metadata;
  try {
    metadata = statSync(binPath);
  } catch {
    return null;
  }
  if (!metadata.isFile()) return null;
  return {
    binPath,
    root: dirname(manifestPath),
    version: typeof manifest.version === "string" ? manifest.version : null,
  };
}

const resolvedCanonicalBinaries = new Map();

/**
 * The official binary that runs `command` when this package owns the name.
 *
 * Owning the command name does not mean the vendored copy is the right tool
 * for the project's configuration. That configuration is the project's, and it
 * tracks whatever Oxlint or Oxfmt the project installed: a rule or option added
 * after this package's pin is rejected as unknown by the pin, even though the
 * project never chose the pin (tsrx-org/oxc#105). So the binary is the newer of
 * the project's installed official package, resolved from the project root
 * whether or not it is declared there, and the vendored copy. Rules are added
 * far more often than removed, so the newer parser accepts what either would.
 *
 * Never throws for an ordinary project: an unresolvable, undeclared, or
 * facade `command` package simply leaves the vendored copy in charge. Command
 * ownership itself is still `decideCanonicalCommand`'s decision.
 */
export function resolveCanonicalBinary(command, options: any = {}) {
  const vendoredPackage = VENDORED_PACKAGES[command];
  if (vendoredPackage === undefined) throw new Error(`unknown canonical command: ${command}`);
  const cwd = options.cwd ?? process.cwd();
  const fromUrl = options.fromUrl ?? import.meta.url;
  const key = `${command}\0${fromUrl}\0${cwd}`;
  const cached = resolvedCanonicalBinaries.get(key);
  if (cached !== undefined) return cached;

  const vendoredManifest = createRequire(fromUrl).resolve(`${vendoredPackage}/package.json`);
  const vendored = declaredBinaryOf(vendoredManifest, command);
  if (vendored === null) {
    throw new Error(`${vendoredPackage} does not declare its ${command} npm binary`);
  }

  const projectRoot = findProjectRootSync(cwd);
  let project = null;
  if (projectRoot !== null) {
    try {
      const manifestPath = createRequire(join(projectRoot, "package.json")).resolve(
        `${command}/package.json`,
      );
      project = declaredBinaryOf(manifestPath, command);
    } catch {
      project = null;
    }
  }

  const preferProject =
    project !== null &&
    project.version !== null &&
    vendored.version !== null &&
    compareVersions(project.version, vendored.version) > 0;
  const chosen = preferProject ? project : vendored;
  const resolved = Object.freeze({
    command,
    binPath: chosen.binPath,
    version: chosen.version,
    source: preferProject ? "project" : "vendored",
    officialRoot: chosen.root,
    vendoredVersion: vendored.version,
    projectVersion: project?.version ?? null,
    projectRoot,
  });
  resolvedCanonicalBinaries.set(key, resolved);
  return resolved;
}

/**
 * Runs the resolved canonical binary in place of this launcher, the way
 * `runOfficialCommand` runs a project's declared package. The vendored copy is
 * this package's own JavaScript launcher, so it is imported in this process
 * whatever its shebang says; a project's copy is executed by whatever it
 * declares.
 */
export async function runCanonicalBinary(resolved, options: any = {}) {
  if (resolved.source === "vendored") {
    await import(pathToFileURL(resolved.binPath).href);
    return;
  }
  await runOfficialCommand(resolved, options);
}

/**
 * Explains a configuration the resolved canonical tool rejected, naming the
 * versions involved so a project can see at once whether the pin is behind.
 */
export function configurationRejectionNotice(resolved, output) {
  const ran = `${resolved.command} ${resolved.version ?? "of unknown version"} (${
    resolved.source === "project" ? "the project's installed copy" : "the copy vendored by oxc-tsrx"
  })`;
  const installed =
    resolved.projectVersion !== null && resolved.projectVersion !== resolved.version
      ? ` The project has ${resolved.command} ${resolved.projectVersion} installed.`
      : "";
  return `${ran} rejected this project's configuration.${installed}\n${output}`.trimEnd();
}

/** Arguments that name a file this package's provider block claims. */
export function providedArguments(args) {
  return args.filter(
    (argument) =>
      typeof argument === "string" &&
      !argument.startsWith("-") &&
      extensionOf(argument) === PROVIDED_EXTENSION,
  );
}

/**
 * One actionable line, only when the caller actually asked about a `.tsrx`
 * file. Silence for every ordinary invocation is the point: a project that
 * pinned official Oxlint or Oxfmt must not gain new output because `oxc-tsrx`
 * is installed somewhere in its tree.
 */
export function deferralNotice(decision, args) {
  if (decision.owner !== "project") return null;
  const provided = providedArguments(args);
  if (provided.length === 0) return null;
  const owned = OWNED_COMMANDS[decision.command];
  const pinned =
    decision.officialVersion === null
      ? `the official ${decision.command} package`
      : `official ${decision.command} ${decision.officialVersion}`;
  return (
    `${decision.command} (oxc-tsrx): this project depends on ${pinned}, so the ` +
    `${decision.command} command runs it unchanged and will not read ` +
    `${provided.join(", ")}. Run \`npx ${owned.leafBin}\` for .tsrx files, or drop the ` +
    `direct ${decision.command} dependency to let oxc-tsrx serve both.`
  );
}

/**
 * A declared `bin` entry may be a JavaScript wrapper or a native executable.
 * Reading the shebang is a static file read, not an execution of the package.
 *
 * The BOM strip is not decoration. A UTF-8 byte-order mark is common in files
 * authored on Windows, and it sits in front of the `#!`, so without stripping
 * it a perfectly ordinary Node wrapper would be classified as a native
 * executable and spawned — which on Windows fails outright, because an
 * extensionless file is not something `CreateProcess` can run.
 */
export async function usesNodeInterpreter(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, 128, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/u, "");
    const shebang = head.split("\n", 1)[0];
    return shebang.startsWith("#!") && /\bnode(?:\.exe)?\b/u.test(shebang);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * Execute the official binary, preserving its exact behaviour. A Node wrapper
 * runs in this process so argv, stdio, exit code, and signal handling are the
 * program's own; anything else is spawned with inherited stdio and its status
 * is mirrored.
 *
 * `pathToFileURL` is load-bearing rather than tidy: on Windows a bare absolute
 * path such as `C:\project\node_modules\oxlint\bin\oxlint` is not a valid
 * import specifier, and `import()` rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME
 * because it reads `C:` as a URL scheme. Every host reaches the in-process
 * branch, so this is the difference between the launcher working on Windows and
 * failing on the first `oxlint` in a project that pinned the official package.
 *
 * `spawnCommand` covers the other branch: a declared `bin` may be a `.cmd` or
 * `.bat` launcher, which only a command interpreter can run. See
 * ./spawn-command.js for why that is done inline and without `shell: true`.
 *
 * A spawn that never starts is reported rather than thrown as an unhandled
 * `error` event, so the caller's `catch` turns it into this package's one-line
 * message instead of a stack trace from inside `node:child_process`.
 */
export async function runOfficialCommand(decision, options: any = {}) {
  if (await usesNodeInterpreter(decision.binPath)) {
    await import(pathToFileURL(decision.binPath).href);
    return;
  }
  const spawnProcess = options.spawn ?? spawn;
  const child = spawnCommand(
    decision.binPath,
    process.argv.slice(2),
    { stdio: "inherit" },
    spawnProcess,
  );
  let failure = null;
  // Attached before `once` adds its own rejecting listener, so this records the
  // cause even though the awaited promise is the one that rejects.
  child.on("error", (error) => (failure ??= error));
  const [status, signal] = await once(child, "close").catch(() => [null, null]);
  if (failure !== null) {
    throw new Error(
      `could not execute ${decision.binPath}, the ${decision.command} binary declared by ` +
        `${decision.officialRoot ?? "the official package"}: ${failure.message}`,
    );
  }
  process.exitCode = signal === null ? (status ?? 0) : 2;
}

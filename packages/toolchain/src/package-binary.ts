import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve the executable declared by an installed npm package's `bin` field. */
export function resolvePackageBinary(packageName, binaryName, fromUrl) {
  const localRequire = createRequire(fromUrl);
  const manifestPath = localRequire.resolve(`${packageName}/package.json`);
  const manifest = localRequire(manifestPath);
  const declared =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binaryName];
  if (typeof declared !== "string" || declared.length === 0) {
    throw new Error(`${packageName} does not declare its ${binaryName} npm binary`);
  }

  const entry = resolve(dirname(manifestPath), declared);
  let metadata;
  try {
    metadata = statSync(entry);
  } catch {
    throw new Error(`${packageName} declares a missing ${binaryName} npm binary at ${entry}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${packageName} declares a non-file ${binaryName} npm binary at ${entry}`);
  }
  return entry;
}

// Kept here rather than shared with provider-resolve.ts: the VSIX bundles that
// module by itself, and an import edge between the two lets the editor build
// inline it through this file even when the extension cannot resolve it.
function projectRootOf(start) {
  const from = resolve(start);
  const filesystemRoot = parse(from).root;
  let directory = from;
  for (;;) {
    if (statSync(join(directory, "package.json"), { throwIfNoEntry: false })?.isFile()) {
      return directory;
    }
    if (directory === filesystemRoot) return null;
    directory = dirname(directory);
  }
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

function declaredVersion(manifestPath, localRequire) {
  const version = localRequire(manifestPath).version;
  return typeof version === "string" && /^\d+\.\d+\.\d+/u.test(version) ? version : null;
}

/**
 * Resolve the Oxlint that parses this project's configuration.
 *
 * `oxlint-current` is a pin: one Oxlint version, frozen when this package was
 * released. The configuration it has to parse is not pinned at all, because the
 * project owns that file and writes it against whatever Oxlint the project
 * installed. So a project whose Oxlint is newer than the pin has its own config
 * rejected over rules that do exist, which the pin has simply never heard of
 * (tsrx-org/oxc#105). Bumping the pin does not fix that: it re-breaks on the
 * next Oxlint release that adds a rule.
 *
 * Preferring the project's own Oxlint whenever it is at least as new as the pin
 * does fix it, and cannot regress the pinned behaviour. An older, absent, or
 * unreadable project Oxlint leaves the pin exactly where it was, so the pin
 * stays the floor every composition lane here was established against.
 *
 * This is deliberately not the question `decideCanonicalCommand` answers. That
 * one decides who owns the *command name*, where a merely transitive Oxlint must
 * not take the name away from an explicit `oxc-tsrx` install. Which binary
 * parses the project's config is separate: a transitively installed Oxlint is
 * still the version that project's config was written against.
 */
export function selectCanonicalOxlint(fromUrl, cwd = process.cwd()) {
  const pinnedPath = resolvePackageBinary("oxlint-current", "oxlint", fromUrl);
  let pinned = { path: pinnedPath, version: null, source: "pinned" };
  const localRequire = createRequire(fromUrl);
  let pinnedManifestPath;
  let pinnedVersion;
  try {
    pinnedManifestPath = localRequire.resolve("oxlint-current/package.json");
    pinnedVersion = declaredVersion(pinnedManifestPath, localRequire);
    pinned = { path: pinnedPath, version: pinnedVersion, source: "pinned" };
  } catch {
    return pinned;
  }
  if (pinnedVersion === null) return pinned;

  const projectRoot = projectRootOf(cwd);
  if (projectRoot === null) return pinned;

  const projectRequire = createRequire(join(projectRoot, "package.json"));
  let projectManifestPath;
  let projectVersion;
  try {
    projectManifestPath = projectRequire.resolve("oxlint/package.json");
    projectVersion = declaredVersion(projectManifestPath, projectRequire);
  } catch {
    return pinned;
  }
  // The pinned package resolves under this one, so its own manifest must never
  // be mistaken for a separate project install.
  if (projectManifestPath === pinnedManifestPath) return pinned;
  // `oxc-tsrx setup` can write a compatibility facade into the `oxlint` slot.
  // That facade carries this package's version and re-enters this launcher, so
  // selecting it would recurse without bound. It is identified the same way
  // `decideCanonicalCommand` identifies it, by its own manifest metadata,
  // because its path is its own and a path comparison never sees it.
  if (projectRequire(projectManifestPath).oxcTsrxCompatibility?.provider === "oxc-tsrx") {
    return pinned;
  }
  if (projectVersion === null || compareVersions(projectVersion, pinnedVersion) < 0) return pinned;

  try {
    return {
      path: resolvePackageBinary("oxlint", "oxlint", pathToFileURL(projectManifestPath).href),
      version: projectVersion,
      source: "project",
    };
  } catch {
    return pinned;
  }
}

/** Execute a declared JavaScript npm binary in this process. */
export async function importDeclaredPackageBinary(packageName, binaryName, fromUrl) {
  const entry = resolvePackageBinary(packageName, binaryName, fromUrl);
  await import(pathToFileURL(entry).href);
}

/** The path of the Oxlint that parses this project's config. */
export function resolveCanonicalOxlint(fromUrl, cwd = process.cwd()) {
  return selectCanonicalOxlint(fromUrl, cwd).path;
}

/** Execute the Oxlint that parses this project's config, in this process. */
export async function importCanonicalOxlint(fromUrl, cwd = process.cwd()) {
  await import(pathToFileURL(resolveCanonicalOxlint(fromUrl, cwd)).href);
}

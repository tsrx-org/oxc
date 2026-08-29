import { cp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setupCompatibility } from "../../packages/toolchain/dist/compat.js";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");

async function linkPackage(modules, name, packageRoot) {
  const destination = join(modules, ...name.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await symlink(packageRoot, destination, "dir");
}

async function copyPackageEntries(source, destination, entries) {
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const from = join(source, entry);
    try {
      await stat(from);
    } catch {
      continue;
    }
    await cp(from, join(destination, entry), { recursive: true });
  }
}

async function resolvePackageRoot(packageRequire, name) {
  try {
    return dirname(packageRequire.resolve(`${name}/package.json`));
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  let directory = dirname(packageRequire.resolve(name));
  for (;;) {
    const manifestPath = join(directory, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name === name) return directory;
    } catch {
      // Continue walking through package-internal entry directories.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`unable to locate package root for ${name}`);
    directory = parent;
  }
}

function platformSuffix() {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `win32-${process.arch}-msvc`;
  if (process.platform === "linux") {
    const report = process.report?.getReport?.();
    const libc = report?.header?.glibcVersionRuntime ? "gnu" : "musl";
    return `linux-${process.arch}-${libc}`;
  }
  throw new Error(`unsupported package-test platform: ${process.platform}-${process.arch}`);
}

/**
 * Build the physical package layout a consumer install exposes to Vite+, the thin companions,
 * their canonical OXC delegates, and native bindings. Package files are copied; only unrelated
 * dependency packages and platform bindings are symlinked to the read-only workspace install.
 */
export async function installPhysicalToolPackages(modules, vitePlusPackage) {
  const vitePlusSource = dirname(require.resolve(`${vitePlusPackage}/package.json`));
  const vitePlusDestination = join(modules, "vite-plus");
  await copyPackageEntries(vitePlusSource, vitePlusDestination, [
    "package.json",
    "bin",
    "binding",
    "dist",
  ]);

  const vitePlusManifest = JSON.parse(await readFile(join(vitePlusSource, "package.json"), "utf8"));
  const vitePlusRequire = createRequire(join(vitePlusSource, "package.json"));
  for (const dependency of Object.keys(vitePlusManifest.dependencies ?? {})) {
    if (dependency === "oxlint" || dependency === "oxfmt" || dependency === "oxlint-tsgolint") {
      continue;
    }
    await linkPackage(modules, dependency, await resolvePackageRoot(vitePlusRequire, dependency));
  }
  const suffix = platformSuffix();
  const vitePlusBinding = `@voidzero-dev/vite-plus-${suffix}`;
  await linkPackage(
    modules,
    vitePlusBinding,
    await resolvePackageRoot(vitePlusRequire, vitePlusBinding),
  );

  const toolchainDestination = join(modules, "@tsrx/oxc");
  await copyPackageEntries(join(root, "packages/toolchain"), toolchainDestination, [
    "package.json",
    "bin",
    "dist",
    "LICENSE",
  ]);

  // The toolchain's runtime dependency must resolve from the physical copy the
  // same way a real install provides it.
  const toolchainRequire = createRequire(join(root, "packages/toolchain/package.json"));
  const pathePackage = await resolvePackageRoot(toolchainRequire, "pathe");
  await copyPackageEntries(pathePackage, join(toolchainDestination, "node_modules/pathe"), [
    "package.json",
    "dist",
    "LICENSE",
  ]);

  const canonicalLint = dirname(require.resolve("oxlint-current/package.json"));
  const canonicalFormat = dirname(require.resolve("oxfmt-current/package.json"));
  await Promise.all([
    copyPackageEntries(canonicalLint, join(toolchainDestination, "node_modules/oxlint-current"), [
      "package.json",
      "bin",
      "dist",
      "configuration_schema.json",
      "LICENSE",
    ]),
    copyPackageEntries(canonicalFormat, join(toolchainDestination, "node_modules/oxfmt-current"), [
      "package.json",
      "bin",
      "dist",
      "LICENSE",
    ]),
  ]);
  for (const [source, packageRequire] of [
    [canonicalLint, createRequire(join(canonicalLint, "package.json"))],
    [canonicalFormat, createRequire(join(canonicalFormat, "package.json"))],
  ]) {
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await linkPackage(modules, dependency, await resolvePackageRoot(packageRequire, dependency));
    }
  }
  // The native bindings are optional dependencies of Oxlint and Oxfmt, so they
  // are resolved from those packages rather than from this file. pnpm keeps a
  // package's optional dependencies beside it in the virtual store instead of
  // hoisting them to the repository root, and only the owning package can see
  // them.
  await Promise.all([
    linkPackage(modules, "tinyglobby", await resolvePackageRoot(require, "tinyglobby")),
    linkPackage(
      modules,
      `@oxlint/binding-${suffix}`,
      await resolvePackageRoot(
        createRequire(join(canonicalLint, "package.json")),
        `@oxlint/binding-${suffix}`,
      ),
    ),
    linkPackage(
      modules,
      `@oxfmt/binding-${suffix}`,
      await resolvePackageRoot(
        createRequire(join(canonicalFormat, "package.json")),
        `@oxfmt/binding-${suffix}`,
      ),
    ),
    linkPackage(modules, "oxlint-tsgolint", await resolvePackageRoot(require, "oxlint-tsgolint")),
  ]);

  const projectRoot = dirname(modules);
  const projectManifestPath = join(projectRoot, "package.json");
  const projectManifest = JSON.parse(await readFile(projectManifestPath, "utf8"));
  projectManifest.devDependencies = {
    ...projectManifest.devDependencies,
    "@tsrx/oxc": "0.8.0",
  };
  await writeFile(projectManifestPath, `${JSON.stringify(projectManifest, null, 2)}\n`);
  await setupCompatibility({ projectRoot });
}

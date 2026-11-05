import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const packageRoot = join(root, "packages/tsrx-core-compat");
const toolchainPackageRoot = join(root, "packages/toolchain");
const expectedInventory = [
  "facade.js",
  "index.d.ts",
  "index.js",
  "style.js",
  "types/estree.d.ts",
  "types/index.d.ts",
];
const declarationFiles = ["index.d.ts", "types/index.d.ts", "types/estree.d.ts"];
const toolchainDeclarationFiles = [
  "canonical-command.d.ts",
  "compat.d.ts",
  "format.d.ts",
  "index.d.ts",
  "lint-plugins-dev.d.ts",
  "lint.d.ts",
  "parser.d.ts",
  "provider-resolve.d.ts",
  "spawn-command.d.ts",
];

function supportsTsdown(version) {
  const [major, minor] = version.slice(1).split(".").map(Number);
  return (major === 22 && minor >= 18) || major > 24 || (major === 24 && minor >= 11);
}

async function inventory(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(directory, path).replaceAll("\\", "/"));
    }
  }
  await visit(directory);
  return files.sort();
}

test(
  "committed core-compat dist is an exact, read-only rebuild",
  {
    skip: supportsTsdown(process.version)
      ? false
      : `visible skip: tsdown 0.22.14 requires Node ^22.18.0 || >=24.11.0; running ${process.version}`,
  },
  async (context) => {
    const fixture = await mkdtemp(join(tmpdir(), "oxc-tsrx-core-compat-build-"));
    const fixturePackage = join(fixture, "tsrx-core-compat");
    context.after(() => rm(fixture, { recursive: true, force: true }));

    await cp(packageRoot, fixturePackage, {
      recursive: true,
      filter: (source) => !/[\\/](?:dist|node_modules)(?:[\\/]|$)/u.test(source),
    });
    await symlink(
      join(root, "node_modules"),
      join(fixturePackage, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const committedBefore = new Map(
      await Promise.all(
        expectedInventory.map(async (file) => [
          file,
          await readFile(join(packageRoot, "dist", file)),
        ]),
      ),
    );
    const build = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/tsdown/dist/run.mjs"),
        "--config",
        join(fixturePackage, "tsdown.config.ts"),
      ],
      { cwd: fixturePackage, encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);

    assert.deepEqual(await inventory(join(packageRoot, "dist")), expectedInventory);
    assert.deepEqual(await inventory(join(fixturePackage, "dist")), expectedInventory);
    for (const file of expectedInventory) {
      assert.deepEqual(
        await readFile(join(fixturePackage, "dist", file)),
        committedBefore.get(file),
        `packages/tsrx-core-compat/dist/${file} is stale; run pnpm run build:packages`,
      );
      assert.deepEqual(
        await readFile(join(packageRoot, "dist", file)),
        committedBefore.get(file),
        `freshness check rewrote packages/tsrx-core-compat/dist/${file}`,
      );
    }

    for (const file of declarationFiles) {
      assert.deepEqual(
        await readFile(join(packageRoot, "dist", file)),
        await readFile(join(packageRoot, "src", file)),
        `dist/${file} must be a byte-identical copy of src/${file}`,
      );
    }
  },
);

test(
  "committed toolchain dist is an exact, complete, read-only rebuild",
  {
    skip: supportsTsdown(process.version)
      ? false
      : `visible skip: tsdown 0.22.14 requires Node ^22.18.0 || >=24.11.0; running ${process.version}`,
  },
  async (context) => {
    const fixture = await mkdtemp(join(tmpdir(), "oxc-tsrx-toolchain-build-"));
    const fixturePackage = join(fixture, "toolchain");
    context.after(() => rm(fixture, { recursive: true, force: true }));

    await cp(toolchainPackageRoot, fixturePackage, {
      recursive: true,
      filter: (source) => !/[\\/](?:dist|node_modules)(?:[\\/]|$)/u.test(source),
    });
    await cp(
      join(packageRoot, "dist"),
      join(fixture, "tsrx-core-compat", "dist"),
      { recursive: true },
    );
    await symlink(
      join(root, "node_modules"),
      join(fixturePackage, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const authoredRuntime = (await inventory(join(toolchainPackageRoot, "src")))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
      .map((file) => `${file.slice(0, -3)}.js`)
      .sort();
    assert.equal(authoredRuntime.filter((file) => !file.startsWith("bin/")).length, 24);
    assert.equal(authoredRuntime.filter((file) => file.startsWith("bin/")).length, 6);
    assert.equal(toolchainDeclarationFiles.length, 9);
    const toolchainExpectedInventory = [
      ...authoredRuntime,
      ...toolchainDeclarationFiles,
      "tsrx-core-compat/facade.js",
      "tsrx-core-compat/index.d.ts",
      "tsrx-core-compat/index.js",
      "tsrx-core-compat/style.js",
      "tsrx-core-compat/types/estree.d.ts",
      "tsrx-core-compat/types/index.d.ts",
    ].sort();
    const committedBefore = new Map(
      await Promise.all(
        toolchainExpectedInventory.map(async (file) => [
          file,
          await readFile(join(toolchainPackageRoot, "dist", file)),
        ]),
      ),
    );
    const build = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/tsdown/dist/run.mjs"),
        "--config",
        join(fixturePackage, "tsdown.config.ts"),
      ],
      { cwd: fixturePackage, encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const committedInventory = await inventory(join(toolchainPackageRoot, "dist"));
    const rebuiltInventory = await inventory(join(fixturePackage, "dist"));
    assert.deepEqual(committedInventory, toolchainExpectedInventory);
    assert.deepEqual(rebuiltInventory, toolchainExpectedInventory);
    assert.deepEqual(
      committedInventory.filter((file) => file.endsWith(".js")),
      [
        ...authoredRuntime,
        "tsrx-core-compat/facade.js",
        "tsrx-core-compat/index.js",
        "tsrx-core-compat/style.js",
      ].sort(),
      "every authored toolchain runtime must have exactly one emitted JavaScript file",
    );
    for (const file of toolchainExpectedInventory) {
      assert.deepEqual(
        await readFile(join(fixturePackage, "dist", file)),
        committedBefore.get(file),
        `packages/toolchain/dist/${file} is stale; run pnpm run build:packages`,
      );
      assert.deepEqual(
        await readFile(join(toolchainPackageRoot, "dist", file)),
        committedBefore.get(file),
        `freshness check rewrote packages/toolchain/dist/${file}`,
      );
    }

    for (const file of toolchainDeclarationFiles) {
      assert.deepEqual(
        await readFile(join(toolchainPackageRoot, "dist", file)),
        await readFile(join(toolchainPackageRoot, "src", file)),
        `dist/${file} must be a byte-identical copy of src/${file}`,
      );
    }
  },
);

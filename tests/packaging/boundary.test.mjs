import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveNpmInvocation } from "../helpers/npm-invocation.mjs";
import { resolveVsceInvocation } from "../../scripts/vsce-invocation.ts";
import { temporaryDirectory } from "./temporary-directory.mjs";

const root = resolve(import.meta.dirname, "../..");
const adapterManifestPath = join(root, "crates/oxc_adapter/Cargo.toml");
const adapterSourcePath = join(root, "crates/oxc_adapter/src/lib.rs");
const editorIntegrationPath = join(root, "docs/integrations/editor.md");
const upstreamingGuidePath = join(root, "docs/architecture/upstreaming-to-oxc.md");
const canonicalRepository = "https://github.com/oxc-project/oxc";
const pinnedOxcRevision = "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40";
const auditedOxcMain = "6fe866af3036127c2236cc1db557f086c4408905";
const expectedAdapterDependencies = [
  "oxc_allocator",
  "oxc_ast",
  "oxc_ast_visit",
  "oxc_config",
  "oxc_data_structures",
  "oxc_diagnostics",
  "oxc_estree",
  "oxc_formatter",
  "oxc_formatter_core",
  "oxc_language_server",
  "oxc_linter",
  "oxc_parser",
  "oxc_semantic",
  "oxc_span",
  "oxc_syntax",
];

async function writeNpmFixture(
  packageRoot,
  { declared = "./cli/from-public-manifest.mjs", contents = "#!/usr/bin/env node\n" } = {},
) {
  const entry = resolve(packageRoot, declared);
  await mkdir(dirname(entry), { recursive: true });
  await Promise.all([
    writeFile(entry, contents),
    writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "npm",
        version: "99.0.0-test",
        bin: { npm: declared },
      })}\n`,
    ),
  ]);
  return entry;
}

async function publicNpmEntry(entryPath) {
  const entry = await realpath(entryPath);
  let directory = dirname(entry);
  while (true) {
    const manifestPath = join(directory, "package.json");
    const source = await readFile(manifestPath, "utf8").catch(() => null);
    if (source !== null) {
      let manifest;
      try {
        manifest = JSON.parse(source);
      } catch {
        manifest = null;
      }
      if (manifest?.name === "npm") {
        const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.npm;
        if (typeof declared !== "string" || declared.length === 0) {
          throw new Error("npm's public package manifest does not declare bin.npm");
        }
        return {
          manifest,
          entry: await realpath(resolve(directory, declared)),
        };
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`could not find npm's public package manifest above ${entry}`);
    }
    directory = parent;
  }
}

function dependencyTables(manifest) {
  const dependencies = new Map();
  for (const match of manifest.matchAll(/^(oxc_[\w-]+)\s*=\s*\{([^\n}]*)\}\s*$/gm)) {
    dependencies.set(match[1], match[2]);
  }
  return dependencies;
}

function dependencyNames(manifest) {
  return [
    ...manifest.matchAll(/^(oxc_[\w-]+)\s*=/gm),
    ...manifest.matchAll(/^\[(?:[^\]\n]+\.)?dependencies\.(oxc_[\w-]+)\]\s*$/gm),
    ...manifest.matchAll(/\bpackage\s*=\s*"(oxc_[\w-]+)"/gm),
  ].map((match) => match[1]);
}

function quotedField(table, field) {
  return table.match(new RegExp(`(?:^|,)\\s*${field}\\s*=\\s*"([^"]+)"`))?.[1];
}

function lockPackages(lock) {
  return lock
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => ({
      block,
      name: block.match(/^name\s*=\s*"([^"]+)"/m)?.[1],
      source: block.match(/^source\s*=\s*"([^"]+)"/m)?.[1],
    }));
}

async function cargoManifests(directory) {
  const manifests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(directory, entry.name, "Cargo.toml");
    try {
      manifests.push([manifestPath, await readFile(manifestPath, "utf8")]);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return manifests;
}

async function walkDirectories(directory, visit) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || [".git", "node_modules", "target"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    visit(path);
    await walkDirectories(path, visit);
  }
}

test("canonical OXC crates resolve through one exact adapter revision", async () => {
  const [adapterManifest, adapterSource, lock, runtime, nativePackager, vscodePackager] =
    await Promise.all([
      readFile(adapterManifestPath, "utf8"),
      readFile(adapterSourcePath, "utf8"),
      readFile(join(root, "Cargo.lock"), "utf8"),
      readFile(join(root, "packages/toolchain/dist/runtime.js"), "utf8"),
      readFile(join(root, "scripts/package-native.ts"), "utf8"),
      readFile(join(root, "scripts/package-vscode.ts"), "utf8"),
    ]);

  const dependencies = dependencyTables(adapterManifest);
  assert.deepEqual([...dependencies.keys()].sort(), expectedAdapterDependencies);

  const revisions = new Set();
  for (const [name, table] of dependencies) {
    assert.equal(
      quotedField(table, "git"),
      canonicalRepository,
      `${name} must use the canonical OXC repository`,
    );
    const revision = quotedField(table, "rev");
    assert.match(revision ?? "", /^[0-9a-f]{40}$/, `${name} must pin one full commit SHA`);
    assert.equal(quotedField(table, "path"), undefined, `${name} must not use a local checkout`);
    assert.equal(quotedField(table, "branch"), undefined, `${name} must not follow a branch`);
    assert.equal(quotedField(table, "tag"), undefined, `${name} must not follow a tag`);
    revisions.add(revision);
  }
  assert.equal(revisions.size, 1, "all adapter dependencies must move in one OXC upgrade");
  const [revision] = revisions;

  const constant = adapterSource.match(
    /pub const OXC_REVISION:\s*&str\s*=\s*"([0-9a-f]{40})"/,
  )?.[1];
  assert.equal(constant, revision, "the adapter's public revision must match its dependencies");

  const packages = lockPackages(lock);
  for (const name of expectedAdapterDependencies) {
    const resolved = packages.filter(
      (entry) => entry.name === name && entry.source?.startsWith(`git+${canonicalRepository}`),
    );
    assert.equal(resolved.length, 1, `${name} must resolve exactly once from canonical OXC`);
    assert.match(
      resolved[0].source,
      new RegExp(`\\?rev=${revision}#${revision}$`),
      `${name} lock entry must resolve the adapter's exact revision`,
    );
  }

  const canonicalLockSources = new Set(
    packages
      .map((entry) => entry.source)
      .filter((source) => source?.startsWith(`git+${canonicalRepository}`)),
  );
  assert.deepEqual(
    [...canonicalLockSources],
    [`git+${canonicalRepository}?rev=${revision}#${revision}`],
    "Cargo.lock must not contain a second canonical OXC source or revision",
  );
  const [canonicalLockSource] = canonicalLockSources;
  const canonicalPackageNames = new Set(
    packages.filter((entry) => entry.source === canonicalLockSource).map((entry) => entry.name),
  );
  for (const name of canonicalPackageNames) {
    const conflictingIdentities = packages.filter(
      (entry) => entry.name === name && entry.source !== canonicalLockSource,
    );
    assert.deepEqual(
      conflictingIdentities,
      [],
      `${name} must not resolve from both canonical Git and another Cargo source`,
    );
  }

  const distributionPins = [
    ["runtime", runtime.match(/const OXC_REVISION\s*=\s*"([0-9a-f]{40})"/)?.[1]],
    ["native packager", nativePackager.match(/const revision\s*=\s*"([0-9a-f]{40})"/)?.[1]],
    ["VS Code packager", vscodePackager.match(/const revision\s*=\s*"([0-9a-f]{40})"/)?.[1]],
  ];
  for (const [label, pin] of distributionPins) {
    assert.equal(pin, revision, `${label} metadata must identify the exact adapter revision`);
  }
});

test("no crate bypasses the OXC adapter", async () => {
  const manifests = [
    [join(root, "Cargo.toml"), await readFile(join(root, "Cargo.toml"), "utf8")],
    ...(await cargoManifests(join(root, "crates"))),
  ];
  for (const [path, manifest] of manifests) {
    if (path === adapterManifestPath) continue;
    const directOxcDependencies = dependencyNames(manifest).filter(
      (name) => name !== "oxc_adapter",
    );
    assert.deepEqual(
      directOxcDependencies,
      [],
      `${relative(root, path)} imports canonical OXC outside oxc_adapter`,
    );
    assert.doesNotMatch(
      manifest,
      /github\.com\/oxc-project\/oxc|(?:^|[,\s])(?:git|rev|branch|tag)\s*=.*oxc/,
      `${relative(root, path)} must not declare an OXC source`,
    );
  }
});

test("the ordinary OXC adapter has a one-way zero-entry boundary from TSRX", async () => {
  const [adapterManifest, engineManifest] = await Promise.all([
    readFile(adapterManifestPath, "utf8"),
    readFile(join(root, "crates/tsrx_parser_engine/Cargo.toml"), "utf8"),
  ]);

  assert.doesNotMatch(
    adapterManifest,
    /^tsrx_(?:parser_engine|syntax)\s*=/m,
    "ordinary OXC routes must not link the TSRX scanner or parser engine",
  );
  assert.match(
    engineManifest,
    /^oxc_adapter\s*=\s*\{[^}\n]*path\s*=\s*"\.\.\/oxc_adapter"[^}\n]*default-features\s*=\s*false[^}\n]*features\s*=\s*\[\s*"parser"\s*\][^}\n]*\}/m,
    "the TSRX engine must depend one-way on only the pinned OXC parser adapter",
  );
});

test("the workspace has no Cargo patch, vendor tree, checkout, or copied OXC crate", async () => {
  const manifests = [
    [join(root, "Cargo.toml"), await readFile(join(root, "Cargo.toml"), "utf8")],
    ...(await cargoManifests(join(root, "crates"))),
  ];
  for (const [path, manifest] of manifests) {
    assert.doesNotMatch(
      manifest,
      /^\s*\[patch(?:\.|\])/m,
      `${relative(root, path)} must not patch Cargo sources`,
    );
    assert.doesNotMatch(
      manifest,
      /^\s*replace-with\s*=/m,
      `${relative(root, path)} must not replace Cargo sources`,
    );
  }

  for (const name of ["config", "config.toml"]) {
    const path = join(root, ".cargo", name);
    let config;
    try {
      config = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    assert.doesNotMatch(
      config,
      /^\s*\[source\.|^\s*(?:replace-with|directory)\s*=/m,
      `${relative(root, path)} must not replace canonical Cargo sources`,
    );
  }

  const forbiddenDirectories = [];
  await walkDirectories(root, (path) => {
    const component = basename(path).toLowerCase();
    if (
      ["vendor", "vendored", "checkouts", "upstream"].includes(component) ||
      /^(?:oxc[-_])?(?:source|sources|checkout|upstream|vendor)$/.test(component) ||
      /^(?:source|checkout|upstream|vendor)[-_]oxc$/.test(component)
    ) {
      forbiddenDirectories.push(relative(root, path).split(sep).join("/"));
    }
  });
  assert.deepEqual(
    forbiddenDirectories,
    [],
    `forbidden source trees found: ${forbiddenDirectories.join(", ")}`,
  );

  for (const [path, manifest] of manifests) {
    if (path === adapterManifestPath) continue;
    const packageName = manifest.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    assert.equal(
      expectedAdapterDependencies.includes(packageName),
      false,
      `${relative(root, path)} copies canonical OXC crate ${packageName}`,
    );
  }
});

test("VSCE runs its manifest-declared JavaScript entry through Node on Windows", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-vsce-invocation-");
  const packageRoot = join(directory, "node_modules/@vscode/vsce");
  const consumer = join(directory, "package-vscode.mjs");
  const declaredEntry = join(packageRoot, "commands/vsce.js");
  const windowsNode = String.raw`C:\Program Files\nodejs\node.exe`;

  try {
    await Promise.all([
      mkdir(join(packageRoot, "commands"), { recursive: true }),
      mkdir(join(directory, "node_modules/.bin"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(consumer, "export {};\n"),
      writeFile(declaredEntry, "#!/usr/bin/env node\n"),
      writeFile(join(directory, "node_modules/.bin/vsce.cmd"), "@echo private shim\r\n"),
      writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "@vscode/vsce",
          version: "1.0.0-test",
          bin: { vsce: "./commands/vsce.js" },
        })}\n`,
      ),
    ]);

    const invocation = resolveVsceInvocation(["package", "--target", "win32-x64"], {
      fromUrl: pathToFileURL(consumer).href,
      nodeExecutable: windowsNode,
    });

    assert.equal(invocation.executable, windowsNode);
    assert.deepEqual(invocation.args, [
      await realpath(resolve(declaredEntry)),
      "package",
      "--target",
      "win32-x64",
    ]);
    assert.doesNotMatch(invocation.args[0], /[\\/]\.bin[\\/]|\.cmd$/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository VSCE invocation resolves the installed public package manifest", () => {
  const invocation = resolveVsceInvocation(["--version"]);

  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.args.length, 2);
  assert.match(invocation.args[0], /node_modules[\\/]@vscode[\\/]vsce[\\/]vsce$/u);
  assert.equal(invocation.args[1], "--version");
  assert.doesNotMatch(invocation.args[0], /[\\/]\.bin[\\/]|\.cmd$/iu);
});

test("npm rejects every exact dotfile basename before shebang inspection", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-npm-rejected-dotfiles-");
  const nodeDirectory = join(directory, "node");
  const nodeExecutable = join(nodeDirectory, "node.exe");
  const packageRoot = join(nodeDirectory, "node_modules/npm");

  try {
    await mkdir(nodeDirectory, { recursive: true });
    await writeFile(nodeExecutable, "simulated node executable\n");
    for (const name of [
      ".cmd",
      ".CMD",
      ".bat",
      ".exe",
      ".com",
      ".ps1",
      ".command",
      ".txt",
      ".wat",
      ".js",
      ".cjs",
      ".mjs",
      ".hidden.js",
    ]) {
      await writeNpmFixture(packageRoot, {
        declared: `./cli/${name}`,
        contents: "#!/usr/bin/env node\nprocess.exit(0);\n",
      });
      assert.throws(
        () => resolveNpmInvocation(["pack"], { nodeExecutable, env: { PATH: "" } }),
        /could not resolve npm's manifest-declared JavaScript entry/iu,
        name,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm categorically rejects manifest-declared shell and native launchers", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-npm-rejected-launchers-");
  const nodeDirectory = join(directory, "node");
  const nodeExecutable = join(nodeDirectory, "node.exe");
  const packageRoot = join(nodeDirectory, "node_modules/npm");

  try {
    await mkdir(nodeDirectory, { recursive: true });
    await writeFile(nodeExecutable, "simulated node executable\n");
    for (const suffix of [".cmd", ".CMD", ".bat", ".exe", ".com", ".ps1", ".command"]) {
      await writeNpmFixture(packageRoot, {
        declared: `./cli/adversarial${suffix}`,
        contents: "#!/usr/bin/env node\nprocess.exit(0);\n",
      });
      assert.throws(
        () =>
          resolveNpmInvocation(["pack"], {
            nodeExecutable,
            env: { PATH: "" },
          }),
        /could not resolve npm's manifest-declared JavaScript entry/iu,
        suffix,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm accepts JavaScript entries and only extensionless entries with a Node shebang", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-npm-javascript-entries-");
  const nodeDirectory = join(directory, "node");
  const nodeExecutable = join(nodeDirectory, "node.exe");
  const packageRoot = join(nodeDirectory, "node_modules/npm");

  try {
    await mkdir(nodeDirectory, { recursive: true });
    await writeFile(nodeExecutable, "simulated node executable\n");
    for (const extension of [".js", ".cjs", ".mjs"]) {
      const entry = await writeNpmFixture(packageRoot, {
        declared: `./cli/declared${extension}`,
        contents: "process.exit(0);\n",
      });
      const invocation = resolveNpmInvocation(["pack"], {
        nodeExecutable,
        env: { PATH: "" },
      });
      assert.equal(invocation.args[0], await realpath(entry), extension);
    }

    for (const [declared, contents] of [
      ["./cli/directnode", "#!/usr/bin/node\nprocess.exit(0);\n"],
      ["./cli/envnode", "#!/usr/bin/env node\nprocess.exit(0);\n"],
      ["./cli/envsnode", "#!/usr/bin/env -S node --no-warnings\nprocess.exit(0);\n"],
    ]) {
      const extensionless = await writeNpmFixture(packageRoot, { declared, contents });
      assert.equal(
        resolveNpmInvocation(["pack"], { nodeExecutable, env: { PATH: "" } }).args[0],
        await realpath(extensionless),
        declared,
      );
    }

    for (const [declared, contents] of [
      ["./cli/not-javascript.txt", "#!/usr/bin/env node\nprocess.exit(0);\n"],
      ["./cli/no-node-shebang", "process.exit(0);\n"],
      ["./cli/wrong-shebang", "#!/bin/echo node\nprocess.exit(0);\n"],
    ]) {
      await writeNpmFixture(packageRoot, { declared, contents });
      assert.throws(
        () => resolveNpmInvocation(["pack"], { nodeExecutable, env: { PATH: "" } }),
        /could not resolve npm's manifest-declared JavaScript entry/iu,
        declared,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm rejects a manifest-declared entry whose symlink escapes the package root", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-npm-symlink-escape-");
  const nodeDirectory = join(directory, "node");
  const nodeExecutable = join(nodeDirectory, "node.exe");
  const packageRoot = join(nodeDirectory, "node_modules/npm");
  const outside = join(directory, "outside");

  try {
    await Promise.all([
      mkdir(packageRoot, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(nodeExecutable, "simulated node executable\n"),
      writeFile(join(outside, "escaped.js"), "process.exit(0);\n"),
      writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "npm",
          version: "99.0.0-test",
          bin: { npm: "./escape/escaped.js" },
        })}\n`,
      ),
      symlink(
        outside,
        join(packageRoot, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      ),
    ]);

    assert.throws(
      () => resolveNpmInvocation(["pack"], { nodeExecutable, env: { PATH: "" } }),
      /could not resolve npm's manifest-declared JavaScript entry/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm uses its manifest-declared JavaScript entry in a simulated Windows Node layout", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-npm-windows-invocation-");
  const nodeDirectory = join(directory, "node");
  const nodeExecutable = join(nodeDirectory, "node.exe");
  const packageRoot = join(nodeDirectory, "node_modules/npm");

  try {
    const declaredEntry = await writeNpmFixture(packageRoot);
    await Promise.all([
      writeFile(nodeExecutable, "simulated node executable\n"),
      writeFile(join(nodeDirectory, "npm.cmd"), "@echo decoy shim that must not execute\r\n"),
    ]);
    const invocation = resolveNpmInvocation(["pack", "--json"], {
      nodeExecutable,
      env: { PATH: nodeDirectory },
    });

    assert.equal(invocation.executable, nodeExecutable);
    assert.deepEqual(invocation.args, [await realpath(declaredEntry), "pack", "--json"]);
    assert.doesNotMatch(`${invocation.executable}\n${invocation.args.join("\n")}`, /npm\.cmd/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm discovery supports the ordinary Unix Node distribution layout", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-npm-unix-invocation-");
  const installation = join(directory, "installation");
  const nodeExecutable = join(installation, "bin/node");
  const packageRoot = join(installation, "lib/node_modules/npm");

  try {
    const declaredEntry = await writeNpmFixture(packageRoot);
    await mkdir(join(installation, "bin"), { recursive: true });
    await writeFile(nodeExecutable, "simulated node executable\n");
    const invocation = resolveNpmInvocation(["--version"], {
      nodeExecutable,
      env: { PATH: "" },
    });

    assert.equal(invocation.executable, nodeExecutable);
    assert.deepEqual(invocation.args, [await realpath(declaredEntry), "--version"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm_execpath is accepted only when it is the npm manifest's declared entry", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-npm-execpath-invocation-");
  const nodeExecutable = join(directory, "detached/node");
  const packageRoot = join(directory, "share/node_modules/npm");

  try {
    const declaredEntry = await writeNpmFixture(packageRoot);
    await mkdir(join(directory, "detached"), { recursive: true });
    await Promise.all([
      writeFile(nodeExecutable, "simulated node executable\n"),
      writeFile(join(packageRoot, "cli/not-npm.js"), "#!/usr/bin/env node\n"),
    ]);
    const invocation = resolveNpmInvocation(["pack"], {
      nodeExecutable,
      env: { PATH: "", npm_execpath: relative(directory, declaredEntry) },
      cwd: directory,
    });
    assert.deepEqual(invocation, {
      executable: nodeExecutable,
      args: [await realpath(declaredEntry), "pack"],
    });

    assert.throws(
      () =>
        resolveNpmInvocation(["pack"], {
          nodeExecutable,
          env: { PATH: "", npm_execpath: join(packageRoot, "cli/not-npm.js") },
        }),
      /could not resolve npm's manifest-declared JavaScript entry/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "npm discovery follows a PATH launcher symlink back to the declared entry",
  { skip: process.platform === "win32" ? "file symlinks need elevated Windows privileges" : false },
  async () => {
    const directory = await temporaryDirectory("oxc-tsrx-npm-path-invocation-");
    const nodeExecutable = join(directory, "detached/node");
    const packageRoot = join(directory, "share/node_modules/npm");
    const pathDirectory = join(directory, "path-bin");

    try {
      const declaredEntry = await writeNpmFixture(packageRoot);
      await Promise.all([
        mkdir(join(directory, "detached"), { recursive: true }),
        mkdir(pathDirectory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(nodeExecutable, "simulated node executable\n"),
        symlink(declaredEntry, join(pathDirectory, "npm")),
        writeFile(join(pathDirectory, "npm.cmd"), "@echo decoy shim that must not execute\r\n"),
      ]);
      const invocation = resolveNpmInvocation(["pack"], {
        nodeExecutable,
        env: { PATH: pathDirectory },
      });

      assert.deepEqual(invocation, {
        executable: nodeExecutable,
        args: [await realpath(declaredEntry), "pack"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("repository npm invocation matches npm's public manifest-declared bin", async () => {
  const invocation = resolveNpmInvocation(["--version"]);
  const expected = await publicNpmEntry(invocation.args[0]);

  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.args.length, 2);
  assert.equal(expected.manifest.name, "npm");
  assert.equal(invocation.args[0], expected.entry);
  assert.equal(invocation.args[1], "--version");
  assert.doesNotMatch(invocation.args[0], /[\\/]\.bin[\\/]|\.(?:bat|cmd|com|exe|ps1)$/iu);
});

test("editor and maintainer docs distinguish OXC's compiled seam from runtime hooks", async () => {
  // Prose reflows on every edit, so phrase assertions run against collapsed
  // whitespace: a line break must never be the reason a fact "disappears".
  const flatten = (text) => text.replace(/\s+/gu, " ");
  const [editor, guide] = (
    await Promise.all([
      readFile(editorIntegrationPath, "utf8"),
      readFile(upstreamingGuidePath, "utf8"),
    ])
  ).map(flatten);

  // The page may say this in its own words. What must survive is that the
  // extension picks its documents from a fixed internal list rather than from
  // an API a provider could call.
  assert.match(editor, /hard-codes its document selectors|fixed\s+internal list/i);
  assert.match(editor, /exposes no public API|rather than from a public API/i);
  assert.match(editor, /github\.com\/oxc-project\/oxc\/discussions\/21936/);
  assert.match(guide, /ToolBuilder/);
  assert.match(guide, /compile-time Rust embedding seam/i);
  assert.match(guide, /not a runtime language loader/i);
  assert.match(guide, /github\.com\/oxc-project\/oxc\/discussions\/21936/);
  assert.match(guide, /github\.com\/oxc-project\/oxc\/issues\/19918/);
  assert.match(guide, /github\.com\/oxc-project\/oxc\/pull\/24262/);
});

test("the maintainer guide defines a source-backed upstream transplant contract", async () => {
  const flatten = (text) => text.replace(/\s+/gu, " ");
  const [guideRaw, readme, core, editor, siteConfig] = await Promise.all([
    readFile(upstreamingGuidePath, "utf8"),
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "docs/architecture/rust-oxc-core.md"), "utf8"),
    readFile(editorIntegrationPath, "utf8"),
    readFile(join(root, "docs/site.config.mjs"), "utf8"),
  ]);
  const guide = flatten(guideRaw);

  // The stance is required, its exact phrasing is not: this is the official
  // OXC integration for TSRX, and the TSRX project is the one maintaining it.
  assert.match(guide, /OXC for TSRX is the official OXC integration for TSRX/i);
  assert.match(guide, /official OXC integration[^.]*maintained by the TSRX project/i);
  // The retired non-affiliation disclaimer must not come back with a reflow.
  assert.doesNotMatch(guide, /not affiliated with/i);
  assert.match(guide, new RegExp(pinnedOxcRevision));
  assert.match(guide, new RegExp(auditedOxcMain));
  assert.match(guide, /audited(?: on)? 2026-07-16/i);
  assert.match(guide, /no merged whole-file (?:language |parser )?hook/i);
  // Being the official integration is not a claim that any of this transplant
  // work is upstream business: the page still has to say so in its own words.
  assert.match(guide, /nothing here has been submitted to OXC and nothing is scheduled/i);
  assert.match(guide, /unicode-id-start\s*=\s*[`"]1[`"]|`unicode-id-start = "1"`/);

  for (const path of [
    "scanner/overlay.rs",
    "scanner/lexical.rs",
    "projection/lint.rs",
    "projection/lift/scaffold.rs",
  ]) {
    assert.match(guide, new RegExp(path.replaceAll("/", "\\/")), path);
  }
  assert.doesNotMatch(guide, /projection\/manifest\.rs/);

  for (const classification of [
    "Direct reuse",
    "Adapt or replace",
    "Standalone product glue",
    "Upstream-only redesign",
  ]) {
    assert.match(guide, new RegExp(classification, "i"), classification);
  }

  for (const closedSeam of ["SourceType", "PartialLoader", "FileKind", "Oxfmt LSP routing"]) {
    assert.match(guide, new RegExp(closedSeam), closedSeam);
  }
  for (const primarySource of [
    `${canonicalRepository}/blob/${auditedOxcMain}/crates/oxc_span/src/source_type.rs`,
    `${canonicalRepository}/blob/${auditedOxcMain}/crates/oxc_linter/src/loader/partial_loader/mod.rs`,
    `${canonicalRepository}/blob/${auditedOxcMain}/apps/oxfmt/src/core/support.rs`,
    `${canonicalRepository}/blob/${auditedOxcMain}/apps/oxfmt/src/lsp/mod.rs`,
    `${canonicalRepository}/blob/${auditedOxcMain}/crates/oxc_parser/src/config.rs`,
    `${canonicalRepository}/blob/${pinnedOxcRevision}/crates/oxc_lexer/README.md`,
  ]) {
    assert.ok(guide.includes(primarySource), primarySource);
  }
  for (const researchUrl of [
    `${canonicalRepository}/discussions/21936`,
    `${canonicalRepository}/issues/19918`,
    `${canonicalRepository}/pull/24262`,
  ]) {
    assert.ok(guide.includes(researchUrl), researchUrl);
  }
  assert.match(guide, /unmerged research/i);
  assert.match(guide, /not (?:runtime |release )?dependencies/i);
  assert.match(guide, /one (?:canonical )?OXC parse/i);
  assert.match(guide, /format (?:performs|does) two structural scan(?:ner passe|)s/i);
  // Was pinned to the precise phrasing ("affine authored identity segments and
  // explicitly unmapped synthetic regions"). The page now says the same thing in
  // plain words, so assert the fact: a whole-file copy whose ranges are not all
  // yours, which is why PartialLoader does not fit.
  assert.match(
    guide,
    /affine authored identity segments|some ranges are yours and some are\s+placeholders/i,
  );
  assert.match(
    guide,
    /no (?:new )?(?:source )?cop(?:y|ies),\s+parses,\s+allocations, or dynamic dispatch/i,
  );
  assert.match(guide, /cargo test --locked -p tsrx_syntax --all-targets/);
  assert.match(guide, /pnpm run benchmark:native-lint/);
  assert.match(guide, /pnpm run benchmark:native-format/);
  // The extension is optional because these two may link either at the file in
  // this repository or at the published site, which serves clean URLs. What has
  // to hold is that both still point a reader at the upstream map.
  for (const source of [readme, editor]) {
    assert.match(source, /architecture\/upstreaming-to-oxc(?:\.md|\.html)?/);
  }
  assert.match(siteConfig, /link:\s*['"]\/architecture\/upstreaming-to-oxc['"]/);
  assert.match(core, /(?:\.\/|architecture\/)upstreaming-to-oxc\.md/);
});

// The docs Rust tools sit outside the product workspace, so each keeps its own
// Cargo.lock. Those locks record a resolved version for every path dependency
// they pull out of crates/, which means a workspace version bump leaves them
// stale. build-docs-wasm.ts refuses to let a build rewrite its lock, so a
// stale lock does not produce a wrong artifact, it fails the docs site build
// outright. That is the correct behaviour and a terrible way to find out: it
// costs a four-minute cargo build to learn a version string is one digit off.
// Check it here in milliseconds instead.
test("the out-of-workspace docs locks record the current workspace version", async () => {
  const workspaceManifest = await readFile(join(root, "Cargo.toml"), "utf8");
  const workspaceVersion = workspaceManifest.match(
    /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms,
  )?.[1];
  assert.match(
    workspaceVersion ?? "",
    /^\d+\.\d+\.\d+$/,
    "the workspace must declare one shared crate version",
  );

  const localCrates = new Set(
    (await readdir(join(root, "crates"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );

  const toolLocks = ["docs/tools/demo-wasm", "docs/tools/projection-dump"];
  for (const tool of toolLocks) {
    const lock = await readFile(join(root, tool, "Cargo.lock"), "utf8");
    const pathEntries = lockPackages(lock).filter(
      // A path dependency is the one kind of package a lock records with no
      // source at all; registry and git packages always carry one.
      (entry) => entry.source === undefined && localCrates.has(entry.name),
    );
    assert.ok(
      pathEntries.length > 0,
      `${tool}/Cargo.lock must resolve at least one crate from this repository`,
    );
    for (const entry of pathEntries) {
      assert.equal(
        entry.block.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
        workspaceVersion,
        `${tool}/Cargo.lock pins ${entry.name} at a stale version; relock it after a version bump`,
      );
    }
  }
});

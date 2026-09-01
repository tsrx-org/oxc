import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";
import { startLocalRegistry } from "./local-registry.mjs";

const root = resolve(import.meta.dirname, "../..");
// Read from the package this test packs, so cutting a release cannot leave the
// expected `--version` output behind and paint the whole suite red.
const toolchainVersion = JSON.parse(
  await readFile(resolve(root, "packages/toolchain/package.json"), "utf8"),
).version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packageManagers = [
  {
    name: "npm",
    executable: npm,
    args: (registry) => [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${registry}`,
    ],
  },
  {
    name: "pnpm",
    executable: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: (registry) => [
      "install",
      "--ignore-scripts",
      "--no-frozen-lockfile",
      `--registry=${registry}`,
    ],
  },
  {
    name: "bun",
    executable: process.platform === "win32" ? "bun.exe" : "bun",
    args: (registry) => ["install", "--ignore-scripts", `--registry=${registry}`],
  },
];

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (status, signal) => resolveRun({ status, signal, stdout, stderr }));
  });
}

async function mustRun(executable, args, options = {}) {
  const result = await run(executable, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function pack(packageRoot, artifacts, cache) {
  const result = await mustRun(
    npm,
    [
      "pack",
      "--json",
      "--pack-destination",
      artifacts,
      resolve(root, packageRoot),
    ],
    {
      cwd: root,
      env: { ...process.env, npm_config_cache: cache },
    },
  );
  const packed = parseNpmPackResponse(result.stdout);
  const manifest = JSON.parse(
    await readFile(join(root, packageRoot, "package.json"), "utf8"),
  );
  return {
    manifest,
    tarball: join(artifacts, packed.filename),
    integrity: packed.integrity,
    shasum: packed.shasum,
  };
}

function available(manager) {
  return spawnSync(manager.executable, ["--version"], {
    stdio: "ignore",
  }).status === 0;
}

function cleanEnvironment(temporary, manager, registry) {
  const environment = {
    ...process.env,
    NO_COLOR: "1",
    npm_config_cache: join(temporary, "npm-cache"),
    npm_config_registry: registry,
    XDG_CACHE_HOME: join(temporary, "xdg-cache"),
    XDG_DATA_HOME: join(temporary, "xdg-data"),
    XDG_STATE_HOME: join(temporary, "xdg-state"),
    PNPM_HOME: join(temporary, "pnpm-home"),
    BUN_INSTALL_CACHE_DIR: join(temporary, "bun-cache"),
  };
  delete environment.NODE_PATH;
  for (const key of Object.keys(environment)) {
    if (key.startsWith("OXC_TSRX_") || key.startsWith("OXLINT_TSGOLINT")) {
      delete environment[key];
    }
  }
  environment.OXC_TSRX_TEST_PACKAGE_MANAGER = manager;
  return environment;
}

test(
  "the explicit bridge is idempotent, collision-safe, reversible, and works after npm, pnpm, and Bun isolation",
  { timeout: 240_000 },
  async (context) => {
    const availableManagers = packageManagers.filter(available);
    assert.ok(availableManagers.some((manager) => manager.name === "npm"));

    const temporary = await mkdtemp(join(tmpdir(), "oxc-tsrx-compat-"));
    const artifacts = join(temporary, "artifacts");
    const cache = join(temporary, "pack-cache");
    await mkdir(artifacts, { recursive: true });
    let registry;
    try {
      const packages = await Promise.all(
        ["packages/toolchain"].map((packageRoot) => pack(packageRoot, artifacts, cache)),
      );
      registry = await startLocalRegistry(packages);

      for (const manager of availableManagers) {
        await context.test(manager.name, async () => {
          const consumer = join(temporary, `consumer-${manager.name}`);
          await mkdir(consumer, { recursive: true });
          const manifest = {
            name: `oxc-tsrx-${manager.name}-consumer`,
            private: true,
            type: "module",
            devDependencies: { "@tsrx/oxc": "0.9.0" },
          };
          await writeFile(
            join(consumer, "package.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          const environment = cleanEnvironment(temporary, manager.name, registry.url);
          await mustRun(manager.executable, manager.args(registry.url), {
            cwd: consumer,
            env: environment,
          });

          assert.deepEqual(
            Object.keys(
              JSON.parse(await readFile(join(consumer, "package.json"), "utf8"))
                .devDependencies,
            ),
            ["@tsrx/oxc"],
          );
          const cli = join(consumer, "node_modules/@tsrx/oxc/bin/oxc-tsrx");

          // The four ways a reader asks this command what it is, before any of
          // them can change the project. `--help` and `--version` are the first
          // two flags anyone tries and they are not subcommands, so this pins
          // that they are answered rather than reported as unknown commands.
          // The reference page states this contract, and it stated the opposite
          // of it for as long as nothing here held it still.
          for (const argument of ["--help", "-h", "help"]) {
            const help = await mustRun(process.execPath, [cli, argument], {
              cwd: consumer,
              env: environment,
            });
            assert.match(help.stdout, /^oxc-tsrx\n\nUsage:\n/u, argument);
            assert.match(help.stdout, /oxc-tsrx setup \[--project <directory>\]/u, argument);
          }
          for (const argument of ["--version", "-V", "version"]) {
            const version = await mustRun(process.execPath, [cli, argument], {
              cwd: consumer,
              env: environment,
            });
            assert.equal(version.stdout, `oxc-tsrx ${toolchainVersion}\n`, argument);
          }
          const unknown = await run(process.execPath, [cli, "frobnicate"], {
            cwd: consumer,
            env: environment,
          });
          assert.equal(unknown.status, 2);
          assert.match(unknown.stderr, /unknown command: frobnicate/u);
          assert.match(unknown.stderr, /Usage:/u);

          const first = await mustRun(
            process.execPath,
            [cli, "setup", "--json"],
            { cwd: consumer, env: environment },
          );
          const firstReport = JSON.parse(first.stdout);
          assert.equal(firstReport.packageManager, manager.name);
          assert.deepEqual(firstReport.changed, ["oxc-parser", "oxlint", "oxfmt"]);
          assert.ok(firstReport.slots.every((slot) => slot.state === "active"));

          // The fourth slot, on the install this package manager actually
          // wrote. Nothing but `@tsrx/oxc` is installed here, so `.bin/oxlint`
          // is already this package's and the editor setting would be noise.
          // This is the assertion that says the detection reads a real shim
          // rather than a fixture, per package manager.
          assert.equal(firstReport.editorSlot.state, "unnecessary");
          assert.equal(firstReport.editorSlot.linterShim.owner, "@tsrx/oxc");
          assert.ok(
            ["symlink", "shim-text"].includes(firstReport.editorSlot.linterShim.resolvedBy),
            `${manager.name}: ${firstReport.editorSlot.linterShim.resolvedBy}`,
          );
          assert.equal(
            (await readdir(consumer)).includes(".vscode"),
            false,
            "no settings file may be written when the ordinary lookup already works",
          );

          const second = await mustRun(
            process.execPath,
            [cli, "setup", "--json"],
            { cwd: consumer, env: environment },
          );
          assert.deepEqual(JSON.parse(second.stdout).changed, []);

          const probe = join(consumer, "probe.mjs");
          await writeFile(
            probe,
            [
              'import { parseSync } from "oxc-parser";',
              'import { defineConfig } from "oxlint";',
              'import { format } from "oxfmt";',
              "process.stdout.write(JSON.stringify({",
              '  parser: typeof parseSync, lint: typeof defineConfig, format: typeof format,',
              "}));",
              "",
            ].join("\n"),
          );
          const probed = await mustRun(process.execPath, [probe], {
            cwd: consumer,
            env: environment,
          });
          assert.deepEqual(JSON.parse(probed.stdout), {
            parser: "function",
            lint: "function",
            format: "function",
          });

          for (const [name, capability] of [
            ["oxc-parser", "parser"],
            ["oxlint", "lint"],
            ["oxfmt", "format"],
          ]) {
            const facade = JSON.parse(
              await readFile(join(consumer, "node_modules", name, "package.json"), "utf8"),
            );
            assert.equal(facade.name, name);
            assert.deepEqual(facade.oxcTsrxCompatibility, {
              schemaVersion: 1,
              provider: "oxc-tsrx",
              providerVersion: "0.9.0",
              capability,
            });
          }

          const removed = await mustRun(
            process.execPath,
            [cli, "remove", "--json"],
            { cwd: consumer, env: environment },
          );
          assert.deepEqual(JSON.parse(removed.stdout).removed, [
            "oxc-parser",
            "oxlint",
            "oxfmt",
          ]);

          const lintSlot = join(consumer, "node_modules/oxlint");
          await mkdir(join(lintSlot, "dist"), { recursive: true });
          await writeFile(
            join(lintSlot, "package.json"),
            `${JSON.stringify({
              name: "oxlint",
              version: "1.2.3",
              type: "module",
              main: "./dist/index.js",
            })}\n`,
          );
          await writeFile(join(lintSlot, "dist/index.js"), "export const official = true;\n");
          const replaced = await mustRun(
            process.execPath,
            [cli, "setup", "--json"],
            { cwd: consumer, env: environment },
          );
          const replacedReport = JSON.parse(replaced.stdout);
          assert.deepEqual(
            replacedReport.slots.find((slot) => slot.name === "oxlint").replacedPackage,
            { name: "oxlint", version: "1.2.3" },
          );
          await mustRun(
            process.execPath,
            [cli, "remove", "--json"],
            { cwd: consumer, env: environment },
          );
          assert.deepEqual(JSON.parse(await readFile(join(lintSlot, "package.json"), "utf8")), {
            name: "oxlint",
            version: "1.2.3",
            type: "module",
            main: "./dist/index.js",
          });

          await writeFile(
            join(lintSlot, "package.json"),
            `${JSON.stringify({ name: "custom-oxlint", version: "999.0.0" })}\n`,
          );
          const collision = await run(
            process.execPath,
            [cli, "setup", "--json"],
            { cwd: consumer, env: environment },
          );
          assert.equal(collision.status, 2);
          assert.match(collision.stderr, /refusing to replace unowned package slot.*oxlint/);
          assert.deepEqual(
            JSON.parse(
              await readFile(join(lintSlot, "package.json"), "utf8"),
            ),
            { name: "custom-oxlint", version: "999.0.0" },
          );

          // --- the editor slot, with the lookup taken away ------------------
          // A Vite+ project is this shape: `node_modules/.bin/oxlint` belongs to
          // another tool, so the official OXC extension finds that tool and
          // serves no `.tsrx` diagnostics, with nothing anywhere saying why.
          // Every `oxlint*` entry the package manager wrote is replaced, which
          // covers the POSIX symlink and the Windows `.cmd`/`.ps1` text shims in
          // one step.
          await rm(lintSlot, { recursive: true, force: true });
          const binDirectory = join(consumer, "node_modules/.bin");
          for (const entry of await readdir(binDirectory)) {
            if (!/^oxlint(\.cmd|\.ps1)?$/u.test(entry)) continue;
            await rm(join(binDirectory, entry), { force: true });
            await writeFile(
              join(binDirectory, entry),
              "#!/usr/bin/env node\nconsole.error('another tool owns this name');\n",
            );
          }

          const settings = join(consumer, ".vscode/settings.json");
          const editorSetup = JSON.parse(
            (await mustRun(process.execPath, [cli, "setup", "--json"], {
              cwd: consumer,
              env: environment,
            })).stdout,
          );
          assert.equal(editorSetup.editorSlot.linterShim.owner, "other");
          assert.equal(editorSetup.editorSlot.state, "active");
          assert.ok(editorSetup.changed.includes("oxc.path.oxlint"));
          assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), {
            "oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/oxlint",
          });

          const settled = await readFile(settings, "utf8");
          const editorAgain = JSON.parse(
            (await mustRun(process.execPath, [cli, "setup", "--json"], {
              cwd: consumer,
              env: environment,
            })).stdout,
          );
          assert.deepEqual(editorAgain.changed, []);
          assert.equal(await readFile(settings, "utf8"), settled);

          // The user's own file, with the key this package wrote in the middle
          // of it. `remove` gives back exactly that key.
          const authored = [
            "{",
            "  // team-wide",
            '  "editor.tabSize": 2,',
            '  "oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/oxlint",',
            '  "files.eol": "\\n",',
            "}",
            "",
          ].join("\n");
          await writeFile(settings, authored);
          const editorRemoved = JSON.parse(
            (await mustRun(process.execPath, [cli, "remove", "--json"], {
              cwd: consumer,
              env: environment,
            })).stdout,
          );
          assert.ok(editorRemoved.removed.includes("oxc.path.oxlint"));
          assert.equal(
            await readFile(settings, "utf8"),
            [
              "{",
              "  // team-wide",
              '  "editor.tabSize": 2,',
              '  "files.eol": "\\n",',
              "}",
              "",
            ].join("\n"),
          );
        });
      }
    } finally {
      await registry?.close();
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

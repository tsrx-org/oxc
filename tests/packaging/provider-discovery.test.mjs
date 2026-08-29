import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { NATIVE_TARGETS } from "../../packages/toolchain/dist/native-targets.js";
import {
  resolveCommandInvocation,
  spawnCommand,
} from "../../packages/toolchain/dist/spawn-command.js";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";
import { startLocalRegistry } from "./local-registry.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";
import { requireCts } from "../helpers/require-cts.mjs";

const root = resolve(import.meta.dirname, "../..");
const toolchainRoot = join(root, "packages/toolchain");
const cli = join(toolchainRoot, "bin/oxc-tsrx");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const commands = [];

/**
 * The command name to record, independent of how this host spells the launcher:
 * the package manager on PATH is `npm` on POSIX and `npm.cmd` on Windows, and
 * the "nothing but an install ran here" assertion is about the command, not the
 * spelling.
 */
function commandName(executable) {
  const name = basename(executable);
  return name.slice(0, name.length - extname(name).length) || name;
}

/**
 * `path.relative` compares case-insensitively on Windows and speaks the host's
 * own separator, so containment needs no platform branch.
 */
function isInside(directory, path) {
  const offset = relative(directory, path);
  return offset.length > 0 && !offset.startsWith("..") && !isAbsolute(offset);
}

function run(executable, args, options = {}) {
  commands.push({ executable: commandName(executable), args, cwd: options.cwd });
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnCommand(executable, args, {
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

/**
 * `STATUS_STACK_BUFFER_OVERRUN`, the Windows fast-fail exit. GitHub's hosted
 * Windows runners intermittently kill a pnpm install with it mid-download —
 * observed twice on identical trees that passed on rerun, always this exact
 * code, never an assertion. It is a runner-environment crash, so that one code
 * on that one platform earns a bounded retry; every other non-zero exit stays
 * an immediate failure.
 */
const WINDOWS_FAST_FAIL = 3221226505;

async function mustRun(executable, args, options = {}) {
  let result = await run(executable, args, options);
  for (
    let retries = 0;
    process.platform === "win32" && result.status === WINDOWS_FAST_FAIL && retries < 2;
    retries += 1
  ) {
    result = await run(executable, args, options);
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function available(executable) {
  const invocation = resolveCommandInvocation(executable, ["--version"]);
  return (
    spawnSync(invocation.file, invocation.args, {
      stdio: "ignore",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }).status === 0
  );
}

async function writePackage(directory, manifest, files = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  return directory;
}

async function pack(packageRoot, artifacts, cache) {
  const result = await mustRun(
    npm,
    ["pack", "--json", "--pack-destination", artifacts, packageRoot],
    { cwd: root, env: { ...process.env, npm_config_cache: cache } },
  );
  const packed = parseNpmPackResponse(result.stdout);
  return {
    manifest: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
    tarball: join(artifacts, packed.filename),
    integrity: packed.integrity,
    shasum: packed.shasum,
  };
}

function cleanEnvironment(temporary, registry) {
  const environment = {
    ...process.env,
    NO_COLOR: "1",
    npm_config_cache: join(temporary, "npm-cache"),
    npm_config_registry: registry,
    XDG_CACHE_HOME: join(temporary, "xdg-cache"),
    XDG_DATA_HOME: join(temporary, "xdg-data"),
    XDG_STATE_HOME: join(temporary, "xdg-state"),
    PNPM_HOME: join(temporary, "pnpm-home"),
  };
  delete environment.NODE_PATH;
  for (const key of Object.keys(environment)) {
    if (key.startsWith("OXC_TSRX_") || key.startsWith("OXLINT_TSGOLINT")) {
      delete environment[key];
    }
  }
  return environment;
}

/** Discovery always runs through the copy of the resolver the consumer installed. */
async function discoverFrom(consumer) {
  const module = await import(
    pathToFileURL(join(consumer, "node_modules/@tsrx/oxc/dist/provider-resolve.js")).href
  );
  return module.discoverProviders({ root: await realpath(consumer) });
}

// The editor host's decision module, exercised against the very same installed
// consumer: package presence alone must be enough to produce editor clients.
const providerClient = await requireCts(
  join(root, "packages/vscode/src/provider-client.cts"),
);

const ORDINARY_DOCUMENTS = ["src/app.ts", "src/app.tsx", "src/app.js", "tsconfig.json"];

async function editorStateFor(consumer) {
  const module = await import(
    pathToFileURL(join(consumer, "node_modules/@tsrx/oxc/dist/provider-resolve.js")).href
  );
  return providerClient.discoverWorkspaceFolder(await realpath(consumer), {
    discover: module.discoverProviders,
  });
}

/**
 * A clean consumer that only declared the dependency yields exactly one editor
 * language client, pointed at a file inside the installed package, and no client
 * at all for ordinary source documents.
 */
async function assertEditorClients(consumer) {
  const appRoot = await realpath(consumer);
  const state = await editorStateFor(consumer);
  assert.deepEqual(state.extensions, [".tsrx"]);
  assert.deepEqual(state.selector, [{ scheme: "file", pattern: "**/*.tsrx" }]);
  assert.equal(state.failure, null);
  assert.equal(state.clients.length, 1);

  const [client] = state.clients;
  const executable = join(appRoot, "node_modules/@tsrx/oxc/bin/oxc-tsrx-lsp");
  assert.equal(client.id, "tsrx");
  assert.equal(client.package, "@tsrx/oxc");
  assert.deepEqual(client.extensions, [".tsrx"]);
  assert.equal(client.executable, executable);
  assert.equal(client.command, process.execPath);
  assert.deepEqual(client.args, [executable, "--stdio"]);
  assert.equal(await exists(executable), true);
  for (const value of [client.command, ...client.args]) {
    assert.equal(value.split(/[/\\]/u).includes(".bin"), false, value);
  }

  assert.equal(
    providerClient.clientForDocument(state, join(appRoot, "src/View.tsrx")),
    client,
  );
  const ordinary = ORDINARY_DOCUMENTS.map((path) => ({
    folder: appRoot,
    path: join(appRoot, path),
  }));
  for (const document of ordinary) {
    assert.equal(
      providerClient.clientForDocument(state, document.path),
      null,
      document.path,
    );
  }
  assert.deepEqual(
    providerClient.plannedClientStarts([state], ordinary),
    [],
    "a session of ordinary documents starts no provider client",
  );
  assert.deepEqual(
    providerClient
      .plannedClientStarts([state], [
        ...ordinary,
        { folder: appRoot, path: join(appRoot, "src/View.tsrx") },
      ])
      .map(({ client: started }) => started.id),
    ["tsrx"],
  );
  return { selector: state.selector, clients: state.clients };
}

async function snapshot(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const files = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    if (relative(directory, path).startsWith("node_modules")) continue;
    files[relative(directory, path)] = await readFile(path, "utf8");
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const providerStub = (name, id, extension, extra = {}) => ({
  name,
  version: "1.0.0",
  type: "module",
  main: "./index.js",
  exports: { ".": "./index.js", "./package.json": "./package.json" },
  oxc: {
    provider: {
      protocol: 1,
      id,
      languages: [
        {
          id,
          extensions: [extension],
          capabilities: { parse: { module: "." } },
        },
      ],
    },
  },
  ...extra,
});

test(
  "a plain install is the only step a consumer takes to register a language provider",
  { timeout: 420_000 },
  async (context) => {
    const temporary = await temporaryDirectory("oxc-tsrx-provider-");
    const artifacts = join(temporary, "artifacts");
    const sources = join(temporary, "sources");
    const cache = join(temporary, "pack-cache");
    await mkdir(artifacts, { recursive: true });
    let registry;
    context.after(async () => {
      await registry?.close();
      await rm(temporary, { recursive: true, force: true });
    });

    // The published toolchain tarball, plus dependency stubs so the fixture
    // needs no network and executes no native artifact.
    //
    // The eight `@tsrx/oxc-*` optional dependencies are stubbed for the
    // same reason the third-party packages are, and the reason is easy to miss:
    // without them `npm` falls through to the public registry, which only ever
    // has *already published* versions. That worked by accident while the
    // candidate version happened to be published, and turned into eight
    // unresolved optional entries in `package-lock.json` the moment the version
    // was bumped, which `npm ci` then refuses. Each stub carries the real
    // `os`/`cpu`/`libc`, so npm's platform selection behaves exactly as it does
    // against the registry.
    const toolchainVersion = JSON.parse(
      await readFile(join(toolchainRoot, "package.json"), "utf8"),
    ).version;
    const stubSources = await Promise.all([
      ...NATIVE_TARGETS.map((target) =>
        writePackage(
          join(sources, `native-${target.packageSuffix}`),
          {
            name: `@tsrx/oxc-${target.packageSuffix}`,
            version: toolchainVersion,
            os: [target.os],
            cpu: [target.cpu],
            ...(target.libc === undefined ? {} : { libc: [target.libc] }),
          },
          { "placeholder.txt": "no native artifact is executed by this fixture\n" },
        ),
      ),
      ...[
        ["oxlint-current", "oxlint", "1.74.0"],
        ["oxfmt-current", "oxfmt", "0.59.0"],
        ["types", "@oxc-project/types", "0.140.0"],
        ["tsgolint", "oxlint-tsgolint", "0.24.0"],
        ["pathe", "pathe", "2.0.3"],
        ["tinyglobby", "tinyglobby", "0.2.17"],
      ].map(([directory, name, version]) =>
        writePackage(
          join(sources, directory),
          {
            name,
            version,
            type: "module",
            exports: {
              ".": "./index.js",
              "./plugins-dev": "./index.js",
              "./package.json": "./package.json",
            },
          },
          { "index.js": "export const stub = true;\n" },
        ),
      ),
      // A second, entirely unrelated provider. Its entry point writes a marker
      // and throws, so any import during discovery would be unmissable.
      writePackage(
        join(sources, "demo"),
        {
          ...providerStub("demo-language-provider", "demo", ".demo"),
          dependencies: { "hidden-language-provider": "1.0.0" },
        },
        {
          "index.js": [
            'import { writeFileSync } from "node:fs";',
            'writeFileSync(new URL("./executed.marker", import.meta.url), "ran");',
            'throw new Error("provider code must not run during discovery");',
            "",
          ].join("\n"),
        },
      ),
      // Only reachable as a dependency of the demo provider.
      writePackage(join(sources, "hidden"), providerStub("hidden-language-provider", "hidden", ".hidden"), {
        "index.js": "export const stub = true;\n",
      }),
    ]);
    const packages = await Promise.all(
      [toolchainRoot, ...stubSources].map((packageRoot) => pack(packageRoot, artifacts, cache)),
    );
    registry = await startLocalRegistry(packages);
    const environment = cleanEnvironment(temporary, registry.url);
    const installedConsumers = [];

    const consumer = async (name, dependencies) => {
      const directory = join(temporary, name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify(
          { name, private: true, type: "module", dependencies },
          null,
          2,
        )}\n`,
      );
      installedConsumers.push(directory);
      return directory;
    };

    await context.test("npm: one declared dependency and no activation step", async () => {
      const app = await consumer("npm-consumer", { "@tsrx/oxc": "0.8.0" });
      await mustRun(
        npm,
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry.url}`],
        { cwd: app, env: environment },
      );
      const installed = await snapshot(app);
      assert.deepEqual(Object.keys(installed).sort(), ["package-lock.json", "package.json"]);

      const index = await discoverFrom(app);
      const appRoot = await realpath(app);
      assert.deepEqual(Object.keys(index.extensions), [".tsrx"]);
      assert.deepEqual(
        index.providers.map(({ name, id, protocol }) => ({ name, id, protocol })),
        [{ name: "@tsrx/oxc", id: "tsrx", protocol: 1 }],
      );
      assert.deepEqual(
        index.diagnostics.filter((entry) => entry.severity === "error"),
        [],
      );

      const capabilities = index.extensions[".tsrx"].capabilities;
      assert.deepEqual(Object.keys(capabilities).sort(), ["format", "lint", "lsp", "parse"]);
      for (const [capability, expected] of [
        ["lint", join("node_modules/@tsrx/oxc/bin/oxc-tsrx-lint")],
        ["format", join("node_modules/@tsrx/oxc/bin/oxc-tsrx-fmt")],
        ["lsp", join("node_modules/@tsrx/oxc/bin/oxc-tsrx-lsp")],
        ["parse", join("node_modules/@tsrx/oxc/dist/parser.js")],
      ]) {
        const target = capabilities[capability];
        assert.equal(relative(appRoot, target.path), expected, capability);
        assert.equal(await exists(target.path), true);
      }
      assert.equal(capabilities.parse.specifier, "@tsrx/oxc/parser");
      assert.equal(
        Object.values(capabilities).some(({ path }) =>
          path.split(/[/\\]/u).includes(".bin"),
        ),
        false,
        "no capability may resolve through node_modules/.bin",
      );

      // Nothing in the installed provider tree is loaded to build the index.
      const manifest = JSON.parse(
        await readFile(join(app, "node_modules/@tsrx/oxc/package.json"), "utf8"),
      );
      assert.equal(manifest.oxc.provider.protocol, 1);
      assert.equal(manifest.scripts, undefined);

      // A capability target must be a leaf executor. If it were one of the bin
      // names a host resolves by canonical tool name, a discovering lint or
      // format host would execute another host and re-enter discovery.
      const [installedLanguage] = manifest.oxc.provider.languages;
      for (const [capability, target] of Object.entries(installedLanguage.capabilities)) {
        if (typeof target.bin !== "string") continue;
        assert.equal(
          ["oxlint", "oxfmt", "oxc-tsrx"].includes(target.bin),
          false,
          `${capability} must not target a general host entry point`,
        );
      }

      // The editor host needs nothing but this install: no setup command, no
      // bin shim, no PATH entry, no lifecycle script.
      const editor = await assertEditorClients(app);

      // Discovery must not depend on the bin shims the installer created.
      await rm(join(app, "node_modules/.bin"), { recursive: true, force: true });
      assert.deepEqual(await discoverFrom(app), index);
      assert.deepEqual(await assertEditorClients(app), editor);

      // Frozen reinstall from the lockfile alone.
      await rm(join(app, "node_modules"), { recursive: true, force: true });
      await mustRun(
        npm,
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry.url}`],
        { cwd: app, env: environment },
      );
      assert.equal(
        await exists(join(app, "node_modules/@tsrx/oxc/dist/provider-resolve.js")),
        true,
        "the frozen reinstall must restore the provider metadata and resolver",
      );
      assert.deepEqual(await discoverFrom(app), index);
      assert.deepEqual(
        await assertEditorClients(app),
        editor,
        "the editor clients survive a frozen reinstall byte for byte",
      );
      assert.deepEqual(await snapshot(app), installed);
    });

    await context.test("pnpm: isolated node_modules resolve the same index", async (subtest) => {
      if (!available(pnpm)) {
        subtest.skip("pnpm is not installed");
        return;
      }
      const app = await consumer("pnpm-consumer", { "@tsrx/oxc": "0.8.0" });
      await mustRun(
        pnpm,
        ["install", "--ignore-scripts", `--registry=${registry.url}`],
        { cwd: app, env: environment },
      );
      const installed = await snapshot(app);
      assert.deepEqual(Object.keys(installed).sort(), ["package.json", "pnpm-lock.yaml"]);

      const index = await discoverFrom(app);
      const appRoot = await realpath(app);
      assert.deepEqual(Object.keys(index.extensions), [".tsrx"]);
      assert.equal(index.extensions[".tsrx"].package, "@tsrx/oxc");
      assert.equal(
        isInside(appRoot, index.extensions[".tsrx"].providerRoot),
        true,
        "the provider must resolve inside the consumer, through pnpm's store links",
      );
      assert.equal(
        index.extensions[".tsrx"].providerRoot.split(/[/\\]/u).includes(".pnpm"),
        true,
        "pnpm keeps the provider in its isolated store, reachable only as a direct link",
      );

      await rm(join(app, "node_modules"), { recursive: true, force: true });
      await mustRun(
        pnpm,
        ["install", "--frozen-lockfile", "--ignore-scripts", `--registry=${registry.url}`],
        { cwd: app, env: environment },
      );
      assert.deepEqual(await discoverFrom(app), index);
      assert.deepEqual(await snapshot(app), installed);
    });

    await context.test(
      "an unrelated second provider is discovered and its code never runs",
      async () => {
        const app = await consumer("mixed-consumer", {
          "demo-language-provider": "1.0.0",
          "@tsrx/oxc": "0.8.0",
        });
        await mustRun(
          npm,
          ["install", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry.url}`],
          { cwd: app, env: environment },
        );

        const index = await discoverFrom(app);
        assert.deepEqual(Object.keys(index.extensions).sort(), [".demo", ".tsrx"]);
        assert.deepEqual(
          index.providers.map(({ name }) => name).sort(),
          ["@tsrx/oxc", "demo-language-provider"],
        );
        assert.equal(index.extensions[".demo"].package, "demo-language-provider");
        assert.deepEqual(
          index.diagnostics.filter((entry) => entry.severity === "error"),
          [],
        );

        // The editor selector is built from the index, so a second provider
        // widens it; only the provider that declares a language server gets a
        // client, and the two never share one.
        const editor = await editorStateFor(app);
        assert.deepEqual(editor.extensions, [".demo", ".tsrx"]);
        assert.deepEqual(editor.selector, [
          { scheme: "file", pattern: "**/*.demo" },
          { scheme: "file", pattern: "**/*.tsrx" },
        ]);
        assert.deepEqual(
          editor.clients.map(({ id }) => id),
          ["tsrx"],
          "a provider that declares no language server contributes no client",
        );
        assert.equal(
          providerClient.clientForDocument(editor, join(app, "a.demo")),
          null,
        );

        // The transitive provider is installed but is never a candidate.
        const hidden = join(app, "node_modules/hidden-language-provider/package.json");
        assert.equal(await exists(hidden), true);
        assert.equal(JSON.parse(await readFile(hidden, "utf8")).oxc.provider.id, "hidden");
        assert.equal(index.extensions[".hidden"], undefined);
        assert.equal(
          index.providers.some(({ name }) => name === "hidden-language-provider"),
          false,
        );

        // Controlled proof that the entry point really is destructive to load.
        const marker = join(app, "node_modules/demo-language-provider/executed.marker");
        assert.equal(await exists(marker), false, "discovery must not load provider code");
        const consumerRequire = createRequire(join(await realpath(app), "package.json"));
        await assert.rejects(
          () => import(pathToFileURL(consumerRequire.resolve("demo-language-provider")).href),
          /provider code must not run during discovery/u,
        );
        assert.equal(await exists(marker), true);
      },
    );

    assert.deepEqual(
      commands
        .filter(({ cwd }) => installedConsumers.includes(cwd))
        .map(({ executable, args }) => `${executable} ${args[0]}`),
      [
        "npm install",
        "npm ci",
        ...(available(pnpm) ? ["pnpm install", "pnpm install"] : []),
        "npm install",
      ],
      "a consumer runs nothing but its package manager install",
    );
  },
);

test("the providers report is a read-only audit that fails loudly", async (context) => {
  const temporary = await temporaryDirectory("oxc-tsrx-provider-report-");
  context.after(() => rm(temporary, { recursive: true, force: true }));

  const fixture = async (name, dependencies, packages) => {
    const directory = join(temporary, name);
    await writePackage(directory, { name, private: true, type: "module", dependencies });
    await mkdir(join(directory, "node_modules/@tsrx"), { recursive: true });
    // A junction is the Windows form that needs no elevated privilege; a plain
    // directory symlink there requires Developer Mode or an admin token, which
    // would make this fixture fail for a reason that is not about discovery.
    await symlink(
      toolchainRoot,
      join(directory, "node_modules/@tsrx/oxc"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const [packageName, manifest] of Object.entries(packages)) {
      await writePackage(join(directory, "node_modules", packageName), manifest, {
        "index.js": "export const stub = true;\n",
      });
    }
    return directory;
  };

  await context.test("a clean project reports every declared capability", async () => {
    const project = await fixture("solo", { "@tsrx/oxc": "0.8.0" }, {});
    const before = await snapshot(project);
    const result = await run(process.execPath, [cli, "providers", "--json", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(Object.keys(report.extensions), [".tsrx"]);
    assert.deepEqual(
      report.providers.map(({ name, id }) => ({ name, id })),
      [{ name: "@tsrx/oxc", id: "tsrx" }],
    );
    assert.deepEqual(await snapshot(project), before, "the report must write nothing");

    const text = await run(process.execPath, [cli, "providers", "--project", project]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /@tsrx\/oxc@0\.8\.0 \(provider tsrx, protocol 1\)/u);
    assert.match(text.stdout, /language tsrx: \.tsrx/u);
    assert.match(text.stdout, /routed extensions: \.tsrx -> @tsrx\/oxc/u);
  });

  await context.test("two providers claiming one extension fail loudly", async () => {
    const project = await fixture(
      "conflict",
      { "@tsrx/oxc": "0.8.0", "rival-language-provider": "1.0.0" },
      { "rival-language-provider": providerStub("rival-language-provider", "rival", ".tsrx") },
    );
    const result = await run(process.execPath, [cli, "providers", "--json", "--project", project]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    const [failure] = report.diagnostics.filter((entry) => entry.severity === "error");
    assert.equal(failure.code, "extension-conflict");
    assert.deepEqual(failure.packages, ["@tsrx/oxc", "rival-language-provider"]);
    assert.equal(failure.extension, ".tsrx");
    assert.equal(report.extensions[".tsrx"], undefined, "a conflict never picks a winner");

    const text = await run(process.execPath, [cli, "providers", "--project", project]);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /error: packages @tsrx\/oxc and rival-language-provider/u);
  });

  await context.test("claiming a core extension fails loudly", async () => {
    const project = await fixture(
      "reserved",
      { "greedy-language-provider": "1.0.0" },
      { "greedy-language-provider": providerStub("greedy-language-provider", "greedy", ".ts") },
    );
    const result = await run(process.execPath, [cli, "providers", "--json", "--project", project]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    const [failure] = report.diagnostics.filter((entry) => entry.severity === "error");
    assert.equal(failure.code, "reserved-extension");
    assert.deepEqual(failure.packages, ["greedy-language-provider"]);
    assert.equal(failure.extension, ".ts");
    assert.deepEqual(report.extensions, {});
  });
});

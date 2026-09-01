import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { temporaryDirectory } from "./temporary-directory.mjs";

const root = resolve(import.meta.dirname, "../..");
const packageRoot = join(root, "packages", "toolchain");

async function writePackage(directory, manifest, files) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const path = join(directory, relativePath);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, source);
    }),
  );
}

function runNode(file, args = [], options = {}) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
}

test("the public export map is backed by this package's own implementation", async () => {
  const [{ toolchain }, parser, lint, plugins, format, compat] = await Promise.all([
    import(pathToFileURL(join(packageRoot, "dist/index.js"))),
    import(pathToFileURL(join(packageRoot, "dist/parser.js"))),
    import(pathToFileURL(join(packageRoot, "dist/lint.js"))),
    import(pathToFileURL(join(packageRoot, "dist/lint-plugins-dev.js"))),
    import(pathToFileURL(join(packageRoot, "dist/format.js"))),
    import(pathToFileURL(join(packageRoot, "dist/compat.js"))),
  ]);

  assert.deepEqual(toolchain, {
    name: "@tsrx/oxc",
    language: "tsrx",
    extensions: [".tsrx"],
    capabilities: ["parser", "lint", "format", "languageServer"],
  });
  assert.equal(Object.isFrozen(toolchain), true);
  assert.equal(typeof parser.parseSync, "function");
  assert.equal(typeof parser.parse, "function");
  assert.equal(typeof parser.ParserOperationalError, "function");
  assert.equal(typeof lint.defineConfig, "function");
  assert.equal(typeof plugins.RuleTester, "function");
  assert.equal(typeof format.format, "function");
  assert.equal(typeof format.jsTextToDoc, "function");
  assert.equal(typeof format.defineConfig, "function");
  assert.equal(typeof compat.setupCompatibility, "function");
  assert.equal(typeof compat.removeCompatibility, "function");

  // The export map used to hand every capability to a separate first-party
  // package. Nothing here may re-acquire one: a user should never have to know
  // any name but `@tsrx/oxc`.
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const wrappers = ["@oxc-tsrx/parser", "@oxc-tsrx/runtime", "oxlint-tsrx", "oxfmt-tsrx"];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const wrapper of wrappers) {
      assert.equal(manifest[field]?.[wrapper], undefined, `${field}.${wrapper}`);
    }
  }
  const shipped = await readdir(join(packageRoot, "dist"));
  for (const file of shipped) {
    if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
    const source = await readFile(join(packageRoot, "dist", file), "utf8");
    for (const wrapper of wrappers) {
      assert.doesNotMatch(
        source,
        new RegExp(`from\\s+["']${wrapper.replace("/", "\\/")}(?:/|["'])`, "u"),
        `dist/${file} must not import ${wrapper}`,
      );
    }
  }
});

/**
 * Bin keys that are entry points a host resolves by canonical tool name, or the
 * package's own general CLI. A capability target that is one of these turns a
 * discovering host into a caller of another host: an adopting linter would
 * execute a linter, discover the same provider, and recurse without bound.
 */
const GENERAL_HOST_BINS = ["oxlint", "oxfmt", "oxc-tsrx"];

/**
 * Markers that only a general host can legitimately carry. The contrast
 * assertion below requires each of them to appear in the general host bins, so
 * the leaf assertion cannot pass by matching nothing anywhere.
 */
const HOST_MARKERS = [
  { label: "provider discovery", pattern: /provider-resolve|discoverProviders|providers-report/u },
  { label: "language-server multiplexing", pattern: /multiplexer|--lsp/u },
  { label: "delegation to another host wrapper", pattern: /importDeclaredPackageBinary/u },
];

/** Everything a leaf capability executor must not do. */
const LEAF_FORBIDDEN = [
  ...HOST_MARKERS,
  { label: "file-extension dispatch", pattern: /extname|\.tsrx|endsWith\(|extensionOf/u },
  { label: "argument partitioning", pattern: /\bfilter\(|\bpartition\b|startsWith\(/u },
];

test("no capability target is a general host entry point", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const [language] = manifest.oxc.provider.languages;
  const binTargets = Object.entries(language.capabilities).filter(
    ([, target]) => typeof target.bin === "string",
  );
  assert.deepEqual(
    binTargets.map(([capability]) => capability).sort(),
    ["format", "lint", "lsp"],
    "every executable capability must be covered by this assertion",
  );

  const generalHostPaths = new Set(GENERAL_HOST_BINS.map((name) => manifest.bin[name]));
  for (const [capability, target] of binTargets) {
    assert.equal(
      GENERAL_HOST_BINS.includes(target.bin),
      false,
      `the ${capability} capability must not point at the ${target.bin} host entry point`,
    );
    assert.equal(
      generalHostPaths.has(manifest.bin[target.bin]),
      false,
      `the ${capability} capability must not resolve to a general host file`,
    );
    assert.equal(typeof manifest.bin[target.bin], "string", target.bin);
  }
});

test("every capability executor is a leaf: no discovery, no extension dispatch", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const [language] = manifest.oxc.provider.languages;

  for (const [capability, target] of Object.entries(language.capabilities)) {
    if (typeof target.bin !== "string") continue;
    const source = await readFile(join(packageRoot, "dist", "bin", `${target.bin}.js`), "utf8");
    assert.ok(source.length > 0, target.bin);
    for (const { label, pattern } of LEAF_FORBIDDEN) {
      assert.doesNotMatch(
        source,
        pattern,
        `the ${capability} capability executor must not perform ${label}`,
      );
    }
    // One resolution, one process, one hand-off of the argv it was given.
    assert.equal(source.match(/resolveNativeCommand\(/gu)?.length, 1, target.bin);
    assert.equal(source.match(/runPassthrough\(/gu)?.length, 1, target.bin);
    assert.match(source, /process\.argv\.slice\(2\)/u, target.bin);
  }

  // The same markers really are what separates a leaf from a host, so the
  // assertion above cannot pass by matching nothing anywhere.
  const hosts = await Promise.all(
    GENERAL_HOST_BINS.map((name) =>
      readFile(join(packageRoot, "dist", "bin", `${name}.js`), "utf8")
    ),
  );
  const combined = hosts.join("\n");
  for (const { label, pattern } of HOST_MARKERS) {
    assert.match(combined, pattern, `a general host is expected to perform ${label}`);
  }
});

test("a capability executor reports a child killed by a signal as exit 2", {
  // Windows has no POSIX signals: `process.kill(process.pid, "SIGTERM")` there
  // is an unconditional `TerminateProcess`, and the parent is told only an exit
  // status. A child cannot report a termination signal for itself, so the input
  // this assertion needs does not exist on that host, and every other host in
  // CI covers it.
  skip: process.platform === "win32"
    ? "a child cannot be killed by a signal on Windows, which has no POSIX signals"
    : false,
}, async () => {
  // The convention promises hosts that 2 means "the executor or its tool
  // broke". A child that dies from a signal has no exit status of its own, so
  // the runtime the executors share has to supply one.
  const { runPassthrough } = await import(
    pathToFileURL(join(packageRoot, "dist/process.js"))
  );
  const result = await runPassthrough(process.execPath, [
    "-e",
    "process.kill(process.pid, 'SIGTERM')",
  ]);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.status, 2);
});

test("the capability calling convention is documented where an adopting host will look", async () => {
  // The published README is the registry landing page, so the protocol lives on
  // the docs site instead. The package README links to this page.
  const page = await readFile(
    join(packageRoot, "../../docs/architecture/provider-protocol.md"),
    "utf8",
  );
  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  assert.match(readme, /architecture\/provider-protocol/u, "the README must link the protocol page");
  const start = page.indexOf("### Capability calling convention");
  assert.notEqual(start, -1, "the page must document the calling convention");
  const end = page.indexOf("\n### ", start + 1);
  const section = end === -1 ? page.slice(start) : page.slice(start, end);
  for (const required of [
    "#### argv",
    "#### Output",
    "#### Exit codes",
    "oxc-tsrx-lint",
    // The honest scope label. Nothing calls lint or format through discovery.
    "no host calls `lint` or `format` through discovery",
  ]) {
    assert.ok(section.includes(required), `the convention must document ${required}`);
  }
});

/**
 * The published package is self-contained: every public export and every bin
 * resolves inside `node_modules/@tsrx/oxc` plus that package's own third-party
 * dependencies. There is no first-party package under it any more, so this lane
 * installs nothing first-party and stubs only the seams a published install
 * genuinely has: the pinned Oxlint and Oxfmt packages, and the platform-native
 * artifact.
 */
test("an isolated consumer resolves every public export and bin from the package alone", async () => {
  const temporary = await temporaryDirectory("oxc-tsrx-toolchain-");
  const consumer = join(temporary, "consumer");
  const installed = join(consumer, "node_modules", "@tsrx/oxc");
  const nested = join(installed, "node_modules");

  try {
    await mkdir(join(consumer, "node_modules"), { recursive: true });
    // The installed copy must arrive without `packages/toolchain/node_modules`.
    // This lane stubs the two pinned third-party packages itself a few lines
    // below, and `cp` turns pnpm's relative store symlinks into absolute ones,
    // so copying that directory would make those stub writes land in the real
    // pnpm store instead of in this fixture.
    await cp(packageRoot, installed, {
      recursive: true,
      filter: (path) => !/[\\/]node_modules([\\/]|$)/u.test(path),
    });
    // `files` excludes the parser addon built into the source tree for local
    // development, so an installed copy must not carry it either.
    for (const artifact of ["parser.node", "parser.node.json"]) {
      await rm(join(installed, artifact), { force: true });
    }
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({
        name: "clean-oxc-tsrx-consumer",
        private: true,
        type: "module",
        devDependencies: { "@tsrx/oxc": "0.9.0" },
      }, null, 2)}\n`,
    );

    // The stub stands in for the native tool. Two environment switches let the
    // calling-convention assertions below drive the two branches the convention
    // describes: a tool that ran and returned a status, and a native package
    // that could not be resolved at all. Replacing the module rather than a
    // package is the seam the merged package actually has.
    await writeFile(
      join(installed, "dist", "runtime.js"),
      [
        "const SUBCOMMANDS = { lint: [], format: ['fmt'], server: ['lsp'] };",
        "export function resolveNativeCommand(kind, args = []) {",
        "  if (process.env.STUB_RESOLVE_FAILURE) {",
        "    throw new Error(`stub native package for ${kind} is unavailable`);",
        "  }",
        "  return { executable: `nested:${kind}`, args: [...SUBCOMMANDS[kind], ...args] };",
        "}",
        "export async function runPassthrough(executable, args) {",
        '  process.stdout.write(JSON.stringify({ tool: "passthrough", executable, args }));',
        "  return { status: Number(process.env.STUB_STATUS ?? 0) };",
        "}",
        "export async function runCaptured(executable, args) {",
        "  return { status: 0, stdout: '', stderr: '', signal: null };",
        "}",
        "",
      ].join("\n"),
    );

    // The toolchain's real runtime dependency, copied from the workspace install
    // so the isolated consumer resolves it exactly as a registry install would.
    await cp(join(packageRoot, "node_modules", "pathe"), join(nested, "pathe"), {
      recursive: true,
      dereference: true,
    });

    // The two third-party packages this one pins by npm alias. Ordinary files
    // are still their work, and the canonical command names still enter their
    // own declared launchers in process.
    await writePackage(
      join(nested, "oxlint-current"),
      {
        name: "oxlint",
        version: "1.74.0",
        type: "module",
        bin: { oxlint: "./bin/oxlint" },
        exports: {
          ".": "./index.js",
          "./plugins-dev": "./plugins-dev.js",
          "./package.json": "./package.json",
        },
      },
      {
        "index.js": "export function defineConfig(config) { return config; }\n",
        "plugins-dev.js":
          'export const pluginMarker = "nested-plugin";\nexport class RuleTester {}\n',
        "bin/oxlint":
          'process.stdout.write(JSON.stringify({ tool: "oxlint", args: process.argv.slice(2) }));\n',
      },
    );
    await writePackage(
      join(nested, "oxfmt-current"),
      {
        name: "oxfmt",
        version: "0.59.0",
        type: "module",
        bin: { oxfmt: "./bin/oxfmt" },
        exports: { ".": "./index.js", "./package.json": "./package.json" },
      },
      {
        "index.js": [
          "export function defineConfig(config) { return config; }",
          "export async function format() { return { code: '', errors: [] }; }",
          "export async function jsTextToDoc() { return { code: '', errors: [] }; }",
          "",
        ].join("\n"),
        "bin/oxfmt":
          'process.stdout.write(JSON.stringify({ tool: "oxfmt", args: process.argv.slice(2) }));\n',
      },
    );

    const probe = join(consumer, "probe.mjs");
    await writeFile(
      probe,
      [
        'import { toolchain } from "@tsrx/oxc";',
        'import { parseSync } from "@tsrx/oxc/parser";',
        'import { defineConfig } from "@tsrx/oxc/lint";',
        'import { pluginMarker } from "@tsrx/oxc/lint/plugins-dev";',
        'import { format } from "@tsrx/oxc/format";',
        'import { setupCompatibility } from "@tsrx/oxc/compat";',
        'import { discoverProviders } from "@tsrx/oxc/provider-resolve";',
        "process.stdout.write(JSON.stringify({",
        "  toolchain,",
        "  parserMarker: typeof parseSync,",
        "  lintMarker: typeof defineConfig,",
        "  pluginMarker,",
        "  formatMarker: typeof format,",
        "  compatMarker: typeof setupCompatibility,",
        "  providerMarker: typeof discoverProviders,",
        "}));",
        "",
      ].join("\n"),
    );

    const imported = runNode(probe, [], { cwd: consumer });
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(JSON.parse(imported.stdout), {
      toolchain: {
        name: "@tsrx/oxc",
        language: "tsrx",
        extensions: [".tsrx"],
        capabilities: ["parser", "lint", "format", "languageServer"],
      },
      parserMarker: "function",
      lintMarker: "function",
      pluginMarker: "nested-plugin",
      formatMarker: "function",
      compatMarker: "function",
      providerMarker: "function",
    });

    // The canonical command names still hand an ordinary-only invocation to the
    // pinned package's own declared launcher, in this process.
    await writeFile(join(consumer, "ordinary.tsx"), "export const value = 1;\n");
    for (const [binary, args, expected] of [
      ["oxlint", ["ordinary.tsx", "--deny-warnings"], {
        tool: "oxlint",
        args: ["ordinary.tsx", "--deny-warnings"],
      }],
      ["oxfmt", ["ordinary.tsx", "--check"], {
        tool: "oxfmt",
        args: ["ordinary.tsx", "--check"],
      }],
      ["oxc-tsrx-lsp", ["--stdio"], {
        tool: "passthrough",
        executable: "nested:server",
        args: ["lsp", "--stdio"],
      }],
      // The leaf capability executors hand their argv to the native binary
      // untouched: no partitioning, no discovery, no second host. The one
      // native binary carries all three tools, so a leading subcommand selects
      // which one runs. It is a tool selector, not an argv rewrite: everything
      // the host passed follows it in order. Linting needs no selector.
      ["oxc-tsrx-lint", ["src/View.tsrx", "--deny-warnings"], {
        tool: "passthrough",
        executable: "nested:lint",
        args: ["src/View.tsrx", "--deny-warnings"],
      }],
      ["oxc-tsrx-fmt", ["src/View.tsrx", "--check"], {
        tool: "passthrough",
        executable: "nested:format",
        args: ["fmt", "src/View.tsrx", "--check"],
      }],
    ]) {
      const result = runNode(join(installed, "bin", binary), args, { cwd: consumer });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }

    // --- The capability calling convention -------------------------------
    // Documented in docs/architecture/provider-protocol.md, "Capability
    // calling convention". No host calls lint or format through discovery, so
    // these assertions are what an adopting host would be able to rely on.
    const executors = [
      ["oxc-tsrx-lint", "lint", []],
      ["oxc-tsrx-fmt", "format", ["fmt"]],
    ];

    // argv: whatever a host passes is what the native tool parses. Awkward
    // paths, values with spaces, and option order all survive untouched.
    const hostArgv = [
      "--config",
      "config dir/.oxlintrc.json",
      join(consumer, "src", "A B.tsrx"),
      "src/View.tsrx",
    ];
    for (const [binary, kind, subcommand] of executors) {
      const result = runNode(join(installed, "bin", binary), hostArgv, { cwd: consumer });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        tool: "passthrough",
        executable: `nested:${kind}`,
        args: [...subcommand, ...hostArgv],
      });
    }

    // exit codes: 0 is a clean run, 1 is findings, 2 is breakage, and any
    // other code the native tool produces reaches the host unchanged.
    for (const [binary] of executors) {
      for (const status of ["0", "1", "2", "87"]) {
        const result = runNode(join(installed, "bin", binary), ["src/View.tsrx"], {
          cwd: consumer,
          env: { ...process.env, STUB_STATUS: status },
        });
        assert.equal(result.status, Number(status), `${binary} must report ${status}`);
      }
    }

    // A broken executor is distinguishable from findings: exit 2, one stderr
    // line naming the executor, and no stdout for a host to misparse.
    for (const [binary] of executors) {
      const result = runNode(join(installed, "bin", binary), ["src/View.tsrx"], {
        cwd: consumer,
        env: { ...process.env, STUB_RESOLVE_FAILURE: "1" },
      });
      assert.equal(result.status, 2, `${binary} must report an executor failure as 2`);
      assert.equal(result.stdout, "", `${binary} must write nothing to stdout when it breaks`);
      assert.match(result.stderr, new RegExp(`^${binary}: `, "u"));
      assert.equal(result.stderr.trimEnd().split("\n").length, 1, result.stderr);
    }

    const negativeProbe = join(consumer, "negative-probe.mjs");
    await writeFile(negativeProbe, "await import(process.argv[2]);\n");
    // The folded wrapper names must stay gone, and folding them in must not
    // have turned this package's internals into a second public surface: the
    // export map is still the whole of what a consumer can reach.
    for (const implementation of [
      "@oxc-tsrx/parser",
      "@oxc-tsrx/runtime",
      "oxlint-tsrx",
      "oxfmt-tsrx",
      "@tsrx/oxc/dist/runtime.js",
      "@tsrx/oxc/dist/lint-cli.js",
      "@tsrx/oxc/dist/format-cli.js",
      "@tsrx/oxc/dist/index.js",
      "@tsrx/oxc/runtime",
    ]) {
      const result = runNode(negativeProbe, [implementation], { cwd: consumer });
      assert.notEqual(
        result.status,
        0,
        `${implementation} must not be importable from the consumer root`,
      );
    }

    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.scripts, undefined);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

/**
 * `oxlint` and `oxfmt` are canonical command names this package does not own.
 * It publishes them because a plain install has no other way to reach a released
 * host, and it hands them back the moment a project says what it means by them.
 * The end-to-end proof is `released-host-install.test.mjs`; these are the branch
 * assertions that do not need a registry.
 */
test("the canonical command names arbitrate from the project manifest alone", async () => {
  const { decideCanonicalCommand, deferralNotice, providedArguments } = await import(
    pathToFileURL(join(packageRoot, "dist/canonical-command.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-canonical-");

  const project = async (name, dependencies, modules = {}) => {
    const directory = join(temporary, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name, private: true, dependencies }, null, 2)}\n`,
    );
    for (const [packageName, { manifest, files = {} }] of Object.entries(modules)) {
      await writePackage(join(directory, "node_modules", packageName), manifest, files);
    }
    return directory;
  };

  const officialOxlint = {
    manifest: { name: "oxlint", version: "1.72.0", bin: { oxlint: "./bin/oxlint" } },
    files: { "bin/oxlint": "#!/usr/bin/env node\n" },
  };

  try {
    // Nothing declared: the launcher keeps the name, which is the only reason a
    // plain install reaches a released host at all.
    const plain = await project("plain", { "@tsrx/oxc": "0.9.0" });
    assert.deepEqual(await decideCanonicalCommand("oxlint", { cwd: plain }), {
      command: "oxlint",
      owner: "@tsrx/oxc",
      reason: "not-directly-declared",
      projectRoot: plain,
    });

    // A transitive official package is not a statement about the command name,
    // so an installed-but-undeclared `oxlint` changes nothing. This is the case
    // every Vite+ project is in.
    const transitive = await project("transitive", { "@tsrx/oxc": "0.9.0" }, { oxlint: officialOxlint });
    assert.equal((await decideCanonicalCommand("oxlint", { cwd: transitive })).owner, "@tsrx/oxc");

    // A direct declaration is such a statement, and it wins outright.
    const pinned = await project(
      "pinned",
      { "@tsrx/oxc": "0.9.0", oxlint: "1.72.0" },
      { oxlint: officialOxlint },
    );
    const deferred = await decideCanonicalCommand("oxlint", { cwd: pinned });
    assert.equal(deferred.owner, "project");
    assert.equal(deferred.reason, "declared-in-dependencies");
    assert.equal(deferred.officialVersion, "1.72.0");
    // `path.relative` is the comparison rather than `===` because Windows
    // resolves the same file to different spellings — `C:\Users\RUNNER~1` and
    // `C:\Users\runneradmin`, `C:` and `c:` — and compares them case
    // insensitively, while POSIX keeps the exact string it was given.
    assert.equal(
      relative(deferred.binPath, await realpath(join(pinned, "node_modules/oxlint/bin/oxlint"))),
      "",
      deferred.binPath,
    );

    // devDependencies say it just as clearly, and the decision is made from the
    // nearest project root, so a nested directory inherits it.
    const development = await project(
      "development",
      { "@tsrx/oxc": "0.9.0" },
      { oxlint: officialOxlint },
    );
    const developmentManifest = JSON.parse(
      await readFile(join(development, "package.json"), "utf8"),
    );
    developmentManifest.devDependencies = { oxlint: "1.72.0" };
    await writeFile(
      join(development, "package.json"),
      `${JSON.stringify(developmentManifest, null, 2)}\n`,
    );
    await mkdir(join(development, "src/deep"), { recursive: true });
    const nested = await decideCanonicalCommand("oxlint", { cwd: join(development, "src/deep") });
    assert.equal(nested.owner, "project");
    assert.equal(nested.reason, "declared-in-devDependencies");

    // The compatibility bridge writes a package named `oxlint` into that slot.
    // Deferring to it would re-enter this launcher without bound, so it does not.
    const bridged = await project(
      "bridged",
      { "@tsrx/oxc": "0.9.0", oxlint: "1.72.0" },
      {
        oxlint: {
          manifest: {
            name: "oxlint",
            version: "0.9.0",
            bin: { oxlint: "./bin/oxlint" },
            oxcTsrxCompatibility: {
              schemaVersion: 1,
              provider: "oxc-tsrx",
              providerVersion: "0.9.0",
              capability: "lint",
            },
          },
          files: { "bin/oxlint": "#!/usr/bin/env node\n" },
        },
      },
    );
    const facade = await decideCanonicalCommand("oxlint", { cwd: bridged });
    assert.equal(facade.owner, "@tsrx/oxc");
    assert.equal(facade.reason, "compatibility-facade");

    // Genuinely ambiguous: the project named a package that is not there. There
    // is no safe guess, so it refuses instead of quietly linting with the wrong
    // tool.
    const missing = await project("missing", { "@tsrx/oxc": "0.9.0", oxfmt: "0.44.0" });
    await assert.rejects(
      () => decideCanonicalCommand("oxfmt", { cwd: missing }),
      /declares the official oxfmt package in dependencies.*not installed/su,
    );

    // The one line a deferring run may print, and only when the caller actually
    // asked about a file this package's provider block claims.
    assert.deepEqual(providedArguments(["--fix", "a.ts", "b.tsrx", "--config=x.tsrx"]), ["b.tsrx"]);
    assert.equal(deferralNotice(deferred, ["src/app.ts"]), null);
    assert.equal(deferralNotice(facade, ["src/View.tsrx"]), null);
    const notice = deferralNotice(deferred, ["src/View.tsrx", "src/app.ts"]);
    assert.match(notice, /official oxlint 1\.72\.0/u);
    assert.match(notice, /src\/View\.tsrx/u);
    assert.match(notice, /npx oxc-tsrx-lint/u);
    assert.equal(notice.includes("\n"), false, "the notice must be one line");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

/**
 * Handing the command name back is only kept if the official binary can actually
 * be executed, and "executed" is not the same operation on every host this
 * package publishes for.
 *
 * These assertions run identically everywhere on purpose. The Windows shapes —
 * a `.cmd` launcher, a drive-lettered path that is not a valid import
 * specifier, a byte-order mark in front of a shebang — are reachable from any
 * host because the platform is a parameter, and a lane that could only run on
 * Windows would be a lane that never runs. What they cannot do is stand in for
 * a Windows host: the `install-arbitration` CI job is what observes that.
 */
test("the official binary is executed the way each host requires", async (context) => {
  const { escapeCommandArgument, resolveCommandInvocation } = await import(
    pathToFileURL(join(packageRoot, "dist/spawn-command.js"))
  );
  const { runOfficialCommand, usesNodeInterpreter } = await import(
    pathToFileURL(join(packageRoot, "dist/canonical-command.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-official-run-");
  context.after(() => rm(temporary, { recursive: true, force: true }));

  // Windows cannot execute a `.cmd` launcher directly, and `npm` writes exactly
  // that into `node_modules/.bin`. It goes to the command interpreter, verbatim,
  // with every argument escaped for `cmd.exe` rather than concatenated the way
  // `shell: true` would.
  const batch = resolveCommandInvocation(
    "C:\\Program Files\\app\\node_modules\\.bin\\oxlint.cmd",
    ["--format=json", "a b.tsrx", "x&whoami"],
    "win32",
  );
  assert.match(batch.file, /cmd(?:\.exe)?$/iu);
  assert.deepEqual(batch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(batch.windowsVerbatimArguments, true);
  assert.equal(batch.args.length, 4);
  assert.match(batch.args[3], /^"/u);
  assert.match(batch.args[3], /oxlint\.cmd/u);
  assert.equal(
    batch.args[3].includes("&whoami") && !batch.args[3].includes("^&whoami"),
    false,
    "an unescaped & would let an argument start a second command",
  );
  assert.equal(escapeCommandArgument("a b.tsrx"), '^"a^ b.tsrx^"');
  assert.equal(escapeCommandArgument("x&whoami"), '^"x^&whoami^"');
  assert.equal(escapeCommandArgument('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(escapeCommandArgument("C:\\dir\\"), '^"C:\\dir\\\\^"');

  // Everything else is spawned as itself, on every host. A `.cmd` name on a
  // POSIX host is an ordinary file and must not be routed through an
  // interpreter that is not there.
  for (const [file, platform] of [
    ["C:\\app\\oxlint.exe", "win32"],
    ["C:\\app\\node_modules\\oxlint\\bin\\oxlint", "win32"],
    ["/app/node_modules/.bin/oxlint.cmd", "linux"],
    ["/app/node_modules/oxlint/bin/oxlint", "darwin"],
  ]) {
    const invocation = resolveCommandInvocation(file, ["--version"], platform);
    assert.deepEqual(invocation, {
      file,
      args: ["--version"],
      windowsVerbatimArguments: false,
    });
  }

  // A byte-order mark in front of a shebang is ordinary in a file authored on
  // Windows. Reading past it is what keeps a Node wrapper on the in-process
  // path; classifying it as a native executable would spawn an extensionless
  // file, which Windows cannot run at all.
  const wrapper = join(temporary, "bom-wrapper");
  await writeFile(wrapper, '\uFEFF#!/usr/bin/env node\nprocess.exitCode = 0;\n');
  assert.equal(await usesNodeInterpreter(wrapper), true, "a BOM must not hide the shebang");
  const native = join(temporary, "native-binary");
  await writeFile(native, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]));
  assert.equal(await usesNodeInterpreter(native), false);

  // The in-process branch imports through a file URL. That is not cosmetic: a
  // path is not a module specifier, and the difference shows on any host as
  // soon as the path contains a character a URL reads as syntax. On Windows
  // every path does, because `C:` parses as a scheme.
  const awkward = join(temporary, "a b#c");
  await mkdir(join(awkward, "bin"), { recursive: true });
  await writeFile(join(awkward, "package.json"), '{ "name": "awkward", "type": "module" }\n');
  const binPath = join(awkward, "bin", "oxlint");
  await writeFile(
    binPath,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("./ran.marker", import.meta.url), "ran");',
      "",
    ].join("\n"),
  );
  await assert.rejects(
    () => import(binPath),
    "a bare path is not a module specifier; this is the failure pathToFileURL prevents",
  );
  await runOfficialCommand(
    { command: "oxlint", binPath, officialRoot: awkward },
    {
      spawn: () => {
        throw new Error("a Node wrapper must run in this process, not as a child");
      },
    },
  );
  assert.equal(await readFile(join(awkward, "bin", "ran.marker"), "utf8"), "ran");

  // A declared binary that cannot start is the launcher's error to report. Left
  // unhandled it would be an `error` event on the child, which surfaces as a
  // stack trace out of node:child_process instead of one actionable line.
  const unrunnable = join(temporary, "not-runnable");
  await writeFile(unrunnable, "this is not an executable and has no shebang\n");
  await assert.rejects(
    () => runOfficialCommand({ command: "oxlint", binPath: unrunnable, officialRoot: temporary }),
    /could not execute .*not-runnable.*oxlint binary/su,
  );
});

/**
 * The fourth compatibility slot: one key in the project's own
 * `.vscode/settings.json`.
 *
 * `setup` writing the `oxlint` *package* facade is what makes `vp lint` work. It
 * does nothing for the editor, because the official OXC extension finds its
 * linter through `node_modules/.bin/oxlint`, and in a Vite+ project that shim
 * belongs to Vite+, which knows nothing about `.tsrx`. The observed result was an
 * editor with no diagnostics and no message anywhere saying why.
 *
 * These fixtures stand in a published `@tsrx/oxc` so the assertions are about the
 * slot rather than about this repository's install layout; the real installed
 * shape, under npm, pnpm, and Bun, is `toolchain-compat.test.mjs`.
 */
async function providerFixture(temporary, name, { ownsLinterShim }) {
  const project = join(temporary, name);
  const modules = join(project, "node_modules");
  const provider = join(modules, "@tsrx/oxc");
  await mkdir(join(provider, "bin"), { recursive: true });
  await mkdir(join(modules, ".bin"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify(
      {
        // `name` may be a nested path, so that a fixture can put the project
        // below the folder a user would open. The manifest still needs a plain
        // package name.
        name: basename(name),
        private: true,
        type: "module",
        devDependencies: { "@tsrx/oxc": "0.9.0" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(provider, "package.json"),
    `${JSON.stringify({ name: "@tsrx/oxc", version: "0.9.0", bin: { oxlint: "./bin/oxlint" } }, null, 2)}\n`,
  );
  await writeFile(join(provider, "bin", "oxlint"), "#!/usr/bin/env node\n");

  // Vite+'s own wrapper, in the slot the extension reads.
  const foreign = join(modules, "vite-plus", "bin", "oxlint");
  await mkdir(join(modules, "vite-plus", "bin"), { recursive: true });
  await writeFile(foreign, "#!/usr/bin/env node\n");

  const target = ownsLinterShim ? join(provider, "bin", "oxlint") : foreign;
  const shim = join(modules, ".bin", "oxlint");
  try {
    await symlink(target, shim);
  } catch {
    // Windows writes text shims that name their target inline, which is the
    // other resolution this detection has to read.
    await writeFile(shim, `@"%~dp0\\..\\${relative(modules, target)}" %*\r\n`);
  }
  return { project, modules, settings: join(project, ".vscode", "settings.json") };
}

/**
 * What a correctly wired editor slot reports *on this machine*.
 *
 * Everywhere except Windows that is `active`. On Windows it is not, and
 * deliberately so: the value this package writes ends in `@tsrx/oxc/bin/oxlint`,
 * which the extension classifies as a native binary rather than a Node script,
 * and it spawns a native binary through `cmd.exe`, which can only run `.exe`,
 * `.com`, `.bat` and `.cmd`. An extensionless file is none of those, so the
 * spawn fails and the editor goes quiet. Reporting `active` there would be the
 * exact silence this slot exists to end. The platform-pinned tests below assert
 * both answers on every machine.
 */
const WIRED = process.platform === "win32" ? "unresolvable" : "active";

test("the editor slot is written only when another tool owns the linter lookup", async () => {
  const { compatibilityStatus, removeCompatibility, setupCompatibility } = await import(
    pathToFileURL(join(packageRoot, "dist/compat.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-editor-slot-");
  try {
    // A plain install: this package already owns `.bin/oxlint`, so the setting
    // would be noise. Nothing is written and the slot says so rather than
    // reporting itself active.
    const plain = await providerFixture(temporary, "plain", { ownsLinterShim: true });
    const plainSetup = await setupCompatibility({ projectRoot: plain.project });
    assert.equal(plainSetup.editorSlot.state, "unnecessary");
    assert.equal(plainSetup.editorSlot.linterShim.owner, "@tsrx/oxc");
    assert.equal(plainSetup.changed.includes("oxc.path.oxlint"), false);
    assert.deepEqual(await readdir(plain.project), ["node_modules", "package.json"]);

    // A Vite+ shaped project: another tool owns the lookup, so the setting is
    // the only thing that reaches the editor.
    const bridged = await providerFixture(temporary, "bridged", { ownsLinterShim: false });
    const before = await compatibilityStatus({ projectRoot: bridged.project });
    assert.equal(before.editorSlot.state, "missing");
    assert.equal(before.editorSlot.linterShim.owner, "other");

    const preview = await setupCompatibility({ projectRoot: bridged.project, dryRun: true });
    assert.equal(preview.changed.includes("oxc.path.oxlint"), true);
    assert.equal(await readdir(bridged.project).then((names) => names.includes(".vscode")), false);

    const written = await setupCompatibility({ projectRoot: bridged.project });
    assert.equal(written.editorSlot.state, WIRED);
    assert.equal(written.changed.includes("oxc.path.oxlint"), true);
    assert.deepEqual(JSON.parse(await readFile(bridged.settings, "utf8")), {
      "oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/oxlint",
    });

    // Twice changes nothing, byte for byte.
    const first = await readFile(bridged.settings, "utf8");
    const again = await setupCompatibility({ projectRoot: bridged.project });
    assert.deepEqual(again.changed, []);
    assert.equal(again.editorSlot.state, WIRED);
    assert.equal(await readFile(bridged.settings, "utf8"), first);

    // `remove` takes the key back, and the file and directory with it, because
    // `setup` created both and left nothing else in them.
    const removed = await removeCompatibility({ projectRoot: bridged.project });
    assert.equal(removed.removed.includes("oxc.path.oxlint"), true);
    assert.equal(removed.editorSlot.state, "missing");
    assert.equal((await readdir(bridged.project)).includes(".vscode"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the editor slot merges into the user's settings and gives back only its own key", async () => {
  const { removeCompatibility, setupCompatibility } = await import(
    pathToFileURL(join(packageRoot, "dist/compat.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-editor-merge-");
  try {
    // `.vscode/settings.json` is the user's file. VS Code accepts comments and
    // trailing commas there, this repository has no JSON5/JSONC dependency, and
    // acquiring one to rewrite a user's file would be the wrong trade. The key
    // is spliced in and out by byte offset instead, so everything this package
    // does not own survives exactly as written.
    const authored = [
      "{",
      "  // Formatting for TSRX files, contributed by the framework extension.",
      '  "[markless-tsrx]": {',
      '    "editor.defaultFormatter": "oxc.oxc-vscode"',
      "  },",
      "  /* team-wide */",
      '  "editor.tabSize": 2,',
      "}",
      "",
    ].join("\n");

    const merged = await providerFixture(temporary, "merged", { ownsLinterShim: false });
    await mkdir(join(merged.project, ".vscode"), { recursive: true });
    await writeFile(merged.settings, authored);
    await setupCompatibility({ projectRoot: merged.project });
    const written = await readFile(merged.settings, "utf8");
    assert.match(written, /"oxc\.path\.oxlint": "node_modules\/@tsrx\/oxc\/bin\/oxlint"/u);
    for (const preserved of [
      "// Formatting for TSRX files, contributed by the framework extension.",
      "/* team-wide */",
      '"editor.tabSize": 2,',
      '"editor.defaultFormatter": "oxc.oxc-vscode"',
    ]) {
      assert.ok(written.includes(preserved), preserved);
    }
    await removeCompatibility({ projectRoot: merged.project });
    // The user's file is theirs again, byte for byte, and it was not deleted
    // because this package did not create it.
    assert.equal(await readFile(merged.settings, "utf8"), authored);

    // An `oxc.path.oxlint` the user already set is a statement. It is reported
    // and left, the same refusal the package slots make for a direct or
    // unrecognized collision, and `remove` does not take it either.
    const owned = [
      "{",
      '  "editor.tabSize": 2,',
      '  "oxc.path.oxlint": "/opt/homebrew/bin/oxlint",',
      '  "search.exclude": { "**/dist": true }',
      "}",
      "",
    ].join("\n");
    const conflicting = await providerFixture(temporary, "conflicting", {
      ownsLinterShim: false,
    });
    await mkdir(join(conflicting.project, ".vscode"), { recursive: true });
    await writeFile(conflicting.settings, owned);
    const collided = await setupCompatibility({ projectRoot: conflicting.project });
    assert.equal(collided.editorSlot.state, "collision");
    assert.equal(collided.editorSlot.currentValue, "/opt/homebrew/bin/oxlint");
    assert.equal(collided.changed.includes("oxc.path.oxlint"), false);
    assert.equal(await readFile(conflicting.settings, "utf8"), owned);
    await removeCompatibility({ projectRoot: conflicting.project });
    assert.equal(await readFile(conflicting.settings, "utf8"), owned);

    // Removing a last entry has to take the previous entry's comma with it, or
    // a file that was strict JSON stops being strict JSON.
    const last = await providerFixture(temporary, "last-entry", { ownsLinterShim: false });
    await mkdir(join(last.project, ".vscode"), { recursive: true });
    await writeFile(
      last.settings,
      '{\n  "editor.tabSize": 2,\n  "oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/oxlint"\n}\n',
    );
    await removeCompatibility({ projectRoot: last.project });
    assert.equal(
      await readFile(last.settings, "utf8"),
      '{\n  "editor.tabSize": 2\n}\n',
    );

    // A settings file this package cannot read as one top-level object is not a
    // file it will guess at. It reports and writes nothing.
    const opaque = await providerFixture(temporary, "opaque", { ownsLinterShim: false });
    await mkdir(join(opaque.project, ".vscode"), { recursive: true });
    await writeFile(opaque.settings, "[1, 2, 3]\n");
    const refused = await setupCompatibility({ projectRoot: opaque.project });
    assert.equal(refused.editorSlot.state, "unreadable");
    assert.equal(refused.changed.includes("oxc.path.oxlint"), false);
    assert.equal(await readFile(opaque.settings, "utf8"), "[1, 2, 3]\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

/**
 * The gap this whole slice exists for.
 *
 * `setup` writes at the project root, meaning the nearest `package.json`. VS
 * Code reads `.vscode/settings.json` only from the folder you open as the
 * workspace root, never from a subfolder of it. Every monorepo puts those two in
 * different places, and in that window the key is simply not read: the extension
 * falls back to its own lookup, finds whichever tool owns
 * `node_modules/.bin/oxlint`, and nothing anywhere says why there are no
 * diagnostics. Reporting `active` for that was the lie.
 */
test("a workspace root above the project root is reported instead of claimed active", async () => {
  const {
    compatibilityStatus,
    formatCompatibilityReport,
    removeCompatibility,
    setupCompatibility,
  } = await import(pathToFileURL(join(packageRoot, "dist/compat.js")));
  const temporary = await temporaryDirectory("oxc-tsrx-editor-folder-");
  try {
    const nested = await providerFixture(temporary, join("mono", "apps", "web"), {
      ownsLinterShim: false,
    });
    const monorepo = join(temporary, "mono");
    await writeFile(join(monorepo, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');

    // `platform` is pinned so this asserts the folder answer rather than the
    // Windows spawn answer, which has its own test below.
    const options = { projectRoot: nested.project, platform: "linux" };

    const before = await compatibilityStatus(options);
    assert.equal(before.editorSlot.state, "missing");
    assert.deepEqual(before.editorSlot.workspaceRoots, [
      { path: monorepo, evidence: "pnpm-workspace.yaml" },
    ]);

    const written = await setupCompatibility(options);
    assert.equal(written.changed.includes("oxc.path.oxlint"), true);
    // Written at the project root, with the value that is correct for it, and
    // nothing at all above it. The flag is the only way up.
    assert.deepEqual(JSON.parse(await readFile(nested.settings, "utf8")), {
      "oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/oxlint",
    });
    assert.equal(written.editorSlot.settingsRoot, nested.project);
    assert.equal((await readdir(monorepo)).includes(".vscode"), false);

    // Written is not wired, and the slot says which of the two it is.
    assert.equal(written.editorSlot.state, "inert");
    assert.equal(written.editorSlot.reach.state, "inert");
    assert.equal(written.editorSlot.reach.resolution.reason, "resolved");
    assert.equal(written.editorSlot.notes.length, 3);
    assert.match(
      written.editorSlot.notes[0],
      /VS Code reads \.vscode\/settings\.json only from the folder you open/u,
    );
    assert.ok(written.editorSlot.notes[0].includes(`${monorepo} (pnpm-workspace.yaml)`));
    // The two remedies, in the order the reader should try them.
    assert.match(
      written.editorSlot.notes[1],
      new RegExp(
        `open ${escapeForRegExp(nested.project)} as the folder in your editor, or - from ${escapeForRegExp(nested.project)} - run npx oxc-tsrx setup --workspace-root <folder>`,
        "u",
      ),
    );
    // A written key changes nothing in a window whose server is already
    // running, so every write ends by saying so.
    assert.match(written.editorSlot.notes[2], /reload it \(Developer: Reload Window\)/u);

    const report = formatCompatibilityReport(written);
    assert.match(report, /oxc\.path\.oxlint:\s+inert \(editor\)/u);
    for (const fragment of [monorepo, "pnpm-workspace.yaml", "--workspace-root", nested.project]) {
      assert.ok(report.includes(fragment), `${fragment} is missing from:\n${report}`);
    }

    // `status` says the same thing on its own, with no setup re-run, and never
    // drifts back to active.
    const after = await compatibilityStatus(options);
    assert.equal(after.editorSlot.state, "inert");
    assert.equal(after.editorSlot.currentValue, "node_modules/@tsrx/oxc/bin/oxlint");

    // A key that cannot be claimed is still a key this package wrote, so
    // `remove` still takes it back and the file it created with it.
    const removed = await removeCompatibility(options);
    assert.equal(removed.removed.includes("oxc.path.oxlint"), true);
    assert.equal((await readdir(nested.project)).includes(".vscode"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function escapeForRegExp(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

test("--workspace-root is the only way to write above the project root", async () => {
  const {
    compatibilityStatus,
    formatCompatibilityReport,
    removeCompatibility,
    setupCompatibility,
  } = await import(pathToFileURL(join(packageRoot, "dist/compat.js")));
  const temporary = await temporaryDirectory("oxc-tsrx-editor-root-flag-");
  try {
    const nested = await providerFixture(temporary, join("mono", "apps", "web"), {
      ownsLinterShim: false,
    });
    const monorepo = join(temporary, "mono");
    await writeFile(join(monorepo, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
    const ancestorSettings = join(monorepo, ".vscode", "settings.json");

    const written = await setupCompatibility({
      projectRoot: nested.project,
      workspaceRoot: monorepo,
      platform: "linux",
    });
    // The value is relative to the folder that was named, not to the project.
    assert.deepEqual(JSON.parse(await readFile(ancestorSettings, "utf8")), {
      "oxc.path.oxlint": "apps/web/node_modules/@tsrx/oxc/bin/oxlint",
    });
    assert.equal(written.editorSlot.state, "active");
    assert.equal(written.editorSlot.settingsRoot, monorepo);
    assert.equal(written.editorSlot.path, ancestorSettings);
    assert.equal((await readdir(nested.project)).includes(".vscode"), false);

    // The caveat that makes this a flag rather than a default.
    const caveat = written.editorSlot.notes.find((note) => note.includes("FIRST folder"));
    assert.ok(caveat, JSON.stringify(written.editorSlot.notes));
    assert.match(caveat, /multi-root window resolves a relative "oxc\.path\.oxlint"/u);
    // "FIRST" on its own: the report wraps at spaces, so the phrase around it
    // may be split across two lines.
    assert.ok(formatCompatibilityReport(written).includes("FIRST"));

    // `status` and `remove` find that file again from the receipt alone, with
    // no flag repeated, which is what keeps remove symmetric with setup.
    const status = await compatibilityStatus({ projectRoot: nested.project, platform: "linux" });
    assert.equal(status.editorSlot.path, ancestorSettings);
    assert.equal(status.editorSlot.state, "active");

    // A folder that is not a directory, and a folder that does not contain the
    // project, are both refused: a relative value has no way to climb out,
    // because the extension rejects any value containing "..".
    await assert.rejects(
      setupCompatibility({ projectRoot: nested.project, workspaceRoot: join(temporary, "absent") }),
      /--workspace-root .* is not a directory/u,
    );
    const sibling = join(temporary, "sibling");
    await mkdir(sibling, { recursive: true });
    await assert.rejects(
      setupCompatibility({ projectRoot: nested.project, workspaceRoot: sibling }),
      /does not contain/u,
    );
    // Re-aiming at a different folder would orphan the key already written.
    await assert.rejects(
      setupCompatibility({ projectRoot: nested.project, workspaceRoot: nested.project }),
      /already wrote "oxc\.path\.oxlint"/u,
    );

    const removed = await removeCompatibility({ projectRoot: nested.project, platform: "linux" });
    assert.equal(removed.removed.includes("oxc.path.oxlint"), true);
    assert.equal((await readdir(monorepo)).includes(".vscode"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("every weak ancestor in the chain gets its own copy of the key", async () => {
  // Not just the nearest: whichever ancestor folder the editor is opened in,
  // that window reads its own settings file, so every installed ancestor above
  // the project is covered with a value relative to itself.
  const { removeCompatibility, setupCompatibility } = await import(
    pathToFileURL(join(packageRoot, "dist/compat.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-editor-chain-");
  try {
    const nested = await providerFixture(temporary, join("outer", "demo", "my-app"), {
      ownsLinterShim: false,
    });
    const outer = join(temporary, "outer");
    const demo = join(outer, "demo");
    for (const shell of [outer, demo]) {
      await writeFile(
        join(shell, "package.json"),
        `${JSON.stringify({ name: basename(shell), private: true }, null, 2)}\n`,
      );
      await writeFile(join(shell, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    }

    const options = { projectRoot: nested.project, platform: "linux" };
    const written = await setupCompatibility(options);
    assert.equal(written.editorSlot.state, "active");
    assert.deepEqual(
      JSON.parse(await readFile(join(demo, ".vscode", "settings.json"), "utf8")),
      { "oxc.path.oxlint": "my-app/node_modules/@tsrx/oxc/bin/oxlint" },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(outer, ".vscode", "settings.json"), "utf8")),
      { "oxc.path.oxlint": "demo/my-app/node_modules/@tsrx/oxc/bin/oxlint" },
    );

    // Symmetry across the whole chain.
    const removed = await removeCompatibility(options);
    assert.equal(removed.removed.includes("oxc.path.oxlint"), true);
    assert.equal((await readdir(demo)).includes(".vscode"), false);
    assert.equal((await readdir(outer)).includes(".vscode"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a workspace-root placement survives the reinstall that wipes the receipt", async () => {
  // The receipt lives under node_modules, and the walkthroughs themselves tell
  // readers to reinstall and re-run setup. Before this test existed, that wipe
  // made plain `setup` forget a --workspace-root placement, write a second key
  // at the project root, and leave the parent key behind in a file nothing
  // took back - a demo whose editor went dark after every dependency change.
  const { compatibilityStatus, removeCompatibility, setupCompatibility } = await import(
    pathToFileURL(join(packageRoot, "dist/compat.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-editor-reinstall-");
  try {
    const nested = await providerFixture(temporary, join("demo", "my-app"), {
      ownsLinterShim: false,
    });
    const demo = join(temporary, "demo");
    // The walkthrough's exact parent shape: an installed project, no .git.
    await writeFile(
      join(demo, "package.json"),
      `${JSON.stringify({ name: "demo-shell", private: true }, null, 2)}\n`,
    );
    await writeFile(join(demo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const ancestorSettings = join(demo, ".vscode", "settings.json");
    const receipt = join(nested.project, "node_modules", ".oxc-tsrx-compat");

    const options = { projectRoot: nested.project, platform: "linux" };
    await setupCompatibility({ ...options, workspaceRoot: demo });
    assert.deepEqual(JSON.parse(await readFile(ancestorSettings, "utf8")), {
      "oxc.path.oxlint": "my-app/node_modules/@tsrx/oxc/bin/oxlint",
    });

    // The reinstall: node_modules contents are regenerated, the receipt is gone.
    await rm(receipt, { recursive: true, force: true });

    // The durable artifact is the key itself, so status still serves it...
    const status = await compatibilityStatus(options);
    assert.equal(status.editorSlot.path, ancestorSettings);
    assert.equal(status.editorSlot.settingsRoot, demo);
    assert.equal(status.editorSlot.state, "active");

    // ...plain setup keeps the parent as the primary placement AND covers the
    // project's own window too, so whichever folder is opened, that window
    // reads a correct key...
    const again = await setupCompatibility(options);
    assert.equal(again.editorSlot.path, ancestorSettings);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(nested.project, ".vscode", "settings.json"), "utf8"),
      ),
      { "oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/oxlint" },
    );

    // ...re-aiming elsewhere is still refused, receipt or no receipt...
    await assert.rejects(
      setupCompatibility({ ...options, workspaceRoot: nested.project }),
      /already wrote "oxc\.path\.oxlint"/u,
    );

    // ...and remove takes back every placement. Without the receipt it cannot
    // prove it created the settings files, so the keys go and emptied files
    // conservatively stay - deleting a file it cannot prove it made would be
    // presumptuous.
    await rm(receipt, { recursive: true, force: true });
    const removed = await removeCompatibility(options);
    assert.equal(removed.removed.includes("oxc.path.oxlint"), true);
    for (const settings of [ancestorSettings, join(nested.project, ".vscode", "settings.json")]) {
      const survivor = JSON.parse(await readFile(settings, "utf8").catch(() => "{}"));
      assert.equal(survivor["oxc.path.oxlint"], undefined, settings);
    }
    await rm(join(demo, ".vscode"), { recursive: true, force: true });
    await rm(join(nested.project, ".vscode"), { recursive: true, force: true });

    // A parent key that resolves into someone else's install is not adopted:
    // it is their wiring, not a lost receipt of ours.
    await mkdir(join(demo, ".vscode"), { recursive: true });
    await writeFile(
      ancestorSettings,
      `${JSON.stringify({ "oxc.path.oxlint": "elsewhere/node_modules/@tsrx/oxc/bin/oxlint" }, null, 2)}\n`,
    );
    const foreign = await compatibilityStatus(options);
    assert.equal(foreign.editorSlot.settingsRoot, nested.project);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("every candidate workspace root is named with the file that made it a candidate", async () => {
  const { compatibilityStatus, formatCompatibilityReport, setupCompatibility } = await import(
    pathToFileURL(join(packageRoot, "dist/compat.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-editor-candidates-");
  try {
    const nested = await providerFixture(temporary, join("root", "repo", "apps", "web"), {
      ownsLinterShim: false,
    });
    const outer = join(temporary, "root");
    const repo = join(outer, "repo");
    const apps = join(repo, "apps");
    // Three ancestors, three different kinds of evidence, and `.git` sitting in
    // the same folder as a `workspaces` field so the stronger one wins there.
    await writeFile(join(outer, "team.code-workspace"), '{ "folders": [{ "path": "repo" }] }\n');
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({ name: "repo", private: true, workspaces: ["apps/*"] }, null, 2)}\n`,
    );
    await writeFile(join(apps, "turbo.json"), "{}\n");

    const options = { projectRoot: nested.project, platform: "linux" };
    const status = await compatibilityStatus(options);
    assert.deepEqual(status.editorSlot.workspaceRoots, [
      { path: outer, evidence: "team.code-workspace" },
      { path: repo, evidence: "package.json" },
      { path: apps, evidence: "turbo.json" },
    ]);
    assert.equal(
      status.editorSlot.workspaceRoots.some((candidate) => candidate.evidence === ".git"),
      false,
      "a folder that declares workspaces should be named by that, not by .git",
    );

    const written = await setupCompatibility(options);
    assert.equal(written.editorSlot.state, "inert");
    const report = formatCompatibilityReport(written);
    for (const fragment of [
      `${outer} (team.code-workspace)`,
      `${repo} (package.json)`,
      `${apps} (turbo.json)`,
    ]) {
      assert.ok(written.editorSlot.notes[0].includes(fragment), fragment);
    }
    assert.ok(report.includes("team.code-workspace"), report);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an installed ancestor with no workspace declaration is still a named candidate", async () => {
  // The Vite+ walkthrough manufactures exactly this shape: a demo folder made
  // with --no-git holding only a package.json, a lockfile, and node_modules,
  // with the real project scaffolded one level below. Opening the demo folder
  // in the editor makes the project's own settings key inert, so the demo
  // folder must be named even though it declares no workspace at all.
  const { compatibilityStatus } = await import(pathToFileURL(join(packageRoot, "dist/compat.js")));
  const temporary = await temporaryDirectory("oxc-tsrx-editor-installed-ancestor-");
  try {
    const nested = await providerFixture(temporary, join("demo", "my-app"), {
      ownsLinterShim: false,
    });
    const demo = join(temporary, "demo");
    await writeFile(
      join(demo, "package.json"),
      `${JSON.stringify({ name: "demo-shell", private: true, dependencies: { "vite-plus": "^0.2.6" } }, null, 2)}\n`,
    );
    await writeFile(join(demo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mkdir(join(demo, "node_modules"), { recursive: true });
    // A bare manifest with neither lockfile nor node_modules stays invisible:
    // it is not an installed project, and naming it would be noise.
    const bare = join(temporary, "demo", "my-app", "packages");
    await mkdir(bare, { recursive: true });

    const status = await compatibilityStatus({ projectRoot: nested.project, platform: "linux" });
    assert.deepEqual(status.editorSlot.workspaceRoots, [
      { path: demo, evidence: "pnpm-lock.yaml" },
    ]);

    // Weak evidence is handled, not warned about: an installed ancestor is a
    // folder someone MIGHT open, so setup writes that folder's own copy of the
    // key automatically, and the walkthrough's happy path reads as the success
    // it is - active, with the extra coverage named.
    const { setupCompatibility } = await import(
      pathToFileURL(join(packageRoot, "dist/compat.js"))
    );
    const written = await setupCompatibility({ projectRoot: nested.project, platform: "linux" });
    assert.equal(written.editorSlot.state, "active");
    assert.deepEqual(
      JSON.parse(await readFile(join(demo, ".vscode", "settings.json"), "utf8")),
      { "oxc.path.oxlint": "my-app/node_modules/@tsrx/oxc/bin/oxlint" },
      "the ancestor's own window is covered without a flag or a manual step",
    );
    const ancestorNotes = written.editorSlot.notes.filter((note) => note.includes(demo));
    assert.equal(ancestorNotes.length, 1);
    assert.match(ancestorNotes[0], /Also covered/u);
    assert.equal(
      written.editorSlot.notes.some((note) => note.includes("Two remedies")),
      false,
      "the full remedies wall is reserved for deliberate workspace markers",
    );
    // Idempotent: a second setup changes nothing and reports the same coverage.
    const again = await setupCompatibility({ projectRoot: nested.project, platform: "linux" });
    assert.equal(again.changed.includes("oxc.path.oxlint"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

/**
 * Another tool's `oxlint`, in the `.bin` of whichever folder is named. This is
 * the thing that makes an ancestor dangerous rather than merely present.
 */
async function competingLinterShim(root, owner = "vite-plus") {
  const modules = join(root, "node_modules");
  const source = join(modules, owner, "bin", "oxlint");
  await mkdir(join(modules, owner, "bin"), { recursive: true });
  await mkdir(join(modules, ".bin"), { recursive: true });
  await writeFile(
    join(modules, owner, "package.json"),
    `${JSON.stringify({ name: owner, version: "1.0.0", bin: { oxlint: "./bin/oxlint" } }, null, 2)}\n`,
  );
  await writeFile(source, "#!/usr/bin/env node\n");
  const shim = join(modules, ".bin", "oxlint");
  try {
    await symlink(source, shim);
  } catch {
    await writeFile(shim, `@"%~dp0\\..\\${relative(modules, source)}" %*\r\n`);
  }
  return shim;
}

/**
 * The other half of the same lie.
 *
 * `active` was demoted for a key the editor would never read. `unnecessary` was
 * not demoted at all: `node_modules/.bin/oxlint` being ours ended the enquiry,
 * and the report said "the editor needs no setting and none was written" for a
 * monorepo whose root carries a competing `oxlint`. The extension searches each
 * opened folder's own `node_modules/.bin` first, so opening that root runs the
 * other tool and there are no `.tsrx` diagnostics at all. Green report, silent
 * editor, which is the failure this slot exists to end.
 *
 * Both directions are asserted on one tree, so the only difference between them
 * is the competing binary itself. A monorepo without one must stay
 * `unnecessary`: a false alarm here would be worse than the gap.
 */
test("unnecessary is proven from every folder that might be opened, not assumed", async () => {
  const { compatibilityStatus, formatCompatibilityReport, removeCompatibility, setupCompatibility } =
    await import(pathToFileURL(join(packageRoot, "dist/compat.js")));
  const { resolveEditorLinter } = await import(
    pathToFileURL(join(packageRoot, "dist/editor-resolution.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-editor-unnecessary-");
  try {
    const nested = await providerFixture(temporary, join("mono", "packages", "app"), {
      ownsLinterShim: true,
    });
    const monorepo = join(temporary, "mono");
    await writeFile(join(monorepo, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    const options = { projectRoot: nested.project, platform: "linux" };

    // Direction one: the ancestor is a workspace root and has no oxlint of its
    // own, so opening it still lands in this package through the extension's
    // `**/package.json` step. Nothing is wrong and nothing is claimed.
    const healthy = await setupCompatibility(options);
    assert.equal(healthy.editorSlot.state, "unnecessary");
    assert.deepEqual(healthy.editorSlot.notes, []);
    assert.deepEqual(healthy.editorSlot.workspaceRoots, [
      { path: monorepo, evidence: "pnpm-workspace.yaml" },
    ]);
    assert.equal(healthy.changed.includes("oxc.path.oxlint"), false);
    assert.equal((await readdir(nested.project)).includes(".vscode"), false);
    assert.ok(
      healthy.editorSlot.reach.autoDetection.every((candidate) => candidate.reaches),
      JSON.stringify(healthy.editorSlot.reach.autoDetection),
    );

    // Still direction one, and the shape that a path-based answer gets wrong.
    // pnpm 10 writes `.bin/oxlint` as a shell script rather than a symlink, so
    // the file that stats is the launcher itself and the nearest `package.json`
    // above it is the consumer's own. A root shim that is really ours must not
    // be read as a foreign linter: measured on a real pnpm install, where every
    // path-shaped test called this tree diverged.
    const hoisted = join(monorepo, "node_modules", "@tsrx/oxc");
    await mkdir(join(hoisted, "bin"), { recursive: true });
    await mkdir(join(monorepo, "node_modules", ".bin"), { recursive: true });
    await writeFile(
      join(hoisted, "package.json"),
      `${JSON.stringify({ name: "@tsrx/oxc", version: "0.9.0", bin: { oxlint: "./bin/oxlint" } }, null, 2)}\n`,
    );
    await writeFile(join(hoisted, "bin", "oxlint"), "#!/usr/bin/env node\n");
    const rootShim = join(monorepo, "node_modules", ".bin", "oxlint");
    await writeFile(
      rootShim,
      '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../@tsrx/oxc/bin/oxlint" "$@"\n',
    );
    const alsoOurs = await compatibilityStatus(options);
    assert.equal(alsoOurs.editorSlot.state, "unnecessary");
    assert.deepEqual(alsoOurs.editorSlot.notes, []);
    assert.equal(alsoOurs.editorSlot.reach.autoDetection.at(-1).path, rootShim);
    assert.equal(alsoOurs.editorSlot.reach.autoDetection.at(-1).tsrxAware, false);
    assert.equal(
      alsoOurs.editorSlot.reach.autoDetection.at(-1).reaches,
      true,
      "a launcher naming this package's binary inline is this package's launcher",
    );

    // Direction two: the same tree, one competing binary at the root.
    await rm(rootShim, { force: true });
    const competing = await competingLinterShim(monorepo);
    const status = await compatibilityStatus(options);
    assert.equal(status.editorSlot.state, "inert");
    assert.equal(status.editorSlot.currentValue, null);
    assert.equal(status.editorSlot.linterShim.owner, "@tsrx/oxc");

    // The evidence file that made the ancestor a candidate, and the binary it
    // would really run, both named.
    assert.equal(status.editorSlot.notes.length, 2);
    for (const fragment of [
      `${monorepo} (pnpm-workspace.yaml)`,
      competing,
      "does not understand .tsrx",
    ]) {
      assert.ok(status.editorSlot.notes[0].includes(fragment), fragment);
    }
    assert.match(
      status.editorSlot.notes[1],
      new RegExp(
        `open ${escapeForRegExp(nested.project)} as the folder in your editor, or - from ${escapeForRegExp(nested.project)} - run npx oxc-tsrx setup --workspace-root <folder>`,
        "u",
      ),
    );
    const report = formatCompatibilityReport(status);
    assert.match(report, /oxc\.path\.oxlint:\s+inert \(editor\)/u);
    for (const fragment of [monorepo, "pnpm-workspace.yaml", "--workspace-root"]) {
      assert.ok(report.includes(fragment), `${fragment} is missing from:\n${report}`);
    }

    // This package's own oracle, asked the same tree the way the extension asks
    // it. `status` used to contradict this answer; now it reports it.
    const oracle = await resolveEditorLinter({
      name: "oxlint",
      configured: null,
      workspaceFolders: [monorepo],
      packageJsonDirectories: [nested.project],
      stat: async (candidate) => {
        const real = await realpath(candidate).catch(() => null);
        if (!real) return null;
        return {
          realPath: real,
          content: candidate.endsWith("package.json")
            ? await readFile(candidate, "utf8").catch(() => null)
            : null,
        };
      },
    });
    assert.equal(oracle.path, competing);
    assert.equal(oracle.tsrxAware, false);
    assert.equal(status.editorSlot.reach.autoDetection.at(-1).path, oracle.path);

    // `setup` on its own still writes nothing: a key at the project root would
    // not change which linter that other folder finds.
    const unwritten = await setupCompatibility(options);
    assert.equal(unwritten.editorSlot.state, "inert");
    assert.equal(unwritten.changed.includes("oxc.path.oxlint"), false);
    assert.equal((await readdir(nested.project)).includes(".vscode"), false);

    // The second remedy the note prints has to be a real one. Naming the folder
    // writes the key into it, and only then is the slot wired.
    const wired = await setupCompatibility({ ...options, workspaceRoot: monorepo });
    assert.equal(wired.changed.includes("oxc.path.oxlint"), true);
    assert.deepEqual(JSON.parse(await readFile(join(monorepo, ".vscode/settings.json"), "utf8")), {
      "oxc.path.oxlint": "packages/app/node_modules/@tsrx/oxc/bin/oxlint",
    });
    assert.equal(wired.editorSlot.state, "active");
    assert.equal(wired.editorSlot.settingsRoot, monorepo);

    // And `remove` follows the receipt back up to it, with no flag repeated.
    const removed = await removeCompatibility(options);
    assert.equal(removed.removed.includes("oxc.path.oxlint"), true);
    assert.equal((await readdir(monorepo)).includes(".vscode"), false);

    // A slot that never wrote anything has nothing for `remove` to take back,
    // so it is not reported as removed either.
    const nothing = await removeCompatibility(options);
    assert.equal(nothing.editorSlot.state, "inert");
    assert.equal(nothing.removed.includes("oxc.path.oxlint"), false);

    // Owning `.bin/oxlint` does not make somebody else's key invisible either.
    // The editor runs what the key names, so it is a collision, not "no setting
    // needed".
    const opinionated = await providerFixture(temporary, "opinionated", { ownsLinterShim: true });
    await mkdir(join(opinionated.project, ".vscode"), { recursive: true });
    await writeFile(
      opinionated.settings,
      '{\n  "oxc.path.oxlint": "/opt/homebrew/bin/oxlint"\n}\n',
    );
    const collided = await compatibilityStatus({
      projectRoot: opinionated.project,
      platform: "linux",
    });
    assert.equal(collided.editorSlot.state, "collision");
    assert.equal(collided.editorSlot.currentValue, "/opt/homebrew/bin/oxlint");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

/**
 * A configured `oxc.path.oxlint` does not win the extension's lookup, it
 * replaces it: `searchBinaryPath` is `e ? se(t,e) : ...`, with no fallback. So a
 * value the extension refuses is worse than no value at all, and a slot that
 * reports it active is the worst outcome of the three.
 */
test("status refuses to call a key active when the extension would refuse the value", async () => {
  const { compatibilityStatus, formatCompatibilityReport, setupCompatibility } = await import(
    pathToFileURL(join(packageRoot, "dist/compat.js"))
  );
  const temporary = await temporaryDirectory("oxc-tsrx-editor-unresolvable-");
  try {
    // A value that points at exactly the right file and still never reaches a
    // linter, because `T()` rejects any value containing "..".
    const traversal = await providerFixture(temporary, "traversal", { ownsLinterShim: false });
    await mkdir(join(traversal.project, ".vscode"), { recursive: true });
    await writeFile(
      traversal.settings,
      '{\n  "oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/../bin/oxlint"\n}\n',
    );
    const rejected = await compatibilityStatus({
      projectRoot: traversal.project,
      platform: "linux",
    });
    assert.equal(rejected.editorSlot.state, "unresolvable");
    assert.equal(rejected.editorSlot.reach.rejection, "configured-rejected-traversal");
    assert.match(rejected.editorSlot.notes[0], /refuses any "oxc\.path\.oxlint" containing/u);
    assert.ok(formatCompatibilityReport(rejected).includes("unresolvable (editor)"));

    // The same again for the shell metacharacters, which reject a value that
    // resolves to a real, correct, executable file.
    const metacharacter = await providerFixture(temporary, "metacharacter", {
      ownsLinterShim: false,
    });
    await writeFile(join(metacharacter.modules, "@tsrx/oxc", "bin", "oxlint!"), "#!/bin/sh\n");
    await mkdir(join(metacharacter.project, ".vscode"), { recursive: true });
    await writeFile(
      metacharacter.settings,
      '{\n  "oxc.path.oxlint": "node_modules/@tsrx/oxc/bin/oxlint!"\n}\n',
    );
    const refused = await compatibilityStatus({
      projectRoot: metacharacter.project,
      platform: "linux",
    });
    assert.equal(refused.editorSlot.state, "unresolvable");
    assert.equal(refused.editorSlot.reach.rejection, "configured-rejected-metacharacter");

    // N1, asserted from any machine: on Windows the value this package writes is
    // extensionless with a native loader, and the extension spawns that through
    // cmd.exe, which cannot execute it.
    const windows = await providerFixture(temporary, "windows", { ownsLinterShim: false });
    const onWindows = await setupCompatibility({
      projectRoot: windows.project,
      platform: "win32",
    });
    assert.equal(onWindows.changed.includes("oxc.path.oxlint"), true);
    assert.equal(onWindows.editorSlot.state, "unresolvable");
    assert.equal(onWindows.editorSlot.reach.resolution.reason, "resolved");
    assert.equal(onWindows.editorSlot.reach.resolution.loader, "native");
    assert.equal(onWindows.editorSlot.reach.resolution.spawnable, false);
    assert.match(onWindows.editorSlot.notes[0], /cmd\.exe/u);
    assert.match(onWindows.editorSlot.notes[0], /"oxc\.useExecPath": true/u);

    // The identical tree, judged for a platform that can spawn it, is active.
    // Nothing about the file changed: only the question being asked.
    const elsewhere = await compatibilityStatus({
      projectRoot: windows.project,
      platform: "linux",
    });
    assert.equal(elsewhere.editorSlot.state, "active");
    assert.deepEqual(elsewhere.editorSlot.notes, []);

    // And a value this package wrote whose target has gone is still not active.
    await rm(join(windows.modules, "@tsrx/oxc", "bin", "oxlint"), { force: true });
    const gone = await compatibilityStatus({ projectRoot: windows.project, platform: "linux" });
    assert.equal(gone.editorSlot.state, "stale");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// `setup` reports the missing tsconfig entry and refuses to write it. That is
// still true without `--write-tsconfig`, and the flag is the single opt-in that
// changes it. A tsconfig is the user's file and a scaffold's carries comments,
// so the edit is held to the same standard as the settings file: splice one
// entry in by byte offset, leave every other byte alone, and refuse rather than
// guess whenever the shape is not the one this knows how to edit.
test("setup writes the tsconfig plugin entry only when asked, and never guesses", async () => {
  const { setupCompatibility } = await import(pathToFileURL(join(packageRoot, "dist/compat.js")));
  const temporary = await temporaryDirectory("oxc-tsrx-write-tsconfig-");
  const authored = [
    "{",
    "  // Scaffolds ship comments, and JSON.parse refuses them.",
    '  "compilerOptions": {',
    '    "target": "es2023",',
    "    /* kept verbatim */",
    '    "strict": true',
    "  },",
    '  "include": ["src"]',
    "}",
    "",
  ].join("\n");
  const fixture = async (name, text) => {
    const created = await providerFixture(temporary, name, { ownsLinterShim: true });
    const tsconfig = join(created.project, "tsconfig.json");
    await writeFile(tsconfig, text);
    return { ...created, tsconfig };
  };
  try {
    // Without the flag nothing is touched, and the report still says so.
    const untouched = await fixture("untouched", authored);
    const reported = await setupCompatibility({ projectRoot: untouched.project });
    assert.equal(reported.tsconfigWrite, undefined);
    assert.equal(await readFile(untouched.tsconfig, "utf8"), authored);
    assert.ok(
      reported.languageSupport.notes.some((note) => note.includes("--write-tsconfig")),
      "the report should name the flag that would do it for you",
    );

    // With it, the entry lands under compilerOptions and every comment lives.
    const written = await fixture("written", authored);
    const result = await setupCompatibility({
      projectRoot: written.project,
      writeTsconfig: true,
    });
    assert.equal(result.tsconfigWrite.state, "written");
    assert.equal(result.tsconfigWrite.path, written.tsconfig);
    const after = await readFile(written.tsconfig, "utf8");
    assert.match(after, /"plugins": \[\{ "name": "@tsrx\/typescript-plugin" \}\]/u);
    for (const preserved of [
      "// Scaffolds ship comments, and JSON.parse refuses them.",
      "/* kept verbatim */",
      '"strict": true',
      '"include": ["src"]',
    ]) {
      assert.ok(after.includes(preserved), preserved);
    }
    // It parses, and it declares exactly one plugin.
    const parsed = JSON.parse(after.replaceAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""));
    assert.deepEqual(parsed.compilerOptions.plugins, [{ name: "@tsrx/typescript-plugin" }]);
    assert.equal(parsed.compilerOptions.strict, true);

    // Twice is a no-op rather than a second entry.
    const again = await setupCompatibility({
      projectRoot: written.project,
      writeTsconfig: true,
    });
    assert.equal(again.tsconfigWrite.state, "present");
    assert.equal(await readFile(written.tsconfig, "utf8"), after);

    // A dry run reports the file it would edit and writes nothing.
    const preview = await fixture("preview", authored);
    const previewed = await setupCompatibility({
      projectRoot: preview.project,
      writeTsconfig: true,
      dryRun: true,
    });
    assert.equal(previewed.tsconfigWrite.state, "preview");
    assert.equal(await readFile(preview.tsconfig, "utf8"), authored);

    // Somebody else's plugins list is not appended to blind. It refuses and
    // says what to add, the way a taken package slot does.
    const taken = await fixture(
      "taken",
      '{\n  "compilerOptions": {\n    "plugins": [{ "name": "typescript-styled-plugin" }]\n  }\n}\n',
    );
    await assert.rejects(
      setupCompatibility({ projectRoot: taken.project, writeTsconfig: true }),
      /"compilerOptions\.plugins" already exists/u,
    );
    assert.ok((await readFile(taken.tsconfig, "utf8")).includes("typescript-styled-plugin"));

    // A shape it cannot edit is refused rather than rewritten.
    const opaque = await fixture("opaque", '{\n  "include": ["src"]\n}\n');
    await assert.rejects(
      setupCompatibility({ projectRoot: opaque.project, writeTsconfig: true }),
      /"compilerOptions" object could not be located/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("setup reports the TSRX editor prerequisites it deliberately does not own", async () => {
  const { setupCompatibility } = await import(pathToFileURL(join(packageRoot, "dist/compat.js")));
  const temporary = await temporaryDirectory("oxc-tsrx-editor-support-");
  try {
    // `.tsrx` as a language belongs to the TSRX toolchain, so none of this is
    // installed, edited, or configured here. It is still detected, because a
    // green bridge plus a dead editor otherwise leaves a user no way to tell
    // which half is missing.
    const bare = await providerFixture(temporary, "bare", { ownsLinterShim: false });
    const missing = await setupCompatibility({ projectRoot: bare.project });
    const support = missing.languageSupport;
    assert.equal(support.ok, false);
    assert.equal(support.typescriptPlugin.present, false);
    assert.equal(support.frameworkBinding.present, false);
    assert.equal(support.tsconfig.path, null);
    assert.equal(support.typescript.requirement, ">=5.9 <6");
    assert.equal(support.notes.length, 4, support.notes.join("\n"));
    for (const expected of [
      /@tsrx\/typescript-plugin/u,
      /@tsrx\/react.*octane/u,
      /tsconfig\.json/u,
      /typescript/u,
    ]) {
      assert.ok(support.notes.some((note) => expected.test(note)), String(expected));
    }

    // `vp create` scaffolds TypeScript 6 while the plugin declares ^5.9.3, so a
    // stock project sits outside the supported range. A stock scaffold on 6.0.3
    // was measured answering correctly three times out of three, so the note
    // must report an unsupported combination and must NOT claim a failure.
    // Everything else present, that one line is still reported, and the version
    // on disk is not changed.
    const scaffolded = await providerFixture(temporary, "scaffolded", {
      ownsLinterShim: false,
    });
    await writePackage(
      join(scaffolded.modules, "@tsrx", "typescript-plugin"),
      { name: "@tsrx/typescript-plugin", version: "0.4.0" },
      {},
    );
    await writePackage(join(scaffolded.modules, "@tsrx", "react"), {
      name: "@tsrx/react",
      version: "0.9.0",
    }, {});
    await writePackage(join(scaffolded.modules, "typescript"), {
      name: "typescript",
      version: "6.0.3",
    }, {});
    const tsconfig = join(scaffolded.project, "tsconfig.json");
    const authoredTsconfig = [
      "{",
      '  "compilerOptions": {',
      "    // the TSRX language service",
      '    "plugins": [{ "name": "@tsrx/typescript-plugin" }],',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(tsconfig, authoredTsconfig);
    const trapped = await setupCompatibility({ projectRoot: scaffolded.project });
    assert.equal(trapped.languageSupport.typescriptPlugin.present, true);
    assert.equal(trapped.languageSupport.frameworkBinding.name, "@tsrx/react");
    assert.equal(trapped.languageSupport.tsconfig.declaresPlugin, true);
    assert.equal(trapped.languageSupport.typescript.version, "6.0.3");
    assert.equal(trapped.languageSupport.typescript.supported, false);
    assert.equal(trapped.languageSupport.notes.length, 1);
    const [typescriptNote] = trapped.languageSupport.notes;
    assert.match(typescriptNote, /outside .*declared peer range/u);
    assert.match(typescriptNote, /6\.0\.3/u);
    assert.match(typescriptNote, /may still work/u);
    // The wording must not assert a failure this project has not reproduced.
    assert.doesNotMatch(typescriptNote, /hangs|broken|fails/iu);
    assert.equal(await readFile(tsconfig, "utf8"), authoredTsconfig);

    // The supported version, and the report goes quiet.
    await writeFile(
      join(scaffolded.modules, "typescript", "package.json"),
      `${JSON.stringify({ name: "typescript", version: "5.9.3" }, null, 2)}\n`,
    );
    const ready = await setupCompatibility({ projectRoot: scaffolded.project });
    assert.deepEqual(ready.languageSupport.notes, []);
    assert.equal(ready.languageSupport.ok, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  nativePackageName,
  nativeTargetForHost,
} from "../../packages/toolchain/dist/native-targets.js";
import { resolveNpmInvocation } from "../helpers/npm-invocation.mjs";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";
import { scriptNode } from "../helpers/script-node.mjs";
import { temporaryDirectory } from "../packaging/temporary-directory.mjs";

const root = resolve(import.meta.dirname, "../..");

// pnpm does not hoist transitive dependencies to the repository root, so
// `<root>/node_modules/@oxc-project/types` does not exist here. Spawning npm
// with a cwd that is not there fails as `spawn npm ENOENT`, which reads like a
// missing npm rather than a missing directory. Resolve it from the workspace
// package that actually declares the dependency instead.
const typesDirectory = dirname(
  createRequire(import.meta.url).resolve("@oxc-project/types/package.json", {
    paths: [join(root, "packages/toolchain")],
  }),
);

function linuxLibc() {
  if (process.platform !== "linux") return undefined;
  return process.report?.getReport?.().header?.glibcVersionRuntime ? "glibc" : "musl";
}

function hostTarget() {
  return nativeTargetForHost(process.platform, process.arch, linuxLibc());
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
        else resolveRun({ stdout, stderr });
      },
    );
  });
}

// npm is reached the way the product reaches it: through the JavaScript entry
// its own manifest declares, run by Node. Naming `npm.cmd` on Windows is not
// only the shim this repository's boundary forbids, it cannot run at all, because
// Node refuses to spawn a `.cmd` file without `shell: true`. This suite spelled
// it that way and nothing noticed until the addon lanes first ran on a Windows
// runner and every npm call here died with `spawn EINVAL`.
function runNpm(args, options = {}) {
  const invocation = resolveNpmInvocation(args, {
    env: options.env ?? process.env,
    cwd: options.cwd ?? root,
  });
  return run(invocation.executable, invocation.args, options);
}

test("untouched packed parser and host-native tarballs load, parse, and preserve lazy identity", async () => {
  // Anchored on its real path, not on `os.tmpdir()`. Windows reports the 8.3
  // short form there (`C:\Users\RUNNER~1\...`), and the module resolver keeps
  // whatever spelling it is handed while `fs/promises.realpath` asks Windows
  // for the final name, so a fixture rooted on the short form makes the addon
  // this test expects and the addon the child reports two different strings for
  // the same file.
  const temporary = await temporaryDirectory("oxc-tsrx-parser-host-product-");
  try {
    const artifacts = join(temporary, "artifacts");
    const consumer = join(temporary, "consumer");
    const npmCache = join(temporary, "npm-cache");
    await Promise.all([mkdir(artifacts), mkdir(consumer), mkdir(npmCache)]);
    const npmEnvironment = {
      ...process.env,
      npm_config_cache: npmCache,
    };
    delete npmEnvironment.OXC_TSRX_PARSER_ADDON;

    const addon = join(temporary, "parser.node");
    await run(scriptNode(), [
    "scripts/build-parser-native.ts",
    "--skip-build",
    "--out",
    addon,
    ]);
    const nativePackage = JSON.parse(
    (
      await run(scriptNode(), [
        "scripts/package-native.ts",
        "--target",
        hostTarget().target,
        "--bin-dir",
        "target/release",
        "--parser-addon",
        addon,
        "--out-dir",
        artifacts,
      ])
    ).stdout,
    );
    const parserPack = parseNpmPackResponse(
    (
      await runNpm(
        ["pack", "--json", "--pack-destination", artifacts],
        { cwd: join(root, "packages/toolchain"), env: npmEnvironment },
      )
    ).stdout,
    );
    const parserTarball = join(artifacts, parserPack.filename);
    const typesPack = parseNpmPackResponse(
    (
      await runNpm(
        ["pack", "--json", "--pack-destination", artifacts],
        {
          cwd: typesDirectory,
          env: npmEnvironment,
        },
      )
    ).stdout,
    );
    const typesTarball = join(artifacts, typesPack.filename);

    await runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      parserTarball,
      nativePackage.tarball,
      typesTarball,
    ],
    { cwd: consumer, env: npmEnvironment },
    );

    const parserRoot = join(consumer, "node_modules", "@tsrx/oxc");
    const nativeRoot = join(
    consumer,
    "node_modules",
    ...nativePackageName(hostTarget()).split("/"),
    );
    const parserManifest = JSON.parse(await readFile(join(parserRoot, "package.json"), "utf8"));
    const nativeManifest = JSON.parse(await readFile(join(nativeRoot, "package.json"), "utf8"));
    assert.equal(parserManifest.version, nativeManifest.version);
    assert.equal(
    parserManifest.optionalDependencies[nativeManifest.name],
    nativeManifest.version,
    );

    const childSource = String.raw`
    import { createRequire } from "node:module";
    import { capabilities, parse, parseSync } from "@tsrx/oxc/parser";
    const require = createRequire(import.meta.url);
    const ordinary = parseSync("entry.tsx", "export const value = <main>{1n}</main>");
    const source = "function View() @{ @if(ok){<main/>}@else{<aside/>} }";
    const tsrx = parseSync("View.tsrx", source);
    const asyncResult = await parse("View.tsrx", source);
    const invalid = parseSync("Broken.tsrx", "function Broken() @{ @if(ok){");
    const descriptors = Object.fromEntries(
      ["program", "module", "comments", "errors"].map((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(tsrx, name);
        return [name, {
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
          getter: typeof descriptor.get,
          setter: descriptor.set,
          writable: Object.hasOwn(descriptor, "writable"),
        }];
      }),
    );
    const loadedAddons = Object.keys(require.cache).filter((path) => path.endsWith("parser.node"));
    process.stdout.write(JSON.stringify({
      capabilities,
      ordinary: {
        program: ordinary.program.type,
        bigint: typeof ordinary.program.body[0].declaration.declarations[0].init.children[0].expression.value,
        module: ordinary.module.hasModuleSyntax,
        comments: ordinary.comments.length,
        errors: ordinary.errors.length,
      },
      tsrx: {
        program: tsrx.program.type,
        sameProgram: tsrx.program === tsrx.program,
        sameModule: tsrx.module === tsrx.module,
        sameComments: tsrx.comments === tsrx.comments,
        sameErrors: tsrx.errors === tsrx.errors,
        errors: tsrx.errors.length,
      },
      async: {
        program: asyncResult.program.type,
        errors: asyncResult.errors.length,
      },
      invalid: {
        program: invalid.program,
        cachedNull: invalid.program === invalid.program,
        module: invalid.module,
        errors: invalid.errors.length,
      },
      descriptors,
      loadedAddons,
    }));
    `;
    const childEnvironment = { ...process.env };
    delete childEnvironment.OXC_TSRX_PARSER_ADDON;
    const observation = JSON.parse(
    (
      await run(process.execPath, ["--input-type=module", "-e", childSource], {
        cwd: consumer,
        env: childEnvironment,
      })
    ).stdout,
    );

    assert.deepEqual(observation.capabilities, {
    apiVersion: 1,
    languages: ["js", "jsx", "ts", "tsx", "dts", "tsrx"],
    target: hostTarget().target,
    nodeApi: 8,
    nodeEngine: "^20.19.0 || >=22.12.0",
    oxcRevision: "8e0ed2ebb96137fb1611cdbd5742d5cb46037d40",
    lazy: true,
    async: true,
    editorRecovery: true,
    cssMaterialization: false,
    rawTransfer: false,
    });
    assert.deepEqual(observation.ordinary, {
    program: "Program",
    bigint: "bigint",
    module: true,
    comments: 0,
    errors: 0,
    });
    assert.deepEqual(observation.tsrx, {
    program: "Program",
    sameProgram: true,
    sameModule: true,
    sameComments: true,
    sameErrors: true,
    errors: 0,
    });
    assert.deepEqual(observation.async, { program: "Program", errors: 0 });
    assert.equal(observation.invalid.program, null);
    assert.equal(observation.invalid.cachedNull, true);
    assert.equal(observation.invalid.module, null);
    assert.ok(observation.invalid.errors > 0);
    for (const descriptor of Object.values(observation.descriptors)) {
      assert.deepEqual(descriptor, {
      enumerable: true,
      configurable: true,
      getter: "function",
      writable: false,
      });
    }
    assert.deepEqual(observation.loadedAddons, [
      await realpath(join(nativeRoot, "parser.node")),
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  NATIVE_TARGETS,
  nativePackageName,
} from "../../packages/toolchain/dist/native-targets.js";
import {
  canRunCanonicalOxlint,
  parseOxlintInvocation,
  planCanonicalOxlintComposition,
} from "../../packages/toolchain/dist/lint-invocation.js";
import {
  canRunCanonicalOxfmt,
  parseOxfmtInvocation,
} from "../../packages/toolchain/dist/format-invocation.js";
import { resolvePackageBinary } from "../../packages/toolchain/dist/runtime.js";
import { temporaryDirectory } from "./temporary-directory.mjs";

const root = resolve(import.meta.dirname, "../..");

// The stock comparison binaries are the ones `packages/toolchain/bin/*` would
// delegate to, so they are resolved from that package's own manifest. pnpm
// installs them under `packages/toolchain/node_modules`, not at the repository
// root, and only the declaring package is entitled to see them.
const toolchainManifestUrl = pathToFileURL(join(root, "packages/toolchain/package.json")).href;
const stockOxlint = resolvePackageBinary("oxlint-current", "oxlint", toolchainManifestUrl);
const stockOxfmt = resolvePackageBinary("oxfmt-current", "oxfmt", toolchainManifestUrl);

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (status, signal) => {
      resolveRun({ status, signal, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

// Both routes are compared byte for byte, so every measured duration has to be
// normalised or the assertion becomes a race. `--format=json` reports
// `start_time`; the human-readable format reports `Finished in <n>ms`. Only the
// duration varies: the candidate and the stock binary run on the same machine,
// so file, rule, and thread counts already match.
function withoutRuntimeTiming(result) {
  return {
    ...result,
    stdout: result.stdout
      .replace(/"start_time":\s*[0-9.]+/u, '"start_time": <runtime>')
      .replace(/Finished in [0-9.]+(?:ms|s|m)\b/u, "Finished in <runtime>"),
  };
}

test("the toolchain owns one exact optional native package for every supported target", async () => {
  const toolchain = JSON.parse(
    await readFile(join(root, "packages/toolchain/package.json"), "utf8"),
  );
  const expected = Object.fromEntries(
    NATIVE_TARGETS.map((platform) => [nativePackageName(platform), toolchain.version]),
  );
  assert.deepEqual(toolchain.optionalDependencies, expected);
  assert.equal(toolchain.publishConfig.access, "public");
  assert.equal(toolchain.publishConfig.provenance, true);
  assert.ok(toolchain.files.includes("README.md"));
  assert.ok(toolchain.files.includes("THIRD_PARTY_NOTICES.md"));
});

test("the platform matrix is unique and covers the eight launch targets", async () => {
  assert.equal(NATIVE_TARGETS.length, 8);
  for (const key of ["target", "packageSuffix", "vscodeTarget"]) {
    assert.equal(new Set(NATIVE_TARGETS.map((platform) => platform[key])).size, 8);
  }
  assert.deepEqual(
    new Set(NATIVE_TARGETS.map((platform) => platform.os)),
    new Set(["darwin", "linux", "win32"]),
  );
});

test("explicit ordinary files take the zero-wrapper canonical Oxlint route", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-ordinary-route-");
  const source = join(directory, "ordinary.tsx");
  const trace = join(directory, "trace.jsonl");
  const config = join(directory, "oxlint.config.mjs");
  const candidate = join(root, "packages/toolchain/bin/oxlint");
  const stock = stockOxlint;
  const environment = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    OXC_TSRX_TRACE_FILE: trace,
  };

  try {
    await writeFile(
      source,
      "export function View() { debugger; return <main>ordinary</main>; }\n",
    );
    await writeFile(config, 'export default { rules: { "no-debugger": "error" } };\n');
    for (const args of [
      ["--deny", "no-debugger", source],
      ["--format=json", "--deny", "no-debugger", source],
      ["--config", config, source],
      ["-Dno-debugger", "-fjson", source],
      [`-c${config}`, source],
    ]) {
      const [actual, expected] = await Promise.all([
        run(candidate, args, { env: environment }),
        run(stock, args, { env: environment }),
      ]);
      assert.deepEqual(
        withoutRuntimeTiming(actual),
        withoutRuntimeTiming(expected),
        args.join(" "),
      );
    }

    const candidateFix = join(directory, "candidate.ts");
    const stockFix = join(directory, "stock.ts");
    await Promise.all([
      writeFile(candidateFix, "export var answer = 42;\n"),
      writeFile(stockFix, "export var answer = 42;\n"),
    ]);
    const [actualFix, expectedFix] = await Promise.all([
      run(candidate, ["--fix", "--deny", "no-var", candidateFix], { env: environment }),
      run(stock, ["--fix", "--deny", "no-var", stockFix], { env: environment }),
    ]);
    assert.deepEqual(
      withoutRuntimeTiming(actualFix),
      withoutRuntimeTiming(expectedFix),
      "--fix process result",
    );
    assert.equal(await readFile(candidateFix, "utf8"), await readFile(stockFix, "utf8"));

    await assert.rejects(
      readFile(trace, "utf8"),
      (error) => error?.code === "ENOENT",
      "ordinary-only work must not enter the TSRX process-dispatch layer",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the canonical Oxlint router is conservative around ambiguous paths and options", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-route-contract-");
  const ordinary = join(directory, "ordinary.tsx");
  const disguisedDirectory = join(directory, "components.tsx");
  const nestedTsrx = join(disguisedDirectory, "View.tsrx");

  try {
    await writeFile(ordinary, "export const value = 1;\n");
    await mkdir(disguisedDirectory);
    await writeFile(nestedTsrx, "export function View() @{ <main />; }\n");

    assert.equal(
      canRunCanonicalOxlint(["--deny", "no-debugger", ordinary], directory),
      true,
    );
    assert.equal(
      canRunCanonicalOxlint(["-Dno-debugger", "-fjson", ordinary], directory),
      true,
    );
    assert.equal(
      canRunCanonicalOxlint(["-csettings.json", ordinary], directory),
      true,
    );
    assert.equal(canRunCanonicalOxlint([disguisedDirectory], directory), false);
    assert.equal(canRunCanonicalOxlint([nestedTsrx], directory), false);
    assert.equal(canRunCanonicalOxlint([join(directory, "missing.tsx")], directory), false);
    assert.equal(canRunCanonicalOxlint(["--future-option", ordinary], directory), false);
    assert.equal(canRunCanonicalOxlint(["--help"], directory), true);
    assert.deepEqual(
      planCanonicalOxlintComposition(
        ["-Dno-debugger", "-fjson", ordinary, nestedTsrx],
        directory,
      ),
      {
        args: ["-Dno-debugger", ordinary, "--format=json"],
        ordinaryFiles: 1,
        tsrxFiles: 1,
      },
    );
    assert.equal(
      planCanonicalOxlintComposition(["--fix", ordinary, nestedTsrx], directory),
      null,
    );
    assert.deepEqual(
      parseOxlintInvocation(["--config", "settings.mjs", "--", ordinary]).positionals,
      [ordinary],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical package binaries resolve from the manifest bin declaration", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-package-bin-");
  const packageRoot = join(directory, "node_modules", "mock-canonical-tool");
  const entry = join(directory, "consumer.mjs");
  const declaredBin = join(packageRoot, "commands", "canonical.js");

  try {
    await mkdir(join(packageRoot, "lib", "deep"), { recursive: true });
    await mkdir(join(packageRoot, "commands"), { recursive: true });
    await Promise.all([
      writeFile(entry, "export {};\n"),
      writeFile(join(packageRoot, "lib", "deep", "index.js"), "export {};\n"),
      writeFile(declaredBin, "#!/usr/bin/env node\n"),
      writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "mock-canonical-tool",
          type: "module",
          main: "./lib/deep/index.js",
          bin: { canonical: "./commands/canonical.js" },
        })}\n`,
      ),
    ]);

    assert.equal(
      resolvePackageBinary(
        "mock-canonical-tool",
        "canonical",
        pathToFileURL(entry).href,
      ),
      await realpath(declaredBin),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mixed routing does not depend on private Oxlint modules or descriptor capture", async () => {
  async function productionSources(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const pathname = join(directory, entry.name);
        if (entry.isDirectory()) return productionSources(pathname);
        if (entry.name.endsWith(".js") || !entry.name.includes(".")) return [pathname];
        return [];
      }),
    );
    return nested.flat();
  }

  const files = (
    await Promise.all(
      ["packages/toolchain/bin", "packages/toolchain/dist"].map((directory) =>
        productionSources(join(root, directory)),
      ),
    )
  ).flat();
  const requiredFiles = [
    "packages/toolchain/dist/runtime.js",
    "packages/toolchain/dist/process.js",
    "packages/toolchain/dist/package-binary.js",
    "packages/toolchain/bin/oxlint",
    "packages/toolchain/dist/bin/oxlint.js",
    "packages/toolchain/dist/lint-cli.js",
    "packages/toolchain/dist/lint-prestart.js",
    "packages/toolchain/dist/lint-invocation.js",
    "packages/toolchain/bin/oxfmt",
    "packages/toolchain/dist/bin/oxfmt.js",
    "packages/toolchain/dist/format-cli.js",
    "packages/toolchain/dist/format-invocation.js",
  ].map((pathname) => join(root, pathname));
  assert.ok(
    requiredFiles.every((pathname) => files.includes(pathname)),
    "required runtime and launcher entrypoints must remain in the scanned surface",
  );

  const forbidden = [
    /runOxlintInProcess/u,
    /bindings\.js/u,
    /(?:oxlint|oxfmt)-current\/(?:dist|lib|src|build|bindings)(?:\/|\.js)/u,
    /closeSync\s*\(\s*[12]\s*\)/u,
    /process\.(?:stdout|stderr)\.fd/u,
    /\/dev\/(?:fd|stdout|stderr)/u,
    /\/proc\/self\/fd/u,
    /\bdup2?(?:Sync)?\s*\(/u,
  ];
  const sources = new Map();
  for (const pathname of files) {
    const source = await readFile(pathname, "utf8");
    sources.set(pathname, source);
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${pathname}: ${pattern}`);
    }
  }

  // The lint lanes reach Oxlint through the canonical selector, which starts from
  // the `oxlint-current` pin and prefers the project's own Oxlint only when that
  // one is at least as new. The pin therefore still has to be the thing the
  // selector resolves, and it still has to be resolved as a declared npm binary.
  assert.match(
    sources.get(join(root, "packages/toolchain/dist/bin/oxlint.js")),
    /importCanonicalOxlint\(/u,
  );
  assert.match(
    sources.get(join(root, "packages/toolchain/dist/package-binary.js")),
    /resolvePackageBinary\("oxlint-current", "oxlint"/u,
  );
  assert.match(
    sources.get(join(root, "packages/toolchain/dist/bin/oxfmt.js")),
    /importDeclaredPackageBinary\("oxfmt-current", "oxfmt"/u,
  );
  const prestart = sources.get(join(root, "packages/toolchain/dist/lint-prestart.js"));
  assert.match(prestart, /resolveCanonicalOxlint\(/u);
  assert.match(prestart, /runCaptured\(process\.execPath/u);
  assert.match(
    sources.get(join(root, "packages/toolchain/dist/process.js")),
    /from "node:child_process"/u,
  );
});

test("ordinary Oxfmt stdin and explicit files take the zero-wrapper canonical route", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-ordinary-format-route-");
  const source = join(directory, "ordinary.tsx");
  const trace = join(directory, "trace.jsonl");
  const candidate = join(root, "packages/toolchain/bin/oxfmt");
  const stock = stockOxfmt;
  const environment = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    OXC_TSRX_TRACE_FILE: trace,
  };

  try {
    const unformatted = "export function View( ){return <main>ordinary</main>}\n";
    const [actualStdin, expectedStdin] = await Promise.all([
      run(candidate, ["--stdin-filepath=ordinary.tsx"], {
        cwd: directory,
        env: environment,
        input: unformatted,
      }),
      run(stock, ["--stdin-filepath=ordinary.tsx"], {
        cwd: directory,
        env: environment,
        input: unformatted,
      }),
    ]);
    assert.deepEqual(
      withoutRuntimeTiming(actualStdin),
      withoutRuntimeTiming(expectedStdin),
      "ordinary stdin",
    );

    await writeFile(source, unformatted);
    const [actualFile, expectedFile] = await Promise.all([
      run(candidate, ["--list-different", source], { env: environment }),
      run(stock, ["--list-different", source], { env: environment }),
    ]);
    assert.deepEqual(
      withoutRuntimeTiming(actualFile),
      withoutRuntimeTiming(expectedFile),
      "explicit ordinary file",
    );

    await assert.rejects(
      readFile(trace, "utf8"),
      (error) => error?.code === "ENOENT",
      "ordinary-only formatting must not enter the TSRX process-dispatch layer",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the canonical Oxfmt router keeps ambiguous and TSRX work in the bridge", async () => {
  const directory = await temporaryDirectory("oxc-tsrx-format-route-contract-");
  const ordinary = join(directory, "ordinary.tsx");
  const disguisedDirectory = join(directory, "format.tsx");
  const nestedTsrx = join(disguisedDirectory, "View.tsrx");

  try {
    await writeFile(ordinary, "export const value={answer:42};\n");
    await mkdir(disguisedDirectory);
    await writeFile(nestedTsrx, "export function View() @{ <main />; }\n");

    assert.equal(canRunCanonicalOxfmt(["--check", ordinary], directory), true);
    assert.equal(canRunCanonicalOxfmt(["-csettings.json", ordinary], directory), true);
    assert.equal(canRunCanonicalOxfmt([disguisedDirectory], directory), false);
    assert.equal(canRunCanonicalOxfmt([nestedTsrx], directory), false);
    assert.equal(canRunCanonicalOxfmt([join(directory, "*.tsx")], directory), false);
    assert.equal(canRunCanonicalOxfmt(["--future-option", ordinary], directory), false);
    assert.equal(canRunCanonicalOxfmt([], directory), false);
    assert.equal(
      canRunCanonicalOxfmt(["--stdin-filepath=ordinary.tsx"], directory),
      true,
    );
    assert.equal(
      canRunCanonicalOxfmt(["--stdin-filepath=View.tsrx"], directory),
      false,
    );
    assert.equal(canRunCanonicalOxfmt(["--version"], directory), true);
    assert.deepEqual(
      parseOxfmtInvocation(["--config", "settings.mjs", "--", ordinary]).positionals,
      [ordinary],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

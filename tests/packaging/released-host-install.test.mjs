import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import {
  resolveCommandInvocation,
  spawnCommand,
} from "../../packages/toolchain/dist/spawn-command.js";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";
import { scriptNode } from "../helpers/script-node.mjs";
import { startLocalRegistry } from "./local-registry.mjs";

/**
 * The path a real developer takes: `npm install @tsrx/oxc`, and nothing else.
 *
 * `provider-discovery.test.mjs` and the install-only VS Code session deliberately
 * delete `node_modules/.bin` and shadow `PATH`, because they isolate static
 * provider discovery from every other route. That isolation is exactly wrong for
 * the question this file asks. A developer does not delete `.bin`, and `.bin` is
 * how every released host actually reaches this package today: the installer
 * links `oxlint` and `oxfmt` there, and released `oxc.oxc-vscode` probes
 * `<folder>/node_modules/.bin/oxlint` before anything else.
 *
 * So here `.bin` stays, `PATH` is the ambient one, no `oxc-tsrx setup` runs, and
 * the assertions record what released hosts do — including the two things a
 * plain install must never do: change what the official `oxlint`/`oxfmt` a
 * project pinned does, and depend on which package won the `.bin` race.
 *
 * Measured limits this file pins deliberately, so a change to either is visible:
 *   - Vite+ 0.2.4 resolves the *package* named `oxlint`, which a bin cannot
 *     satisfy, so `vp lint` and `vp check` never see `.tsrx`. They keep working
 *     for ordinary files. Reaching `.tsrx` through Vite+ needs the
 *     `oxc-tsrx setup` compatibility bridge; nothing this package ships in an
 *     install can substitute for it.
 *   - A project that directly declares official `oxlint`/`oxfmt` gets that
 *     package for those command names, so `.tsrx` is not served through them.
 */

const root = resolve(import.meta.dirname, "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/** Public releases the collision cases pin, so the drift is a real one. */
const OFFICIAL_OXLINT = "1.72.0";
const OFFICIAL_OXFMT = "0.44.0";
const VITE_PLUS = "0.2.4";

function hostTarget() {
  if (process.platform === "darwin") {
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  }
  if (process.platform === "win32") {
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
  }
  if (process.platform === "linux" && ["arm64", "x64"].includes(process.arch)) {
    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
    return `${architecture}-unknown-linux-${libc}`;
  }
  throw new Error(`unsupported released-host install host ${process.platform}-${process.arch}`);
}

/**
 * The Windows half of this file is argued from source and proved by the
 * `install-arbitration` CI job, not by this machine. Everything below therefore
 * runs the same assertions on every host; nothing is skipped for `win32`.
 *
 * Three shapes differ and are handled rather than asserted away:
 *   - a package manager on PATH is `npm.cmd`, a batch launcher, so it goes
 *     through `resolveCommandInvocation`;
 *   - `node_modules/.bin/<name>` is a symlink on POSIX and a trio of generated
 *     shims (`<name>`, `<name>.cmd`, `<name>.ps1`) on Windows, so "which package
 *     won the link" is read from the shim rather than from `realpath`;
 *   - an extensionless Node script such as the official `oxlint/bin/oxlint`
 *     cannot be executed by `CreateProcess`, so it is run through Node.
 */
function run(executable, args, options = {}) {
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
 * NTSTATUS values a package-manager child has actually exited with on Windows.
 *
 * A process that dies this way reports the status itself as its exit code
 * instead of an ordinary small number, and prints nothing on the way out, so
 * the bare integer is the only evidence left in the log.
 */
const WINDOWS_FAST_FAIL_STATUS = new Map([
  [0xc0000005, "STATUS_ACCESS_VIOLATION"],
  [0xc000001d, "STATUS_ILLEGAL_INSTRUCTION"],
  [0xc00000fd, "STATUS_STACK_OVERFLOW"],
  [0xc0000142, "STATUS_DLL_INIT_FAILED"],
  [0xc0000374, "STATUS_HEAP_CORRUPTION"],
  [0xc0000409, "STATUS_STACK_BUFFER_OVERRUN"],
]);

/**
 * Name the exit status when Windows reports one of its own.
 *
 * `STATUS_STACK_BUFFER_OVERRUN` has been measured here at roughly one install
 * in thirty-five on `windows-2025`: the `npm` or `pnpm` process is fast-failed
 * before it finishes installing, on an idle machine with 13 GB of free memory
 * and 29 GB of free disk. It is not this project failing. Every install below
 * passes `--ignore-scripts`, so no code from this repository is loaded into
 * that process, and the same run leaves no Windows Error Reporting record, no
 * local crash dump, and no Node fatal-error report with all three armed.
 *
 * Nothing here tolerates the status: the assertion still fails on it. Naming
 * it only saves the next reader from having to rediscover which of the two
 * possible readings of a bare `3221226505` applies.
 */
function describeExitStatus(status, signal) {
  if (status === null) return `no exit code (signal ${signal})`;
  const name = WINDOWS_FAST_FAIL_STATUS.get(status >>> 0);
  if (name === undefined) return String(status);
  const hexadecimal = (status >>> 0).toString(16).padStart(8, "0");
  return `${status} (0x${hexadecimal} ${name}, a Windows fast-fail of the child's own process)`;
}

async function mustRun(executable, args, options = {}) {
  const result = await run(executable, args, options);
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(" ")} exited ${describeExitStatus(result.status, result.signal)}\n${result.stderr || result.stdout}`,
  );
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The names the installer actually writes for one linked command. On Windows
 * `npm` writes generated shims instead of a symlink, and only the `.cmd` one is
 * a launcher Windows can execute.
 */
function binNames(binary) {
  return process.platform === "win32"
    ? [binary, `${binary}.cmd`, `${binary}.ps1`]
    : [binary];
}

/** The executable form of `node_modules/.bin/<binary>` on this host. */
function binCommand(consumer, binary) {
  const shim = join(consumer, "node_modules/.bin", binary);
  return process.platform === "win32" ? `${shim}.cmd` : shim;
}

/**
 * The file `node_modules/.bin/<binary>` really runs — which is the whole point
 * of the collision assertions, since npm and pnpm disagree about who wins it.
 *
 * POSIX has a symlink to follow. Windows has no link at all: the generated
 * `.cmd` shim names its target relative to its own directory as `%dp0%\..\...`,
 * so the target is read out of the shim and confirmed to exist.
 */
async function binTarget(consumer, binary) {
  const binDirectory = join(consumer, "node_modules", ".bin");
  if (process.platform !== "win32") return realpath(join(binDirectory, binary));
  for (const shimName of [`${binary}.cmd`, binary]) {
    let shim;
    try {
      shim = await readFile(join(binDirectory, shimName), "utf8");
    } catch {
      continue;
    }
    for (const [, token] of shim.matchAll(/"(?:%dp0%|\$basedir)[\\/]([^"]+)"/gu)) {
      const candidate = resolve(binDirectory, token.replaceAll("\\", "/"));
      if (await exists(candidate)) return realpath(candidate);
    }
  }
  throw new Error(`node_modules/.bin/${binary} names no target this host can follow`);
}

/**
 * Windows cannot execute an extensionless file, and the official `oxlint` and
 * `oxfmt` packages both declare exactly that: a shebang Node script with no
 * extension. Running it through Node is what the launcher's in-process branch
 * does too, so the two sides of the byte-for-byte comparison stay comparable.
 */
function nodeScript(file, args) {
  return process.platform === "win32" && extname(file) === ""
    ? [process.execPath, [file, ...args]]
    : [file, args];
}

async function pack(packageRoot, artifacts, cache) {
  const result = await mustRun(
    npm,
    ["pack", "--json", "--pack-destination", artifacts, resolve(root, packageRoot)],
    { cwd: root, env: { ...process.env, npm_config_cache: cache } },
  );
  const packed = parseNpmPackResponse(result.stdout);
  return {
    ...packed,
    manifest: JSON.parse(await readFile(join(root, packageRoot, "package.json"), "utf8")),
    tarball: join(artifacts, packed.filename),
  };
}

/**
 * The ambient environment, minus this repository's own overrides. `PATH` is
 * deliberately the developer's own: shadowing it is what the discovery lanes do,
 * and doing it here would hide the route this file measures.
 */
function consumerEnvironment(consumer, registry) {
  const environment = {
    ...process.env,
    NO_COLOR: "1",
    npm_config_cache: join(consumer, ".npm-cache"),
    npm_config_registry: registry,
  };
  for (const key of Object.keys(environment)) {
    if (
      key === "NODE_PATH" ||
      key.startsWith("OXC_TSRX_") ||
      key.startsWith("OXLINT_TSGOLINT")
    ) {
      delete environment[key];
    }
  }
  // `process.env` is case-insensitive on Windows but the spread copy is not:
  // the search path arrives as `Path` there, so it is looked up by name.
  const searchPath = (candidates) =>
    candidates.find((key) => key.toLowerCase() === "path");
  const copied = searchPath(Object.keys(environment));
  assert.equal(
    copied === undefined ? undefined : environment[copied],
    process.env.PATH,
    "PATH must stay exactly as the developer has it",
  );
  return environment;
}

async function writeSources(consumer) {
  await Promise.all([
    writeFile(
      join(consumer, ".oxlintrc.json"),
      `${JSON.stringify({ rules: { "no-var": "error" } }, null, 2)}\n`,
    ),
    writeFile(
      join(consumer, ".oxfmtrc.json"),
      `${JSON.stringify({ singleQuote: true, semi: true }, null, 2)}\n`,
    ),
    writeFile(join(consumer, "View.tsrx"), `export function View( ) @{var count=0;<button>{count}</button>}`),
    writeFile(join(consumer, "ordinary.tsx"), `export var ordinary={value:1}\n`),
  ]);
}

/** One LSP `initialize` round trip against the exact command a host spawns. */
function initializeSession(command, args, options, { untilRegistration = false } = {}) {
  return new Promise((resolveSession, rejectSession) => {
    const child = spawnCommand(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    const messages = [];
    let buffer = Buffer.alloc(0);
    let stderr = "";
    let initialize = null;
    const finish = (error, value) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) rejectSession(error);
      else resolveSession(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`no LSP response from ${command}\n${stderr}`)),
      60_000,
    );
    const send = (message) => {
      const body = Buffer.from(JSON.stringify(message));
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    };
    child.on("error", (error) => finish(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const header = buffer.subarray(0, boundary).toString("ascii");
        const match = /content-length:\s*(\d+)/iu.exec(header);
        if (match === null) return finish(new Error(`bad LSP header: ${header}`));
        const start = boundary + 4;
        const end = start + Number(match[1]);
        if (buffer.length < end) return;
        const message = JSON.parse(buffer.subarray(start, end).toString("utf8"));
        buffer = buffer.subarray(end);
        messages.push(message);
        if (message.id === 1 && message.result !== undefined) {
          initialize = message.result;
          if (!untilRegistration) return finish(null, { initialize, messages, stderr });
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          continue;
        }
        if (untilRegistration && message.method === "client/registerCapability") {
          return finish(null, { initialize, registration: message, messages, stderr });
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: process.pid, rootUri: null, capabilities: {} },
    });
  });
}

/** Oxlint's JSON report carries a wall-clock field that is never equal twice. */
function withoutTiming(report) {
  return report.replaceAll(/"start_time":\s*[0-9.]+/gu, '"start_time":0');
}

test(
  "a plain install serves released hosts and changes nothing a project already pinned",
  { timeout: 1_800_000 },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), "oxc-tsrx-released-host-"));
    const artifacts = join(temporary, "artifacts");
    const cache = join(artifacts, ".npm-cache");
    let registry;
    context.after(async () => {
      await registry?.close();
      await rm(temporary, { recursive: true, force: true });
    });

    const nativeResult = await mustRun(
      scriptNode(),
      [
        "scripts/package-native.ts",
        "--allow-missing-parser-addon",
        "--target",
        hostTarget(),
        "--bin-dir",
        "target/release",
        "--out-dir",
        artifacts,
      ],
      { cwd: root, env: { ...process.env, npm_config_cache: cache } },
    );
    const native = JSON.parse(nativeResult.stdout);
    const packages = await Promise.all([pack("packages/toolchain", artifacts, cache)]);
    registry = await startLocalRegistry([
      ...packages,
      {
        manifest: { name: native.packageName, version: native.version },
        tarball: native.tarball,
        integrity: native.integrity,
        shasum: native.shasum,
      },
    ]);

    /** Install a consumer the ordinary way and leave everything else alone. */
    const install = async (name, dependencies, manager = "npm") => {
      const consumer = await mkdtemp(join(tmpdir(), `oxc-tsrx-${name}-`));
      await writeFile(
        join(consumer, "package.json"),
        `${JSON.stringify({ name: `oxc-tsrx-${name}`, private: true, type: "module", dependencies }, null, 2)}\n`,
      );
      const environment = consumerEnvironment(consumer, registry.url);
      if (manager === "npm") {
        await mustRun(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
          cwd: consumer,
          env: environment,
        });
      } else {
        await mustRun(pnpm, ["install", "--ignore-scripts", `--registry=${registry.url}`], {
          cwd: consumer,
          env: environment,
        });
      }
      await writeSources(consumer);
      context.after(() => rm(consumer, { recursive: true, force: true }));
      return {
        consumer,
        environment,
        bin: (binary) => binCommand(consumer, binary),
      };
    };

    await context.test(
      "the default install path: node_modules/.bin intact, PATH untouched, no setup",
      async () => {
        const { consumer, environment, bin } = await install("default", { "@tsrx/oxc": "0.8.0" });

        // Nothing ran but the install, so none of the compatibility bridge's
        // package-name facades can exist.
        for (const facade of ["oxlint", "oxfmt", "oxc-parser"]) {
          assert.equal(
            await exists(join(consumer, "node_modules", facade)),
            false,
            `${facade} exists without oxc-tsrx setup`,
          );
        }

        // The installer's own bin links are the whole mechanism, and they are
        // this package's launchers.
        const links = await readdir(join(consumer, "node_modules/.bin"));
        for (const binary of ["oxlint", "oxfmt", "oxc-tsrx", "oxc-tsrx-lint", "oxc-tsrx-fmt", "oxc-tsrx-lsp"]) {
          for (const name of binNames(binary)) {
            assert.equal(links.includes(name), true, `node_modules/.bin/${name} is missing`);
          }
          assert.equal(
            await binTarget(consumer, binary),
            await realpath(join(consumer, "node_modules/@tsrx/oxc/bin", binary)),
            binary,
          );
        }

        // `npx oxlint` over a mixed set: the authored TSRX file is parsed and
        // linted, and the ordinary file is linted exactly as before.
        const lint = await run(bin("oxlint"), ["--format=json", "View.tsrx", "ordinary.tsx"], {
          cwd: consumer,
          env: environment,
        });
        assert.equal(lint.status, 1, lint.stderr || lint.stdout);
        const report = JSON.parse(lint.stdout);
        assert.equal(report.oxcTsrx.parseCount, 1);
        assert.ok(report.diagnostics.some((entry) => entry.filename.endsWith("View.tsrx")));
        assert.ok(report.diagnostics.some((entry) => entry.filename.endsWith("ordinary.tsx")));

        // `npx oxfmt` over the same set: check, write, check.
        const before = await run(bin("oxfmt"), ["--check", "View.tsrx", "ordinary.tsx"], {
          cwd: consumer,
          env: environment,
        });
        assert.equal(before.status, 1, before.stderr || before.stdout);
        await mustRun(bin("oxfmt"), ["--write", "View.tsrx", "ordinary.tsx"], {
          cwd: consumer,
          env: environment,
        });
        await mustRun(bin("oxfmt"), ["--check", "View.tsrx", "ordinary.tsx"], {
          cwd: consumer,
          env: environment,
        });
        assert.match(await readFile(join(consumer, "View.tsrx"), "utf8"), /export function View\(\) @\{/u);

        // Released `oxc.oxc-vscode` 1.59.0 probes exactly this path first, then
        // spawns it with `--lsp`. Driving the same command proves the editor
        // route exists from the install alone: the session answers `initialize`,
        // and then registers `**/*.tsrx` as a routed document selector.
        const session = await initializeSession(
          bin("oxlint"),
          ["--lsp"],
          { cwd: consumer, env: environment },
          { untilRegistration: true },
        );
        assert.equal(session.initialize.serverInfo.name, "oxlint");
        const selectors = session.registration.params.registrations.map(
          (registration) => registration.registerOptions.documentSelector,
        );
        for (const selector of selectors) {
          assert.deepEqual(selector, [{ scheme: "file", pattern: "**/*.tsrx" }]);
        }

        // The install stayed an install: the bin directory was not consumed and
        // no manifest was rewritten.
        assert.equal(await exists(join(consumer, "node_modules/.bin/oxlint")), true);
        assert.deepEqual(
          JSON.parse(await readFile(join(consumer, "package.json"), "utf8")).dependencies,
          { "@tsrx/oxc": "0.8.0" },
        );
      },
    );

    await context.test(
      "Vite+ keeps working on ordinary files and still cannot see .tsrx",
      async () => {
        const { consumer, environment, bin } = await install("vite-plus", {
          "@tsrx/oxc": "0.8.0",
          "vite-plus": VITE_PLUS,
        });
        await writeFile(
          join(consumer, "vite.config.mjs"),
          `export default {\n  lint: { rules: { "no-var": "error" } },\n  fmt: { singleQuote: true, semi: true },\n};\n`,
        );

        // Vite+ resolves the *package* named `oxlint`. Its own dependency
        // supplies one, and a bin of that name cannot substitute for it.
        const resolved = JSON.parse(
          await readFile(join(consumer, "node_modules/oxlint/package.json"), "utf8"),
        );
        assert.equal(resolved.name, "oxlint");
        assert.equal(resolved.oxcTsrxCompatibility, undefined);

        const vpLint = await run(bin("vp"), ["lint", "View.tsrx", "ordinary.tsx"], {
          cwd: consumer,
          env: environment,
        });
        const vpLintOutput = vpLint.stdout + vpLint.stderr;
        assert.equal(vpLint.status, 1, vpLintOutput);
        assert.match(vpLintOutput, /ordinary\.tsx/u, "Vite+ must keep linting ordinary files");
        assert.doesNotMatch(
          vpLintOutput,
          /View\.tsrx/u,
          "measured limit: Vite+ 0.2.4 silently skips .tsrx without the compatibility bridge",
        );

        const vpCheck = await run(bin("vp"), ["check", "View.tsrx", "ordinary.tsx"], {
          cwd: consumer,
          env: environment,
        });
        const vpCheckOutput = vpCheck.stdout + vpCheck.stderr;
        assert.equal(vpCheck.status, 1, vpCheckOutput);
        assert.match(vpCheckOutput, /ordinary\.tsx/u);
        assert.doesNotMatch(vpCheckOutput, /View\.tsrx/u);

        // A transitive official `oxlint` is not a statement about the command
        // name, so `npx oxlint` in the same project still serves TSRX.
        assert.equal(
          await binTarget(consumer, "oxlint"),
          await realpath(join(consumer, "node_modules/@tsrx/oxc/bin/oxlint")),
        );
        const lint = await run(bin("oxlint"), ["--format=json", "View.tsrx", "ordinary.tsx"], {
          cwd: consumer,
          env: environment,
        });
        assert.equal(lint.status, 1, lint.stderr || lint.stdout);
        assert.ok(
          JSON.parse(lint.stdout).diagnostics.some((entry) => entry.filename.endsWith("View.tsrx")),
        );
      },
    );

    /**
     * The case that decides whether an install is safe: a project that already
     * pinned official Oxlint and Oxfmt. Whichever package the installer links
     * into `.bin`, the observable behaviour of those two command names must be
     * the pinned package's, unchanged.
     */
    const assertPinnedToolsUnchanged = async ({ consumer, environment, bin }, manager) => {
      const officialLint = join(consumer, "node_modules/oxlint/bin/oxlint");
      const officialFormat = join(consumer, "node_modules/oxfmt/bin/oxfmt");
      const runOfficial = (file, args, options) => run(...nodeScript(file, args), options);

      const lintVersion = await mustRun(bin("oxlint"), ["--version"], { cwd: consumer, env: environment });
      const formatVersion = await mustRun(bin("oxfmt"), ["--version"], { cwd: consumer, env: environment });
      assert.match(lintVersion.stdout, new RegExp(`\\b${OFFICIAL_OXLINT.replaceAll(".", "\\.")}\\b`, "u"), manager);
      assert.match(formatVersion.stdout, new RegExp(`\\b${OFFICIAL_OXFMT.replaceAll(".", "\\.")}\\b`, "u"), manager);

      // Byte-for-byte the pinned linter's own report, not merely a similar one.
      const viaCommand = await run(bin("oxlint"), ["--format=json", "ordinary.tsx"], {
        cwd: consumer,
        env: environment,
      });
      const viaPinned = await runOfficial(officialLint, ["--format=json", "ordinary.tsx"], {
        cwd: consumer,
        env: environment,
      });
      assert.equal(viaCommand.status, viaPinned.status, manager);
      assert.equal(withoutTiming(viaCommand.stdout), withoutTiming(viaPinned.stdout), manager);
      assert.equal(viaCommand.stderr, "", "an ordinary run must gain no new output");

      const formatViaCommand = await run(bin("oxfmt"), ["--check", "ordinary.tsx"], {
        cwd: consumer,
        env: environment,
      });
      const formatViaPinned = await runOfficial(officialFormat, ["--check", "ordinary.tsx"], {
        cwd: consumer,
        env: environment,
      });
      assert.equal(formatViaCommand.status, formatViaPinned.status, manager);
      assert.equal(formatViaCommand.stderr, "");

      // The editor route defers too: the same server, answering identically.
      const viaCommandSession = await initializeSession(bin("oxlint"), ["--lsp"], {
        cwd: consumer,
        env: environment,
      });
      const viaPinnedSession = await initializeSession(...nodeScript(officialLint, ["--lsp"]), {
        cwd: consumer,
        env: environment,
      });
      assert.deepEqual(viaCommandSession.initialize, viaPinnedSession.initialize, manager);

      // Asking those command names about a `.tsrx` file never lints it. When
      // this package's launcher is the one the installer linked, it says so and
      // names the command to run instead; when the pinned package holds the
      // link, the developer sees exactly the silence they had before.
      const launcherOwnsLink =
        (await binTarget(consumer, "oxlint")) ===
        (await realpath(join(consumer, "node_modules/@tsrx/oxc/bin/oxlint")));
      const provided = await run(bin("oxlint"), ["--format=json", "View.tsrx", "ordinary.tsx"], {
        cwd: consumer,
        env: environment,
      });
      if (launcherOwnsLink) {
        assert.match(provided.stderr, /View\.tsrx/u, manager);
        assert.match(provided.stderr, /npx oxc-tsrx-lint/u, manager);
      } else {
        assert.equal(provided.stderr, "", manager);
      }
      assert.equal(
        JSON.parse(provided.stdout).diagnostics.some((entry) => entry.filename.endsWith("View.tsrx")),
        false,
      );

      // TSRX itself is still one command away, under its own name.
      const leaf = await run(bin("oxc-tsrx-lint"), ["--format=json", "View.tsrx"], {
        cwd: consumer,
        env: environment,
      });
      assert.equal(leaf.status, 1, leaf.stderr || leaf.stdout);
      assert.ok(
        JSON.parse(leaf.stdout).diagnostics.some((entry) => entry.filename.endsWith("View.tsrx")),
      );

      // No node_modules slot was rewritten to make any of that true.
      for (const slot of ["oxlint", "oxfmt"]) {
        const manifest = JSON.parse(
          await readFile(join(consumer, "node_modules", slot, "package.json"), "utf8"),
        );
        assert.equal(manifest.oxcTsrxCompatibility, undefined, slot);
      }
      return launcherOwnsLink;
    };

    let npmWinner;
    await context.test("a project that also pins official oxlint and oxfmt keeps them", async () => {
      const consumer = await install("collision", {
        "@tsrx/oxc": "0.8.0",
        oxlint: OFFICIAL_OXLINT,
        oxfmt: OFFICIAL_OXFMT,
      });
      npmWinner = await assertPinnedToolsUnchanged(consumer, "npm");
    });

    await context.test(
      "pnpm links the other package into .bin and reaches the same answer",
      async (subtest) => {
        if (!available(pnpm)) {
          subtest.skip("pnpm is not installed");
          return;
        }
        const consumer = await install(
          "collision-pnpm",
          { "@tsrx/oxc": "0.8.0", oxlint: OFFICIAL_OXLINT, oxfmt: OFFICIAL_OXFMT },
          "pnpm",
        );
        const pnpmWinner = await assertPinnedToolsUnchanged(consumer, "pnpm");

        // The contrast that makes the assertions above worth making: the two
        // installers do not agree about who owns `node_modules/.bin/oxlint`, so
        // the behaviour cannot be allowed to follow from that link.
        assert.equal(npmWinner, true, "npm is expected to link this package's launcher");
        assert.equal(pnpmWinner, false, "pnpm is expected to link the official package");
      },
    );

    await context.test("a declared but uninstalled official package fails loudly", async () => {
      const { consumer, environment, bin } = await install("declared-missing", {
        "@tsrx/oxc": "0.8.0",
      });
      const manifest = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
      manifest.dependencies.oxlint = OFFICIAL_OXLINT;
      await writeFile(join(consumer, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      const result = await run(bin("oxlint"), ["--format=json", "ordinary.tsx"], {
        cwd: consumer,
        env: environment,
      });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.match(result.stderr, /declares the official oxlint package in dependencies/u);
      assert.match(result.stderr, /not installed/u);
      assert.equal(result.stdout, "", "a refusal must not look like a clean report");
    });
  },
);

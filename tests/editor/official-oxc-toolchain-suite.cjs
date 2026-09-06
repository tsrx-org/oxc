"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, lstatSync, readFileSync, realpathSync } = require("node:fs");
const nodePath = require("node:path");
const vscode = require("vscode");

/**
 * Several real VS Code sessions share this suite, selected by
 * `OXC_TSRX_SUITE_MODE`.
 *
 * - `compatibility` (default) is the long-standing proof: `oxc-tsrx setup` has
 *   run, the official extension finds `node_modules/.bin/oxlint`, and TSRX is
 *   served because this package owns the canonical `oxlint` bin name.
 * - `discovery` is the install-only proof: nothing but `npm install` ran, the
 *   whole of `node_modules/.bin` has been deleted, the compatibility facades
 *   `setup` writes are absent, and every tool name is shadowed on `PATH` by a
 *   decoy that records its own invocation. The TSRX language server can then
 *   only exist because the provider block in the installed package's own
 *   `package.json` was discovered and its declared `lsp` bin was started.
 * - `patched-host` is `discovery` again with no `oxc.path.*` at all and a
 *   locally patched upstream Oxlint in the tree.
 * - `setup-value` and `setup-value-untrusted` are the pair that runs the
 *   artifact a consumer actually gets: a synthetic Vite+ owns
 *   `node_modules/.bin/oxlint`, `oxc-tsrx setup` wrote the relative
 *   `oxc.path.oxlint` value itself, and the runner wrote no `oxc.path.*` and no
 *   `oxc.useExecPath` of its own.
 * - `direct-dependency` is `setup-value` with the real official Oxlint package
 *   declared by the project in place of the synthetic Vite+. It proves the same
 *   things and one more: ordinary TypeScript is served by a live `--lsp` process
 *   of the project's own Oxlint, the exact version it pinned, not by this
 *   package's pinned copy (tsrx-org/oxc#69).
 *
 * The compatibility path still ships and its assertions are unchanged.
 */

function diagnosticCode(diagnostic) {
  return String(
    typeof diagnostic.code === "object" ? diagnostic.code?.value : diagnostic.code,
  );
}

async function waitFor(read, predicate, label, timeout = 15000) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() - started >= timeout) {
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A labelled step reporter. The prefix names the lane so two different real
 * sessions can share this file without their transcripts becoming ambiguous.
 */
function createStep(prefix) {
  return async function step(label, operation) {
    process.stdout.write(`[${prefix}] START ${label}\n`);
    try {
      const result = await operation();
      process.stdout.write(`[${prefix}] PASS ${label}\n`);
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      throw new Error(`[${prefix}] FAIL ${label}\n${detail}`, { cause: error });
    }
  };
}

const step = createStep("official-toolchain");

async function assertOnlyTheOfficialExtension() {
  await step("use only the released official OXC extension", async () => {
    assert.equal(vscode.extensions.getExtension("thejackshelton.oxc-tsrx-vscode"), undefined);
    const extension = vscode.extensions.getExtension("oxc.oxc-vscode");
    assert.ok(extension, "the released official OXC extension is not loaded");
    assert.equal(extension.extensionPath, process.env.OXC_TSRX_EXPECTED_EXTENSION_PATH);
  });
}

async function runCompatibility() {
  await assertOnlyTheOfficialExtension();

  const ordinaryUri = vscode.Uri.file(process.env.OXC_TSRX_ORDINARY_EDITOR_FILE);
  const ordinary = await step("keep ordinary TypeScript on canonical Oxlint", async () => {
    const extension = vscode.extensions.getExtension("oxc.oxc-vscode");
    const document = await vscode.workspace.openTextDocument(ordinaryUri);
    await vscode.window.showTextDocument(document);
    await waitFor(() => extension.isActive, Boolean, "official extension activation");
    const diagnostics = await waitFor(
      () => vscode.languages.getDiagnostics(ordinaryUri),
      (items) =>
        items.some(
          (item) => item.source === "oxc" && diagnosticCode(item).includes("no-debugger"),
        ),
      "canonical ordinary-file diagnostic",
    );
    assert.equal(diagnostics.some((item) => item.source === "oxlint-tsrx"), false);
    return document;
  });
  assert.equal(ordinary.languageId, "typescript");

  const tsrxUri = vscode.Uri.file(process.env.OXC_TSRX_EDITOR_FILE);
  const tsrx = await step("publish native diagnostics for TSRX", async () => {
    const document = await vscode.workspace.openTextDocument(tsrxUri);
    await vscode.window.showTextDocument(document);
    const diagnostics = await waitFor(
      () => vscode.languages.getDiagnostics(tsrxUri),
      (items) =>
        items.some(
          (item) =>
            item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
        ) &&
        items.some(
          (item) =>
            item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-debugger"),
        ),
      "native TSRX diagnostics",
    );
    assert.equal(diagnostics.some((item) => item.source === "oxc"), false);
    return document;
  });

  await step("refresh TSRX diagnostics for an unsaved edit", async () => {
    const diagnostic = vscode.languages
      .getDiagnostics(tsrxUri)
      .find(
        (item) =>
          item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
      );
    assert.ok(diagnostic);
    const originalLine = diagnostic.range.start.line;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(tsrxUri, new vscode.Position(0, 0), "// unsaved editor change\n");
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor(
      () => vscode.languages.getDiagnostics(tsrxUri),
      (items) =>
        items.some(
          (item) =>
            item.source === "oxlint-tsrx" &&
            diagnosticCode(item).includes("no-var") &&
            item.range.start.line === originalLine + 1,
        ),
      "native diagnostics after an unsaved change",
    );
  });

  await step("format TSRX through the dynamically registered provider", async () => {
    const edits = await waitFor(
      () =>
        vscode.commands.executeCommand(
          "vscode.executeFormatDocumentProvider",
          tsrxUri,
          { tabSize: 2, insertSpaces: true },
        ),
      (items) => Array.isArray(items) && items.length > 0,
      "TSRX formatting edits",
    );
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(tsrxUri, edits);
    assert.equal(await vscode.workspace.applyEdit(workspaceEdit), true);
    await waitFor(
      () => tsrx.getText(),
      (text) =>
        text.includes("export function View() @{") &&
        text.includes("var count = 0;") &&
        text.includes("<button>{count}</button>;"),
      "formatted authored TSRX",
    );
  });

  await step("apply a native TSRX quick fix", async () => {
    const diagnostics = await waitFor(
      () => vscode.languages.getDiagnostics(tsrxUri),
      (items) =>
        items.find(
          (item) =>
            item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
      ),
      "no-var diagnostic after formatting",
    );
    const diagnostic = diagnostics.find(
      (item) =>
        item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
    );
    assert.ok(diagnostic);
    const actions = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      tsrxUri,
      diagnostic.range,
      "quickfix",
    );
    const action = actions.find((candidate) => /no-var/u.test(candidate.title));
    assert.ok(action?.edit, "the native TSRX server returned no no-var quick fix");
    assert.equal(await vscode.workspace.applyEdit(action.edit), true);
    await waitFor(
      () => tsrx.getText(),
      (text) => !text.includes("var count"),
      "applied no-var quick fix",
    );
    await waitFor(
      () => vscode.languages.getDiagnostics(tsrxUri),
      (items) =>
        !items.some(
          (item) =>
            item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
        ),
      "updated diagnostics after quick fix",
    );
    assert.equal(await tsrx.save(), true);
  });
}

/**
 * Every live process on this machine, with its parent, exactly as the operating
 * system reports it. Nothing about the language server is inferred from our own
 * bookkeeping: the evidence is the real process table.
 */
function processTable() {
  assert.notEqual(
    process.platform,
    "win32",
    "the discovery session reads the real process table and has no Windows probe yet",
  );
  const ps = "/bin/ps";
  assert.ok(existsSync(ps), `${ps} is required to inspect the real process table`);
  const output = execFileSync(ps, ["-axww", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const processes = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (match === null) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3].trim(),
    });
  }
  assert.ok(processes.length > 0, "the process table came back empty");
  return processes;
}

/**
 * A path plus the same path with every symlink resolved. A spawned process
 * reports whichever form the operating system handed it, and on macOS a
 * temporary directory is reached through `/var` but reported as `/private/var`.
 */
function pathVariants(target) {
  const variants = new Set([target]);
  try {
    variants.add(realpathSync.native(target));
  } catch {
    // A path that does not exist has no resolved form; the literal one stands.
  }
  // Longest first: `/private/var/...` and `/var/...` are both suffixes of the
  // same command line, and only the longer one identifies the whole path.
  return [...variants].sort((left, right) => right.length - left.length);
}

/**
 * The language server this workspace's provider declares, read from package
 * presence alone: the installed package's own `package.json`, its `oxc.provider`
 * block, and its `bin` map. No `.bin` directory, no `PATH`, no lookup by tool
 * name, no state written by any setup command.
 */
function declaredLanguageServer(root) {
  const packageRoot = nodePath.join(root, "node_modules", "@tsrx/oxc");
  const manifest = JSON.parse(
    readFileSync(nodePath.join(packageRoot, "package.json"), "utf8"),
  );
  const provider = manifest.oxc?.provider;
  assert.ok(provider, "the installed package declares no oxc.provider block");
  assert.equal(provider.protocol, 1);
  const language = (provider.languages ?? []).find((candidate) =>
    (candidate.extensions ?? []).includes(".tsrx"),
  );
  assert.ok(language, "no declared language claims .tsrx");
  const binName = language.capabilities?.lsp?.bin;
  assert.equal(typeof binName, "string");
  const declared = manifest.bin?.[binName];
  assert.equal(typeof declared, "string");
  const executable = nodePath.resolve(packageRoot, declared);
  assert.ok(
    executable.startsWith(`${packageRoot}${nodePath.sep}`),
    `the declared language server ${executable} escapes ${packageRoot}`,
  );
  assert.ok(existsSync(executable), `${executable} is not installed`);
  return { packageRoot, binName, executable, executables: pathVariants(executable) };
}

/**
 * The single live process that is the provider's declared language server.
 *
 * Waits for the real process table to contain it, requires that exactly one
 * process matches, requires the command line to end in the declared bin plus
 * `--stdio`, and requires the interpreter in front of it to be an absolute path
 * that exists. Nothing here is read from our own bookkeeping.
 */
async function liveLanguageServer(server, timeout = 30000) {
  const running = (entry) =>
    server.executables.some((candidate) => entry.command.includes(candidate));
  const table = await waitFor(
    () => processTable(),
    (processes) => processes.some(running),
    `a live ${server.executable} process`,
    timeout,
  );
  const matches = table.filter(running);
  assert.equal(
    matches.length,
    1,
    `expected exactly one live language server, saw ${JSON.stringify(matches)}`,
  );
  const [languageServer] = matches;
  const observed = server.executables.find((candidate) =>
    languageServer.command.endsWith(`${candidate} --stdio`),
  );
  assert.ok(observed, `unexpected language server command line: ${languageServer.command}`);
  const interpreter = languageServer.command.slice(
    0,
    languageServer.command.length - ` ${observed} --stdio`.length,
  );
  assert.ok(
    nodePath.isAbsolute(interpreter) && existsSync(interpreter),
    `the language server interpreter ${interpreter} is not an absolute existing path`,
  );
  return { table, languageServer, interpreter, observed };
}

/**
 * No live process anywhere on the machine was launched through this workspace's
 * `node_modules/.bin` or through the shadowed `PATH` directory, and no decoy
 * recorded being executed. This is what makes "discovery, not lookup by name"
 * falsifiable rather than asserted.
 */
function assertNoLookupPaths({ table, root, decoyDirectory, decoyMarker }) {
  const forbidden = [
    ...pathVariants(root).map(
      (candidate) => `${nodePath.join(candidate, "node_modules", ".bin")}${nodePath.sep}`,
    ),
    ...pathVariants(decoyDirectory).map((candidate) => `${candidate}${nodePath.sep}`),
  ];
  for (const entry of table) {
    for (const directory of forbidden) {
      assert.equal(
        entry.command.includes(directory),
        false,
        `a live process was launched through ${directory}: ${entry.command}`,
      );
    }
  }
  assert.equal(
    existsSync(decoyMarker),
    false,
    "a tool name was resolved from PATH during the discovery session",
  );
}

/**
 * The install-only path: an ordinary install and nothing else.
 *
 * The workspace has no `node_modules/.bin` at all, none of the compatibility
 * facades `oxc-tsrx setup` writes, and a `PATH` whose first entry shadows every
 * tool name with a decoy that records being run. If any of those had been the
 * route to the TSRX language server there would be no server; the server that
 * does exist is the one the provider block declares.
 */
/**
 * The host that started the language server, asserted against the process
 * table.
 *
 * In `discovery` mode that host is this repository's own general Oxlint
 * launcher, named by an absolute `oxc.path.oxlint` setting. In `patched-host`
 * mode it is upstream's own `oxlint` wrapper, carrying a locally built provider
 * patch, found by the released extension's ordinary resolution with no setting
 * of any kind — and this repository's launcher must then not appear anywhere in
 * the process table.
 */
function expectedHost(root, mode) {
  if (mode === "patched-host") {
    const declared = process.env.OXC_TSRX_EXPECTED_HOST_BIN;
    assert.equal(typeof declared, "string");
    return {
      bin: declared,
      forbidden: nodePath.join(root, "node_modules", "@tsrx/oxc", "bin", "oxlint"),
    };
  }
  return {
    bin: nodePath.join(root, "node_modules", "@tsrx/oxc", "bin", "oxlint"),
    forbidden: null,
  };
}

/**
 * The `oxlint` package this workspace resolves is upstream's host, not a facade
 * `oxc-tsrx setup` wrote and not a provider. Checked from the package itself.
 */
function assertUpstreamHostPackage(root) {
  const hostRoot = nodePath.join(root, "node_modules", "oxlint");
  const manifest = JSON.parse(readFileSync(nodePath.join(hostRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "oxlint");
  assert.equal(
    manifest.oxc?.provider,
    undefined,
    "the resolved host must not itself be a provider",
  );
  assert.equal(typeof manifest.bin?.oxlint, "string");
  const bin = nodePath.resolve(hostRoot, manifest.bin.oxlint);
  assert.ok(existsSync(bin), `${bin} is not installed`);
  assert.equal(
    /tsrx/iu.test(readFileSync(bin, "utf8")),
    false,
    "the host's own entry point names this repository's toolchain",
  );
  assert.equal(
    /tsrx/iu.test(JSON.stringify(manifest)),
    false,
    "the host's manifest names this repository's toolchain",
  );
  return { hostRoot, bin };
}

async function runDiscovery(mode = "discovery") {
  const root = process.env.OXC_TSRX_DISCOVERY_ROOT;
  const decoyDirectory = process.env.OXC_TSRX_PATH_DECOY_DIR;
  const decoyMarker = process.env.OXC_TSRX_PATH_DECOY_MARKER;
  assert.equal(typeof root, "string");
  assert.equal(typeof decoyDirectory, "string");
  assert.equal(typeof decoyMarker, "string");
  const host = expectedHost(root, mode);

  await assertOnlyTheOfficialExtension();

  await step("start from an install-only workspace", async () => {
    assert.equal(
      existsSync(nodePath.join(root, "node_modules", ".bin")),
      false,
      "node_modules/.bin must not exist in the discovery workspace",
    );
    // In `patched-host` mode `node_modules/oxlint` is upstream's own package, so
    // its presence is the point rather than a setup leftover. The other two
    // facades `setup` writes must still be absent.
    const facades =
      mode === "patched-host" ? ["oxfmt", "oxc-parser"] : ["oxlint", "oxfmt", "oxc-parser"];
    for (const facade of facades) {
      assert.equal(
        existsSync(nodePath.join(root, "node_modules", facade)),
        false,
        `${facade} is present, so oxc-tsrx setup ran in the discovery workspace`,
      );
    }
    const manifest = JSON.parse(
      readFileSync(nodePath.join(root, "package.json"), "utf8"),
    );
    // The runner names the manifest it wrote, so cutting a release cannot leave
    // this assertion pinned to a version nobody installs any more.
    assert.deepEqual(
      manifest.dependencies,
      JSON.parse(process.env.OXC_TSRX_EXPECTED_DEPENDENCIES),
    );
    assert.equal(manifest.scripts, undefined);
    const search = (process.env.PATH ?? "").split(nodePath.delimiter);
    assert.equal(
      search[0],
      decoyDirectory,
      "the decoy directory must shadow every tool name first on PATH",
    );
    assert.equal(search.includes(nodePath.join(root, "node_modules", ".bin")), false);
    for (const name of ["oxlint", "oxfmt", "oxc-tsrx", "oxc-tsrx-lsp"]) {
      assert.ok(
        existsSync(nodePath.join(decoyDirectory, name)),
        `${name} is not shadowed on PATH`,
      );
    }
    assert.equal(
      existsSync(decoyMarker),
      false,
      "a shadowed tool name was already executed from PATH",
    );
  });

  if (mode === "patched-host") {
    await step("locate the host with no oxc.path setting at all", async () => {
      const settings = JSON.parse(
        readFileSync(nodePath.join(root, ".vscode", "settings.json"), "utf8"),
      );
      const pointers = Object.keys(settings).filter((key) => key.startsWith("oxc.path"));
      assert.deepEqual(pointers, [], `the workspace still points the host at ${pointers}`);
      const { bin } = assertUpstreamHostPackage(root);
      // `/var` and `/private/var` name the same file on macOS, so every path
      // comparison here is made over the resolved variants rather than the
      // literal strings.
      const expected = new Set(pathVariants(host.bin));
      const sameFile = (candidate) =>
        pathVariants(candidate).some((variant) => expected.has(variant));
      assert.ok(sameFile(bin), `${bin} is not the declared host ${host.bin}`);
      // Exactly what the released extension's own resolution chain answers,
      // recomputed here from the workspace folder with the same call it makes.
      const resolved = nodePath.resolve(
        nodePath.dirname(require.resolve("oxlint/package.json", { paths: [root] })),
        "bin",
        "oxlint",
      );
      assert.ok(
        sameFile(resolved),
        `ordinary Node resolution answered ${resolved}, not the patched host`,
      );
    });
  }

  const server = await step(
    "resolve the language server from package presence alone",
    async () => declaredLanguageServer(root),
  );

  const ordinaryUri = vscode.Uri.file(process.env.OXC_TSRX_ORDINARY_EDITOR_FILE);
  await step("keep ordinary TypeScript on canonical Oxlint", async () => {
    const extension = vscode.extensions.getExtension("oxc.oxc-vscode");
    const document = await vscode.workspace.openTextDocument(ordinaryUri);
    await vscode.window.showTextDocument(document);
    await waitFor(() => extension.isActive, Boolean, "official extension activation");
    assert.equal(document.languageId, "typescript");
    const diagnostics = await waitFor(
      () => vscode.languages.getDiagnostics(ordinaryUri),
      (items) =>
        items.some(
          (item) => item.source === "oxc" && diagnosticCode(item).includes("no-debugger"),
        ),
      "canonical ordinary-file diagnostic",
      30000,
    );
    assert.equal(diagnostics.some((item) => item.source === "oxlint-tsrx"), false);
  });

  const tsrxUri = vscode.Uri.file(process.env.OXC_TSRX_EDITOR_FILE);
  const tsrx = await step(
    "publish native TSRX diagnostics through the discovered provider",
    async () => {
      const document = await vscode.workspace.openTextDocument(tsrxUri);
      await vscode.window.showTextDocument(document);
      const diagnostics = await waitFor(
        () => vscode.languages.getDiagnostics(tsrxUri),
        (items) =>
          items.some(
            (item) =>
              item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
          ) &&
          items.some(
            (item) =>
              item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-debugger"),
          ),
        "native TSRX diagnostics from the discovered provider",
        30000,
      );
      assert.equal(diagnostics.some((item) => item.source === "oxc"), false);
      return document;
    },
  );

  await step("run the provider's declared lsp bin as a real process", async () => {
    const { table, languageServer } = await liveLanguageServer(server);

    const parent = table.find((entry) => entry.pid === languageServer.ppid);
    assert.ok(parent, "the language server has no live parent process");
    const hosts = pathVariants(host.bin);
    assert.ok(
      hosts.some((candidate) => parent.command.includes(candidate)) &&
        parent.command.includes("--lsp"),
      `the language server was not started by the discovering host: ${parent.command}`,
    );

    // With a patched upstream host, nothing in this repository may take part in
    // locating or starting anything. The only TSRX process on the machine must
    // be the provider's own declared language server.
    if (host.forbidden !== null) {
      for (const candidate of pathVariants(host.forbidden)) {
        for (const entry of table) {
          assert.equal(
            entry.command.includes(candidate),
            false,
            `this repository's own Oxlint launcher took part: ${entry.command}`,
          );
        }
      }
    }

    assertNoLookupPaths({ table, root, decoyDirectory, decoyMarker });
  });

  await step("answer a real request from the discovered language server", async () => {
    const diagnostic = vscode.languages
      .getDiagnostics(tsrxUri)
      .find(
        (item) =>
          item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
      );
    assert.ok(diagnostic);
    const actions = await waitFor(
      () =>
        vscode.commands.executeCommand(
          "vscode.executeCodeActionProvider",
          tsrxUri,
          diagnostic.range,
          "quickfix",
        ),
      (items) => Array.isArray(items) && items.some((item) => /no-var/u.test(item.title)),
      "a quick fix from the discovered language server",
      30000,
    );
    const action = actions.find((candidate) => /no-var/u.test(candidate.title));
    assert.ok(action?.edit, "the discovered language server returned no no-var quick fix");
    assert.equal(await vscode.workspace.applyEdit(action.edit), true);
    await waitFor(
      () => tsrx.getText(),
      (text) => !text.includes("var count"),
      "applied no-var quick fix",
    );
    await waitFor(
      () => vscode.languages.getDiagnostics(tsrxUri),
      (items) =>
        !items.some(
          (item) =>
            item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
        ),
      "updated diagnostics after the quick fix",
    );
  });
}

/**
 * The value `oxc-tsrx setup` writes, read straight off disk. Nothing in this
 * lane may write `oxc.path.*`, so this is the artifact under test rather than a
 * fixture, and the assertions here describe it before anything is asked of it.
 */
function settingsUnderTest(root) {
  const expected = process.env.OXC_TSRX_EXPECTED_EDITOR_VALUE;
  assert.equal(typeof expected, "string");
  const settings = JSON.parse(
    readFileSync(nodePath.join(root, ".vscode", "settings.json"), "utf8"),
  );
  assert.equal(
    settings["oxc.path.oxlint"],
    expected,
    "the workspace does not carry the value setup writes",
  );
  assert.equal(
    nodePath.isAbsolute(expected),
    false,
    "the value under test must be the relative one, which the extension joins onto the first workspace folder",
  );
  assert.equal(
    Object.keys(settings).filter((key) => key.startsWith("oxc.path")).length,
    1,
    "setup writes exactly one path key, and this lane adds none",
  );
  assert.equal(
    "oxc.useExecPath" in settings,
    false,
    "oxc.useExecPath would route the value through the editor's own Node, which is the thing this lane must not lean on",
  );
  return { settings, expected };
}

/**
 * `node_modules/.bin/oxlint` does not belong to this package. Every other lane
 * either owns that name or deletes the directory; this one leaves a synthetic
 * Vite+ holding it, so the extension's own lookup would find a binary that
 * exits 3. Read here, inside the editor, rather than taken on trust from the
 * runner.
 */
function assertLinterShimIsNotOurs(root) {
  const provider = realpathSync(nodePath.join(root, "node_modules", "@tsrx/oxc"));
  const shim = nodePath.join(root, "node_modules", ".bin", "oxlint");
  assert.ok(existsSync(shim), "the collider did not take node_modules/.bin/oxlint");
  const info = lstatSync(shim);
  const target = info.isSymbolicLink() ? realpathSync(shim) : null;
  assert.equal(
    target !== null && target.startsWith(`${provider}${nodePath.sep}`),
    false,
    `node_modules/.bin/oxlint resolves into this package (${target}), so auto-detection would have found us anyway`,
  );
  if (info.isFile() && !info.isSymbolicLink()) {
    assert.equal(
      /@tsrx[\\/]oxc[\\/]bin[\\/]oxlint/u.test(readFileSync(shim, "utf8")),
      false,
      "node_modules/.bin/oxlint is a text shim naming this package, so auto-detection would have found us anyway",
    );
  }
  return { provider, shim };
}

/**
 * The setup-value lanes.
 *
 * `setup-value-untrusted` runs with the workspace-trust feature on and the
 * folder not trusted. `oxc.path.oxlint` is listed in the extension's
 * `capabilities.untrustedWorkspaces.restrictedConfigurations`, so VS Code must
 * drop the workspace value and hand the extension the default instead. That is
 * the whole of the lane: a written key is worth nothing in Restricted Mode, and
 * this measures it rather than reasoning about it.
 *
 * `setup-value` is the proof. The window is trusted, the extension sees the
 * relative value, and everything below is served by the file that value names:
 * ordinary TypeScript still on canonical Oxlint, native `.tsrx` diagnostics, a
 * live process started from the configured path, the dynamically registered
 * formatter, and a quick fix.
 */
async function runSetupValue(mode) {
  const root = process.env.OXC_TSRX_SETUP_VALUE_ROOT;
  assert.equal(typeof root, "string");
  const setupStep = createStep(mode);

  await assertOnlyTheOfficialExtension();
  const { expected } = settingsUnderTest(root);
  const configuredPath = nodePath.join(root, expected);
  const ordinaryUri = vscode.Uri.file(process.env.OXC_TSRX_ORDINARY_EDITOR_FILE);

  // The released extension activates on `onLanguage:typescript`, so nothing it
  // does can be observed until an ordinary TypeScript file is open.
  const ordinary = await setupStep("activate the released extension", async () => {
    const extension = vscode.extensions.getExtension("oxc.oxc-vscode");
    const document = await vscode.workspace.openTextDocument(ordinaryUri);
    await vscode.window.showTextDocument(document);
    assert.equal(document.languageId, "typescript");
    await waitFor(() => extension.isActive, Boolean, "official extension activation", 30000);
    return document;
  });
  assert.ok(ordinary);

  if (mode === "setup-value-untrusted") {
    await setupStep("keep the window in Restricted Mode", async () => {
      assert.equal(
        vscode.workspace.isTrusted,
        false,
        "this lane only means something in an untrusted window, and this one is trusted",
      );
    });
    await setupStep("drop the configured value the workspace carries", async () => {
      const visible = vscode.workspace.getConfiguration().get("oxc.path.oxlint");
      assert.notEqual(
        visible,
        expected,
        "an untrusted window handed the extension the workspace value, so restricted configurations are not being enforced",
      );
      process.stdout.write(
        `[${mode}] the extension sees ${JSON.stringify(visible)} while the workspace file says ${JSON.stringify(expected)}\n`,
      );
    });
    // The negative control for the trusted lane, run on the same workspace, the
    // same install and the same collider. With the key dropped the extension
    // falls back to its own lookup, that lookup finds the collider, and no
    // `.tsrx` diagnostic ever arrives. The trusted lane below gets them in
    // under a second, so a green pair says the key is what carries the wiring
    // rather than something else in the tree.
    await setupStep("publish no TSRX diagnostics while the key is dropped", async () => {
      const tsrxUri = vscode.Uri.file(process.env.OXC_TSRX_EDITOR_FILE);
      const document = await vscode.workspace.openTextDocument(tsrxUri);
      await vscode.window.showTextDocument(document);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const diagnostics = vscode.languages.getDiagnostics(tsrxUri);
        assert.equal(
          diagnostics.some((item) => item.source === "oxlint-tsrx"),
          false,
          `a dropped oxc.path.oxlint still produced TSRX diagnostics: ${JSON.stringify(diagnostics)}`,
        );
        await new Promise((settle) => setTimeout(settle, 250));
      }
    });
    return;
  }

  assert.ok(
    mode === "setup-value" || mode === "direct-dependency",
    `unknown setup-value mode ${mode}`,
  );

  await setupStep("read the value setup wrote, in a trusted window", async () => {
    assert.equal(vscode.workspace.isTrusted, true, "the window is not trusted");
    assert.equal(
      vscode.workspace.getConfiguration().get("oxc.path.oxlint"),
      expected,
      "the extension does not see the value setup wrote",
    );
    assert.ok(existsSync(configuredPath), `${configuredPath} is not installed`);
  });

  await setupStep("leave node_modules/.bin/oxlint to the collider", async () =>
    assertLinterShimIsNotOurs(root),
  );

  await setupStep("keep ordinary TypeScript on canonical Oxlint", async () => {
    const diagnostics = await waitFor(
      () => vscode.languages.getDiagnostics(ordinaryUri),
      (items) =>
        items.some(
          (item) => item.source === "oxc" && diagnosticCode(item).includes("no-debugger"),
        ),
      "canonical ordinary-file diagnostic",
      30000,
    );
    assert.equal(diagnostics.some((item) => item.source === "oxlint-tsrx"), false);
  });

  if (mode === "direct-dependency") {
    await setupStep("serve ordinary files through the project's own official Oxlint", async () => {
      const official = process.env.OXC_TSRX_EXPECTED_OFFICIAL_OXLINT;
      assert.equal(typeof official, "string");
      const candidates = pathVariants(official);
      const table = await waitFor(
        () => processTable(),
        (processes) =>
          processes.some(
            (entry) =>
              entry.command.includes("--lsp") &&
              candidates.some((candidate) => entry.command.includes(candidate)),
          ),
        `a live --lsp process of the project's official Oxlint at ${official}`,
        30000,
      );
      const upstream = table.find(
        (entry) =>
          entry.command.includes("--lsp") &&
          candidates.some((candidate) => entry.command.includes(candidate)),
      );
      process.stdout.write(`[${mode}] the multiplexer spawned ${upstream.command}\n`);
      // The pinned copy this package ships must not be the server for ordinary
      // files in this layout: the whole point is the version the project chose.
      const pinned = table.filter(
        (entry) =>
          entry.command.includes("--lsp") &&
          entry.command.includes(root) &&
          /oxlint-current/u.test(entry.command),
      );
      assert.deepEqual(
        pinned.map((entry) => entry.command),
        [],
        "this package's pinned Oxlint is serving ordinary files instead of the project's own",
      );
    });
  }

  const tsrxUri = vscode.Uri.file(process.env.OXC_TSRX_EDITOR_FILE);
  const tsrx = await setupStep("publish native TSRX diagnostics", async () => {
    const document = await vscode.workspace.openTextDocument(tsrxUri);
    await vscode.window.showTextDocument(document);
    const diagnostics = await waitFor(
      () => vscode.languages.getDiagnostics(tsrxUri),
      (items) =>
        items.some(
          (item) =>
            item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
        ) &&
        items.some(
          (item) =>
            item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-debugger"),
        ),
      "native TSRX diagnostics from the configured linter",
      30000,
    );
    assert.equal(diagnostics.some((item) => item.source === "oxc"), false);
    return document;
  });

  await setupStep("spawn the configured path itself, with no exec-path help", async () => {
    // The value is relative, `oxc.useExecPath` is absent, and the extension's
    // own loader rule calls a path ending `@tsrx/oxc/bin/oxlint` native, so this
    // is the file being executed directly rather than handed to a Node.
    const candidates = pathVariants(configuredPath);
    const table = await waitFor(
      () => processTable(),
      (processes) =>
        processes.some(
          (entry) =>
            entry.command.includes("--lsp") &&
            candidates.some((candidate) => entry.command.includes(candidate)),
        ),
      `a live ${configuredPath} --lsp process`,
      30000,
    );
    const host = table.find(
      (entry) =>
        entry.command.includes("--lsp") &&
        candidates.some((candidate) => entry.command.includes(candidate)),
    );
    process.stdout.write(`[${mode}] the editor spawned ${host.command}\n`);
  });

  await setupStep("format TSRX through the dynamically registered provider", async () => {
    const edits = await waitFor(
      () =>
        vscode.commands.executeCommand(
          "vscode.executeFormatDocumentProvider",
          tsrxUri,
          { tabSize: 2, insertSpaces: true },
        ),
      (items) => Array.isArray(items) && items.length > 0,
      "TSRX formatting edits",
      30000,
    );
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(tsrxUri, edits);
    assert.equal(await vscode.workspace.applyEdit(workspaceEdit), true);
    await waitFor(
      () => tsrx.getText(),
      (text) =>
        text.includes("export function View() @{") &&
        text.includes("var count = 0;") &&
        text.includes("<button>{count}</button>;"),
      "formatted authored TSRX",
    );
  });

  await setupStep("apply a native TSRX quick fix", async () => {
    const diagnostic = (
      await waitFor(
        () => vscode.languages.getDiagnostics(tsrxUri),
        (items) =>
          items.some(
            (item) =>
              item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
          ),
        "no-var diagnostic after formatting",
        30000,
      )
    ).find(
      (item) => item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
    );
    const actions = await waitFor(
      () =>
        vscode.commands.executeCommand(
          "vscode.executeCodeActionProvider",
          tsrxUri,
          diagnostic.range,
          "quickfix",
        ),
      (items) => Array.isArray(items) && items.some((item) => /no-var/u.test(item.title)),
      "a quick fix from the configured language server",
      30000,
    );
    const action = actions.find((candidate) => /no-var/u.test(candidate.title));
    assert.ok(action?.edit, "the configured language server returned no no-var quick fix");
    assert.equal(await vscode.workspace.applyEdit(action.edit), true);
    await waitFor(
      () => tsrx.getText(),
      (text) => !text.includes("var count"),
      "applied no-var quick fix",
    );
    await waitFor(
      () => vscode.languages.getDiagnostics(tsrxUri),
      (items) =>
        !items.some(
          (item) =>
            item.source === "oxlint-tsrx" && diagnosticCode(item).includes("no-var"),
        ),
      "updated diagnostics after the quick fix",
    );
  });
}

async function run() {
  const mode = process.env.OXC_TSRX_SUITE_MODE ?? "compatibility";
  if (mode === "discovery" || mode === "patched-host") return runDiscovery(mode);
  if (mode === "setup-value" || mode === "setup-value-untrusted" || mode === "direct-dependency") {
    return runSetupValue(mode);
  }
  assert.equal(mode, "compatibility", `unknown suite mode ${mode}`);
  return runCompatibility();
}

module.exports = {
  run,
  // Shared with `tests/editor/vscode-suite.cjs`, which runs the same
  // process-table probe against this repository's own VS Code client.
  assertNoLookupPaths,
  createStep,
  declaredLanguageServer,
  diagnosticCode,
  liveLanguageServer,
  pathVariants,
  processTable,
  waitFor,
};

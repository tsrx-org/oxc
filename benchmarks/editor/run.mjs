import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, release as osRelease, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { LspClient, pathToFileUri, SERVER_ARGUMENTS } from "../../tests/editor/lsp-client.mjs";

const root = resolve(import.meta.dirname, "../..");
const server = join(root, "target/release/oxc-tsrx");
const fixture = join(root, "tests/fixtures/editor/markless-arm-try-events.tsrx");
const budgets = JSON.parse(
  await readFile(join(root, "benchmarks/editor/budgets.json"), "utf8"),
);
const samplePolicy = {
  initialOpenWarmups: 20,
  initialOpenSamples: 100,
  editWarmups: 20,
  editSamples: 100,
  formatWarmups: 20,
  formatSamples: 100,
  codeActionWarmups: 20,
  codeActionSamples: 100,
  editSoak: 1_000,
};
const workspace = await mkdtemp(join(tmpdir(), "oxc-tsrx-editor-bench-"));
const sourcePath = join(workspace, "App.tsrx");
await cp(fixture, sourcePath);
await writeFile(
  join(workspace, ".oxlintrc.json"),
  `${JSON.stringify({ rules: { "no-debugger": "error", "no-var": "error" } })}\n`,
);
await writeFile(
  join(workspace, ".oxfmtrc.json"),
  `${JSON.stringify({ semi: true, singleQuote: true })}\n`,
);
await mkdir(join(workspace, ".vscode"), { recursive: true });

const retained = await readFile(sourcePath, "utf8");
const withDebugger = retained
  .replace(
    "export function App() @{",
    "export function App() @{\nvar editorProbe=0;\nvoid editorProbe;\ndebugger;",
  )
  .replace("let saved = state('none');", "let saved=state('none');");
const withoutDebugger = withDebugger.replace("debugger;", "void 0;");
await writeFile(sourcePath, withDebugger);
assert.ok(Buffer.byteLength(withDebugger) >= budgets.minimumSourceBytes);

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(values) {
  return {
    samples: values.length,
    rawMs: values,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function positionAt(source, offset) {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return {
    line: lines.length - 1,
    character: [...lines.at(-1)].reduce(
      (length, character) => length + character.length,
      0,
    ),
  };
}

function rssMiB(pid) {
  const kib = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
  assert.ok(Number.isFinite(kib));
  return kib / 1024;
}

const uri = pathToFileUri(sourcePath);
const rootUri = pathToFileUri(workspace);

async function measureInitialOpenOnce() {
  const probe = new LspClient(server, { args: SERVER_ARGUMENTS, cwd: workspace });
  const started = performance.now();
  try {
    await probe.initialize(rootUri);
    probe.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "markless-tsrx",
        version: 1,
        text: withDebugger,
      },
    });
    const diagnostics = await probe.waitFor(
      (message) => message.method === "textDocument/publishDiagnostics",
      5000,
      "benchmark repeated open diagnostics",
    );
    assert.ok(diagnostics.params.diagnostics.some((diagnostic) => diagnostic.code === "no-var"));
    return performance.now() - started;
  } finally {
    try {
      await probe.close();
    } finally {
      probe.terminate();
    }
  }
}

for (let index = 0; index < samplePolicy.initialOpenWarmups; index += 1) {
  await measureInitialOpenOnce();
}
const initialOpenMs = [];
for (let index = 0; index < samplePolicy.initialOpenSamples; index += 1) {
  initialOpenMs.push(await measureInitialOpenOnce());
}

const client = new LspClient(server, { args: SERVER_ARGUMENTS, cwd: workspace });
let version = 1;
let current = withDebugger;
try {
  const initialized = await client.initialize(rootUri);
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "markless-tsrx",
      version,
      text: current,
    },
  });
  const opened = await client.waitFor(
    (message) => message.method === "textDocument/publishDiagnostics",
    5000,
    "benchmark open diagnostics",
  );
  assert.ok(opened.params.diagnostics.some((diagnostic) => diagnostic.code === "no-var"));

  async function editOnce() {
    version += 1;
    current = current === withDebugger ? withoutDebugger : withDebugger;
    const started = performance.now();
    client.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: current }],
    });
    await client.waitFor(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        message.params.version === version,
      5000,
      `benchmark diagnostics version ${version}`,
    );
    return performance.now() - started;
  }

  for (let index = 0; index < samplePolicy.editWarmups; index += 1) await editOnce();
  const editMs = [];
  for (let index = 0; index < samplePolicy.editSamples; index += 1) editMs.push(await editOnce());

  const formatMs = [];
  for (let index = 0; index < samplePolicy.formatWarmups; index += 1) {
    await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
  }
  for (let index = 0; index < samplePolicy.formatSamples; index += 1) {
    const started = performance.now();
    const edits = await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.equal(edits.length, 1);
    formatMs.push(performance.now() - started);
  }

  const varOffset = current.indexOf("var editorProbe");
  const codeActionParams = {
    textDocument: { uri },
    range: {
      start: positionAt(current, varOffset),
      end: positionAt(current, varOffset + 3),
    },
    context: { diagnostics: [] },
  };
  for (let index = 0; index < samplePolicy.codeActionWarmups; index += 1) {
    await client.request("textDocument/codeAction", codeActionParams);
  }
  const actionMs = [];
  for (let index = 0; index < samplePolicy.codeActionSamples; index += 1) {
    const started = performance.now();
    const actions = await client.request("textDocument/codeAction", codeActionParams);
    assert.equal(actions.length, 1);
    actionMs.push(performance.now() - started);
  }

  const rssBeforeSoakMiB = rssMiB(client.pid);
  for (let index = 0; index < samplePolicy.editSoak; index += 1) await editOnce();
  const rssAfterSoakMiB = rssMiB(client.pid);
  const initialOpen = summarize(initialOpenMs);
  const report = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      osRelease: osRelease(),
    },
    build: {
      profile: "release",
      binary: "target/release/oxc-tsrx",
      oxcRevision: "5a6e37e5cf895143a5b34050c50109c46e2ae96a",
    },
    server: {
      binary: "target/release/oxc-tsrx",
      name: initialized.serverInfo?.name,
      version: initialized.serverInfo?.version,
      transport: "canonical OXC language server over stdio",
      sourceSync: "full document",
      processCount: 1,
      typeAware: false,
      typeCheck: false,
      typeProcessCount: 0,
      canonicalOxcRevision: "5a6e37e5cf895143a5b34050c50109c46e2ae96a",
      canonicalOxcLanguageServerVersion: "1.41.0",
    },
    corpus: {
      kind: "retained exact Markless arm/try fixture with disposable editor probes",
      bytes: Buffer.byteLength(withDebugger),
      sha256: createHash("sha256").update(withDebugger).digest("hex"),
      retainedFixtureSha256: createHash("sha256").update(retained).digest("hex"),
    },
    samplePolicy,
    initialOpen,
    initialOpenMs: initialOpen.p95Ms,
    editDiagnostics: summarize(editMs),
    formatting: summarize(formatMs),
    codeActions: summarize(actionMs),
    memory: {
      rssBeforeSoakMiB,
      rssAfterSoakMiB,
      growthMiB: rssAfterSoakMiB - rssBeforeSoakMiB,
    },
    budgets,
    assertions: {},
  };
  report.assertions = {
    initialOpen: report.initialOpen.p95Ms <= budgets.initialOpenMsMax,
    editDiagnosticsP95:
      report.editDiagnostics.p95Ms <= budgets.editDiagnosticsP95MsMax,
    formatP95: report.formatting.p95Ms <= budgets.formatP95MsMax,
    codeActionP95: report.codeActions.p95Ms <= budgets.codeActionP95MsMax,
    residentMemory: report.memory.rssAfterSoakMiB <= budgets.residentMemoryMiBMax,
    editSoakGrowth: report.memory.growthMiB <= budgets.editSoakGrowthMiBMax,
    sourceSize: report.corpus.bytes >= budgets.minimumSourceBytes,
    oneServerProcess: report.server.processCount === 1,
  };
  const output = join(root, `benchmarks/editor/results-${Date.now()}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...report }, null, 2));
  if (Object.values(report.assertions).some((passed) => !passed)) process.exitCode = 1;
  await client.close();
} finally {
  client.terminate();
  await rm(workspace, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createOxlintLspMultiplexer,
  isProviderDocumentMessage,
  providerLspSessions,
  readLspMessages,
  registrationRequest,
  runOxlintLspMultiplexer,
  writeLspMessage,
} from "../../packages/toolchain/dist/oxlint-lsp-multiplexer.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const toolchainRoot = join(repositoryRoot, "packages/toolchain");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    readLspMessages(this.stdin, (message) => this.messages.push(message));
  }
}

function providerEndpoint(id, extensions, starts) {
  return {
    id,
    extensions,
    start() {
      const child = new FakeChild();
      starts.push({ id, child });
      return child;
    },
  };
}

async function waitFor(read, predicate, label, timeout = 2000) {
  const started = Date.now();
  for (;;) {
    const value = read();
    const match = value.find(predicate);
    if (match !== undefined) return match;
    if (Date.now() - started >= timeout) {
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function harness(providers) {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const clientError = new PassThrough();
  const canonical = new FakeChild();
  const clientMessages = [];
  let errors = "";
  readLspMessages(clientOutput, (message) => clientMessages.push(message));
  clientError.setEncoding("utf8");
  clientError.on("data", (chunk) => (errors += chunk));
  const multiplexer = createOxlintLspMultiplexer({
    clientInput,
    clientOutput,
    clientError,
    canonical,
    providers,
  });
  return {
    multiplexer,
    canonical,
    clientMessages,
    clientInput,
    errors: () => errors,
    sendClient: (message) => writeLspMessage(clientInput, message),
    sendCanonical: (message) => writeLspMessage(canonical.stdout, message),
    close() {
      multiplexer.dispose();
      canonical.emit("close", 0, null);
      clientInput.end();
    },
  };
}

test("document routing follows the discovered extensions, not a fixed language", () => {
  const extensions = [".tsrx", ".demo"];
  assert.equal(
    isProviderDocumentMessage(
      {
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///tmp/View.TSRX" } },
      },
      extensions,
    ),
    true,
  );
  assert.equal(
    isProviderDocumentMessage(
      {
        method: "textDocument/formatting",
        params: { textDocument: { uri: "file:///tmp/a%20b/Widget.demo" } },
      },
      { ".demo": {} },
    ),
    true,
  );
  for (const uri of [
    "file:///tmp/View.tsx",
    "file:///tmp/main.ts",
    "file:///tmp/app.js",
    "file:///tmp/data.json",
  ]) {
    assert.equal(
      isProviderDocumentMessage(
        { method: "textDocument/didOpen", params: { textDocument: { uri } } },
        extensions,
      ),
      false,
      `${uri} must stay on canonical Oxlint`,
    );
  }
  assert.equal(
    isProviderDocumentMessage(
      { method: "workspace/executeCommand", params: { uri: "file:///tmp/View.tsrx" } },
      extensions,
    ),
    false,
  );
  assert.equal(isProviderDocumentMessage({ method: "textDocument/didOpen" }, extensions), false);
  assert.equal(
    isProviderDocumentMessage(
      { method: "textDocument/didOpen", params: { textDocument: { uri: "file:///a/View.tsrx" } } },
      [],
    ),
    false,
  );
});

test("the document selector is derived from the discovered extensions", () => {
  assert.deepEqual(
    registrationRequest([".tsrx", ".demo"]).params.registrations[0].registerOptions
      .documentSelector,
    [
      { scheme: "file", pattern: "**/*.demo" },
      { scheme: "file", pattern: "**/*.tsrx" },
    ],
  );
});

test("an empty index leaves the session a pure passthrough that spawns nothing", async () => {
  const harnessed = harness([]);
  const { sendClient, sendCanonical, canonical, clientMessages, multiplexer } = harnessed;

  sendClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
  await waitFor(() => canonical.messages, (message) => message.id === 1, "canonical initialize");
  sendCanonical({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "oxlint" } } });
  await waitFor(() => clientMessages, (message) => message.id === 1, "initialize response");
  sendClient({ jsonrpc: "2.0", method: "initialized", params: {} });
  await waitFor(
    () => canonical.messages,
    (message) => message.method === "initialized",
    "canonical initialized",
  );
  sendClient({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri: "file:///w/View.tsrx", version: 1, text: "" } },
  });
  await waitFor(
    () => canonical.messages,
    (message) => message.method === "textDocument/didOpen",
    "unclaimed document stays canonical",
  );

  assert.deepEqual(multiplexer.extensions, []);
  assert.deepEqual(multiplexer.startedProviders(), []);
  assert.equal(
    clientMessages.some((message) => message.method === "client/registerCapability"),
    false,
  );
  assert.equal(harnessed.errors(), "");
  harnessed.close();
});

test("a provider server starts only at the first document it claims", async () => {
  const starts = [];
  const harnessed = harness([providerEndpoint("demo", [".demo"], starts)]);
  const { sendClient, sendCanonical, canonical, clientMessages, multiplexer } = harnessed;

  sendClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
  await waitFor(() => canonical.messages, (message) => message.id === 1, "canonical initialize");
  sendCanonical({ jsonrpc: "2.0", id: 1, result: {} });
  sendClient({ jsonrpc: "2.0", method: "initialized", params: {} });
  const registration = await waitFor(
    () => clientMessages,
    (message) => message.method === "client/registerCapability",
    "eager registration",
  );
  sendClient({ jsonrpc: "2.0", id: registration.id, result: null });

  // A whole ordinary session: nothing the provider claims is ever opened.
  for (const uri of ["file:///w/main.ts", "file:///w/App.tsx", "file:///w/util.js"]) {
    sendClient({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, version: 1, text: "" } },
    });
  }
  sendClient({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///w/main.ts" }, options: {} },
  });
  await waitFor(() => canonical.messages, (message) => message.id === 2, "canonical formatting");
  assert.deepEqual(starts, []);
  assert.deepEqual(multiplexer.startedProviders(), []);

  sendClient({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri: "file:///w/Widget.demo", version: 1, text: "" } },
  });
  await waitFor(() => starts, () => true, "lazy provider spawn");
  assert.deepEqual(
    starts.map(({ id }) => id),
    ["demo"],
  );
  const provider = starts[0].child;
  const initialize = await waitFor(
    () => provider.messages,
    (message) => message.method === "initialize",
    "provider initialize",
  );
  assert.equal(initialize.id, "$/oxc-tsrx/provider/demo/initialize");
  assert.equal(
    provider.messages.some((message) => message.method === "textDocument/didOpen"),
    false,
    "documents wait until the provider finished initializing",
  );

  writeLspMessage(provider.stdout, {
    jsonrpc: "2.0",
    id: "$/oxc-tsrx/provider/demo/initialize",
    result: {},
  });
  await waitFor(
    () => provider.messages,
    (message) => message.method === "initialized",
    "provider initialized",
  );
  const opened = await waitFor(
    () => provider.messages,
    (message) => message.method === "textDocument/didOpen",
    "queued document flushed",
  );
  assert.equal(opened.params.textDocument.uri, "file:///w/Widget.demo");
  assert.equal(
    canonical.messages.some(
      (message) => message.params?.textDocument?.uri === "file:///w/Widget.demo",
    ),
    false,
  );
  assert.equal(
    provider.messages.some((message) => message.params?.textDocument?.uri?.endsWith(".ts")),
    false,
  );
  assert.deepEqual(multiplexer.startedProviders(), ["demo"]);
  assert.equal(harnessed.errors(), "");

  multiplexer.dispose();
  canonical.emit("close", 0, null);
  provider.emit("close", 0, null);
  harnessed.clientInput.end();
});

test("the multiplexer isolates traffic and request IDs across two providers", async () => {
  const starts = [];
  const harnessed = harness([
    providerEndpoint("alpha", [".alpha"], starts),
    providerEndpoint("beta", [".beta"], starts),
  ]);
  const { sendClient, sendCanonical, canonical, clientMessages, multiplexer } = harnessed;
  const alphaUri = "file:///workspace/View.alpha";
  const betaUri = "file:///workspace/View.beta";
  const tsUri = "file:///workspace/main.ts";

  assert.deepEqual(multiplexer.extensions, [".alpha", ".beta"]);

  sendClient({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { rootUri: "file:///workspace", capabilities: {} },
  });
  assert.equal(
    (
      await waitFor(
        () => canonical.messages,
        (message) => message.method === "initialize",
        "canonical initialize",
      )
    ).id,
    1,
  );
  assert.deepEqual(starts, []);

  sendCanonical({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "oxlint" } } });
  await waitFor(() => clientMessages, (message) => message.id === 1, "initialize response");
  sendClient({ jsonrpc: "2.0", method: "initialized", params: {} });
  await waitFor(
    () => canonical.messages,
    (message) => message.method === "initialized",
    "canonical initialized",
  );
  const registration = await waitFor(
    () => clientMessages,
    (message) => message.method === "client/registerCapability",
    "dynamic registrations",
  );
  assert.deepEqual(
    registration.params.registrations.map(({ method }) => method),
    [
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didSave",
      "textDocument/didClose",
      "textDocument/formatting",
      "textDocument/codeAction",
    ],
  );
  assert.deepEqual(
    registration.params.registrations[0].registerOptions.documentSelector,
    [
      { scheme: "file", pattern: "**/*.alpha" },
      { scheme: "file", pattern: "**/*.beta" },
    ],
  );
  sendClient({ jsonrpc: "2.0", id: registration.id, result: null });

  sendClient({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri: tsUri, version: 1, text: "debugger;" } },
  });
  sendClient({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri: alphaUri, version: 1, text: "var count = 0;" } },
  });
  await waitFor(
    () => canonical.messages,
    (message) => message.method === "textDocument/didOpen",
    "ordinary didOpen",
  );
  await waitFor(() => starts, () => true, "alpha spawn");
  assert.deepEqual(
    starts.map(({ id }) => id),
    ["alpha"],
    "only the claiming provider starts",
  );
  const alpha = starts[0].child;
  writeLspMessage(alpha.stdout, {
    jsonrpc: "2.0",
    id: "$/oxc-tsrx/provider/alpha/initialize",
    result: {},
  });
  await waitFor(
    () => alpha.messages,
    (message) => message.method === "textDocument/didOpen",
    "alpha didOpen",
  );
  assert.equal(
    canonical.messages.some((message) => message.params?.textDocument?.uri === alphaUri),
    false,
  );
  assert.equal(
    alpha.messages.some((message) => message.params?.textDocument?.uri === tsUri),
    false,
  );

  sendClient({
    jsonrpc: "2.0",
    method: "workspace/didChangeConfiguration",
    params: { settings: {} },
  });
  await Promise.all([
    waitFor(
      () => canonical.messages,
      (message) => message.method === "workspace/didChangeConfiguration",
      "canonical configuration",
    ),
    waitFor(
      () => alpha.messages,
      (message) => message.method === "workspace/didChangeConfiguration",
      "alpha configuration",
    ),
  ]);

  sendClient({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri: alphaUri }, options: {} },
  });
  sendClient({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/formatting",
    params: { textDocument: { uri: tsUri }, options: {} },
  });
  sendClient({
    jsonrpc: "2.0",
    id: 6,
    method: "textDocument/formatting",
    params: { textDocument: { uri: betaUri }, options: {} },
  });
  await waitFor(() => alpha.messages, (message) => message.id === 2, "alpha formatting");
  await waitFor(() => canonical.messages, (message) => message.id === 3, "canonical formatting");
  await waitFor(() => starts, ({ id }) => id === "beta", "beta spawn");
  const beta = starts.find(({ id }) => id === "beta").child;
  writeLspMessage(beta.stdout, {
    jsonrpc: "2.0",
    id: "$/oxc-tsrx/provider/beta/initialize",
    result: {},
  });
  await waitFor(() => beta.messages, (message) => message.id === 6, "beta formatting");
  assert.equal(canonical.messages.some((message) => message.id === 2), false);
  assert.equal(alpha.messages.some((message) => message.id === 3), false);
  assert.equal(alpha.messages.some((message) => message.id === 6), false);

  writeLspMessage(alpha.stdout, { jsonrpc: "2.0", id: 2, result: [{ newText: "formatted" }] });
  sendCanonical({ jsonrpc: "2.0", id: 3, result: [] });
  assert.deepEqual(
    (
      await waitFor(
        () => clientMessages,
        (message) => message.id === 2,
        "alpha formatting response",
      )
    ).result,
    [{ newText: "formatted" }],
  );
  await waitFor(() => clientMessages, (message) => message.id === 3, "canonical response");

  sendClient({
    jsonrpc: "2.0",
    id: 4,
    method: "textDocument/codeAction",
    params: { textDocument: { uri: alphaUri }, range: {}, context: {} },
  });
  await waitFor(() => alpha.messages, (message) => message.id === 4, "alpha code action");
  sendClient({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 4 } });
  await waitFor(
    () => alpha.messages,
    (message) => message.method === "$/cancelRequest" && message.params.id === 4,
    "alpha cancellation",
  );
  assert.equal(
    canonical.messages.some(
      (message) => message.method === "$/cancelRequest" && message.params.id === 4,
    ),
    false,
  );

  writeLspMessage(alpha.stdout, {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: alphaUri, diagnostics: [{ source: "alpha" }] },
  });
  await waitFor(
    () => clientMessages,
    (message) =>
      message.method === "textDocument/publishDiagnostics" && message.params.uri === alphaUri,
    "alpha diagnostics",
  );

  writeLspMessage(alpha.stdout, {
    jsonrpc: "2.0",
    id: 17,
    method: "workspace/configuration",
    params: { items: [] },
  });
  const providerRequest = await waitFor(
    () => clientMessages,
    (message) =>
      message.method === "workspace/configuration" &&
      String(message.id).startsWith("$/oxc-tsrx/provider/alpha/request/"),
    "remapped provider server request",
  );
  sendClient({ jsonrpc: "2.0", id: providerRequest.id, result: [] });
  assert.deepEqual(
    (
      await waitFor(
        () => alpha.messages,
        (message) => message.id === 17 && message.method === undefined,
        "restored provider server request ID",
      )
    ).result,
    [],
  );
  assert.equal(
    canonical.messages.some(
      (message) => message.id === providerRequest.id && message.method === undefined,
    ),
    false,
  );

  sendCanonical({
    jsonrpc: "2.0",
    id: 17,
    method: "workspace/configuration",
    params: { items: [{ section: "oxc_language_server" }] },
  });
  const canonicalRequest = await waitFor(
    () => clientMessages,
    (message) =>
      message.method === "workspace/configuration" &&
      String(message.id).startsWith("$/oxc-tsrx/canonical-request/"),
    "remapped canonical server request",
  );
  assert.notEqual(canonicalRequest.id, providerRequest.id);
  sendClient({ jsonrpc: "2.0", id: canonicalRequest.id, result: [{ lint: true }] });
  assert.deepEqual(
    (
      await waitFor(
        () => canonical.messages,
        (message) => message.id === 17 && message.method === undefined,
        "restored canonical server request ID",
      )
    ).result,
    [{ lint: true }],
  );
  assert.equal(
    alpha.messages.some(
      (message) => message.id === canonicalRequest.id && message.method === undefined,
    ),
    false,
  );

  sendClient({ jsonrpc: "2.0", id: 5, method: "shutdown", params: null });
  await waitFor(() => canonical.messages, (message) => message.id === 5, "canonical shutdown");
  await waitFor(
    () => alpha.messages,
    (message) => message.id === "$/oxc-tsrx/provider/alpha/shutdown",
    "alpha shutdown",
  );
  writeLspMessage(alpha.stdout, {
    jsonrpc: "2.0",
    id: "$/oxc-tsrx/provider/alpha/shutdown",
    result: null,
  });
  assert.equal(
    clientMessages.some((message) => message.id === "$/oxc-tsrx/provider/alpha/shutdown"),
    false,
  );
  sendClient({ jsonrpc: "2.0", method: "exit", params: {} });
  await Promise.all([
    waitFor(() => canonical.messages, (message) => message.method === "exit", "canonical exit"),
    waitFor(() => alpha.messages, (message) => message.method === "exit", "alpha exit"),
  ]);

  assert.equal(harnessed.errors(), "");
  multiplexer.dispose();
  canonical.emit("close", 0, null);
  alpha.emit("close", 0, null);
  beta.emit("close", 0, null);
  harnessed.clientInput.end();
});

test("a provider that cannot start fails its requests instead of the session", async () => {
  const harnessed = harness([
    {
      id: "broken",
      extensions: [".broken"],
      start() {
        throw new Error("no executable");
      },
    },
  ]);
  const { sendClient, sendCanonical, canonical, clientMessages } = harnessed;

  sendClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
  await waitFor(() => canonical.messages, (message) => message.id === 1, "canonical initialize");
  sendCanonical({ jsonrpc: "2.0", id: 1, result: {} });
  sendClient({ jsonrpc: "2.0", method: "initialized", params: {} });
  sendClient({
    jsonrpc: "2.0",
    id: 9,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///w/View.broken" }, options: {} },
  });
  const failure = await waitFor(
    () => clientMessages,
    (message) => message.id === 9,
    "failed provider request",
  );
  assert.equal(failure.error.code, -32002);
  assert.match(harnessed.errors(), /broken language server could not start/u);

  sendClient({
    jsonrpc: "2.0",
    id: 10,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///w/main.ts" }, options: {} },
  });
  await waitFor(
    () => canonical.messages,
    (message) => message.id === 10,
    "canonical still serves ordinary files",
  );
  harnessed.close();
});

test("only providers with an lsp capability become startable sessions", () => {
  const spawns = [];
  const spawnProcess = (command, args) => {
    spawns.push({ command, args });
    return new FakeChild();
  };
  const index = {
    root: "/w",
    providers: [
      {
        name: "demo-language",
        id: "demo",
        root: "/store/demo-language",
        languages: [
          {
            id: "demo",
            extensions: [".demo"],
            capabilities: { lsp: { kind: "bin", bin: "demo-lsp", path: "/store/demo-language/bin/demo-lsp" } },
          },
        ],
      },
      {
        name: "parse-only-language",
        id: "parseonly",
        root: "/store/parse-only-language",
        languages: [
          {
            id: "parseonly",
            extensions: [".parseonly"],
            capabilities: { parse: { kind: "module", specifier: "parse-only-language", path: "/x" } },
          },
        ],
      },
    ],
    extensions: {
      ".demo": { package: "demo-language" },
      ".parseonly": { package: "parse-only-language" },
    },
    diagnostics: [],
  };

  const sessions = providerLspSessions(index, spawnProcess, { cwd: "/w" });
  assert.deepEqual(
    sessions.map(({ id, extensions, command }) => ({ id, extensions, command })),
    [{ id: "demo", extensions: [".demo"], command: "/store/demo-language/bin/demo-lsp" }],
  );
  assert.deepEqual(spawns, [], "building sessions must not spawn anything");
  sessions[0].start();
  assert.deepEqual(spawns, [
    { command: "/store/demo-language/bin/demo-lsp", args: ["--stdio"] },
  ]);
  assert.deepEqual(providerLspSessions({ providers: [] }, spawnProcess, {}), []);
});

test("the real entry point discovers the index and still starts only canonical Oxlint", async (context) => {
  const require = createRequire(join(toolchainRoot, "dist/oxlint-lsp-multiplexer.js"));
  try {
    require.resolve("oxlint-current/package.json");
  } catch {
    context.skip("the canonical Oxlint delegate is not installed");
    return;
  }

  const project = await mkdtemp(join(tmpdir(), "oxc-tsrx-lsp-host-"));
  context.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "host", private: true, dependencies: { "@tsrx/oxc": "0.8.0" } })}\n`,
  );
  await mkdir(join(project, "node_modules/@tsrx"), { recursive: true });
  await symlink(toolchainRoot, join(project, "node_modules/@tsrx/oxc"), "dir");

  const spawns = [];
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const clientError = new PassThrough();
  let errors = "";
  clientError.setEncoding("utf8");
  clientError.on("data", (chunk) => (errors += chunk));
  let canonical = null;

  const finished = runOxlintLspMultiplexer(["--lsp"], {
    cwd: project,
    clientInput,
    clientOutput,
    clientError,
    spawn: (command, args) => {
      spawns.push({ command, args });
      canonical = new FakeChild();
      return canonical;
    },
  });

  await waitFor(() => spawns, () => true, "canonical Oxlint spawn");
  assert.equal(spawns.length, 1, "no provider process may start before a provider document");
  assert.equal(spawns[0].command, process.execPath);
  assert.match(spawns[0].args[0], /oxlint/u);
  assert.deepEqual(spawns[0].args.slice(1), ["--lsp"]);
  assert.equal(errors, "");

  canonical.emit("close", 0, null);
  assert.equal(await finished, 0);
});

import { spawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverProviders, extensionOf, findProjectRoot } from "./provider-resolve.js";
import { spawnCommand } from "./spawn-command.js";

const REGISTER_REQUEST_ID = "$/oxc-tsrx/register-capabilities";
const CANONICAL_SERVER_REQUEST_PREFIX = "$/oxc-tsrx/canonical-request/";
const PROVIDER_PREFIX = "$/oxc-tsrx/provider/";
const BROADCAST_NOTIFICATIONS = new Set([
  "workspace/didChangeConfiguration",
  "workspace/didChangeWatchedFiles",
  "workspace/didChangeWorkspaceFolders",
]);

function providerInitializeId(id) {
  return `${PROVIDER_PREFIX}${id}/initialize`;
}

function providerShutdownId(id) {
  return `${PROVIDER_PREFIX}${id}/shutdown`;
}

function providerRequestPrefix(id) {
  return `${PROVIDER_PREFIX}${id}/request/`;
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function isRequest(message) {
  return message?.method !== undefined && message.id !== undefined;
}

function isResponse(message) {
  return message?.method === undefined && message?.id !== undefined;
}

function textDocumentUri(message) {
  const uri = message?.params?.textDocument?.uri ?? message?.params?.uri;
  return typeof uri === "string" ? uri : null;
}

/** Accepts an array, a Set, or a discovered `index.extensions` object. */
function extensionSet(extensions) {
  if (extensions === null || extensions === undefined) return new Set();
  const values =
    typeof extensions[Symbol.iterator] === "function" ? extensions : Object.keys(extensions);
  return new Set([...values].map((extension) => String(extension).toLowerCase()));
}

/** The lowercase extension of the document a text-document message refers to. */
export function documentExtension(message) {
  if (typeof message?.method !== "string" || !message.method.startsWith("textDocument/")) {
    return null;
  }
  const uri = textDocumentUri(message);
  if (uri === null) return null;
  try {
    return extensionOf(decodeURIComponent(new URL(uri).pathname));
  } catch {
    return extensionOf(uri.split(/[?#]/u, 1)[0]);
  }
}

/**
 * Route only the extensions a discovered provider claims. Every other document
 * message, and every non-document message, stays on canonical Oxlint.
 */
export function isProviderDocumentMessage(message, extensions) {
  const extension = documentExtension(message);
  return extension !== null && extensionSet(extensions).has(extension);
}

export function writeLspMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message));
  stream.write(
    Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
      body,
    ]),
  );
}

export function readLspMessages(stream, onMessage, onError: any = (error) => {
  throw error;
}) {
  let input = Buffer.alloc(0);
  const onData = (chunk) => {
    input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const boundary = input.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      const header = input.subarray(0, boundary).toString("ascii");
      const match = /(?:^|\r\n)content-length:\s*(\d+)/iu.exec(header);
      if (match === null) {
        onError(new Error(`LSP message is missing Content-Length: ${header}`));
        return;
      }
      const length = Number(match[1]);
      const bodyStart = boundary + 4;
      const bodyEnd = bodyStart + length;
      if (input.length < bodyEnd) return;
      const body = input.subarray(bodyStart, bodyEnd);
      input = input.subarray(bodyEnd);
      try {
        onMessage(JSON.parse(body.toString("utf8")));
      } catch (error) {
        onError(
          new Error(
            `LSP message contains invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        return;
      }
    }
  };
  stream.on("data", onData);
  return () => stream.off("data", onData);
}

export function registrationRequest(extensions) {
  const documentSelector = [...extensionSet(extensions)]
    .sort()
    .map((extension) => ({ scheme: "file", pattern: `**/*${extension}` }));
  return {
    jsonrpc: "2.0",
    id: REGISTER_REQUEST_ID,
    method: "client/registerCapability",
    params: {
      registrations: [
        {
          id: "oxc-tsrx-did-open",
          method: "textDocument/didOpen",
          registerOptions: { documentSelector },
        },
        {
          id: "oxc-tsrx-did-change",
          method: "textDocument/didChange",
          registerOptions: { documentSelector, syncKind: 1 },
        },
        {
          id: "oxc-tsrx-did-save",
          method: "textDocument/didSave",
          registerOptions: { documentSelector },
        },
        {
          id: "oxc-tsrx-did-close",
          method: "textDocument/didClose",
          registerOptions: { documentSelector },
        },
        {
          id: "oxc-tsrx-formatting",
          method: "textDocument/formatting",
          registerOptions: { documentSelector },
        },
        {
          id: "oxc-tsrx-code-actions",
          method: "textDocument/codeAction",
          registerOptions: {
            documentSelector,
            codeActionKinds: ["quickfix"],
            resolveProvider: false,
          },
        },
      ],
    },
  };
}

function endpointExit(endpoint) {
  return new Promise<any>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.once("close", (status, signal) => {
      resolve({ status: status ?? 2, signal });
    });
  });
}

/**
 * The `initialize` a provider session should see.
 *
 * A provider resolves its configuration from the workspace root it is handed,
 * and through that config the `jsPlugins` a project declares. When the editor
 * opened a folder *above* the project that owns the provider, forwarding the
 * client's root verbatim points the session at a directory with no
 * `.oxlintrc.json`, so the project's own rules and JS plugins quietly stop
 * applying in the editor while they still apply on the command line. Rewriting
 * the root, and only the root, keeps both views of the project identical.
 */
function initializeForProvider(message, providerRoot) {
  if (providerRoot === null) return message;
  const uri = pathToFileURL(providerRoot).href;
  return {
    ...message,
    params: {
      ...message.params,
      rootUri: uri,
      rootPath: providerRoot,
      workspaceFolders: [{ uri, name: basename(providerRoot) }],
    },
  };
}

/**
 * Compose canonical Oxlint and any discovered language provider servers behind
 * one stdio LSP.
 *
 * `canonical` is a child-process-shaped endpoint. Each entry of `providers` is
 * `{ id, extensions, start() }`; `start` is only called when the editor sends
 * the first document message for an extension that provider claims, so an
 * ordinary session never pays for a provider process. With an empty
 * `providers` list every byte is forwarded to canonical Oxlint unchanged.
 */
export function createOxlintLspMultiplexer({
  clientInput,
  clientOutput,
  clientError,
  canonical,
  providers = [],
  providerRoot = null,
}) {
  let clientInitialized = false;
  let registered = false;
  let registrationPending = false;
  let initializeMessage = null;
  let nextCanonicalServerRequest = 1;
  const canonicalServerRequests = new Map();
  const clientRequestTargets = new Map();
  const disposeReaders = [];

  const sessions = providers.map((provider) => ({
    provider,
    extensions: extensionSet(provider.extensions),
    endpoint: null,
    initializePending: false,
    initialized: false,
    failed: false,
    started: false,
    shutdownPending: false,
    exit: null,
    queued: [],
    serverRequests: new Map(),
    nextServerRequest: 1,
  }));
  const routedExtensions = new Set(
    sessions.flatMap((session) => [...session.extensions]),
  );

  const report = (message) => clientError.write(`oxlint (oxc-tsrx): ${message}\n`);
  const sendCanonical = (message) => writeLspMessage(canonical.stdin, message);
  const sendClient = (message) => writeLspMessage(clientOutput, message);
  const sendSession = (session, message) => writeLspMessage(session.endpoint.stdin, message);
  const protocolError = (source) => (error) => {
    report(`${source} protocol error: ${error instanceof Error ? error.message : String(error)}`);
  };

  const failQueued = (session, reason) => {
    for (const message of session.queued.splice(0)) {
      if (!isRequest(message)) continue;
      clientRequestTargets.delete(requestKey(message.id));
      sendClient({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32002, message: reason },
      });
    }
  };

  const startSession = (session) => {
    if (session.started || !clientInitialized || !session.initialized || session.failed) return;
    session.started = true;
    sendSession(session, { jsonrpc: "2.0", method: "initialized", params: {} });
    for (const message of session.queued.splice(0)) sendSession(session, message);
  };

  const onSessionMessage = (session, message) => {
    const { id } = session.provider;
    if (
      session.initializePending &&
      isResponse(message) &&
      message.id === providerInitializeId(id)
    ) {
      session.initializePending = false;
      if (message.error !== undefined) {
        session.failed = true;
        report(
          `the ${id} language server failed to initialize: ${JSON.stringify(message.error)}`,
        );
        failQueued(session, `The ${id} language server did not initialize`);
      } else {
        session.initialized = true;
        startSession(session);
      }
      return;
    }
    if (
      session.shutdownPending &&
      isResponse(message) &&
      message.id === providerShutdownId(id)
    ) {
      session.shutdownPending = false;
      return;
    }
    if (isRequest(message)) {
      const proxyId = `${providerRequestPrefix(id)}${session.nextServerRequest++}`;
      session.serverRequests.set(requestKey(proxyId), message.id);
      sendClient({ ...message, id: proxyId });
      return;
    }
    if (isResponse(message)) clientRequestTargets.delete(requestKey(message.id));
    sendClient(message);
  };

  const ensureSession = (session) => {
    if (session.endpoint !== null || session.failed) return;
    if (initializeMessage === null) return;
    let endpoint;
    try {
      endpoint = session.provider.start();
    } catch (error) {
      session.failed = true;
      report(
        `the ${session.provider.id} language server could not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      failQueued(session, `The ${session.provider.id} language server could not start`);
      return;
    }
    session.endpoint = endpoint;
    session.exit = endpointExit(endpoint).catch((error) => ({
      status: 2,
      signal: null,
      error,
    }));
    disposeReaders.push(
      readLspMessages(
        endpoint.stdout,
        (message) => onSessionMessage(session, message),
        protocolError(`the ${session.provider.id} language server`),
      ),
    );
    endpoint.stderr?.on("data", (chunk) => clientError.write(chunk));
    session.initializePending = true;
    sendSession(session, {
      ...initializeForProvider(initializeMessage, providerRoot),
      id: providerInitializeId(session.provider.id),
    });
  };

  const sessionFor = (message) => {
    if (routedExtensions.size === 0) return null;
    const extension = documentExtension(message);
    if (extension === null) return null;
    return sessions.find((session) => session.extensions.has(extension)) ?? null;
  };

  const deliver = (session, message) => {
    ensureSession(session);
    if (session.failed) {
      if (isRequest(message)) {
        clientRequestTargets.delete(requestKey(message.id));
        sendClient({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32002,
            message: `The ${session.provider.id} language server is unavailable`,
          },
        });
      }
      return;
    }
    if (session.started) sendSession(session, message);
    else session.queued.push(message);
  };

  const onClientMessage = (message) => {
    if (isResponse(message)) {
      if (registrationPending && message.id === REGISTER_REQUEST_ID) {
        registrationPending = false;
        if (message.error !== undefined) {
          report(`the editor rejected provider capabilities: ${JSON.stringify(message.error)}`);
        }
        return;
      }
      for (const session of sessions) {
        const original = session.serverRequests.get(requestKey(message.id));
        if (original === undefined) continue;
        session.serverRequests.delete(requestKey(message.id));
        if (session.endpoint !== null) sendSession(session, { ...message, id: original });
        return;
      }
      const canonicalRequest = canonicalServerRequests.get(requestKey(message.id));
      if (canonicalRequest !== undefined) {
        canonicalServerRequests.delete(requestKey(message.id));
        sendCanonical({ ...message, id: canonicalRequest });
        return;
      }
      sendCanonical(message);
      return;
    }

    if (message.method === "initialize" && isRequest(message)) {
      initializeMessage = message;
      clientRequestTargets.set(requestKey(message.id), "canonical");
      sendCanonical(message);
      return;
    }

    if (message.method === "initialized") {
      clientInitialized = true;
      sendCanonical(message);
      if (routedExtensions.size > 0 && !registered) {
        registered = true;
        registrationPending = true;
        sendClient(registrationRequest(routedExtensions));
      }
      for (const session of sessions) startSession(session);
      return;
    }

    if (message.method === "shutdown" && isRequest(message)) {
      clientRequestTargets.set(requestKey(message.id), "canonical");
      sendCanonical(message);
      for (const session of sessions) {
        if (!session.started) continue;
        session.shutdownPending = true;
        sendSession(session, { ...message, id: providerShutdownId(session.provider.id) });
      }
      return;
    }

    if (message.method === "exit") {
      sendCanonical(message);
      for (const session of sessions) {
        if (session.endpoint !== null) sendSession(session, message);
      }
      return;
    }

    if (message.method === "$/cancelRequest") {
      const target = clientRequestTargets.get(requestKey(message.params?.id));
      if (target !== undefined && target !== "canonical") deliver(target, message);
      else sendCanonical(message);
      return;
    }

    if (BROADCAST_NOTIFICATIONS.has(message.method) && message.id === undefined) {
      sendCanonical(message);
      for (const session of sessions) {
        if (session.started) sendSession(session, message);
      }
      return;
    }

    const session = sessionFor(message);
    if (session !== null) {
      if (isRequest(message)) clientRequestTargets.set(requestKey(message.id), session);
      deliver(session, message);
      return;
    }

    if (isRequest(message)) {
      clientRequestTargets.set(requestKey(message.id), "canonical");
    }
    sendCanonical(message);
  };

  const onCanonicalMessage = (message) => {
    if (isRequest(message)) {
      const proxyId = `${CANONICAL_SERVER_REQUEST_PREFIX}${nextCanonicalServerRequest++}`;
      canonicalServerRequests.set(requestKey(proxyId), message.id);
      sendClient({ ...message, id: proxyId });
      return;
    }
    if (isResponse(message)) clientRequestTargets.delete(requestKey(message.id));
    sendClient(message);
  };

  disposeReaders.push(
    readLspMessages(clientInput, onClientMessage, protocolError("editor")),
    readLspMessages(canonical.stdout, onCanonicalMessage, protocolError("canonical Oxlint")),
  );

  canonical.stderr?.on("data", (chunk) => clientError.write(chunk));
  clientInput.on("end", () => {
    canonical.stdin.end();
    for (const session of sessions) {
      if (session.endpoint !== null) session.endpoint.stdin.end();
    }
  });

  return {
    extensions: [...routedExtensions].sort(),
    startedProviders: () =>
      sessions.filter((session) => session.endpoint !== null).map(({ provider }) => provider.id),
    closed: (async () => {
      const canonicalExit = await endpointExit(canonical);
      const providerExits = await Promise.all(
        sessions.filter((session) => session.exit !== null).map((session) => session.exit),
      );
      return { canonical: canonicalExit, providers: providerExits };
    })(),
    kill(signal) {
      canonical.kill(signal);
      for (const session of sessions) session.endpoint?.kill(signal);
    },
    dispose() {
      for (const dispose of disposeReaders.splice(0)) dispose();
      // Reading the client stream resumed it, and dropping the listener does
      // not release the handle. Without this the process stays alive after the
      // servers are gone, so `oxlint --lsp` never exits and an editor leaks one
      // multiplexer per session.
      clientInput.pause?.();
      clientInput.unref?.();
    },
  };
}

function resolveCanonicalOxlintBinary() {
  const require = createRequire(import.meta.url);
  const canonicalManifest = require.resolve("oxlint-current/package.json");
  const manifest = require(canonicalManifest);
  const declared =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.oxlint;
  if (typeof declared !== "string" || declared.length === 0) {
    throw new Error("oxlint-current does not declare the oxlint binary");
  }
  return fileURLToPath(new URL(declared, pathToFileURL(canonicalManifest)));
}

/**
 * A declared `bin` entry may be a JavaScript wrapper or a native executable.
 * Reading the shebang is a static file read, not an execution of the package.
 *
 * A UTF-8 byte-order mark sits in front of the `#!` and is common in files
 * authored on Windows, so it is stripped before the test: misreading a Node
 * wrapper as a native executable would make this spawn an extensionless file,
 * which Windows cannot run at all.
 */
function usesNodeInterpreter(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(128);
    const read = readSync(descriptor, buffer, 0, 128, 0);
    const head = buffer.subarray(0, read).toString("utf8").replace(/^\uFEFF/u, "");
    const shebang = head.split("\n", 1)[0];
    return shebang.startsWith("#!") && /\bnode(?:\.exe)?\b/u.test(shebang);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Turn a discovered index into lazily startable language server sessions. Only
 * providers that declare an `lsp` capability contribute; their claimed
 * extensions are the exact routing set.
 */
export function providerLspSessions(index, spawnProcess, childOptions) {
  const sessions = [];
  for (const provider of index?.providers ?? []) {
    const extensions = [];
    let command = null;
    for (const language of provider.languages) {
      const capability = language.capabilities?.lsp;
      if (capability?.kind !== "bin") continue;
      command = capability.path;
      for (const extension of language.extensions) {
        if (index.extensions?.[extension]?.package === provider.name) extensions.push(extension);
      }
    }
    if (command === null || extensions.length === 0) continue;
    sessions.push({
      id: provider.id,
      package: provider.name,
      command,
      extensions,
      start: () =>
        usesNodeInterpreter(command)
          ? spawnProcess(process.execPath, [command, "--stdio"], childOptions)
          : // A provider is free to declare a `.cmd`/`.bat` launcher, which only
            // a command interpreter can run on Windows. Every other target is
            // spawned exactly as before.
            spawnCommand(command, ["--stdio"], childOptions, spawnProcess),
    });
  }
  return sessions;
}

/**
 * Every project root that could own the provider index for this session, after
 * the editor's own workspace root.
 *
 * VS Code opens whatever folder the user picked, and that is routinely a plain
 * directory *above* the project that installed this package: a scaffold inside a
 * demo folder, an app inside a repo that declares no workspace. Discovery rooted
 * at the opened folder then finds no provider, registers no `.tsrx` capability,
 * and the session serves nothing while looking perfectly healthy.
 *
 * This process is running out of the installing project's `node_modules`, so the
 * path it was launched from names that project: everything before the first
 * `node_modules` segment. Both the launched script and this module are checked,
 * because a package manager may hand over either the symlink or the real path.
 */
function installingProjectRoots() {
  const roots = [];
  for (const candidate of [process.argv[1], fileURLToPath(import.meta.url)]) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const marker = candidate.indexOf(`${sep}node_modules${sep}`);
    if (marker === -1) continue;
    const root = candidate.slice(0, marker);
    if (root.length > 0 && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

async function discoverProviderIndex(cwd, report) {
  try {
    const root = await findProjectRoot(cwd);
    let index = await discoverProviders({ root });
    if (index.providers.length === 0) {
      for (const candidate of installingProjectRoots()) {
        if (candidate === root) continue;
        const nested = await discoverProviders({ root: candidate });
        if (nested.providers.length === 0) continue;
        report(
          `the opened folder ${root} declares no language provider, so discovery ` +
            `used the project that installed this package instead: ${candidate}`,
        );
        index = nested;
        break;
      }
    }
    for (const diagnostic of index.diagnostics) {
      report(`${diagnostic.severity}: ${diagnostic.message}`);
    }
    return index;
  } catch (error) {
    report(
      `language provider discovery failed, continuing with canonical Oxlint only: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { root: cwd, providers: [], extensions: {}, diagnostics: [] };
  }
}

export async function runOxlintLspMultiplexer(args, options: any = {}) {
  const spawnProcess = options.spawn ?? spawn;
  const clientError = options.clientError ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  // A project that declares the official Oxlint package directly has said what
  // `oxlint` means to it, and the editor serves its ordinary files through that
  // exact binary. Only `.tsrx` documents leave it for the native server. Said
  // once on the client's error stream, which the editor shows in its output
  // channel, so a session in that layout is never a mystery.
  const canonicalBinary = options.canonical?.binPath ?? resolveCanonicalOxlintBinary();
  if (options.canonical?.binPath) {
    const version = options.canonical.version ? ` ${options.canonical.version}` : "";
    clientError.write(
      `oxlint (oxc-tsrx): ordinary documents are served by the official oxlint${version} ` +
        `this project declares (${options.canonical.binPath}); .tsrx documents by the native server\n`,
    );
  }
  const childOptions = {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  };
  const index =
    options.index ??
    (await discoverProviderIndex(cwd, (message) =>
      clientError.write(`oxlint (oxc-tsrx): ${message}\n`),
    ));
  // A provider session resolves its own configuration from its working
  // directory: `.oxlintrc.json`, and through it the `jsPlugins` a project
  // declares. The editor's working directory is the folder the user opened,
  // which may sit above the project that owns the provider, and that folder
  // usually carries no config at all. Running the session from the discovered
  // index root instead keeps a nested project's rules and JS plugins live in
  // the editor exactly as they are on the command line. Canonical Oxlint keeps
  // the editor's own directory, because it serves the whole opened workspace.
  const providerOptions =
    typeof index?.root === "string" && index.root.length > 0 && index.root !== cwd
      ? { ...childOptions, cwd: index.root }
      : childOptions;
  const providers = providerLspSessions(index, spawnProcess, providerOptions);
  const canonical = spawnProcess(process.execPath, [canonicalBinary, ...args], childOptions);
  const multiplexer = createOxlintLspMultiplexer({
    providerRoot: providerOptions === childOptions ? null : index.root,
    clientInput: options.clientInput ?? process.stdin,
    clientOutput: options.clientOutput ?? process.stdout,
    clientError,
    canonical,
    providers,
  });

  // Installing a handler for these replaces Node's default, which is to
  // terminate. So once we forward the signal we own the exit: if a child
  // ignores it, or is wedged, nothing else will ever stop this process and the
  // editor is left with an orphan language server per session. Escalate on a
  // timer instead of waiting forever.
  const shutdownGraceMs = 2000;
  let escalation;
  const forwardSignal = (signal) => {
    multiplexer.kill(signal);
    if (escalation) return;
    escalation = setTimeout(() => {
      multiplexer.kill("SIGKILL");
      // A child that survives SIGKILL is not something this process can wait
      // out, and staying alive would be worse than reporting the signal.
      escalation = setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), shutdownGraceMs);
      escalation.unref?.();
    }, shutdownGraceMs);
    // Do not hold the event loop open purely to run the escalation.
    escalation.unref?.();
  };
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) process.once(signal, forwardSignal);
  try {
    const exits = await multiplexer.closed;
    if (exits.canonical.signal !== null) {
      clientError.write?.(`canonical Oxlint exited with ${exits.canonical.signal}\n`);
    }
    for (const providerExit of exits.providers) {
      if (providerExit.signal !== null) {
        clientError.write?.(`a language provider server exited with ${providerExit.signal}\n`);
      }
    }
    return Math.max(exits.canonical.status, ...exits.providers.map((exit) => exit.status), 0);
  } finally {
    if (escalation) clearTimeout(escalation);
    multiplexer.dispose();
    for (const signal of signals) process.off(signal, forwardSignal);
  }
}

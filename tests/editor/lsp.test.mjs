import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyTextEdits, LspClient, pathToFileUri, SERVER_ARGUMENTS } from "./lsp-client.mjs";

const root = resolve(import.meta.dirname, "../..");
const workspace = join(root, "tests/fixtures/editor/workspace");
const sourcePath = join(workspace, "View.tsrx");
const server = resolve(
  process.env.OXC_TSRX_LSP_BIN ?? join(root, "target/release/oxc-tsrx"),
);
const uri = pathToFileUri(sourcePath);

test("native LSP activates TSRX formatting, live diagnostics, edits, and safe actions", async () => {
  let source = await readFile(sourcePath, "utf8");
  const client = new LspClient(server, { args: SERVER_ARGUMENTS, cwd: workspace });
  try {
    const initialized = await client.initialize(pathToFileUri(workspace));
  assert.equal(initialized.serverInfo.name, "OXC for TSRX");
  assert.equal(initialized.capabilities.documentFormattingProvider, true);
  assert.deepEqual(initialized.capabilities.codeActionProvider.codeActionKinds, ["quickfix"]);
  assert.equal(initialized.capabilities.textDocumentSync.change, 1);

  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "markless-tsrx", version: 1, text: source },
  });
  const opened = await client.waitFor(
    (message) => message.method === "textDocument/publishDiagnostics",
    5000,
    "open diagnostics",
  );
  assert.equal(opened.params.uri, uri);
  assert.equal(opened.params.version, 1);
  assert.deepEqual(
    opened.params.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    ["no-debugger", "no-var"],
  );
  const debuggerDiagnostic = opened.params.diagnostics.find(
    (diagnostic) => diagnostic.code === "no-debugger",
  );
  assert.deepEqual(debuggerDiagnostic.range, {
    start: { line: 4, character: 11 },
    end: { line: 4, character: 20 },
  });

  const formatting = await client.request("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(formatting.length, 1);
  const formatted = applyTextEdits(source, formatting);
  assert.notEqual(formatted, source);
  assert.match(formatted, /export function View\(\) @\{\n  var total = 0;/);
  assert.match(formatted, /<button aria-label=\{label\}>\{total\}<\/button>;/);

  const actions = await client.request("textDocument/codeAction", {
    textDocument: { uri },
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
    context: { diagnostics: opened.params.diagnostics },
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "quickfix");
  assert.equal(actions[0].isPreferred, true);
  const fixed = applyTextEdits(source, actions[0].edit.changes[uri]);
  assert.doesNotMatch(fixed, /var total/);
  assert.match(fixed, /(?:let|const) total/);

  client.notify("workspace/didChangeConfiguration", {
    settings: [
      {
        workspaceUri: pathToFileUri(workspace),
        options: { lintConfigPath: "no-var-only.json" },
      },
    ],
  });
  const reconfigured = await client.waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" &&
      message.params.diagnostics.some((diagnostic) => diagnostic.code === "no-var") &&
      !message.params.diagnostics.some((diagnostic) => diagnostic.code === "no-debugger"),
    5000,
    "configuration-change diagnostics",
  );
  assert.deepEqual(
    reconfigured.params.diagnostics.map((diagnostic) => diagnostic.code),
    ["no-var"],
  );

  const debuggerStart = source.indexOf("debugger");
  source = source.slice(0, debuggerStart) + "total++;" + source.slice(debuggerStart + 9);
  client.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: source }],
  });
  const changed = await client.waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" && message.params.version === 2,
    5000,
    "change diagnostics",
  );
  assert.deepEqual(
    changed.params.diagnostics.map((diagnostic) => diagnostic.code),
    ["no-var"],
  );

  client.notify("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [{ text: "export function View() @{ @if (" }],
  });
  const malformed = await client.waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" && message.params.version === 3,
    2000,
    "malformed edit diagnostics",
  );
  assert.deepEqual(
    malformed.params.diagnostics.map((diagnostic) => diagnostic.code),
    ["parse-error"],
  );
  await assert.rejects(
    client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    }),
    /formatting|unterminated|expected|syntax/i,
  );

  client.notify("textDocument/didChange", {
    textDocument: { uri, version: 4 },
    contentChanges: [{ text: source }],
  });
  const recovered = await client.waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" && message.params.version === 4,
    2000,
    "recovered edit diagnostics",
  );
  assert.deepEqual(
    recovered.params.diagnostics.map((diagnostic) => diagnostic.code),
    ["no-var"],
  );

  client.notify("textDocument/didClose", { textDocument: { uri } });
    await client.close();
  } finally {
    client.terminate();
  }
});

// A `jsPlugins` config used to take every diagnostic away from every `.tsrx` file
// in the editor, silently. The command line strips `jsPlugins` before it reaches
// the native engine, because the `oxlint` wrapper hosts those plugins itself over
// the TSX projection; the editor path did not, so the engine refused the whole
// workspace, the refusal had nowhere to go, and the file simply looked clean. A
// developer who added one custom rule lost `no-debugger` with no way to find out
// why.
//
// These tests pin all three halves of the fix: the native rules survive the
// config, the developer's own rule reaches the editor as a squiggle of its own,
// and a refusal the strip cannot avoid is published rather than swallowed.
const pluginFixtures = join(root, "tests/fixtures/lint/js-plugins");

async function withPluginWorkspace(config, body) {
  const workspace = await mkdtemp(join(tmpdir(), "oxc-tsrx-lsp-js-plugins-"));
  try {
    await cp(join(pluginFixtures, "demo-plugin.mjs"), join(workspace, "demo-plugin.mjs"));
    await cp(join(pluginFixtures, "demo.tsrx"), join(workspace, "demo.tsrx"));
    await writeFile(join(workspace, ".oxlintrc.json"), `${JSON.stringify(config, null, 2)}\n`);
    return await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function openTsrx(workspace) {
  const path = join(workspace, "demo.tsrx");
  const uri = pathToFileUri(path);
  const source = await readFile(path, "utf8");
  const client = new LspClient(server, { args: SERVER_ARGUMENTS, cwd: workspace });
  await client.initialize(pathToFileUri(workspace));
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "markless-tsrx", version: 1, text: source },
  });
  const published = await client.waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" && message.params.uri === uri,
    // The plugin lane starts a Node host and runs the published Oxlint binary over
    // the projection, so the first publish is slower than a native-only one.
    20000,
    "jsPlugins diagnostics",
  );
  return { client, uri, source, diagnostics: published.params.diagnostics };
}

/** The zero-based line and UTF-16 column of one authored byte offset. */
function editorPositionOf(source, offset) {
  const before = source.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: before.slice(before.lastIndexOf("\n") + 1).length };
}

const JS_PLUGIN_CONFIG = {
  jsPlugins: ["./demo-plugin.mjs"],
  rules: { "tsrx-js-demo/no-banned-identifier": "warn" },
  overrides: [
    {
      files: ["**/*.tsrx"],
      rules: { "tsrx-js-demo/no-banned-identifier": "error" },
    },
  ],
};

test("native LSP still reports Rust rules on .tsrx while jsPlugins is configured", async () => {
  await withPluginWorkspace(JS_PLUGIN_CONFIG, async (workspace) => {
    const { client, source, diagnostics } = await openTsrx(workspace);
    try {
      // Silence is the failure this test exists to catch, so the count is asserted
      // before anything is looked up inside it.
      assert.ok(diagnostics.length > 0, `expected diagnostics, got ${JSON.stringify(diagnostics)}`);
      const reported = diagnostics.find((diagnostic) => diagnostic.code === "no-debugger");
      assert.ok(reported, JSON.stringify(diagnostics));
      assert.equal(reported.data.code, "eslint(no-debugger)");
      assert.equal(reported.source, "oxlint-tsrx");

      // The position is checked against the authored source rather than trusted,
      // so a config swap that quietly linted something else would fail here.
      const line = source.split("\n").findIndex((text) => text.includes("debugger;"));
      assert.equal(reported.range.start.line, line);
      assert.equal(reported.range.start.character, source.split("\n")[line].indexOf("debugger"));

      await client.close();
    } finally {
      client.terminate();
    }
  });
});

// The whole point of the board: a rule the developer wrote, registered in their
// own `.oxlintrc.json`, has to arrive in the editor as a squiggle on the `.tsrx`
// file, at the bytes they actually wrote. Before this, the editor path never
// reached the plugin lane at all and a custom rule was invisible there.
test("native LSP publishes the developer's own plugin rule as a .tsrx squiggle", async () => {
  await withPluginWorkspace(JS_PLUGIN_CONFIG, async (workspace) => {
    const { client, source, diagnostics } = await openTsrx(workspace);
    try {
      const reported = diagnostics.filter(
        (diagnostic) => diagnostic.code === "tsrx-js-demo(no-banned-identifier)",
      );
      // The fixture plugin reports every identifier literally named `banned`, so
      // the expected spans are readable straight out of the authored source and a
      // diagnostic sitting on projection offsets could not pass.
      const expected = [...source.matchAll(/banned/gu)].map((match) => match.index);
      assert.equal(expected.length, 2, "the fixture stopped containing two `banned` identifiers");
      assert.equal(reported.length, expected.length, JSON.stringify(diagnostics, null, 2));
      for (const [index, diagnostic] of reported.entries()) {
        assert.deepEqual(diagnostic.range, {
          start: editorPositionOf(source, expected[index]),
          end: editorPositionOf(source, expected[index] + "banned".length),
        });
        assert.equal(diagnostic.severity, 1, "the config sets this rule to error on .tsrx");
        assert.equal(diagnostic.data.jsPlugin, true);
        assert.equal(diagnostic.data.rule, "no-banned-identifier");
      }

      // And the native Rust rules are still in the same publish, which is what
      // makes this a merge rather than a replacement.
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code === "no-debugger"),
        JSON.stringify(diagnostics, null, 2),
      );
      // Nothing failed quietly on the way.
      assert.deepEqual(
        diagnostics.filter((diagnostic) =>
          ["js-plugins-unavailable", "lint-unavailable"].includes(String(diagnostic.code)),
        ),
        [],
      );
      // The extra parse is disclosed once, in the server log, with its opt-out.
      assert.match(client.stderr, /running this project's Oxlint JS plugins on \.tsrx/u);
      assert.match(client.stderr, /jsPluginsOnTsrx/u);
      await client.close();
    } finally {
      client.terminate();
    }
  });
});

// An editor re-lints on every keystroke, so the lane has to keep answering with
// positions measured in the buffer it was handed rather than in whatever is on
// disk. This edits the file in memory only and checks the rule follows.
test("native LSP re-runs the plugin lane on an unsaved edit", async () => {
  await withPluginWorkspace(JS_PLUGIN_CONFIG, async (workspace) => {
    const { client, uri, source } = await openTsrx(workspace);
    try {
      const edited = `// a line nobody saved\n${source}`;
      client.notify("textDocument/didChange", {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: edited }],
      });
      const changed = await client.waitFor(
        (message) =>
          message.method === "textDocument/publishDiagnostics" && message.params.version === 2,
        20000,
        "plugin diagnostics after an unsaved edit",
      );
      const reported = changed.params.diagnostics.filter(
        (diagnostic) => diagnostic.code === "tsrx-js-demo(no-banned-identifier)",
      );
      const expected = [...edited.matchAll(/banned/gu)].map((match) => match.index);
      assert.equal(reported.length, expected.length, JSON.stringify(changed.params.diagnostics));
      for (const [index, diagnostic] of reported.entries()) {
        assert.deepEqual(diagnostic.range.start, editorPositionOf(edited, expected[index]));
      }
      // The native half moved with it too.
      const nativeDiagnostic = changed.params.diagnostics.find(
        (diagnostic) => diagnostic.code === "no-debugger",
      );
      assert.ok(nativeDiagnostic, JSON.stringify(changed.params.diagnostics));
      assert.deepEqual(
        nativeDiagnostic.range.start,
        editorPositionOf(edited, edited.indexOf("debugger")),
      );
      await client.close();
    } finally {
      client.terminate();
    }
  });
});

test("native LSP publishes a capability refusal instead of going silent", async () => {
  await withPluginWorkspace(
    { ...JS_PLUGIN_CONFIG, settings: { oxcTsrx: { jsPluginsOnTsrx: false } } },
    async (workspace) => {
      const { client, diagnostics } = await openTsrx(workspace);
      try {
        // The opt-out is the one configuration that asks for the native refusal.
        // It has to arrive as something the developer can read, not as an empty
        // Problems panel.
        assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
        assert.equal(diagnostics[0].code, "lint-unavailable");
        assert.equal(diagnostics[0].severity, 1);
        assert.match(
          diagnostics[0].message,
          /JavaScript plugins are not hosted by the native TSRX lint target itself/u,
        );
        assert.match(diagnostics[0].message, /jsPluginsOnTsrx/u);
        // And in the client's server log, for anyone reading that instead.
        assert.match(client.stderr, /TSRX linting is unavailable/u);
        await client.close();
      } finally {
        client.terminate();
      }
    },
  );
});

test("native LSP keeps type-aware lint opt-in and authored TSRX diagnostics", async () => {
  const typeRoot = join(root, "tests/fixtures/type-aware/single");
  const typePath = join(typeRoot, "View.tsrx");
  const typeUri = pathToFileUri(typePath);
  const rootUri = pathToFileUri(typeRoot);
  const source = await readFile(typePath, "utf8");
  const client = new LspClient(server, { args: SERVER_ARGUMENTS, cwd: typeRoot });
  try {
    await client.initialize(rootUri, [
      { workspaceUri: rootUri, options: { typeAware: true, typeCheck: false } },
    ]);
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: typeUri,
        languageId: "markless-tsrx",
        version: 1,
        text: source,
      },
    });
    const published = await client.waitFor(
      (message) => message.method === "textDocument/publishDiagnostics",
      5000,
      "type-aware diagnostics",
    );
    const diagnostic = published.params.diagnostics.find(
      (item) => item.code === "no-floating-promises",
    );
    assert.ok(diagnostic, JSON.stringify(published));
    assert.equal(diagnostic.source, "oxlint-tsrx");
    // tsgolint 7.x labels `save()` rather than the whole `save();` statement.
    assert.deepEqual(diagnostic.range, {
      start: { line: 3, character: 2 },
      end: { line: 3, character: 8 },
    });
    await client.close();
  } finally {
    client.terminate();
  }
});

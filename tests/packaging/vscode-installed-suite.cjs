"use strict";

const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

const extensionId = "thejackshelton.oxc-tsrx-vscode";

async function step(label, operation) {
  process.stdout.write(`[installed-vsix] START ${label}\n`);
  try {
    const result = await operation();
    process.stdout.write(`[installed-vsix] PASS ${label}\n`);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`[installed-vsix] FAIL ${label}\n${detail}`, { cause: error });
  }
}

async function waitFor(read, predicate, label, timeout = 10000) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() - started >= timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function run() {
  await step("environment has no native-binary override", async () => {
    assert.equal(process.env.OXC_TSRX_LSP_BIN, undefined);
  });
  const uri = vscode.Uri.file(process.env.OXC_TSRX_EDITOR_FILE);
  const document = await step("open real Markless TSRX fixture", async () => {
    const opened = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(opened);
    assert.equal(opened.languageId, "markless-tsrx");
    return opened;
  });

  const extension = await step("activate the extension installed from the VSIX", async () => {
    const installed = vscode.extensions.getExtension(extensionId);
    assert.ok(installed, `${extensionId} is not installed from the VSIX`);
    assert.equal(
      installed.extensionPath.startsWith(process.env.OXC_TSRX_INSTALLED_EXTENSIONS_DIR),
      true,
    );
    const suffix = process.platform === "win32" ? ".exe" : "";
    // The VSIX ships the one multi-call native binary (`oxc-tsrx`, whose `lsp`
    // tool is the language server); older packages shipped a dedicated
    // `oxc-tsrx-lsp`. Either proves the native server travelled with the VSIX.
    assert.equal(
      ["oxc-tsrx", "oxc-tsrx-lsp"].some((name) =>
        existsSync(join(installed.extensionPath, "dist/native", `${name}${suffix}`)),
      ),
      true,
    );
    await waitFor(() => installed.isActive, Boolean, "installed extension activation");
    return installed;
  });
  assert.equal(extension.isActive, true);

  await step("publish exact authored native diagnostics", async () => {
    const diagnostics = await waitFor(
      () => vscode.languages.getDiagnostics(uri),
      (items) => {
        const native = items.filter((item) => item.source === "oxlint-tsrx");
        return (
          native.some((item) => item.code === "no-debugger") &&
          native.some((item) => item.code === "no-var")
        );
      },
      "installed native diagnostics",
    );
    const debuggerOffset = document.getText().indexOf("debugger;");
    assert.notEqual(debuggerOffset, -1);
    const debuggerDiagnostic = diagnostics.find(
      (item) => item.source === "oxlint-tsrx" && item.code === "no-debugger",
    );
    assert.deepEqual(
      debuggerDiagnostic.range,
      new vscode.Range(
        document.positionAt(debuggerOffset),
        document.positionAt(debuggerOffset + "debugger;".length),
      ),
    );
  });

  await step("perform real format-on-save through the embedded server", async () => {
    const editorConfig = vscode.workspace.getConfiguration("editor", document);
    await editorConfig.update(
      "defaultFormatter",
      extensionId,
      vscode.ConfigurationTarget.Workspace,
      true,
    );
    await editorConfig.update(
      "formatOnSave",
      true,
      vscode.ConfigurationTarget.Workspace,
      true,
    );
    await waitFor(
      () => ({
        formatter: vscode.workspace
          .getConfiguration("editor", document)
          .get("defaultFormatter"),
        onSave: vscode.workspace.getConfiguration("editor", document).get("formatOnSave"),
      }),
      (value) => value.formatter === extensionId && value.onSave === true,
      "language-specific formatter settings",
    );
    const availableEdits = await vscode.commands.executeCommand(
      "vscode.executeFormatDocumentProvider",
      uri,
      { tabSize: 2, insertSpaces: true },
    );
    assert.ok(availableEdits.length > 0, "the installed native formatter returned no edits");
    const declaration = document.getText().indexOf("let saved=state('none');");
    assert.notEqual(declaration, -1);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, document.positionAt(declaration + 3), "  ");
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor(() => document.isDirty, Boolean, "dirty editor document");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await document.save(), true);
    await waitFor(
      () => document.getText(),
      (text) => text.includes("let saved = state('none');"),
      "installed VSIX format-on-save",
    );
    assert.match(document.getText(), /var editorProbe = 0;/);
  });

  await step("apply identity-safe no-var code action", async () => {
    const varOffset = document.getText().indexOf("var editorProbe");
    assert.notEqual(varOffset, -1);
    const actions = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      uri,
      new vscode.Range(document.positionAt(varOffset), document.positionAt(varOffset + 3)),
      "quickfix",
    );
    const action = actions.find((candidate) => /no-var/.test(candidate.title));
    assert.ok(action?.edit, "installed VSIX returned no validated no-var action");
    assert.equal(await vscode.workspace.applyEdit(action.edit), true);
    await waitFor(
      () => document.getText(),
      (text) => !text.includes("var editorProbe"),
      "identity-safe code action",
    );
    await waitFor(
      () => vscode.languages.getDiagnostics(uri),
      (items) =>
        !items.some((item) => item.source === "oxlint-tsrx" && item.code === "no-var"),
      "installed VSIX diagnostics after safe action",
    );
    assert.equal(await document.save(), true);
  });
}

module.exports = { run };

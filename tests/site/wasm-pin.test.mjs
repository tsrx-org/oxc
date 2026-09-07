import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

// The committed pin is what oxc.tsrx.dev builds from. This asks GitHub for the
// release it names and checks every byte against it, so a pin that no longer
// resolves is red in CI before it is a static preview in production. It needs
// the network: that is the property under test.
const repoRoot = resolve(import.meta.dirname, "../..");
const releaseBase =
  process.env.OXC_TSRX_WASM_RELEASE_BASE || "https://github.com/tsrx-org/oxc/releases/download";

test("the committed wasm pin resolves to the exact bytes it names", async () => {
  const pin = JSON.parse(await readFile(join(repoRoot, "website-oxc/wasm-pin.json"), "utf8"));
  assert.match(pin.tag, /^wasm-demo-/u, "the pin names a demo engine release");
  for (const [field, name] of [["wasm", "demo-wasm.wasm"], ["worker", "wasi-worker-browser.mjs"]]) {
    const url = `${releaseBase}/${pin.tag}/${name}`;
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    assert.equal(response.status, 200, `${url} responded ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, pin[field].bytes, `${name} length`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin[field].sha256, `${name} sha256`);
  }
});

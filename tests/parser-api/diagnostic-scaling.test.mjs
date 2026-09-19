import assert from "node:assert/strict";
import test from "node:test";

import { parseSync } from "../../packages/toolchain/dist/parser.js";

// Rendering a codeframe needs the line index of the whole source. The adapter
// renders every diagnostic of a file in one batch so that index is built once;
// rendering each diagnostic on its own would rebuild it per diagnostic and turn
// a file with many diagnostics into quadratic work in its length. This test
// grows both the source length and the diagnostic count together, so quadratic
// rendering shows up as time growing with the square of the scale factor.

function fixture(scale) {
  // A long run of blank lines makes the line index expensive, `let x; let x;`
  // is one guaranteed parse diagnostic per statement block, and the TSRX
  // function keeps the file on the projected `.tsrx` route.
  return (
    "\n".repeat(scale * 1024) +
    "{ let x; let x; }\n".repeat(scale) +
    "function View() @{ <div/> }\n"
  );
}

function parseTime(source) {
  const started = process.hrtime.bigint();
  // Redeclared `let` bindings are semantic early errors, so ask for them explicitly.
  const result = parseSync("Scaling.tsrx", source, {
    lang: "tsrx",
    sourceType: "module",
    showSemanticErrors: true,
  });
  const elapsedNs = Number(process.hrtime.bigint() - started);
  return { result, elapsedMs: elapsedNs / 1e6 };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

test("codeframe rendering scales linearly with source length and diagnostic count", (t) => {
  const small = fixture(32);
  const large = fixture(128);

  // Warm the addon and the allocator before timing anything.
  for (let index = 0; index < 3; index += 1) parseTime(large);

  const smallRuns = [];
  const largeRuns = [];
  for (let index = 0; index < 7; index += 1) {
    const { result, elapsedMs } = parseTime(small);
    assert.ok(result.errors.length >= 32, "small fixture must carry many diagnostics");
    assert.ok(result.errors.every((error) => typeof error.codeframe === "string"));
    smallRuns.push(elapsedMs);
    const largeRun = parseTime(large);
    assert.ok(largeRun.result.errors.length >= 128, "large fixture must carry many diagnostics");
    largeRuns.push(largeRun.elapsedMs);
  }

  const smallMs = median(smallRuns);
  const largeMs = median(largeRuns);
  const ratio = largeMs / smallMs;
  t.diagnostic(`small ${smallMs.toFixed(2)} ms, large ${largeMs.toFixed(2)} ms, ratio ${ratio.toFixed(2)}`);
  // The large fixture is 4x the small one in both length and diagnostics. Linear
  // rendering lands near 4x; quadratic rendering lands near 16x. The bound leaves
  // room for a loaded machine without admitting the quadratic case.
  assert.ok(ratio < 9, `4x input took ${ratio.toFixed(2)}x the time; rendering is not linear`);
});

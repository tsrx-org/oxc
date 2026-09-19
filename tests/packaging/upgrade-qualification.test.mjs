import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

// Retained qualification evidence must have been produced on the pinned OXC
// revision and the pinned official tools. A report whose revision string was
// edited without re-running the lane still carries the older tool versions,
// artifact hashes, and timestamps inside it, so this test reads the fields a
// relabel cannot keep consistent.

const root = resolve(import.meta.dirname, "../..");

async function json(relative) {
  return JSON.parse(await readFile(join(root, relative), "utf8"));
}

async function pins() {
  const adapter = await readFile(join(root, "crates/oxc_adapter/src/lib.rs"), "utf8");
  const revision = adapter.match(/pub const OXC_REVISION: &str = "([0-9a-f]{40})"/u)?.[1];
  assert.match(revision ?? "", /^[0-9a-f]{40}$/u, "adapter revision constant");
  const toolchain = await json("packages/toolchain/package.json");
  const alias = (name) => {
    const spec = toolchain.dependencies[name];
    const version = spec.match(/^npm:(?:oxlint|oxfmt)@(\d+\.\d+\.\d+)$/u)?.[1];
    assert.ok(version, `${name} must be an exact npm alias`);
    return version;
  };
  return {
    revision,
    oxlint: alias("oxlint-current"),
    oxfmt: alias("oxfmt-current"),
    tsgolint: toolchain.dependencies["oxlint-tsgolint"],
    packageVersion: toolchain.version,
  };
}

test("the retained Vite+ matrix report was generated on the pinned revision and tools", async () => {
  const { revision, oxlint, oxfmt, packageVersion } = await pins();
  const report = await json("tests/packaging/vite-plus-matrix-report.json");
  assert.equal(report.native.oxcRevision, revision, "native.oxcRevision");
  assert.equal(report.native.version, packageVersion, "native package version");
  const text = JSON.stringify(report);
  assert.ok(text.includes(`oxlint@${oxlint}`) || text.includes(`"${oxlint}"`), `Oxlint ${oxlint} in report`);
  assert.ok(text.includes(`oxfmt@${oxfmt}`) || text.includes(`"${oxfmt}"`), `Oxfmt ${oxfmt} in report`);
  assert.doesNotMatch(text, /8e0ed2ebb96137fb1611cdbd5742d5cb46037d40/u, "superseded revision");
});

test("the retained clean-room report was generated on the pinned revision", async () => {
  const { revision } = await pins();
  const report = await json("docs/acceptance/clean-room-report.json");
  const text = JSON.stringify(report);
  assert.ok(text.includes(revision), "clean-room report names the pinned revision");
  assert.equal(report.matrix?.versions?.oxcRevision ?? revision, revision, "matrix.versions.oxcRevision");
});

test("every aggregate-selected performance report was measured on the pinned revision", async () => {
  const { revision } = await pins();
  const aggregate = await json("docs/acceptance/performance-report.json");
  assert.equal(aggregate.status, "passed");
  for (const [family, selected] of Object.entries(aggregate.results)) {
    const report = await json(selected.path);
    const observed = report.host?.oxcRevision ?? report.build?.oxcRevision ?? report.versions?.oxcTsrx;
    assert.ok(
      typeof observed === "string" && observed.includes(revision),
      `${family}: ${selected.path} was measured on ${observed}, not ${revision}`,
    );
  }
});

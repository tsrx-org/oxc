import assert from "node:assert/strict";
import test from "node:test";
import { acceptedAdvisoriesPresent, blockingAdvisories } from "./audit-policy.mjs";

const accepted = "https://github.com/advisories/GHSA-587h-7wmj-h5pm";

function advisory(severity, url, title = "advisory") {
  return { source: 1, name: "vite-plus", dependency: "vite-plus", title, url, severity, range: "<=1.0.0" };
}

test("an accepted high advisory does not block, and is recorded as present", () => {
  const report = {
    vulnerabilities: {
      "vite-plus": {
        severity: "high",
        via: ["vitest", advisory("high", accepted), advisory("moderate", "https://example.test/m")],
      },
      vitest: { severity: "moderate", via: [advisory("moderate", "https://example.test/v")] },
    },
  };
  assert.deepEqual(blockingAdvisories(report), []);
  assert.deepEqual(acceptedAdvisoriesPresent(report), [accepted]);
});

test("any other high or critical advisory still blocks, even on the same package", () => {
  const report = {
    vulnerabilities: {
      "vite-plus": {
        severity: "critical",
        via: [advisory("high", accepted), advisory("critical", "https://example.test/c", "new")],
      },
      other: { severity: "high", via: [advisory("high", "https://example.test/h", "other")] },
    },
  };
  assert.deepEqual(
    blockingAdvisories(report).map(({ name, severity, url }) => ({ name, severity, url })),
    [
      { name: "vite-plus", severity: "critical", url: "https://example.test/c" },
      { name: "other", severity: "high", url: "https://example.test/h" },
    ],
  );
});

test("a clean report has nothing blocking or accepted", () => {
  assert.deepEqual(blockingAdvisories({ vulnerabilities: {} }), []);
  assert.deepEqual(acceptedAdvisoriesPresent({ vulnerabilities: {} }), []);
});

/**
 * The audit gate the clean-install consumer and the supported Vite+ lanes share:
 * no high or critical advisory, except the ones listed below.
 *
 * An entry here is a reviewed exception, not a silenced category. Each one names
 * the single advisory, why it does not reach this package's supported workflow,
 * and what retires it. Any other high or critical advisory, including a new one
 * against the same package, still fails the gate.
 */

export const acceptedAdvisories = new Map([
  [
    // launch-editor <= 2.14.1, carried by every Vite+ release up to 1.0.0. The
    // existence check it bypasses guards opening a file in an editor from the
    // Vite dev server's error overlay on Windows; lint, format, and check never
    // reach it. Every patched Vite+ is 1.1.0 or later, which needs Node 22.18
    // and is not a supported lane yet (docs/releasing/upgrades.md). Retire this
    // entry when the supported lanes move to Vite+ 1.1.0 or later.
    "https://github.com/advisories/GHSA-587h-7wmj-h5pm",
    "launch-editor fs.existsSync() bypass on Windows (Vite+ <= 1.0.0)",
  ],
]);

const blocking = new Set(["high", "critical"]);

/**
 * Returns every high or critical advisory in an `npm audit --json` report that
 * is not an accepted exception, as `{ name, severity, url, title }`.
 */
export function blockingAdvisories(report) {
  const found = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // A string names another vulnerable package; its own entry carries the advisory.
      if (typeof via === "string") continue;
      if (!blocking.has(via.severity) || acceptedAdvisories.has(via.url)) continue;
      found.push({ name, severity: via.severity, url: via.url, title: via.title });
    }
  }
  return found;
}

/** The accepted advisories the report actually contains, for the proof report. */
export function acceptedAdvisoriesPresent(report) {
  const present = new Set();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "string" && acceptedAdvisories.has(via.url)) present.add(via.url);
    }
  }
  return [...present].sort();
}

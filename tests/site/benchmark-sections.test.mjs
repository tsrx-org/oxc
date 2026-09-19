import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  benchmarksSectionsHtml,
  comparativeChartHtml,
  escapeDatasetHtml,
} from "../../docs/benchmarks-data.mjs";

const root = resolve(import.meta.dirname, "../..");
const families = ["comparative", "native-lint", "native-format", "type-aware", "vite", "editor"];

async function aggregateReport() {
  return JSON.parse(await readFile(join(root, "docs/acceptance/performance-report.json"), "utf8"));
}

async function latestReports() {
  const aggregate = await aggregateReport();
  const latest = new Map();
  for (const family of families) {
    const selected = aggregate.results?.[family]?.path;
    assert.match(selected ?? "", new RegExp(`^benchmarks/${family}/results-\\d+\\.json$`));
    const file = selected.split("/").at(-1);
    latest.set(family, {
      file,
      report: JSON.parse(await readFile(join(root, selected), "utf8")),
    });
  }
  return latest;
}

test("the static benchmark page renders every aggregate-selected release-gate family", async () => {
  const html = await benchmarksSectionsHtml();
  assert.equal((html.match(/<h2 id="/g) ?? []).length, 6);
  for (const id of families) {
    assert.match(html, new RegExp(`<h2 id="${id}">`));
  }
  assert.doesNotMatch(html, /BUDGET FAILURES PRESENT/);
});

test("launch-facing performance links point only at each aggregate-selected report", async () => {
  const latest = await latestReports();

  for (const relative of [
    "README.md",
    "docs/acceptance/matrix.md",
    "docs/architecture/rust-oxc-core.md",
    "docs/integrations/configuration.md",
    "docs/integrations/editor.md",
    "docs/releasing/v0.1.0.md",
  ]) {
    const source = await readFile(join(root, relative), "utf8");
    for (const match of source.matchAll(
      /benchmarks\/(comparative|native-lint|native-format|type-aware|vite|editor)\/(results-\d+\.json)/gu,
    )) {
      assert.equal(match[2], latest.get(match[1]).file, `${relative}: ${match[1]}`);
    }
  }

  for (const [family, prefix] of [
    ["comparative", "Aggregate-selected representative report:"],
    ["native-lint", "Aggregate-selected representative report:"],
    ["native-format", "Aggregate-selected representative report:"],
    ["vite", "Aggregate-selected representative report:"],
  ]) {
    const source = await readFile(join(root, "benchmarks", family, "README.md"), "utf8");
    assert.match(
      source,
      new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\`${latest.get(family).file}\``),
      `benchmarks/${family}/README.md`,
    );
  }
});

test("the matched comparison is honest about absolute timings and frozen ratio gates", async () => {
  const source = await readFile(join(root, "docs", "benchmarks-data.mjs"), "utf8");
  const build = await readFile(join(root, "docs", "build.mjs"), "utf8");
  const siteConfig = await readFile(join(root, "docs", "site.config.mjs"), "utf8");
  const html = await comparativeChartHtml();

  assert.doesNotMatch(source, /data-pass="true"/u);
  assert.match(html, /absolute median wall-clock/u);
  assert.match(html, /frozen ratio gate/u);
  assert.doesNotMatch(build, /Each number is also a release gate/u);
  assert.doesNotMatch(build, /Matched 1,000-file TSX CLI comparison[\s\S]{0,500}dashed line/u);
  assert.doesNotMatch(siteConfig, /Every headline number above[\s\S]*frozen release gate/u);
});

test("the matched comparison publishes the exact ordinary and mixed process routes", async () => {
  const latest = await latestReports();
  const report = latest.get("comparative").report;
  const route = report.validation.routeEvidence;
  const html = await comparativeChartHtml();

  assert.equal(route.ordinaryDispatchEvents, 0);
  assert.equal(route.publicCanonicalNodeChildren, 1);
  assert.equal(route.nativeTsrxChildren, 1);
  assert.equal(route.privateInProcessAdapterChildren, 0);
  assert.match(html, /same Node process with zero TSRX dispatch/u);
  assert.match(
    html,
    new RegExp(
      `${route.publicCanonicalNodeChildren} public canonical Node child, ${route.nativeTsrxChildren} native TSRX child, and ${route.privateInProcessAdapterChildren} private adapter children`,
      "u",
    ),
  );
  assert.doesNotMatch(html, /all-TSX[^.]*native TSRX lane/iu);
  assert.match(html, /Matched cross-tool bars use the same[^.]*TSX files/iu);
  assert.match(html, /separately patterned mixed bar is the paired internal workload/iu);
  assert.doesNotMatch(html, /Bar lengths show[^.]*same[^.]*TSX files/iu);
});

test("public methodology explains fail-closed near-threshold adjudication", async () => {
  // Collapse the markdown's hard line wrapping so phrase assertions cannot
  // fail on where a sentence happens to break.
  const source = (await readFile(join(root, "docs/reference/benchmarks.md"), "utf8")).replace(
    /\s+/gu,
    " ",
  );
  const aggregate = JSON.parse(
    await readFile(join(root, "docs/acceptance/performance-report.json"), "utf8"),
  );
  const html = await benchmarksSectionsHtml();
  assert.match(source, /3% near-threshold band/u);
  assert.match(source, /exactly two additional fresh\s+reports/u);
  assert.match(source, /two[-\s]of[-\s]three/u);
  assert.match(source, /median normalized budget pressure/u);
  assert.match(source, /report-path tie-break/u);
  assert.match(source, /selected representative is red/u);
  // One adjudication paragraph per family whose selected report landed inside
  // the near-threshold band; a run that cleared every band renders none.
  const triggered = Object.values(aggregate.results).filter(
    (family) => family.adjudication?.triggered === true,
  ).length;
  assert.equal((html.match(/Near-threshold adjudication\./gu) ?? []).length, triggered);
  for (const family of ["native-format", "comparative"]) {
    for (const report of aggregate.results[family].adjudication.reports) {
      assert.match(html, new RegExp(report.path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    }
  }
});

test("benchmark tooltip dataset values survive an innerHTML consumer as text", () => {
  const hostile = '<img src=x onerror="window.__benchXss=1">';
  const encoded = escapeDatasetHtml(hostile);
  assert.equal(encoded.includes("<"), false);
  assert.match(encoded, /&amp;lt;img/u);
  assert.match(encoded, /&amp;quot;/u);
});

test("benchmark charts plot retained distributions honestly", async () => {
  const source = await readFile(join(root, "docs", "benchmarks-data.mjs"), "utf8");
  const html = await benchmarksSectionsHtml();

  // Six chart blocks, one figure per numeric gate row, each shipping a
  // build-time ECharts SVG render for the light theme and one for dark.
  assert.equal((html.match(/<div class="bench-chart">/gu) ?? []).length, 6);
  const figures = (html.match(/<figure class="bench-echart"/gu) ?? []).length;
  assert.ok(figures >= 40, `expected one chart per numeric gate row, saw ${figures}`);
  assert.equal((html.match(/class="bench-echart-light"/gu) ?? []).length, figures);
  assert.equal((html.match(/class="bench-echart-dark"/gu) ?? []).length, figures);

  // Every plotted datum in ECharts SSR output carries an ecmeta marker; the
  // retained sample arrays (hundreds of samples, twice for the two themes)
  // must actually be in the SVG, not summarized away.
  const plottedData = (html.match(/ecmeta_ssr_type="chart"/gu) ?? []).length;
  assert.ok(
    plottedData >= 2000,
    `expected the retained sample arrays to appear as plotted marks, saw ${plottedData}`,
  );

  // Gates asserted on a single recorded value must say so instead of faking
  // a distribution.
  assert.match(html, /single measurement per report/u);

  // Ratio gates plot the asserted ratio plus both raw arrays; per-sample
  // ratios are never derived because the runs are not index-paired.
  assert.match(html, /runs are sampled independently, so no per-sample ratios/u);
  assert.match(html, /sampled independently, so no per-sample ratios/u);

  // Every chart names its frozen budget on the dashed markLine strip.
  const budgets = (html.match(/>budget [≤≥] /gu) ?? []).length;
  assert.ok(budgets >= figures, `expected a labeled budget per chart, saw ${budgets}`);

  // Every tooltip payload, including the sample line on the table rows,
  // stays inside the double-escaping contract consumed by app.js.
  assert.match(source, /data-samples="\$\{escapeDatasetHtml\(/u);
  assert.match(html, /data-samples="\d+ samples/u);
});

test("aggregate-selected performance copy cannot retain superseded measurements", async () => {
  const stale = [
    /257\.66 MiB\/s/u,
    /127\.40 MiB\/s/u,
    /827\.9[23] MiB\/s/u,
    /3\.33 ms/u,
    /3\.06 ms/u,
    /256\.61 MiB\/s/u,
    /131\.47 MiB\/s/u,
    /840\.09 MiB\/s/u,
    /3\.22 ms/u,
    /4\.20 ms/u,
    /results-178431(?:677|678|679|680|682|893|894|895|896|898)\d*\.json/u,
    /Latest passing report: `results-178421/u,
  ];
  for (const relative of [
    "docs/releasing/v0.1.0.md",
    "docs/site.config.mjs",
    "benchmarks/native-lint/README.md",
    "benchmarks/native-format/README.md",
    "benchmarks/vite/README.md",
  ]) {
    const source = await readFile(join(root, relative), "utf8");
    for (const pattern of stale) assert.doesNotMatch(source, pattern, relative);
  }
});

test("release headlines are derived from the aggregate-selected measurements", async () => {
  const latest = await latestReports();
  const lintAssertion = (name) =>
    latest.get("native-lint").report.assertions.find((entry) => entry.name === name).observed;
  const formatAssertion = (name) =>
    latest.get("native-format").report.assertions.find((entry) => entry.name === name).observed;
  const editor = latest.get("editor").report;
  const headlines = [
    `${lintAssertion("P02 median scan+copy+parse throughput").toFixed(2)} MiB/s`,
    `${formatAssertion("p04_sequential_median_mib_s").toFixed(2)} MiB/s`,
    `${formatAssertion("p04_default_thread_mib_s").toFixed(2)} MiB/s`,
    `${lintAssertion("P05 fresh-process TSRX p95 latency").toFixed(2)} ms cold lint p95`,
    `${editor.initialOpen.p95Ms.toFixed(2)} ms fresh editor`,
  ];
  const release = await readFile(join(root, "docs/releasing/v0.1.0.md"), "utf8");
  for (const headline of headlines) assert.match(release, new RegExp(headline.replace(".", "\\.")));
});

// Hand-written prose wraps at whatever column the sentence happens to reach,
// so phrase assertions read a whitespace-collapsed copy of the file.
const collapse = (text) => text.replace(/\s+/gu, " ");
const countWord = (count) =>
  ["zero", "one", "two", "three", "four", "five"][count] ?? String(count);

async function proseFixture(relative) {
  const latest = await latestReports();
  const aggregate = await aggregateReport();
  const observed = (family, name) =>
    latest.get(family).report.assertions.find((entry) => entry.name === name).observed;
  return {
    source: collapse(await readFile(join(root, relative), "utf8")),
    relative,
    aggregate,
    lint: (name) => observed("native-lint", name),
    format: (name) => observed("native-format", name),
    typeAware: latest.get("type-aware").report,
    vite: latest.get("vite").report,
    editor: latest.get("editor").report,
    comparative: latest.get("comparative").report,
    // Every family's assertion list is normalized to an array in the
    // aggregate, so a lane's "n/n pass" cell is derivable for all six.
    assertionCount: (family) => aggregate.results[family].assertions.length,
    adjudicationCount: (family) => aggregate.results[family].adjudication?.reports?.length ?? 1,
  };
}

test("the release acceptance matrix keeps every lane row derived from the pinned reports", async () => {
  const fixture = await proseFixture("docs/acceptance/matrix.md");
  const { lint, format, typeAware, vite, editor, comparative } = fixture;
  const lintCount = fixture.assertionCount("native-lint");
  const formatCount = fixture.assertionCount("native-format");
  const comparativeCount = fixture.assertionCount("comparative");

  // Invariants the qualitative half of each cell asserts in words.
  assert.equal(typeAware.invariants.defaultTypeAwareProcesses, 0);
  assert.equal(typeAware.invariants.singleTypeAwareProcesses, 1);
  assert.equal(typeAware.invariants.projectTypeAwareProcesses, 1);
  assert.equal(vite.invariants.nativeTsrxParseCount, 1);
  assert.equal(fixture.aggregate.results.comparative.adjudication.triggered, false);
  assert.equal(fixture.adjudicationCount("comparative"), 1);

  const rows = [
    // Native lint
    `${lint("P02 median scan+copy+parse throughput").toFixed(2)} MiB/s median scan/project/parse`,
    `${lint("P03 CLI one-thread lint throughput").toFixed(2)} MiB/s complete CLI lint`,
    `${lint("P03 end-to-end CLI latency ratio").toFixed(3)}× equivalent-TSX CLI latency`,
    `${lint("P05 fresh-process TSRX p95 latency").toFixed(2)} ms fresh-process p95`,
    `${lintCount}/${lintCount} pass across ${countWord(fixture.adjudicationCount("native-lint"))} adjudication reports`,
    // Native format
    `${format("p04_sequential_median_mib_s").toFixed(2)} MiB/s sequential`,
    `${format("p04_default_thread_mib_s").toFixed(2)} MiB/s default-thread p95`,
    `${format("p04_generalized_control_median_mib_s").toFixed(2)} MiB/s generalized control`,
    `${format("p05_stdin_p95_ms").toFixed(2)} ms fresh-stdin p95`,
    `${format("p07_rss_ratio").toFixed(3)}× complete-output RSS`,
    `${formatCount}/${formatCount} pass across ${countWord(fixture.adjudicationCount("native-format"))} adjudication reports`,
    // Type-aware lint
    `Default syntax ${typeAware.defaultSyntax.p95Ms.toFixed(2)} ms p95 with zero type processes`,
    `one-file type-aware ${typeAware.singleTypeAware.p95Ms.toFixed(2)} ms p95`,
    `two-file project ${typeAware.projectTypeAware.p95Ms.toFixed(2)} ms p95`,
    `one type process per batch`,
    `${fixture.assertionCount("type-aware")}/${fixture.assertionCount("type-aware")} pass`,
    // Vite/Vite+ process boundary
    `Ordinary Oxfmt ${vite.directOrdinaryFormat.p95Ms.toFixed(2)} ms p95 / ${vite.ratios.directOrdinaryFormatVsCanonicalP95.toFixed(3)}× canonical`,
    `mixed lint ${vite.directMixedLint.p95Ms.toFixed(2)} ms p95 / ${vite.ratios.directLintVsCanonicalP95.toFixed(3)}×`,
    `mixed format ${vite.directMixedFormat.p95Ms.toFixed(2)} ms p95 / ${vite.ratios.directFormatVsCanonicalP95.toFixed(3)}×`,
    `Vite+ ${vite.versions.vitePlusCurrent} mixed lint ${vite.vitePlusCurrentMixedLint.p95Ms.toFixed(2)} ms p95`,
    `one native TSRX parse`,
    `${fixture.assertionCount("vite")}/${fixture.assertionCount("vite")} pass`,
    // Incremental editor
    `Fresh open ${editor.initialOpen.medianMs.toFixed(2)} ms median / ${editor.initialOpen.p95Ms.toFixed(2)} ms p95 across ${editor.initialOpen.samples} samples`,
    `diagnostics ${editor.editDiagnostics.p95Ms.toFixed(3)} ms p95`,
    `format ${editor.formatting.p95Ms.toFixed(3)} ms p95`,
    `code action ${editor.codeActions.p95Ms.toFixed(3)} ms p95`,
    `${editor.memory.rssBeforeSoakMiB.toFixed(2)} MiB RSS and ${editor.memory.growthMiB} MiB growth after ${editor.samplePolicy.editSoak.toLocaleString("en-US")} edits`,
    `${fixture.assertionCount("editor")}/${fixture.assertionCount("editor")} pass`,
    // Matched CLI comparison
    `Same ${comparative.corpus.files.toLocaleString("en-US")} explicit TSX files`,
    `ESLint ${comparative.tools.eslint.medianMs.toFixed(2)} ms`,
    `official Oxlint ${comparative.tools.oxlint.medianMs.toFixed(2)} ms`,
    `OXC for TSRX npm CLI ${comparative.tools.oxcTsrx.medianMs.toFixed(2)} ms median`,
    `paired ${Math.round(comparative.corpus.tsrxShare * 100)}% TSRX workload ${comparative.tools.oxcTsrxMixed.medianMs.toFixed(2)} ms / ${comparative.ratios.mixedVsTsx.toFixed(3)}× all-TSX`,
    `All ${comparativeCount} assertions pass in a single unadjudicated fresh report`,
  ];
  for (const row of rows) {
    assert.ok(fixture.source.includes(row), `docs/acceptance/matrix.md is missing: ${row}`);
  }
});

test("the architecture page's measured prose stays derived from the pinned reports", async () => {
  const fixture = await proseFixture("docs/architecture/rust-oxc-core.md");
  const { format, typeAware, editor, comparative } = fixture;
  const scanThroughput = fixture.lint("P02 median scan+copy+parse throughput");
  const slowestRoundTripP95Ms = Math.max(
    editor.editDiagnostics.p95Ms,
    editor.formatting.p95Ms,
    editor.codeActions.p95Ms,
  );

  // "in the hundreds of MiB/s" and "well under a millisecond" are rounded to
  // a magnitude rather than a figure, so they are guarded at the magnitude
  // the sentence claims instead of against an exact value.
  assert.ok(
    scanThroughput >= 100 && scanThroughput < 1000,
    `scan+copy+parse throughput ${scanThroughput} is no longer "in the hundreds of MiB/s"`,
  );
  assert.ok(
    slowestRoundTripP95Ms < 1,
    `slowest editor round-trip p95 ${slowestRoundTripP95Ms} ms is no longer under a millisecond`,
  );

  const claims = [
    `run in the hundreds of MiB/s`,
    `holds ${format("p04_generalized_control_median_mib_s").toFixed(2)} MiB/s on the stress corpus and ${format("p04_sequential_median_mib_s").toFixed(2)} MiB/s on the fast path`,
    `the CLI finishes in about ${Math.round(comparative.tools.oxcTsrx.medianMs)} ms, where official Oxlint takes about ${Math.round(comparative.tools.oxlint.medianMs)} ms and ESLint takes about ${Math.round(comparative.tools.eslint.medianMs)} ms`,
    `Type-aware lint costs roughly ${Math.round(typeAware.singleTypeAware.medianMs)} ms per file`,
    `editor responses stay well under a millisecond after a fresh open of about ${editor.initialOpen.medianMs.toFixed(1)} ms`,
  ];
  for (const claim of claims) {
    assert.ok(
      fixture.source.includes(claim),
      `docs/architecture/rust-oxc-core.md is missing: ${claim}`,
    );
  }
});

test("the editor diagram quotes its latency through a build-time token", async () => {
  const source = await readFile(join(root, "docs/diagrams/editor-session.json"), "utf8");
  assert.match(source, /open to first diagnostics measured \{\{editorInitialOpenMedian\}\} median/u);
  assert.doesNotMatch(source, /\d+(?:\.\d+)?\s*ms/u);
});

test("public benchmark copy names non-comparable boundaries without speedup marketing", async () => {
  const benchmarkSource = await readFile(join(root, "docs/benchmarks-data.mjs"), "utf8");
  const buildSource = await readFile(join(root, "docs/build.mjs"), "utf8");
  assert.doesNotMatch(benchmarkSource, /about .* times a historical/iu);
  assert.doesNotMatch(benchmarkSource, /keystroke in VS Code/iu);
  assert.doesNotMatch(benchmarkSource, /RSS after 100-edit soak/iu);
  assert.doesNotMatch(benchmarkSource, /Lint speed vs stock Oxlint/iu);
  assert.doesNotMatch(benchmarkSource, /typescript-eslint recommended/iu);
  assert.doesNotMatch(benchmarkSource, /median of 3 runs/iu);
  assert.doesNotMatch(benchmarkSource, /same generated .*20%.*tsrx/iu);
  assert.doesNotMatch(buildSource, /oxlint-tsrx keeps that speed/iu);
});

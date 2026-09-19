import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, release as osRelease } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "../..");
const binary = join(root, "target/release/oxc-tsrx");
const defaultSource = join(root, "tests/fixtures/lint/native-lint.tsrx");
const singleRoot = join(root, "tests/fixtures/type-aware/single");
const singleSource = join(singleRoot, "View.tsrx");
const projectRoot = join(root, "tests/fixtures/type-aware/project");
const projectView = join(projectRoot, "View.tsrx");
const projectService = join(projectRoot, "service.tsrx");
const budgets = JSON.parse(
  await readFile(join(root, "benchmarks/type-aware/budgets.json"), "utf8"),
);
const warmups = 5;
const samples = 20;

function run(cwd, args) {
  return new Promise((resolveRun, rejectRun) => {
    const started = performance.now();
    const child = spawn(binary, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (status) => {
      resolveRun({
        status,
        stdout,
        stderr,
        milliseconds: performance.now() - started,
      });
    });
  });
}

function parse(result) {
  const start = result.stdout.indexOf("{");
  assert.notEqual(start, -1, result.stderr || result.stdout);
  return JSON.parse(result.stdout.slice(start));
}

async function measure(factory, expectedStatus) {
  const cold = await factory();
  assert.equal(cold.status, expectedStatus, cold.stderr || cold.stdout);
  for (let index = 0; index < warmups; index += 1) {
    const warmup = await factory();
    assert.equal(warmup.status, expectedStatus, warmup.stderr || warmup.stdout);
  }
  const values = [];
  let output;
  for (let index = 0; index < samples; index += 1) {
    const result = await factory();
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    values.push(result.milliseconds);
    output = parse(result);
  }
  return { coldMs: cold.milliseconds, values, output };
}

async function corpusIdentity(files) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const source = await readFile(file);
    const relative = file.slice(root.length + 1);
    hash.update(relative).update("\0").update(source);
    bytes += source.length;
  }
  return {
    kind: "authored syntax-only, single-file type-aware, and explicit two-file TSRX project fixtures",
    files: files.map((file) => file.slice(root.length + 1)),
    bytes,
    sha256: hash.digest("hex"),
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(measurement) {
  return {
    coldMs: measurement.coldMs,
    rawMs: measurement.values,
    medianMs: percentile(measurement.values, 0.5),
    p95Ms: percentile(measurement.values, 0.95),
  };
}

const defaultSyntax = await measure(
  () => run(root, ["--format=json", "--deny", "no-debugger", defaultSource]),
  1,
);
const singleTypeAware = await measure(
  () => run(singleRoot, ["--format=json", "--type-aware", singleSource]),
  1,
);
const projectTypeAware = await measure(
  () =>
    run(projectRoot, [
      "--format=json",
      "--type-aware",
      projectView,
      projectService,
    ]),
  1,
);
const corpus = await corpusIdentity([defaultSource, singleSource, projectView, projectService]);

const summary = {
  schemaVersion: 1,
  timestamp: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? "unknown",
    osRelease: osRelease(),
  },
  build: {
    profile: "release",
    binary: "target/release/oxc-tsrx",
    oxcRevision: defaultSyntax.output.oxcTsrx.oxcRevision,
  },
  corpus,
  versions: {
    tsgolint: "7.0.2002",
  },
  samplePolicy: {
    coldSamples: 1,
    warmupsAfterCold: warmups,
    measured: samples,
    freshProcessesPerLane: 1 + warmups + samples,
    statistic: "median and nearest-rank p95 over measured fresh native CLI processes; first process retained separately",
  },
  defaultSyntax: summarize(defaultSyntax),
  singleTypeAware: summarize(singleTypeAware),
  projectTypeAware: summarize(projectTypeAware),
  ratios: {},
  invariants: {
    defaultParseCount: defaultSyntax.output.oxcTsrx.parseCount,
    defaultTypeAwareProcesses: defaultSyntax.output.oxcTsrx.typeAwareProcesses,
    singleTypeAwareProcesses: singleTypeAware.output.oxcTsrx.typeAwareProcesses,
    projectTypeAwareProcesses: projectTypeAware.output.oxcTsrx.typeAwareProcesses,
    projectParseCount: projectTypeAware.output.oxcTsrx.parseCount,
  },
  budgets,
  assertions: {},
};
summary.ratios.singleTypeAwareVsDefaultP95 =
  summary.singleTypeAware.p95Ms / summary.defaultSyntax.p95Ms;
summary.assertions = {
  defaultSyntaxP95: summary.defaultSyntax.p95Ms <= budgets.defaultSyntaxP95MsMax,
  singleTypeAwareP95: summary.singleTypeAware.p95Ms <= budgets.singleTypeAwareP95MsMax,
  projectTypeAwareP95: summary.projectTypeAware.p95Ms <= budgets.projectTypeAwareP95MsMax,
  singleTypeAwareCold:
    summary.singleTypeAware.coldMs <= budgets.singleTypeAwareColdMsMax,
  projectTypeAwareCold:
    summary.projectTypeAware.coldMs <= budgets.projectTypeAwareColdMsMax,
  singleTypeAwareRatio:
    summary.ratios.singleTypeAwareVsDefaultP95 <=
    budgets.singleTypeAwareVsDefaultP95RatioMax,
  defaultPathUnchanged:
    summary.invariants.defaultParseCount === budgets.defaultParseCountPerFile &&
    summary.invariants.defaultTypeAwareProcesses === 0,
  oneTypeProcessPerBatch:
    summary.invariants.singleTypeAwareProcesses === budgets.typeAwareProcessesPerBatch &&
    summary.invariants.projectTypeAwareProcesses === budgets.typeAwareProcessesPerBatch &&
    summary.invariants.projectParseCount === 2,
};

const output = join(root, `benchmarks/type-aware/results-${Date.now()}.json`);
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ output, ...summary.assertions, summary }, null, 2));
if (Object.values(summary.assertions).some((passed) => !passed)) process.exitCode = 1;

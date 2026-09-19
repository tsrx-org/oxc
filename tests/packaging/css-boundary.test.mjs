import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const revision = "5a6e37e5cf895143a5b34050c50109c46e2ae96a";

function run(executable, args, input = null) {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(
      executable,
      args,
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
        else resolveRun({ stdout, stderr });
      },
    );
    child.stdin.end(input ?? undefined);
  });
}

async function rustSources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await rustSources(path)));
    else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(path);
  }
  return files;
}

test("KEEP RAW is a pinned, fail-closed CSS shipping decision", async () => {
  const decision = JSON.parse(
    await readFile(join(root, "docs/architecture/css-boundary.json"), "utf8"),
  );
  assert.equal(decision.decision, "KEEP_RAW");
  assert.equal(decision.oxcRevision, revision);
  assert.deepEqual(decision.shippingContract, {
    payloadFidelity: "byte-exact",
    embeddedParser: null,
    embeddedFormatter: null,
    embeddedParseCount: 0,
    embeddedFormatNanoseconds: 0,
    subprocess: false,
    cargoPatch: false,
  });
  assert.equal(decision.upstreamBlocker.formatterCrate, "oxc_formatter_css@0.67.0");
  assert.equal(decision.upstreamBlocker.formatterCratePublished, false);
  assert.equal(decision.upstreamBlocker.parserDependency, "oxc-css-parser@0.0.15");
  assert.match(decision.upstreamBlocker.allocatorConflict, /registry oxc_allocator/u);
  assert.match(decision.upstreamBlocker.requiredUpstreamPatch, /oxc_allocator.*path/u);
  assert.equal(decision.requalifyOnlyWhen.length, 3);
});

test("the product graph has no CSS crate, Cargo patch, or CSS subprocess path", async () => {
  const manifests = [join(root, "Cargo.toml")];
  for (const entry of await readdir(join(root, "crates"), { withFileTypes: true })) {
    if (entry.isDirectory()) manifests.push(join(root, "crates", entry.name, "Cargo.toml"));
  }
  const manifestText = (
    await Promise.all(manifests.map((path) => readFile(path, "utf8")))
  ).join("\n");
  assert.doesNotMatch(manifestText, /\[patch(?:\.|\])/u);
  assert.doesNotMatch(manifestText, /oxc[-_]css|oxc_formatter_css/u);

  const lock = await readFile(join(root, "Cargo.lock"), "utf8");
  assert.doesNotMatch(lock, /name = "(?:oxc-css-parser|oxc_formatter_css)"/u);

  const formattingSources = [
    ...(await rustSources(join(root, "crates/tsrx_format"))),
    ...(await rustSources(join(root, "crates/tsrx_syntax"))),
  ];
  const source = (
    await Promise.all(formattingSources.map((path) => readFile(path, "utf8")))
  ).join("\n");
  assert.doesNotMatch(
    source,
    /std::process::Command|process::Command|tokio::process|Command::new\s*\(|\.spawn\s*\(/u,
  );
});

test("real native formatting preserves CSS bytes and retained evidence reports zero hidden work", async () => {
  const payload = "/* authored  spacing */ .card{color:oklch(62% .2 25);  margin:0  1rem}";
  const input = `export function View() @{<main><style>${payload}</style><p>Hi</p></main>}\n`;
  const executable = join(
    root,
    "target/release",
    process.platform === "win32" ? "oxc-tsrx.exe" : "oxc-tsrx",
  );
  // `fmt` selects the formatter inside the one multi-call native binary.
  const formatted = await run(executable, ["fmt", "--stdin-filepath=View.tsrx"], input);
  assert.equal(formatted.stderr, "");
  assert.match(formatted.stdout, /<style>/u);
  assert.ok(formatted.stdout.includes(payload));

  const reports = (await readdir(join(root, "benchmarks/native-format")))
    .filter((name) => /^results-\d+\.json$/u.test(name))
    .sort((left, right) => Number(left.slice(8, -5)) - Number(right.slice(8, -5)));
  assert.ok(reports.length > 0);
  const latest = JSON.parse(
    await readFile(join(root, "benchmarks/native-format", reports.at(-1)), "utf8"),
  );
  assert.equal(latest.host.oxcRevision, revision);
  const assertion = latest.assertions.find(
    (candidate) => candidate.name === "p04_generalized_no_hidden_embedded_parse",
  );
  assert.deepEqual(
    { observed: assertion?.observed, threshold: assertion?.threshold, pass: assertion?.pass },
    { observed: 1, threshold: 1, pass: true },
  );
});

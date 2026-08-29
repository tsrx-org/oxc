import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const { default: siteConfig } = await import("../../docs/site.config.mjs");
const origin = siteConfig.origin;
const base = siteConfig.base ?? "/";
const trimmedBase = base.replace(/\/$/u, "");
const baseSegments = base.split("/").filter(Boolean);
const siteUrl = `${origin}${base}`;
// The home page canonical drops the trailing slash when the site lives under
// a base path (docs/build.mjs canonicalUrl).
const homeUrl = trimmedBase ? `${origin}${trimmedBase}` : siteUrl;

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      args,
      {
        cwd: root,
        env: options.env ?? process.env,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(stderr || stdout, { cause: error }));
        else resolveRun({ stdout, stderr });
      },
    );
  });
}

async function filesUnder(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(directory);
  return files.sort();
}

async function buildTemporarySite(environment = {}) {
  const outDir = await mkdtemp(join(tmpdir(), "oxc-tsrx-site-"));
  const result = await run(process.execPath, ["docs/build.mjs"], {
    env: { ...process.env, ...environment, OXC_TSRX_DOCS_OUT_DIR: outDir },
  });
  // Site pages live under the base path inside the deploy root; the landing
  // page, robots.txt, and vercel.json stay at the root.
  return { outDir, siteDir: join(outDir, ...baseSegments), result };
}

function request(port, { path = `${trimmedBase}/demo-capabilities.json`, method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const call = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    call.on("error", rejectRequest);
    if (body) call.write(body);
    call.end();
  });
}

async function startDocsServer(environment = {}) {
  const child = spawn(process.execPath, ["docs/serve.mjs", "0"], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const port = await new Promise((resolvePort, rejectPort) => {
    const timeout = setTimeout(() => rejectPort(new Error(`docs server did not start\n${stderr}`)), 10_000);
    const inspect = () => {
      const match = stdout.match(/127\.0\.0\.1:(\d+)/u);
      if (!match) return;
      clearTimeout(timeout);
      resolvePort(Number(match[1]));
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectPort(new Error(`docs server exited ${code}\n${stderr}`));
    });
  });
  return {
    child,
    port,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolveClose) => child.once("exit", resolveClose));
    },
  };
}

test("static launch build has canonical and social metadata on every public page", async () => {
  const { outDir, siteDir, result } = await buildTemporarySite();
  assert.match(result.stdout, new RegExp(`-> ${outDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n$`, "u"));

  const htmlFiles = (await filesUnder(siteDir)).filter((path) => path.endsWith(".html"));
  // The 17 sidebar pages, plus the home page, the playground, and the one
  // supplemental page (the embedded CSS boundary) that is linked to rather than
  // listed. A literal on purpose: adding or removing a public page should be a
  // deliberate edit here, not a number that quietly follows along. It went from
  // 20 to 19 when /integrations/vite-plus was folded into the getting-started
  // guide, and back to 20 when the walkthrough moved out again: that guide was
  // 467 bytes under the page-weight budget with it, so nothing else could be
  // added there. The vercel.json redirect that stood in for the page is gone
  // with it. It dropped to 19 again when /playground was removed, and is back
  // at 20 now that the in-browser engine works and the page is restored. Down
  // to 19 once more with the upstreaming-to-OXC guide retired.
  assert.equal(htmlFiles.length, 19);
  assert.equal(htmlFiles.some((path) => path.endsWith(`${sep}logos.html`)), false);

  for (const path of htmlFiles) {
    const html = await readFile(path, "utf8");
    const pagePath = relative(siteDir, path).split(sep).join("/");
    const canonical =
      pagePath === "index.html" ? homeUrl : `${siteUrl}${pagePath.replace(/\.html$/u, "")}`;
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical}"`), pagePath);
    assert.match(html, /<meta property="og:type" content="website" \/>/u, pagePath);
    assert.match(html, new RegExp(`<meta property="og:url" content="${canonical}"`), pagePath);
    assert.match(html, /<meta property="og:title" content="[^"]+" \/>/u, pagePath);
    assert.match(html, /<meta property="og:description" content="[^"]+" \/>/u, pagePath);
    assert.match(
      html,
      new RegExp(`<meta property="og:image" content="${origin}${base}assets/social-card.png"`),
      pagePath,
    );
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/u, pagePath);
    assert.match(html, /<meta name="twitter:image:alt" content="OXC for TSRX" \/>/u, pagePath);
  }
});

test("static launch build has a scoped base, crawl metadata, and no internal design gallery", async () => {
  const { outDir, siteDir } = await buildTemporarySite();
  const [home, robots, sitemap, playground, capabilities, vercel] = await Promise.all([
    readFile(join(siteDir, "index.html"), "utf8"),
    readFile(join(outDir, "robots.txt"), "utf8"),
    readFile(join(siteDir, "sitemap.xml"), "utf8"),
    readFile(join(siteDir, "playground.html"), "utf8"),
    readFile(join(siteDir, "demo-capabilities.json"), "utf8").then(JSON.parse),
    readFile(join(outDir, "vercel.json"), "utf8").then(JSON.parse),
  ]);
  const escapedBase = trimmedBase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

  assert.match(home, new RegExp(`href="${escapedBase}/guide/getting-started"`, "u"));
  assert.match(home, /href="https:\/\/github\.com\/tsrx-org\/oxc"/u);
  assert.match(home, /href="https:\/\/www\.npmjs\.com\/package\/@tsrx\/oxc"/u);
  assert.doesNotMatch(home, /npmjs\.com\/package\/(?:oxlint-tsrx|oxfmt-tsrx)/u);
  assert.match(home, new RegExp(`href="${escapedBase}/assets/`, "u"));
  assert.match(home, new RegExp(`src="${escapedBase}/assets/`, "u"));
  // No double-applied base prefix anywhere.
  assert.equal(new RegExp(`(?:href|src)="${escapedBase}${escapedBase}/`, "u").test(home), false);

  if (trimmedBase) {
    // The domain root carries the landing page pointing at the docs.
    const landing = await readFile(join(outDir, "index.html"), "utf8");
    assert.match(landing, new RegExp(`href="${escapedBase}"`, "u"));
    assert.match(landing, /prefers-color-scheme: dark/u);
    assert.match(landing, /color-scheme" content="light dark"/u);
  }
  assert.equal(playground.includes("Everything on this page runs the real"), false);
  assert.match(playground, /static preview/u);
  assert.match(playground, /local development server/u);
  assert.match(home, /pre-generated example · static preview/u);
  assert.match(home, /native lint and format run only on the local development server/u);
  assert.doesNotMatch(home, /lint clean · format converged/u);
  assert.equal((await stat(join(siteDir, "assets", "social-card.png"))).isFile(), true);
  await assert.rejects(stat(join(siteDir, "assets", "logos")), /ENOENT/u);

  assert.equal(
    robots,
    `User-agent: *\nAllow: ${base}\nSitemap: ${siteUrl}sitemap.xml\n`,
  );
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/u);
  assert.equal([...sitemap.matchAll(/<loc>/gu)].length, 19);
  assert.match(sitemap, new RegExp(`<loc>${homeUrl}</loc>`));
  assert.equal(sitemap.includes("logos.html"), false);
  assert.equal(sitemap.includes(".html"), false);
  // The build ships the in-browser wasm engine whenever its artifact exists
  // (npm run docs:wasm); the capability contract self-describes either way.
  const wasmEngineBuilt = existsSync(
    join(root, "docs", "tools", "demo-wasm", "dist", "demo-wasm.wasm"),
  );
  assert.deepEqual(capabilities, {
    ok: true,
    mode: wasmEngineBuilt ? "wasm" : "static",
    native: false,
    wasm: wasmEngineBuilt,
    typeAware: false,
    projection: wasmEngineBuilt,
    completions: false,
  });
  assert.equal(vercel.cleanUrls, true);
  assert.equal(vercel.trailingSlash, false);
  assert.deepEqual(vercel.headers, [
    {
      source: "/(.*)",
      headers: [
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
      ],
    },
  ]);
  // Guessless docs are now embedded as static files during the build, so no
  // external rewrite is needed. Verify the rewrites array is empty.
  assert.ok(Array.isArray(vercel.rewrites), "vercel.json should have rewrites array");
  assert.equal(vercel.rewrites.length, 0, "vercel.json should have no rewrites");
});

test("launch build fails closed when the browser WebAssembly artifact is required", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "oxc-tsrx-site-required-wasm-"));
  try {
    await assert.rejects(
      run(process.execPath, ["docs/build.mjs"], {
        env: {
          ...process.env,
          OXC_TSRX_DOCS_OUT_DIR: outDir,
          OXC_TSRX_REQUIRE_WASM: "1",
          OXC_TSRX_WASM_BINARY: join(outDir, "missing.wasm"),
        },
      }),
      /required docs WebAssembly artifact is missing/u,
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test(
  "generated WebAssembly executes the real lint, format, and projection engines",
  { skip: !existsSync(join(root, "docs/tools/demo-wasm/dist/demo-wasm.wasi.cjs")) },
  () => {
    const require = createRequire(import.meta.url);
    const engine = require(join(root, "docs/tools/demo-wasm/dist/demo-wasm.wasi.cjs"));

    const formatted = JSON.parse(
      engine.format("export function T() @{ const value=1; <b>{value}</b>; }"),
    );
    assert.match(formatted.formatted, /const value = 1;/u);

    const linted = JSON.parse(
      engine.lint(
        "export function T() @{ console.log('browser'); <b/>; }",
        JSON.stringify({ config: '{ "rules": { "no-console": "error" } }' }),
      ),
    );
    assert.ok(linted.diagnostics.some((diagnostic) => diagnostic.rule === "no-console"));
    assert.equal(linted.oxcTsrx.parseCount, 1);

    const projected = JSON.parse(engine.project("export function T() @{ <b/>; }", false));
    assert.match(projected.projected, /function T\(\)/u);
    assert.equal(projected.counts.controls, 0);
    assert.ok(Array.isArray(projected.tokens));
  },
);

test("social preview is a 1200 by 630 PNG", async () => {
  const image = await readFile(join(root, "docs", "assets", "social-card.png"));
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
});

test("the generated terminal transcript stays discoverable outside the interactive HTML", async () => {
  const { siteDir } = await buildTemporarySite();
  const [html, markdown, llmsFull, searchIndex] = await Promise.all([
    readFile(join(siteDir, "guide", "getting-started.html"), "utf8"),
    readFile(join(siteDir, "guide", "getting-started.md"), "utf8"),
    readFile(join(siteDir, "llms-full.txt"), "utf8"),
    readFile(join(siteDir, "search-index.json"), "utf8").then(JSON.parse),
  ]);
  const command = "npx oxlint src/Cart.tsrx";
  const diagnostic = "Variable 'total' is declared but never used.";

  assert.ok(html.includes(command));
  assert.ok(html.includes("Variable &#39;total&#39; is declared but never used."));
  for (const artifact of [markdown, llmsFull]) {
    assert.ok(artifact.includes(command));
    assert.ok(artifact.includes(diagnostic));
  }
  for (const artifact of [html, markdown, llmsFull]) {
    assert.doesNotMatch(artifact, /<!-- terminal-demo -->/u);
  }
  assert.match(JSON.stringify(searchIndex), /npx oxlint src\/Cart\.tsrx/u);
  assert.match(JSON.stringify(searchIndex), /Variable 'total' is declared but never used\./u);
});

test("aggregate-selected benchmark evidence survives Markdown, LLM, and search exports", async () => {
  const { siteDir } = await buildTemporarySite();
  const aggregate = JSON.parse(
    await readFile(join(root, "docs", "acceptance", "performance-report.json"), "utf8"),
  );
  const selected = [
    aggregate.results["native-format"].path,
    aggregate.results.comparative.path,
  ];
  const [markdown, llmsFull, searchIndex] = await Promise.all([
    readFile(join(siteDir, "reference", "benchmarks.md"), "utf8"),
    readFile(join(siteDir, "llms-full.txt"), "utf8"),
    readFile(join(siteDir, "search-index.json"), "utf8"),
  ]);

  for (const artifact of [markdown, llmsFull]) {
    assert.doesNotMatch(artifact, /<!-- benchmarks:auto -->/u);
    assert.match(artifact, /Near-threshold adjudication/u);
    assert.match(artifact, /median normalized budget pressure/u);
    for (const report of selected) assert.ok(artifact.includes(report), report);
  }
  for (const report of selected) assert.ok(searchIndex.includes(report), report);
});

test("docs output refuses nonempty, protected, and symlink destinations", async () => {
  const parent = await mkdtemp(join(tmpdir(), "oxc-tsrx-output-guard-"));
  const nonempty = join(parent, "oxc-tsrx-nonempty");
  const sentinel = join(nonempty, "sentinel.txt");
  await mkdir(nonempty);
  await writeFile(sentinel, "keep me");
  await assert.rejects(
    run(process.execPath, ["docs/build.mjs"], {
      env: { ...process.env, OXC_TSRX_DOCS_OUT_DIR: nonempty },
    }),
    /refusing nonempty custom docs output directory/u,
  );
  assert.equal(await readFile(sentinel, "utf8"), "keep me");

  const target = join(parent, "target");
  const link = join(parent, "oxc-tsrx-link");
  await writeFile(join(parent, "target-sentinel.txt"), "outside");
  await writeFile(target, "not a directory");
  await symlink(target, link);
  await assert.rejects(
    run(process.execPath, ["docs/build.mjs"], {
      env: { ...process.env, OXC_TSRX_DOCS_OUT_DIR: link },
    }),
    /refusing symlink docs output directory/u,
  );
  assert.equal(await readFile(target, "utf8"), "not a directory");

  const outside = await mkdtemp(join(root, ".docs-output-outside-"));
  const outsideLeaf = join(outside, "oxc-tsrx-victim");
  const outsideSentinel = join(outsideLeaf, "sentinel.txt");
  const ancestorLink = join(parent, "ancestor-link");
  try {
    await mkdir(outsideLeaf);
    await writeFile(outsideSentinel, "keep me too");
    await symlink(outside, ancestorLink, "dir");
    await assert.rejects(
      run(process.execPath, ["docs/build.mjs"], {
        env: {
          ...process.env,
          OXC_TSRX_DOCS_OUT_DIR: join(ancestorLink, "oxc-tsrx-victim"),
        },
      }),
      /resolves outside the trusted temporary directory/u,
    );
    assert.equal(await readFile(outsideSentinel, "utf8"), "keep me too");
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("loopback demo server rejects rebinding and cross-site work before spawning tools", async () => {
  await run(process.execPath, ["docs/build.mjs"]);
  const temp = await mkdtemp(join(tmpdir(), "oxc-tsrx-docs-server-"));
  const stub = join(temp, "tool-stub.mjs");
  const log = join(temp, "invocations.log");
  await writeFile(
    stub,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.DOCS_STUB_LOG, process.argv.slice(2).join(' ') + '\\n')
let input = ''
const respond = () => setTimeout(() => {
  if (process.argv.some((arg) => arg.includes('stdin-filepath'))) process.stdout.write(input)
  else process.stdout.write(JSON.stringify({ diagnostics: [], number_of_rules: 1, oxcTsrx: { parseCount: 1 } }))
}, 250)
if (process.argv.some((arg) => arg.includes('stdin-filepath'))) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { input += chunk })
  process.stdin.on('end', respond)
} else respond()
`,
  );
  await chmod(stub, 0o755);
  const server = await startDocsServer({
    OXC_TSRX_LINT_BIN: stub,
    OXC_TSRX_FORMAT_BIN: stub,
    DOCS_STUB_LOG: log,
  });
  const sameOrigin = {
    Origin: `http://127.0.0.1:${server.port}`,
    "Sec-Fetch-Site": "same-origin",
  };
  try {
    assert.equal((await request(server.port, { headers: { Host: "attacker.invalid" } })).status, 421);
    assert.equal(
      (
        await request(server.port, {
          path: `${trimmedBase}/api/lint`,
          method: "POST",
          body: "export const value = 1",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(server.port, {
          path: `${trimmedBase}/api/lint`,
          method: "POST",
          headers: { Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" },
          body: "export const value = 1",
        })
      ).status,
      403,
    );
    await assert.rejects(readFile(log, "utf8"), /ENOENT/u);

    const firstFour = Array.from({ length: 4 }, () =>
      request(server.port, {
        path: `${trimmedBase}/api/format`,
        method: "POST",
        headers: sameOrigin,
        body: "export const value=1",
      }),
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    const busy = await request(server.port, {
      path: `${trimmedBase}/api/format`,
      method: "POST",
      headers: sameOrigin,
      body: "export const later=2",
    });
    assert.equal(busy.status, 429);
    assert.ok((await Promise.all(firstFour)).every((response) => response.status === 200));

    const linted = await request(server.port, {
      path: `${trimmedBase}/api/lint`,
      method: "POST",
      headers: sameOrigin,
      body: "export const value = 1",
    });
    assert.equal(linted.status, 200);
    const requestDirectories = (await readdir(join(root, ".docs-demo-tmp"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("request-"));
    assert.equal(requestDirectories.length, 0);

    assert.equal((await request(server.port, { path: "/%ZZ" })).status, 400);
    assert.equal((await request(server.port)).status, 200);
  } finally {
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
});

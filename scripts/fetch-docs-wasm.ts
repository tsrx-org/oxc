// Put the playground's WebAssembly demo engine in place for a build that cannot
// compile it.
//
// https://oxc.tsrx.dev is a Vercel project rooted at website-oxc/, built by
// Vercel's own git integration on Vercel's image. That image has no cargo and no
// wasm32-wasip1-threads target, so `pnpm run docs:wasm` can never run there. The
// engine is instead built and *proved* once, on GitHub Actions, and published to
// the rolling `wasm-demo-latest` release; the same workflow commits a pin
// (website-oxc/wasm-pin.json) naming the exact bytes it published. That commit
// is what tells Vercel to rebuild, and this script is what turns the pin back
// into files:
//
//   .github/workflows/site-artifact.yml   builds, proves, uploads, pins
//   website-oxc/wasm-pin.json             tag + inputs hash + sha256 of each byte
//   this script                           downloads and verifies against the pin
//
// Three rules shape everything below.
//
// It never fails the site build. A missing pin, a download that will not come,
// bytes that do not match their hash: each one prints one line and exits 0.
// docs/build.mjs detects the engine by the presence of
// docs/tools/demo-wasm/dist/demo-wasm.wasm and renders the static preview
// contract without it (docs/build.mjs, `wasmDemo`), so the correct degradation
// is a site that builds and says the demo is unavailable -- never a red deploy.
// The exit code matters: website-oxc/package.json runs this script and the site
// build in one `&&` chain, so a non-zero exit here is a failed deploy.
//
// It refuses bytes that do not match the pin, and only those. sha256 and byte
// length are checked on every download and a mismatch installs nothing --
// integrity is fail-closed and this file must keep it that way.
//
// A stale pin is NOT an integrity failure, and does not take the demo down.
// Owner directive, 2026-08-29, after this cost the live site the demo more than
// once. The pin also carries a hash of the sources the engine was compiled
// from, and that hash disagrees with the checkout on every merge that touches
// crates/tsrx_* or docs/tools/demo-wasm, because the workflow's pin-refresh
// push is rejected by branch protection and lands late or not at all. Refusing
// on that mismatch turned an ordinary merge into a silent outage:
// oxc.tsrx.dev fell back to mode:"static" with nothing red anywhere. So a
// mismatch now prints a loud warning and installs the pinned engine anyway.
// The bytes are still exactly the bytes CI proved; they are merely older than
// the checkout, which is strictly better than no engine at all. The known cost
// is skew -- demo-panel JS newer than the engine it drives -- and there is no
// version handshake between the two to catch it (docs/demo-wasm-engine-entry.mjs
// re-exports lint/format/project straight off the module), so skew shows up as
// a panel-side error rather than a clean fallback. That risk was weighed and
// accepted against a certain outage.
//
// The inputs hash therefore has exactly one remaining job: telling a reader
// which engine they are looking at. It still lives here rather than in the
// workflow because the workflow authors the pin by calling this same file with
// --print-inputs-hash, so the two definitions cannot drift.
//
// Deliberately repo-only: the hash covers tracked source, not the rustc that
// compiled it. Vercel's builder cannot know which compiler CI used, and it does
// not need to -- the pin's sha256s are the byte-level truth, and the hash only
// answers the coarser question of whether these bytes were built from this tree.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pinPath = "website-oxc/wasm-pin.json";
const outputDir = "docs/tools/demo-wasm/dist";
// Overridable so the download can be pointed at a local server: the fallback
// policy above is only believable if it is tested, and tests/site/
// stale-pin-fallback.test.mjs cannot reach a GitHub release. Unset in every
// real build, where the bytes come from the release named by the pin.
const releaseBase =
  process.env.OXC_TSRX_WASM_RELEASE_BASE || "https://github.com/tsrx-org/oxc/releases/download";

// Both files land in docs/tools/demo-wasm/dist/ and neither is optional: the
// engine bundle reaches the worker through a relative URL that the worker entry
// hard-codes as a sibling of the binary (docs/demo-wasm-worker-entry.mjs).
const assets = [
  { field: "wasm", name: "demo-wasm.wasm" },
  { field: "worker", name: "wasi-worker-browser.mjs" },
];

// Every input the compiled engine is a function of, as tracked source. The
// demo-wasm crate itself, the three tsrx_* crates it links, and the toolchain
// file that picks the compiler.
const hashPatterns = [
  "docs/tools/demo-wasm/**",
  "crates/tsrx_format/**",
  "crates/tsrx_lint/**",
  "crates/tsrx_syntax/**",
  "rust-toolchain.toml",
];

// Build output, never source. docs/tools/demo-wasm/.gitignore ignores exactly
// these three names, so skipping them here is the same set of files `git
// ls-files` would report -- computed without needing a .git directory, which a
// Vercel build does not have.
const hashIgnore = ["**/dist/**", "**/node_modules/**", "**/target/**", "**/.DS_Store"];

// A reason to leave the playground on its static preview, as opposed to a fault.
class Skip extends Error {}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

async function computeInputsHash() {
  // Imported here rather than at module scope so that a checkout whose
  // dependencies are missing degrades into a skip instead of a crash.
  const { glob } = await import("tinyglobby");
  const files = await glob(hashPatterns, {
    cwd: root,
    dot: true,
    absolute: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: hashIgnore,
  });
  if (files.length === 0) {
    throw new Error(`no engine sources found under ${root}`);
  }
  // Path and content both, so that a rename is a different hash. Sorted by code
  // unit, which is stable across platforms and locales, unlike readdir order.
  files.sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const contents = await readFile(join(root, file));
    digest.update(file);
    digest.update("\0");
    digest.update(createHash("sha256").update(contents).digest("hex"));
    digest.update("\n");
  }
  return digest.digest("hex");
}

async function readPin() {
  let source;
  try {
    source = await readFile(join(root, pinPath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Skip(
        `no ${pinPath} yet -- no run of site-artifact.yml has published an engine for this site`,
      );
    }
    throw error;
  }
  let pin;
  try {
    pin = JSON.parse(source);
  } catch (error) {
    throw new Skip(`${pinPath} is not valid JSON: ${describe(error)}`);
  }
  if (typeof pin?.tag !== "string" || pin.tag === "") {
    throw new Skip(`${pinPath} names no release tag`);
  }
  if (typeof pin.inputsHash !== "string" || pin.inputsHash === "") {
    throw new Skip(`${pinPath} carries no inputs hash`);
  }
  for (const asset of assets) {
    const entry = pin[asset.field];
    if (typeof entry?.sha256 !== "string" || entry.sha256 === "" || !Number.isInteger(entry.bytes)) {
      throw new Skip(`${pinPath} does not describe ${asset.name}`);
    }
  }
  return pin;
}

async function download(url, expected, name) {
  let response;
  try {
    // A build must not hang on a download it can do without.
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new Skip(`${name} could not be downloaded: ${describe(error)}`);
  }
  if (!response.ok) {
    throw new Skip(`${url} responded ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expected.bytes) {
    throw new Skip(`${name} is ${bytes.length} bytes, the pin says ${expected.bytes}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected.sha256) {
    throw new Skip(`${name} hashes to ${sha256}, the pin says ${expected.sha256}`);
  }
  return bytes;
}

async function fetchPinnedEngine() {
  const pin = await readPin();
  const sourceCommit =
    typeof pin.sourceCommit === "string" && pin.sourceCommit !== ""
      ? pin.sourceCommit.slice(0, 7)
      : "an unrecorded commit";

  // Advisory from here on. Neither a mismatch nor a failure to compute it stops
  // the install; both only decide what gets printed. See the staleness note at
  // the top of this file -- the only thing that can stop an install is a byte
  // that does not match the pin.
  let inputsHash;
  try {
    inputsHash = await computeInputsHash();
  } catch (error) {
    console.warn(
      `fetch-docs-wasm: WARNING -- freshness unknown: the engine sources could not be hashed ` +
        `(${describe(error)}). Installing the pinned engine built from ${sourceCommit} anyway; ` +
        `its sha256s are still checked below.`,
    );
  }
  if (inputsHash !== undefined && inputsHash !== pin.inputsHash) {
    console.warn(
      `fetch-docs-wasm: WARNING -- stale pin: engine built from ${sourceCommit} ` +
        `(inputs ${pin.inputsHash.slice(0, 12)}), checkout is ${inputsHash.slice(0, 12)}. ` +
        `Installing the last engine CI proved, so the playground stays live on older ` +
        `engine code; a fresh pin from site-artifact.yml clears this.`,
    );
  }

  // Downloaded and verified in full before anything is written, so that a
  // failure half way through cannot leave a partial engine on disk for
  // docs/build.mjs to find and believe.
  const downloaded = [];
  for (const asset of assets) {
    downloaded.push({
      ...asset,
      bytes: await download(`${releaseBase}/${pin.tag}/${asset.name}`, pin[asset.field], asset.name),
    });
  }

  await mkdir(join(root, outputDir), { recursive: true });
  for (const asset of downloaded) {
    await writeFile(join(root, outputDir, asset.name), asset.bytes);
  }

  const sizes = downloaded.map((asset) => `${asset.name} ${asset.bytes.length} bytes`).join(", ");
  console.log(
    `fetch-docs-wasm: demo engine in place from ${pin.tag} (${sizes}), built from ${sourceCommit}`,
  );
}

const options = process.argv.slice(2);
const printInputsHash = options.length === 1 && options[0] === "--print-inputs-hash";
if (options.length > 0 && !printInputsHash) {
  throw new Error(`unsupported option(s): ${options.join(", ")}`);
}

if (printInputsHash) {
  // The workflow's half of the contract, and the one caller that must fail
  // hard: site-artifact.yml runs this under `set -e` to author the pin, and a
  // hash silently defaulted to nothing would write a pin that reports every
  // later build as stale. Nothing about the fallback below applies here.
  process.stdout.write(`${await computeInputsHash()}\n`);
} else {
  try {
    await fetchPinnedEngine();
  } catch (error) {
    // Reaching here now means the pin is unusable or its bytes did not verify,
    // never that the pin is merely old. Exit 0 all the same: the site must
    // build and say the demo is unavailable rather than fail the deploy.
    const reason = error instanceof Skip ? error.message : `unexpected failure: ${describe(error)}`;
    console.log(`fetch-docs-wasm: no demo engine, ${reason}`);
    console.log("fetch-docs-wasm: the playground will render its static preview instead.");
  }
}

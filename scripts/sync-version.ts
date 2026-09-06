#!/usr/bin/env node
// Propagate the root package.json version across every place in this repository
// that carries it as literal text.
//
// `bumpp` rewrites the `version` field of a manifest and nothing else. That is a
// small fraction of this repository's version surface: the toolchain package
// pins all eight `@tsrx/oxc-*` platform packages to the exact version,
// two more manifests pin `@tsrx/oxc` itself, the Cargo workspace carries its own
// version, `packages/toolchain/src/` is authored source and
// `packages/toolchain/dist/` is committed build output, and eighteen test files
// assert or install a literal version string.
// Miss one of those and the cut still builds, still passes most of the suite,
// and ships a tarball whose pins point at versions that do not exist.
//
// So this script is deliberately not a repo-wide search and replace. Every
// location it touches is declared below, with the exact shape it expects and
// how many times that shape must occur. If a declared location is missing, has
// moved, or has changed shape, the script fails and names it rather than
// quietly updating fewer files than it should.
//
// A declaration list is only as good as its proof that it is exhaustive, so
// every declared file also goes through the residual backstop below
// (`undeclaredInText` / `undeclaredInJson`). That backstop reads a version the
// way a reader does rather than the way a `String.indexOf` does: `0.1.4`,
// `0\.1\.4` inside a regex literal, `0[.]1[.]4`, and any mixture of those are
// all the same version to it. A version reference that no slot covers fails the
// run and names its file, line and spelling. That is what turns "76 locations
// all carry 0.1.4" from a statement about this script's own declarations into a
// statement about the files.
//
// Usage:
//   node scripts/sync-version.ts            rewrite every declared location
//   node scripts/sync-version.ts --check    verify only; exit 1 and name any
//                                            location still carrying a stale
//                                            version (this is the CI gate)
//   node scripts/sync-version.ts --version 1.0.0
//                                            use an explicit target instead of
//                                            the root package.json version
//
// What this script deliberately does NOT touch:
//
//   * `Cargo.lock`, `licenses/rust-dependencies.json`, `licenses/RUST_DEPENDENCIES.md`,
//     `pnpm-lock.yaml`, `packages/vscode/licenses/*`, `docs/terminal-transcripts.json`
//     and `docs/acceptance/performance-report.json`. Those are generated, and a
//     text substitution would desynchronise them from the checksums and hashes
//     they also carry. `docs/releasing/publish-runbook.md` lists the command
//     that regenerates each one, in the order they have to run.
//
//   * `docs/releasing/v0.1.0-launch.json`. Its `version` field is a launch
//     identity marker, not a per-release manifest. It is read in exactly one
//     place, `tests/release/launch-contract.test.mjs`, which pins it to the
//     literal `0.1.0`.
//
//   * `docs/releasing/publish-runbook.md` and the historical release notes.
//     Their version references are true statements about what is already on the
//     registry. Rewriting them would turn accurate history into a lie.
//
//   * `benchmarks/**/results-*.json`. Those are dated evidence files recording
//     what a specific binary measured. They are history too.
//
// The lockstep backstop is `pnpm run test:release`
// (`tests/release/launch-contract.test.mjs`), which reads the root manifest at
// runtime and asserts every package manifest equals it. If this script ever
// drifts from the real surface, that test is what catches it.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * How a version can be SPELLED in this repository. Both spellings below mean
 * the same version; they differ only in how their separators are written.
 *
 *   plain         0.1.4        a manifest pin, a constant, a Cargo version
 *   regexEscaped  0\.1\.4      the same version inside a regular expression
 *                              literal, which is how the packaging tests assert
 *                              CLI output
 *
 * A slot declares which spelling it expects and is rewritten in that same
 * spelling, so an escaped assertion stays escaped and keeps matching after a
 * cut. Before this existed, `tests/packaging/provider-discovery.test.mjs`
 * asserted `@tsrx\/oxc@0\.1\.4` and no slot could see it.
 */
const SPELLINGS: any = {
  plain: {
    label: "plain",
    dot: String.raw`\.`,
    render: (version) => version,
  },
  regexEscaped: {
    label: "regex-escaped",
    dot: String.raw`\\\.`,
    render: (version) => version.replaceAll(".", String.raw`\.`),
  },
};

/** The shape a version string is allowed to have, written in one spelling. */
const semverIn = ({ dot }) =>
  String.raw`\d+${dot}\d+${dot}\d+(?:-[0-9A-Za-z]+(?:${dot}[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:${dot}[0-9A-Za-z]+)*)?`;

/** The shape a version string is allowed to have anywhere in this repository. */
const SEMVER = semverIn(SPELLINGS.plain);

/**
 * Reduce any spelling back to the version it means: `0\.1\.4` and `0[.]1[.]4`
 * both become `0.1.4`. Comparisons and reports always use this form, so a slot
 * and the backstop agree on what version a piece of text carries no matter how
 * its dots are written.
 */
const canonical = (raw) => raw.replace(/[\\[\]]/g, "");

/**
 * Build a matcher for one kind of version slot. `<V>` marks the single capture
 * group that holds the version; everything else in the source is context that
 * has to be present for the slot to count as found.
 *
 * The `d` flag is load-bearing: it gives exact capture indices, so the rewrite
 * splices the version out by position instead of doing a nested string replace
 * that could hit the wrong occurrence inside a multi-line match.
 */
const slot = (source, spelling = SPELLINGS.plain) => {
  const regexp: any = new RegExp(source.replaceAll("<V>", `(${semverIn(spelling)})`), "gd");
  regexp.spelling = spelling;
  return regexp;
};

// ---------------------------------------------------------------------------
// Slot shapes
// ---------------------------------------------------------------------------

/** `"@tsrx/oxc": "1.0.0"` — a dependency pin in a manifest or a test fixture. */
const DEP = () => slot(String.raw`"@tsrx/oxc":\s*"<V>"`);

/** `'@tsrx/oxc': '1.0.0'` — the same pin inside a single-quoted template source. */
const DEP_SINGLE_QUOTED = () => slot(String.raw`'@tsrx/oxc':\s*'<V>'`);

/**
 * `@tsrx\/oxc@1\.0\.0` — the npm-style spec the CLI prints, asserted inside a
 * regex literal, so every dot arrives escaped and the scope separator usually
 * does too. Rewritten in the same spelling. The `\\?` before the slash accepts
 * both spellings, because a `/` only has to be escaped inside a regex literal
 * and the same spec also shows up in plain strings.
 */
const CLI_SPEC_IN_REGEX = () =>
  slot(String.raw`@tsrx\\?/oxc@<V>`, SPELLINGS.regexEscaped);

/** `assert.equal(manifest.dependencies["@tsrx/oxc"], "1.0.0")` */
const ASSERT_DEP = () => slot(String.raw`dependencies\["@tsrx/oxc"\],\s*"<V>"`);

/** `assert.equal(<something>.version, "1.0.0")` */
const ASSERT_VERSION = () => slot(String.raw`\.version,\s*"<V>"`);

/** `assert.equal(record.packageVersion, "1.0.0")` */
const ASSERT_PACKAGE_VERSION = () => slot(String.raw`\.packageVersion,\s*"<V>"`);

/** `providerVersion: "1.0.0"` inside an `oxcTsrxCompatibility` block. */
const PROVIDER_VERSION = () => slot(String.raw`providerVersion:\s*"<V>"`);

/** `const version = "1.0.0";` — the module constant in native-version.test.mjs. */
const CONST_VERSION = () => slot(String.raw`const version = "<V>";`);

/** `["@tsrx/oxc-darwin-arm64", "1.0.0"],` — an optionalDependencies assertion. */
const NATIVE_PIN_ENTRY = () =>
  slot(String.raw`"@tsrx/oxc-[a-z0-9-]+",\s*"<V>"`);

/**
 * The bare third element of a `[directory, name, version]` tuple built from
 * `nativePackageName(platform)` in the provider matrix lanes.
 */
const NATIVE_TUPLE_VERSION = () =>
  slot(String.raw`nativePackageName\(platform\),\s*\n\s*"<V>",`);

/** The synthesised platform-package manifest fixture in native-package.test.mjs. */
const NATIVE_FIXTURE_VERSION = () =>
  slot(String.raw`name: nativePackageName\(target\),\s*\n\s*version: "<V>",`);

/**
 * The compatibility facade fixture: a package literally named `oxlint` that is
 * the `@tsrx/oxc` bridge, so its own version tracks `@tsrx/oxc` rather than
 * oxlint.
 */
const FACADE_MANIFEST_VERSION = () =>
  slot(
    String.raw`name: "oxlint",\s*\n\s*version: "<V>",\s*\n\s*bin: \{ oxlint: "\./bin/oxlint" \},\s*\n\s*oxcTsrxCompatibility:`,
  );

/** An inline one-line `@tsrx/oxc` manifest written into a throwaway fixture. */
const INLINE_TOOLCHAIN_MANIFEST = () =>
  slot(String.raw`name: "@tsrx/oxc", version: "<V>"`);

/** `[workspace.package]` / `version = "1.0.0"` in the Cargo workspace root. */
const CARGO_WORKSPACE_VERSION = () =>
  slot(String.raw`\[workspace\.package\]\s*\nversion = "<V>"`);

/** `const PACKAGE_VERSION = "1.0.0";` in the committed toolchain source. */
const PACKAGE_VERSION_CONST = () =>
  slot(String.raw`const PACKAGE_VERSION = "<V>";`);

// ---------------------------------------------------------------------------
// The declared surface
// ---------------------------------------------------------------------------

/**
 * JSON targets are edited through the parsed object at an explicit key path, so
 * a renamed or removed key is an error rather than a silent miss. Every file
 * here round-trips through `JSON.stringify(value, null, 2)` byte for byte, and
 * the script asserts that before it writes.
 */
const jsonTargets: any[] = [
  {
    file: "packages/toolchain/package.json",
    paths: [
      ["version"],
      ["optionalDependencies", "@tsrx/oxc-darwin-arm64"],
      ["optionalDependencies", "@tsrx/oxc-darwin-x64"],
      ["optionalDependencies", "@tsrx/oxc-linux-arm64-gnu"],
      ["optionalDependencies", "@tsrx/oxc-linux-arm64-musl"],
      ["optionalDependencies", "@tsrx/oxc-linux-x64-gnu"],
      ["optionalDependencies", "@tsrx/oxc-linux-x64-musl"],
      ["optionalDependencies", "@tsrx/oxc-win32-arm64-msvc"],
      ["optionalDependencies", "@tsrx/oxc-win32-x64-msvc"],
    ],
  },
  {
    file: "packages/tsrx-core-compat/package.json",
    paths: [["version"], ["dependencies", "@tsrx/oxc"]],
  },
  {
    file: "packages/vscode/package.json",
    paths: [["version"], ["dependencies", "@tsrx/oxc"]],
  },
  {
    // Written by scripts/build-parser-native.ts, but only this one field moves
    // on a version bump: the addon binary itself is not version stamped, so its
    // `bytes` and `sha256` stay put and a one-field rewrite is safe. The addon
    // is a host-specific local build artifact and is not tracked, so a fresh
    // checkout legitimately has neither file; the pin applies only when the
    // artifact exists.
    file: "packages/toolchain/parser.node.json",
    paths: [["packageVersion"]],
    optional: true,
  },
];

/**
 * Text targets. `slots` declares every shape the file is expected to contain
 * and exactly how many times. `historical` lists the versions the file is
 * allowed to keep a reference to outside every slot, because they are
 * statements about the past rather than pins.
 *
 * `historical` names the version rather than counting the references, so it
 * stays true across a cut: before 1.0.0 ships, a historical `0.1.4` and a
 * pinned `0.1.4` sit in the same file and have to be told apart by position;
 * after it ships, the pin reads 1.0.0 and the historical reference still reads
 * 0.1.4, and the declaration has not changed. A historical entry that silently
 * gets rewritten to the new version therefore fails the run too.
 */
const textTargets: any[] = [
  { file: "Cargo.toml", slots: [[CARGO_WORKSPACE_VERSION, 1]] },
  { file: "packages/toolchain/src/parser.ts", slots: [[PACKAGE_VERSION_CONST, 1]] },
  { file: "packages/toolchain/dist/parser.js", slots: [[PACKAGE_VERSION_CONST, 1]] },
  {
    file: "docs/generate-transcripts.mjs",
    slots: [[DEP_SINGLE_QUOTED, 1]],
    // The comment above the fixture records which published release the two
    // captured demos were checked against by hand. That check happened at that
    // version and stays true after this one ships.
    historical: ["0.1.4"],
  },

  { file: "tests/editor/official-oxc-toolchain-run.mjs", slots: [[DEP, 4]] },
  { file: "tests/editor/oxlint-multiplexer.test.mjs", slots: [[DEP, 2]] },
  { file: "tests/editor/package.test.mjs", slots: [[ASSERT_DEP, 1]] },
  { file: "tests/editor/vscode-run.mjs", slots: [[DEP, 1]] },
  {
    file: "tests/markless-dropin/facade.test.mjs",
    slots: [
      [ASSERT_VERSION, 1],
      [ASSERT_DEP, 1],
    ],
  },
  { file: "tests/packaging/clean-install.test.mjs", slots: [[DEP, 1]] },
  {
    file: "tests/packaging/native-package.test.mjs",
    slots: [
      [NATIVE_FIXTURE_VERSION, 1],
      [ASSERT_VERSION, 2],
      [ASSERT_PACKAGE_VERSION, 1],
    ],
  },
  { file: "tests/packaging/native-version.test.mjs", slots: [[CONST_VERSION, 1]] },
  {
    file: "tests/packaging/provider-discovery.test.mjs",
    slots: [
      [DEP, 5],
      [CLI_SPEC_IN_REGEX, 1],
    ],
  },
  {
    file: "tests/packaging/provider-matrix.test.mjs",
    slots: [
      [DEP, 2],
      [NATIVE_TUPLE_VERSION, 2],
    ],
  },
  {
    file: "tests/packaging/public-package-metadata.test.mjs",
    slots: [
      [ASSERT_VERSION, 1],
      [NATIVE_PIN_ENTRY, 8],
    ],
  },
  { file: "tests/packaging/released-host-install.test.mjs", slots: [[DEP, 6]] },
  {
    file: "tests/packaging/toolchain-compat.test.mjs",
    slots: [
      [DEP, 2],
      [PROVIDER_VERSION, 1],
    ],
  },
  {
    file: "tests/packaging/toolchain-package.test.mjs",
    slots: [
      [DEP, 8],
      [FACADE_MANIFEST_VERSION, 1],
      [PROVIDER_VERSION, 1],
      [INLINE_TOOLCHAIN_MANIFEST, 2],
    ],
  },
  { file: "tests/packaging/vite-plus-matrix.test.mjs", slots: [[DEP, 1]] },
  { file: "tests/packaging/vscode-artifact.test.mjs", slots: [[ASSERT_VERSION, 1]] },
  { file: "tests/plugins/custom-js-plugins-doc.test.mjs", slots: [[DEP, 1]] },
  { file: "tests/vite/physical-consumer.mjs", slots: [[DEP, 1]] },
  // Docs and README install commands say `@tsrx/oxc@latest` (owner decision,
  // 2026-08-14) and are no longer declared here. The trade this accepts is
  // pnpm's release-age hold: for about a day after a publish, `@latest`
  // resolves the previous release. tests/site/documented-version-pin.test.mjs
  // enforces the dist-tag form so stale pins cannot creep back in.
];

// ---------------------------------------------------------------------------

class SyncError extends Error {}

function fail(message) {
  throw new SyncError(message);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

async function readTarget(file) {
  const absolute = path.join(root, file);
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(
        `${file}: declared in scripts/sync-version.ts but not present. Either the file ` +
          `moved and this script has to follow it, or the declaration is stale.`,
      );
    }
    throw error;
  }
}

/** Every match of one slot shape, with exact capture bounds. */
function findSlots(text, regexp) {
  const found = [];
  const spelling = regexp.spelling ?? SPELLINGS.plain;
  regexp.lastIndex = 0;
  let match;
  while ((match = regexp.exec(text)) !== null) {
    const [start, end] = match.indices[1];
    found.push({ start, end, raw: match[1], value: canonical(match[1]), spelling });
    if (match[0].length === 0) regexp.lastIndex += 1;
  }
  return found;
}

// ---------------------------------------------------------------------------
// The residual backstop
// ---------------------------------------------------------------------------

/**
 * A separator between version parts, however it is written: a bare dot, a dot
 * escaped for a regex, or a dot inside a character class, escaped or not. Each
 * position is matched independently, so `0\.1.4` — escaped in one place and not
 * the other — is still read as `0.1.4`.
 */
const LOOSE_DOT = String.raw`(?:\\?\.|\[\\?\.\])`;

/**
 * Every version-shaped run of text in a file, in any spelling.
 *
 * The boundaries reject a longer number that merely starts or ends the same way
 * (`10.1.4`, `0.1.40`, `0.1.4.2`) while still finding the real thing at the end
 * of a sentence (`... @tsrx/oxc 0.1.4.`) or in front of a file extension
 * (`tsrx-oxc-0.1.4.tgz`).
 */
function findVersions(text) {
  const regexp = new RegExp(
    String.raw`(?<![\d.\\])(\d+${LOOSE_DOT}\d+${LOOSE_DOT}\d+(?:-[0-9A-Za-z.\\]+)?(?:\+[0-9A-Za-z.\\]+)?)(?!\d)(?!${LOOSE_DOT}\d)`,
    "g",
  );
  const found = [];
  for (const match of text.matchAll(regexp)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      raw: match[1],
      value: canonical(match[1]),
    });
  }
  return found;
}

/**
 * Names whose version is this repository's version: the toolchain itself, the
 * eight platform packages and the core-compat facade that share its scope, the
 * VS Code extension (still spelled `oxc-tsrx-vscode`, because a Marketplace
 * identity cannot be renamed), and the `oxlint` compatibility facade.
 */
const OUR_PACKAGE =
  /^(?:@tsrx\/oxc(?:-[A-Za-z0-9._-]+)?|oxc-tsrx-vscode|oxlint)$/;

/** A key like `version`, `packageVersion`, `providerVersion`, `PACKAGE_VERSION`. */
const VERSION_FIELD = /version$/i;

/**
 * What a version reference belongs to, read from the text immediately before
 * it. Only the punctuation that glues a name to its version may sit in between,
 * so a package name three lines up never claims a version that is not its own.
 *
 *   "vite": "5.0.0"        pin        -> vite
 *   '@tsrx/oxc': '0.1.4'   pin        -> @tsrx/oxc
 *   @tsrx/oxc@0\.1\.4      spec       -> @tsrx/oxc
 *   version = "0.1.4"      assignment -> version
 */
function ownerOf(text, start) {
  const window = text.slice(Math.max(0, start - 160), start);
  const pin = /["']([@A-Za-z0-9._/-]+)["']\s*:\s*["']$/.exec(window);
  if (pin) return { name: pin[1], kind: "pin" };
  const spec = /(?<![A-Za-z0-9._/@-])([@A-Za-z][@A-Za-z0-9._/-]*)@$/.exec(window);
  if (spec) return { name: spec[1], kind: "spec" };
  const assignment = /([@A-Za-z0-9._$-]+)\s*[:=]\s*["'`]?$/.exec(window);
  if (assignment) return { name: assignment[1], kind: "assignment" };
  return null;
}

/**
 * Whether a version reference has to be declared, given what owns it.
 *
 * This is the one thing the backstop has to get right to be usable, because
 * these files are full of third-party versions and some of them collide with
 * ours. `tests/packaging/provider-discovery.test.mjs` alone pins four fixture
 * providers at `1.0.0` and stamps a fifth fixture manifest `version: "1.0.0"` —
 * which is exactly the version this repository is cutting. Reporting those would
 * make the backstop cry wolf on the release it exists to protect.
 *
 * So ownership decides, and it errs in a specific direction:
 *
 *   pin / spec   `"@tsrx/oxc": "…"`, `@tsrx/oxc@…`. The name says whose version
 *                this is. Ours has to be declared, anybody else's is ignored.
 *   no owner     a regex literal, prose, a tarball name. Nothing claims it, so
 *                it has to be declared. This is where the escaped-dot assertion
 *                in the CLI output test lives.
 *   assignment   `version: "…"`, `version = "…"`. A bare version field belongs
 *                to whatever object it sits in, and this scan cannot see that,
 *                so it is left to the slot declarations. That is sound because
 *                slot counts are exact: a file that grows a second
 *                `assert.equal(x.version, "…")` fails the count check for the
 *                shape it already declares. The residue is a version field of a
 *                shape a file does not declare at all, which is the one gap here.
 */
function needsDeclaring(owner) {
  if (owner === null) return true;
  if (owner.kind === "assignment") return !VERSION_FIELD.test(owner.name);
  return OUR_PACKAGE.test(owner.name) || VERSION_FIELD.test(owner.name);
}

/**
 * Version references in a text target that no declared slot covers.
 *
 * `slots` are the exact capture ranges `survey` already found, so a reference is
 * only reported when it is genuinely outside every declared location. Ranges
 * are compared rather than counted, which is what lets a file hold a pinned and
 * a historical reference to the same version.
 */
function undeclaredInText(text, slots, interesting) {
  const undeclared = [];
  for (const hit of findVersions(text)) {
    if (!interesting.has(hit.value)) continue;
    if (slots.some((range) => range.start <= hit.start && hit.end <= range.end)) continue;
    if (!needsDeclaring(ownerOf(text, hit.start))) continue;
    undeclared.push({ ...hit, line: lineOf(text, hit.start) });
  }
  return undeclared;
}

/**
 * The same question for a JSON target, where the edit happens through the parsed
 * object and there are no capture ranges to compare against. A reference is
 * covered when its own key is a declared leaf key and that key has not already
 * used up its declared occurrences, so a second `"@tsrx/oxc"` pin in a section
 * this script does not know about is still reported.
 */
function undeclaredInJson(text, keyPaths, interesting) {
  const budget = new Map();
  for (const keyPath of keyPaths) {
    const leaf = keyPath.at(-1);
    budget.set(leaf, (budget.get(leaf) ?? 0) + 1);
  }
  const undeclared = [];
  for (const hit of findVersions(text)) {
    if (!interesting.has(hit.value)) continue;
    const owner = ownerOf(text, hit.start);
    if (!needsDeclaring(owner)) continue;
    const remaining = owner === null ? 0 : (budget.get(owner.name) ?? 0);
    if (remaining > 0) {
      budget.set(owner.name, remaining - 1);
      continue;
    }
    undeclared.push({ ...hit, line: lineOf(text, hit.start) });
  }
  return undeclared;
}

/**
 * Reconcile what the backstop found against what the file declared as
 * historical. Both directions are errors: an undeclared reference means a slot
 * is missing and the next cut would leave a stale version behind, and a missing
 * historical reference means a statement about the past was rewritten into a
 * claim about the present.
 */
function reconcile(file, undeclared, historical) {
  const found = undeclared.map((hit) => hit.value).sort();
  const declared = [...historical].sort();
  if (found.length === declared.length && found.every((value, i) => value === declared[i])) {
    return;
  }
  const detail = undeclared
    .map(
      (hit) =>
        `  ${file} (line ${hit.line}): ${hit.raw}` +
        (hit.raw === hit.value ? "" : ` (a ${SPELLINGS.regexEscaped.label} ${hit.value})`),
    )
    .join("\n");
  fail(
    `${file}: the declared slots do not account for every version reference in this file.\n` +
      `${undeclared.length} reference(s) sit outside every declared slot:\n${detail || "  (none)"}\n` +
      `and the file declares historical: ${JSON.stringify(declared)}.\n\n` +
      `Every version above has to be either covered by a slot shape in ` +
      `scripts/sync-version.ts — add one, in the spelling the file actually uses — or ` +
      `declared historical because it is a true statement about an older release. ` +
      `Leaving it undeclared is how a cut ships a stale version while --check reports clean.`,
  );
}

/**
 * Read every declared location without writing anything, then prove those
 * locations are all of them.
 *
 * Returns `{ locations, staleVersions }` where a location is
 * `{ file, where, value }` and `staleVersions` is the set of distinct values
 * that are not the target.
 *
 * The second pass is the backstop, and it runs in `--check` as well as in a
 * rewrite. That matters: an undeclared reference carries the SAME version as the
 * declared ones until a cut happens, so nothing about the values is wrong yet
 * and only an exhaustiveness check can see it. `--check` reporting clean while a
 * reference sits outside every slot is the failure this exists to prevent.
 */
async function survey(target) {
  const locations = [];
  const audit = [];

  for (const { file, paths, optional } of jsonTargets) {
    if (optional && !existsSync(path.join(root, file))) continue;
    const text = await readTarget(file);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      fail(`${file}: not parseable as JSON (${error.message})`);
    }
    if (`${JSON.stringify(parsed, null, 2)}\n` !== text) {
      fail(
        `${file}: does not round-trip through JSON.stringify(value, null, 2) with a trailing ` +
          `newline, so rewriting it would reformat the whole file. Fix the formatting or ` +
          `move this target to a text slot.`,
      );
    }
    for (const keyPath of paths) {
      let cursor = parsed;
      for (const key of keyPath) {
        if (cursor === null || typeof cursor !== "object" || !(key in cursor)) {
          fail(`${file}: expected key path ${keyPath.join(".")} is missing`);
        }
        cursor = cursor[key];
      }
      if (typeof cursor !== "string" || !new RegExp(`^${SEMVER}$`).test(cursor)) {
        fail(
          `${file}: ${keyPath.join(".")} is ${JSON.stringify(cursor)}, which is not a version`,
        );
      }
      locations.push({ file, where: keyPath.join("."), value: cursor, kind: "json", keyPath });
    }
    audit.push({ file, text, kind: "json", keyPaths: paths, historical: [] });
  }

  for (const { file, slots, historical = [] } of textTargets) {
    const text = await readTarget(file);
    const ranges = [];
    for (const [shape, expected] of slots) {
      const regexp = shape();
      const found = findSlots(text, regexp);
      if (found.length !== expected) {
        fail(
          `${file}: expected ${expected} occurrence(s) of ${regexp.source} but found ` +
            `${found.length}. The file changed shape; update the declaration in ` +
            `scripts/sync-version.ts rather than letting the cut ship a stale version.`,
        );
      }
      for (const hit of found) {
        ranges.push(hit);
        locations.push({
          file,
          where: `line ${lineOf(text, hit.start)}`,
          value: hit.value,
          kind: "text",
        });
      }
    }
    audit.push({ file, text, kind: "text", ranges, historical });
  }

  // Which versions the backstop cares about: the ones this repository declares
  // for itself, the one being moved to, and the ones declared historical.
  // Everything else in these files is a third-party version and none of this
  // script's business.
  const interesting = new Set([
    target,
    ...locations.map((entry) => entry.value),
    ...audit.flatMap((entry) => entry.historical),
  ]);

  for (const entry of audit) {
    const undeclared =
      entry.kind === "json"
        ? undeclaredInJson(entry.text, entry.keyPaths, interesting)
        : undeclaredInText(entry.text, entry.ranges, interesting);
    reconcile(entry.file, undeclared, entry.historical);
  }

  const staleVersions = new Set(
    locations.filter((entry) => entry.value !== target).map((entry) => entry.value),
  );
  return { locations, staleVersions };
}

async function sync(target, { check }) {
  const { locations, staleVersions } = await survey(target);

  if (staleVersions.size === 0) {
    if (!check) {
      console.log(
        `sync-version: already at ${target} across ${textTargets.length + jsonTargets.length} ` +
          `files and ${locations.length} locations. Nothing to do.`,
      );
    } else {
      console.log(
        `sync-version --check: ${locations.length} locations across ` +
          `${textTargets.length + jsonTargets.length} files all carry ${target}, and no ` +
          `undeclared version reference survives in any spelling.`,
      );
    }
    return 0;
  }

  const stale = locations.filter((entry) => entry.value !== target);

  if (check) {
    console.error(
      `sync-version --check: ${stale.length} location(s) do not carry ${target}:`,
    );
    for (const entry of stale) {
      console.error(`  ${entry.file} (${entry.where}): ${entry.value}`);
    }
    console.error("\nRun: node scripts/sync-version.ts");
    return 1;
  }

  if (staleVersions.size > 1) {
    fail(
      `the version surface is inconsistent: found ${[...staleVersions]
        .map((value) => JSON.stringify(value))
        .join(", ")} alongside the target ${target}.\n` +
        stale.map((entry) => `  ${entry.file} (${entry.where}): ${entry.value}`).join("\n") +
        `\n\nThis usually means a slot shape in scripts/sync-version.ts is matching ` +
        `something it should not. Refusing to rewrite anything.`,
    );
  }

  const previous = [...staleVersions][0];
  const changed = [];

  // What the backstop looks for while re-reading each rewritten file: the
  // version being left behind, the one being moved to, and anything declared
  // historical. survey() already proved the pre-rewrite state; this is the belt
  // that stops a file being written with a reference the rewrite could not see.
  const interesting = new Set([
    previous,
    target,
    ...textTargets.flatMap(({ historical = [] }) => historical),
  ]);

  for (const { file, paths, optional } of jsonTargets) {
    const absolute = path.join(root, file);
    if (optional && !existsSync(absolute)) continue;
    const text = await readFile(absolute, "utf8");
    const parsed = JSON.parse(text);
    let touched = 0;
    for (const keyPath of paths) {
      let cursor = parsed;
      for (const key of keyPath.slice(0, -1)) cursor = cursor[key];
      const leaf = keyPath.at(-1);
      if (cursor[leaf] !== target) {
        cursor[leaf] = target;
        touched += 1;
      }
    }
    if (touched === 0) continue;
    const next = `${JSON.stringify(parsed, null, 2)}\n`;
    reconcile(file, undeclaredInJson(next, paths, interesting), []);
    await writeFile(absolute, next);
    changed.push({ file, count: touched });
  }

  for (const { file, slots, historical = [] } of textTargets) {
    const absolute = path.join(root, file);
    const text = await readFile(absolute, "utf8");
    const edits = [];
    for (const [shape, expected] of slots) {
      const found = findSlots(text, shape());
      // survey() already proved the count; this is the belt to that braces.
      if (found.length !== expected) fail(`${file}: slot count changed mid-run`);
      for (const hit of found) if (hit.value !== target) edits.push(hit);
    }
    if (edits.length === 0) continue;
    let next = text;
    // Each slot is rewritten in the spelling it was found in, so a version
    // asserted inside a regex literal comes back out escaped.
    for (const hit of edits.sort((a, b) => b.start - a.start)) {
      next = next.slice(0, hit.start) + hit.spelling.render(target) + next.slice(hit.end);
    }
    // Re-find the slots in the rewritten text: their bounds have moved, and the
    // backstop compares positions, not counts.
    const ranges = slots.flatMap(([shape]) => findSlots(next, shape()));
    reconcile(file, undeclaredInText(next, ranges, interesting), historical);
    await writeFile(absolute, next);
    changed.push({ file, count: edits.length });
  }

  const total = changed.reduce((sum, entry) => sum + entry.count, 0);
  console.log(`sync-version: ${previous} -> ${target}`);
  for (const entry of changed.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`  ${entry.file}  (${entry.count})`);
  }
  console.log(
    `sync-version: rewrote ${total} location(s) in ${changed.length} file(s); ` +
      `${locations.length} declared location(s) now carry ${target}.`,
  );

  const after = await survey(target);
  if (after.staleVersions.size !== 0) {
    fail(
      `the rewrite did not stick: ${[...after.staleVersions].join(", ")} still present. ` +
        `This is a bug in scripts/sync-version.ts.`,
    );
  }
  return 0;
}

async function main(argv) {
  const check = argv.includes("--check");
  const versionIndex = argv.indexOf("--version");
  let target;
  if (versionIndex !== -1) {
    target = argv[versionIndex + 1];
    if (!target) fail("--version needs a value");
  } else {
    const manifest = JSON.parse(await readTarget("package.json"));
    target = manifest.version;
  }
  if (typeof target !== "string" || !new RegExp(`^${SEMVER}$`).test(target)) {
    fail(`target version ${JSON.stringify(target)} is not a version`);
  }
  return sync(target, { check });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof SyncError) {
    console.error(`sync-version: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NATIVE_TARGETS, nativePackageName } from "../packages/toolchain/dist/native-targets.js";
import { hostPlatformPackage, installAndExerciseRelease } from "./installed-release-check.ts";

/**
 * The post-publish backstop.
 *
 * npm versions are immutable and unpublish is restricted, so nothing here can
 * prevent a bad release; the prevention lives in the pre-publish gate. What
 * this can do is notice, on one platform, that the thing on the registry is not
 * the thing that was gated, which is the one failure mode a pre-publish check
 * structurally cannot see: npm's own handling of the upload.
 *
 * It replaces a step that resolved a version string with `npm view` and
 * believed the release. A version string resolving is still checked, for all
 * nine names, because that is the cheapest way to see a package that never
 * landed. It is now the first of three things rather than the only one: the
 * release is then installed from the registry into a project outside this
 * workspace, and made to produce a real diagnostic and a real AST.
 *
 * Usage:
 *   node scripts/verify-published-release.ts --version 0.1.5
 *
 *   --version <version>     the version that was just published
 *   --order-file <path>     "<name> <path>" lines naming the published packages
 *                           (default: the eight platform packages plus @tsrx/oxc)
 *   --registry <url>        default https://registry.npmjs.org/
 *   --attempts <n>          registry visibility attempts, 10s apart (default 30).
 *                           npm's read replicas have taken up to four minutes to
 *                           expose the last of the nine packages after a publish
 *                           (0.11.0, 0.12.0 and 0.13.0 each went red here at the
 *                           old 60-second budget while every package had landed),
 *                           so the default budget is five minutes.
 *   --rehearsal             dry-run mode: if the requested version is not on the
 *                           registry, run every stage against the latest version
 *                           that is, so the rehearsal installs and runs
 *                           something real instead of no-opping
 *
 * On `--rehearsal`. A backstop that has never executed is the same shape as the
 * `npm view` check it replaced: wired, believed, unproven. A dry run cannot
 * install the version it is rehearsing, because that version is by definition
 * not published yet, so a rehearsal that insists on the pending version can only
 * ever skip. Retargeting the last published release is what makes the dry run
 * exercise the whole path for real.
 *
 * What that proves: this script, the registry read, the install into a project
 * outside the workspace, the lint and the parse all work on the publish runner
 * as configured today. What it does not prove: anything whatsoever about the
 * pending version's artifacts. Those are the pre-publish gate's job, and the
 * gate runs before this step. It does mean a dry run now also answers "does the
 * release currently on npm still install and work", which is worth knowing on
 * its own.
 */

const root = resolve(import.meta.dirname, "..");
const PUBLIC_PACKAGE = "@tsrx/oxc";
const NATIVE_PREFIX = "@tsrx/oxc-";

function parseArguments(argv) {
  const options = {
    version: null,
    orderFile: null,
    registry: "https://registry.npmjs.org/",
    attempts: 30,
    rehearsal: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--rehearsal") {
      options.rehearsal = true;
      continue;
    }
    const value = argv[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--version") options.version = value;
    else if (argument === "--order-file") options.orderFile = value;
    else if (argument === "--registry") options.registry = value.endsWith("/") ? value : `${value}/`;
    else if (argument === "--attempts") options.attempts = Number.parseInt(value, 10);
    else throw new Error(`unsupported option: ${argument}`);
  }
  if (!options.version) throw new Error("--version is required");
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new Error("--attempts must be a positive integer");
  }
  return options;
}

function say(line = "") {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  process.stdout.write(
    `${process.env.GITHUB_ACTIONS === "true" ? "::error::" : "error: "}${message}\n`,
  );
}

async function publishedNames(options) {
  if (!options.orderFile) return [...NATIVE_TARGETS.map(nativePackageName), PUBLIC_PACKAGE];
  const contents = await readFile(resolve(root, options.orderFile), "utf8");
  return contents
    .split("\n")
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean);
}

/** The abbreviated packument, or null when the name has never been published. */
async function packument(registry, name) {
  const response = await fetch(new URL(encodeURIComponent(name).replace("%40", "@"), registry), {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${name}: registry answered ${response.status}`);
  return await response.json();
}

/** Whether `name@version` is visible, without spawning npm nine times. */
async function visible(registry, name, version) {
  return Boolean((await packument(registry, name))?.versions?.[version]);
}

/** The version behind the `latest` dist-tag, or null when nothing is published. */
async function latestPublished(registry, name) {
  const document = await packument(registry, name);
  const latest = document?.["dist-tags"]?.latest ?? null;
  return latest && document.versions?.[latest] ? latest : null;
}

/**
 * The one name in the set that consumers install; the rest are its platforms.
 *
 * The platform names are the public name plus a hyphen and a target suffix, so
 * the public name itself does not carry NATIVE_PREFIX and the test still
 * separates the two sets.
 */
function publicPackage(names) {
  return names.find((name) => !name.startsWith(NATIVE_PREFIX)) ?? PUBLIC_PACKAGE;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const names = await publishedNames(options);
  const publicName = publicPackage(names);
  const label = options.rehearsal ? "rehearsal" : "backstop";

  // In rehearsal mode the pending version is normally not on the registry yet,
  // and a check that stops there is a check that never runs. Retarget it at the
  // release that IS out there, and say so in as many words: the run is proving
  // the mechanism, not the pending artifacts.
  let target = options.version;
  let retargeted = false;
  if (options.rehearsal && !(await visible(options.registry, publicName, options.version))) {
    const latest = await latestPublished(options.registry, publicName);
    if (!latest) {
      say(`${publicName} has no published version at all, so there is nothing to install.`);
      say();
      say("rehearsal: SKIPPED  the registry holds no release of this package yet");
      return;
    }
    target = latest;
    retargeted = true;
  }

  say(options.rehearsal ? "Post-publish backstop (rehearsal)" : "Post-publish backstop");
  say(`  version   ${target}`);
  say(`  registry  ${options.registry}`);
  say(`  packages  ${names.length}`);
  if (retargeted) {
    say(`  requested ${options.version}, which is not on the registry yet`);
    say(
      `  rehearsing against ${target}, the current \`latest\` of ${publicName}, so every stage ` +
        "below runs for real",
    );
    say(
      `  this proves the backstop mechanism and the health of ${target}. It proves nothing ` +
        `about ${options.version}, which the pre-publish gate above already covered.`,
    );
  }
  say();

  say("[1/2] every published name resolves at this version");
  const missing = new Set(names);
  // A read can hit a replica that has not caught up with the write that just
  // succeeded, so a single miss is not evidence. That was true of the `npm view`
  // check this replaces and it is still true here.
  for (let attempt = 1; attempt <= options.attempts && missing.size > 0; attempt += 1) {
    for (const name of [...missing]) {
      if (await visible(options.registry, name, target)) missing.delete(name);
    }
    if (missing.size === 0) break;
    say(`  ${missing.size} not visible yet (attempt ${attempt}), waiting for the registry`);
    if (attempt < options.attempts) await sleep(10_000);
  }
  if (missing.size > 0) {
    for (const name of missing) fail(`${name}@${target} is not on the registry`);
    say();
    say(`${label}: FAIL  ${missing.size} of ${names.length} packages did not land at ${target}`);
    process.exitCode = 1;
    return;
  }
  say(`  all ${names.length} names resolve at ${target}`);
  say();

  say("[2/2] install the published release and make it do real work");
  say();
  const host = hostPlatformPackage();
  try {
    // No tarball path and no local file: this is the registry's copy, resolving
    // the platform package through the published optionalDependencies exactly
    // as a consumer's first install does.
    const installed = await installAndExerciseRelease({
      specs: [`${publicName}@${target}`],
      registry: options.registry,
      expectedVersion: target,
      log: (line) => say(line),
    });
    say();
    say(
      `${label}: PASS  ${publicName}@${target} installed from the registry on ` +
        `${host.target.target}, linted ${installed.lint.diagnostics} diagnostics, and parsed through ` +
        "its own addon",
    );
    if (retargeted) {
      say(
        `the code path a ${options.version} publish depends on ran end to end here; ` +
          `${options.version} itself is gated before publish, not here`,
      );
    }
  } catch (error) {
    fail(`the published release does not work when installed from the registry: ${error.message}`);
    say();
    say(
      retargeted
        ? `rehearsal: FAIL  ${target} is already published and no longer installs and runs`
        : `${label}: FAIL  the published artifact is broken; deprecate and patch`,
    );
    process.exitCode = 1;
  }
}

await main();

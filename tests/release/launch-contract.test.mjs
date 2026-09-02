import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { NATIVE_TARGETS, nativePackageName } from "../../packages/toolchain/dist/native-targets.js";
import { npmChildEnvironment, resolveNpmInvocation } from "../helpers/npm-invocation.mjs";
import { parseNpmPackResponse } from "../helpers/npm-pack-response.mjs";

const root = resolve(import.meta.dirname, "../..");
const repository = "https://github.com/tsrx-org/oxc";
const homepage = "https://oxc.tsrx.dev";
// The v0.1.0 launch manifest is a record of the launch as it ran, when the
// repo lived in its original org and the site at its original domain; it keeps
// the URL it actually posted.
const launchHomepage = "https://oxc-tsrx.dev/";
const launchRepository = "https://github.com/markless-dev/oxc-tsrx";
const publicDirectories = ["toolchain"];

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd ?? root,
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

test("root and public packages expose one launch identity", async () => {
  const rootManifest = await readJson(join(root, "package.json"));
  assert.equal(rootManifest.license, "MIT");
  assert.equal(rootManifest.homepage, homepage);
  assert.equal(rootManifest.repository.url, `git+${repository}.git`);
  assert.equal(rootManifest.bugs.url, `${repository}/issues`);
  assert.ok(rootManifest.keywords.includes("tsrx"));

  for (const directory of publicDirectories) {
    const manifest = await readJson(join(root, "packages", directory, "package.json"));
    assert.equal(manifest.version, rootManifest.version, directory);
    assert.equal(manifest.homepage, homepage, directory);
    assert.equal(manifest.repository.url, `git+${repository}.git`, directory);
    assert.equal(manifest.bugs.url, `${repository}/issues`, directory);
    assert.equal(manifest.license, "MIT", directory);
  }

  const vscode = await readJson(join(root, "packages", "vscode", "package.json"));
  assert.equal(vscode.version, rootManifest.version);
  assert.equal(vscode.homepage, homepage);
  assert.equal(vscode.repository.url, `${repository}.git`);
});

test("launch manifest names every byte set and keeps external actions approval-gated", async () => {
  const launch = await readJson(join(root, "docs", "releasing", "v0.1.0-launch.json"));
  assert.equal(launch.schemaVersion, 2);
  assert.equal(launch.version, "0.1.0");
  assert.equal(launch.repository, launchRepository);
  assert.equal(launch.site.url, launchHomepage);
  assert.equal(launch.site.artifact, "docs/dist");
  assert.equal(launch.site.provider, "vercel");
  assert.equal(launch.site.config, "docs/dist/vercel.json");
  assert.equal(launch.site.buildWorkflow, ".github/workflows/site-artifact.yml");
  assert.equal(launch.site.trigger, "workflow_dispatch");
  assert.equal(launch.site.artifactNameTemplate, "oxc-tsrx-docs-{COMMIT_SHA}");
  assert.equal(launch.site.deployWorkflow, null);

  const nativeNames = NATIVE_TARGETS.map(nativePackageName);
  assert.deepEqual(launch.npm.publishOrder.slice(0, nativeNames.length), nativeNames);
  // One published host package plus the eight platform packages a user never
  // names: nine names, and no first-party wrapper between the user and the
  // toolchain.
  assert.deepEqual(launch.npm.publishOrder.slice(nativeNames.length), ["@tsrx/oxc"]);
  assert.equal(launch.npm.publishOrder.length, nativeNames.length + 1);
  assert.equal(new Set(launch.npm.publishOrder).size, launch.npm.publishOrder.length);
  assert.deepEqual(
    launch.vscode.targets,
    NATIVE_TARGETS.map(({ vscodeTarget }) => vscodeTarget),
  );
  assert.equal(launch.vscode.role, "optional-legacy-activation-client");
  assert.equal(launch.vscode.requiredForPrimaryEditorWorkflow, false);
  assert.match(launch.social.text, /OXC for TSRX/u);
  assert.match(launch.social.text, /Install oxc-tsrx/u);
  assert.doesNotMatch(launch.social.text, /Install oxlint-tsrx|Install oxfmt-tsrx/u);
  assert.match(launch.social.text, new RegExp(launchHomepage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(launch.requiredApprovals, [
    "repository-push",
    "npm-publication",
    "vscode-marketplace-publication",
    "website-deployment",
    "social-announcement",
  ]);

  const [notes, runbook, prerequisites, workflow] = await Promise.all([
    readFile(join(root, "docs", "releasing", "v0.1.0.md"), "utf8"),
    readFile(join(root, "docs", "releasing", "launch-runbook.md"), "utf8"),
    readFile(join(root, "docs", "releasing", "external-prerequisites.md"), "utf8"),
    readFile(join(root, ".github", "workflows", "site-artifact.yml"), "utf8"),
  ]);
  assert.match(notes, /^# OXC for TSRX 0\.1\.0/mu);
  assert.match(notes, /Known boundaries/u);
  assert.match(runbook, /exact approval/u);
  assert.match(runbook, /COMMIT_SHA/u);
  assert.match(runbook, /RUN_ID/u);
  assert.match(runbook, /SITE_RUN_ID/u);
  assert.match(runbook, /Vercel production deployment/u);
  assert.match(runbook, /Cross-Origin-Opener-Policy/u);
  assert.match(runbook, /Cross-Origin-Embedder-Policy/u);
  assert.match(runbook, /zero `?\/api`? engine requests/u);
  assert.doesNotMatch(runbook, /GitHub Pages|thejackshelton\.github\.io/u);
  assert.match(prerequisites, /^## Vercel$/mu);
  assert.match(prerequisites, /compiled\.run\/oxc-tsrx/u);
  assert.match(prerequisites, /docs\/dist\/vercel\.json/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /rustup target add wasm32-wasip1-threads/u);
  assert.match(workflow, /pnpm run docs:wasm/u);
  assert.match(workflow, /OXC_TSRX_REQUIRE_WASM=1 pnpm run docs:build/u);
  assert.match(workflow, /node tests\/site\/verify-static\.mjs --require-wasm/u);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /name: oxc-tsrx-docs-\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /path: docs\/dist/u);
  // The website now deploys from the same run that proved the artifact, so a
  // blanket ban on deployment no longer describes this workflow. What still has
  // to hold is where the credential may live and what gates it.
  const [buildJob, deployJob] = workflow.split(/^  deploy:$/mu);
  assert.ok(deployJob, "the website workflow must still have a separate deploy job");

  // The build job runs the whole dependency graph: pnpm postinstalls, cargo, and
  // every docs script. The deploy credential must never be in that runner.
  assert.doesNotMatch(buildJob, /VERCEL_TOKEN|vercel deploy/iu);

  // Deployment stays behind a GitHub environment, which is where the approval
  // and the credential are configured.
  assert.match(deployJob, /environment:\n\s+name: production/u);
  assert.match(deployJob, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/u);
  // It only ever ships bytes the build job already proved, never a fresh build.
  assert.match(deployJob, /actions\/download-artifact@[0-9a-f]{40}/u);
  assert.doesNotMatch(deployJob, /actions\/checkout|pnpm run docs:build/u);

  // GitHub Pages was never the target, and no workflow publishes packages or
  // posts the announcement.
  assert.doesNotMatch(
    workflow,
    /configure-pages|upload-pages-artifact|deploy-pages|github-pages/iu,
  );
  assert.doesNotMatch(workflow, /npm publish|vsce publish|curl .*social/iu);
  // The one git push this workflow is allowed is the wasm-pin commit that
  // retriggers the oxc.tsrx.dev Vercel build; anything else pushing from the
  // site workflow is still a contract violation.
  const sitePushes = workflow.match(/git push/gu) ?? [];
  assert.equal(sitePushes.length, 1, "site-artifact.yml may push only the wasm pin");
  assert.match(
    workflow,
    /wasm-pin\.json[\s\S]{0,3000}git push|git push[\s\S]{0,3000}wasm-pin\.json/u,
    "the sole git push must belong to the wasm-pin step",
  );
});

test("all platform-independent npm payloads pass pack dry-run", async () => {
  const npmCache = await mkdtemp(join(tmpdir(), "oxc-tsrx-pack-cache-"));
  for (const directory of publicDirectories) {
    const npmInvocation = resolveNpmInvocation([
      "pack",
      "--dry-run",
      "--json",
      `./packages/${directory}`,
    ]);
    const { stdout, stderr } = await run(npmInvocation.executable, npmInvocation.args, {
      // npm must not inherit pnpm's `npm_config_*` settings; it warns about
      // every one it does not recognise, and this assertion is that a clean
      // pack prints nothing.
      env: {
        ...npmChildEnvironment(),
        npm_config_cache: npmCache,
        // npm's update notifier writes to stderr whenever a newer npm exists,
        // which has nothing to do with this payload. npm skips it when
        // `ciInfo.isCI`, so CI is quiet by construction and only a local run
        // ever saw it, non-deterministically: the check is a race against the
        // registry that npm deliberately does not await. Turning the notifier
        // off at its own config key (lib/cli/update-notifier.js bails on
        // `!npm.config.get('update-notifier')`) keeps every other byte npm
        // writes to stderr failing this assertion. Filtering the notice out of
        // stderr instead would have to keep pace with npm's wording and could
        // swallow a real warning that happened to match.
        npm_config_update_notifier: "false",
      },
    });
    assert.equal(stderr, "", directory);
    const result = parseNpmPackResponse(stdout);
    assert.equal(
      result.name,
      (await readJson(join(root, "packages", directory, "package.json"))).name,
    );
    assert.ok(
      result.files.some(({ path }) => path === "LICENSE"),
      directory,
    );
    assert.ok(
      result.files.some(({ path }) => path === "README.md"),
      directory,
    );
    assert.ok(
      result.files.some(({ path }) => path === "THIRD_PARTY_NOTICES.md"),
      directory,
    );
    assert.equal(
      result.files.some(({ path }) => path.startsWith("test")),
      false,
      directory,
    );
    // The host package is platform-independent. The parser addon built into the
    // source tree for local development must never reach the payload.
    assert.equal(
      result.files.some(({ path }) => path.endsWith(".node")),
      false,
      directory,
    );
  }
});

test("every hosted VSIX validates its rebuilt bundle against the legal inventory", async () => {
  const [workflow, packager] = await Promise.all([
    readFile(join(root, ".github", "workflows", "release-candidate.yml"), "utf8"),
    readFile(join(root, "scripts", "package-vscode.ts"), "utf8"),
  ]);
  const build = workflow.indexOf("pnpm run build:editor");
  const legalCheck = workflow.indexOf("pnpm run licenses:vscode:check", build);
  const packageVsix = workflow.indexOf("node scripts/package-vscode.ts", build);
  assert.ok(build >= 0, "release candidates must rebuild the editor bundle");
  assert.ok(legalCheck > build, "the rebuilt bundle must be checked against its legal inventory");
  assert.ok(
    packageVsix > legalCheck,
    "the legal check must pass before the target VSIX is packaged",
  );

  const productionReadback = packager.indexOf("verifyAndPromoteVsix(candidate");
  const successOutput = packager.indexOf("process.stdout.write", productionReadback);
  assert.ok(productionReadback >= 0, "the production packager must reopen the candidate VSIX");
  assert.ok(
    successOutput > productionReadback,
    "verified atomic promotion must pass before packaging succeeds",
  );

  const download = workflow.indexOf("actions/download-artifact");
  const assembledReadback = workflow.indexOf(
    "node scripts/vsix-archive.ts release/*.vsix",
    download,
  );
  const legalStage = workflow.indexOf(
    "Stage legal texts and locked dependency inventory",
    download,
  );
  assert.ok(assembledReadback > download, "downloaded hosted VSIX files must be reopened");
  assert.ok(
    assembledReadback < legalStage,
    "all hosted VSIX files must verify before assembly continues",
  );
});

test("hosted assembly cross-binds every native report to one target-specific VSIX", async () => {
  const [workflow, nativePackager] = await Promise.all([
    readFile(join(root, ".github", "workflows", "release-candidate.yml"), "utf8"),
    readFile(join(root, "scripts", "package-native.ts"), "utf8"),
  ]);

  assert.match(nativePackager, /lspSha256:\s*lsp\.sha256/u);
  assert.match(nativePackager, /lspBytes:\s*lsp\.bytes/u);

  const assemblyStart = workflow.indexOf("Verify the complete package and VSIX matrix");
  const assemblyEnd = workflow.indexOf("Stage legal texts and locked dependency inventory");
  assert.ok(assemblyStart >= 0 && assemblyEnd > assemblyStart);
  const assembly = workflow.slice(assemblyStart, assemblyEnd);
  assert.match(assembly, /for \(const platform of NATIVE_TARGETS\)/u);
  assert.match(assembly, /native-package-\$\{platform\.packageSuffix\}\.json/u);
  assert.match(assembly, /vscode-package-\$\{platform\.packageSuffix\}\.json/u);
  assert.match(assembly, /assert\.equal\(native\.lspSha256, vscode\.lspSha256/u);
  assert.match(assembly, /assert\.equal\(native\.lspBytes, vscode\.lspBytes/u);
  assert.match(
    assembly,
    /assert\.equal\(vscode\.lspSha256, vscode\.vsixVerification\.nativeLspSha256/u,
  );
  assert.match(
    assembly,
    /assert\.equal\(vscode\.lspBytes, vscode\.vsixVerification\.nativeLspBytes/u,
  );
  assert.match(
    assembly,
    /assert\.equal\(native\.lspSha256, vscode\.vsixVerification\.nativeLspSha256/u,
  );
  assert.match(
    assembly,
    /assert\.equal\(native\.lspBytes, vscode\.vsixVerification\.nativeLspBytes/u,
  );
  assert.match(assembly, /assert\.equal\(nativeTargets\.size, NATIVE_TARGETS\.length/u);
  assert.match(assembly, /assert\.equal\(vscodeTargets\.size, NATIVE_TARGETS\.length/u);
});

test("native packaging invokes npm's declared JavaScript CLI through Node", async () => {
  const packager = await readFile(join(root, "scripts", "package-native.ts"), "utf8");

  assert.match(packager, /resolveNpmInvocation\(\s*\[\s*"pack"/u);
  assert.match(packager, /run\(npmInvocation\.executable, npmInvocation\.args/u);
  assert.doesNotMatch(packager, /npm\.cmd/u);
  assert.doesNotMatch(packager, /shell\s*:/u);
});

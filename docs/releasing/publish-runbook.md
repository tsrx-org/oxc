# Publish runbook

Rewritten 2026-07-25 for the nine-package layout and for OIDC trusted
publishing. This is the operator checklist for putting `@tsrx/oxc` and its eight
platform packages on npm. It records the traps that are specific to shipping
per-platform native packages, because most of them fail quietly.

**Read this first: the 2026-08 rename resets the one-time setup.** The
repository moved to `tsrx-org/oxc` and every published name changed: the old
`oxc-tsrx` is now `@tsrx/oxc`, and the eight `@oxc-tsrx/native-<suffix>`
packages are now `@tsrx/oxc-<suffix>`. All nine new names are unpublished, so
[the one-time setup only the owner can do](#the-one-time-setup-only-the-owner-can-do)
below is live again rather than historical: each new name has to be bootstrapped
onto the registry by hand and then bound to a trusted publisher pointing at
`tsrx-org/oxc`. Until that is done, `publish.yml` cannot authenticate for any of
the nine.

**The old names have been through this before.** `oxc-tsrx` and the eight
`@oxc-tsrx/native-*` packages exist on npm at 0.1.0 through 0.1.4, `latest`
points at 0.1.4, and `oxc-tsrx@0.1.4` carries a SLSA provenance attestation,
which only a trusted publish from CI produces. Checked against the registry on
2026-07-28. Those records are kept below as evidence that the mechanism works;
they say nothing about the `@tsrx/*` names.

An earlier version of this runbook described thirteen packages. Four of them
(`@oxc-tsrx/runtime`, `@oxc-tsrx/parser`, `oxlint-tsrx`, `oxfmt-tsrx`) were
folded into the single public `oxc-tsrx` package on 2026-07-25 and no longer
exist anywhere in the tree. Anyone following the old list would try an
impossible publish.

## What actually ships

Nine packages, and `docs/releasing/v0.1.0-launch.json` is the source of truth
for both the set and the order:

1. `@tsrx/oxc-darwin-arm64`
2. `@tsrx/oxc-darwin-x64`
3. `@tsrx/oxc-linux-arm64-gnu`
4. `@tsrx/oxc-linux-x64-gnu`
5. `@tsrx/oxc-linux-arm64-musl`
6. `@tsrx/oxc-linux-x64-musl`
7. `@tsrx/oxc-win32-arm64-msvc`
8. `@tsrx/oxc-win32-x64-msvc`
9. `@tsrx/oxc`

npm pack flattens those names: `@tsrx/oxc` packs as `tsrx-oxc-<version>.tgz`
and `@tsrx/oxc-<suffix>` as `tsrx-oxc-<suffix>-<version>.tgz`. That is the one
naming rule `publish.yml`, `release-candidate.yml` and
`scripts/vsix-archive.ts` all spell out, and the candidate matrix check fails on
any artifact that does not match it.

Plus eight target-specific VSIX files for `thejackshelton.oxc-tsrx-vscode`,
which go to the VS Code Marketplace, not to npm, and are covered by
[the release runbook](README.md).

### The order is not negotiable

`@tsrx/oxc` last, always. It lists all eight platform packages in
`optionalDependencies`, and npm resolves those at install time against whatever
is on the registry at that moment. Publish the parent first and you open a
window where an install succeeds, quietly installs no binary, and then fails at
first use with a confusing "binary not found" instead of an install error.

This is the single most damaging ordering mistake available here, because
`optionalDependencies` failures are silent by design. npm treats a missing
optional dependency as normal.

`.github/workflows/publish.yml` reads the order out of the launch contract and
refuses to run if the contract does not list exactly nine names ending in
`@tsrx/oxc`, so you do not have to hold the order in your head. You do have to
not bypass the workflow.

### Version lockstep

All nine publish at the same version. `@tsrx/oxc` pins each platform package to
an exact version:

```json
"optionalDependencies": {
  "@tsrx/oxc-darwin-arm64": "0.6.0",
  "@tsrx/oxc-darwin-x64": "0.6.0"
}
```

If one lands at a different version, that platform gets no binary. There is no
partial-success mode. The publish workflow checks every tarball's manifest
against the version you typed before it publishes anything.

## Cutting a release

Everything below this section is about npm. This section is about the step
before it: moving the repository to a new version, tagging it, and putting a
GitHub Release on the tag. Nothing here publishes anything.

Dispatch **Manual Release** (`.github/workflows/manual-release.yml`) from the
default branch. It takes three inputs:

| Input | What it does |
| --- | --- |
| `release_type` | `patch`, `minor`, `major` or `prerelease`. `major` on any `0.x.y` produces `1.0.0`. |
| `preid` | Only read for `prerelease`. Write `rc` to get a `-rc.0` suffix. |
| `mode` | `dry-run` builds, gates and tags the whole cut on the runner and pushes none of it. `release` pushes the commit, the tag and the Release. Default is `dry-run`, and there is no reason not to run one first. |

Run the dry run, read the notes it attaches to the run as an artifact, then run
it again in `release` mode.

### Why the version is not just `bumpp`

`bumpp` rewrites the `version` field of a manifest. That is four files out of
about thirty, so the workflow runs `bumpp` on the root manifest only and then
hands the rest to `scripts/sync-version.ts`.

`sync-version.mjs` propagates the root version to 76 declared locations across
26 files: the eight `@tsrx/oxc-*` pins in `packages/toolchain`, the two
`@tsrx/oxc` pins in `packages/tsrx-core-compat` and `packages/vscode`, the three
package manifests' own `version` fields, the Cargo workspace version,
`packages/toolchain/src/parser.ts` and the committed build output at
`packages/toolchain/dist/parser.js`, `packages/toolchain/parser.node.json`, the scaffold fixture in
`docs/generate-transcripts.mjs`, and eighteen test files that assert or install
a literal version string.

It is not a search and replace. Every location is declared in the script with
the exact shape it expects and how many times that shape has to occur, so a
file that moved or changed shape fails the run instead of being quietly skipped.
Run it yourself with:

```bash
pnpm run release          # bumpp the root version interactively, then sync
pnpm run release:check    # verify only; names every location still stale
```

`pnpm run release:check` exits non-zero and prints the file and line of every
location that disagrees with the root manifest. It is cheap enough to run
before every push. It is not yet wired into `ci.yml`, which is worth doing.

### What the workflow regenerates, and in what order

The order is forced by what each step reads:

1. `bumpp package.json` (root manifest)
2. `node scripts/sync-version.ts`
3. `cargo update -w`, which is what rewrites `Cargo.lock`
4. `pnpm install --lockfile-only`, which rewrites `pnpm-lock.yaml`
5. `cargo metadata` on `docs/tools/demo-wasm` and `docs/tools/projection-dump`,
   which relocks the two docs Rust tools
6. `pnpm run licenses:generate`, which records a sha256 of `Cargo.lock` and a
   sha256 of `pnpm-lock.yaml`, so it has to come after both of them

Step 5 is easy to forget and expensive to forget. Those two tools sit outside
the product workspace and keep their own `Cargo.lock`, each recording a
resolved version for the crates in `crates/` that it depends on. A version bump
leaves both stale, and `scripts/build-docs-wasm.ts` builds with `--locked`, so
a stale lock does not produce a wrong artifact. It fails the docs site build
outright, about four minutes in, over one digit.
`tests/packaging/boundary.test.mjs` checks it in milliseconds instead.

### What the workflow deliberately leaves to you

Two generated files carry the version and are not regenerated by the release
workflow, because both need a full Rust release build and neither can produce a
broken package:

- `docs/terminal-transcripts.json` holds two `oxc-tsrx <version>` strings that
  are live CLI output. Refresh with `pnpm run build:native` then
  `pnpm run docs:transcripts`. `tests/site/documented-version-pin.test.mjs`
  reads this file but only matches the `@tsrx/oxc@N.N.N` form, which the
  transcripts do not use, so a stale value is cosmetic.
- `docs/acceptance/performance-report.json` carries the version inside its
  `versionsIdentity` string and comes from a full comparative benchmark run.
  Nothing asserts it against the root manifest; a stale value renders an old
  version string on the benchmark page.

Do both before the cut if you want the site to read correctly on release day.

### The gates the cut has to pass

The workflow will not tag anything until all of these pass on the bumped tree:

- `node scripts/sync-version.ts --check`
- `pnpm run test:release`, the lockstep guard. It reads the root manifest at
  runtime and asserts every package manifest equals it, so a manifest the sync
  script missed fails here rather than shipping.
- `pnpm run test:packaging:unit`
- `pnpm run licenses:check`
- `node --test tests/site/documented-version-pin.test.mjs`

### The release notes

`scripts/release-notes.ts` builds the Release body. It runs `changelogen` over
the commit range and then appends an **Other changes** section listing every
commit in the range `changelogen` did not emit.

That second half is not decoration. `changelogen` only parses Conventional
Commits, and a commit whose subject is not `type(scope): summary` is dropped
without a warning. Over the full history of this repository that is 94 of 153
commits, including most of the headline work. The script refuses to write the
file unless every commit in the range appears in the finished text, and it
prints the three counts so you can check:

```
release-notes: <from>..<to> - 153 commit(s) in range, 59 emitted by
changelogen, 94 appended as other changes, 153 covered.
```

Run it yourself with `pnpm run release:notes -- --from <ref> --to <ref> --out
notes.md`. With no `--from` it starts at the most recent `v*` tag, and at the
first commit when there is not one yet. It only looks at tags shaped like
`v<number>`: this repository carries two tags that are not releases
(`pre-idiomatic-merge/main`, `pre-idiomatic-merge/provider`), and a plain
`git describe --tags` picks one of those and silently cuts the history down to
a fraction of itself.

### What the release workflow does not do

It does not publish to npm, and it must not be changed so that it can. It holds
no `id-token: write` permission, which is the permission npm trusted publishing
needs, so it could not authenticate to the registry even if a step tried.

npm publication is the two-workflow gate described in the rest of this
document. After **Manual Release** finishes, continue at
[Before you publish](#before-you-publish) using the SHA it tagged.

## How publishing authenticates

There is no npm token anywhere in this repository, and adding one would be a
step backwards.

`.github/workflows/publish.yml` uses **npm trusted publishing**. The job asks
GitHub for a short-lived OpenID Connect (OIDC) token, the npm CLI notices it
automatically, exchanges it for a short-lived registry token, and publishes. If
you have only ever published with `NPM_TOKEN`, the mental model is: instead of
storing a long-lived secret that proves "I am allowed to publish", the workflow
proves "I am this specific workflow file in this specific repository" at the
moment it runs, and npm decides whether that is allowed.

What makes it work:

- `permissions: { id-token: write }` on the publish job. Without it there is no
  OIDC token and npm falls back to looking for a token that does not exist. The
  error you get is a misleading `ENEEDAUTH` or `E404`.
- npm CLI **11.5.1 or newer**, on Node **22.14.0 or newer**. Node 24.15.0, which
  this repository pins everywhere, bundles npm 11.12.1, so the floor is already
  met. The workflow still pins `npm@11.18.0` explicitly and asserts the version,
  so a future Node bump cannot silently drop below the floor.
- A GitHub-hosted runner. Self-hosted runners are not supported for trusted
  publishing.
- `repository.url` in each manifest must match the GitHub repository exactly.
  Every manifest here says `git+https://github.com/tsrx-org/oxc.git`,
  including the generated platform manifests from `scripts/package-native.ts`.

Provenance comes for free. npm generates and publishes a provenance attestation
automatically for a trusted publish from a public repository, so you do not need
`--provenance` on the command line. Every manifest also sets
`publishConfig.provenance: true`, which is why publishing from a laptop fails:
provenance can only be produced by a supported CI.

Sources: npm's [trusted publishing docs](https://docs.npmjs.com/trusted-publishers)
and the `id-token: write` pattern used by real Solid repositories such as
[`solidjs/solid-start`](https://github.com/solidjs/solid-start/blob/main/.github/workflows/release.yml),
whose release job carries `id-token: write # Required for npm trusted publishing (OIDC)`
and no `NPM_TOKEN`.

## The one-time setup only the owner can do

**Required again, right now.** The nine names that ship today are the `@tsrx/*`
names, and none of them has ever been published. The old `oxc-tsrx` and
`@oxc-tsrx/native-*` names were bootstrapped and bound this way in 0.1.0, and
`oxc-tsrx@0.1.4` carries a provenance attestation, which a laptop publish cannot
produce — that is the proof the procedure below works, not a reason to skip it.
A name that has never been published cannot be configured as a trusted
publisher, and that is the trap this section exists for.

Two things changed at once in the 2026-08 rename, and both invalidate the old
configuration:

- the nine package names are new, so there is nothing on the registry to attach
  a trusted publisher to until step 1 runs;
- the repository is now `tsrx-org/oxc`, so any trusted publisher still naming
  the old repository would refuse the publish even on a name that did exist.
  `scripts/trust-publishers.sh` revokes an existing binding before creating the
  new one for exactly this case.

npm configures a trusted publisher **on a package that already exists**. Both
the [npm trust CLI docs](https://docs.npmjs.com/cli/v11/commands/npm-trust)
("Package must exist: The package you're configuring must already exist on the
npm registry") and the trusted publishing guide ("Navigate to your package
settings on npmjs.com") say so, and
[npm/cli#8544](https://github.com/npm/cli/issues/8544), "Allow publishing
initial version with OIDC", is still open with comments as recent as June 2026.
PyPI supports pre-registering a publisher for a name that does not exist yet.
npm does not.

All nine names are brand new. So the first publish of each name cannot use OIDC.

### Step 1: bootstrap the nine names (one time, from the owner's machine)

Do this once, from a laptop, with interactive authentication. Do not create a
long-lived automation token for it.

This writes to the registry, so it needs the owner's explicit npm-publication
approval in its own right, exactly like publishing 0.1.0 does. It is not a
preparation step that someone else can take on the owner's behalf.

```sh
npm install -g npm@^11.15.0   # npm trust needs 11.15.0 or newer
npm login                     # interactive, 2FA at the prompt
npm whoami                    # confirm the right account
```

Publish a throwaway version of each of the nine names, under a throwaway tag so
that `latest` is never pointed at a placeholder, and with provenance turned off
because a laptop cannot produce it:

```sh
cd "$(mktemp -d)"
for name in \
  @tsrx/oxc-darwin-arm64 @tsrx/oxc-darwin-x64 \
  @tsrx/oxc-linux-arm64-gnu @tsrx/oxc-linux-x64-gnu \
  @tsrx/oxc-linux-arm64-musl @tsrx/oxc-linux-x64-musl \
  @tsrx/oxc-win32-arm64-msvc @tsrx/oxc-win32-x64-msvc \
  @tsrx/oxc
do
  mkdir -p bootstrap && cd bootstrap
  cat > package.json <<JSON
{
  "name": "$name",
  "version": "0.0.0-trusted-publishing-bootstrap",
  "private": false,
  "description": "Name reservation for trusted publishing setup. Do not install.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/tsrx-org/oxc.git" },
  "publishConfig": { "access": "public", "provenance": false }
}
JSON
  npm publish --tag bootstrap
  cd .. && rm -rf bootstrap
done
```

Two details that matter:

- `--tag bootstrap` means `latest` is never set to the placeholder, so nobody
  can accidentally install it.
- `"provenance": false` is required. With `provenance: true` a laptop publish
  fails outright, which is exactly the blocker the earlier runbook recorded.

There is a community tool, `npx setup-npm-trusted-publish <name>`, that
automates the placeholder publish. It is not vetted here, and it publishes under
the owner's account, so the manual loop above is the recommended path.

### Step 2: configure the trusted publisher on each of the nine packages

Two equivalent ways. The CLI is much faster for nine packages.

**Option A, the CLI (recommended).** npm's docs describe a 5 minute window after
the first 2FA prompt in which further `npm trust` calls do not re-prompt, which
is enough for nine packages:

```sh
for name in \
  @tsrx/oxc-darwin-arm64 @tsrx/oxc-darwin-x64 \
  @tsrx/oxc-linux-arm64-gnu @tsrx/oxc-linux-x64-gnu \
  @tsrx/oxc-linux-arm64-musl @tsrx/oxc-linux-x64-musl \
  @tsrx/oxc-win32-arm64-msvc @tsrx/oxc-win32-x64-msvc \
  @tsrx/oxc
do
  npm trust github "$name" \
    --repo tsrx-org/oxc \
    --file publish.yml \
    --allow-publish \
    --yes
  sleep 2
done
npm trust list @tsrx/oxc    # confirm it saved
```

`npm trust` needs npm 11.15.0 or newer, account-level 2FA enabled, and write
access to each package. Granular access tokens with the "bypass 2FA" option do
not work for it.

`scripts/trust-publishers.sh` is that loop, kept in the tree so nobody retypes
it. It reads the nine names from the launch contract rather than repeating them,
stops early if you are not logged in or if npm is too old, skips any name that
is not on the registry yet, and prints a per-package result.
`sh scripts/trust-publishers.sh --check` reports the current configuration
without changing anything. Nothing in CI runs it, and nothing should: it needs
an interactive 2FA prompt, so it stays an owner-only manual step.

**Option B, the website.** For each of the nine packages, in this order of
clicks:

1. Sign in at [npmjs.com](https://www.npmjs.com/).
2. Go to **Packages**, click the package name.
3. Open the **Settings** tab.
4. Find the **Trusted Publisher** section.
5. Under **Select your publisher**, click **GitHub Actions**.
6. **Organization or user**: `tsrx-org`
7. **Repository**: `oxc`
8. **Workflow filename**: `publish.yml` (just the filename, with the extension,
   not a path)
9. **Environment name**: leave empty. `publish.yml` does not declare a GitHub
   environment. If you later add one, you must come back and fill this in, or
   publishing breaks.
10. **Allowed actions**: tick **npm publish**. (Tick **npm stage publish** too if
    you intend to move to staged publishing later.)
11. Save.

Every field is case sensitive and npm does not validate them when you save. A
typo shows up only as a failed publish.

### Step 3: publish 0.1.0 from CI

Now the workflow works. See "Running the publish" below.

### Step 4: clean up the placeholders

Only after 0.1.0 is on the registry, so that each package still has a real
version left:

```sh
npm unpublish "$name@0.0.0-trusted-publishing-bootstrap"
```

Do not unpublish the placeholder while it is the only version of a package.
Removing the last version removes the package, and removing the package removes
its trusted publisher configuration.

### Step 5 (optional hardening, later)

Once a trusted publish has actually worked:

- On each package: **Settings → Publishing access → Require two-factor
  authentication and disallow tokens**. Trusted publishing keeps working; only
  token authentication is switched off.
- Consider switching the trusted publisher to stage-only (`--allow-stage-publish`
  without `--allow-publish`). Then CI runs `npm stage publish` and a human
  approves each release with 2FA before it becomes installable. That is the
  strongest posture, and it is a change to make for 0.1.1, not during a launch.

### So: is publishing hands-off?

**Not for 0.1.0.** Steps 1 and 2 are one-time account-level actions that no
workflow can perform. After they are done, every later release is a workflow
dispatch with no token and no laptop publish. Anyone who says the first release
is fully automated has not tried it against a name that does not exist yet.

## The dist-tag, decided

`docs/releasing/v0.1.0-launch.json` now says `"distTag": "latest"` next to
`"installPreview": "npm install -D @tsrx/oxc"`, and those agree: the advertised
command resolves `latest`. Under the old `oxc-tsrx` name `latest` was 0.1.4;
`@tsrx/oxc` has no `latest` until the first publish under the new name lands.

The trap is worth keeping in mind if anyone proposes `next` again. `npm install
-D @tsrx/oxc` resolves `latest`, so publishing under `next` only makes the
advertised command fail with E404, which is the first thing anyone reading an
announcement will run. Either publish to `latest`, or change every piece of
launch copy to say `@tsrx/oxc@next`. There is no third option.

The publish workflow uses the launch contract's tag by default, prints a loud
warning when the resolved tag is not `latest`, and accepts a `dist_tag` input if
you want to override it for one run. It does not make the decision for you.

## Before you publish

| Check | How | Result 2026-07-28 |
| --- | --- | --- |
| The version you are about to publish is free | `npm view <name>@<version> version` on any of the nine | All nine are published at 0.1.0 through 0.1.4. npm versions are immutable, so a republish of an existing version fails at the rehearsal step. |
| `access: public` on every package | manifest `publishConfig` | Present. The publish workflow re-checks each tarball. |
| Versions in lockstep | every manifest at the same version | All at `0.1.4` |
| Candidate built | **Build release candidate** run is green | Required. The publish workflow refuses any other run. |
| Packages contain what they promise | the gate, below | Automated. Runs in both modes and blocks everything after it. |

Scoped packages default to **restricted** on first publish. `access: public` is
set everywhere, so this is covered, but a newly added scoped package needs the
same field or the publish silently creates a private package nobody can install.

## Running the publish

The publish workflow never rebuilds. It downloads the artifact that was already
reviewed, re-checks `SHA256SUMS`, and publishes those exact bytes.

1. Dispatch **Build release candidate** on the exact commit. Note the run ID and
   the commit SHA.
2. Review the candidate as described in [the release runbook](README.md).
3. Dispatch **Publish to npm** with:
   - `candidate_run_id`: the run ID from step 1
   - `candidate_sha`: the commit SHA from step 1
   - `version`: `0.1.0`
   - `mode`: `dry-run`
   - `confirm`: leave empty
4. Read the dry-run log. It prints the nine packages in publish order, the
   resolved dist-tag, and the file list of every tarball. Nothing was published.
5. Dispatch it again with `mode: publish` and `confirm` set to exactly
   `PUBLISH 0.1.0`.

The gate is deliberate. `mode` defaults to `dry-run`, the publish step is
skipped unless `mode` is `publish`, and the job fails immediately if the
confirmation phrase does not match the version. A mistaken trigger cannot
publish. The workflow also runs only on `workflow_dispatch` and only in
`tsrx-org/oxc`, so no push, tag, or fork can start it.

What the workflow checks before it writes anything:

- the candidate run is a **completed, successful** run of
  `release-candidate.yml` on the SHA you named;
- `SHA256SUMS` still matches the downloaded bytes;
- the launch contract lists exactly nine packages with `@tsrx/oxc` last;
- every tarball's manifest carries the version you typed, `access: public`, and
  `provenance: true`;
- `@tsrx/oxc`'s `optionalDependencies` are exactly the eight platform packages,
  each pinned to that version;
- **the gate**, `scripts/check-publish-artifacts.ts`, over all nine tarballs.

Then, in this order:

1. **Rehearse the backstop** (`dry-run` mode only). Installs a real published
   release from npmjs.com and runs it. See
   [what a dry run proves](#what-a-dry-run-proves) below.
2. **Rehearse the publish**. `npm publish --dry-run` against npmjs.com for all
   nine, which is also the check that the version is still free.
3. **Publish in launch-contract order** (`publish` mode only).
4. **Install the published release from the registry and run it** (`publish`
   mode only). The backstop itself.

The backstop rehearsal sits above the publish rehearsal on purpose. It used to
be the last step in the file, where it was skipped whenever the publish
rehearsal correctly refused an already-published version. That is how it reached
0.1.4 having never executed once.

### The gate

This is the step that replaced "publish it and then look". It runs in both
`dry-run` and `publish` mode, nothing below it runs if it fails, and it writes
`release-gate-report.json` as a workflow artifact you can read afterwards.

For every one of the nine tarballs it asks, in this order:

1. **Is every path the package promises really inside it?** Each manifest's
   `files` array is compared against the tarball's actual contents. This is the
   shape oxc uses in
   [`check-npm-packages.js`](https://github.com/oxc-project/oxc/blob/main/.github/scripts/check-npm-packages.js),
   with two additions, because self-consistent is not the same as correct:
   - a platform package that declares no parser addon is rejected outright,
     since that is exactly what 0.1.0 published, and
   - the packed binary and `parser.node` bytes are cross-checked against that
     package's own `checksums.json`.
2. **Does it install?** The platform package for the runner plus the public
   package go into an empty project created outside this workspace, with none
   of this repository's environment overrides.
3. **Does the installed copy do real work?** A real lint has to produce a real
   diagnostic, and `@tsrx/oxc/parser` has to produce a real AST through the
   installed addon. A lint on its own is not enough: 0.1.0 broke the parser and
   left the linter working.
4. **Would npm accept it?** `npm publish --dry-run`, rehearsed against a local
   stand-in registry so the check can run at any version at any time.

The same gate runs on every pull request, in `ci.yml`, on all three Tier 1
platforms, with `--pack-host` so it packs and exercises whatever that runner
just built. That is what makes a packaging mistake fail on the pull request
that caused it rather than on release day. See
[platform support](../reference/platform-support.md) for which platforms those
are.

One known limit: in `dry-run` mode at a version that is already on npm, the
separate "Rehearse the publish" step against npmjs.com fails with `You cannot
publish over the previously published versions`. That is the check working. Use
an unpublished version if you want a clean dry run end to end. Every step before
it, including the backstop rehearsal, has already run by then.

### What a dry run proves

A dry run is the only way the post-publish backstop is ever exercised, so it is
worth being exact about what it does and does not establish.

| Step | In a dry run it | Proves |
| --- | --- | --- |
| The gate | runs in full over the nine tarballs you are about to publish | those exact artifacts install and work on this runner |
| Rehearse the backstop | installs a real release from npmjs.com and lints and parses through it | the backstop mechanism works, and whatever is currently on npm still installs and works |
| Rehearse the publish | asks npmjs.com to accept all nine | the version is free and npm accepts the tarball shape |

The backstop rehearsal cannot install the version being rehearsed, because that
version is not published yet. So `scripts/verify-published-release.ts
--rehearsal` retargets: if the requested version is not on the registry, it runs
every stage against the current `latest` of `@tsrx/oxc` instead, and says so in
the log. If the requested version *is* already published, it runs against that.
Either way the dry run installs something real from the registry into a project
outside the workspace and makes it produce a real diagnostic and a real AST.

What that does **not** prove is anything about the pending version's artifacts.
The gate directly above it covers those, on this runner and on all three Tier 1
platforms in `ci.yml`. Keep the two claims apart when reading the log: the gate
speaks about the release being made, the rehearsal speaks about the mechanism
and about the release already out there.

It follows that a failing backstop rehearsal at a version that is already
published is real news: the release on npm no longer installs and runs.

### If the publish fails with ENEEDAUTH or E404

Nearly always a trusted publisher configuration mismatch. Check in this order:

1. Workflow filename on npmjs.com is exactly `publish.yml`, with the extension
   and no directory.
2. Organization/user is `tsrx-org` and repository is `oxc`, case
   sensitive.
3. The **Environment name** field is empty, because `publish.yml` declares no
   environment.
4. `id-token: write` is present on the job (it is, on the `publish` job).
5. The package already exists. A name that has never been published cannot be
   configured, so this error on a first publish means step 1 of the setup was
   skipped.

npm's own troubleshooting notes that these errors are reported as generic 404 /
ENEEDAUTH rather than as a trusted-publishing diagnostic, so do not read the
message too literally.

## After you publish

The workflow does the round trip itself now. There used to be a manual `npm
view` checklist here; `npm view` resolving a version string is how 0.1.0 was
called verified while every platform package was missing `parser.node`, so it is
no longer the last word on anything.

The last step of a `publish` run is `scripts/verify-published-release.ts`, and
it is a **backstop, not the gate**. npm versions are immutable and unpublish is
restricted, so nothing after the publish can prevent a bad release. It can only
notice one, and the only remedy is deprecate and patch. Prevention lives in the
gate above.

What it does, on `linux-x64-gnu` only, because this is detection rather than
coverage:

1. waits for all nine names to be visible at the published version, retrying
   for up to five minutes, because a registry read can hit a replica that has
   not caught up with the write that just succeeded. The old 60-second budget
   went red on 0.11.0, 0.12.0 and 0.13.0 while every package had in fact
   landed; the slowest replica took close to four minutes;
2. installs `@tsrx/oxc@<version>` from the registry into a project outside the
   workspace, so the platform package is resolved through the published
   `optionalDependencies` the way a consumer's first install resolves it;
3. lints a real file and parses one through the installed addon.

Step 2 is the reason a post-publish check survives at all: it is the only place
that sees npm's own handling of the upload, which no pre-publish check can
reach.

The same script runs earlier in the job in `dry-run` mode with `--rehearsal`, so
the code path the release depends on is exercised by a rehearsal rather than
only by an irreversible publish. See
[what a dry run proves](#what-a-dry-run-proves). The only case it skips is a
package with no published version at all, where there is genuinely nothing to
install.

### What is still yours to check by hand

The automation covers the install and the run. These are not automated:

```sh
# Provenance really landed
npm view @tsrx/oxc@<version> dist.attestations

# A project that already pins official oxlint must keep its version
mkdir /tmp/oxc-tsrx-collision && cd /tmp/oxc-tsrx-collision
npm init -y
npm install -D oxlint@1.72.0
npx oxlint --version           # note the version
npm install -D @tsrx/oxc
npx oxlint --version           # MUST still report 1.72.0
```

The collision case is the regression that
`tests/packaging/released-host-install.test.mjs` guards, and that suite runs on
all three Tier 1 platforms on every pull request. Before that fix, npm silently
upgraded a pinned 1.72.0 to 1.74.0, and pnpm behaved differently again. Confirm
it against the published artifacts once, on a machine that has never built this
project, because the suite runs against locally packed tarballs rather than
against the registry.

## Edge cases specific to per-platform native packages

- **`optionalDependencies` fail silently.** If one platform package fails to
  publish, users on that platform get no install error. They get a runtime
  "binary not found" later, which reads like a bug in your code. The workflow
  checks all nine landed, but check the registry yourself before announcing.
- **`os`/`cpu` fields decide what gets downloaded.** A wrong or missing field
  means either the wrong binary on a platform or nothing at all.
- **musl versus glibc.** `linux-x64-musl` is what Alpine and many Docker images
  need. It is easy to leave out, and the failure looks like a corrupt binary
  rather than a missing variant.
- **One binary, three names.** Each platform package now ships a single
  multi-call executable that answers to `oxc-tsrx`, `oxc-tsrx-fmt`, and
  `oxc-tsrx-lsp` through `argv[0]` and through the `fmt` / `lsp` subcommands.
  Do not expect three files in the tarball.
- **The 72 hour unpublish window.** npm allows unpublishing within 72 hours of
  first publish. After that you can only deprecate. For a first release with
  nine interdependent packages, that window is your only clean undo.
- **Provenance is per-package.** All nine publish from CI, so all nine get
  attestation. A mixed release where some have it and some do not is worse than
  none having it.
- **Two dependencies are npm alias specs.** `@tsrx/oxc` depends on
  `"oxlint-current": "npm:oxlint@1.74.0"` and `"oxfmt-current": "npm:oxfmt@0.59.0"`.
  The names `oxlint-current` and `oxfmt-current` do not exist on npm and do not
  need to; the alias points at the real package. npm supports alias specs in
  published manifests, and the local clean-install and compat lanes exercise
  them. They are less common though, so confirm on pnpm, Yarn, and Bun after
  publishing rather than assuming parity. A failure here looks like an
  unresolvable `oxlint-current`.
- **Aliasing means the real `oxlint` package is present under another name.** A
  consumer ends up with real Oxlint installed as `oxlint-current`, so
  `require.resolve("oxlint")` still fails. That is exactly why Vite+ cannot see
  TSRX from a plain install, and it is expected, not a packaging bug.

## What is verified and what is not

Verified in CI on every pull request and every commit that lands on `main`, on
`ubuntu-24.04`, `windows-latest`, and `macos-latest`:

- install-only behavior for `npx oxlint` and `npx oxfmt`, the pinned-version
  collision case, and provider discovery across npm, pnpm, Bun, Deno, Yarn
  Berry node-modules, and Yarn Berry Plug'n'Play
  (`test:packaging:released-hosts` and `test:packaging:providers`);
- the pre-publish gate, against packages packed on that runner;
- a real lint, a real format, live `--lsp` sessions, and a parser addon load.

Verified at release-candidate time only, on a runner matching each target:
`darwin-x64`, `linux-arm64-gnu`, and `win32-arm64-msvc`. Never executed on a
musl system at all: `linux-x64-musl` and `linux-arm64-musl`. The per-target
detail is in [platform support](../reference/platform-support.md).

Verified on darwin-arm64 only:

- the released `oxc.oxc-vscode` extension driven with no setup step, which needs
  a real extension host.

Not verified anywhere:

- **The gate and the backstop in `publish` mode.** Both have run end to end, but
  neither has run on the same job as a real publish, because both landed after
  0.1.4 shipped. The gate has run over the nine real 0.1.4 candidate tarballs on
  the publish runner and on all three Tier 1 CI lanes. The backstop script ran
  against npmjs.com in dry run
  [30339428030](https://github.com/markless-dev/oxc-tsrx/actions/runs/30339428030),
  installing `oxc-tsrx@0.1.4` from the registry and linting and parsing through
  it. What is still unexercised is the two `if: inputs.mode == 'publish'` steps
  themselves, which are one condition away from what did run.
- **The `--rehearsal` retargeting branch, in CI.** Proven locally only. A dry run
  can only be dispatched at the version the candidate artifacts carry, and that
  version is currently published, so CI takes the direct path rather than the
  retarget. The retarget is what the next release's dry run will take, since its
  version will not be published yet.

Verified, contrary to what earlier revisions of this page said:

- **Trusted publishing.** `oxc-tsrx@0.1.4` was published by
  `.github/workflows/publish.yml` on `refs/heads/main` in run
  [30314008255](https://github.com/markless-dev/oxc-tsrx/actions/runs/30314008255),
  and says so itself: `npm view oxc-tsrx@0.1.4 dist.attestations` resolves a
  SLSA provenance attestation naming that workflow, that ref, and that run. No
  laptop publish can produce one. What that run used as its final check was the
  old `npm view` loop, which is why the backstop exists.

And one thing that is not a gap but reads like one:

- Vite+ cannot be served by a plain install. It resolves the *package* name
  `oxlint`, which a bin cannot satisfy and which this project cannot legitimately
  publish. `npx oxc-tsrx setup` remains the one command that fixes it. Say that
  plainly in launch copy rather than letting people discover it.

`docs/releasing/external-prerequisites.md` has since been corrected and now
lists the same nine names, with the four folded-in wrappers called out by name.
The two pages agree. That the eight-target list is written out by hand in ten
places at all is recorded in
[platform management follow-ups](platform-management-followups.md), along with
four other pieces of release machinery nobody checks.

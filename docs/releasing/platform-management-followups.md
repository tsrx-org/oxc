# Platform management follow-ups

Five known problems in how this project manages its eight native platforms.
None of them is broken today. All five are the same shape: machinery that a
human maintains by hand, with nothing that fails when the hand slips.

They were found while making platform coverage provable (Windows and macOS
execution on every pull request, the pre-publish gate, the published support
matrix). They were deliberately left out of that work because each is its own
piece of engineering, and they are written down here because the working notes
they came from are not in version control.

Nothing here is urgent. Read this before the next release, or before touching
the release workflows, whichever comes first.

**Line numbers move.** Every one below was checked on 2026-07-28. If a line
number does not match, search for the quoted text instead.

---

## 1. One version pin sits outside the bump script and has already drifted

**Mostly fixed since this was written.** `scripts/sync-version.ts` now owns the
version surface: 73 declared locations across 25 files, driven from the root
manifest, run by `.github/workflows/manual-release.yml`, and gated by
`node scripts/sync-version.ts --check`. It is not a search and replace. Each
location declares the shape it expects and how many times that shape occurs, so a
file that moved or changed shape fails the run and gets named instead of silently
not being updated. `pnpm run test:release` is the backstop: it reads the root
manifest at runtime and asserts every package manifest equals it.

**What is still wrong.** One pin is outside that surface, and it is the one that
had already drifted. The bump script deliberately does not touch the root
manifest's `devDependencies`, so nothing derives or checks that pin, and nothing
would notice it going stale again.

The places a bump touches:

| File | What is pinned |
| --- | --- |
| `package.json:3` | the workspace version, the source of truth every other location is derived from |
| `package.json:89` | `@oxc-tsrx/native-darwin-arm64`, a root devDependency, **pinned at `0.1.1`**, and outside the bump script |
| `packages/toolchain/package.json:3` | the published version of `oxc-tsrx` |
| `packages/toolchain/package.json:119-126` | the eight `optionalDependencies`, one per platform |
| `packages/tsrx-core-compat/package.json` | its own version |
| `packages/vscode/package.json` | its own version |
| `tests/packaging/public-package-metadata.test.mjs:46,67-74` | the version literal and all eight pins, asserted |

`package.json:89` is the drift. It pins `@oxc-tsrx/native-darwin-arm64` at
`0.1.1` while the workspace has moved on several releases past that. It was at
`:86` when this was first written; two devDependencies added by the release
tooling shifted it, which is the header's warning about line numbers in action.

**Why it matters, and how much.** That particular drift is low severity and you
should not rush to fix it in isolation: it is a root `devDependency`, nothing
published depends on it, and the pins that consumers actually resolve are
asserted against the shipped version literal by
`tests/packaging/public-package-metadata.test.mjs`, which
`scripts/sync-version.ts` rewrites on every cut. So the published surface is
protected. What is not protected is this one pin. The drift is the visible
symptom: a pin went stale for three releases and no check anywhere noticed, which
is the same failure mode that let two out-of-workspace `Cargo.lock` files go
stale for two releases.

**Research finding worth keeping.** oxc and rolldown do not hand-edit these
pins at all. Both *generate* the per-platform `optionalDependencies` with the
napi CLI as a release step (`napi pre-publish` / `napi create-npm-dirs`; oxc's
release workflow comments that it "adds optionalDependencies to package_path").
Hand-editing has no precedent among the projects surveyed. Both projects also
gate the whole release on an automated version-change detector rather than on a
human noticing.

**What fixing the rest would involve.** The bump script and the lockstep test are
both landed, which is the second half of the original recommendation. Two pieces
remain. The smaller one is the `devDependency` pin above: either derive it from
the root version like everything else, or add it to the bump script's declared
surface so a stale value fails `--check` instead of sitting there. The larger one
is the napi CLI route, which oxc and rolldown use: it *generates* the
per-platform `optionalDependencies` rather than rewriting them, so the shape
cannot drift at all. This project rewrites declared slots instead, which is a
weaker guarantee than generation, and it is worth revisiting the next time the
target list changes.

---

## 2. The eight-target list is hand-duplicated in ten places

**What is wrong.** `packages/toolchain/dist/native-targets.js` is the canonical
list of the eight targets. Ten other files restate it by hand:

| File | Line | What it restates |
| --- | --- | --- |
| `.github/workflows/release-candidate.yml` | 27-77 | the build matrix: target, package suffix, runner, expected platform, arch, libc |
| `packages/toolchain/package.json` | 119-126 | the eight `optionalDependencies` |
| `docs/releasing/v0.1.0-launch.json` | 17-27 | the publish order |
| `tests/packaging/public-package-metadata.test.mjs` | 67-74 | the expected pins |
| `docs/reference/platform-support.md` | 40-80, the tier lists | the reader-facing matrix |
| `docs/releasing/platform-abi-policy.md` | 14-21 | target, runner, npm selector, VSIX target |
| `docs/releasing/publish-runbook.md` | 31, 158, 202 | the nine names, twice as shell commands |
| `docs/releasing/launch-runbook.md` | 49-57 | the nine names |
| `docs/releasing/external-prerequisites.md` | 14-17 | the eight scoped names |
| `docs/archive/tsrx-parser-api.md` | 1824-1831 | an archived matrix, no longer maintained |

**Why it matters.** Adding or removing a target means finding all eleven copies.
A workflow copy fails loudly when it goes stale. A docs copy does not: it just
quietly tells a reader their platform is supported, or fails to mention one that
is. There is precedent for exactly that: the four-name collapse of 2026-07-25
left several of these lists disagreeing until they were corrected one at a time
by hand.

**What already covers part of it.** `tests/site/platform-support-matrix.test.mjs`
binds `docs/reference/platform-support.md` to `native-targets.js` and fails when
either side gains, loses, or renames a target. That is one copy of ten. It runs
in `site-artifact.yml`, on pull requests and on `main`.

**What fixing it would involve.** Two separable pieces. The release matrix can
be generated: a small job emits `native-targets.js` as JSON and the build matrix
reads it through `fromJSON`, which removes the copy that costs the most when it
is wrong. The docs copies are better deleted than tested: most of them could
link to `docs/reference/platform-support.md` instead of restating it, leaving
two lists in the repository rather than eleven. Extending the drift test to the
remaining docs copies is the cheap middle option and would take about an hour.

---

## 3. Forty-three hardcoded toolchain literals across the workflows

**What is wrong.** Rust, Node, and Vite+ versions are written out in full at
every use site.

```sh
grep -rn "1\.95\.0\|1\.97\.0\|24\.15\.0\|0\.1\.24\|0\.2\.4" .github/workflows | wc -l
```

That returns 43 today, across five workflow files: `advisory.yml` 11,
`ci.yml` 16, `publish.yml` 3, `release-candidate.yml` 9, `site-artifact.yml` 4.
It was 41 when it was first counted a few days earlier, which is itself the
point: the number moves and nobody is tracking it.

Two Rust versions are in play deliberately, and the split is easy to lose:
`1.95.0` is the build toolchain for shipped artifacts (`ci.yml:37-40`,
`ci.yml:174-178`, `release-candidate.yml:112-113`), and `1.97.0` is a
forward-looking lane plus the SBOM tooling (`ci.yml:43`,
`release-candidate.yml:249-253`, `advisory.yml:42-46`).

One literal is baked into a **job display name**:

```yaml
# .github/workflows/ci.yml:255
name: Clean install / Vite+ 0.3.2 and 0.3.3
```

**Why it matters.** A toolchain bump is a find-and-replace across five files
where a missed site does not fail, it just silently keeps building on the old
version. The display name is worse than the others: it is the string that
appears in the checks list and in branch protection rules, so it can claim a
version the job no longer uses, and renaming it breaks any required-check
configuration that names it.

**What fixing it would involve.** Workflow-level `env` covers most of the sites.
Be aware of one wrinkle before starting: `jobs.<id>.name` cannot read the `env`
context, only `github`, `needs`, `strategy`, `matrix`, `vars`, and `inputs`. So
the display name needs either a repository variable or a rewording that carries
no version at all, which is probably the right answer. A test that greps the
workflows for a version literal outside the declared `env` block would keep it
from growing back.

---

## 4. The image that builds the shipped artifact is never the image that verifies it

**What is wrong.** The two pipelines run on different runner images and
different Rust versions.

| | `release-candidate.yml` (builds what ships) | `ci.yml` (verifies) |
| --- | --- | --- |
| Linux | `ubuntu-22.04`, `ubuntu-22.04-arm` (`:42-60`) | `ubuntu-24.04` (`:29`, `:145`) |
| Windows | `windows-2025`, `windows-11-arm` (`:66-71`) | `windows-latest` (`:147`) |
| macOS | `macos-14`, `macos-15-intel` (`:30-36`) | `macos-latest` (`:149`) |
| Rust | `1.95.0` (`:112-113`), `1.97.0` in the assemble job (`:249-253`) | `1.95.0` (`:174-178`) and `1.97.0` (`:43`) |

**Which half of this is deliberate.** The Linux difference is a decision, not an
accident: GNU builds use Ubuntu 22.04 to keep the glibc floor low, and
`release-candidate.yml:150-156` asserts that no shipped binary references a
symbol newer than `GLIBC_2.35`. That is documented at
`docs/releasing/platform-abi-policy.md:29-33` and should stay. The rest is
unexamined. `windows-latest` and `macos-latest` are moving labels, so what CI
verifies on can change without a commit, and whether it currently matches the
pinned release image is not something a reader can tell from the file.

**Why it matters.** A defect that only appears on the image the release is built
on cannot be caught by a lane running on a different image. It is a narrow gap
rather than a gaping one, because the release candidate does execute a real
lint, a real format, and live `--lsp` sessions on natively matching runners for
all eight targets. But that only happens on manual dispatch, so the continuous
lanes are the ones that would catch a regression early, and they run elsewhere.

**What fixing it would involve.** Cheapest first: pin `windows-latest` and
`macos-latest` in `ci.yml` to the images the release actually uses, so the two
sides are readable and a runner-image migration becomes a commit rather than a
surprise. Aligning Linux is the expensive one and probably not worth it, since
`ubuntu-24.04` is the right image for a verification lane and `ubuntu-22.04` is
the right image for a shipped artifact. Write down which differences are
intentional, next to the assertion that enforces the floor.

---

## 5. The Windows `0xC0000409` fast-fail, now diagnosed: a libuv bug in Node 24.15.0

**Root cause, found 2026-11-05.** The process that dies is `node.exe` running
the package manager, and the defect is in the libuv that Node 24.15.0 bundles
(1.51.0). Its Windows TCP code calls `RtlGetVersion` with an `OSVERSIONINFOW`
whose `dwOSVersionInfoSize` was never initialized, so the call can write past
the structure. The `/GS` cookie check in `uv__tcp_keepalive` / `uv__tcp_connect`
then calls `__fastfail(FAST_FAIL_STACK_COOKIE_CHECK_FAILURE)`, which exits
`0xC0000409` without stderr, a Node report or a WER record. That is exactly the
silence measured below. Every install here opens many keep-alive TCP connections
to the loopback registry, which is the trigger. It was fixed upstream by
libuv `aabb7651de` ("win: properly initialize OSVERSIONINFOW"), cherry-picked as
nodejs/node#62561 and first shipped in Node 24.16.0. nodejs/node#63620 bisects it
on `windows-latest`: 24.15.0 crashes, 24.16.0 is clean. The 22.12.0 arm below
came back clean because 22.12.0 predates the libuv change.

Runner image `windows-2025-vs2026` 20261030 (OS build 26100.33674, up from
.33650) raised the rate from about one run in nine to about one in three. Every
pass from October was on 20261021, and every failure from November was on 20261030
or 20261103. Nothing in the repository changed. The new image makes the existing bug
fire more often. It did not create it.

**Fix.** Every workflow that pinned Node 24.15.0 now pins 24.22.2. That covers
`ci.yml`, `release-candidate.yml` with its Windows lanes, `publish.yml`,
`manual-release.yml`, `site-artifact.yml` and `advisory.yml`. The product floors
(20.19.0 and 22.12.0) are unchanged, and they predate the libuv change. The
bounded retry on this exit code in `tests/packaging/provider-discovery.test.mjs`
has been removed, so the status fails immediately again if it ever comes back.

The original write-up follows, unchanged, as the record of what was ruled out.


**What is wrong.** On Windows runners, an `npm` or `pnpm` child process is
occasionally killed by Windows itself with exit status `3221226505`
(`0xC0000409`, `STATUS_STACK_BUFFER_OVERRUN`) part-way through an install.

**The measured rate.** 6 fast-fails in 54 unmodified executions of the Windows
packaging suite: roughly one in thirty-five package-manager installs, which
works out to about **11% of runs** because each run performs several installs.
It is recorded in the test that trips over it, at
`tests/packaging/released-host-install.test.mjs:112-126`.

**What has been ruled out, with evidence.**

- *This project's own code.* Every install passes `--ignore-scripts`, so no code
  from this repository is loaded into the process that dies. It hits `npm.cmd`
  and `pnpm.cmd` identically, at install positions 1, 4 and 5, with no pattern.
- *A recently added test step.* It reproduced on a fresh machine with the
  packaging suite moved ahead of the new steps.
- *Resource pressure or accumulated residue.* It failed on an idle machine with
  13 GB free memory, 29 GB free disk, zero surviving node processes and no
  leftover temp directories; eight further runs on that same dirty machine all
  passed. Handle count stayed flat at ~47k across the job.
- *Windows Defender.* `RealTimeProtectionEnabled` is `False` on the image.
- *A Node fatal error.* `--report-on-fatalerror` was armed for every child across
  24 runs including two that fast-failed, and no report was written, so it is
  neither an out-of-memory nor a V8 `CHECK`.
- *Any exception Windows Error Reporting can see.* `WerSvc` running, `LocalDumps`
  and `SilentProcessExit` both armed for `node.exe`, and both reproductions
  produced no dump and no Application Error event.
- *A Node version regression.* 12 runs on 22.12.0 and 12 on 24.15.0, zero
  fast-fails in either arm.

A process exiting `0xC0000409` while all three of those recorders are armed and
none of them records anything is not the shape of an ordinary unhandled
exception. Going further needs a live debugger on a `windows-2025` runner.

**Why it matters.** At about 11% per run, roughly one pull request in nine gets
a red Windows leg for a reason that has nothing to do with the change. That is
the rate at which people start ignoring the lane, which is worse than not having
it. It is also not new: the step it hits pre-dates continuous Windows execution,
so this was happening before anyone was watching.

**What has already been done.** The assertion now names the status instead of
printing a bare `3221226505`, so the next person does not have to rediscover
which of the two readings of that integer applies. Nothing tolerates it: the
assertion still fails.

**The decision that is still open**, and it belongs to the owner rather than to
a test:

- a narrowly scoped retry, restricted to this exact status on this exact class
  of child process, which risks masking a genuine crash of the same shape; or
- an upstream report to `actions/runner-images` with the measurements above,
  which costs nothing but fixes nothing on any schedule you control.

Doing both is reasonable. Doing neither means the lane keeps failing at 11% and
the flake gradually teaches everyone to press rerun.

## 6. The Vite HMR teardown race, now fixed, recorded so it is not rediscovered

`tests/vite/framework-chain.test.mjs` removed its temporary project with a
plain recursive `rm` in a `finally` block. Vite's dependency optimizer writes
into `node_modules/.vite/deps_temp_*` from its own timers, so the removal
sometimes raced a directory Vite was still filling and failed:

```
[Error: ENOTEMPTY: directory not empty, rmdir
  '/tmp/oxc-tsrx-vite-react-yCW2mv/node_modules/.vite/deps_temp_4b8f356d']
```

It turned `main` red at `b3ad509` on the Rust-current lane, 157 of 158 passing,
and it had appeared at least twice before that on other branches without being
written down anywhere.

The assertions had already passed both times. The failure was in cleanup of a
temporary directory that was being deleted anyway, so both teardown sites now
pass `maxRetries` and `retryDelay`, which is what Node provides for exactly this
race. Nothing about the test's assertions changed, and the teardown still fails
the test if the directory genuinely cannot be removed.

**Why this is in this file.** It is the second unrecorded CI flake found during
one goal, after the Windows `0xC0000409` fast-fail above (since diagnosed). A flake that lives
only in a rerun is indistinguishable from a real failure that nobody
investigated, and the charter line it bears on is "do not add a CI lane whose
failure will be ignored". If a third appears, the pattern is worth treating as
its own piece of work rather than as three separate annoyances.

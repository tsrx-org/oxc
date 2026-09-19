# Dependency and toolchain upgrade policy

Installed artifacts are insulated from upstream churn: the official OXC
workspace engine closure is pinned to one commit and compiled into the native
binaries; remaining registry dependencies are locked separately.
Official npm tools and Vite+ are exercised at explicit supported versions. An
upstream release never changes an already-installed OXC for TSRX binary.
This is artifact immutability, not automatic compatibility with arbitrary
future OXC revisions. Adopting a new revision is a deliberate OXC for TSRX
release that may require adapter changes and always requires full qualification.

## Current frozen set

As of 2026-09-18, the release candidate is qualified against:

- official OXC commit
  `5a6e37e5cf895143a5b34050c50109c46e2ae96a` (crates v0.150.0) across twelve direct adapter Git
  dependencies, with their canonical workspace closure resolved from the same
  source and commit;
- official Oxlint 1.83.0;
- official Oxfmt 0.68.0;
- `oxlint-tsgolint` 7.0.2002;
- Vite+ 0.1.24 as the tested minimum supported release; and
- Vite+ 0.2.4 as the pinned current release (as of the date above).

Vite+ 0.1.20 is retained only as an isolated non-blocking Markless compatibility
control. It has published dependency advisories addressed in later Vite+
releases and is not supported for new installs. An unpublished commit or
announced version is not a support lane. Add a next lane only after an official
npm package exists and a clean consumer qualifies it.

## OXC adapter upgrade procedure

`.github/workflows/advisory.yml` resolves official OXC `main`, replaces the
release pin in a disposable copy, conservatively updates the Git lock source,
and runs compile/behavior checks. The job is deliberately non-blocking. It is an
early warning, not permission to merge or release that revision.

For a deliberate upgrade:

1. Record the candidate's full canonical Git SHA, app/crate versions, Rust
   version, release notes, and motivation. Never use a branch, tag, fork, local
   checkout, or abbreviated SHA in a release manifest.
2. Change all twelve `rev` fields together in
   `crates/oxc_adapter/Cargo.toml`. Change the public revision constant and the
   runtime/native/VSIX distribution metadata in the same patch.
3. Update only the official OXC lock source with Cargo's precise Git revision
   support. Inspect `Cargo.lock`; unrelated registry movement is not part of an
   OXC upgrade.
4. Run `tests/packaging/boundary.test.mjs`. It must prove one repository, one
   full revision, one lock source, no OXC dependency outside `oxc_adapter`, and
   no patch, source replacement, vendor tree, copied crate, or local checkout.
5. Adapt public API changes inside `crates/oxc_adapter`. Do not spread OXC APIs
   into syntax, lint, format, CLI, runtime, or editor crates to make a compile
   error disappear.
6. Refresh the exact upstream OXC `LICENSE`, `THIRD-PARTY-LICENSE`, and
   provenance record. Update the expected hashes in the license inventory
   generator and regenerate the locked shipping dependency report.
7. Run Rust formatting, clippy, all workspace tests, all npm and package tests,
   clean-install proof, Vite/Vite+ minimum/current, installed VSIX proof, the
   read-only Markless corpus, and the complete same-machine performance matrix.
8. Compare ordinary JS/TS/JSX/TSX throughput, TSRX parse/lower, lint, format,
   CLI startup, RSS, and incremental editor measurements to the frozen budgets.
   An API-compatible compile with a performance regression is not qualified.
9. Build a new eight-target candidate. Never reuse artifacts produced by the
   scheduled advisory copy.

### Re-baselined ratios

Two budgets are ratios against the stock tool rather than absolute floors, so an
upstream release that makes Oxlint or Oxfmt faster or leaner can turn them red
without any change on this side. On 2026-09-18 (crates v0.150.0, Oxlint 1.83.0,
Oxfmt 0.68.0) the owner re-baselined both with the candidate's absolute numbers
flat or better: the native-lint P02 equivalent-TSX floor moved from 0.50 to 0.45
(candidate 213-215 MiB/s against 214-227 before; stock plain-TSX parse 442-449
MiB/s against 418-436), and the native-format P07 RSS ceiling moved from 1.15 to
1.30 (candidate 194 MiB against 208 before; stock Oxfmt 157 MiB against 182).
The frozen-hash snapshot in `tests/acceptance/performance-contract.test.mjs` and
the weaken-guard in `crates/oxc_tsrx_format_benchmark/src/budgets.rs` carry the
same values. A ratio may only move this way when the candidate's own absolute
measurement did not regress, and the reason must be recorded here.

One deliberate exception, on 2026-09-19: the formatter's settling pass
(tsrx-org/oxc#93) formats a file the first pass changed a second time and
returns the settled output, so one `--write` leaves nothing for `--check`. The
format benchmark corpora are unformatted, so every sample pays that second
pass: the P04 direct-route ratio against the single-pass canonical control moved
from 1.05/1.08 to 2.25/2.3 (observed 2.04 median, 1.95 p95) and the
generalized-control floors from 15/12 MiB/s to 7/6 MiB/s (observed 8.26-8.93
median, 7.35-8.48 p95 across two runs).
The Vite boundary lane's mixed format p95 ratio ceiling moved from 2 to 2.25 for
the same reason (observed 1.955 before, 2.05-2.11 after). The candidate's single-pass
cost did not change; already-formatted input, which
is what `--check` on a clean tree and the editor see, still costs one pass. The
owner chose this over gating the second pass on a re-parse of the output
(narrower, about 1.2x) and over waiting for the upstream formatter fix.

If the candidate needs `[patch]`, `replace-with`, a fork, copied upstream
source, an unpublished local crate, or a second OXC revision, reject it and keep
the current pin. Waiting is safer than turning routine upstream releases into a
downstream patch queue.

## Official Oxlint, Oxfmt, and Vite+ upgrades

The public toolchain's internal lint and format adapters own `.tsrx` and
delegate ordinary source to exact official tool packages. For each proposed
official-tool change:

1. add the version as a candidate alias without removing the current lane;
2. install it from the public registry in an empty consumer with lifecycle
   scripts disabled;
3. audit that consumer and record resolved versions;
4. exercise mixed TSRX/TSX lint, format-check, write/fix/check convergence,
   config materialization, type-aware opt-in, and failure on a missing/mismatched
   native package;
5. prove ordinary source still goes to the official engine and `.tsrx` still
   goes to the native project engine exactly once;
6. run the ecosystem performance boundary; and
7. promote the candidate to current only after the existing minimum and current
   lanes remain green.

Minimum support is removed only in a documented breaking release or when a
security issue makes it unsafe. A legacy advisory lane never appears in install
instructions and never makes a required release check optional.

## Embedded CSS remains byte-preserved

Embedded `<style>` payloads are not formatted. The surrounding TSRX/JSX is
formatted, while CSS bytes are copied exactly. This is an intentional safe
boundary, not an overlooked formatter option.

At the pinned OXC revision and the current release checked for this tranche,
using the canonical CSS parser/formatter still requires a downstream allocator
dependency patch. That violates the no-patch, one-canonical-revision release
contract. Therefore OXC for TSRX keeps CSS raw and claims neither CSS formatting
nor CSS validation.

Requalify CSS only when all of the following are true:

- the public official OXC dependency graph resolves at one exact revision with
  no Cargo patch, source replacement, fork, vendor copy, or local checkout;
- CSS parse/format uses a clear single allocator/ownership boundary;
- one adversarial batch test covers malformed CSS, closing-tag-like bytes,
  comments, strings, escapes, interpolation-adjacent text, and large payloads;
- failure is all-or-nothing and cannot partially rewrite a `.tsrx` file;
- output reparses, preserves TSRX semantics, and converges after one pass;
- the full Markless corpus proves every affected payload and external
  fingerprint; and
- parse/format/RSS/copy and editor latency remain inside the frozen budgets.

If any condition is absent, retain raw bytes and keep the limitation explicit.
CSS requalification must not delay unrelated safe OXC upgrades, and an OXC
upgrade must not silently turn CSS formatting on.

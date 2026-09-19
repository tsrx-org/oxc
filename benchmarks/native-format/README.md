# Native formatter performance gate

Run the release-only gate after building the formatter binary:

```sh
pnpm run build:native
pnpm run benchmark:native-format
```

Use `pnpm run build:native`, not bare `cargo build`. The three old release
binaries are now one multi-call executable that selects its tool from `argv[0]`
or from a leading subcommand, and `budgets.json` names the candidate by file
path only, so it cannot pass a subcommand. `budgets.json` is frozen evidence:
`tests/acceptance/performance-contract.test.mjs` pins its SHA-256 and
`docs/acceptance/performance-report.json` embeds its exact bytes, so the
`candidateBinary` path is made valid instead of edited. It also cannot simply
point at `target/release/oxc-tsrx`, because with no tool in `argv[0]` and no
subcommand that binary runs the linter, which would silently measure the wrong
tool.

`scripts/build-native.ts` therefore rebuilds a fresh copy at
`target/release/oxc-tsrx-fmt` after every build and checks that it reports
`oxc-tsrx-fmt --version` before it is used. It is a copy rather than a hardlink
because cargo replaces the binary with a new inode, so a link made once would
serve a stale build forever. The copy is a local build convenience only: the
published platform package still ships exactly one `bin/oxc-tsrx`.

Schema 2 records raw latency/RSS arrays, hardware/toolchain/OXC identity,
corpus hashes, sample policy, summaries, and every assertion in a timestamped
`results-*.json` report. It contains two in-process grammar lanes:

- the retained 1 MiB statement-control corpus preserves comparison with prior
  T015/T016 reports; and
- a 256 KiB generalized corpus repeats direct JSX-child, nested, expression,
  annotated `@for`/`@empty`, `for await`, `@switch`/`@case`/`@default`, and
  `@try`/`@pending`/`@catch` controls, plus nested dynamic tags and raw style
  payloads. Its half-size companion detects nonlinear work. The report records
  dynamic/style counts and requires one JS/TSX parse, zero hidden CSS parses,
  byte-preserving convergence, and honest embedded timing metadata.

P04 also measures canonical Oxfmt, the ordinary direct product path, and an
absolute 16.6 MiB/s floor derived from 10× a historical (non-comparable)
1.66 MiB/s Prettier result. That floor is a retained regression threshold, not
a like-for-like 10× speedup claim. P04 also measures complete default-thread
multi-file `--check` and
an isolated configured session that must load once, parse two files exactly
twice, and visibly apply its quote/semicolon options.
P05 compares fresh project TSRX stdin with official Oxfmt on equivalent TSX.
P07 compares complete-output RSS for TSRX and canonical TSX in the same Rust
binary.

The harness rejects weakened limits. Existing gates remain: ordinary median
and p95 overhead ≤2.25×/2.3× (re-baselined from 1.05×/1.08× on 2026-09-19 with
the formatter's settling pass, tsrx-org/oxc#93: a file the first pass changed is
formatted a second time, and this corpus is unformatted, so every sample pays
that pass against the single-pass canonical control; observed 2.04×/1.95×),
sequential TSRX ≥15 MiB/s and ≥16.6 MiB/s (10× the historical incumbent floor),
batch p95 throughput ≥100 MiB/s, stdin p95 ≤110 ms and ≤1.25× official Oxfmt,
and RSS ≤1.30× canonical TSX (re-baselined from 1.15× with the OXC crates
v0.150.0 upgrade: stock Oxfmt 0.68.0 lowered its own peak RSS from ~182 MiB to
~157 MiB while the candidate fell from ~208 MiB to ~194 MiB, so the ratio rose
although both absolute numbers improved). The generalized control lane additionally
requires ≥7 MiB/s median, ≥6 MiB/s p95 (re-baselined from 15/12 MiB/s with the
settling pass; observed 8.26-8.93 median, 7.35-8.48 p95), ≤1.35× normalized full/half scaling,
one OXC parse per formatter pass, and idempotence.

Aggregate-selected representative report: `results-1789839644878.json`
(OXC crates v0.150.0, stock Oxfmt 0.68.0).

- 55.68 MiB/s median (48.69 MiB/s p95) retained sequential corpus;
- 688.64 MiB/s default-thread 16 MiB batch at p95;
- 8.81 MiB/s generalized median and 7.80 MiB/s p95 across 394 dynamic tags
  and 197 raw style payloads;
- 1.019× generalized normalized scaling;
- one timed config load for two files/two parses with applied options;
- 2.82 ms fresh stdin p95; and
- 1.171× complete-output RSS.

The report retains 30 raw samples for every sequential phase. No assertion
landed inside the policy's 3% near-threshold band, so the aggregate selected
this single fresh report without adjudication. The RSS ceiling itself was
re-baselined to 1.30× in this upgrade (see above); under the previous 1.15×
ceiling the v0.140.0-era representative `results-1785296526997.json` had been
adjudicated by three fresh runs at 1.143476× each.

The stdin upstream ratio compares the direct Rust candidate executable with
the official Oxfmt npm launcher. It is a diagnostic guardrail rather than a
tool-speed claim; the absolute 110 ms p95 ceiling is the product gate.

`results-1784180050706.json` is the retained generalized red: the old repeated
search/string-shift lift reached only 0.324 MiB/s and scaled at 1.928×. Earlier
reports retain the original T015 quadratic token-lift and batch regressions.

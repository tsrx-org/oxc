# Vite and Vite+ boundary benchmark

Run from the repository root after the release native binaries exist:

```sh
node benchmarks/vite/run.mjs
```

The harness compares the project-owned mixed `.tsx`/`.tsrx` command packages
with canonical Oxlint/Oxfmt over two equivalent ordinary TSX files. A separate
matched Oxfmt lane runs `oxfmt-tsrx` over those same two ordinary files, proving
the exact manifest-declared Oxfmt launcher is imported in the same Node process,
with zero TSRX dispatch, without conflating it with mixed formatting. It also
measures a complete current-when-frozen Vite+ mixed lint command, retains every
raw sample, and asserts that the TSRX lane records one native parse while
ordinary files remain in the canonical upstream process. Each lane uses five
warmups and 20 measured fresh processes; the report retains host/build/OXC and
corpus identity.

These process-boundary budgets supplement, rather than replace, the much tighter
native hot-path budgets in `benchmarks/native-lint` and
`benchmarks/native-format`. Vite runtime build/HMR compilation remains entirely
framework-owned and is exercised by `tests/vite/framework-chain.test.mjs`; OXC
for TSRX does not add a transform or parser to that path.

Aggregate-selected representative report:
`results-1789790952481.json`. The ordinary `oxfmt` median is 34.30 ms
versus canonical Oxfmt 0.68.0's 34.68 ms on the identical files; p95 is 38.42
ms versus 40.32 ms (0.953×). Exact normalized stdout/stderr and exit status
match, and trace evidence records zero TSRX dispatch events. The mixed
companion p95 is 63.91 ms for lint (1.888× canonical two-file TSX) and 61.50
ms for format-check (1.525× canonical). A complete Vite+ 0.2.4 mixed lint is
272.16 ms p95. The
native metadata records exactly one TSRX parse and zero ordinary files in the
project-owned lane.

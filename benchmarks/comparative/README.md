# Matched cross-tool CLI benchmark

Run the release-only comparison after building the native lint binary:

```sh
cargo build --release --locked -p oxc_tsrx_cli --bin oxc-tsrx
pnpm run benchmark:comparative
```

The cross-tool lanes give ESLint plus typescript-eslint, official Oxlint, and
OXC for TSRX the same byte-identical 1,000-file TSX corpus, the same explicit
file list, and the same single `no-debugger` rule. Every lane is measured
through its npm CLI entry point, exactly as a project invokes it, so each time
includes that tool's own Node launcher. The OXC for TSRX lane is the
`oxlint-tsrx` command with `OXC_TSRX_LINT_BIN` pinned to the release binary
under test. When every explicit file is ordinary JS/TS, the launcher imports
the exact npm binary declared by `oxlint-current` in the same Node process. A
mixed list retains that canonical lane and additionally runs the native TSRX
binary. It uses only the public manifest-declared launcher in a Node child; the
child starts while the bridge loads, and no private Oxlint module is imported.
Ambiguous paths, directories, globs, and unknown options never take the
ordinary-only shortcut.
Every tool must validate 1,000 files with zero diagnostics and default output
before timings are accepted. The harness records five warmups and twenty
measured fresh processes per lane, using median and nearest-rank p95 latency.

A fourth, mixed-file-types lane replaces 20% of those files with paired TSRX
generated from the same component specifications. That lane is an internal OXC
for TSRX workload ratio only. It is not compared with ESLint or official
Oxlint because those tools do not parse TSRX.

Aggregate-selected representative report: `results-1789794045675.json`.

| Lane | Median | p95 |
| --- | ---: | ---: |
| ESLint + typescript-eslint, matched TSX | 650.04 ms | 664.29 ms |
| Official Oxlint 1.83.0, matched TSX | 44.15 ms | 45.24 ms |
| OXC for TSRX npm CLI, matched TSX | 50.98 ms | 53.20 ms |
| OXC for TSRX npm CLI, mixed file types (20% TSRX) | 72.13 ms | 76.14 ms |

On this retained host and corpus, OXC for TSRX's matched-TSX median was 1.155×
official Oxlint's median. That all-TSX command imports the exact
manifest-declared official Oxlint launcher in the same Node process with zero
TSRX dispatch. ESLint's median was 13.23× OXC for TSRX's, and the mixed OXC for
TSRX workload was 1.451× its all-TSX lane. The mixed route proves exactly one
public canonical Node child and one native TSRX child, with zero private
adapter children. These
are bounded fresh-process results for the recorded versions and fixture, not a
universal tool-speed ranking or a claim about unrelated rules and projects.

The 1.489× mixed ratio fell inside the unchanged 3% near-threshold band around
the 1.50× ceiling. The aggregate therefore required exactly two additional
fresh, identity-matched reports. Only the triggering mixed-ratio assertion can
pass by two of three; every other assertion and invariant must pass in all
three. The retained ratios were 1.489×, 1.474×, and 1.492×, and every route
proof passed. The published report is the median normalized budget-pressure
sample, with a stable report-path tie-break—not the fastest sample. A failure
more than 3% beyond a limit is definitive, and adjudication also fails if its
selected representative is red.

The report records tool versions, launcher identity, native build and OXC
revision, host identity, corpus/config hashes, validation counts, raw warmup
and measured arrays, direct-route absence, public mixed-child identity, and
every frozen assertion. The performance acceptance
runner verifies the sampling policy, comparison boundary, selected report
identity, and unchanged budget file before release.

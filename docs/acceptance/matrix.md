# Release acceptance matrix

This is the human-readable index for the fresh `0.1.0` correctness owner oracle
completed on 2026-07-16 and performance oracle completed on 2026-07-17.
Machine truth is retained in
[`clean-room-report.json`](clean-room-report.json) and
[`performance-report.json`](performance-report.json). Both reports have
`status: "passed"` and `failure: null`.

The correctness run used a byte-exact disposable copy, a lifecycle-script-free
`npm ci`, empty consumer projects, fresh Cargo targets, and locally produced
package artifacts. The performance run used the frozen same-machine budgets.
Neither run publishes or deploys anything.

## Correctness and ecosystem oracle

| Oracle clause | Direct observation | Retained evidence |
| --- | --- | --- |
| Clean install and native build | Fresh npm install, Rust formatting, Clippy, Rust tests, release binaries, and the editor bundle all exited successfully in a disposable source copy. No source-tree `node_modules` or binary override was used. | `clean-room-report.json`: `isolation`, `matrix.cleanSource`, and command records 6–13 |
| Installable packages | Untouched `@oxc-tsrx/runtime`, native, `oxlint-tsrx`, and `oxfmt-tsrx` tarballs were installed into an empty consumer with install scripts disabled. All native binaries resolved from that consumer's `node_modules`; the npm audit was empty. | `matrix.packagedConsumer.install`, `.resolutions`, `.packages`, `.audit`, and all nine `.assertions` |
| Native TSRX diagnostics and fixes | One OXC parse reported `debugger;` at authored byte 37 and `var` at byte 49. The identity-safe fix changed only `var` to `const`, then reparsed and relinted successfully. | `matrix.authoredSpanAndFix`; the diagnostic command's exit status `1` is intentional because `no-var` is denied |
| Formatter correctness | Check/write/check converged from installed packages. Every one of 179 parser-valid Markless files formatted, reparsed, and converged; all 12 parser-invalid completion fixtures were rejected; raw style payloads stayed byte-exact. | `matrix.claims.formatCheckWriteConverges`, `matrix.marklessCorpus`, and the successful `read-only 179-file Markless format/reparse/convergence corpus` command |
| Config, rules, plugins, and type awareness | JSON, JSONC, and serializable Vite config behavior passed; real OXC rules and built-in plugin namespaces passed; tsgolint ran once per opted-in batch. Unsupported JavaScript plugins fail loudly rather than silently downgrading. | `matrix.claims.jsonJsoncAndViteConfig`, `.builtinPluginAndTypeAware`, `.javascriptPluginUnsupportedLoudly`; `matrix.packagedConsumer.assertions.typeAwareTsgolint`; successful product matrix |
| Ordinary JS/JSX/TS/TSX path | Every ordinary source family remained delegated to the canonical direct path, with output/diagnostic parity and zero TSRX scan or projection allocation. | `matrix.claims.ordinaryJsJsxTsTsxDelegated`; successful product matrix; native lint/format direct-path parity tests and P01/P04 assertions |
| Vite build, plugin chain, dev, and HMR | A real framework compiler build and a real Vite dev-server edit passed through the official TSRX plugin chain, including watcher invalidation and an HMR payload, without an OXC transform. | `matrix.claims.viteFrameworkBuildDevHmr`; successful framework-chain test |
| Vite+ minimum and current | Clean physical consumers passed literal `vp build`, literal `vp dev` served compilation plus changed-source retransform, mixed lint, format-check, and convergent `check --fix` on Vite+ `0.1.24` and `0.2.4`. Both lanes had zero audit findings and no environment overrides. | `matrix.claims.vitePlusBuildDevRetransform`, `matrix.vitePlus.policy`, and both `matrix.vitePlus.lanes[].proof` objects |
| Installed editor behavior | A real target VSIX activated automatically beside Markless, used its embedded native server, published exact authored diagnostics, performed format-on-save, and applied a safe code action. | All six `matrix.editor.assertions`; embedded-server SHA-256 and installed directory in `matrix.editor` |
| External repository safety | Markless HEAD, tracked/staged diffs, status, untracked paths, and untracked bytes had the same combined fingerprint before and after. The editor operated on a disposable copy. | `external.unchanged: true`, identical `external.before/after`, `matrix.editor.markless.externalWrites: false` |
| Non-fork OXC architecture | The package boundary suite proved one exact canonical OXC adapter revision and rejected Cargo patches, vendor trees, copied OXC crates, and adapter bypasses. | Successful `package/non-fork/legal artifact matrix` command; `matrix.versions.oxcRevision` = `5a6e37e5cf895143a5b34050c50109c46e2ae96a` |
| Legal and release artifacts | Locked inventories verified 205 Rust and 12 bundled VS Code dependencies; host packages and the VSIX passed artifact checks. | Successful `locked legal inventories` and package/non-fork/legal matrix commands |

Every boolean under `matrix.claims`, `matrix.packagedConsumer.assertions`, and
`matrix.editor.assertions` is `true`. Both supported Vite+ lanes have
`proof.supported: true` and every performance lane below has
`allPassed: true`.

## Frozen performance oracle

| Lane | Fresh observation | Frozen gate result | Raw report |
| --- | --- | --- | --- |
| Native lint | 217.82 MiB/s median scan/project/parse; 70.02 MiB/s complete CLI lint; 1.232× equivalent-TSX CLI latency; 3.45 ms fresh-process p95 | 19/19 pass across one adjudication reports | [`native-lint/results-1789839639381.json`](../../benchmarks/native-lint/results-1789839639381.json) |
| Native format | 55.68 MiB/s sequential; 688.64 MiB/s default-thread p95; 8.81 MiB/s generalized control; 2.82 ms fresh-stdin p95; 1.171× complete-output RSS | 25/25 pass across one adjudication reports | [`native-format/results-1789839644878.json`](../../benchmarks/native-format/results-1789839644878.json) |
| Type-aware lint | Default syntax 2.76 ms p95 with zero type processes; one-file type-aware 24.51 ms p95; two-file project 25.76 ms p95; one type process per batch | 8/8 pass | [`type-aware/results-1789839646411.json`](../../benchmarks/type-aware/results-1789839646411.json) |
| Vite/Vite+ process boundary | Ordinary Oxfmt 37.27 ms p95 / 1.209× canonical; mixed lint 60.63 ms p95 / 1.856×; mixed format 64.95 ms p95 / 2.107×; Vite+ 0.2.4 mixed lint 286.85 ms p95; one native TSRX parse | 8/8 pass | [`vite/results-1789839658924.json`](../../benchmarks/vite/results-1789839658924.json) |
| Incremental editor | Fresh open 2.59 ms median / 2.77 ms p95 across 100 samples; diagnostics 0.113 ms p95; format 0.152 ms p95; code action 0.126 ms p95; 10.67 MiB RSS and 0 MiB growth after 1,000 edits | 8/8 pass | [`editor/results-1789839659592.json`](../../benchmarks/editor/results-1789839659592.json) |
| Matched CLI comparison | Same 1,000 explicit TSX files, one rule, every lane through its npm CLI: ESLint 696.09 ms, official Oxlint 44.11 ms, OXC for TSRX npm CLI 52.55 ms median through the zero-dispatch declared-bin route; paired 20% TSRX workload 74.33 ms / 1.414× all-TSX | All 3 assertions pass in a single unadjudicated fresh report | [`comparative/results-1789839682891.json`](../../benchmarks/comparative/results-1789839682891.json) |

Same-build ordinary-path and mixed-companion ratios are like-for-like as named.
Cold direct-Rust versus official npm-launcher ratios are diagnostic guardrails,
and 16.6 MiB/s is an absolute cross-corpus-derived formatter threshold rather
than a Prettier speedup claim. No lane equates complete TSRX formatting or
linting with a parser-only benchmark.

The unchanged 3% near-threshold policy triggered for formatter RSS and the
comparative mixed/all-TSX ratio. Each trigger required exactly two additional
fresh identity-matched reports. Only a triggering assertion may use two-of-
three tolerance; every other assertion and invariant must pass in all three.
The aggregate publishes the median normalized budget-pressure report with a
stable path tie-break and fails if that representative is red.

## Reproduce

```sh
MARKLESS_ROOT=/Users/jacksm5pro/dev/open-source/markless \
  node tests/acceptance/run.mjs

node tests/acceptance/run-performance.mjs
```

These commands may open an isolated VS Code test window. They must leave the
external Markless fingerprint unchanged. Publishing packages, deploying the
site, pushing a repository, publishing the VSIX, and posting launch material
remain separate approval-gated actions.

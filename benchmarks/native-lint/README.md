# Native lint performance gate

This release-only harness proves that the Rust/OXC lint path does not hide
projection, rule setup, process, or memory costs. It measures:

- P01: ordinary TSX through same-build `oxc_adapter` controls;
- P02: TSRX scan, one mapped legal-TSX projection, and one OXC parse;
- P03: semantic analysis, real `no-debugger` diagnostics, identity translation,
  the complete CLI boundary against equivalent TSX, and an isolated configured
  session that must load once, parse once, and apply its configured rule;
- P05: 20 fresh processes running `no-debugger` plus `no-unused-vars`; and
- P07: peak RSS in five fresh processes for equal-byte 8 MiB inputs.

The generated comparison corpus retains TypeScript, JSX, `@{`, statement
`@if`/`@else`, protected lexical contexts, and real diagnostics so results stay
comparable with earlier reports. Direct/nested/expression control mapping is
covered by black-box tests and the shared scanner/projection implementation,
including `@switch`/`@case`/`@default` and `@try`/`@pending`/`@catch`. This
historically stable corpus does not claim representative performance coverage
for every supported control family. Dynamic-tag traversal and raw-style lift
costs are exercised by the formatter's generalized native lane; raw style
payloads remain outside the JavaScript AST and are not CSS-linted.

```sh
cargo build --release --locked -p oxc_tsrx_cli --bins
cargo run --release --locked -p oxc_tsrx_benchmark -- \
  --assert benchmarks/native-lint/budgets.json
```

Every run writes a timestamped report with host/build identity, corpus hash,
raw nanosecond/RSS arrays, summaries, and assertions. The harness enforces at
least five warmups, 30 throughput samples, 100 warm 10 KiB samples, 20 fresh
processes, and five RSS processes.

Aggregate-selected representative report: `results-1789790934847.json`, with 220.44 MiB/s
scan/project/parse-and-dynamic-validation, 71.55 MiB/s complete CLI lint,
1.229× CLI latency versus equivalent TSX, and 3.96 ms fresh-process p95. Its
configuration assertions record one timed config load, one file/one parse, and
one real configured `no-debugger` diagnostic. No numeric threshold was
weakened.

The fresh-process upstream ratio compares the direct Rust candidate executable
with the official Oxlint npm launcher. It is retained as a regression
guardrail, not a cross-tool speed claim; the absolute 50 ms p95 ceiling is the
candidate cold-start product gate.

# Third-party notices

OXC for TSRX links canonical OXC Rust crates from commit
`5a6e37e5cf895143a5b34050c50109c46e2ae96a` of
<https://github.com/oxc-project/oxc>. OXC is licensed under the MIT License.
The byte-exact upstream `LICENSE`, upstream `THIRD-PARTY-LICENSE`, their source
URLs, and their SHA-256 provenance are shipped in `licenses/oxc/`.

The dependency is an exact-revision Cargo dependency. No OXC source is copied,
vendored, patched, or forked in this repository. The complete normal/build
dependency closure of the distributed Rust binaries, including locked versions,
Cargo license expressions, source identities, and registry checksums, is shipped
as `licenses/rust-dependencies.json` and `licenses/RUST_DEPENDENCIES.md`.
`scripts/generate-rust-license-inventory.ts --check` fails if that report,
`Cargo.lock`, the accepted-expression policy, or either canonical OXC legal file
drifts.

The lint and formatter benchmark harnesses use `memory-stats` 1.2.0 to read
current-process RSS without privileged process inspection. `memory-stats` is
dual-licensed under MIT or Apache-2.0 and is not linked into any distributed
binary, so it is deliberately outside the shipping dependency report.

OXC for TSRX is an independent community integration. It is not an official OXC
project and is not affiliated with or endorsed by VoidZero Inc. or the OXC
contributors.

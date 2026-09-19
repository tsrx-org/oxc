# Third-party notices

`oxc-tsrx` is the complete OXC-shaped TSRX parser, linter, formatter, and
language-server host. It uses canonical OXC Rust crates from commit
`5a6e37e5cf895143a5b34050c50109c46e2ae96a` of
<https://github.com/oxc-project/oxc>. OXC is licensed under the MIT License.

OXC is consumed as an exact-revision Cargo dependency. Its source is not
copied, vendored, patched, or forked by this project. Target-native packages
contain the complete generated Rust dependency inventory and byte-exact
upstream legal files, and each `@oxc-tsrx/native-*` package carries the notices
for the linked Rust/OXC binary distribution it ships.

This package's npm dependencies are:

- `@oxc-project/types` 0.140.0, MIT licensed and maintained by the OXC project,
  for the parser declaration surface.
- `oxlint` 1.74.0, which ordinary linting delegates to unchanged.
- `oxfmt` 0.59.0, which ordinary formatting delegates to unchanged.
- `oxlint-tsgolint` 0.24.0, for type-aware linting.
- `tinyglobby` 0.2.17, MIT licensed, for file discovery.

Those packages retain their own license and notice files when installed.

The `oxc-tsrx/tsrx-core-compat` export adapts the CSS parser from `@tsrx/core`
0.1.56, Copyright (c) 2025 Dominic Gannaway. The adapted source is licensed
under the MIT License:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

OXC for TSRX is an independent community integration. It is not an official
OXC project and is not affiliated with or endorsed by VoidZero Inc. or OXC's
contributors.

// Generates docs/terminal-transcripts.json: the named "See it run" terminal
// walkthroughs embedded on docs pages via <!-- terminal-demo:NAME -->.
// Every transcript is captured by really running the release binaries (and the
// npm wrappers) inside a throwaway sample project, so the output on the site
// is exactly what the tools printed.
// Prereqs:
//   cargo build --release --locked -p oxc_tsrx_cli --bins
//   node scripts/build-parser-native.ts (parser addon for the parsing demo)
//   pnpm install (for the npm wrappers and the pinned oxlint-tsgolint executable)
//   jq on PATH (the JSON walkthroughs pipe through it for readable output)
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTsgolintExecutable } from '../tests/helpers/tsgolint-path.mjs'

const docsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(docsDir, '..')
const lintBin = path.join(repoRoot, 'target', 'release', 'oxc-tsrx')
const formatBin = path.join(repoRoot, 'target', 'release', 'oxc-tsrx')
const npmLintBin = path.join(repoRoot, 'packages', 'toolchain', 'bin', 'oxlint')
const npmFormatBin = path.join(repoRoot, 'packages', 'toolchain', 'bin', 'oxfmt')
const npmCompatBin = path.join(repoRoot, 'packages', 'toolchain', 'bin', 'oxc-tsrx')
const tsgolintBin = resolveTsgolintExecutable(repoRoot)
const toolchainPackage = path.join(repoRoot, 'packages', 'toolchain')
// ESLint is already an exact-pinned fixture dependency of tests/package.json.
// The custom-plugin walkthrough drives that same CLI; nothing new is installed.
const eslintBin = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve('eslint/package.json', {
      paths: [path.join(repoRoot, 'tests')],
    }),
  ),
  'bin',
  'eslint.js',
)

const baseEnv = {
  ...process.env,
  OXC_TSRX_LINT_BIN: lintBin,
  OXC_TSRX_FORMAT_BIN: formatBin,
  ...(tsgolintBin ? { OXLINT_TSGOLINT_PATH: tsgolintBin } : {}),
}

// ---------- sample project files ----------

const cartTsrx = `export function Cart({ items }: Props) @{
  var total = 0;
  debugger;

  <section class="cart">
    @if (items.length > 0) {
      @for (const item of items; key item.id) {
        <Row item={item} />
      }
    } @else {
      <Empty />
    }
  </section>
}
`

// The Cart file from Getting Started with its two lint warnings fixed, but
// with the kind of messy spacing the formatter exists to clean up.
const messyCartTsrx = `export function Cart({items}:Props) @{
  <section   class="cart">
      @if (items.length>0) {
      @for (const item of items; key item.id) {
          <Row item={item}/>
      }
      } @else {
        <Empty/>
      }
  </section>
}
`

const simpleCounterTsrx = `export function Counter({ start }: { start: number }) @{
  var count = start;
  console.log("mounted");
  debugger;

  <div class="counter">
    <span>{count}</span>
  </div>
}
`

// The type-lane version: an unawaited promise for --type-aware and a wrong
// type annotation for --type-check. The triple-slash reference plus jsx.d.ts
// stand in for the framework types a real project already has installed.
const typedCounterTsrx = `/// <reference path="./jsx.d.ts" />
async function refresh(): Promise<void> {}

export function Counter({ start }: { start: number }) @{
  var count = start;
  const label: string = start;
  console.log("mounted");
  debugger;
  refresh();

  <div class="counter">
    <strong>{label}</strong>
    <span>{count}</span>
  </div>
}
`

const viewTsx = `export function View({ label }: { label: string }) {
  var seen = false
  const title = "section: " + label
  return <p title={title}>{label}</p>
}
`

const viewTsrx = `/// <reference path="./jsx.d.ts" />
import { loadItems } from "./service.tsrx";

export function View({ label }: { label: string }) @{
  const version: number = "0.1.0";
  console.log("render", label);
  debugger;
  loadItems();

  <section class="view">
    <h2>{label}</h2>
    <p>v{version}</p>
  </section>
}
`

const serviceTsrx = `export async function loadItems(): Promise<string[]> {
  return ["alpha", "beta"];
}
`

const jsxShim = `declare namespace JSX {
  interface IntrinsicElements {
    [name: string]: unknown;
  }
}

declare module "react/jsx-runtime" {
  export const Fragment: unknown;
  export function jsx(type: unknown, properties: unknown): unknown;
  export function jsxs(type: unknown, properties: unknown): unknown;
}
`

const tsconfigJson = `{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "strict": true,
    "target": "ESNext"
  },
  "include": ["**/*"]
}
`

// The first example on integrations/configuration.md, extended the way that
// page's type-aware section describes: the typescript plugin, an error-level
// no-floating-promises override for .tsrx files, and the triple-slash style
// rule turned off because the sample project pulls its JSX types through a
// jsx.d.ts reference instead of installed framework types.
const configurationLintConfig = `{
  "plugins": ["react", "typescript"],
  "env": { "browser": true },
  "globals": { "frameworkGlobal": "readonly" },
  "rules": {
    "no-debugger": "error",
    "eqeqeq": ["error", "always"],
    "react/jsx-no-undef": "error",
    "typescript/triple-slash-reference": "off"
  },
  "overrides": [
    {
      "files": ["**/*.tsrx"],
      "rules": {
        "no-console": "warn",
        "typescript/no-floating-promises": "error"
      }
    }
  ],
  "ignorePatterns": ["generated/**"]
}
`

// The triple-slash rule is off because the sample project pulls its JSX types
// through a reference to jsx.d.ts instead of installed framework types.
const lintingConfig = `{
  "rules": {
    "eqeqeq": ["error", "always"],
    "typescript/triple-slash-reference": "off"
  }
}
`

const tripleSlashOffConfig = `{
  "rules": {
    "typescript/triple-slash-reference": "off"
  }
}
`

// Mirrors the format example on integrations/configuration.md.
const formatConfig = `{
  "singleQuote": true,
  "semi": false,
  "printWidth": 100,
  "overrides": [
    {
      "files": ["**/*.tsrx"],
      "options": { "singleAttributePerLine": true }
    }
  ],
  "ignorePatterns": ["generated/**"]
}
`

const simpleFormatConfig = `{
  "singleQuote": true,
  "semi": false,
  "printWidth": 100
}
`

// The parsing guide's sample file. Must stay identical to the tsrx fence on
// docs/guide/parsing.md so the recorded output matches the code on the page.
const parseViewTsrx = `import { Row } from "./Row";

export function View({ items }: { items: Item[] }) @{
  <ul class="list">
    @for (const item of items; key item.id) {
      <Row item={item} />
    } @empty {
      <li>No items yet</li>
    }
  </ul>
}
`

const parseBrokenTsrx = `export function Broken() @{
  <p>hello</p
}
`

// Must stay identical to the js fence on docs/guide/parsing.md.
const parseBrokenScript = `import { readFileSync } from "node:fs";
import { parseSync } from "@tsrx/oxc/parser";

const source = readFileSync("src/Broken.tsrx", "utf8");
const result = parseSync("src/Broken.tsrx", source);

for (const error of result.errors) {
  console.log(\`\${error.severity}: \${error.message}\`);
  console.log(error.codeframe);
}
`

// ---------- custom JavaScript plugin sample project ----------
// integrations/custom-js-plugins.md is a tutorial, so its sample project is the
// real examples/custom-js-plugins/ directory rather than a retyped copy. The
// page prints these same files, and tests/plugins/custom-js-plugins-doc.test.mjs
// fails if a fence on the page and the file here ever disagree.

const pluginExamples = path.join(repoRoot, 'examples', 'custom-js-plugins')
const readPluginExample = (name) => readFileSync(path.join(pluginExamples, name), 'utf8')

const taskListTsrx = readPluginExample('src/TaskList.tsrx')
const taskRowTsx = readPluginExample('src/TaskRow.tsx')
const exploreTsrxAst = readPluginExample('explore-tsrx-ast.mjs')
const oxlintDemoPlugin = readPluginExample('oxlint-demo-plugin.mjs')
const oxlintDemoConfig = readPluginExample('.oxlintrc.json')
const eslintDemoConfig = readPluginExample('eslint.config.mjs')
const eslintDemoPlugin = readPluginExample('demo-lint-plugin.mjs')

// The in-repo adapter imports the parser by relative path so the plugin tests
// can load it straight from the source tree. A reader who ran
// `npm install @tsrx/oxc` uses the public subpath instead, which is what the page
// says, so swap exactly that one specifier and nothing else.
const relativeParserImport = '"../../packages/toolchain/dist/parser.js"'
const tsrxEslintParser = readPluginExample('tsrx-eslint-parser.mjs').replace(
  relativeParserImport,
  '"@tsrx/oxc/parser"',
)
if (tsrxEslintParser.includes(relativeParserImport)) {
  throw new Error(
    'examples/custom-js-plugins/tsrx-eslint-parser.mjs no longer imports the parser by the expected relative path',
  )
}

// Step "make it pass": the same fixture with the key the rule asked for.
const unkeyedForBlock = '@for (const task of tasks) {'
const keyedTaskListTsrx = taskListTsrx.replace(
  unkeyedForBlock,
  '@for (const task of tasks; key task.id) {',
)
if (keyedTaskListTsrx === taskListTsrx) {
  throw new Error(
    `examples/custom-js-plugins/src/TaskList.tsrx no longer contains "${unkeyedForBlock}"`,
  )
}

// src/TaskFeed.tsrx is the one file on the page that examples/custom-js-plugins
// does not carry: the page tells the reader to add it inline. So the page's own
// fence is the source of truth, and the transcript below is captured from
// exactly those bytes rather than from a retyped copy that could drift.
const customPluginsPage = readFileSync(
  path.join(docsDir, 'integrations', 'custom-js-plugins.md'),
  'utf8',
)
const taskFeedFence = customPluginsPage.match(
  /`src\/TaskFeed\.tsrx`:\r?\n\r?\n```tsrx\r?\n([\s\S]*?)^```/mu,
)
if (!taskFeedFence) {
  throw new Error(
    'docs/integrations/custom-js-plugins.md no longer tells the reader to add src/TaskFeed.tsrx',
  )
}
const taskFeedTsrx = taskFeedFence[1]

// The same config with the extra-parse opt-out the page documents. Built from
// the example config rather than retyped, so it cannot drift from it.
const optedOutDemoConfig = `${JSON.stringify(
  { ...JSON.parse(oxlintDemoConfig), settings: { oxcTsrx: { jsPluginsOnTsrx: false } } },
  null,
  2,
)}\n`

const installedToolchain = { 'node_modules/@tsrx/oxc': toolchainPackage }

// ---------- the Vite+ walkthrough sample project ----------
// The page's step-by-step route from a `vp create` scaffold. Its four files live
// in examples/custom-js-plugins/vite-plus/ for the same reason the files above
// live in examples/custom-js-plugins/: the page prints them, and the docs test
// compares each fence to the file byte for byte.

const vitePlusExamples = path.join(pluginExamples, 'vite-plus')
const readVitePlusExample = (name) => readFileSync(path.join(vitePlusExamples, name), 'utf8')

const houseRulesPlugin = readVitePlusExample('house-rules.mjs')
const houseRulesConfig = readVitePlusExample('.oxlintrc.json')
const greetingTsrx = readVitePlusExample('src/Greeting.tsrx')
const panelTsx = readVitePlusExample('src/Panel.tsx')

// The same config carrying the one `vp create` template default the page tells
// you to delete, so the refusal is captured from the example rather than typed.
const typeAwareConfig = `${JSON.stringify(
  { ...JSON.parse(houseRulesConfig), options: { typeAware: true } },
  null,
  2,
)}\n`

// `oxc-tsrx setup` and `status` report on the project around them, so the
// fixture below reproduces the shape a `vp create` React scaffold has: a
// solution-style root tsconfig that owns no files, a referenced tsconfig.app.json
// that owns `src`, a `node_modules/.bin/oxlint` belonging to Vite+, a pnpm
// lockfile, and TypeScript 6. These two demos were checked line for line against
// a real `vp create` scaffold running published oxc-tsrx 0.1.4. They match it
// except for one thing the capture itself causes: `sanitize` strips the
// throwaway project directory, so the two tsconfig paths `setup` prints in full
// arrive here as bare filenames. The captions say so.
const scaffoldPackageJson = `${JSON.stringify(
  {
    name: 'my-app',
    version: '0.0.0',
    private: true,
    type: 'module',
    devDependencies: {
      '@tsrx/oxc': '0.9.0',
      '@types/react': '^19.2.17',
      typescript: '~6.0.2',
      'vite-plus': '^0.2.6',
    },
  },
  null,
  2,
)}\n`

const scaffoldRootTsconfig = `${JSON.stringify(
  { files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] },
  null,
  2,
)}\n`

const scaffoldAppTsconfig = (withPlugin) =>
  `${JSON.stringify(
    {
      compilerOptions: {
        ...(withPlugin ? { plugins: [{ name: '@tsrx/typescript-plugin' }] } : {}),
        jsx: 'react-jsx',
        moduleResolution: 'bundler',
        noEmit: true,
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`

const stubPackage = (name, version) => `${JSON.stringify({ name, version }, null, 2)}\n`

// Vite+'s own `node_modules/.bin/oxlint`. `setup` only asks where that shim
// resolves to, so a stand-in that resolves nowhere near this package is enough
// to reproduce what a Vite+ project does to the editor's lookup.
const vitePlusOxlintShim = `#!/bin/sh
echo "This oxlint wrapper is for IDE extension use only (--lsp mode)."
echo "To lint your code, run: vp lint"
exit 1
`

const scaffoldBaseFiles = {
  'package.json': scaffoldPackageJson,
  'pnpm-lock.yaml': '',
  'tsconfig.json': scaffoldRootTsconfig,
  'node_modules/.bin/oxlint': vitePlusOxlintShim,
  'node_modules/typescript/package.json': stubPackage('typescript', '6.0.3'),
}

// ---------- runners ----------

const runners = {
  // One multi-call native binary: no subcommand lints, `fmt` formats.
  lint: { bin: lintBin },
  fmt: { bin: formatBin, prefix: ['fmt'] },
  npxLint: { bin: process.execPath, prefix: [npmLintBin] },
  npxFmt: { bin: process.execPath, prefix: [npmFormatBin] },
  npxCompat: { bin: process.execPath, prefix: [npmCompatBin] },
  eslint: { bin: process.execPath, prefix: [eslintBin] },
  cat: { bin: '/bin/cat' },
  // Plain Node scripts (used by the parser API demo).
  node: { bin: process.execPath },
  // Real shell pipelines (used to pipe JSON reports through jq).
  sh: { bin: '/bin/sh', prefix: ['-c'] },
}

function runEntry(workspace, entry) {
  const runner = runners[entry.runner]
  const result = spawnSync(runner.bin, [...(runner.prefix ?? []), ...entry.args], {
    cwd: workspace,
    encoding: 'utf8',
    env: baseEnv,
    ...(entry.stdinFile
      ? { input: readFileSync(path.join(workspace, entry.stdinFile), 'utf8') }
      : {}),
  })
  if (result.error) throw result.error
  if (result.signal) {
    throw new Error(`${entry.command} exited on signal ${result.signal}`)
  }
  if (result.status !== entry.expectExit) {
    throw new Error(
      `${entry.command} exited ${result.status}, expected ${entry.expectExit}\n${result.stdout}${result.stderr}`,
    )
  }
  return `${result.stdout}${result.stderr}`
}

function sanitize(output, workspace) {
  const real = realpathSync(workspace)
  return output
    .replaceAll(`${real}${path.sep}`, '')
    .replaceAll(`${workspace}${path.sep}`, '')
    .replaceAll(real, '.')
    .replaceAll(workspace, '.')
}

// `oxc-tsrx setup|status|remove` wrap their own report to 80 columns, and they
// do it while the absolute path of this throwaway workspace is still in the
// text. `sanitize` then deletes that path, which leaves the tail of a wrapped
// note stranded on a line of its own. Re-flowing the two block shapes that
// report indents gives the page the wrapping a reader with short paths sees.
// Scoped to those commands so no other demo's indented output is touched.
const REPORT_COMMAND = /oxc-tsrx (?:setup|status|remove)\b/

function wrapCaptured(text, firstPrefix, restPrefix, width) {
  const limit = Math.max(width - restPrefix.length, 24)
  const lines = []
  let current = ''
  for (const word of text.split(' ')) {
    if (current === '') current = word
    else if (`${current} ${word}`.length <= limit) current = `${current} ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines.map((line, index) => `${index === 0 ? firstPrefix : restPrefix}${line}`)
}

function reflowReport(output) {
  const lines = output.split('\n')
  const reflowed = []
  let index = 0
  const take = (matches) => {
    const parts = [lines[index].trim()]
    index += 1
    while (index < lines.length && matches.test(lines[index])) {
      parts.push(lines[index].trim())
      index += 1
    }
    return parts.join(' ')
  }
  while (index < lines.length) {
    if (/^ {2}! \S/.test(lines[index])) {
      const text = take(/^ {4}\S/).replace(/^! /, '')
      reflowed.push(...wrapCaptured(text, '  ! ', '    ', 80))
      continue
    }
    if (/^ {6}\S/.test(lines[index])) {
      reflowed.push(...wrapCaptured(take(/^ {6}\S/), '      ', '      ', 80))
      continue
    }
    reflowed.push(lines[index])
    index += 1
  }
  return reflowed.join('\n')
}

function captureDemo(demo) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'oxc-tsrx-docs-demo-'))
  try {
    for (const [relative, contents] of Object.entries(demo.files)) {
      const absolute = path.join(workspace, relative)
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, contents)
    }
    // Symlinks let a demo resolve real workspace packages (for example
    // node_modules/@tsrx/oxc) without copying them into the sample.
    for (const [relative, target] of Object.entries(demo.links ?? {})) {
      const absolute = path.join(workspace, relative)
      mkdirSync(path.dirname(absolute), { recursive: true })
      symlinkSync(target, absolute)
    }
    // A demo whose starting state is what an earlier command produced runs that
    // command here rather than hand-writing its effects into `files`. The output
    // is discarded: only the entries below are printed on the page.
    for (const entry of demo.prelude ?? []) runEntry(workspace, entry)
    return {
      caption: demo.caption,
      transcript: demo.entries.map((entry) => ({
        ...(entry.comment ? { comment: entry.comment } : {}),
        command: entry.command,
        output: REPORT_COMMAND.test(entry.command)
          ? reflowReport(sanitize(runEntry(workspace, entry), workspace))
          : sanitize(runEntry(workspace, entry), workspace),
      })),
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

// ---------- demo definitions ----------

const demos = {
  'introduction-commands': {
    caption:
      'Real output, captured at build time. The sample project has a src/Counter.tsrx with a debugger statement and an unformatted src/View.tsx with an unused variable.',
    files: {
      'src/Counter.tsrx': simpleCounterTsrx,
      'src/View.tsx': viewTsx,
    },
    entries: [
      {
        comment: 'Lint .tsrx and ordinary JS/TS with real OXC rules',
        command: 'npx oxlint src/Counter.tsrx src/View.tsx',
        runner: 'npxLint',
        args: ['src/Counter.tsrx', 'src/View.tsx'],
        expectExit: 0,
      },
      {
        comment: 'Format .tsrx and ordinary JS/TS with real Oxfmt layout',
        command: 'npx oxfmt --check src/Counter.tsrx src/View.tsx',
        runner: 'npxFmt',
        args: ['--check', 'src/Counter.tsrx', 'src/View.tsx'],
        expectExit: 1,
      },
    ],
  },

  'getting-started-format-write': {
    caption:
      'Real output, captured at build time. The sample is the src/Cart.tsrx from above with its two warnings fixed but sloppy spacing left behind.',
    files: { 'src/Cart.tsrx': messyCartTsrx },
    entries: [
      {
        comment: 'The warnings are fixed, but look at the spacing',
        command: 'cat src/Cart.tsrx',
        runner: 'cat',
        args: ['src/Cart.tsrx'],
        expectExit: 0,
      },
      {
        comment: 'Rewrite the file in place; a summary line and no file list means it worked',
        command: 'npx oxfmt --write src/Cart.tsrx',
        runner: 'npxFmt',
        args: ['--write', 'src/Cart.tsrx'],
        expectExit: 0,
      },
      {
        comment: 'Same file, now in canonical Oxfmt layout',
        command: 'cat src/Cart.tsrx',
        runner: 'cat',
        args: ['src/Cart.tsrx'],
        expectExit: 0,
      },
    ],
  },

  'getting-started-native': {
    caption:
      'Real output, captured at build time, for the src/Cart.tsrx file above. The native binary prints the whole report as one line of JSON; jq makes it readable here.',
    files: { 'src/Cart.tsrx': cartTsrx },
    entries: [
      {
        comment: 'The report is one line of JSON; jq picks out the diagnostics',
        command: "target/release/oxc-tsrx --format=json src/Cart.tsrx | jq '.diagnostics'",
        runner: 'sh',
        args: [`"${lintBin}" --format=json src/Cart.tsrx | jq '.diagnostics'`],
        expectExit: 0,
      },
      {
        comment: 'And the metadata proves it parsed your file exactly once',
        command:
          "target/release/oxc-tsrx --format=json src/Cart.tsrx | jq '.oxcTsrx.parseCount'",
        runner: 'sh',
        args: [`"${lintBin}" --format=json src/Cart.tsrx | jq '.oxcTsrx.parseCount'`],
        expectExit: 0,
      },
    ],
  },

  'linting-usage': {
    caption:
      'Real output, captured at build time. The sample src/Counter.tsrx has a debugger statement, a var declaration, an unawaited promise, and a wrong type annotation; src/View.tsx has an unused variable.',
    files: {
      'src/Counter.tsrx': typedCounterTsrx,
      'src/View.tsx': viewTsx,
      'src/jsx.d.ts': jsxShim,
      'tsconfig.json': tsconfigJson,
      'config/lint.json': lintingConfig,
      '.oxlintrc.json': tripleSlashOffConfig,
    },
    entries: [
      {
        comment: 'The report is one line of JSON; jq shows the diagnostics readably',
        command:
          "oxc-tsrx --format=json src/Counter.tsrx src/View.tsx \\\n  | jq '.diagnostics'",
        runner: 'sh',
        args: [
          `"${lintBin}" --format=json src/Counter.tsrx src/View.tsx | jq '.diagnostics'`,
        ],
        expectExit: 0,
      },
      {
        comment: 'Explicit configuration plus per-rule severity from the CLI',
        command:
          "oxc-tsrx --format=json --config config/lint.json \\\n  --warn no-console --deny no-debugger src/Counter.tsrx | jq '.diagnostics'",
        runner: 'sh',
        args: [
          `"${lintBin}" --format=json --config config/lint.json --warn no-console --deny no-debugger src/Counter.tsrx | jq '.diagnostics'`,
        ],
        expectExit: 0,
      },
      {
        comment: 'Apply safe fixes; here no-var rewrites var to const',
        command:
          "oxc-tsrx --format=json --deny no-var --fix src/Counter.tsrx | jq '.oxcTsrx.fixes'",
        runner: 'sh',
        args: [
          `"${lintBin}" --format=json --deny no-var --fix src/Counter.tsrx | jq '.oxcTsrx.fixes'`,
        ],
        expectExit: 0,
      },
      {
        comment: 'Opt into the official TypeScript-Go rules',
        command: "oxc-tsrx --format=json --type-aware src/Counter.tsrx | jq '.diagnostics'",
        runner: 'sh',
        args: [`"${lintBin}" --format=json --type-aware src/Counter.tsrx | jq '.diagnostics'`],
        expectExit: 0,
      },
      {
        comment: 'Or add full TypeScript compiler diagnostics on top',
        command: "oxc-tsrx --format=json --type-check src/Counter.tsrx | jq '.diagnostics'",
        runner: 'sh',
        args: [`"${lintBin}" --format=json --type-check src/Counter.tsrx | jq '.diagnostics'`],
        expectExit: 0,
      },
    ],
  },

  'formatting-usage': {
    caption:
      'Real output, captured at build time. The sample src/Counter.tsrx starts with double quotes and no statement semicolons after JSX, so the formatter has work to do.',
    files: {
      'src/Counter.tsrx': simpleCounterTsrx,
      'src/View.tsx': viewTsx,
      'config/format.json': simpleFormatConfig,
    },
    entries: [
      {
        comment: 'Check without modifying files; exits 1 and lists files that differ',
        command: 'oxc-tsrx-fmt --check src/Counter.tsrx',
        runner: 'fmt',
        args: ['--check', 'src/Counter.tsrx'],
        expectExit: 1,
      },
      {
        comment: 'Format and write files; success prints only the summary line',
        command: 'oxc-tsrx-fmt --write src/Counter.tsrx src/View.tsx',
        runner: 'fmt',
        args: ['--write', 'src/Counter.tsrx', 'src/View.tsx'],
        expectExit: 0,
      },
      {
        comment: 'Editor/stdin mode: formatted source goes to stdout',
        command: 'oxc-tsrx-fmt --stdin-filepath=src/Counter.tsrx < src/Counter.tsrx',
        runner: 'fmt',
        args: ['--stdin-filepath=src/Counter.tsrx'],
        stdinFile: 'src/Counter.tsrx',
        expectExit: 0,
      },
      {
        comment: 'Explicit config and worker count',
        command:
          'oxc-tsrx-fmt --write --config config/format.json --threads=4 src/Counter.tsrx',
        runner: 'fmt',
        args: [
          '--write',
          '--config',
          'config/format.json',
          '--threads=4',
          'src/Counter.tsrx',
        ],
        expectExit: 0,
      },
      {
        comment: 'The explicit config switched the file to single quotes, no semicolons',
        command: 'cat src/Counter.tsrx',
        runner: 'cat',
        args: ['src/Counter.tsrx'],
        expectExit: 0,
      },
    ],
  },

  'configuration-lint': {
    caption:
      'Real output, captured at build time by running the release binaries against the sample project described above. The type-aware and type-check runs are filtered to the diagnostics each flag adds.',
    files: {
      'src/View.tsrx': viewTsrx,
      'src/View.tsx': viewTsx,
      'src/service.tsrx': serviceTsrx,
      'src/jsx.d.ts': jsxShim,
      'tsconfig.json': tsconfigJson,
      '.oxlintrc.json': configurationLintConfig,
      'config/lint.json': configurationLintConfig,
    },
    entries: [
      {
        comment: 'Discovered .oxlintrc.json: console is a warning, debugger an error',
        command:
          "oxc-tsrx --format=json src/View.tsrx src/View.tsx \\\n  | jq '.diagnostics'",
        runner: 'sh',
        args: [`"${lintBin}" --format=json src/View.tsrx src/View.tsx | jq '.diagnostics'`],
        expectExit: 0,
      },
      {
        comment: 'Explicit config path plus CLI severity overrides',
        command:
          "oxc-tsrx --format=json --config config/lint.json \\\n  --warn no-console --deny no-debugger src/View.tsrx | jq '.diagnostics'",
        runner: 'sh',
        args: [
          `"${lintBin}" --format=json --config config/lint.json --warn no-console --deny no-debugger src/View.tsrx | jq '.diagnostics'`,
        ],
        expectExit: 0,
      },
      {
        comment:
          'One TypeScript-Go process covers the whole explicit batch; showing only what --type-aware adds',
        command:
          'oxc-tsrx --format=json --type-aware src/View.tsrx src/service.tsrx \\\n  | jq \'[.diagnostics[] | select(.code | startswith("typescript"))]\'',
        runner: 'sh',
        args: [
          `"${lintBin}" --format=json --type-aware src/View.tsrx src/service.tsrx | jq '[.diagnostics[] | select(.code | startswith("typescript"))]'`,
        ],
        expectExit: 0,
      },
      {
        comment:
          '--type-check additionally lands compiler diagnostics on your authored bytes; showing only those',
        command:
          'oxc-tsrx --format=json --type-check src/View.tsrx src/service.tsrx \\\n  | jq \'[.diagnostics[] | select(.code | startswith("typescript(TS"))]\'',
        runner: 'sh',
        args: [
          `"${lintBin}" --format=json --type-check src/View.tsrx src/service.tsrx | jq '[.diagnostics[] | select(.code | startswith("typescript(TS"))]'`,
        ],
        expectExit: 0,
      },
    ],
  },

  'configuration-format': {
    caption:
      'Real output, captured at build time by running the release binaries against the sample project described above.',
    files: {
      'src/View.tsrx': viewTsrx,
      'src/View.tsx': viewTsx,
      'src/service.tsrx': serviceTsrx,
      'src/jsx.d.ts': jsxShim,
      '.oxfmtrc.json': formatConfig,
      'config/format.json': formatConfig,
    },
    entries: [
      {
        comment: 'Both sample files differ from the configured single-quote layout',
        command: 'oxc-tsrx-fmt --check src/View.tsrx src/View.tsx',
        runner: 'fmt',
        args: ['--check', 'src/View.tsrx', 'src/View.tsx'],
        expectExit: 1,
      },
      {
        comment: 'Rewrite one file with the explicit config; no file list means success',
        command: 'oxc-tsrx-fmt --write --config config/format.json src/View.tsrx',
        runner: 'fmt',
        args: ['--write', '--config', 'config/format.json', 'src/View.tsrx'],
        expectExit: 0,
      },
      {
        comment: 'Stdin mode prints the formatted source, single quotes and all',
        command: 'oxc-tsrx-fmt --stdin-filepath=src/View.tsrx < src/View.tsrx',
        runner: 'fmt',
        args: ['--stdin-filepath=src/View.tsrx'],
        stdinFile: 'src/View.tsrx',
        expectExit: 0,
      },
    ],
  },

  'custom-plugins-first-run': {
    caption:
      'Real output, captured at build time. The whole sample project is one src/TaskList.tsrx and an install of @tsrx/oxc. There is no configuration file yet.',
    files: { 'src/TaskList.tsrx': taskListTsrx },
    entries: [
      {
        comment: 'The oxlint that @tsrx/oxc installs already reads .tsrx',
        command: 'npx oxlint src/TaskList.tsrx',
        runner: 'npxLint',
        args: ['src/TaskList.tsrx'],
        expectExit: 0,
      },
    ],
  },

  'custom-plugins-explore': {
    caption:
      'Real output, captured at build time, from the explore-tsrx-ast.mjs script above run against src/TaskList.tsrx.',
    files: {
      'src/TaskList.tsrx': taskListTsrx,
      'explore-tsrx-ast.mjs': exploreTsrxAst,
    },
    links: installedToolchain,
    entries: [
      {
        comment: 'Print the node type of every TSRX control block in the file',
        command: 'node explore-tsrx-ast.mjs',
        runner: 'node',
        args: ['explore-tsrx-ast.mjs'],
        expectExit: 0,
      },
    ],
  },

  'custom-plugins-oxlint-plugin': {
    caption:
      'Real output, captured at build time. The sample project now has the .oxlintrc.json and oxlint-demo-plugin.mjs from above, plus the ordinary src/TaskRow.tsx.',
    files: {
      'src/TaskRow.tsx': taskRowTsx,
      'oxlint-demo-plugin.mjs': oxlintDemoPlugin,
      '.oxlintrc.json': oxlintDemoConfig,
    },
    entries: [
      {
        comment: 'Your own JavaScript rule, running inside the oxlint you installed',
        command: 'npx oxlint src/TaskRow.tsx',
        runner: 'npxLint',
        args: ['src/TaskRow.tsx'],
        expectExit: 1,
      },
    ],
  },

  'custom-plugins-tsrx-plugin': {
    caption:
      'Real output, captured at build time, from the same project and the same .oxlintrc.json, pointed at the .tsrx file instead.',
    files: {
      'src/TaskList.tsrx': taskListTsrx,
      'src/TaskRow.tsx': taskRowTsx,
      'oxlint-demo-plugin.mjs': oxlintDemoPlugin,
      '.oxlintrc.json': oxlintDemoConfig,
    },
    entries: [
      {
        comment: 'Same plugin, same config, one .tsrx file',
        command: 'npx oxlint src/TaskList.tsrx',
        runner: 'npxLint',
        args: ['src/TaskList.tsrx'],
        // The rule looks for a `.map()` call and this file has an `@for` block,
        // so it runs and finds nothing. Only the built-in warning reports.
        expectExit: 0,
      },
    ],
  },

  'custom-plugins-tsrx-map': {
    caption:
      'Real output, captured at build time, after src/TaskFeed.tsrx was added to the same project.',
    files: {
      'src/TaskFeed.tsrx': taskFeedTsrx,
      'oxlint-demo-plugin.mjs': oxlintDemoPlugin,
      '.oxlintrc.json': oxlintDemoConfig,
    },
    entries: [
      {
        comment: 'Your own rule, reporting on the .tsrx file you wrote',
        command: 'npx oxlint src/TaskFeed.tsrx',
        runner: 'npxLint',
        args: ['src/TaskFeed.tsrx'],
        expectExit: 1,
      },
    ],
  },

  'custom-plugins-mixed-directory': {
    caption:
      'Real output, captured at build time, from the same project with one command run over the whole src directory.',
    files: {
      'src/TaskList.tsrx': taskListTsrx,
      'src/TaskFeed.tsrx': taskFeedTsrx,
      'src/TaskRow.tsx': taskRowTsx,
      'oxlint-demo-plugin.mjs': oxlintDemoPlugin,
      '.oxlintrc.json': oxlintDemoConfig,
    },
    entries: [
      {
        comment: 'Both file types at once, one plugin, one command',
        command: 'npx oxlint src',
        runner: 'npxLint',
        args: ['src'],
        expectExit: 1,
      },
    ],
  },

  'custom-plugins-vp-setup': {
    caption:
      'Real output, captured at build time, from a project shaped like a fresh vp create React scaffold with @tsrx/oxc installed and none of the TSRX toolchain packages yet. One difference from a real scaffold: setup names the two tsconfig files by absolute path, and the capture rewrites the throwaway project directory away, so they read as bare filenames here.',
    files: {
      ...scaffoldBaseFiles,
      'tsconfig.app.json': scaffoldAppTsconfig(false),
      'src/Greeting.tsrx': greetingTsrx,
    },
    links: installedToolchain,
    entries: [
      {
        comment: 'Four slots this package owns, then four things it will not touch',
        command: 'npx oxc-tsrx setup',
        runner: 'npxCompat',
        args: ['setup'],
        expectExit: 0,
      },
    ],
  },

  'custom-plugins-vp-status': {
    caption:
      'Real output, captured at build time, from the same project after the TSRX toolchain packages were installed and tsconfig.app.json declared the plugin. On a real scaffold this prints identically.',
    files: {
      ...scaffoldBaseFiles,
      'tsconfig.app.json': scaffoldAppTsconfig(true),
      'src/Greeting.tsrx': greetingTsrx,
      'node_modules/@tsrx/typescript-plugin/package.json': stubPackage(
        '@tsrx/typescript-plugin',
        '0.3.112',
      ),
      'node_modules/@tsrx/react/package.json': stubPackage('@tsrx/react', '0.2.50'),
    },
    links: installedToolchain,
    // The three package slots and the editor key are `setup`'s own work, so the
    // demo runs it rather than faking the state it leaves behind.
    prelude: [{ command: 'npx oxc-tsrx setup', runner: 'npxCompat', args: ['setup'], expectExit: 0 }],
    entries: [
      {
        comment: 'Three of the four unowned prerequisites are done; one is left',
        command: 'npx oxc-tsrx status',
        runner: 'npxCompat',
        args: ['status'],
        expectExit: 0,
      },
    ],
  },

  'custom-plugins-vp-cli': {
    caption:
      'Real output, captured at build time, from the walkthrough project with house-rules.mjs, .oxlintrc.json, src/Greeting.tsrx, and src/Panel.tsx in place.',
    files: {
      'house-rules.mjs': houseRulesPlugin,
      '.oxlintrc.json': houseRulesConfig,
      'src/Greeting.tsrx': greetingTsrx,
      'src/Panel.tsx': panelTsx,
    },
    entries: [
      {
        comment: 'One command, one top-level jsPlugins, both file types',
        command: 'node_modules/@tsrx/oxc/bin/oxlint src',
        runner: 'npxLint',
        args: ['src'],
        expectExit: 0,
      },
    ],
  },

  'custom-plugins-typeaware': {
    caption:
      'Real output, captured at build time, from the same project after options.typeAware was added to .oxlintrc.json. That is the option a vp create scaffold sets in vite.config.ts.',
    files: {
      'house-rules.mjs': houseRulesPlugin,
      '.oxlintrc.json': typeAwareConfig,
      'src/Greeting.tsrx': greetingTsrx,
      'src/Panel.tsx': panelTsx,
    },
    entries: [
      {
        comment: 'The .tsrx half refuses; exit 2 is the configuration refusal',
        command: 'node_modules/@tsrx/oxc/bin/oxlint src',
        runner: 'npxLint',
        args: ['src'],
        expectExit: 2,
      },
    ],
  },

  'custom-plugins-tsrx-opt-out': {
    caption:
      'Real output, captured at build time, from the same project after settings.oxcTsrx.jsPluginsOnTsrx was set to false.',
    files: {
      'src/TaskFeed.tsrx': taskFeedTsrx,
      'oxlint-demo-plugin.mjs': oxlintDemoPlugin,
      '.oxlintrc.json': optedOutDemoConfig,
    },
    entries: [
      {
        comment: 'With the lane switched off, the .tsrx half refuses out loud',
        command: 'npx oxlint src/TaskFeed.tsrx',
        runner: 'npxLint',
        args: ['src/TaskFeed.tsrx'],
        // Exit 2 is the configuration refusal, not a lint failure.
        expectExit: 2,
      },
    ],
  },

  'custom-plugins-eslint': {
    caption:
      'Real output, captured at build time by running ESLint 10.7.0 against src/TaskList.tsrx with the adapter, plugin, and config above.',
    files: {
      'src/TaskList.tsrx': taskListTsrx,
      'eslint.config.mjs': eslintDemoConfig,
      'demo-lint-plugin.mjs': eslintDemoPlugin,
      'tsrx-eslint-parser.mjs': tsrxEslintParser,
    },
    links: installedToolchain,
    entries: [
      {
        comment: 'Both rules fire, on the @if and the @for you authored',
        command: 'npx eslint src/TaskList.tsrx',
        runner: 'eslint',
        args: ['src/TaskList.tsrx'],
        expectExit: 1,
      },
    ],
  },

  'custom-plugins-eslint-fixed': {
    caption:
      'Real output, captured at build time from the same project after the @for block was given its key expression.',
    files: {
      'src/TaskList.tsrx': keyedTaskListTsrx,
      'eslint.config.mjs': eslintDemoConfig,
      'demo-lint-plugin.mjs': eslintDemoPlugin,
      'tsrx-eslint-parser.mjs': tsrxEslintParser,
    },
    links: installedToolchain,
    entries: [
      {
        comment: 'The error is gone; the warning you asked for stays',
        command: 'npx eslint src/TaskList.tsrx',
        runner: 'eslint',
        args: ['src/TaskList.tsrx'],
        expectExit: 0,
      },
    ],
  },

  'parsing-quickstart': {
    caption:
      'Real output, captured at build time, from a Broken.tsrx whose closing tag is unterminated.',
    files: {
      'src/Broken.tsrx': parseBrokenTsrx,
      'errors.mjs': parseBrokenScript,
    },
    links: {
      'node_modules/@tsrx/oxc': path.join(repoRoot, 'packages', 'toolchain'),
    },
    entries: [
      {
        comment: 'Parse errors land in result.errors and point at your file',
        command: 'node errors.mjs',
        runner: 'node',
        args: ['errors.mjs'],
        expectExit: 0,
      },
    ],
  },
}

const captured = {}
for (const [name, demo] of Object.entries(demos)) {
  captured[name] = captureDemo(demo)
  console.log(`captured ${name} (${captured[name].transcript.length} commands)`)
}

writeFileSync(
  path.join(docsDir, 'terminal-transcripts.json'),
  `${JSON.stringify(
    {
      note: 'Generated by docs/generate-transcripts.mjs by running the real release binaries. Do not edit by hand.',
      demos: captured,
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote docs/terminal-transcripts.json (${Object.keys(captured).length} demos)`)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const binary = process.env.OXLINT_BIN ?? join(root, 'target/release/oxc-tsrx');
// `oxlint-current` is declared by tests/package.json, so it is resolved from
// this file rather than from a hoisted repository-root `node_modules`. pnpm
// installs it under tests/node_modules and nowhere else.
const stockBinary = join(
  dirname(createRequire(import.meta.url).resolve('oxlint-current/package.json')),
  'bin/oxlint',
);
const tsrxFixture = join(root, 'tests/fixtures/lint/native-lint.tsrx');
const tsxFixture = join(root, 'tests/fixtures/lint/ordinary.tsx');

function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function parseJsonOutput(result) {
  const start = result.stdout.indexOf('{');
  assert.notEqual(start, -1, result.stderr || result.stdout);
  return JSON.parse(result.stdout.slice(start));
}

function byteOffset(source, needle) {
  const characterOffset = source.indexOf(needle);
  assert.notEqual(characterOffset, -1, `Missing ${needle}`);
  return Buffer.byteLength(source.slice(0, characterOffset));
}

function diagnosticFor(output, rule) {
  return output.diagnostics.find((diagnostic) =>
    diagnostic.rule === rule || diagnostic.code?.includes(`(${rule})`));
}

function comparableDiagnostics(output) {
  return output.diagnostics.map(({ code, message, severity, labels }) => ({
    code,
    message,
    severity,
    labels: labels.map(({ span }) => ({
      span: { offset: span.offset, length: span.length },
    })),
  }));
}

test('runs real OXC rules once and reports original TSRX byte spans', async () => {
  const source = await readFile(tsrxFixture, 'utf8');
  const result = await run([
    '--format=json',
    '--deny',
    'no-debugger',
    '--deny',
    'no-unused-vars',
    tsrxFixture,
  ]);

  assert.equal(result.signal, null);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJsonOutput(result);

  const debuggerDiagnostic = diagnosticFor(output, 'no-debugger');
  assert.ok(debuggerDiagnostic, result.stdout);
  assert.equal(debuggerDiagnostic.filename, tsrxFixture);
  assert.equal(debuggerDiagnostic.severity, 'error');
  assert.deepEqual(debuggerDiagnostic.labels[0].span, {
    offset: byteOffset(source, 'debugger;\n    <main'),
    length: Buffer.byteLength('debugger;'),
  });

  const unusedDiagnostic = diagnosticFor(output, 'no-unused-vars');
  assert.ok(unusedDiagnostic, result.stdout);
  assert.equal(unusedDiagnostic.filename, tsrxFixture);
  assert.equal(
    unusedDiagnostic.labels.some((label) =>
      label.span.offset === byteOffset(source, 'unused = 1')),
    true,
    result.stdout,
  );

  assert.equal(output.oxcTsrx.native, true);
  assert.equal(output.oxcTsrx.engine, 'oxc_linter');
  assert.equal(output.oxcTsrx.oxcRevision, '8e0ed2ebb96137fb1611cdbd5742d5cb46037d40');
  assert.equal(output.oxcTsrx.parseCount, 1);
  assert.equal(output.oxcTsrx.files.tsrx, 1);
  for (const field of ['scanNs', 'projectionNs', 'parseNs', 'semanticNs', 'lintNs']) {
    assert.equal(typeof output.oxcTsrx.timings[field], 'number');
  }
});

test('applies only an identity-mapped no-var fix and reparses TSRX', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-t011-'));
  const file = join(directory, 'native-lint.tsrx');
  await copyFile(tsrxFixture, file);
  const before = await readFile(file, 'utf8');

  const result = await run(['--format=json', '--fix', '--deny', 'no-var', file]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = parseJsonOutput(result);
  const after = await readFile(file, 'utf8');

  assert.match(after, /\b(?:let|const) legacy = 2;/);
  assert.doesNotMatch(after, /\bvar legacy = 2;/);
  assert.equal(after.replace(/(?:let|const) legacy/, 'var legacy'), before);
  assert.match(after, /export function View\(\{ ready \}: Props\) @\{/);
  assert.match(after, /const contact = "@if@example\.com";/);
  assert.match(after, /\/\/ @if \(false\) \{ debugger; \}/);
  assert.equal(output.oxcTsrx.fixes.applied, 1);
  assert.equal(output.oxcTsrx.fixes.rejected, 0);
  assert.equal(output.oxcTsrx.reparseCount, 1);
});

test('an unprojectable .tsrx becomes its own diagnostic and the rest of the batch still reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-batch-continues-'));
  const goodSource = 'export function Good() @{\n  var legacy = 1;\n  <div>hi</div>\n}\n';
  const brokenSource = 'export function Broken() @{\n  let x = 1;\n  <main>\n    <h1>hi</h1>\n}\n';
  const good = join(directory, 'Good.tsrx');
  const broken = join(directory, 'Broken.tsrx');
  await writeFile(good, goodSource);
  await writeFile(broken, brokenSource);

  // The control: the good file on its own. Only warnings, so it exits 0.
  const alone = await run(['--format=json', good]);
  assert.equal(alone.code, 0, alone.stderr || alone.stdout);
  const aloneDiagnostics = parseJsonOutput(alone).diagnostics;
  assert.ok(aloneDiagnostics.length > 0, alone.stdout);

  const batch = await run(['--format=json', good, broken]);
  // Before this, `lint_files` collected into a Result and short-circuited: one
  // unparseable file exited 2 with empty stdout and discarded every other file's
  // diagnostics. A syntax error is a diagnostic, so exit 1 now falls out of the
  // error count with no special case, and stderr stays clean.
  assert.equal(batch.code, 1, batch.stderr || batch.stdout);
  assert.equal(batch.stderr, '', batch.stderr);
  const output = parseJsonOutput(batch);
  assert.equal(output.number_of_files, 2);

  const survived = output.diagnostics.filter((diagnostic) => diagnostic.filename === good);
  assert.deepEqual(
    survived,
    aloneDiagnostics,
    `a broken sibling changed the good file's report:\n${batch.stdout}`,
  );

  const failures = output.diagnostics.filter((diagnostic) => diagnostic.filename === broken);
  assert.equal(failures.length, 1, batch.stdout);
  assert.equal(failures[0].severity, 'error');
  assert.match(failures[0].message, /unterminated/u);
  // No rule and no code: there is no rule to disable, and the wrapper's default
  // renderer omits the code slot for a diagnostic that carries none, which is
  // how canonical Oxlint prints a `.ts` parse error.
  assert.equal(failures[0].rule, '');
  assert.equal(failures[0].code, '');
  // The label is the authored byte offset of the token that was never closed,
  // which is the only thing a caller needs to turn it into line:col.
  assert.equal(failures[0].labels[0].span.offset, byteOffset(brokenSource, '<main>'));
  assert.equal(
    output.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    1,
    batch.stdout,
  );
});

test('the report carries the number of threads the run really linted on', async () => {
  // Canonical Oxlint closes every report with `Finished in <t> on <n> files
  // with <r> rules using <threads> threads.`, and the tools that read Oxlint
  // want that line. A batch of nothing but `.tsrx` files never reaches
  // canonical Oxlint at all, so this leaf is the only half that can supply the
  // thread count for it - which is why the field is here and why the wrapper
  // stopped after the counts without it.
  //
  // The value is counted, not assumed: `aggregate_outputs` folds the distinct
  // threads its per-file outputs were produced on. So this asserts the shape of
  // a real measurement rather than the literal 1 today's sequential walk
  // produces, because a future parallel walk reporting 8 would be this field
  // working, not this test failing.
  for (const files of [[tsrxFixture], [tsrxFixture, tsxFixture]]) {
    const result = await run(['--format=json', ...files]);
    const output = parseJsonOutput(result);
    assert.equal(output.number_of_files, files.length, result.stdout);
    assert.ok(
      Number.isInteger(output.threads_count) && output.threads_count >= 1,
      `a ${files.length}-file batch reported no measured thread count:\n${result.stdout}`,
    );
  }
});

test('ordinary TSX bypasses the TSRX scan and projection allocation', async () => {
  const result = await run(['--format=json', '--deny', 'no-debugger', tsxFixture]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const output = parseJsonOutput(result);
  assert.ok(diagnosticFor(output, 'no-debugger'), result.stdout);
  assert.equal(output.oxcTsrx.mode, 'direct');
  assert.equal(output.oxcTsrx.files.standard, 1);
  assert.equal(output.oxcTsrx.timings.scanNs, 0);
  assert.equal(output.oxcTsrx.timings.projectionNs, 0);
  assert.equal(output.oxcTsrx.projectionBytes, 0);
});

test('ordinary JS, JSX, TS, and TSX match canonical Oxlint and bypass every TSRX stage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-direct-lint-'));
  const cases = {
    'ordinary.js': 'export function run() { debugger; return 1; }\n',
    'ordinary.jsx': 'export function View() { debugger; return <main>{1}</main>; }\n',
    'ordinary.ts': 'export function run(value: number): number { debugger; return value; }\n',
    'ordinary.tsx': 'export function View(props: { value: number }) { debugger; return <main>{props.value}</main>; }\n',
  };

  for (const [name, source] of Object.entries(cases)) {
    const file = join(directory, name);
    await writeFile(file, source);
    const [candidateResult, stockResult] = await Promise.all([
      run(['--format=json', '--deny', 'no-debugger', file]),
      new Promise((resolvePromise, reject) => {
        const child = spawn(stockBinary, ['--format=json', '--deny', 'no-debugger', file], {
          cwd: root,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
      }),
    ]);
    assert.equal(candidateResult.code, stockResult.code, name);
    const candidate = parseJsonOutput(candidateResult);
    const stock = parseJsonOutput(stockResult);
    assert.deepEqual(comparableDiagnostics(candidate), comparableDiagnostics(stock), name);
    assert.equal(candidate.oxcTsrx.mode, 'direct', name);
    assert.equal(candidate.oxcTsrx.files.standard, 1, name);
    assert.equal(candidate.oxcTsrx.timings.scanNs, 0, name);
    assert.equal(candidate.oxcTsrx.timings.projectionNs, 0, name);
    assert.equal(candidate.oxcTsrx.projectionBytes, 0, name);
  }
});

test('the lint leaf answers --help in the shape its formatter sibling already does', async () => {
  // The live control is the sibling in the same binary. Its help is the one the
  // CLI walkthrough called good, so its shape, not a sentence copied into this
  // file, is what the linter's help is held to.
  const sibling = await run(['fmt', '--help']);
  assert.equal(sibling.code, 0, sibling.stderr || sibling.stdout);
  assert.equal(sibling.stderr, '', sibling.stderr);

  for (const args of [['lint', '--help'], ['--help'], ['-h'], ['lint', '-h']]) {
    const help = await run(args);
    const label = args.join(' ');
    assert.equal(help.code, 0, `${label}: ${help.stderr || help.stdout}`);
    assert.equal(help.stderr, '', label);
    // It used to print `unsupported option in the current native CLI: --help`
    // and exit 2, or a wall of machine JSON with no help at all.
    assert.doesNotMatch(help.stdout, /^\{/u, label);
    assert.doesNotMatch(help.stdout, /"diagnostics"/u, label);

    const firstLine = (text) => text.split('\n', 1)[0];
    const shape = (text) => ({
      titled: /^OXC for TSRX \w+$/u.test(firstLine(text)),
      usage: /^Usage: oxc-tsrx-\w+ /mu.test(text),
      help: /^ {4}-h, --help {2,}\S/mu.test(text),
      version: /^ {4}-V, --version {2,}\S/mu.test(text),
      trailingNewline: text.endsWith('\n'),
    });
    assert.deepEqual(shape(help.stdout), shape(sibling.stdout), `${label}:\n${help.stdout}`);
    assert.deepEqual(
      shape(sibling.stdout),
      { titled: true, usage: true, help: true, version: true, trailingNewline: true },
      sibling.stdout,
    );
    // The one thing the sibling does not have to say: this bin is the internal
    // capability target, and `oxlint` is the command a user wants.
    assert.match(help.stdout, /\boxlint\b/u, label);
  }

  // `--help` is answered before "at least one explicit source file is required",
  // which is the error that used to greet a bare run.
  const bare = await run([]);
  assert.equal(bare.code, 2, bare.stdout);
  assert.match(bare.stderr, /at least one explicit source file is required/u, bare.stderr);
});

test('--discover walks with .gitignore honoured and --paths-file carries a list past the argument limit', async () => {
  // The drop-in oxlint hands the leaf a discovered file list. On a monorepo that keeps
  // gitignored copies of itself the old Node-side walk handed over every copy and the
  // command line overflowed (spawn E2BIG). The leaf now walks on the same `ignore`
  // crate canonical Oxlint uses, and takes a list from a file.
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-discover-'));
  await mkdir(join(directory, 'src/deep'), { recursive: true });
  await mkdir(join(directory, 'ignored/copy'), { recursive: true });
  await mkdir(join(directory, 'node_modules/dep'), { recursive: true });
  await writeFile(join(directory, '.gitignore'), 'ignored/\n');
  const component = 'export function View() @{\n  debugger;\n  <p>hi</p>;\n}\n';
  await writeFile(join(directory, 'src/a.tsrx'), component);
  await writeFile(join(directory, 'src/deep/b.tsrx'), component);
  await writeFile(join(directory, 'src/c.ts'), 'export const c = 1;\n');
  await writeFile(join(directory, 'ignored/copy/d.tsrx'), component);
  await writeFile(join(directory, 'node_modules/dep/e.tsrx'), component);

  const discovered = await run(['--discover', directory]);
  assert.equal(discovered.code, 0, discovered.stderr || discovered.stdout);
  const files = JSON.parse(discovered.stdout).files.map((file) => file.slice(directory.length + 1));
  assert.deepEqual(files.sort(), ['src/a.tsrx', 'src/deep/b.tsrx']);

  // A file named outright is kept even inside an ignored directory, as canonical Oxlint keeps it.
  const named = await run(['--discover', join(directory, 'ignored/copy/d.tsrx')]);
  assert.equal(JSON.parse(named.stdout).files.length, 1);

  const list = join(directory, 'paths.txt');
  await writeFile(list, `${join(directory, 'src/a.tsrx')}\r\n\n${join(directory, 'src/deep/b.tsrx')}\n`);
  const linted = await run(['--paths-file', list]);
  assert.equal(linted.code, 0, linted.stderr || linted.stdout);
  const report = JSON.parse(linted.stdout);
  assert.equal(report.number_of_files, 2);
  assert.equal(report.diagnostics.filter((item) => item.code.includes('no-debugger')).length, 2);
  await rm(directory, { recursive: true, force: true });
});

test('a file OXC cannot parse is a named, positioned error and the rest of the batch still reports', async () => {
  // tsrx-org/oxc#79: an editor-completion probe with an incomplete member access used to abort
  // the whole batch with "OXC parse failed: Unexpected token" and no file name.
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-parse-failure-'));
  const probe = "export function Probe() @{\n\tconst element = document.createElement('div');\n\tdocument./*completion*/;\n\t<div>{element.dataset}</div>\n}\n";
  await writeFile(join(directory, 'probe.tsrx'), probe);
  await writeFile(join(directory, 'clean.tsrx'), "export function Clean() @{\n\tdebugger;\n\t<p>hi</p>\n}\n");
  const result = await run([join(directory, 'probe.tsrx'), join(directory, 'clean.tsrx')]);
  // Error diagnostics exit 1, as for any lint error; the tool-failure exit 2 is what went away.
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.number_of_files, 2);
  const failures = report.diagnostics.filter((item) => item.filename.endsWith('probe.tsrx'));
  assert.equal(failures.length, 1, JSON.stringify(report.diagnostics));
  assert.equal(failures[0].severity, 'error');
  assert.match(failures[0].message, /^OXC parse failed: /u);
  const lineStart = probe.indexOf('\tdocument./*');
  const lineEnd = probe.indexOf('\n', lineStart);
  const offset = failures[0].labels[0]?.span.offset;
  assert.ok(offset >= lineStart && offset <= lineEnd, `offset ${offset} not on the authored line ${lineStart}..${lineEnd}`);
  assert.ok(report.diagnostics.some((item) => item.filename.endsWith('clean.tsrx') && item.code.includes('no-debugger')), 'the other file still reports');
  await rm(directory, { recursive: true, force: true });
});

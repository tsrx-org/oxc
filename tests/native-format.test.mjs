import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// One multi-call native binary carries the linter, the formatter, and the
// language server. `fmt` selects the formatter.
const binary = process.env.OXFMT_BIN ?? join(root, 'target/release/oxc-tsrx');
// `oxfmt-current` is declared by tests/package.json, so it is resolved from
// this file rather than from a hoisted repository-root `node_modules`. pnpm
// installs it under tests/node_modules and nowhere else.
const stockBinary = join(
  dirname(createRequire(import.meta.url).resolve('oxfmt-current/package.json')),
  'bin/oxfmt',
);
const fixtures = join(root, 'tests/fixtures/format');

function run(executable, args, input = null) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    // A command that rejects its config exits before draining stdin, so this
    // write can land on a closed pipe. That is the behaviour under test; report
    // what the child did and let the assertions judge it.
    child.stdin.once('error', (error) => {
      if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') reject(error);
    });
    child.stdin.end(input ?? undefined);
  });
}

function runFormat(args, input = null) {
  return run(binary, ['fmt', ...args], input);
}

async function fixture(name) {
  return readFile(join(fixtures, name), 'utf8');
}

test('formats a Markless-derived TSRX component from stdin and is idempotent', async () => {
  const source = await fixture('markless-counter.unformatted.tsrx');
  const expected = await fixture('markless-counter.formatted.tsrx');
  const first = await runFormat(['--stdin-filepath=Counter.tsrx'], source);

  assert.equal(first.signal, null);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(first.stdout, expected);
  assert.equal(first.stderr, '');
  assert.match(first.stdout, /export function Counter\(\) @\{/);

  const second = await runFormat(['--stdin-filepath=Counter.tsrx'], first.stdout);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(second.stdout, first.stdout);
});

test('preserves lexical @ text while formatting nested statement control flow', async () => {
  const source = await fixture('conditional.unformatted.tsrx');
  const expected = await fixture('conditional.formatted.tsrx');
  const result = await runFormat(['--stdin-filepath', 'conditional.tsrx'], source);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, expected);
  assert.match(result.stdout, /\/@if\\s\+\\\/\/gu/);
  assert.match(result.stdout, /`Crème 🚀 \$\{label\}`/);
  assert.match(result.stdout, />@if is text, not control<\/p>/);
  assert.match(result.stdout, /\/\* @if \(comment\) \{\} \*\//);
  assert.match(result.stdout, /"@else@example\.com"/);
  assert.equal((result.stdout.match(/@if \(ready\)/g) ?? []).length, 1);
  assert.equal((result.stdout.match(/@else \{/g) ?? []).length, 1);
});

test('check and write converge without touching an unformatted file during check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-format-'));
  const path = join(directory, 'Counter.tsrx');
  const before = await fixture('markless-counter.unformatted.tsrx');
  const expected = await fixture('markless-counter.formatted.tsrx');
  await writeFile(path, before);

  const checkBefore = await runFormat(['--check', path]);
  assert.equal(checkBefore.code, 1, checkBefore.stderr || checkBefore.stdout);
  assert.match(checkBefore.stdout, new RegExp(`${basename(path)}|${path.replaceAll('\\', '\\\\')}`));
  assert.equal(await readFile(path, 'utf8'), before);

  const write = await runFormat(['--write', path]);
  assert.equal(write.code, 0, write.stderr || write.stdout);
  assert.equal(await readFile(path, 'utf8'), expected);

  const checkAfter = await runFormat(['--check', path]);
  assert.equal(checkAfter.code, 0, checkAfter.stderr || checkAfter.stdout);
});

test('a multi-file write is fail-atomic when one file contains malformed TSRX', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-format-atomic-'));
  const validPath = join(directory, 'valid.tsrx');
  const malformedPath = join(directory, 'malformed.tsrx');
  const validBefore = await fixture('markless-counter.unformatted.tsrx');
  const malformedBefore = 'export function List() @{ <style>p { color: red } }\n';
  await writeFile(validPath, validBefore);
  await writeFile(malformedPath, malformedBefore);

  const result = await runFormat(['--write', validPath, malformedPath]);
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /unterminated|closing|style|structural/i);
  assert.equal(await readFile(validPath, 'utf8'), validBefore);
  assert.equal(await readFile(malformedPath, 'utf8'), malformedBefore);
});

test('invalid TSRX returns no formatted output', async () => {
  const source = 'export function Broken() @{ const value = ; }\n';
  const result = await runFormat(['--stdin-filepath=broken.tsrx'], source);
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /parse|expected|unexpected/i);
});

test('a jsdoc config reflows JSDoc in .tsrx and matches canonical Oxfmt on ordinary TS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-format-jsdoc-'));
  const configPath = join(directory, '.oxfmtrc.json');
  const doc = ['/**', '*   counts   things', '*  @param {number}   start   the first value', '*/'];
  const tsrx = `${doc.join('\n')}\nexport function View({start}:{start:number}) @{<p>{start}</p>}\n`;
  const ts = `${doc.join('\n')}\nexport function view(start:number){return start+1}\n`;
  // The reflowed comment canonical Oxfmt produces for that source: the description is
  // capitalized, the runs of spaces collapse, and a blank line opens the tag group.
  const reflowed = [
    '/**',
    ' * Counts things',
    ' *',
    ' * @param {number} start The first value',
    ' */',
  ].join('\n');

  await writeFile(configPath, '{ "semi": false, "jsdoc": true }\n');
  const [component, control, stock] = await Promise.all([
    runFormat([`--config=${configPath}`, '--stdin-filepath=View.tsrx'], tsrx),
    runFormat([`--config=${configPath}`, '--stdin-filepath=view.ts'], ts),
    run(stockBinary, [`--config=${configPath}`, '--stdin-filepath=view.ts'], ts),
  ]);
  assert.equal(component.code, 0, component.stderr || component.stdout);
  assert.equal(component.stderr, '');
  assert.ok(component.stdout.startsWith(`${reflowed}\n`), component.stdout);
  // Under `semi: false` the markup statement carries no ASI guard: a line-leading markup
  // opening is a statement boundary in TSRX (tsrx-org/oxc#64).
  assert.match(component.stdout, /@\{\n {2}<p>\{start\}<\/p>\n\}/);
  assert.equal(stock.code, 0, stock.stderr || stock.stdout);
  assert.equal(control.stdout, stock.stdout);

  const again = await runFormat([`--config=${configPath}`, '--stdin-filepath=View.tsrx'], component.stdout);
  assert.equal(again.code, 0, again.stderr || again.stdout);
  assert.equal(again.stdout, component.stdout);

  // The object form reaches the same engine, with the sub-options it names.
  await writeFile(
    configPath,
    '{ "jsdoc": { "commentLineStrategy": "multiline", "descriptionWithDot": true } }\n',
  );
  const object = await runFormat([`--config=${configPath}`, '--stdin-filepath=View.tsrx'], tsrx);
  assert.equal(object.code, 0, object.stderr || object.stdout);
  assert.ok(object.stdout.startsWith('/**\n * Counts things.\n'), object.stdout);
  assert.match(object.stdout, /@param \{number\} start The first value\./);

  // A value the pinned formatter cannot use is still refused, in its own wording.
  await writeFile(configPath, '{ "jsdoc": { "lineWrappingStyle": "wrap" } }\n');
  const rejected = await runFormat([`--config=${configPath}`, '--stdin-filepath=View.tsrx'], tsrx);
  assert.equal(rejected.code, 2, rejected.stderr || rejected.stdout);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /jsdoc lineWrappingStyle `wrap`/);
});

test('a sortImports config orders imports in .tsrx and matches canonical Oxfmt on ordinary TS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-format-sort-imports-'));
  const configPath = join(directory, '.oxfmtrc.json');
  const imports = [
    'import {B} from "Beta";',
    'import {a} from "alpha";',
    'import {readFile} from "node:fs";',
  ].join('\n');
  const tsrx = `${imports}\nexport function Card() @{<p>{a}{B}{readFile}</p>}\n`;
  const ts = `${imports}\nexport function view(){return a+B+readFile}\n`;
  // The order canonical Oxfmt produces for that source with the default groups: the Node built-in
  // leads its own group, then the two external packages sort together, case-insensitively.
  const sorted = [
    'import { readFile } from "node:fs";',
    '',
    'import { a } from "alpha";',
    'import { B } from "Beta";',
  ].join('\n');

  await writeFile(configPath, '{ "sortImports": true }\n');
  const [component, control, stock] = await Promise.all([
    runFormat([`--config=${configPath}`, '--stdin-filepath=Card.tsrx'], tsrx),
    runFormat([`--config=${configPath}`, '--stdin-filepath=view.ts'], ts),
    run(stockBinary, [`--config=${configPath}`, '--stdin-filepath=view.ts'], ts),
  ]);
  assert.equal(component.code, 0, component.stderr || component.stdout);
  assert.equal(component.stderr, '');
  // The refusal this option used to get is gone.
  assert.doesNotMatch(component.stderr, /not available for TSRX/i);
  assert.ok(component.stdout.startsWith(`${sorted}\n`), component.stdout);
  assert.match(component.stdout, /export function Card\(\) @\{\n {2}<p>/);
  assert.equal(stock.code, 0, stock.stderr || stock.stdout);
  assert.equal(control.stdout, stock.stdout);

  const again = await runFormat(
    [`--config=${configPath}`, '--stdin-filepath=Card.tsrx'],
    component.stdout,
  );
  assert.equal(again.code, 0, again.stderr || again.stdout);
  assert.equal(again.stdout, component.stdout);

  // The object form reaches the same engine, with the sub-options it names: a case-sensitive
  // order puts `Beta` above `alpha`, and `newlinesBetween: false` drops the blank line.
  await writeFile(
    configPath,
    `${JSON.stringify({
      sortImports: {
        ignoreCase: false,
        newlinesBetween: false,
        groups: ['builtin', 'external', 'unknown'],
      },
    })}\n`,
  );
  const [object, objectControl, objectStock] = await Promise.all([
    runFormat([`--config=${configPath}`, '--stdin-filepath=Card.tsrx'], tsrx),
    runFormat([`--config=${configPath}`, '--stdin-filepath=view.ts'], ts),
    run(stockBinary, [`--config=${configPath}`, '--stdin-filepath=view.ts'], ts),
  ]);
  assert.equal(object.code, 0, object.stderr || object.stdout);
  assert.ok(
    object.stdout.startsWith(
      [
        'import { readFile } from "node:fs";',
        'import { B } from "Beta";',
        'import { a } from "alpha";',
        '',
      ].join('\n'),
    ),
    object.stdout,
  );
  assert.equal(objectControl.stdout, objectStock.stdout);

  // Canonical Oxfmt's original spelling of this option reaches the same engine.
  await writeFile(configPath, '{ "experimentalSortImports": true }\n');
  const aliased = await runFormat(
    [`--config=${configPath}`, '--stdin-filepath=Card.tsrx'],
    tsrx,
  );
  assert.equal(aliased.code, 0, aliased.stderr || aliased.stdout);
  assert.ok(aliased.stdout.startsWith(`${sorted}\n`), aliased.stdout);

  // A group name nothing defines is still refused, in canonical Oxfmt's own wording.
  await writeFile(configPath, '{ "sortImports": { "groups": ["nope"] } }\n');
  const rejectedGroup = await runFormat(
    [`--config=${configPath}`, '--stdin-filepath=Card.tsrx'],
    tsrx,
  );
  assert.equal(rejectedGroup.code, 2, rejectedGroup.stderr || rejectedGroup.stdout);
  assert.equal(rejectedGroup.stdout, '');
  assert.match(rejectedGroup.stderr, /unknown group name `nope` in `groups`/);
});

test('ordinary JS, JSX, TS, and TSX take the canonical format path byte-for-byte', async () => {
  const cases = {
    'ordinary.js': 'export function value( ){return {answer:1}}\n',
    'ordinary.jsx': 'export function View( ){return <main data-x="1">ok</main>}\n',
    'ordinary.ts': 'export function value(input:number):number{return input+1}\n',
    'ordinary.tsx': 'type P={label:string};export function View({label}:P){return <main>{label}</main>}\n',
  };
  for (const [name, source] of Object.entries(cases)) {
    const [candidate, stock] = await Promise.all([
      runFormat([`--stdin-filepath=${name}`], source),
      run(stockBinary, [`--stdin-filepath=${name}`], source),
    ]);
    assert.equal(candidate.code, 0, candidate.stderr || candidate.stdout);
    assert.equal(stock.code, 0, stock.stderr || stock.stdout);
    assert.equal(candidate.stdout, stock.stdout, name);
  }
});

test('Unicode decorator identifiers format identically through TSRX and canonical TSX paths', async () => {
  const cases = {
    'raw-unicode': '@ifπ\nclass Decorated{method( ){return 1}}\n',
    'escaped-unicode': '@for\\u03c0\nclass Decorated{method( ){return 1}}\n',
    'escaped-astral': '@try\\u{1D49C}\nclass Decorated{method( ){return 1}}\n',
  };

  for (const [name, source] of Object.entries(cases)) {
    const [tsrx, tsx] = await Promise.all([
      runFormat([`--stdin-filepath=${name}.tsrx`], source),
      runFormat([`--stdin-filepath=${name}.tsx`], source),
    ]);
    assert.equal(tsx.code, 0, tsx.stderr || tsx.stdout);
    assert.equal(tsrx.code, 0, tsrx.stderr || tsrx.stdout);
    assert.equal(tsrx.stdout, tsx.stdout, name);
    assert.equal(tsrx.stderr, '');
  }
});

test('a semi: false config prints no ASI guard before a line-leading markup statement', async () => {
  // tsrx-org/oxc#64. The projection writes a `;` wherever TSRX read a statement boundary that
  // legal TSX cannot, and Oxfmt keeps it as a guard under `semi: false`. TSRX has no hazard
  // there, so the lift removes exactly those guards; `;[` and `;(` stay.
  const directory = await mkdtemp(join(tmpdir(), 'oxc-tsrx-format-semi-false-'));
  const configPath = join(directory, '.oxfmtrc.json');
  await writeFile(configPath, '{ "semi": false, "useTabs": true, "tabWidth": 2, "singleQuote": true }\n');
  const source = await fixture('semi-false.unformatted.tsrx');
  const expected = await fixture('semi-false.formatted.tsrx');
  assert.equal((source.match(/^\s*;</gm) ?? []).length, 4);
  assert.equal((expected.match(/^\s*;</gm) ?? []).length, 0);

  const first = await runFormat([`--config=${configPath}`, '--stdin-filepath=Controls.tsrx'], source);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, expected);

  const again = await runFormat([`--config=${configPath}`, '--stdin-filepath=Controls.tsrx'], first.stdout);
  assert.equal(again.code, 0, again.stderr || again.stdout);
  assert.equal(again.stdout, expected);

  // `--check` agrees with `--write`: the guard-free form is the clean one, and the guarded
  // form is what needs fixing.
  const cleanPath = join(directory, 'Controls.tsrx');
  await writeFile(cleanPath, expected);
  const check = await runFormat([`--config=${configPath}`, '--check', cleanPath]);
  assert.equal(check.code, 0, check.stderr || check.stdout);
  await writeFile(cleanPath, source);
  const dirty = await runFormat([`--config=${configPath}`, '--check', cleanPath]);
  assert.equal(dirty.code, 1, dirty.stderr || dirty.stdout);
});

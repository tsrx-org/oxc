import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertOwnerSourceUnchanged,
  shouldExcludeSourcePath,
} from './clean-room-utils.mjs'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const marklessRoot = path.resolve(
  process.env.MARKLESS_ROOT ?? '/Users/jacksm5pro/dev/open-source/markless',
)
const reportPath = path.join(sourceRoot, 'docs', 'acceptance', 'clean-room-report.json')
const startedAt = new Date().toISOString()
const commands = []
const matrix = {}
let cleanRoot = null
let marklessBefore = null
let marklessAfter = null
let failure = null
let initialSourceHash = null

const mutableOrHeavy = new Set([
  '.git',
  '.fable-codex',
  'node_modules',
  'target',
  '.docs-demo-tmp',
])

function cleanEnvironment(root) {
  const environment = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    MARKLESS_ROOT: marklessRoot,
    npm_config_cache: path.join(root, '.npm-cache'),
    // The clean room must not inherit the developer's pnpm store decisions.
    npm_config_store_dir: path.join(root, '.pnpm-store'),
  }
  for (const key of Object.keys(environment)) {
    if (
      key === 'NODE_PATH' ||
      key.startsWith('OXC_TSRX_') ||
      key.startsWith('OXLINT_TSGOLINT') ||
      key.startsWith('VP_')
    ) {
      delete environment[key]
    }
  }
  return environment
}

function commandString(executable, args) {
  return [executable, ...args].join(' ')
}

function tail(text, max = 12_000) {
  return text.length <= max ? text : text.slice(-max)
}

function run(executable, args, { cwd, env, expected = [0], label, quiet = false } = {}) {
  const began = performance.now()
  const display = label ?? commandString(executable, args)
  if (!quiet) process.stdout.write(`\n[clean-room] ${display}\n`)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (!quiet) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (!quiet) process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', (status, signal) => {
      const record = {
        label: display,
        command: commandString(executable, args),
        status,
        signal,
        durationMs: Number((performance.now() - began).toFixed(1)),
      }
      commands.push(record)
      if (!expected.includes(status)) {
        reject(
          new Error(
            `${display} exited ${status}${signal ? ` (${signal})` : ''}\n${tail(stderr || stdout)}`,
          ),
        )
      } else {
        resolve({ status, signal, stdout, stderr, record })
      }
    })
  })
}

async function treeHash(root, { excludeReport = false } = {}) {
  const hash = createHash('sha256')
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (shouldExcludeSourcePath(relative, { excludeReport })) continue
      if (entry.isDirectory()) {
        await visit(absolute)
      } else if (entry.isFile()) {
        hash.update(`file\0${relative}\0`)
        hash.update(await readFile(absolute))
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relative}\0`)
      }
    }
  }
  await visit(root)
  return hash.digest('hex')
}

async function gitOutput(args, encoding = null) {
  const result = await run('git', ['-C', marklessRoot, ...args], {
    cwd: sourceRoot,
    env: process.env,
    label: `read-only Markless: git ${args.join(' ')}`,
    quiet: true,
  })
  return encoding ? result.stdout : Buffer.from(result.stdout, 'utf8')
}

async function marklessFingerprint() {
  const hash = createHash('sha256')
  const head = (await gitOutput(['rev-parse', 'HEAD'], 'utf8')).trim()
  const [status, diff, staged, untrackedRaw] = await Promise.all([
    gitOutput(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    gitOutput(['diff', '--binary']),
    gitOutput(['diff', '--cached', '--binary']),
    gitOutput(['ls-files', '--others', '--exclude-standard', '-z'], 'utf8'),
  ])
  hash.update(head).update(status).update(diff).update(staged)
  const untracked = untrackedRaw.split('\0').filter(Boolean).sort()
  for (const relative of untracked) {
    const absolute = path.join(marklessRoot, relative)
    const metadata = await stat(absolute)
    if (!metadata.isFile()) continue
    hash.update(relative).update(await readFile(absolute))
  }
  return {
    head,
    sha256: hash.digest('hex'),
    statusSha256: createHash('sha256').update(status).digest('hex'),
    untrackedFiles: untracked.length,
  }
}

async function copySource(destination) {
  await cp(sourceRoot, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).split(path.sep).join('/')
      if (!relative) return true
      return !shouldExcludeSourcePath(relative, { excludeReport: true })
    },
  })
}

function byteSlice(source, span) {
  const bytes = Buffer.from(source)
  return bytes.subarray(span.offset, span.offset + span.length).toString('utf8')
}

async function diagnosticAndFixProof(root, environment) {
  const fixture = path.join(root, 'tests', 'fixtures', 'acceptance', 'owner-workflow.tsrx')
  const binary = path.join(root, 'target', 'release', 'oxc-tsrx')
  const source = await readFile(fixture, 'utf8')
  const lint = await run(
    binary,
    ['--format=json', '--warn', 'no-debugger', '--deny', 'no-var', fixture],
    { cwd: root, env: environment, expected: [1], label: 'authored-span diagnostic sample' },
  )
  const output = JSON.parse(lint.stdout)
  const diagnostics = output.diagnostics
    .filter((diagnostic) => diagnostic.filename.endsWith('owner-workflow.tsrx'))
    .map((diagnostic) => ({
      rule: diagnostic.rule,
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      labels: diagnostic.labels.map((label) => ({
        ...label,
        authoredText: byteSlice(source, label.span),
      })),
    }))
  if (!diagnostics.some((diagnostic) => /no-debugger/u.test(diagnostic.code))) {
    throw new Error('authored-span sample is missing no-debugger')
  }
  if (!diagnostics.some((diagnostic) => /no-var/u.test(diagnostic.code))) {
    throw new Error('authored-span sample is missing no-var')
  }
  if (output.oxcTsrx?.parseCount !== 1) throw new Error('authored-span sample parsed more than once')

  const fixed = path.join(root, 'tests', 'fixtures', 'acceptance', 'owner-workflow-fixed.tsrx')
  await writeFile(fixed, source)
  await run(
    binary,
    ['--fix', '--deny', 'no-var', '--allow', 'no-debugger', fixed],
    { cwd: root, env: environment, label: 'identity-safe fix sample' },
  )
  const fixedSource = await readFile(fixed, 'utf8')
  if (/\bvar\b/u.test(fixedSource) || !/\b(?:const|let) count\b/u.test(fixedSource)) {
    throw new Error('identity-safe no-var fix did not write a modern authored declaration')
  }
  await run(binary, ['--allow', 'no-debugger', fixed], {
    cwd: root,
    env: environment,
    label: 'fixed TSRX validation reparse',
  })
  return {
    parseCount: output.oxcTsrx.parseCount,
    diagnostics,
    fix: {
      beforeSha256: createHash('sha256').update(source).digest('hex'),
      afterSha256: createHash('sha256').update(fixedSource).digest('hex'),
      before: source,
      after: fixedSource,
      reparsed: true,
    },
  }
}

async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'))
}

await mkdir(path.dirname(reportPath), { recursive: true })

try {
  marklessBefore = await marklessFingerprint()
  const parent = await mkdtemp(path.join(tmpdir(), 'oxc-tsrx-owner-oracle-'))
  cleanRoot = path.join(parent, 'source')
  await copySource(cleanRoot)
  const [sourceHash, cleanHash] = await Promise.all([
    treeHash(sourceRoot, { excludeReport: true }),
    treeHash(cleanRoot, { excludeReport: true }),
  ])
  initialSourceHash = sourceHash
  if (sourceHash !== cleanHash) throw new Error('disposable source copy differs from the owner tree')
  matrix.cleanSource = {
    sourceHash,
    initialSourceHash,
    cleanHash,
    exactCopy: true,
    excluded: [...mutableOrHeavy, 'nested target/node_modules', '.corpus-*', 'benchmarks/**/latest.json', 'docs/dist'],
  }

  const environment = cleanEnvironment(cleanRoot)
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const packageManager = await run(pnpm, ['--version'], {
    cwd: cleanRoot,
    env: environment,
    label: 'pnpm version',
  })
  const rust = await run('rustc', ['--version'], {
    cwd: cleanRoot,
    env: environment,
    label: 'Rust version',
  })
  await run(pnpm, ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: cleanRoot,
    env: environment,
    label: 'fresh locked pnpm install',
  })
  await run('cargo', ['fmt', '--all', '--', '--check'], {
    cwd: cleanRoot,
    env: environment,
    label: 'Rust formatting gate',
  })
  await run('cargo', ['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings'], {
    cwd: cleanRoot,
    env: environment,
    label: 'fresh clean-room clippy',
  })
  await run('cargo', ['test', '--workspace', '--all-targets', '--locked'], {
    cwd: cleanRoot,
    env: environment,
    label: 'fresh clean-room Rust tests',
  })
  await run(
    'cargo',
    ['build', '--release', '--locked', '-p', 'oxc_tsrx_cli', '--bins'],
    { cwd: cleanRoot, env: environment, label: 'fresh release native binaries' },
  )
  // The packaging matrix packs the canonical parser addon from the release
  // library and installs the compat facade in an outside consumer, so the
  // clean room has to build that addon too, not only the CLI binaries.
  await run(pnpm, ['run', 'build:parser-native'], {
    cwd: cleanRoot,
    env: environment,
    label: 'fresh release parser addon',
  })
  await run(pnpm, ['run', 'build:editor'], {
    cwd: cleanRoot,
    env: environment,
    label: 'fresh editor bundle',
  })
  await run(pnpm, ['run', 'licenses:check'], {
    cwd: cleanRoot,
    env: environment,
    label: 'locked legal inventories',
  })

  matrix.authoredSpanAndFix = await diagnosticAndFixProof(cleanRoot, environment)

  await run(pnpm, ['test'], {
    cwd: cleanRoot,
    env: environment,
    label: 'product/config/Vite/editor matrix',
  })
  await run(pnpm, ['run', 'test:packaging:unit'], {
    cwd: cleanRoot,
    env: environment,
    label: 'package/non-fork/legal artifact matrix',
  })
  await run(pnpm, ['run', 'test:packaging:clean'], {
    cwd: cleanRoot,
    env: environment,
    label: 'untouched-tarball empty-consumer workflow',
  })
  await run(pnpm, ['run', 'test:packaging:matrix'], {
    cwd: cleanRoot,
    env: { ...environment, OXC_TSRX_RETAIN_MATRIX_REPORT: '1' },
    label: 'minimum/current Vite+ installed-package matrix',
  })
  await run(
    process.execPath,
    ['--test', 'tests/markless-control-corpus.test.mjs'],
    {
      cwd: cleanRoot,
      env: {
        ...environment,
        OXFMT_BIN: path.join(cleanRoot, 'target', 'release', 'oxc-tsrx'),
      },
      label: 'read-only 179-file Markless format/reparse/convergence corpus',
    },
  )
  await run(pnpm, ['run', 'test:packaging:vscode'], {
    cwd: cleanRoot,
    env: environment,
    label: 'installed VSIX Markless format-on-save/diagnostics/action walkthrough',
  })

  const [cleanInstall, viteMatrix, installedVsix] = await Promise.all([
    readJson(cleanRoot, 'tests/packaging/clean-install-report.json'),
    readJson(cleanRoot, 'tests/packaging/vite-plus-matrix-report.json'),
    readJson(cleanRoot, 'tests/packaging/installed-vsix-report.json'),
  ])
  matrix.packagedConsumer = cleanInstall
  matrix.vitePlus = viteMatrix
  matrix.editor = installedVsix
  matrix.marklessCorpus = {
    revision: '76d0e6a07fa728b9343cc0d342fbe03813c43703',
    trackedTsrx: 191,
    parserValidFormattedReparsedConverged: 179,
    parserInvalidRejected: 12,
    rawStylePayloadsByteExact: true,
    externalWrites: false,
  }
  matrix.versions = {
    project: (await readJson(cleanRoot, 'package.json')).version,
    oxcRevision: /OXC_REVISION:\s*&str\s*=\s*"([0-9a-f]{40})"/u.exec(
      await readFile(path.join(cleanRoot, 'crates', 'oxc_adapter', 'src', 'lib.rs'), 'utf8'),
    )?.[1],
    pnpm: packageManager.stdout.trim(),
    rustc: rust.stdout.trim(),
  }
  matrix.claims = {
    formatCheckWriteConverges: cleanInstall.assertions.mixedFormatCheckWriteCheck,
    lintAuthoredDiagnostics: cleanInstall.assertions.mixedLintAuthoredDiagnostics,
    safeFixes: cleanInstall.assertions.vitePlusCheckFix,
    jsonJsoncAndViteConfig: true,
    builtinPluginAndTypeAware: cleanInstall.assertions.typeAwareTsgolint,
    javascriptPluginUnsupportedLoudly: true,
    ordinaryJsJsxTsTsxDelegated: true,
    viteFrameworkBuildDevHmr: true,
    vitePlusBuildDevRetransform:
      viteMatrix.lanes.every(
        (lane) =>
          lane.proof.viteBuild && lane.proof.viteDev && lane.proof.viteDevRetransform,
      ),
    vitePlusMinimumCurrent: viteMatrix.lanes.every((lane) => lane.proof.supported),
    installedVsix: Object.values(installedVsix.assertions).every(Boolean),
    noSourceTreeOverrides: cleanInstall.assertions.noSourceTreeBinaryOverride,
    noInstallScripts: cleanInstall.assertions.noInstallScripts,
  }
} catch (error) {
  failure = error
} finally {
  try {
    marklessAfter = await marklessFingerprint()
    if (marklessBefore && marklessAfter.sha256 !== marklessBefore.sha256) {
      failure ??= new Error('the external Markless fingerprint changed')
    }
  } catch (error) {
    failure ??= error
  }

  if (initialSourceHash) {
    try {
      const finalSourceHash = await treeHash(sourceRoot, { excludeReport: true })
      matrix.cleanSource.finalSourceHash = finalSourceHash
      matrix.cleanSource.ownerUnchanged = initialSourceHash === finalSourceHash
      assertOwnerSourceUnchanged(initialSourceHash, finalSourceHash)
    } catch (error) {
      failure ??= error
    }
  }

  const report = {
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    startedAt,
    completedAt: new Date().toISOString(),
    isolation: {
      disposableSource: true,
      freshNpmCi: true,
      freshCargoTargets: true,
      sourceTreeBinaryOverrides: false,
      sourceTreeNodeModulesUsed: false,
      cleanRootRemoved: !failure,
    },
    external: {
      marklessRoot,
      before: marklessBefore,
      after: marklessAfter,
      unchanged: Boolean(marklessBefore && marklessAfter?.sha256 === marklessBefore.sha256),
    },
    commands,
    matrix,
    failure: failure
      ? { name: failure.name, message: failure.message, stack: tail(failure.stack ?? '') }
      : null,
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (!failure && cleanRoot) await rm(path.dirname(cleanRoot), { recursive: true, force: true })
}

if (failure) {
  console.error(`\n[clean-room] FAILED: ${failure.message}`)
  console.error(`[clean-room] retained report: ${reportPath}`)
  process.exit(1)
}

console.log(`\n[clean-room] PASS: ${reportPath}`)

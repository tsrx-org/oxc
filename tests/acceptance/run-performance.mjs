import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  adjudicateReports,
  findSingleFreshReport,
  isAcceptedBenchmarkExit,
  normalizeAssertion,
  planAdjudication,
} from './performance-adjudication.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const reportPath = path.join(root, 'docs', 'acceptance', 'performance-report.json')
const families = ['native-lint', 'native-format', 'type-aware', 'vite', 'editor', 'comparative']
const commands = []
const adjudicationBandFraction = 0.03
let failure = null
const adjudications = {}
let rssAdjudication = null
const selectedReports = {}
const nativeFormatOperators = new Map([
  ['p04_direct_median_ratio', '<='],
  ['p04_direct_p95_ratio', '<='],
  ['p04_sequential_median_mib_s', '>='],
  ['p04_sequential_p95_mib_s', '>='],
  ['p04_historical_incumbent_derived_floor_mib_s', '>='],
  ['p04_default_thread_mib_s', '>='],
  ['p04_generalized_control_median_mib_s', '>='],
  ['p04_generalized_control_p95_mib_s', '>='],
  ['p04_generalized_control_linear_scaling', '<='],
  ['p05_stdin_p95_ms', '<='],
  ['p05_upstream_ratio', '<='],
  ['p07_rss_ratio', '<='],
])

function tail(text, max = 12_000) {
  return text.length <= max ? text : text.slice(-max)
}

function run(executable, args, label, { allowFailure = false } = {}) {
  const began = performance.now()
  const startedAtUnixMs = Date.now()
  process.stdout.write(`\n[performance] ${label}\n`)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', (status, signal) => {
      const commandReceipt = {
        label,
        command: [executable, ...args].join(' '),
        status,
        signal,
        startedAtUnixMs,
        completedAtUnixMs: Date.now(),
        durationMs: Number((performance.now() - began).toFixed(1)),
      }
      commands.push(commandReceipt)
      if (status !== 0 && !allowFailure) {
        reject(new Error(`${label} exited ${status}\n${tail(stderr || stdout)}`))
      } else {
        resolve({ status, signal, stdout, stderr, commandReceipt })
      }
    })
  })
}

async function reportNames(family) {
  const directory = path.join(root, 'benchmarks', family)
  return new Set(
    (await readdir(directory)).filter((candidate) => /^results-\d+\.json$/u.test(candidate)),
  )
}

async function readNamedReport(family, name) {
  const directory = path.join(root, 'benchmarks', family)
  return {
    path: `benchmarks/${family}/${name}`,
    report: JSON.parse(await readFile(path.join(directory, name), 'utf8')),
  }
}

function generatedAtUnixMs(report) {
  if (Number.isFinite(report.generatedAtUnixMs)) return report.generatedAtUnixMs
  const parsed = Date.parse(report.timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

async function runFreshReport({ family, command, label, allowAssertionFailure = false }) {
  const before = await reportNames(family)
  const outcome = await run(command[0], command.slice(1), label, { allowFailure: true })
  const name = findSingleFreshReport(before, await reportNames(family), family)
  const current = await readNamedReport(family, name)
  outcome.commandReceipt.reportPath = current.path
  const generatedAt = generatedAtUnixMs(current.report)
  const filenameTimestamp = Number(name.match(/^results-(\d+)\.json$/u)?.[1])
  if (
    !Number.isFinite(generatedAt) ||
    generatedAt < outcome.commandReceipt.startedAtUnixMs ||
    generatedAt > outcome.commandReceipt.completedAtUnixMs
  ) {
    throw new Error(`${family} report generation time falls outside its command interval`)
  }
  if (!Number.isFinite(filenameTimestamp) || Math.abs(filenameTimestamp - generatedAt) > 1_000) {
    throw new Error(`${family} report filename does not match its generation time`)
  }
  if (!outcome.stdout.includes(name)) {
    throw new Error(`${family} command did not identify its discovered report on stdout`)
  }
  requireContract(family, current.report)
  const assertions = assertionList(current.report)
  const reportPassed = assertions.length > 0 && assertions.every(({ pass }) => pass === true)
  if (
    !isAcceptedBenchmarkExit(
      { status: outcome.status, signal: outcome.signal, reportPassed },
      { allowAssertionFailure },
    )
  ) {
    throw new Error(
      `${label} exited ${outcome.status ?? outcome.signal}\n${tail(outcome.stderr || outcome.stdout)}`,
    )
  }
  return current
}

function assertionList(report) {
  if (Array.isArray(report.assertionDetails)) return report.assertionDetails
  if (Array.isArray(report.assertions)) return report.assertions
  return Object.entries(report.assertions ?? {}).map(([name, pass]) => ({ name, pass }))
}

function requireContract(family, report) {
  const fail = (message) => {
    throw new Error(`${family} performance contract: ${message}`)
  }
  const listedAssertions = assertionList(report)
  if (listedAssertions.length === 0) fail('missing assertions')
  if (Array.isArray(report.assertionDetails)) {
    const detailNames = report.assertionDetails.map(({ name }) => name)
    const compatibilityNames = Object.keys(report.assertions ?? {})
    if (new Set(detailNames).size !== detailNames.length) fail('duplicate structured assertion')
    if (JSON.stringify([...detailNames].sort()) !== JSON.stringify(compatibilityNames.sort())) {
      fail('structured and compatibility assertion names differ')
    }
    for (const detail of report.assertionDetails) {
      if (detail.pass !== report.assertions[detail.name]) {
        fail(`structured and compatibility assertion results differ: ${detail.name}`)
      }
    }
  }
  if (
    typeof report.passed === 'boolean' &&
    report.passed !== listedAssertions.every(({ pass }) => pass === true)
  ) {
    fail('top-level result contradicts assertions')
  }
  if (['native-lint', 'native-format', 'comparative'].includes(family) &&
      typeof report.passed !== 'boolean') {
    fail('missing top-level result')
  }
  if (['native-lint', 'native-format'].includes(family)) {
    if (!/^[0-9a-f]{40}$/u.test(report.host?.oxcRevision ?? '')) fail('missing OXC revision')
    if (!/^[0-9a-f]{16}$/u.test(report.corpus?.fnv1a64 ?? '')) fail('missing corpus identity')
    if (!Number.isInteger(report.budgets?.schemaVersion)) fail('missing budget identity')
    if (typeof report.budgets?.candidateBinary !== 'string') fail('missing candidate identity')
  }
  if (family === 'native-format') {
    if (!/^[0-9a-f]{16}$/u.test(report.generalizedControlCorpus?.fnv1a64 ?? '')) {
      fail('missing generalized-control corpus identity')
    }
    if (report.budgets?.generalizedControlWarmups < 5) fail('generalized warmups below 5')
    if (report.budgets?.generalizedControlSamples < 15) fail('generalized samples below 15')
    if (report.budgets?.batchWarmups < 5) fail('batch warmups below 5')
    if (report.budgets?.batchSamples < 15) fail('batch samples below 15')
    for (const key of [
      'candidateTsrxScanNs',
      'candidateTsrxProjectionNs',
      'candidateTsrxParseNs',
      'candidateTsrxFormatNs',
      'candidateTsrxLiftNs',
    ]) {
      if (report.rawSamples?.[key]?.length !== report.budgets?.samples) fail(`missing ${key}`)
    }
  }
  if (family === 'type-aware' && report.samplePolicy?.measured < 20) {
    fail('fewer than 20 measured fresh processes')
  }
  if (family === 'vite' && (report.samplePolicy?.warmups < 5 || report.samplePolicy?.measured < 15)) {
    fail('fewer than 5 warmups and 15 samples')
  }
  if (family === 'vite') {
    if (report.schemaVersion !== 2) fail('Vite report predates ordinary npm formatter routing')
    if (report.directOrdinaryFormat?.rawMs?.length !== report.samplePolicy?.measured) {
      fail('ordinary npm formatter raw sample count mismatch')
    }
    if (report.assertions?.directOrdinaryFormatP95 !== true) {
      fail('ordinary npm formatter p95 budget failed')
    }
    if (report.assertions?.directOrdinaryFormatRatio !== true) {
      fail('ordinary npm formatter ratio budget failed')
    }
    if (report.build?.formatLauncher !== 'node_modules/@tsrx/oxc/bin/oxfmt') {
      fail('ordinary formatter lane does not identify the installed npm launcher')
    }
    if (report.invariants?.ordinaryFormatProcessParity !== true ||
        report.invariants?.ordinaryFormatDispatchEvents !== 0) {
      fail('ordinary npm formatter lacks canonical parity or direct-route evidence')
    }
  }
  if (family === 'editor') {
    for (const key of ['editWarmups', 'formatWarmups', 'codeActionWarmups', 'initialOpenWarmups']) {
      if (report.samplePolicy?.[key] < 20) fail(`${key} below 20`)
    }
    for (const key of ['editSamples', 'formatSamples', 'codeActionSamples', 'initialOpenSamples']) {
      if (report.samplePolicy?.[key] < 100) fail(`${key} below 100`)
    }
    if (report.samplePolicy?.editSoak < 1_000) fail('edit soak below 1000')
  }
  if (family === 'comparative') {
    if (report.schemaVersion !== 3) fail('comparative report is not npm-boundary schema 3')
    if (report.samplePolicy?.warmups < 5 || report.samplePolicy?.measured < 20) {
      fail('fewer than 5 warmups and 20 measured runs')
    }
    if (!/^[0-9a-f]{64}$/u.test(report.corpus?.tsxSha256 ?? '')) fail('missing TSX corpus hash')
    if (!/^[0-9a-f]{64}$/u.test(report.corpus?.mixedSha256 ?? '')) fail('missing mixed corpus hash')
    if (!/^[0-9a-f]{64}$/u.test(report.corpus?.pairedSpecificationSha256 ?? '')) {
      fail('missing paired specification hash')
    }
    if (!/^[0-9a-f]{64}$/u.test(report.boundary?.configSha256 ?? '')) fail('missing config hash')
    if (report.boundary?.fileSelection !== 'same explicit file list') fail('unmatched file selection')
    if (report.boundary?.output !== 'zero-diagnostic default output') fail('unmatched output boundary')
    if (report.boundary?.launch !== 'every lane measured through its npm CLI entry point, Node launcher included') {
      fail('comparative report does not measure npm CLI launch boundaries')
    }
    if (!report.boundary?.productRouting?.allTsx?.includes('oxlint-current declared npm binary')) {
      fail('missing ordinary-only declared-bin route identity')
    }
    if (!report.boundary?.productRouting?.mixed?.includes('public oxlint-current declared npm binary')) {
      fail('mixed route does not identify the public canonical subprocess')
    }
    if (report.validation?.routeEvidence?.ordinaryDispatchEvents !== 0) {
      fail('ordinary route entered process dispatch during validation')
    }
    if (report.validation?.routeEvidence?.mixedUsesPublicCanonicalNodeChild !== true ||
        report.validation?.routeEvidence?.mixedUsesNativeTsrxChild !== true ||
        report.validation?.routeEvidence?.mixedUsesPrivateInProcessAdapter !== false) {
      fail('mixed route lacks public-process trace evidence')
    }
    if (report.validation?.routeEvidence?.mixedDispatchEvents !== 2 ||
        report.validation?.routeEvidence?.publicCanonicalNodeChildren !== 1 ||
        report.validation?.routeEvidence?.nativeTsrxChildren !== 1 ||
        report.validation?.routeEvidence?.privateInProcessAdapterChildren !== 0) {
      fail('mixed route does not contain exactly the two public/native children')
    }
    if (JSON.stringify(report.boundary?.executables) !== JSON.stringify({
      eslint: 'node_modules/.bin/eslint',
      oxlint: 'node_modules/oxlint-current/bin/oxlint',
      oxcTsrx: 'node_modules/@tsrx/oxc/bin/oxlint',
      oxcTsrxMixed: 'node_modules/@tsrx/oxc/bin/oxlint',
    })) {
      fail('comparative executable identities drifted')
    }
    for (const lane of ['eslint', 'oxlint', 'oxcTsrx', 'oxcTsrxMixed']) {
      if (!report.boundary?.argumentShape?.[lane]?.includes('--no-ignore')) {
        fail(`${lane} does not share explicit ignore behavior`)
      }
    }
    if (!report.build?.binary?.startsWith('node_modules/@tsrx/oxc/bin/oxlint')) {
      fail('build identity does not name the npm launcher')
    }
    // The npm launcher has reported itself as `@tsrx/oxc <version>` since the
    // package rename; the native binary still says `oxc-tsrx <version>`.
    if (!/^(?:oxc-tsrx|@tsrx\/oxc)\s+\S+/u.test(report.versions?.oxcTsrxLauncher ?? '')) {
      fail('missing oxc-tsrx launcher version')
    }
    if (JSON.stringify(report.boundary?.rules) !== JSON.stringify(['no-debugger'])) {
      fail('unmatched rule boundary')
    }
    for (const lane of ['eslint', 'oxlint', 'oxcTsrx', 'oxcTsrxMixed']) {
      if (report.tools?.[lane]?.rawMs?.length !== report.samplePolicy.measured) {
        fail(`${lane} raw sample count mismatch`)
      }
      if (report.validation?.[lane]?.files !== report.corpus.files) fail(`${lane} file count mismatch`)
      if (report.validation?.[lane]?.diagnostics !== 0) fail(`${lane} diagnostic boundary mismatch`)
    }
  }
  if (['type-aware', 'vite', 'editor'].includes(family)) {
    if (!report.host?.cpu || report.host.cpu === 'recorded-by-host') fail('missing real CPU identity')
    if (!report.host?.osRelease) fail('missing OS release')
    if (report.build?.profile !== 'release') fail('missing release build identity')
    if (!/^[0-9a-f]{40}$/u.test(report.build?.oxcRevision ?? '')) fail('missing OXC revision')
    if (!/^[0-9a-f]{64}$/u.test(report.corpus?.sha256 ?? '')) fail('missing corpus hash')
  }
  if (family === 'comparative') {
    if (!report.host?.cpu || report.host.cpu === 'recorded-by-host') fail('missing real CPU identity')
    if (!report.host?.osRelease) fail('missing OS release')
    if (report.build?.profile !== 'release') fail('missing release build identity')
    if (!/^[0-9a-f]{40}$/u.test(report.build?.oxcRevision ?? '')) fail('missing OXC revision')
  }
}

function corpusIdentity(family, report) {
  if (family === 'native-format') {
    return JSON.stringify({
      corpus: report.corpus,
      generalizedControlCorpus: report.generalizedControlCorpus,
    })
  }
  if (family === 'comparative') {
    return [
      report.corpus?.tsxSha256,
      report.corpus?.mixedSha256,
      report.corpus?.pairedSpecificationSha256,
    ].join(':')
  }
  return JSON.stringify(report.corpus)
}

function adjudicationIdentity(family, report) {
  const oxcRevision = report.host?.oxcRevision ?? report.build?.oxcRevision
  return {
    oxcRevision,
    corpusIdentity: corpusIdentity(family, report),
    budgetsIdentity: JSON.stringify(report.budgets),
    hostIdentity: JSON.stringify(report.host),
    buildIdentity: JSON.stringify(report.build ?? {}),
    versionsIdentity: JSON.stringify(report.versions ?? {}),
    routeIdentity:
      family === 'comparative'
        ? JSON.stringify({
            boundary: report.boundary,
            routeEvidence: report.validation?.routeEvidence,
          })
        : family,
  }
}

function arrayAdjudicationEntry(current, family) {
  const assertions = assertionList(current.report).map((assertion) => {
    const operator =
      family === 'native-format' ? nativeFormatOperators.get(assertion.name) : assertion.operator
    return normalizeAssertion(
      operator ? { ...assertion, operator } : assertion,
      { context: `${family} performance contract` },
    )
  })
  if (assertions.length === 0) {
    throw new Error(`${family} performance contract: missing assertions`)
  }
  return {
    path: current.path,
    assertions,
    reportPassed: assertions.every(({ pass }) => pass === true),
    invariantsPassed: assertions
      .filter(({ invariant }) => invariant)
      .every(({ pass }) => pass === true),
    identity: adjudicationIdentity(family, current.report),
  }
}

async function runArrayAssertionFamilyWithAdjudication({
  family,
  command,
  label,
  allowAssertionFailure = false,
}) {
  const currentReports = []
  currentReports.push(await runFreshReport({
    family,
    command,
    label,
    allowAssertionFailure,
  }))
  const first = arrayAdjudicationEntry(currentReports[0], family)
  const reports = [first]
  const firstDecision = planAdjudication(first, {
    bandFraction: adjudicationBandFraction,
  })

  if (firstDecision.triggered) {
    for (let index = 2; index <= 3; index += 1) {
      const currentReport = await runFreshReport({
        family,
        command,
        label: `${label} confidence rerun ${index}/3`,
        allowAssertionFailure,
      })
      currentReports.push(currentReport)
      reports.push(arrayAdjudicationEntry(currentReport, family))
    }
  }

  const adjudication = adjudicateReports(reports, {
    bandFraction: adjudicationBandFraction,
  })
  selectedReports[family] = currentReports.find(
    ({ path: report }) => report === adjudication.selectedReport,
  )
  adjudications[family] = adjudication

  if (family === 'native-format') {
    const rssDecision = adjudication.assertionDecisions.find(({ name }) => name === 'p07_rss_ratio')
    if (!rssDecision) throw new Error('native-format performance contract: missing p07 RSS assertion')
    rssAdjudication = {
      bandFraction: adjudicationBandFraction,
      relativeMargin: rssDecision.samples[0].relativeMargin,
      triggered: rssDecision.triggered,
      requiredReports: reports.length,
      passCount: rssDecision.passCount,
      failCount: rssDecision.failCount,
      decision: rssDecision.decision,
      reports: rssDecision.samples.map((sample, index) => ({
        path: sample.path,
        ratio: sample.observed,
        threshold: sample.threshold,
        pass: sample.pass,
        oxcRevision: reports[index].identity.oxcRevision,
        corpusIdentity: reports[index].identity.corpusIdentity,
      })),
    }
  }

  if (adjudication.decision === 'failed') {
    throw new Error(`${family} budget failed its frozen two-of-three adjudication policy`)
  }
  for (const evidence of adjudication.reports.filter(({ reportPassed }) => !reportPassed)) {
    const commandReceipt = commands.find(({ reportPath: commandPath }) => commandPath === evidence.path)
    if (commandReceipt) commandReceipt.admittedByAdjudication = true
  }
}

const startedAt = new Date().toISOString()
await mkdir(path.dirname(reportPath), { recursive: true })

try {
  await runArrayAssertionFamilyWithAdjudication({
    family: 'native-lint',
    command: ['npm', 'run', 'benchmark:native-lint'],
    label: 'fresh native lint performance gate',
    allowAssertionFailure: true,
  })
  await runArrayAssertionFamilyWithAdjudication({
    family: 'native-format',
    command: ['npm', 'run', 'benchmark:native-format'],
    label: 'fresh native format performance gate',
    allowAssertionFailure: true,
  })
  selectedReports['type-aware'] = await runFreshReport({
    family: 'type-aware',
    command: ['npm', 'run', 'benchmark:type-aware'],
    label: 'fresh type-aware performance gate',
  })
  selectedReports.vite = await runFreshReport({
    family: 'vite',
    command: [process.execPath, 'benchmarks/vite/run.mjs'],
    label: 'fresh Vite/Vite+ boundary gate',
  })
  selectedReports.editor = await runFreshReport({
    family: 'editor',
    command: ['npm', 'run', 'benchmark:editor'],
    label: 'fresh incremental editor performance gate',
  })
  await runArrayAssertionFamilyWithAdjudication({
    family: 'comparative',
    command: [process.execPath, 'benchmarks/comparative/run.mjs'],
    label: 'fresh like-for-like comparative gate',
  })
} catch (error) {
  failure = error
}

const results = {}
for (const family of families) {
  const current = selectedReports[family]
  if (!current) {
    failure ??= new Error(`${family} did not produce selected fresh evidence`)
    continue
  }
  try {
    requireContract(family, current.report)
  } catch (error) {
    failure ??= error
  }
  const assertions = assertionList(current.report)
  const directAllPassed = assertions.length > 0 && assertions.every(({ pass }) => pass === true)
  const allPassed = adjudications[family]
    ? adjudications[family].decision === 'passed'
    : directAllPassed
  results[family] = {
    path: current.path,
    generatedAtUnixMs:
      current.report.generatedAtUnixMs ??
      (Number.isFinite(Date.parse(current.report.timestamp))
        ? Date.parse(current.report.timestamp)
        : null),
    assertions,
    allPassed,
    budgets: current.report.budgets,
  }
  if (adjudications[family]) results[family].adjudication = adjudications[family]
  if (family === 'native-format') {
    results[family].rssAdjudication = rssAdjudication
  }
  if (!results[family].allPassed) failure ??= new Error(`${family} has a red or empty assertion set`)
}

const report = {
  schemaVersion: 1,
  status: failure ? 'failed' : 'passed',
  startedAt,
  completedAt: new Date().toISOString(),
  commands,
  results,
  failure: failure ? { name: failure.name, message: failure.message } : null,
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

if (failure) {
  console.error(`\n[performance] FAILED: ${failure.message}`)
  process.exit(1)
}
console.log(`\n[performance] PASS: ${reportPath}`)

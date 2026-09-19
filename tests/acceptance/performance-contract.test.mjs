import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { cpus } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..', '..')
const publicFamilies = ['comparative', 'editor', 'native-format', 'native-lint', 'type-aware', 'vite']
const frozenBudgetHashes = {
  comparative: 'd3ca368e0dba5d10090c70f58130af78ad574496a28389c7804ac82d0d5b05e3',
  editor: '1fe5c78f1ac1543ca9a169c721d463ba6bc119631f678b896e572334d29592cd',
  // Re-frozen 2026-09-19 with the formatter's settling pass (tsrx-org/oxc#93):
  // a file the formatter changes is formatted a second time, and the benchmark
  // corpora are unformatted, so the P04 direct ratios moved 1.05/1.08 -> 2.25/2.3
  // and the generalized-control floors 15/12 -> 7/6 MiB/s. The 2026-09-18
  // re-baseline (P07 RSS ceiling 1.15 -> 1.30 with the OXC crates v0.150.0
  // upgrade) is carried forward (docs/releasing/upgrades.md, "Re-baselined ratios").
  'native-format': 'bef419af00245ecddbf52ca700bd5dd80c2e985420f18493e227da6d17de3219',
  'native-lint': '5a54761ef797aca67fd900068add0c35656ed37b341da59f99c7f1d3815e44fc',
  'type-aware': '799a15d0a986744f7e1d80688c35bc631697c32a926cde55595a7fbb591d0db4',
  // Re-frozen 2026-09-19 with the settling pass: the mixed format p95 ratio
  // ceiling moved 2 -> 2.25 (observed 1.955 before, 2.05-2.11 after; the mixed lane
  // formats an unformatted .tsrx file, which now takes two passes).
  vite: '8628bb6c7647d8f8472d317c12cb7b3f3690a6a63fe1a87ddf3ed6026cecb341',
}

async function latest(family) {
  const directory = path.join(root, 'benchmarks', family)
  const name = (await readdir(directory))
    .filter((candidate) => /^results-\d+\.json$/u.test(candidate))
    .sort()
    .at(-1)
  assert.ok(name, `missing ${family} report`)
  return JSON.parse(await readFile(path.join(directory, name), 'utf8'))
}

function completeHost(report, family) {
  assert.equal(typeof report.host?.cpu, 'string', `${family}: cpu`)
  assert.notEqual(report.host.cpu, 'recorded-by-host', `${family}: placeholder cpu`)
  assert.ok(report.host.cpu.length >= 3, `${family}: empty cpu`)
  assert.equal(typeof report.host?.osRelease, 'string', `${family}: osRelease`)
  assert.ok(report.host.osRelease.length >= 1, `${family}: empty osRelease`)
  assert.equal(report.host.arch, process.arch, `${family}: architecture`)
  assert.equal(report.host.platform, process.platform, `${family}: platform`)
  assert.ok(cpus().some((cpu) => cpu.model === report.host.cpu), `${family}: actual host cpu`)
}

function completeNativeIdentity(report, family) {
  assert.equal(report.build?.profile, 'release', `${family}: release profile`)
  assert.match(report.build?.oxcRevision ?? '', /^[0-9a-f]{40}$/u, `${family}: OXC revision`)
  assert.match(report.corpus?.sha256 ?? '', /^[0-9a-f]{64}$/u, `${family}: corpus hash`)
  assert.ok(report.corpus?.bytes > 0, `${family}: corpus bytes`)
}

function generatedAtUnixMs(report) {
  if (Number.isFinite(report.generatedAtUnixMs)) return report.generatedAtUnixMs
  const parsed = Date.parse(report.timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

function budgetPressure(sample) {
  if (sample.operator === '<=') return sample.observed / sample.threshold
  if (sample.operator === '>=') return sample.threshold / sample.observed
  throw new Error(`unsupported performance comparison: ${sample.operator}`)
}

function adjudicationIdentity(family, report) {
  const corpusIdentity =
    family === 'native-format'
      ? JSON.stringify({
          corpus: report.corpus,
          generalizedControlCorpus: report.generalizedControlCorpus,
        })
      : family === 'comparative'
        ? [
            report.corpus?.tsxSha256,
            report.corpus?.mixedSha256,
            report.corpus?.pairedSpecificationSha256,
          ].join(':')
        : JSON.stringify(report.corpus)
  return {
    oxcRevision: report.host?.oxcRevision ?? report.build?.oxcRevision,
    corpusIdentity,
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

function assertComparativeRoute(report, label) {
  assert.equal(report.schemaVersion, 3, `${label}: schema`)
  assert.deepEqual(report.boundary.executables, {
    eslint: 'node_modules/.bin/eslint',
    oxlint: 'node_modules/oxlint-current/bin/oxlint',
    oxcTsrx: 'node_modules/@tsrx/oxc/bin/oxlint',
    oxcTsrxMixed: 'node_modules/@tsrx/oxc/bin/oxlint',
  }, `${label}: executables`)
  for (const lane of ['eslint', 'oxlint', 'oxcTsrx', 'oxcTsrxMixed']) {
    assert.match(report.boundary.argumentShape[lane], /--no-ignore/u, `${label}: ${lane} args`)
    assert.equal(report.tools[lane].rawMs.length, report.samplePolicy.measured, `${label}: ${lane} samples`)
    assert.equal(report.validation[lane].files, report.corpus.files, `${label}: ${lane} files`)
    assert.equal(report.validation[lane].diagnostics, 0, `${label}: ${lane} diagnostics`)
  }
  assert.equal(report.validation.routeEvidence.ordinaryDispatchEvents, 0, `${label}: ordinary route`)
  assert.equal(report.validation.routeEvidence.mixedDispatchEvents, 2, `${label}: mixed children`)
  assert.equal(report.validation.routeEvidence.publicCanonicalNodeChildren, 1, `${label}: canonical child`)
  assert.equal(report.validation.routeEvidence.nativeTsrxChildren, 1, `${label}: native child`)
  assert.equal(report.validation.routeEvidence.privateInProcessAdapterChildren, 0, `${label}: private children`)
  assert.equal(report.validation.routeEvidence.mixedUsesPublicCanonicalNodeChild, true, `${label}: public route`)
  assert.equal(report.validation.routeEvidence.mixedUsesNativeTsrxChild, true, `${label}: TSRX route`)
  assert.equal(report.validation.routeEvidence.mixedUsesPrivateInProcessAdapter, false, `${label}: private route`)

  const detailResults = Object.fromEntries(
    report.assertionDetails.map(({ name, pass }) => [name, pass]),
  )
  assert.deepEqual(detailResults, report.assertions, `${label}: assertion representations`)
  assert.equal(report.passed, Object.values(report.assertions).every(Boolean), `${label}: top-level result`)
}

test('fresh performance evidence satisfies the frozen confidence and identity policy', async () => {
  const [format, typeAware, vite, editor] = await Promise.all([
    latest('native-format'),
    latest('type-aware'),
    latest('vite'),
    latest('editor'),
  ])

  assert.ok(format.budgets.generalizedControlWarmups >= 5)
  assert.ok(format.budgets.generalizedControlSamples >= 15)
  assert.ok(format.budgets.batchWarmups >= 5)
  assert.ok(format.budgets.batchSamples >= 15)
  assert.ok(format.budgets.coldProcessSamples >= 20)
  assert.ok(format.budgets.rssProcessSamples >= 5)
  for (const key of [
    'candidateTsrxScanNs',
    'candidateTsrxProjectionNs',
    'candidateTsrxParseNs',
    'candidateTsrxFormatNs',
    'candidateTsrxLiftNs',
  ]) {
    assert.equal(format.rawSamples?.[key]?.length, format.budgets.samples, key)
  }
  assert.equal('prettierSpeedup' in (format.p04 ?? {}), false)
  assert.equal(
    format.assertions.some((entry) => /prettier.*speedup/iu.test(entry.name)),
    false,
  )

  assert.ok(typeAware.samplePolicy?.warmupsAfterCold >= 5)
  assert.ok(typeAware.samplePolicy?.measured >= 20)
  completeHost(typeAware, 'type-aware')
  completeNativeIdentity(typeAware, 'type-aware')

  assert.ok(vite.samplePolicy?.warmups >= 5)
  assert.ok(vite.samplePolicy?.measured >= 15)
  completeHost(vite, 'vite')
  completeNativeIdentity(vite, 'vite')

  for (const field of ['editWarmups', 'formatWarmups', 'codeActionWarmups', 'initialOpenWarmups']) {
    assert.ok(editor.samplePolicy?.[field] >= 20, `editor: ${field}`)
  }
  for (const field of ['editSamples', 'formatSamples', 'codeActionSamples', 'initialOpenSamples']) {
    assert.ok(editor.samplePolicy?.[field] >= 100, `editor: ${field}`)
  }
  assert.ok(editor.samplePolicy?.editSoak >= 1_000)
  assert.equal(editor.initialOpen?.rawMs?.length, editor.samplePolicy.initialOpenSamples)
  const retainedEditorSource = await readFile(
    path.join(root, 'tests', 'fixtures', 'editor', 'markless-arm-try-events.tsrx'),
    'utf8',
  )
  const measuredEditorSource = retainedEditorSource
    .replace(
      'export function App() @{',
      'export function App() @{\nvar editorProbe=0;\nvoid editorProbe;\ndebugger;',
    )
    .replace("let saved = state('none');", "let saved=state('none');")
  assert.equal(
    editor.corpus.sha256,
    createHash('sha256').update(measuredEditorSource).digest('hex'),
    'editor: exact measured source hash',
  )
  assert.equal(
    editor.corpus.retainedFixtureSha256,
    createHash('sha256').update(retainedEditorSource).digest('hex'),
    'editor: retained fixture hash',
  )
  completeHost(editor, 'editor')
  completeNativeIdentity(editor, 'editor')
})

test('aggregate performance evidence is fresh, coherent, and selected without favorable sampling', async () => {
  const report = JSON.parse(
    await readFile(path.join(root, 'docs', 'acceptance', 'performance-report.json'), 'utf8'),
  )
  const startedAt = Date.parse(report.startedAt)
  const completedAt = Date.parse(report.completedAt)
  assert.ok(Number.isFinite(startedAt), 'aggregate startedAt')
  assert.ok(Number.isFinite(completedAt), 'aggregate completedAt')
  assert.ok(completedAt >= startedAt, 'aggregate interval')

  for (const [family, result] of Object.entries(report.results)) {
    assert.ok(Number.isFinite(result.generatedAtUnixMs), `${family}: generatedAtUnixMs`)
    assert.ok(result.generatedAtUnixMs >= startedAt, `${family}: generated before aggregate start`)
    assert.ok(result.generatedAtUnixMs <= completedAt, `${family}: generated after aggregate completion`)
  }

  for (const family of ['native-lint', 'native-format', 'comparative']) {
    const result = report.results[family]
    const adjudication = result.adjudication
    assert.equal(adjudication.bandFraction, 0.03, `${family}: confidence band`)
    assert.equal(adjudication.requiredReports, adjudication.triggered ? 3 : 1, `${family}: report count policy`)
    assert.equal(adjudication.reports.length, adjudication.requiredReports, `${family}: reports`)
    assert.equal(new Set(adjudication.reports.map(({ path: reportPath }) => reportPath)).size, adjudication.requiredReports, `${family}: distinct reports`)
    assert.equal(adjudication.decision, 'passed', `${family}: decision`)
    assert.equal(result.path, adjudication.selectedReport, `${family}: selected report`)
    assert.equal(adjudication.selectionPolicy.kind, 'median-normalized-budget-pressure')
    assert.equal(
      adjudication.selectionPolicy.aggregation,
      'maximum-pressure-across-triggering-assertions',
    )
    assert.equal(adjudication.selectionPolicy.ordering, 'ascending-pressure')
    assert.equal(adjudication.selectionPolicy.tieBreak, 'report-path-ascending')
    assert.equal(
      adjudication.selectionPolicy.selectedIndex,
      Math.floor(adjudication.requiredReports / 2),
      `${family}: median index`,
    )
    assert.deepEqual(
      adjudication.selectionPolicy.assertions,
      adjudication.triggeredBy,
      `${family}: pressure assertions`,
    )

    const [firstIdentity, ...otherIdentities] = adjudication.reports
    for (const key of [
      'oxcRevision',
      'corpusIdentity',
      'budgetsIdentity',
      'hostIdentity',
      'buildIdentity',
      'versionsIdentity',
      'routeIdentity',
    ]) {
      assert.ok(firstIdentity[key], `${family}: missing ${key}`)
      assert.ok(
        otherIdentities.every((entry) => entry[key] === firstIdentity[key]),
        `${family}: incoherent ${key}`,
      )
    }

    for (const decision of adjudication.assertionDecisions) {
      assert.equal(decision.decision, 'passed', `${family}: ${decision.name}`)
      assert.equal(
        decision.passCount + decision.failCount,
        adjudication.requiredReports,
        `${family}: ${decision.name} sample count`,
      )
      assert.deepEqual(
        new Set(decision.samples.map(({ path: reportPath }) => reportPath)),
        new Set(adjudication.reports.map(({ path: reportPath }) => reportPath)),
        `${family}: ${decision.name} paths`,
      )
      if (decision.triggered) {
        assert.ok(decision.passCount >= 2, `${family}: ${decision.name} two-of-three`)
        assert.equal(decision.definitiveFailure, false, `${family}: ${decision.name} definitive failure`)
      } else {
        assert.equal(decision.failCount, 0, `${family}: ${decision.name} received unearned tolerance`)
      }
    }

    const pressures = new Map(
      adjudication.reports.map(({ path: reportPath }) => {
        const triggeredSamples = adjudication.assertionDecisions
          .filter(({ triggered: assertionTriggered }) => assertionTriggered)
          .map(({ samples }) => samples.find((sample) => sample.path === reportPath))
        return [
          reportPath,
          triggeredSamples.length === 0
            ? 0
            : Math.max(...triggeredSamples.map((sample) => budgetPressure(sample))),
        ]
      }),
    )
    const expectedOrder = [...pressures]
      .map(([reportPath, pressure]) => ({ path: reportPath, budgetPressure: pressure }))
      .sort(
        (left, right) =>
          left.budgetPressure - right.budgetPressure || left.path.localeCompare(right.path),
      )
    assert.deepEqual(adjudication.selectionPolicy.orderedReports, expectedOrder, `${family}: pressure order`)
    assert.equal(
      adjudication.selectedReport,
      expectedOrder[Math.floor(expectedOrder.length / 2)].path,
      `${family}: unbiased representative`,
    )
    assert.ok(
      expectedOrder.every(({ budgetPressure: pressure }) =>
        Number.isFinite(pressure) && pressure >= 0),
      `${family}: finite pressures`,
    )
    assert.equal(
      adjudication.reports.find(({ path: reportPath }) => reportPath === result.path).reportPassed,
      true,
      `${family}: red median representative`,
    )

    const frozenBudgets = JSON.parse(
      await readFile(path.join(root, 'benchmarks', family, 'budgets.json'), 'utf8'),
    )
    for (const evidence of adjudication.reports) {
      const raw = JSON.parse(await readFile(path.join(root, evidence.path), 'utf8'))
      const generatedAt = generatedAtUnixMs(raw)
      const filenameTimestamp = Number(evidence.path.match(/results-(\d+)\.json$/u)?.[1])
      assert.ok(generatedAt >= startedAt, `${evidence.path}: predates aggregate`)
      assert.ok(generatedAt <= completedAt, `${evidence.path}: postdates aggregate`)
      assert.ok(Math.abs(filenameTimestamp - generatedAt) <= 1_000, `${evidence.path}: timestamped filename`)
      assert.deepEqual(raw.budgets, frozenBudgets, `${evidence.path}: frozen budgets`)
      assert.equal(raw.passed, evidence.reportPassed, `${evidence.path}: raw result`)
      const identity = adjudicationIdentity(family, raw)
      for (const [key, value] of Object.entries(identity)) {
        assert.equal(evidence[key], value, `${evidence.path}: ${key}`)
      }
      if (family === 'comparative') assertComparativeRoute(raw, evidence.path)

      const receipts = report.commands.filter(({ reportPath }) => reportPath === evidence.path)
      assert.equal(receipts.length, 1, `${evidence.path}: command receipt`)
      const [receipt] = receipts
      assert.equal(receipt.signal, null, `${evidence.path}: command signal`)
      assert.ok([0, 1].includes(receipt.status), `${evidence.path}: command status`)
      assert.ok(receipt.startedAtUnixMs >= startedAt, `${evidence.path}: command predates aggregate`)
      assert.ok(receipt.completedAtUnixMs <= completedAt, `${evidence.path}: command postdates aggregate`)
      assert.ok(receipt.startedAtUnixMs <= generatedAt, `${evidence.path}: report predates command`)
      assert.ok(receipt.completedAtUnixMs >= generatedAt, `${evidence.path}: report postdates command`)
      assert.ok(receipt.completedAtUnixMs >= receipt.startedAtUnixMs, `${evidence.path}: command interval`)
      if (family === 'comparative') assert.equal(receipt.status, 0, `${evidence.path}: non-assert runner`)
      if (receipt.status === 1) {
        assert.equal(evidence.reportPassed, false, `${evidence.path}: assertion exit without red report`)
        assert.equal(receipt.admittedByAdjudication, true, `${evidence.path}: unmarked assertion exit`)
      }
    }
  }

  const formatAdjudication = report.results['native-format'].adjudication
  const rssAdjudication = report.results['native-format'].rssAdjudication
  const rssDecision = formatAdjudication.assertionDecisions.find(({ name }) => name === 'p07_rss_ratio')
  assert.ok(rssDecision, 'native-format: p07 RSS decision')
  assert.equal(rssAdjudication.bandFraction, 0.03)
  assert.equal(rssAdjudication.triggered, rssDecision.triggered)
  assert.equal(rssAdjudication.requiredReports, formatAdjudication.requiredReports)
  assert.equal(rssAdjudication.reports.length, rssAdjudication.requiredReports)
  assert.equal(rssAdjudication.decision, rssDecision.decision)
  assert.equal(rssAdjudication.passCount, rssDecision.passCount)
  assert.equal(rssAdjudication.failCount, rssDecision.failCount)
  const [firstRss, ...otherRss] = rssAdjudication.reports
  assert.ok(otherRss.every((entry) => entry.threshold === firstRss.threshold))
  assert.ok(otherRss.every((entry) => entry.oxcRevision === firstRss.oxcRevision))
  assert.ok(otherRss.every((entry) => entry.corpusIdentity === firstRss.corpusIdentity))

  const comparativeAdjudication = report.results.comparative.adjudication
  const mixedDecision = comparativeAdjudication.assertionDecisions.find(
    ({ name }) => name === 'mixedNoBlowup',
  )
  assert.ok(mixedDecision, 'comparative mixed ratio lacks an adjudicated decision')
  assert.equal(comparativeAdjudication.triggered, comparativeAdjudication.triggeredBy.length > 0)
  assert.ok(
    mixedDecision.samples.every(
      (entry) =>
        Number.isFinite(entry.observed) &&
        entry.threshold === 1.5 &&
        entry.operator === '<=' &&
        typeof entry.pass === 'boolean',
    ),
  )
})

test('every public performance lane is reproducible, structured, and budget-frozen', async () => {
  const aggregate = JSON.parse(
    await readFile(path.join(root, 'docs', 'acceptance', 'performance-report.json'), 'utf8'),
  )
  assert.equal(aggregate.status, 'passed')
  assert.equal(aggregate.failure, null)
  assert.deepEqual(Object.keys(aggregate.results).sort(), publicFamilies)
  const expectedReportPaths = new Set()
  const adjudicatedReports = new Map()
  for (const result of Object.values(aggregate.results)) {
    if (result.adjudication) {
      for (const evidence of result.adjudication.reports) {
        expectedReportPaths.add(evidence.path)
        adjudicatedReports.set(evidence.path, evidence)
      }
    } else {
      expectedReportPaths.add(result.path)
    }
  }
  assert.equal(aggregate.commands.length, expectedReportPaths.size)
  assert.ok(
    aggregate.commands.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.label === 'string' &&
        typeof entry.command === 'string' &&
        Number.isInteger(entry.status) &&
        [0, 1].includes(entry.status) &&
        entry.signal === null &&
        expectedReportPaths.has(entry.reportPath) &&
        /^benchmarks\/(?:native-lint|native-format|type-aware|vite|editor|comparative)\/results-\d+\.json$/u.test(entry.reportPath) &&
        Number.isFinite(entry.startedAtUnixMs) &&
        Number.isFinite(entry.completedAtUnixMs) &&
        entry.completedAtUnixMs >= entry.startedAtUnixMs &&
        Number.isFinite(entry.durationMs),
    ),
  )
  assert.equal(new Set(aggregate.commands.map(({ reportPath }) => reportPath)).size, expectedReportPaths.size)
  for (const command of aggregate.commands) {
    const raw = JSON.parse(await readFile(path.join(root, command.reportPath), 'utf8'))
    const generatedAt = generatedAtUnixMs(raw)
    assert.ok(command.startedAtUnixMs <= generatedAt, `${command.reportPath}: persisted start`)
    assert.ok(command.completedAtUnixMs >= generatedAt, `${command.reportPath}: persisted completion`)
    const evidence = adjudicatedReports.get(command.reportPath)
    if (command.status === 1) {
      assert.ok(evidence, `${command.reportPath}: failed command was not adjudicated`)
      assert.equal(evidence.reportPassed, false, `${command.reportPath}: unexplained command failure`)
    }
    if (evidence?.reportPassed === false) {
      assert.equal(command.admittedByAdjudication, true, `${command.reportPath}: red report admission`)
    }
  }

  for (const family of publicFamilies) {
    const budgetPath = path.join(root, 'benchmarks', family, 'budgets.json')
    const budgetBytes = await readFile(budgetPath)
    assert.equal(
      createHash('sha256').update(budgetBytes).digest('hex'),
      frozenBudgetHashes[family],
      `${family}: frozen budget snapshot`,
    )
    const selected = aggregate.results[family]
    assert.match(selected.path, new RegExp(`^benchmarks/${family}/results-\\d+\\.json$`))
    assert.equal(selected.allPassed, true, `${family}: aggregate pass`)
    const raw = JSON.parse(await readFile(path.join(root, selected.path), 'utf8'))
    assert.deepEqual(selected.budgets, raw.budgets, `${family}: selected budgets`)
    assert.equal(
      selected.generatedAtUnixMs,
      generatedAtUnixMs(raw),
      `${family}: selected generation time`,
    )
    assert.equal(
      aggregate.commands.filter(({ reportPath }) => reportPath === selected.path).length,
      1,
      `${family}: selected command receipt`,
    )
    if (!selected.adjudication) {
      assert.equal(
        aggregate.commands.find(({ reportPath }) => reportPath === selected.path).status,
        0,
        `${family}: direct command status`,
      )
    }
  }

  const comparativeResult = aggregate.results.comparative
  const comparative = JSON.parse(await readFile(path.join(root, comparativeResult.path), 'utf8'))
  assertComparativeRoute(comparative, 'comparative selected')
  assert.equal(comparative.schemaVersion, 3)
  assert.deepEqual(
    comparative.assertionDetails.map(({ name, comparison }) => ({ name, comparison })),
    [
      { name: 'nearOxlintParity', comparison: '<=' },
      { name: 'fasterThanEslint', comparison: '>=' },
      { name: 'mixedNoBlowup', comparison: '<=' },
    ],
  )
  assert.ok(
    comparative.assertionDetails.every(
      ({ observed, threshold, pass }) =>
        Number.isFinite(observed) && Number.isFinite(threshold) && typeof pass === 'boolean',
    ),
  )
  assert.ok(comparative.samplePolicy.warmups >= 5)
  assert.ok(comparative.samplePolicy.measured >= 20)
  assert.match(comparative.corpus.tsxSha256, /^[0-9a-f]{64}$/u)
  assert.match(comparative.corpus.mixedSha256, /^[0-9a-f]{64}$/u)
  assert.match(comparative.corpus.pairedSpecificationSha256, /^[0-9a-f]{64}$/u)
  assert.match(comparative.boundary.configSha256, /^[0-9a-f]{64}$/u)
  assert.equal(comparative.boundary.fileSelection, 'same explicit file list')
  assert.equal(comparative.boundary.output, 'zero-diagnostic default output')
  assert.equal(
    comparative.boundary.launch,
    'every lane measured through its npm CLI entry point, Node launcher included',
  )
  assert.match(comparative.boundary.productRouting.allTsx, /oxlint-current declared npm binary/u)
  assert.match(comparative.boundary.productRouting.mixed, /public oxlint-current declared npm binary/u)
  assert.match(comparative.boundary.argumentShape.oxlint, /--no-ignore/u)
  assert.match(comparative.boundary.argumentShape.oxcTsrx, /--no-ignore/u)
  assert.equal(comparative.validation.routeEvidence.ordinaryDispatchEvents, 0)
  assert.equal(comparative.validation.routeEvidence.mixedUsesPublicCanonicalNodeChild, true)
  assert.equal(comparative.validation.routeEvidence.mixedUsesNativeTsrxChild, true)
  assert.equal(comparative.validation.routeEvidence.mixedUsesPrivateInProcessAdapter, false)
  assert.equal(comparative.boundary.executables.oxcTsrx, 'node_modules/@tsrx/oxc/bin/oxlint')
  assert.deepEqual(comparative.boundary.rules, ['no-debugger'])
  assert.equal(comparative.build.profile, 'release')
  assert.match(comparative.build.binary, /^node_modules\/@tsrx\/oxc\/bin\/oxlint/u)
  assert.match(comparative.build.oxcRevision, /^[0-9a-f]{40}$/u)
  // The npm launcher reports itself as `@tsrx/oxc <version>` since the package rename.
  assert.match(comparative.versions.oxcTsrxLauncher, /^(?:oxc-tsrx|@tsrx\/oxc)\s+\S+/u)
  for (const lane of ['eslint', 'oxlint', 'oxcTsrx', 'oxcTsrxMixed']) {
    assert.equal(comparative.tools[lane].rawMs.length, comparative.samplePolicy.measured, lane)
    assert.equal(comparative.validation[lane].files, comparative.corpus.files, `${lane}: files`)
    assert.equal(comparative.validation[lane].diagnostics, 0, `${lane}: diagnostics`)
  }

  const viteResult = aggregate.results.vite
  const vite = JSON.parse(await readFile(path.join(root, viteResult.path), 'utf8'))
  assert.equal(vite.schemaVersion, 2)
  assert.equal(vite.directOrdinaryFormat.rawMs.length, vite.samplePolicy.measured)
  assert.equal(vite.assertions.directOrdinaryFormatP95, true)
  assert.equal(vite.assertions.directOrdinaryFormatRatio, true)
  assert.ok(vite.ratios.directOrdinaryFormatVsCanonicalP95 <= 1.25)
  assert.equal(vite.build.formatLauncher, 'node_modules/@tsrx/oxc/bin/oxfmt')
  assert.equal(vite.invariants.ordinaryFormatProcessParity, true)
  assert.equal(vite.invariants.ordinaryFormatDispatchEvents, 0)
})

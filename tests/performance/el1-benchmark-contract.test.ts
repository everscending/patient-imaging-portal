import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

// JOR-249. The mandatory adversarial checks for the EL-1 before-and-after
// benchmark. Each one states its rule as a predicate, shows the committed
// artefacts satisfying it, and then shows the rule rejecting a tampered copy —
// a rule nothing can fail is not evidence of anything.
//
// Follows tests/performance/performance-contract.test.ts's scraping patterns.

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const files = {
  benchmark: 'docs/el1-benchmark.md',
  baseline: 'docs/performance-baseline.md',
  imaging: 'k6/imaging.js',
  regression: 'e2e/el1-regression.spec.ts',
  viewer: 'components/imaging/CineViewer.tsx',
} as const

function source(file: keyof typeof files): string {
  return readFileSync(path.join(REPO_ROOT, files[file]), 'utf8')
}

// A shared condition is stated once, in the conditions table, and applies to
// both columns. Reading them back out is how "same conditions" is checked.
function condition(document: string, name: string): string | undefined {
  return new RegExp(`^\\| ${name} \\| (.+) \\|$`, 'mi').exec(document)?.[1]?.trim()
}

const AFTER_ROW = /^\| (PF-[1-3])[^|]*\| p95 < ([\d.]+) s \| ([\d.]+) ms p95 \| ([\d.]+) ms p95 \| ([\d.]+) ms p95 \| (met|missed|unstable) \|$/gm

type ResultRow = {
  requirement: string
  targetMs: number
  before: number
  after: number[]
  verdict: string
}

function resultRows(document: string): ResultRow[] {
  return [...document.matchAll(AFTER_ROW)].map(([, requirement, target, before, firstRun, secondRun, verdict]) => ({
    requirement: requirement!,
    targetMs: Number(target) * 1_000,
    before: Number(before),
    after: [Number(firstRun), Number(secondRun)],
    verdict: verdict!,
  }))
}

// The verdict a row claims, derived from the numbers on that row rather than
// asserted by whoever wrote it.
function verdictFor(row: ResultRow): string {
  if (row.after.every((value) => value < row.targetMs)) return 'met'
  if (row.after.every((value) => value >= row.targetMs)) return 'missed'
  return 'unstable'
}

// The before column as the baseline itself states it, scraped rather than
// copied, so this test cannot drift from the file it claims to read.
function baselineBefore(baseline: string): Map<string, number> {
  return new Map(
    [...baseline.matchAll(/^\| (PF-[1-3])[^|]*\|[^|]*\|[^|]*\| ([\d.]+) ms p95/gm)]
      .map(([, requirement, milliseconds]) => [requirement!, Number(milliseconds)] as const),
  )
}

describe('JOR-249 EL-1 benchmark contract', () => {
  test('afterAtDifferentConditionsIsRejected', () => {
    const benchmark = source('benchmark')
    const baseline = source('baseline')

    // The rule: every condition the two columns share must be stated once and
    // must equal what the baseline recorded for the before run. An after run
    // at a different ramp, dataset or host is not a comparison.
    const sharedConditions = (document: string): boolean =>
      ['VU ramp', 'Dataset'].every((name) => condition(document, name) === condition(baseline, name))
        && (condition(document, 'Host') ?? '').includes('Vercel pdx1')
        && (condition(document, 'Duration') ?? '').startsWith('60 s')
        && resultRows(document).length === 3

    expect(sharedConditions(benchmark), 'the committed benchmark states the baseline conditions').toBe(true)

    for (const tampered of [
      benchmark.replace(/^\| VU ramp \| .+$/m, '| VU ramp | 10 s to 20 VUs, 40 s to 200 VUs, 10 s down to 0 |'),
      benchmark.replace(/^\| Duration \| .+$/m, '| Duration | 15 s |'),
      benchmark.replace(/^\| Host \| .+$/m, '| Host | a local production build on a laptop |'),
      benchmark.replace(/^\| Dataset \| .+$/m, '| Dataset | one study, one clip, ten frames |'),
    ]) {
      expect(sharedConditions(tampered), 'an after run at other conditions must be rejected').toBe(false)
    }
  })

  test('benchmarkWithoutBeforeColumnIsRejected', () => {
    const benchmark = source('benchmark')

    // The rule: a before-and-after document needs both columns. Three rows,
    // each carrying a before number and an after number.
    const hasBothColumns = (document: string): boolean => {
      const rows = resultRows(document)
      return /^\| Requirement \| Target \| Before \| After run 1 \| After run 2 \| Verdict \|$/m.test(document)
        && rows.length === 3
        && rows.every((row) => Number.isFinite(row.before) && row.after.every(Number.isFinite))
    }

    expect(hasBothColumns(benchmark), 'the committed benchmark carries both columns').toBe(true)

    const beforeStripped = benchmark
      .replace(
        /^\| Requirement \| Target \| Before \| After run 1 \| After run 2 \| Verdict \|$/m,
        '| Requirement | Target | After run 1 | After run 2 | Verdict |',
      )
      .replace(/^(\| PF-[1-3][^|]*\| p95 < [\d.]+ s )\| [\d.]+ ms p95 /gm, '$1')
    expect(hasBothColumns(beforeStripped), 'an after-only document must be rejected').toBe(false)
  })

  test('techniqueClaimNotImplementedIsRejected', () => {
    const benchmark = source('benchmark')

    // The rule: every module a technique names must exist, and the read-ahead
    // bound the prose states must be the bound the viewer applies. A technique
    // note is a claim about this build, not a wish list.
    const techniqueRows = (document: string): string[] =>
      [...document.matchAll(/^\| [^|]+ \| ((?:`[^`]+`(?:, )?)+) \| [^|]+ \|$/gm)].map(([, modules]) => modules!)
    const namedModules = (document: string): string[] =>
      techniqueRows(document).flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map(([, module]) => module!))
    const implementedWindow = Number(/export const CINE_FRAME_WINDOW = (\d+)/.exec(source('viewer'))![1])

    const techniquesAreImplemented = (document: string): boolean =>
      namedModules(document).length >= 4
        && namedModules(document).every((module) => existsSync(path.join(REPO_ROOT, module)))
        && new RegExp(`\\(${implementedWindow}\\)`).test(document)

    expect(techniquesAreImplemented(benchmark), 'every named module exists and the stated window matches the code').toBe(true)
    // Each technique's mechanism is actually present in the module it names.
    expect(source('benchmark')).toMatch(/`components\/imaging\/ImageViewer\.tsx`/)
    for (const [module, mechanism] of [
      ['components/imaging/ImageViewer.tsx', /data-testid="image-thumbnail"/],
      ['components/imaging/ImageViewer.tsx', /fetchPriority/],
      ['components/imaging/CineViewer.tsx', /CINE_FRAME_WINDOW/],
      ['components/imaging/CineViewer.tsx', /frameCache/],
    ] as const) {
      expect(readFileSync(path.join(REPO_ROOT, module), 'utf8'), module).toMatch(mechanism)
    }

    for (const tampered of [
      `${benchmark}\n| Predictive frame decoding | \`components/imaging/FramePredictor.tsx\` | Decodes frames before they are requested. |\n`,
      benchmark.replace(`(${implementedWindow})`, `(${implementedWindow * 2})`),
    ]) {
      expect(techniquesAreImplemented(tampered), 'a technique the build does not implement must be rejected').toBe(false)
    }
  })

  test('p1RegressionAcceptedForSpeedIsRejected', () => {
    const benchmark = source('benchmark')
    const loom = readFileSync(path.join(REPO_ROOT, '.loom.yml'), 'utf8')
    const ui = execFileSync(path.join(REPO_ROOT, 'scripts/gate.sh'), ['ui', '--list'], { encoding: 'utf8' })

    // The rule: the regression re-run is wired as gate evidence, and no prose
    // may trade a Priority-1 regression for a speed result.
    const validator = 'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/el1-regression.spec.ts'
    const regressionIsAGate = (document: string): boolean =>
      loom.includes(validator)
        && ui.includes(validator)
        && /A regression in any of them is a gate failure, not a note/.test(document)
        && !/regressi\w*[^.]{0,120}\b(accepted|acceptable|waived|tolerated)\b/i.test(document)
        && !/\b(accept|accepted|waive|waived|tolerate)\b[^.]{0,120}regressi/i.test(document)

    expect(regressionIsAGate(benchmark), 'the regression re-run is wired as a gate and never traded away').toBe(true)

    for (const tampered of [
      `${benchmark}\nPF-1 now meets its target, so the FR-6 regression is accepted for this release.\n`,
      `${benchmark}\nWe waive the EC-5 regression given the speed win.\n`,
      benchmark.replace('A regression in any of them is a gate failure, not a note', 'A regression in any of them is noted here'),
    ]) {
      expect(regressionIsAGate(tampered), 'a Priority-1 regression traded for speed must be rejected').toBe(false)
    }
  })

  test('happyPathOnlyRegressionSpecIsRejected', () => {
    const regression = source('regression')

    // The rule: a regression re-run that only walks the happy path proves
    // nothing about the criteria that are about refusal. Each of these is a
    // denial, a lockout, or an absence the spec must still assert.
    const requiredDenials = [
      /toBe\(404\)/,
      /not\.toBe\(403\)/,
      /toEqual\(\[400, 400, 400, 400\]\)/,
      /toBeDisabled\(\)/,
      /toHaveCount\(0\)/,
      /not\.toContain\(/,
    ]
    const provesRefusal = (spec: string): boolean => requiredDenials.every((pattern) => pattern.test(spec))

    expect(provesRefusal(regression), 'the committed regression spec asserts refusal, not only success').toBe(true)

    for (const pattern of requiredDenials) {
      const tampered = regression.replace(new RegExp(pattern.source, 'g'), 'toBeTruthy()')
      expect(provesRefusal(tampered), `a spec missing ${pattern.source} must be rejected`).toBe(false)
    }
  })

  test('ec2OmittedIsRejected', () => {
    const regression = source('regression')

    // The rule: EC-2 is not optional. The gap must be driven by the manifest's
    // own `available: false`, not inferred from a fetch that failed or is slow,
    // and playback must continue past it.
    const coversEc2 = (spec: string): boolean =>
      /regression EC-2:/.test(spec)
        && /cine-frame-gap/.test(spec)
        && /available:\s*false/.test(spec)
        && /E3_MISSING_CINE_FRAME_INDEX/.test(spec)

    expect(coversEc2(regression), 'the committed regression spec covers EC-2').toBe(true)
    // Every other Priority-1 criterion is present too, so "omitted" cannot mean
    // quietly dropping a different one instead.
    for (const criterion of ['FR-2', 'FR-3', 'FR-4', 'FR-5', 'FR-6', 'EC-1', 'EC-2', 'EC-3', 'EC-4', 'EC-5']) {
      expect(regression, criterion).toMatch(new RegExp(`regression ${criterion}:`))
    }

    const ec2Removed = regression.replace(/\n {2}test\('regression EC-2:[\s\S]*?\n {2}\}\)\n/, '\n')
    expect(ec2Removed, 'the EC-2 block was actually removed').not.toBe(regression)
    expect(coversEc2(ec2Removed), 'a regression spec with EC-2 omitted must be rejected').toBe(false)
  })

  test('baselineRegeneratedInsteadOfReadIsRejected', () => {
    const benchmark = source('benchmark')
    const recorded = baselineBefore(source('baseline'))

    // The rule: the before column is quoted from the baseline, not measured
    // again. Any before value that is not the baseline's own value means the
    // pre-EL-1 numbers were regenerated, and a regenerated "before" is a
    // different event being passed off as the recorded one.
    const beforeIsRead = (document: string): boolean =>
      /read from `docs\/performance-baseline\.md`, never\nre-derived/.test(document)
        && resultRows(document).every((row) => recorded.get(row.requirement) === row.before)

    expect(recorded.size, 'the baseline still records PF-1..PF-3').toBe(3)
    expect(beforeIsRead(benchmark), 'the committed benchmark quotes the baseline').toBe(true)

    for (const tampered of [
      benchmark.replace('| 1130.00 ms p95 |', '| 980.00 ms p95 |'),
      benchmark.replace('| 5060.00 ms p95 |', '| 5900.00 ms p95 |'),
      benchmark.replace(/read from `docs\/performance-baseline\.md`, never\nre-derived/, 're-measured for this ticket'),
    ]) {
      expect(beforeIsRead(tampered), 'a regenerated before column must be rejected').toBe(false)
    }
  })

  test('afterVerdictThatContradictsItsOwnNumbersIsRejected', () => {
    const benchmark = source('benchmark')

    // The rule: the verdict is derived from the recorded runs, not asserted
    // over them. PF-3 falls on both sides of its target here, so this is the
    // exact place a document could quietly keep only the run that passed.
    const verdictsAreHonest = (document: string): boolean =>
      resultRows(document).every((row) => row.verdict === verdictFor(row))

    expect(verdictsAreHonest(benchmark), 'every verdict follows from the numbers beside it').toBe(true)
    // And the straddle is on the record rather than rounded away.
    const pf3 = resultRows(benchmark).find((row) => row.requirement === 'PF-3')!
    expect(pf3.verdict).toBe('unstable')
    expect(Math.min(...pf3.after)).toBeLessThan(pf3.targetMs)
    expect(Math.max(...pf3.after)).toBeGreaterThanOrEqual(pf3.targetMs)

    for (const tampered of [
      benchmark.replace('| 5105.30 ms p95 | 4657.00 ms p95 | unstable |', '| 5105.30 ms p95 | 4657.00 ms p95 | met |'),
      benchmark.replace('| 5105.30 ms p95 | 4657.00 ms p95 | unstable |', '| 4657.00 ms p95 | 4657.00 ms p95 | unstable |'),
      benchmark.replace('| 934.80 ms p95 | 859.05 ms p95 | met |', '| 934.80 ms p95 | 859.05 ms p95 | unstable |'),
    ]) {
      expect(verdictsAreHonest(tampered), 'a verdict that contradicts its own runs must be rejected').toBe(false)
    }
  })

  test('hardcodedUrlOrBarePortIsRejected', () => {
    // The rule is JOR-221's, applied to this ticket's new and changed files:
    // no URL carrying a port, and no bare well-known port.
    const isPortable = (content: string): boolean =>
      !/https?:\/\/[^\s"')]+:\d+/.test(content)
        && !['3000', '5432', '5433', '8080'].some((port) => new RegExp(`\\b${port}\\b`).test(content))

    for (const file of ['benchmark', 'imaging', 'regression'] as const) {
      expect(isPortable(source(file)), files[file]).toBe(true)
    }
    // The k6 script still derives its target rather than naming one.
    expect(source('imaging')).toMatch(/__ENV\.BASE_URL[\s\S]*__ENV\.PORT[\s\S]*4310/)

    for (const tampered of [
      `${source('imaging')}\nconst target = 'http://localhost:3000'\n`,
      `${source('regression')}\nawait page.goto('http://127.0.0.1:8080/studies')\n`,
      `${source('benchmark')}\nMeasured against http://localhost:3000 instead.\n`,
    ]) {
      expect(isPortable(tampered), 'a hardcoded URL or bare port must be rejected').toBe(false)
    }
  })
})

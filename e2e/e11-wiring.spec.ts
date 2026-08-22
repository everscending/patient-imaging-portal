// JOR-235 — E11's wiring proof for the whole benchmark run. E11 builds no new
// product scope: k6/imaging.js, k6/slots.js, k6/booking.js and
// e2e/playback-frames.spec.ts are T59's committed tooling, and
// docs/performance-baseline.md's first block is T60's committed baseline.
// What this ticket adds is one execution of all six PF rows E11 owns, appended
// to that file as a dated confirming record.
//
// tests/performance/performance-contract.test.ts already guards the T60 block
// at the logic tier (six rows, targets honoured or disclosed, PF-4/PF-6 read
// only from server-timing lines). This spec guards the appended record at the
// wiring tier: that it is genuinely appended rather than written over T60,
// that its six numbers carry the conditions they were measured under, that
// those conditions are the stated load against the seeded dataset, that the
// record belongs to this execution rather than an earlier cached one, and
// that the workload it claims is one the running app actually serves.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

import {
  E2_BOOK_SERVICE_ID,
  E2_PERFORMANCE_CLIP_ID,
  E2_SEEDED_STUDY_ID,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'Jor235BenchmarkPassword9'
const SEEDED_PATIENT = { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' }
let identityFixtureLockToken: string | undefined

const BASELINE = 'docs/performance-baseline.md'
const BENCHMARK = 'docs/el1-benchmark.md'

// The heading the confirming record starts at. Everything before it is the T60
// block, which T67's comparison reads and this ticket must not touch.
const RECORD_ANCHOR = '## Confirming run — JOR-235'

// SHA-256 of the T60 block exactly as JOR-221/JOR-302 committed it. A checksum
// rather than a spot-check of a few lines: an append that rewrote one digit of
// a baseline number somewhere above the anchor would still satisfy every
// row-shaped assertion, and would still be the thing this ticket promised not
// to do.
const T60_SHA256 = '0618923d05797567f7fb8f6a6e7afe18d0e740e18ac047d8916ef9119830a335'

// The six PF rows E11 owns. PF-7/PF-8/PF-9 belong to other epics and are
// deliberately absent — a record claiming them would be claiming a run this
// ticket did not perform.
const OWNED_ROWS = ['PF-1', 'PF-2', 'PF-3', 'PF-4', 'PF-5', 'PF-6'] as const

const REQUIRED_CONDITIONS = [
  'Run date',
  'Run commit',
  'Run host',
  'Run dataset',
  'Run VU ramp',
  'Run duration',
  'Run count',
] as const

function source(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

// ── the record, parsed rather than retyped ────────────────────────────────

/** The T60 block: every byte before the confirming record's own heading. */
function preservedBlock(baseline: string): string | null {
  const index = baseline.indexOf(`\n${RECORD_ANCHOR}`)
  return index === -1 ? null : baseline.slice(0, index)
}

function confirmingRecord(baseline: string): string {
  const index = baseline.indexOf(`\n${RECORD_ANCHOR}`)
  return index === -1 ? '' : baseline.slice(index)
}

function condition(document: string, name: string): string | undefined {
  return new RegExp(`^\\| ${name} \\| (.+) \\|$`, 'mi').exec(document)?.[1]?.trim()
}

const RECORD_ROW = /^\| (PF-[1-6])[^|]*\| p95 < ([\d.]+) s \| ([^|]+)\| (met|missed|unstable) \| [^|]+ \|$/gm

type RecordRow = {
  requirement: string
  targetMs: number
  measured: number[]
  verdict: string
}

function recordRows(record: string): RecordRow[] {
  return [...record.matchAll(RECORD_ROW)].map(([, requirement, target, measured, verdict]) => ({
    requirement: requirement!,
    targetMs: Number(target) * 1_000,
    // Only figures explicitly denominated in milliseconds count as measured
    // p95s, so a sample count sitting in the same cell is never mistaken for
    // a timing.
    measured: [...measured!.matchAll(/([\d.]+) ms/g)].map(([, value]) => Number(value)),
    verdict: verdict!,
  }))
}

/** The verdict derived from the numbers on the row, never asserted over them. */
function verdictFor(row: RecordRow): string {
  if (row.measured.every((value) => value < row.targetMs)) return 'met'
  if (row.measured.every((value) => value >= row.targetMs)) return 'missed'
  return 'unstable'
}

function runDates(record: string): string[] {
  return [...(condition(record, 'Run date') ?? '').matchAll(/\d{4}-\d{2}-\d{2}T[\d:]+Z/g)].map(([value]) => value)
}

// ── shared predicates, exercised on the committed record and then shown
//    rejecting a tampered copy further down ────────────────────────────────

/** Appended, not written over: the record exists and the T60 block above it is
 *  byte-for-byte what was committed before this ticket ran. */
function appendedWithoutDisturbingBaseline(baseline: string): boolean {
  const preserved = preservedBlock(baseline)
  if (preserved === null) return false
  return createHash('sha256').update(preserved).digest('hex') === T60_SHA256
}

/** All six p95s present, each with a target and a verdict its own numbers
 *  support, and every row that is not `met` named in a disposition. */
function recordsEverySixNumbers(record: string): boolean {
  const rows = recordRows(record)
  if (rows.length !== OWNED_ROWS.length) return false
  if (OWNED_ROWS.some((requirement) => !rows.some((row) => row.requirement === requirement))) return false
  if (!rows.every((row) => row.measured.length > 0 && row.measured.every(Number.isFinite))) return false
  if (!rows.every((row) => row.verdict === verdictFor(row))) return false

  const unmet = rows.filter((row) => row.verdict !== 'met')
  if (unmet.length === 0) return true
  const disposition = dispositionSection(record)
  return Boolean(disposition) && unmet.every((row) => disposition!.includes(row.requirement))
}

/** Matches either heading level: this record disposes at `###`, while
 *  docs/el1-benchmark.md disposes at `##`. */
function dispositionSection(document: string): string | undefined {
  return /^#{2,3} Disposition[\s\S]*?(?=\n#{2,3} |$(?!\n))/m.exec(document)?.[0]
}

// A disposition that hands its row to some later ticket is a deferral, not a
// decision. JOR-302 opened PF-3's chain and JOR-249 deferred it here; this
// ticket is where it ends, so no disposition on PF-3 may still point past
// itself. Built at runtime so this file's own explanatory words never trip
// its own scan — the technique tests/imaging/el1-delivery-contracts.test.ts
// uses for the same reason.
const DEFERRAL_TERMS = [
  'final' + ' authority',
  'final' + ' PF-3 authority',
  'not the last' + ' word',
  'awaits',
  'to be' + ' decided',
  'a later' + ' ticket',
  'a future' + ' run',
]
const DEFERS_ONWARD = new RegExp(DEFERRAL_TERMS.join('|'), 'i')

/** Terminal: the disposition is a human acceptance carrying its own date, and
 *  it defers the row to nothing further. */
function dispositionIsTerminal(document: string): boolean {
  const disposition = dispositionSection(document)
  return Boolean(disposition)
    && /human-accepted[\s\S]{0,120}\d{4}-\d{2}-\d{2}/i.test(disposition!)
    && !DEFERS_ONWARD.test(disposition!)
}

/** A number is only evidence with the conditions it was measured under beside
 *  it. Every condition the record needs must be stated, not implied. */
function statesItsConditions(record: string): boolean {
  return REQUIRED_CONDITIONS.every((name) => Boolean(condition(record, name)))
}

/** The local production server's port is the one thing a rerun is free to
 *  change — JOR-221 forbids pinning a literal port anywhere, and two worktrees
 *  must be able to run this benchmark without colliding. Everything else in the
 *  host condition (the deployed URL, the region, the local-production-build
 *  arrangement) still has to match exactly. */
function normalisePort(value: string | undefined): string | undefined {
  return value?.replace(/PORT=\d+/, 'PORT=<port>')
}

/** The load actually run is the load REQUIREMENTS.md states and the T60 block
 *  recorded — same ramp, same duration, same host condition per row. */
function ranTheStatedLoad(record: string, baseline: string): boolean {
  const preserved = preservedBlock(baseline) ?? ''
  const host = normalisePort(condition(record, 'Run host'))
  return condition(record, 'Run VU ramp') === condition(preserved, 'VU ramp')
    && condition(record, 'Run duration') === condition(preserved, 'Duration')
    && Boolean(host)
    && host === normalisePort(condition(preserved, 'Host'))
}

/** Measured against the seeded dataset, stated as ADR-0009's own row counts —
 *  a number from some other corpus is not this benchmark's number. */
function ranAgainstTheSeededDataset(record: string, baseline: string): boolean {
  const stated = condition(record, 'Run dataset')
  return Boolean(stated)
    && stated === condition(preservedBlock(baseline) ?? '', 'Dataset')
    && /ADR-0009/.test(stated!)
    && /50 patients[\s\S]*10 providers[\s\S]*150 studies[\s\S]*250 cine clips[\s\S]*700 images[\s\S]*16,?000 slots/i.test(stated!)
}

/** This execution, not a cached earlier one: the record names a commit that is
 *  really in this branch's history, and every run timestamp falls after that
 *  commit was written and after the T60 baseline it confirms. A run cannot
 *  predate the code it measured, so an older number moved under this heading
 *  fails here. */
function belongsToThisExecution(record: string, baseline: string): boolean {
  const commit = condition(record, 'Run commit')
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return false
  try {
    // stderr silenced: an unknown SHA is an expected answer here (the
    // adversarial case below asks exactly that), not a failure to report.
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: REPO_ROOT, stdio: 'ignore' })
  } catch {
    return false
  }
  const commitDate = Date.parse(git('show', '-s', '--format=%cI', commit))
  const baselineDate = Date.parse(condition(preservedBlock(baseline) ?? '', 'Date') ?? '')
  const dates = runDates(record)
  return dates.length > 0
    && dates.every((value) => Date.parse(value) >= commitDate && Date.parse(value) > baselineDate)
}

/** The scripts the record names exist, and the gate runs them rather than
 *  leaving them on disk as decoration. */
function scriptsExistAndAreRegistered(): boolean {
  const scripts = ['k6/imaging.js', 'k6/slots.js', 'k6/booking.js', 'e2e/playback-frames.spec.ts']
  if (!scripts.every((file) => existsSync(path.join(REPO_ROOT, file)))) return false
  const loom = source('.loom.yml')
  const ui = execFileSync(path.join(REPO_ROOT, 'scripts/gate.sh'), ['ui', '--list'], { encoding: 'utf8' })
  const validators = [
    'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e11-wiring.spec.ts',
    'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/playback-frames.spec.ts',
    'npx vitest run --project unit tests/performance/performance-contract.test.ts',
  ]
  return validators.every((command) => loom.includes(command) && ui.includes(command))
}

/** The client half of PF-3 is recorded as run, at the manifest's own frame
 *  rate, with no dropped frames and a bounded preload. */
function playbackValidatorHolds(record: string): boolean {
  const section = /^### Client playback[\s\S]*?(?=\n### |$(?!\n))/m.exec(record)?.[0]
  if (!section) return false
  const statedWindow = Number(
    /export const CINE_FRAME_WINDOW = (\d+)/.exec(source('components/imaging/CineViewer.tsx'))?.[1],
  )
  const peak = Number(/peak preload concurrency was (\d+)/.exec(section)?.[1])
  return /passed/.test(section)
    && /100 frames/.test(section)
    && /no dropped frames/.test(section)
    && /defaultFps/.test(section)
    && Number.isFinite(peak)
    && peak < 100
    && peak <= statedWindow + 2
}

// ── live: the workload the record claims is one this app serves ────────────

async function registerSignInAndVerify(request: APIRequestContext): Promise<void> {
  const email = `jor-235-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await request.post('/api/identity/verify', { data: SEEDED_PATIENT })).status()).toBe(200)
}

test.describe.serial('JOR-235 E11 live wiring against the running app', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))

  test('acceptance: every route the six recorded rows time is one the running app actually serves', async ({ request }) => {
    await registerSignInAndVerify(request)

    // PF-1: study manifest plus a signed image URL to fetch bytes from.
    const detailResponse = await request.get(`/api/studies/${E2_SEEDED_STUDY_ID}`)
    expect(detailResponse.status()).toBe(200)
    const detail = (await detailResponse.json()) as { images?: Array<{ url: string | null }> }
    expect(detail.images?.some((image) => image.url), 'PF-1 needs a signed image URL to time').toBe(true)

    // PF-2 and PF-3: the 100-frame clip manifest the benchmark selects, with
    // every frame available — the same precondition k6/imaging.js enforces
    // before it will produce a number at all.
    const manifestResponse = await request.get(`/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_PERFORMANCE_CLIP_ID}`)
    expect(manifestResponse.status()).toBe(200)
    const manifest = (await manifestResponse.json()) as {
      frameCount: number
      frames: Array<{ available: boolean; url: string | null }>
    }
    expect(manifest.frameCount).toBe(100)
    expect(manifest.frames).toHaveLength(100)
    expect(manifest.frames.every((frame) => frame.available && frame.url)).toBe(true)

    // PF-5: the open-slot query, reached the way k6/slots.js reaches it.
    const providersResponse = await request.get(`/api/providers?serviceId=${E2_BOOK_SERVICE_ID}`)
    expect(providersResponse.status()).toBe(200)
    const provider = ((await providersResponse.json()) as { providers: Array<{ id: string }> }).providers[0]
    expect(provider?.id, 'PF-5 needs a provider offering the seeded service').toBeTruthy()
    const from = new Date().toISOString()
    const to = new Date(Date.now() + 60 * 24 * 60 * 60 * 1_000).toISOString()
    const slotsResponse = await request.get(
      `/api/slots?providerId=${provider!.id}&serviceId=${E2_BOOK_SERVICE_ID}`
      + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
    expect(slotsResponse.status()).toBe(200)
    expect(((await slotsResponse.json()) as { slots: unknown[] }).slots.length).toBeGreaterThan(0)
  })
})

test.describe('JOR-235 E11 wiring contracts', () => {
  const baseline = (): string => source(BASELINE)
  const record = (): string => confirmingRecord(baseline())

  test('acceptance: the confirming run is appended below an untouched T60 block, with all six p95s and the conditions they were measured under', () => {
    expect(appendedWithoutDisturbingBaseline(baseline()), 'the T60 block must be byte-identical').toBe(true)
    expect(recordsEverySixNumbers(record()), 'all six PF rows must carry a p95 and an honest verdict').toBe(true)
    expect(statesItsConditions(record()), 'every number must sit beside its conditions').toBe(true)
    expect(ranTheStatedLoad(record(), baseline()), 'the run must be at the stated load').toBe(true)
    expect(ranAgainstTheSeededDataset(record(), baseline()), 'the run must be against the seeded dataset').toBe(true)
    expect(belongsToThisExecution(record(), baseline()), 'the record must belong to this execution').toBe(true)
  })

  test('acceptance: PF-3 is disposed as a terminal human acceptance, and nothing still defers it onward', () => {
    expect(dispositionIsTerminal(record()), 'this run must accept PF-3 rather than defer it').toBe(true)
    // The chain's other end: JOR-249 deferred PF-3 to this run, so its own
    // disposition must no longer point forward either.
    expect(dispositionIsTerminal(source(BENCHMARK)), 'the JOR-249 disposition must no longer defer PF-3').toBe(true)
  })

  test('acceptance: the benchmark scripts exist and the gate runs them, and the playback validator holds', () => {
    expect(scriptsExistAndAreRegistered()).toBe(true)
    expect(playbackValidatorHolds(record())).toBe(true)
  })

  test('mandatory adversarial: a load other than the stated one is rejected', () => {
    expect(ranTheStatedLoad(record(), baseline())).toBe(true)
    for (const tampered of [
      record().replace(/^\| Run VU ramp \| .+$/m, '| Run VU ramp | 10 s to 20 VUs, 40 s to 200 VUs, 10 s down to 0 |'),
      record().replace(/^\| Run duration \| .+$/m, '| Run duration | 15 s per k6 script |'),
      record().replace(/^\| Run host \| .+$/m, '| Run host | a local production build on a laptop |'),
      // The port is allowed to move; the region is not.
      record().replace('Supabase us-west-2', 'Supabase us-east-1'),
      record().replace(/^\| Run VU ramp \| .+$/m, ''),
    ]) {
      expect(ranTheStatedLoad(tampered, baseline()), 'a run at other than the stated load must be rejected').toBe(false)
    }
  })

  test('mandatory adversarial: a run against a dataset other than the seeded one is rejected', () => {
    expect(ranAgainstTheSeededDataset(record(), baseline())).toBe(true)
    for (const tampered of [
      record().replace(/^\| Run dataset \| .+$/m, '| Run dataset | one study, one clip, ten frames |'),
      record().replace(/^\| Run dataset \| .+$/m, '| Run dataset | ADR-0009 deployed seed: 2 patients, 1 provider, 3 studies, 1 cine clip, 4 images, and approximately 20 slots |'),
      record().replace(/^\| Run dataset \| .+$/m, ''),
    ]) {
      expect(ranAgainstTheSeededDataset(tampered, baseline()), 'a non-seeded dataset must be rejected').toBe(false)
    }
  })

  test('mandatory adversarial: a number presented without its conditions is rejected', () => {
    expect(statesItsConditions(record())).toBe(true)
    // The numbers survive; only the conditions table is removed. A p95 with
    // nothing stating what produced it is not a measurement.
    const conditionsStripped = record().replace(/^### Conditions[\s\S]*?(?=\n### Results)/m, '')
    expect(conditionsStripped, 'the Conditions section was actually removed').not.toBe(record())
    expect(recordRows(conditionsStripped), 'the six numbers are still present').toHaveLength(6)
    expect(statesItsConditions(conditionsStripped), 'a number without conditions must be rejected').toBe(false)

    for (const name of REQUIRED_CONDITIONS) {
      const dropped = record().replace(new RegExp(`^\\| ${name} \\| .+$`, 'm'), '')
      expect(statesItsConditions(dropped), `a record missing "${name}" must be rejected`).toBe(false)
    }
  })

  test('mandatory adversarial: overwriting the T60 baseline instead of appending is rejected', () => {
    expect(appendedWithoutDisturbingBaseline(baseline())).toBe(true)

    // The record on its own, with the T60 block gone — the shape an overwrite
    // would leave behind.
    const overwritten = `# Performance baseline\n${record()}`
    expect(appendedWithoutDisturbingBaseline(overwritten), 'a record written over the baseline must be rejected').toBe(false)

    // An append that also edited one digit above the anchor is still an edit.
    const editedAbove = baseline().replace('| 5060.00 ms p95; accepted exceedance |', '| 4060.00 ms p95 |')
    expect(editedAbove, 'a T60 number was actually changed').not.toBe(baseline())
    expect(appendedWithoutDisturbingBaseline(editedAbove), 'an edit to the T60 block must be rejected').toBe(false)

    // So is a record that never appended anything.
    expect(appendedWithoutDisturbingBaseline(preservedBlock(baseline())!), 'a missing record must be rejected').toBe(false)
  })

  test('mandatory adversarial: an earlier cached run presented as this execution is rejected', () => {
    expect(belongsToThisExecution(record(), baseline())).toBe(true)
    const commitDate = git('show', '-s', '--format=%cI', condition(record(), 'Run commit')!)

    for (const tampered of [
      // The T60 baseline's own run, relabelled as this one.
      record().replace(/^\| Run date \| .+$/m, '| Run date | 2026-08-21T22:20:32Z |'),
      // A timestamp that predates the commit it claims to have measured.
      record().replace(
        /^\| Run date \| .+$/m,
        `| Run date | ${new Date(Date.parse(commitDate) - 60_000).toISOString().replace(/\.\d+Z$/, 'Z')} |`,
      ),
      // A commit that is not in this branch's history at all.
      record().replace(/^\| Run commit \| .+$/m, '| Run commit | 0123456789abcdef0123456789abcdef01234567 |'),
      // No commit to tie the run to.
      record().replace(/^\| Run commit \| .+$/m, '| Run commit | this branch |'),
      // No timestamp to tie the run to.
      record().replace(/^\| Run date \| .+$/m, '| Run date | recently |'),
    ]) {
      expect(belongsToThisExecution(tampered, baseline()), 'a cached earlier run must be rejected').toBe(false)
    }
  })

  test('mandatory adversarial: a verdict that contradicts its own numbers, or an unmet row with no disposition, is rejected', () => {
    expect(recordsEverySixNumbers(record())).toBe(true)

    for (const tampered of [
      // PF-3 straddles its target; claiming it met is the exact failure this
      // ticket is the final authority on.
      record().replace('| 5030 ms (run 1), 4740.15 ms (run 2) | unstable |', '| 5030 ms (run 1), 4740.15 ms (run 2) | met |'),
      // Keeping only the run that passed.
      record().replace('| 5030 ms (run 1), 4740.15 ms (run 2) | unstable |', '| 4740.15 ms (run 2) | unstable |'),
      // A met row relabelled.
      record().replace('| 913.09 ms (run 1), 870.55 ms (run 2) | met |', '| 913.09 ms (run 1), 870.55 ms (run 2) | missed |'),
      // A row dropped entirely.
      record().replace(/^\| PF-5 [^\n]+\n/m, ''),
    ]) {
      expect(recordsEverySixNumbers(tampered), 'a verdict that contradicts its numbers must be rejected').toBe(false)
    }

    const dispositionRemoved = record().replace(/^### Disposition[\s\S]*?(?=\n### Client playback)/m, '')
    expect(dispositionRemoved, 'the disposition was actually removed').not.toBe(record())
    expect(recordsEverySixNumbers(dispositionRemoved), 'an unmet row with no disposition must be rejected').toBe(false)
  })

  test('mandatory adversarial: a disposition that defers its row onward, or accepts it undated, is rejected', () => {
    for (const document of [record(), source(BENCHMARK)]) {
      expect(dispositionIsTerminal(document)).toBe(true)
      for (const tampered of [
        document.replace('human-accepted', 'awaits a decision'),
        document.replace(/(^#{2,3} Disposition[^\n]*\n)/m, '$1\nA future run is the final authority on PF-3.\n'),
        document.replace(/human-accepted[\s\S]{0,120}?\d{4}-\d{2}-\d{2}/i, 'human-accepted at some point'),
      ]) {
        expect(dispositionIsTerminal(tampered), 'a deferred or undated disposition must be rejected').toBe(false)
      }
    }
    expect(dispositionIsTerminal('no disposition here'), 'a missing disposition must be rejected').toBe(false)
  })

  test('mandatory adversarial: a benchmark script that is present but unregistered fails the wiring pass', () => {
    expect(scriptsExistAndAreRegistered()).toBe(true)
    const ui = execFileSync(path.join(REPO_ROOT, 'scripts/gate.sh'), ['ui', '--list'], { encoding: 'utf8' })
    for (const validator of [
      'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e11-wiring.spec.ts',
      'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/playback-frames.spec.ts',
    ]) {
      expect(ui, `${validator} must be a gate command, not just a file on disk`).toContain(validator)
      expect(ui.replace(validator, '')).not.toContain(validator)
    }
  })
})

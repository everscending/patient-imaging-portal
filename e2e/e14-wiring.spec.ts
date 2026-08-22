// e2e/e14-wiring.spec.ts — JOR-265, E14's wiring proof: a reviewer's first
// hour, start to finish. This is the build's last ticket and it introduces no
// product scope. Every property below is already owned somewhere at the logic
// tier — tests/docs/readme-contract.test.ts for the README's internal honesty,
// tests/docs/ai-usage.test.ts for AI_USAGE.md, tests/docs/demo-contract.test.ts
// for the demo record, tests/deploy for docs/deploy.md. What this file adds is
// the one thing none of them can: whether what a reviewer is *handed* matches
// the build they actually meet.
//
// Three design pins, from the ticket:
//   * The quick start is EXECUTED and timed, not read. A clean checkout,
//     README followed literally, elapsed recorded — that run is written into
//     README's own confirming run record, and the predicates below read that
//     record rather than re-timing anything here.
//   * The uptime figure is READ from docs/deploy.md — one measurement, one
//     place — and restated in the README verbatim (GAP-5). This file checks
//     the two agree cell for cell; it never computes an availability figure.
//   * The demo is confirmed by REGENERATING it from its committed spec in a
//     clean clone, not by looking at a file someone left behind.
//
// The README parsers come from tests/docs/readme-contract.ts, the same module
// the logic tier uses, so the wiring tier cannot drift into a second opinion
// about what the README says.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

import {
  configDefault,
  quickStartCoversConcurrencyAndLeakage,
  readmeStatedValue,
  section,
  STATED_PARAMETER_ENV_KEYS,
  unseededDemoCredentials,
} from '../tests/docs/readme-contract'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const DEPLOYED_URL = 'https://patient-imaging-portal.vercel.app'
const RUN_RECORD_HEADING = '## E14 confirming run record (JOR-265)'

const README = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')
const DEPLOY_MD = readFileSync(path.join(REPO_ROOT, 'docs', 'deploy.md'), 'utf8')
const CONFIG_SOURCE = readFileSync(path.join(REPO_ROOT, 'lib', 'config.ts'), 'utf8')
const AI_USAGE_PATH = path.join(REPO_ROOT, 'AI_USAGE.md')

// Every section a reviewer's first hour actually lands on. A heading that
// disappeared would take its whole contract with it silently, which is why
// presence is asserted here and not left implied by the parsers below.
const REQUIRED_README_SECTIONS = [
  '## Grader quick start',
  '## Roles',
  '## Identity verification',
  '## PHI statement',
  '## Business Associate Agreement (BAA) disclosure',
  '## Retention and deletion',
  '## Environment variables',
  '## Stated parameters (ADR-0008)',
  '## PF-8 and PF-9 windows (GAP-5)',
  '## Performance',
  '## Known residues',
  '## Vocabulary',
  '## Deployed URL',
  RUN_RECORD_HEADING,
  '## Documentation',
]

// ── shared predicates: pure functions of text, exercised live below and
//    adversarially further down, so each one is proved to catch what it claims.

/** The deployed URL the README hands a reviewer. */
export function readmeDeployedUrl(content: string): string | undefined {
  return /https:\/\/[^\s)`<>]+/.exec(section(content, '## Deployed URL'))?.[0]
}

// docs/deploy.md's uptime window-close table and the README's restatement of
// it share this header verbatim, so one parser reads both and "restated per
// GAP-5" becomes a cell-for-cell comparison rather than a prose promise.
const UPTIME_HEADER =
  '| Window end (UTC) | Total checks | Reachable and healthy | Reachable but degraded | Unreachable | Availability |'

export function uptimeWindowCloseRow(markdown: string): string[] | undefined {
  const lines = markdown.split('\n')
  const header = lines.findIndex((line) => line.trim() === UPTIME_HEADER)
  if (header === -1) return undefined
  const row = lines[header + 2]
  if (row === undefined || !row.trim().startsWith('|')) return undefined
  return row.split('|').slice(1, -1).map((cell) => cell.trim())
}

/** GAP-5: one measurement, one place. The README may restate it, never
 *  re-derive it — so every cell must match docs/deploy.md exactly. A window
 *  still open reads `_pending_` in both files, and that agrees too. */
export function uptimeFiguresAgree(readmeContent: string, deployMd: string): boolean {
  const stated = uptimeWindowCloseRow(readmeContent)
  const measured = uptimeWindowCloseRow(deployMd)
  if (stated === undefined || measured === undefined) return false
  return stated.length === 6 && measured.length === 6 && stated.every((cell, i) => cell === measured[i])
}

/** Variables `lib/config.ts` fails startup without, that the README's
 *  environment table never names — the reviewer's undocumented-variable trap. */
export function undocumentedRequiredVariables(readmeContent: string, configSource: string): string[] {
  const required = [...configSource.matchAll(/requireString\('([A-Z0-9_]+)'\)/g)].map((match) => match[1]!)
  const table = section(readmeContent, '## Environment variables')
  return [...new Set(required)].filter((name) => !table.includes(`\`${name}\``))
}

export type RunRecordStep = { step: string; elapsed: string; result: string }

/** The executed quick start, one row per step, read back out of the record
 *  the run itself wrote into the README. */
export function quickStartRunRecord(content: string): RunRecordStep[] {
  const record = section(content, RUN_RECORD_HEADING)
  return [...record.matchAll(/^\| \d+ \| (.+?) \| (.+?) \| (.+?) \|$/gm)].map(([, step, elapsed, result]) => ({
    step: step!.trim(),
    elapsed: elapsed!.trim(),
    result: result!.trim(),
  }))
}

/** A step is only ok if the run recorded it ok. Anything else — failed,
 *  skipped, worked around — is a gap, and the ticket's stop condition. */
export function failedQuickStartSteps(content: string): RunRecordStep[] {
  return quickStartRunRecord(content).filter((step) => !/^ok\b/.test(step.result))
}

/** A suite the quick start tells a reviewer to run, with no recorded result
 *  from the confirming run — named but not actually run. */
export function suitesNamedButNotRun(content: string): string[] {
  const quickStart = section(content, '## Grader quick start')
  const named = [...quickStart.matchAll(/npm run (gate:[a-z]+)/g)].map((match) => match[1]!)
  const record = section(content, RUN_RECORD_HEADING)
  return [...new Set(named)].filter((suite) => !record.includes(suite))
}

/** AI_USAGE.md's no-runtime-AI statement must be a sentence, not an
 *  omission — and the file must exist at all. Mirrors the assertions
 *  tests/docs/ai-usage.test.ts owns, restated here as one predicate so the
 *  missing-file case is a `false` rather than a thrown read error. */
export function missingNoRuntimeAiStatement(aiUsage: string | undefined): boolean {
  if (aiUsage === undefined || aiUsage.trim() === '') return true
  if (!aiUsage.includes('## Runtime AI')) return true
  const runtime = section(aiUsage, '## Runtime AI').replace(/\s+/g, ' ')
  return !/no runtime ai is used/i.test(runtime) || !/no model[^.]*is called on any request path/i.test(runtime)
}

/** A regeneration only counts if the committed spec exited clean AND left a
 *  recording with bytes in it. Either half alone proves nothing. */
export function demoRegenerationUsable(run: { status: number; sizeBytes: number }): boolean {
  return run.status === 0 && run.sizeBytes > 0
}

// ADR-0013: never a bare or computed port for a child process, always one the
// OS handed out and this process read back.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not resolve a free port')))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

test.describe('JOR-265 E14 — the deployed demo a reviewer is pointed at', () => {
  test('acceptance: the deployed URL is reachable over HTTPS and answers 200', async ({ page }) => {
    const response = await page.goto(DEPLOYED_URL)
    expect(response?.status()).toBe(200)
    expect(new URL(page.url()).protocol).toBe('https:')
  })

  test('acceptance: /api/health answers 200 with a per-dependency body', async ({ request }) => {
    const response = await request.get(`${DEPLOYED_URL}/api/health`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as Record<string, string>
    // Per-dependency, not a single aggregate flag: an aggregate cannot tell
    // "reachable but degraded" from "gone", which is the one distinction the
    // uptime check (JOR-252) is built on.
    expect(Object.keys(body).sort()).toEqual(['app', 'database', 'storage'])
    expect(body.app).toBe('ok')
    expect(['ok', 'down']).toContain(body.database)
    expect(['ok', 'down']).toContain(body.storage)
  })

  test('acceptance: the deployed URL the README states is the one that answered', async ({ request }) => {
    const stated = readmeDeployedUrl(README)
    expect(stated, 'the README must name a deployed URL, not a pending placeholder').toBe(DEPLOYED_URL)
    expect((await request.get(stated!)).status()).toBe(200)
  })
})

test.describe('JOR-265 E14 — the README, re-asserted against the live build', () => {
  test('acceptance: every section a reviewer\'s first hour lands on is present', () => {
    for (const heading of REQUIRED_README_SECTIONS) {
      expect(README.split('\n').map((line) => line.trim()), `README is missing ${heading}`).toContain(heading)
    }
  })

  test('acceptance: every stated parameter matches the running lib/config.ts default', () => {
    for (const envKey of STATED_PARAMETER_ENV_KEYS) {
      expect(readmeStatedValue(README, envKey), envKey).toBe(configDefault(CONFIG_SOURCE, envKey))
    }
  })

  test('acceptance: every variable the app fails startup without is documented', () => {
    expect(undocumentedRequiredVariables(README, CONFIG_SOURCE)).toEqual([])
  })

  test('acceptance: the quick start names the concurrency and leakage suites, and the run record proves every named suite ran', () => {
    const covered = quickStartCoversConcurrencyAndLeakage(README)
    expect(covered.concurrency, 'the quick start must name tests/scheduling/booking-concurrency.test.ts').toBe(true)
    expect(covered.leakage, 'the quick start must name tests/adversarial/cross-patient.test.ts').toBe(true)
    expect(suitesNamedButNotRun(README)).toEqual([])
  })

  test('acceptance: every quick-start step the confirming run executed is recorded ok', () => {
    const record = quickStartRunRecord(README)
    expect(record.length, 'the run record must carry the executed quick-start steps').toBeGreaterThan(0)
    expect(failedQuickStartSteps(README)).toEqual([])
  })

  test('acceptance: every demo credential the README prints is seeded', () => {
    const result = unseededDemoCredentials(README)
    expect(result.emails).toEqual([])
    expect(result.badPassword).toBe(false)
  })

  test('acceptance: AI_USAGE.md exists and states no runtime AI is used', () => {
    expect(existsSync(AI_USAGE_PATH)).toBe(true)
    expect(missingNoRuntimeAiStatement(readFileSync(AI_USAGE_PATH, 'utf8'))).toBe(false)
  })

  test('acceptance: the README uptime figure is docs/deploy.md\'s, cell for cell (GAP-5)', () => {
    expect(uptimeFiguresAgree(README, DEPLOY_MD)).toBe(true)
  })
})

test.describe('JOR-265 E14 — the demo, confirmed by regenerating it', () => {
  // A clean clone, so the regeneration is proved against committed sources
  // only, and so the nested run's own Playwright output, .local fixture state
  // and identity-fixture lock can never touch this worktree's — the same
  // scratch-clone shape e2e/e0-wiring.spec.ts uses for its nested gate.
  let scratchDir: string
  let regeneration: { status: number; sizeBytes: number; stderr: string }

  test.beforeAll(async () => {
    test.setTimeout(15 * 60_000)
    scratchDir = mkdtempSync(path.join(tmpdir(), 'e14-demo-regen-'))
    execFileSync('git', ['clone', '--local', '--quiet', REPO_ROOT, scratchDir])
    execFileSync('npm', ['ci'], { cwd: scratchDir, stdio: 'pipe' })

    const port = await freePort()
    const run = spawnSync('npx', ['playwright', 'test', '--project=demo-walkthrough', '--reporter=line'], {
      cwd: scratchDir,
      encoding: 'utf8',
      env: { ...process.env, PORT: String(port) },
      maxBuffer: 1024 * 1024 * 64,
    })
    const artifact = path.join(scratchDir, 'test-results', 'demo-walkthrough', 'demo-walkthrough.webm')
    regeneration = {
      status: run.status ?? 1,
      sizeBytes: existsSync(artifact) ? statSync(artifact).size : 0,
      stderr: `${run.stderr ?? ''}\n${run.stdout ?? ''}`,
    }
  })

  test.afterAll(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true })
  })

  test('acceptance: the recorded walkthrough regenerates from its committed spec in a clean clone', () => {
    expect(regeneration.status, regeneration.stderr).toBe(0)
    expect(regeneration.sizeBytes, 'the regenerated recording must have bytes in it').toBeGreaterThan(0)
    expect(demoRegenerationUsable(regeneration)).toBe(true)
  })
})

test.describe('JOR-265 E14 — mandatory adversarial', () => {
  // Deliberately synthetic, not a tampered copy of the real record: the live
  // record is what the acceptance test above judges, and this ticket's own
  // confirming run left two steps failing (Gap 1 and Gap 2, recorded in the
  // README). Reading the real record here too would make this adversarial
  // demonstration a second, duplicate verdict on the same fact.
  test('mandatory adversarial: quickStartStepFails', function quickStartStepFails() {
    const record = (secondStepResult: string): string =>
      [
        RUN_RECORD_HEADING,
        '',
        '| # | Step | Elapsed | Result |',
        '| --- | --- | --- | --- |',
        '| 1 | `git clone` | 1s | ok |',
        `| 2 | \`npm ci\` | 4s | ${secondStepResult} |`,
        '',
      ].join('\n')

    expect(quickStartRunRecord(record('ok'))).toHaveLength(2)
    expect(failedQuickStartSteps(record('ok'))).toEqual([])

    const failed = failedQuickStartSteps(record('failed — npm ci exited 1'))
    expect(failed, 'a recorded quick-start failure must fail the wiring pass').toHaveLength(1)
    expect(failed[0]!.step).toBe('`npm ci`')
    // A step that was neither run nor recorded ok is a failure too — silence
    // is the easiest way to make a quick start look like it worked.
    expect(failedQuickStartSteps(record('skipped'))).toHaveLength(1)
    expect(failedQuickStartSteps(record('okay-ish, needed a manual step'))).toHaveLength(1)
  })

  test('mandatory adversarial: undocumentedVariableRequired', function undocumentedVariableRequired() {
    expect(undocumentedRequiredVariables(README, CONFIG_SOURCE)).toEqual([])
    const withExtra = `${CONFIG_SOURCE}\nconst extra = requireString('PIP_UNDOCUMENTED_SECRET')\n`
    expect(undocumentedRequiredVariables(README, withExtra)).toEqual(['PIP_UNDOCUMENTED_SECRET'])
    // ...and the mirror case: the variable is read, the table drops its row.
    const tableStripped = README.replace(/^\| `SOURCE_REF_SALT` \|.*$/m, '')
    expect(undocumentedRequiredVariables(tableStripped, CONFIG_SOURCE)).toEqual(['SOURCE_REF_SALT'])
  })

  test('mandatory adversarial: demoCredentialNotSeeded', function demoCredentialNotSeeded() {
    expect(unseededDemoCredentials(README).emails).toEqual([])
    const invented = README.replace('| Patient | `patient@demo.pip.test` |', '| Patient | `nurse@demo.pip.test` |')
    expect(invented, 'the fixture must actually have invented an address').not.toBe(README)
    expect(unseededDemoCredentials(invented).emails).toContain('nurse@demo.pip.test')
  })

  test('mandatory adversarial: suiteNamedButNotRunOrMissingConcurrencyOrLeakage', function suiteNamedButNotRunOrMissingConcurrencyOrLeakage() {
    expect(suitesNamedButNotRun(README)).toEqual([])
    // A suite the quick start names that the confirming run never recorded.
    const record = section(README, RUN_RECORD_HEADING)
    const notRun = README.replace(record, record.replace(/gate:api/g, ''))
    expect(suitesNamedButNotRun(notRun)).toEqual(['gate:api'])
    // ...and the quick start silently dropping either named suite.
    const noLeakage = README.replace(/tests\/adversarial\/cross-patient\.test\.ts/g, '')
    expect(quickStartCoversConcurrencyAndLeakage(noLeakage).leakage).toBe(false)
    const noConcurrency = README.replace(/tests\/scheduling\/booking-concurrency\.test\.ts/g, '')
    expect(quickStartCoversConcurrencyAndLeakage(noConcurrency).concurrency).toBe(false)
  })

  test('mandatory adversarial: uptimeFigureDisagreesWithDeployMd', function uptimeFigureDisagreesWithDeployMd() {
    expect(uptimeFiguresAgree(README, DEPLOY_MD)).toBe(true)
    const stated = uptimeWindowCloseRow(README)!
    // One cell edited in the README — the exact shape of a figure that was
    // restated by hand instead of read from the one measurement.
    const tampered = README.replace(
      `| ${stated.join(' | ')} |`,
      `| ${['100.00%', ...stated.slice(1)].join(' | ')} |`,
    )
    expect(tampered, 'the fixture must actually have edited a cell').not.toBe(README)
    expect(uptimeFiguresAgree(tampered, DEPLOY_MD), 'a hand-edited uptime cell must fail the wiring pass').toBe(false)
    // ...and a README that dropped the restatement entirely.
    expect(uptimeFiguresAgree(README.replace(UPTIME_HEADER, ''), DEPLOY_MD)).toBe(false)
  })

  test('mandatory adversarial: parameterDisagreesWithConfig', function parameterDisagreesWithConfig() {
    for (const envKey of STATED_PARAMETER_ENV_KEYS) {
      expect(readmeStatedValue(README, envKey)).toBe(configDefault(CONFIG_SOURCE, envKey))
    }
    const wrong = README.replace('`SHARE_LINK_TTL_HOURS` | 48 |', '`SHARE_LINK_TTL_HOURS` | 47 |')
    expect(wrong, 'the fixture must actually have changed the stated value').not.toBe(README)
    expect(readmeStatedValue(wrong, 'SHARE_LINK_TTL_HOURS')).not.toBe(
      configDefault(CONFIG_SOURCE, 'SHARE_LINK_TTL_HOURS'),
    )
  })

  test('mandatory adversarial: missingAiUsageOrNoRuntimeAiStatement', function missingAiUsageOrNoRuntimeAiStatement() {
    const aiUsage = readFileSync(AI_USAGE_PATH, 'utf8')
    expect(missingNoRuntimeAiStatement(aiUsage)).toBe(false)
    // The file gone entirely.
    expect(missingNoRuntimeAiStatement(undefined)).toBe(true)
    expect(missingNoRuntimeAiStatement('')).toBe(true)
    // The section gone.
    expect(missingNoRuntimeAiStatement(aiUsage.replace('## Runtime AI', '## Something else'))).toBe(true)
    // Present, but a bare denial rather than the request-path sentence.
    expect(missingNoRuntimeAiStatement('## Runtime AI\n\nNo runtime AI is used.\n')).toBe(true)
  })

  test('mandatory adversarial: demoNotRegenerable', function demoNotRegenerable() {
    expect(demoRegenerationUsable({ status: 0, sizeBytes: 1024 })).toBe(true)
    // The spec ran but failed.
    expect(demoRegenerationUsable({ status: 1, sizeBytes: 1024 })).toBe(false)
    // The spec "passed" but left no recording — a green run that produced
    // nothing is exactly the confirmation-by-watching-a-file this ticket
    // refuses to accept.
    expect(demoRegenerationUsable({ status: 0, sizeBytes: 0 })).toBe(false)
  })
})

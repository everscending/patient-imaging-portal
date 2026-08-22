// JOR-261 — the contract behind the recorded DEL-6 walkthrough.
//
// The walkthrough itself proves the product behaves; these tests prove the
// walkthrough cannot quietly stop proving it. Each one names a way a demo
// goes wrong — a recording with no committed spec behind it, clauses drifting
// out of DEL-6's order, a staged race — pins the property that rules it out,
// and then feeds the validator a tampered copy to show the validator would
// actually catch it.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const SPEC_PATH = 'e2e/demo-walkthrough.spec.ts'
const DOC_PATH = 'docs/demo.md'
const SPEC = readFileSync(path.join(REPO_ROOT, SPEC_PATH), 'utf8')
const DOC = readFileSync(path.join(REPO_ROOT, DOC_PATH), 'utf8')

/** The regeneration command docs/demo.md must state, verbatim. */
const REGENERATION_COMMAND = 'npx playwright test --project=demo-walkthrough'

/** DEL-6's clauses, in DEL-6's order. The spec's steps must read as this. */
const DEL6_ORDER = [
  'DEL-6 (1a) patient identity verification',
  'DEL-6 (1b) image viewing',
  'DEL-6 (1c) cine viewing',
  'DEL-6 (2a) secure sharing of an image',
  'DEL-6 (2b) secure sharing of a report',
  'DEL-6 (2c) revocation on /shares',
  'DEL-6 (3) report viewing',
  'DEL-6 (4) provider availability setup',
  'DEL-6 (5) patient booking',
  'DEL-6 (6) the no-double-book behaviour',
  'DEL-6 (7a) reschedule',
  'DEL-6 (7b) cancel',
  'DEL-6 (8) a reminder being sent',
]

/** Every hook the ticket pinned. A demo that stops touching one is not the demo. */
const PINNED_HOOKS = [
  'identity-form', 'study-list', 'image-viewer', 'cine-viewer', 'cine-play',
  'share-create', 'share-list', 'share-revoke', 'report-view',
  'availability-form', 'availability-collision-list', 'service-select',
  'provider-select', 'slot-list', 'slot-item', 'book-submit',
  'booking-conflict', 'appointment-list', 'appointment-reschedule',
  'appointment-cancel',
]

function stepNames(spec: string): string[] {
  return [...spec.matchAll(/demoStep\('([^']+)'/g)].map((match) => match[1]!)
}

function committedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split('\n')
}

// ── the nine ways a recorded demo goes wrong ────────────────────────────────

/** 1. A recording is evidence only if a committed spec can reproduce it. */
function recordingIsBackedByACommittedSpec(doc: string, committed: string[]): boolean {
  return committed.includes(SPEC_PATH) && doc.includes(SPEC_PATH)
}

/** 2. The clauses must run in DEL-6's order, not merely all appear. */
function stepsFollowDel6Order(spec: string): boolean {
  return stepNames(spec).join('\n') === DEL6_ORDER.join('\n')
}

/** 3. At least one segment must be driven at phone width on the tab-bar shell. */
function hasPhoneWidthSegment(spec: string): boolean {
  return /width:\s*390\b/.test(spec) && spec.includes('patient-tabbar')
}

/** 4. The two booking attempts must overlap; a pre-booked slot is a narration. */
function noDoubleBookRaces(spec: string): boolean {
  const races = /Promise\.all\(\[\s*submitBooking\(page\),\s*submitBooking\(rival\),?\s*\]\)/.test(spec)
  const staged = spec.includes('__test__/book-slot')
  return races && !staged
}

/** 5. A cine clip is not shareable, so its screen must offer no share action. */
function assertsCineOffersNoShare(spec: string): boolean {
  return /getByTestId\('share-create'\)\)\.toHaveCount\(0\)/.test(spec)
    && /clip\.getByRole\('(button|link)', \{ name: \/share\/i \}\)\)\.toHaveCount\(0\)/.test(spec)
}

/** 6. A raw share token may never be read back off any later screen. */
function assertsTokenStaysOnIssuingScreen(spec: string): boolean {
  return /not\.toContainText\(tokenOf\(share\)\)/.test(spec)
}

/** 7. No credential and no real-person identifier may reach the recording. */
function keepsCredentialsAndRealPeopleOutOfTheRecording(spec: string): string[] {
  const faults: string[] = []
  // A password may only be typed into a password field, which renders dots.
  if (!/getByLabel\('Password'\)\)\.toHaveAttribute\('type', 'password'\)/.test(spec)) {
    faults.push('password field is never proven masked')
  }
  // Never in a URL, where it would be legible in the address bar.
  if (/goto\([^)]*(?:password|PASSWORD)/.test(spec)) faults.push('credential in a URL')
  // The seeded demo patient only. A real person's details never appear.
  if (!spec.includes("'PT-4471'")) faults.push('does not use the seeded demo patient')
  return faults
}

/** 8. The reminder must go through the real job, behind the real secret. */
function invokesTheRealReminderJob(spec: string): boolean {
  const invokesJob = spec.includes("post('/api/jobs/reminders'") && spec.includes("'x-cron-secret'")
  const stubbed = /sendEmail\(|dispatchReminders\(|route\('\*\*\/api\/jobs\/reminders/.test(spec)
  return invokesJob && !stubbed
}

/** 9. A demo doc nobody can re-run from is a screenshot with extra steps. */
function docStatesRegenerationCommand(doc: string): boolean {
  return doc.includes(REGENERATION_COMMAND)
}

describe('JOR-261 the recorded walkthrough is backed by a committed, ordered spec', () => {
  test('theWalkthroughSpecAndDocAreBothCommitted', () => {
    const committed = committedFiles()
    expect(committed).toContain(SPEC_PATH)
    expect(committed).toContain(DOC_PATH)
    expect(existsSync(path.join(REPO_ROOT, SPEC_PATH))).toBe(true)
  })

  test('everyPinnedHookIsDrivenByTheSpec', () => {
    // A hook counts however it is written: getByTestId('x') or [data-testid="x"].
    expect(PINNED_HOOKS.filter((hook) => !new RegExp(`["']${hook}["']`).test(SPEC))).toEqual([])
  })

  test('theSpecIsRegisteredInThisTiersCommandList', () => {
    const loom = readFileSync(path.join(REPO_ROOT, '.loom.yml'), 'utf8')
    const gate = readFileSync(path.join(REPO_ROOT, 'scripts', 'gate.sh'), 'utf8')
    for (const source of [loom, gate]) {
      expect(source).toContain('--project=demo-walkthrough')
      expect(source).toContain(SPEC_PATH)
    }
  })
})

describe('JOR-261 mandatory adversarial: nine ways a recorded demo goes wrong', () => {
  test('recordingWithNoCommittedSpec_isRejected', () => {
    expect(recordingIsBackedByACommittedSpec(DOC, committedFiles())).toBe(true)
    expect(recordingIsBackedByACommittedSpec(DOC.replaceAll(SPEC_PATH, ''), committedFiles())).toBe(false)
    expect(recordingIsBackedByACommittedSpec(DOC, ['docs/demo.md'])).toBe(false)
  })

  test('stepsOutOfDel6Order_isRejected', () => {
    expect(stepsFollowDel6Order(SPEC)).toBe(true)
    // Report viewing hoisted above the sharing clauses it must follow.
    const swapped = SPEC
      .replace("demoStep('DEL-6 (2a) secure sharing of an image'", "demoStep('DEL-6 (3) report viewing'")
      .replace("demoStep('DEL-6 (3) report viewing', async () => {\n      await page.goto(`/reports/", "demoStep('DEL-6 (2a) secure sharing of an image', async () => {\n      await page.goto(`/reports/")
    expect(stepsFollowDel6Order(swapped)).toBe(false)
    expect(stepsFollowDel6Order(SPEC.replace("demoStep('DEL-6 (8) a reminder being sent'", "demoStep('DEL-6 (9) extra'"))).toBe(false)
  })

  test('noPhoneWidthSegment_isRejected', () => {
    expect(hasPhoneWidthSegment(SPEC)).toBe(true)
    expect(hasPhoneWidthSegment(SPEC.replace('width: 390', 'width: 1280'))).toBe(false)
    expect(hasPhoneWidthSegment(SPEC.replaceAll('patient-tabbar', 'something-else'))).toBe(false)
  })

  test('stagedNonRacingNoDoubleBook_isRejected', () => {
    expect(noDoubleBookRaces(SPEC)).toBe(true)
    // Sequential attempts: the second only starts once the first has won.
    const sequential = SPEC.replace(
      /const \[mainStatus, rivalStatus\] = await Promise\.all\(\[\s*submitBooking\(page\),\s*submitBooking\(rival\),\s*\]\)/,
      'const mainStatus = await submitBooking(page)\n      const rivalStatus = await submitBooking(rival)',
    )
    expect(noDoubleBookRaces(sequential)).toBe(false)
    // Pre-booking the slot out of band and calling the result a race.
    expect(noDoubleBookRaces(`${SPEC}\nawait request.post('/__test__/book-slot')`)).toBe(false)
  })

  test('shareActionOfferedOnACineClip_isRejected', () => {
    expect(assertsCineOffersNoShare(SPEC)).toBe(true)
    expect(assertsCineOffersNoShare(SPEC.replaceAll("getByTestId('share-create')).toHaveCount(0)", ''))).toBe(false)
    expect(assertsCineOffersNoShare(SPEC.replaceAll(/clip\.getByRole\('(button|link)', \{ name: \/share\/i \}\)\)\.toHaveCount\(0\)/g, ''))).toBe(false)
  })

  test('rawShareTokenOutsideIssuingScreen_isRejected', () => {
    expect(assertsTokenStaysOnIssuingScreen(SPEC)).toBe(true)
    expect(assertsTokenStaysOnIssuingScreen(SPEC.replaceAll('not.toContainText(tokenOf(share))', 'toBeTruthy()'))).toBe(false)
  })

  test('credentialOrRealPersonIdentifiersInRecording_isRejected', () => {
    expect(keepsCredentialsAndRealPeopleOutOfTheRecording(SPEC)).toEqual([])
    expect(keepsCredentialsAndRealPeopleOutOfTheRecording(
      SPEC.replace("getByLabel('Password')).toHaveAttribute('type', 'password')", 'Promise.resolve()'),
    )).toContain('password field is never proven masked')
    expect(keepsCredentialsAndRealPeopleOutOfTheRecording(
      `${SPEC}\nawait page.goto('/login?password=hunter2')`,
    )).toContain('credential in a URL')
    expect(keepsCredentialsAndRealPeopleOutOfTheRecording(
      SPEC.replaceAll("'PT-4471'", "'a real patient'"),
    )).toContain('does not use the seeded demo patient')
  })

  test('reminderStubInsteadOfJobInvocation_isRejected', () => {
    expect(invokesTheRealReminderJob(SPEC)).toBe(true)
    // Calling the transport directly, skipping the job and its secret.
    expect(invokesTheRealReminderJob(SPEC.replace("post('/api/jobs/reminders'", "sendEmail('reminder'"))).toBe(false)
    // Intercepting the job so nothing real ever runs.
    expect(invokesTheRealReminderJob(`${SPEC}\nawait page.route('**/api/jobs/reminders', (r) => r.fulfill({ status: 200 }))`)).toBe(false)
    expect(invokesTheRealReminderJob(SPEC.replaceAll("'x-cron-secret'", "'x-nothing'"))).toBe(false)
  })

  test('demoDocWithoutRegenerationCommand_isRejected', () => {
    expect(docStatesRegenerationCommand(DOC)).toBe(true)
    expect(docStatesRegenerationCommand(DOC.replaceAll(REGENERATION_COMMAND, 'run the demo'))).toBe(false)
  })
})

describe('JOR-261 the demo doc states what a reader needs to re-run and trust it', () => {
  test('docNamesArtifactLocationRunTargetAndTransport', () => {
    expect(DOC).toContain('test-results/demo-walkthrough/demo-walkthrough.webm')
    expect(DOC).toMatch(/local stack/i)
    // GAP-3: the transport that actually carried the message.
    expect(DOC).toMatch(/\blog\b/)
  })

  test('docCarriesATimestampForEveryDel6Step', () => {
    for (const clause of DEL6_ORDER) {
      expect(DOC, `docs/demo.md must time ${clause}`).toContain(clause)
    }
    // A timestamp per step, in mm:ss, harvested from a real run.
    expect([...DOC.matchAll(/\b\d{2}:\d{2}\b/g)].length).toBeGreaterThanOrEqual(DEL6_ORDER.length)
  })
})

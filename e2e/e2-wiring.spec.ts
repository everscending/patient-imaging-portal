// JOR-264 — E2's one live identity/access wiring check.  This deliberately
// calls the running app and its committed fake Supabase service only: no route,
// database, Auth, or clock behavior is replaced in this spec.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import {
  E2_FOREIGN_CLIP_ID,
  E2_FOREIGN_REPORT_ID,
  E2_FOREIGN_STUDY_ID,
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_REPORT_ID,
  E2_SEEDED_STUDY_ID,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'
const SEEDED_PATIENT = { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' }
let identityFixtureLockToken: string | undefined

type GuardedEndpoint = {
  path: string
  action: string
  targetKind: string
  targetId: string | null
}

const GUARDED_ENDPOINTS = [
  { path: '/api/studies', action: 'study.view', targetKind: 'study_list', targetId: null },
  { path: `/api/studies/${E2_SEEDED_STUDY_ID}`, action: 'study.view', targetKind: 'study', targetId: E2_SEEDED_STUDY_ID },
  {
    path: `/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`,
    action: 'clip.view',
    targetKind: 'clip',
    targetId: E2_SEEDED_CLIP_ID,
  },
  { path: '/api/reports', action: 'report.view', targetKind: 'report_list', targetId: null },
  { path: `/api/reports/${E2_SEEDED_REPORT_ID}`, action: 'report.view', targetKind: 'report', targetId: E2_SEEDED_REPORT_ID },
] as const satisfies readonly GuardedEndpoint[]

const FOREIGN_GUARDED_ENDPOINTS = [
  { path: `/api/studies/${E2_FOREIGN_STUDY_ID}`, action: 'study.view', targetKind: 'study', targetId: E2_FOREIGN_STUDY_ID },
  {
    path: `/api/studies/${E2_FOREIGN_STUDY_ID}/clips/${E2_FOREIGN_CLIP_ID}`,
    action: 'clip.view',
    targetKind: 'clip',
    targetId: E2_FOREIGN_CLIP_ID,
  },
  { path: `/api/reports/${E2_FOREIGN_REPORT_ID}`, action: 'report.view', targetKind: 'report', targetId: E2_FOREIGN_REPORT_ID },
] as const satisfies readonly GuardedEndpoint[]

type AuditEvent = {
  actor_kind?: string
  actor_ref?: string | null
  action?: string
  target_kind?: string
  target_id?: string | null
  outcome?: string
  occurred_at?: string
}

type IdentityState = {
  patients: Array<{ patient_ref: string; user_id: string | null }>
  auditEvents: AuditEvent[]
}

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  expect(response.ok()).toBe(true)
}

async function state(request: APIRequestContext): Promise<IdentityState> {
  return (await (await request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json()) as IdentityState
}

async function signIn(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.post('/api/auth/login', { data: { email, password: PASSWORD } })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { userId: string }).userId
}

async function registerAndSignIn(request: APIRequestContext, label: string): Promise<{ email: string; userId: string }> {
  const email = `jor-264-${label}-${randomUUID()}@example.com`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  return { email, userId: await signIn(request, email) }
}

async function verify(
  request: APIRequestContext,
  patientRef: string,
  dateOfBirth: string,
  sourceAddress = '192.0.2.264',
): Promise<{ status: number; text: string }> {
  const response = await request.post('/api/identity/verify', {
    data: { patientRef, dateOfBirth },
    headers: { 'x-forwarded-for': sourceAddress },
  })
  return { status: response.status(), text: await response.text() }
}

async function expectOneGuardAudit(
  request: APIRequestContext,
  before: number,
  expected: Pick<AuditEvent, 'action' | 'target_kind' | 'target_id' | 'outcome'> & { actorRef: string | null },
): Promise<void> {
  const events = (await state(request)).auditEvents.slice(before)
  expect(events, 'every guarded decision must append exactly one audit row').toHaveLength(1)
  const [event] = events
  expect(event).toEqual(
    expect.objectContaining({
      actor_kind: 'account',
      actor_ref: expected.actorRef,
      action: expected.action,
      target_kind: expected.target_kind,
      target_id: expected.target_id,
      outcome: expected.outcome,
      occurred_at: expect.any(String),
    }),
  )
  expect(Number.isNaN(Date.parse(event.occurred_at ?? ''))).toBe(false)
}

async function expectGuardedAccess(
  request: APIRequestContext,
  endpoint: GuardedEndpoint,
  expected: { status: 200 | 401 | 403 | 404; outcome: 'granted' | 'denied'; actorRef: string | null },
): Promise<void> {
  const before = (await state(request)).auditEvents.length
  const response = await request.get(endpoint.path, { maxRedirects: 0 })
  expect(response.status(), endpoint.path).toBe(expected.status)
  if (expected.status === 403) {
    expect(await response.json()).toEqual({ error: 'identity_verification_required', message: expect.any(String) })
  }
  await expectOneGuardAudit(request, before, {
    actorRef: expected.actorRef,
    action: endpoint.action,
    target_kind: endpoint.targetKind,
    target_id: endpoint.targetId,
    outcome: expected.outcome,
  })
}

// The fixture must advance its own deterministic clock.  A wall-clock sleep
// would neither prove five minutes nor be acceptable evidence of expiry.
async function advanceCommittedFixtureClock(request: APIRequestContext, milliseconds: number): Promise<void> {
  const sessionToken = (await request.storageState()).cookies.find((cookie) => cookie.name === 'pip_session')?.value
  expect(sessionToken, 'the active test session must expose its HTTP-only cookie to Playwright').toEqual(expect.any(String))
  const response = await request.post(`${await fakeServerUrl()}/__test__/clock`, {
    data: { advanceMs: milliseconds, sessionToken },
  })
  expect(response.status(), 'the committed E2 fixture must provide a deterministic clock hook').toBe(200)
}

test.describe('JOR-264 E2 identity/access wiring', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetIdentity(request))

  test('acceptance: new patient registers signs in edits profile and is signed out at session expiry', async ({ page }) => {
    const email = `jor-264-profile-${randomUUID()}@example.com`
    await page.goto('/register')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Register' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/appointments$/)

    await page.goto('/profile')
    await page.getByLabel('Display name').fill('E2 Patient')
    await page.getByLabel('Contact phone').fill('+1 555 0264')
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible()

    await advanceCommittedFixtureClock(page.request, 60 * 60_000 + 1)
    await page.goto('/profile')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('acceptance: incorrect patient reference and date of birth are generic and source lockout lasts five minutes', async ({ request }) => {
    await registerAndSignIn(request, 'lockout')
    const wrongReference = await verify(request, 'PT-9999', SEEDED_PATIENT.dateOfBirth)
    const secondWrongReference = await verify(request, 'PT-9998', SEEDED_PATIENT.dateOfBirth)
    const thirdFailure = await verify(request, SEEDED_PATIENT.patientRef, '1988-03-16')
    const lockedCorrectAttempt = await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)

    expect([wrongReference.status, secondWrongReference.status, thirdFailure.status, lockedCorrectAttempt.status]).toEqual([400, 400, 400, 400])
    expect([wrongReference.text, secondWrongReference.text, thirdFailure.text, lockedCorrectAttempt.text]).toEqual([
      wrongReference.text,
      wrongReference.text,
      wrongReference.text,
      wrongReference.text,
    ])

    await advanceCommittedFixtureClock(request, 4 * 60_000 + 59_000)
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(400)

    await resetIdentity(request)
    await verify(request, 'PT-9999', SEEDED_PATIENT.dateOfBirth)
    await verify(request, 'PT-9998', SEEDED_PATIENT.dateOfBirth)
    await verify(request, SEEDED_PATIENT.patientRef, '1988-03-16')
    await advanceCommittedFixtureClock(request, 5 * 60_000 + 1)
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
  })

  test('acceptance: three failures for one patient reference lock attempts across independent sources', async ({ request }) => {
    await registerAndSignIn(request, 'reference-lockout')
    for (const [index, dateOfBirth] of ['1988-03-15', '1988-03-16', '1988-03-17'].entries()) {
      expect((await verify(request, SEEDED_PATIENT.patientRef, dateOfBirth, `192.0.2.${10 + index}`)).status).toBe(400)
    }
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth, '192.0.2.99')).status).toBe(400)
  })

  test("acceptance: correct verification permanently links the account to only that patient's studies and reports", async ({ request }) => {
    await registerAndSignIn(request, 'unlock')
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    const studies = await request.get('/api/studies')
    const reports = await request.get('/api/reports')
    expect(studies.status()).toBe(200)
    expect(reports.status()).toBe(200)
    expect((await studies.json()) as unknown).toEqual({
      studies: [expect.objectContaining({ id: E2_SEEDED_STUDY_ID })],
    })
    expect((await reports.json()) as unknown).toEqual({
      reports: [expect.objectContaining({ id: E2_SEEDED_REPORT_ID, studyId: E2_SEEDED_STUDY_ID })],
    })
  })

  test('acceptance: direct access to another patient study clip or report is concealed and audited', async ({ request }) => {
    const account = await registerAndSignIn(request, 'foreign-resource')
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    for (const endpoint of FOREIGN_GUARDED_ENDPOINTS) {
      await expectGuardedAccess(request, endpoint, { status: 404, outcome: 'denied', actorRef: account.userId })
    }
  })

  test('mandatory adversarial: secondAccountCannotUseFirstPatientReferenceAndDateOfBirth', async ({ request, browser }) => {
    const firstAccount = await registerAndSignIn(request, 'first-account')
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    const linkedBefore = (await state(request)).patients.find((patient) => patient.patient_ref === SEEDED_PATIENT.patientRef)
    expect(linkedBefore?.user_id).toBe(firstAccount.userId)
    const secondContext = await browser.newContext()
    try {
      await registerAndSignIn(secondContext.request, 'second-account')
      const secondAttempt = await verify(secondContext.request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)
      expect(secondAttempt.status).toBe(400)
      expect(secondAttempt.text).toBe(JSON.stringify({ error: 'identity_mismatch', message: 'The reference and date of birth did not match.' }))
      expect((await state(request)).patients.find((patient) => patient.patient_ref === SEEDED_PATIENT.patientRef)).toEqual(linkedBefore)
      expect((await request.get('/api/studies')).status()).toBe(200)
    } finally {
      await secondContext.close()
    }
  })

  test('mandatory adversarial: unlinkedGuardedRequestNeverReturns200', async ({ request }) => {
    const account = await registerAndSignIn(request, 'unlinked')
    for (const endpoint of GUARDED_ENDPOINTS) {
      await expectGuardedAccess(request, endpoint, { status: 403, outcome: 'denied', actorRef: account.userId })
    }
  })

  test('mandatory adversarial: noSessionGuardedRequestAlwaysReturns401', async ({ request }) => {
    for (const endpoint of GUARDED_ENDPOINTS) {
      await expectGuardedAccess(request, endpoint, { status: 401, outcome: 'denied', actorRef: null })
    }
  })

  test('mandatory adversarial: everyGuardedAccessWritesExactlyOneAuditEvent', async ({ request }) => {
    const account = await registerAndSignIn(request, 'audit')
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    for (const endpoint of GUARDED_ENDPOINTS) {
      await expectGuardedAccess(request, endpoint, { status: 200, outcome: 'granted', actorRef: account.userId })
    }
  })

  test('mandatory adversarial: verifyFailureCausesAreByteIdentical', async ({ request }) => {
    await registerAndSignIn(request, 'generic-errors')
    const wrongReference = await verify(request, 'PT-9999', SEEDED_PATIENT.dateOfBirth)
    const wrongDateOfBirth = await verify(request, SEEDED_PATIENT.patientRef, '1988-03-15')
    await verify(request, SEEDED_PATIENT.patientRef, '1988-03-16')
    const activeLockout = await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)
    expect([wrongReference.status, wrongDateOfBirth.status, activeLockout.status]).toEqual([400, 400, 400])
    expect([wrongReference.text, wrongDateOfBirth.text, activeLockout.text]).toEqual([
      wrongReference.text,
      wrongReference.text,
      wrongReference.text,
    ])
  })

  test('mandatory adversarial: linkedPatientNeverAskedToVerifyAgain', async ({ request, browser }) => {
    const account = await registerAndSignIn(request, 'already-linked')
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    const returningContext = await browser.newContext()
    try {
      expect(await signIn(returningContext.request, account.email)).toBe(account.userId)
      const returningPage = await returningContext.newPage()
      await returningPage.goto('/verify?next=%2Fstudies')
      await expect(returningPage).toHaveURL(/\/studies$/)
      await expect(returningPage.getByTestId('identity-form')).toHaveCount(0)
    } finally {
      await returningContext.close()
    }
  })
})

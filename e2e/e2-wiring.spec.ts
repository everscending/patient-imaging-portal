// JOR-264 — E2's one live identity/access wiring check.  This deliberately
// calls the running app and its committed fake Supabase service only: no route,
// database, Auth, or clock behavior is replaced in this spec.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'
const SEEDED_PATIENT = { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' }
const IDENTITY_FIXTURE_LOCK = path.join(REPO_ROOT, '.local', 'identity-fixture.lock')

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

async function acquireIdentityFixture(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await mkdir(IDENTITY_FIXTURE_LOCK)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('identity fixture lock timed out')
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  expect(response.ok()).toBe(true)
}

async function state(request: APIRequestContext): Promise<IdentityState> {
  return (await (await request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json()) as IdentityState
}

async function registerAndSignIn(request: APIRequestContext, label: string): Promise<string> {
  const email = `jor-264-${label}-${randomUUID()}@example.com`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  return email
}

async function verify(request: APIRequestContext, patientRef: string, dateOfBirth: string): Promise<{ status: number; text: string }> {
  const response = await request.post('/api/identity/verify', {
    data: { patientRef, dateOfBirth },
    headers: { 'x-forwarded-for': '192.0.2.264' },
  })
  return { status: response.status(), text: await response.text() }
}

async function expectOneGuardAudit(
  request: APIRequestContext,
  before: number,
  expected: Pick<AuditEvent, 'action' | 'target_kind' | 'outcome'>,
): Promise<void> {
  const events = (await state(request)).auditEvents.slice(before)
  expect(events, 'every guarded decision must append exactly one audit row').toHaveLength(1)
  const [event] = events
  expect(event).toEqual(
    expect.objectContaining({
      actor_kind: 'account',
      actor_ref: expect.any(String),
      action: expected.action,
      target_kind: expected.target_kind,
      outcome: expected.outcome,
      occurred_at: expect.any(String),
    }),
  )
  expect(Number.isNaN(Date.parse(event.occurred_at ?? ''))).toBe(false)
}

// The fixture must advance its own deterministic clock.  A wall-clock sleep
// would neither prove five minutes nor be acceptable evidence of expiry.
async function advanceCommittedFixtureClock(request: APIRequestContext, milliseconds: number): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/clock`, { data: { advanceMs: milliseconds } })
  expect(response.status(), 'the committed E2 fixture must provide a deterministic clock hook').toBe(200)
}

test.describe('JOR-264 E2 identity/access wiring', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(acquireIdentityFixture)
  test.afterAll(async () => rm(IDENTITY_FIXTURE_LOCK, { recursive: true, force: true }))
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

  test('acceptance: incorrect reference and DOB are generic then three failures impose a five-minute lockout', async ({ request }) => {
    await registerAndSignIn(request, 'lockout')
    const wrongReference = await verify(request, 'PT-9999', SEEDED_PATIENT.dateOfBirth)
    const wrongDob = await verify(request, SEEDED_PATIENT.patientRef, '1988-03-15')
    const thirdFailure = await verify(request, SEEDED_PATIENT.patientRef, '1988-03-16')
    const lockedCorrectAttempt = await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)

    expect([wrongReference.status, wrongDob.status, thirdFailure.status, lockedCorrectAttempt.status]).toEqual([400, 400, 400, 400])
    expect([wrongReference.text, wrongDob.text, thirdFailure.text, lockedCorrectAttempt.text]).toEqual([
      wrongReference.text,
      wrongReference.text,
      wrongReference.text,
      wrongReference.text,
    ])

    await advanceCommittedFixtureClock(request, 5 * 60_000 + 1)
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
  })

  test('acceptance: correct verification permanently unlocks only that patients studies and reports', async ({ request }) => {
    await registerAndSignIn(request, 'unlock')
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    expect((await request.get('/api/studies')).status()).toBe(200)
    expect((await request.get('/api/reports')).status()).toBe(200)
    expect((await request.get('/studies', { maxRedirects: 0 })).status()).toBe(200)
    expect((await request.get('/reports', { maxRedirects: 0 })).status()).toBe(200)
  })

  test('mandatory adversarial: secondAccountCannotUseFirstPatientsCorrectReferenceAndDOB', async ({ request, browser }) => {
    await registerAndSignIn(request, 'first-account')
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    const secondContext = await browser.newContext()
    try {
      await registerAndSignIn(secondContext.request, 'second-account')
      const secondAttempt = await verify(secondContext.request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)
      expect(secondAttempt.status).toBe(400)
      expect(secondAttempt.text).toBe(JSON.stringify({ error: 'identity_mismatch', message: 'The reference and date of birth did not match.' }))
    } finally {
      await secondContext.close()
    }
  })

  test('mandatory adversarial: unlinkedGuardedRequestNeverReturns200', async ({ request }) => {
    await registerAndSignIn(request, 'unlinked')
    const before = (await state(request)).auditEvents.length
    const response = await request.get('/api/studies', { maxRedirects: 0 })
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ error: 'identity_verification_required', message: expect.any(String) })
    await expectOneGuardAudit(request, before, { action: 'study.view', target_kind: 'study_list', outcome: 'denied' })
  })

  test('mandatory adversarial: noSessionGuardedRequestAlwaysReturns401', async ({ request }) => {
    const before = (await state(request)).auditEvents.length
    const response = await request.get('/api/studies', { maxRedirects: 0 })
    expect(response.status()).toBe(401)
    await expectOneGuardAudit(request, before, { action: 'study.view', target_kind: 'study_list', outcome: 'denied' })
  })

  test('mandatory adversarial: everyGuardedAccessWritesExactlyOneAuditEvent', async ({ request }) => {
    await registerAndSignIn(request, 'audit')
    expect((await verify(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    const before = (await state(request)).auditEvents.length
    expect((await request.get('/api/studies')).status()).toBe(200)
    await expectOneGuardAudit(request, before, { action: 'study.view', target_kind: 'study_list', outcome: 'granted' })
  })

  test('mandatory adversarial: verifyFailuresAreByteIdentical', async ({ request }) => {
    await registerAndSignIn(request, 'generic-errors')
    const wrongReference = await verify(request, 'PT-9999', SEEDED_PATIENT.dateOfBirth)
    const wrongDob = await verify(request, SEEDED_PATIENT.patientRef, '1988-03-15')
    expect(wrongReference.status).toBe(400)
    expect(wrongDob.status).toBe(400)
    expect(wrongReference.text).toBe(wrongDob.text)
  })

  test('mandatory adversarial: linkedPatientNeverAskedToVerifyAgain', async ({ page }) => {
    await registerAndSignIn(page.request, 'already-linked')
    expect((await verify(page.request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
    await page.goto('/verify?next=%2Fstudies')
    await expect(page).toHaveURL(/\/studies$/)
    await expect(page.getByTestId('identity-form')).toHaveCount(0)
  })
})

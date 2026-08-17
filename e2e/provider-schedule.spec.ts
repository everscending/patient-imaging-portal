// JOR-260 — provider-only daily schedule and lifecycle actions.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import {
  E2_OTHER_PROVIDER_EMAIL,
  E2_OTHER_PROVIDER_ID,
  E2_PROVIDER_EMAIL,
  E2_PROVIDER_ID,
  E2_PROVIDER_PASSWORD,
} from './fixtures/fake-auth-server'
import { acquireIdentityFixtureLock, IDENTITY_FIXTURE_HOOK_TIMEOUT_MS, releaseIdentityFixtureLock } from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const DAY = '2026-08-17'
const REQUESTED_APPOINTMENT = '26000000-0000-4000-8000-000000000101'
const CANCELLED_APPOINTMENT = '26000000-0000-4000-8000-000000000102'
let identityFixtureLockToken: string | undefined

async function fakeServerUrl(): Promise<string> {
  return (JSON.parse(await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')) as { url: string }).url
}

async function resetSchedule(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fakeServerUrl()}/__test__/reset-availability`)).ok()).toBe(true)
}

async function signIn(request: APIRequestContext, email = E2_PROVIDER_EMAIL): Promise<void> {
  expect((await request.post('/api/auth/login', { data: { email, password: E2_PROVIDER_PASSWORD } })).status()).toBe(200)
}

async function signInPatient(request: APIRequestContext): Promise<void> {
  const email = `schedule-patient-${randomUUID()}@example.test`
  const password = 'PatientFixturePassword9'
  expect((await request.post('/api/auth/register', { data: { email, password } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password } })).status()).toBe(200)
}

test.describe.serial('JOR-260 provider schedule', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetSchedule(request))

  test('live check: provider sees references only and confirms a requested appointment', async ({ page }) => {
    await signIn(page.request)
    await page.goto('/provider/schedule')
    await page.getByLabel('Date').fill(DAY)
    await expect(page.getByTestId('provider-schedule')).toBeVisible()
    await expect(page.getByText('America/Chicago', { exact: true })).toBeVisible()
    await expect(page.getByTestId('provider-schedule-row')).toHaveCount(3)
    await expect(page.getByText('PT-4471', { exact: false })).toBeVisible()
    await expect(page.getByText('Open', { exact: true })).toBeVisible()
    await expect(page.getByText('Outside hours — this appointment is unaffected.')).toBeVisible()
    await page.getByTestId('provider-transition-action').filter({ hasText: 'Confirm' }).click()
    await expect(page.getByText('PT-4471 · MRI · confirmed')).toBeVisible()
    const text = await page.getByTestId('provider-schedule').innerText()
    expect(text).not.toContain('Morgan Rivers')
    expect(text).not.toContain('1988-03-14')
  })

  test('foreignProvider404PatientAndAnonymousScheduleRequests', async ({ page }) => {
    await signIn(page.request, E2_OTHER_PROVIDER_EMAIL)
    expect((await page.request.get(`/api/provider/schedule?date=${DAY}&providerId=${E2_PROVIDER_ID}`)).status()).toBe(404)
    await page.context().clearCookies()
    await signInPatient(page.request)
    expect((await page.request.get(`/api/provider/schedule?date=${DAY}`)).status()).toBe(404)
    await page.context().clearCookies()
    expect((await page.request.get(`/api/provider/schedule?date=${DAY}`)).status()).toBe(401)
  })

  test('malformedDateAndForbiddenForcedLifecyclePaths', async ({ page }) => {
    await signIn(page.request)
    expect((await page.request.get('/api/provider/schedule?date=2026-02-31')).status()).toBe(422)
    const earlyNoShow = await page.request.patch(`/api/appointments/${REQUESTED_APPOINTMENT}`, {
      data: { action: 'transition', status: 'no_show' },
    })
    expect(earlyNoShow.status()).toBe(422)
    const cancelledCompleted = await page.request.patch(`/api/appointments/${CANCELLED_APPOINTMENT}`, {
      data: { action: 'transition', status: 'completed' },
    })
    expect(cancelledCompleted.status()).toBe(422)
  })

  test('scheduleResponseHasNoPatientNameOrDobAndTerminalRowsHaveNoActions', async ({ page }) => {
    await signIn(page.request)
    const response = await page.request.get(`/api/provider/schedule?date=${DAY}`)
    expect(response.status()).toBe(200)
    const payload = await response.json() as { timeZone: string; slots: Array<{ appointment: { allowedTransitions: string[] } | null }> }
    expect(payload).toHaveProperty('timeZone', 'America/Chicago')
    expect(JSON.stringify(payload)).not.toContain('Morgan Rivers')
    expect(JSON.stringify(payload)).not.toContain('1988-03-14')
    expect(payload.slots.some((slot) => slot.appointment?.allowedTransitions.length === 0)).toBe(true)
  })

  test('scheduleSourceUsesLifecycleAndCancellationEnvelope', async () => {
    const [route, page] = await Promise.all([
      readFile(path.join(REPO_ROOT, 'app/api/provider/schedule/route.ts'), 'utf8'),
      readFile(path.join(REPO_ROOT, 'app/(provider)/schedule/page.tsx'), 'utf8'),
    ])
    expect(route).toContain("role: 'provider'")
    expect(route).toContain('allowedTransitions(')
    expect(page).toContain("{ action: 'cancel' }")
    expect(page).toContain("{ action: 'transition', status }")
    expect(page).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(page).toContain('provider-schedule-row')
    expect(page).toContain('provider-transition-action')
    expect(E2_OTHER_PROVIDER_ID).toBeTruthy()
  })
})

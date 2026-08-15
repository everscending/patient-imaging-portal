// JOR-263 — identity-verification and account-profile live checks against the
// real Next routes and the deterministic fake Supabase service.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

import { config } from '../lib/config'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'
const PINNED_ERROR = 'We could not match those details. Please check them and try again.'
const IDENTITY_FIXTURE_LOCK = path.join(REPO_ROOT, '.local', 'identity-fixture.lock')

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

async function registerAndSignIn(request: APIRequestContext): Promise<string> {
  const email = `jor-263-${randomUUID()}@example.com`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  return email
}

type IdentityState = {
  patients: Array<Record<string, unknown>>
  identityAttempts: Array<Record<string, unknown>>
  auditEvents: Array<Record<string, unknown>>
}

async function identityState(request: APIRequestContext): Promise<IdentityState> {
  return (await (await request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json()) as IdentityState
}

test.describe('JOR-263 /verify and /profile', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(acquireIdentityFixture)
  test.afterAll(async () => rm(IDENTITY_FIXTURE_LOCK, { recursive: true, force: true }))
  test.beforeEach(async ({ request }) => {
    await resetIdentity(request)
  })

  test('live check: wrong reference, wrong date, and third failure render one identical alert then disable', async ({
    page,
  }) => {
    await registerAndSignIn(page.request)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/verify?next=%2Fprofile')

    await expect(page.getByTestId('identity-form')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByText('This is a one-time step. Once matched, you will not be asked again.')).toBeVisible()
    await expect(page.getByLabel('Patient reference')).toBeVisible()
    await expect(page.getByLabel('Date of birth')).toBeVisible()

    const renderedErrors: string[] = []
    for (const values of [
      { patientRef: 'PT-9999', dateOfBirth: '1988-03-14' },
      { patientRef: 'PT-4471', dateOfBirth: '1988-03-15' },
      { patientRef: 'PT-9998', dateOfBirth: '1988-03-14' },
    ]) {
      await page.getByLabel('Patient reference').fill(values.patientRef)
      await page.getByLabel('Date of birth').fill(values.dateOfBirth)
      await page.getByRole('button', { name: 'Continue' }).click()
      const alert = page.getByTestId('identity-error')
      await expect(alert).toHaveAttribute('role', 'alert')
      renderedErrors.push((await alert.textContent()) ?? '')
    }

    expect(renderedErrors).toEqual([PINNED_ERROR, PINNED_ERROR, PINNED_ERROR])
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await expect(page.getByText('Try again in a few minutes', { exact: true })).toBeVisible()

    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toMatch(/locked|lockout|attempts remaining/i)
    expect(bodyText).not.toMatch(/reference (?:is|was) wrong|date of birth (?:is|was) wrong/i)
    const buttonBox = await page.getByRole('button', { name: 'Continue' }).boundingBox()
    expect(buttonBox?.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })

  test('successful verification returns to next and a linked account skips the screen thereafter', async ({
    page,
  }) => {
    await registerAndSignIn(page.request)
    await page.goto('/verify?next=%2Fprofile')
    await page.getByLabel('Patient reference').fill('PT-4471')
    await page.getByLabel('Date of birth').fill('1988-03-14')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page).toHaveURL(/\/profile$/)

    await page.goto('/verify?next=%2Fprofile')
    await expect(page).toHaveURL(/\/profile$/)
    await expect(page.getByTestId('identity-form')).toHaveCount(0)
  })

  test('profile GET/PATCH uses account metadata and leaves the linked patients row byte-identical', async ({
    page,
  }) => {
    const sessionRequest = page.request
    const email = await registerAndSignIn(sessionRequest)
    const unlinked = await sessionRequest.get('/api/profile')
    expect(unlinked.status()).toBe(200)
    expect(await unlinked.json()).toEqual({ email, fullName: '', phone: null, patientRef: null })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/profile')
    await expect(page.getByTestId('profile-form')).toBeVisible()
    await expect(page.getByTestId('profile-patient-ref')).toHaveCount(0)
    await expect(page.getByLabel('Email')).toHaveAttribute('readonly', '')
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    const verified = await sessionRequest.post('/api/identity/verify', {
      data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
      headers: { 'x-forwarded-for': '192.0.2.63' },
    })
    expect(verified.status()).toBe(200)
    const linked = await sessionRequest.get('/api/profile')
    expect((await linked.json()).patientRef).toBe('PT-4471')

    const patientsBefore = (await identityState(sessionRequest)).patients
    const update = await sessionRequest.patch('/api/profile', {
      data: { fullName: 'Morgan Patient', phone: '+1 555 0100' },
    })
    expect(update.status()).toBe(200)
    expect(await update.json()).toEqual({
      email,
      fullName: 'Morgan Patient',
      phone: '+1 555 0100',
      patientRef: 'PT-4471',
    })
    expect((await identityState(sessionRequest)).patients).toEqual(patientsBefore)

    await page.reload()
    const patientReference = page.getByTestId('profile-patient-ref')
    await expect(patientReference).toHaveValue('PT-4471')
    await expect(patientReference).toHaveAttribute('readonly', '')
    const saveBox = await page.getByTestId('profile-save').boundingBox()
    expect(saveBox?.height).toBeGreaterThanOrEqual(44)
  })

  test('profile PATCH rejects every authority-bearing extra key and changes neither account nor patient data', async ({
    request,
  }) => {
    const email = await registerAndSignIn(request)
    const profileBefore = await (await request.get('/api/profile')).json()
    const patientsBefore = (await identityState(request)).patients

    for (const extra of [
      { email: 'attacker@example.com' },
      { password: 'ChangedPassword9' },
      { patientRef: 'PT-4471' },
      { patientId: randomUUID() },
      { userId: randomUUID() },
    ]) {
      const response = await request.patch('/api/profile', {
        data: { fullName: 'Attacker', phone: null, ...extra },
      })
      expect(response.status(), JSON.stringify(extra)).toBe(422)
      expect(await response.json()).toEqual({ error: 'validation_failed', message: expect.any(String) })
    }

    expect(await (await request.get('/api/profile')).json()).toEqual(profileBefore)
    expect((await identityState(request)).patients).toEqual(patientsBefore)
    expect((await (await request.get('/api/profile')).json()).email).toBe(email)
  })

  test('profile PATCH rejects oversized and non-string metadata', async ({ request }) => {
    await registerAndSignIn(request)
    for (const body of [
      { fullName: 'x'.repeat(10_000), phone: null },
      { fullName: 'Morgan', phone: '1'.repeat(10_000) },
      { fullName: 42, phone: null },
      { fullName: 'Morgan', phone: 42 },
    ]) {
      const response = await request.patch('/api/profile', { data: body })
      expect(response.status()).toBe(422)
      expect((await response.json()).error).toBe('validation_failed')
    }
  })

  test('profile GET and PATCH require a session', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({
      baseURL: `http://localhost:${config.port}`,
    })
    try {
      expect((await anonymous.get('/api/profile')).status()).toBe(401)
      expect(
        (await anonymous.patch('/api/profile', { data: { fullName: 'Morgan', phone: null } })).status(),
      ).toBe(401)
    } finally {
      await anonymous.dispose()
    }
  })

  test('direct submission during server-side lockout returns the same generic response', async ({ request }) => {
    await registerAndSignIn(request)
    const bodies: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const response = await request.post('/api/identity/verify', {
        data: { patientRef: 'PT-4471', dateOfBirth: `1988-03-${String(15 + index).padStart(2, '0')}` },
        headers: { 'x-forwarded-for': '192.0.2.64' },
      })
      expect(response.status()).toBe(400)
      bodies.push(await response.text())
    }
    const locked = await request.post('/api/identity/verify', {
      data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
      headers: { 'x-forwarded-for': '192.0.2.64' },
    })
    expect(locked.status()).toBe(400)
    bodies.push(await locked.text())
    expect(new Set(bodies).size).toBe(1)
  })

  test('profile implementation contains no patients write path and no editable patient reference', async () => {
    const route = await readFile(path.join(REPO_ROOT, 'app/api/profile/route.ts'), 'utf8')
    const page = await readFile(path.join(REPO_ROOT, 'app/(patient)/profile/page.tsx'), 'utf8')
    expect(route).not.toMatch(/\.from\(['"]patients['"]\)\s*\.update/)
    expect(route).not.toMatch(/\.from\(['"]patients['"]\)\s*\.insert/)
    expect(page).toMatch(/data-testid="profile-patient-ref"[\s\S]{0,180}readOnly/)
  })
})

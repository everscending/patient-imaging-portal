// e2e/availability.spec.ts — JOR-223's live provider availability check.
// The browser drives the real page and API; fake-auth-server.ts supplies the
// provider-scoped PostgREST tables and transactional RPC needed by that API.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  E2_OTHER_PROVIDER_ID,
  E2_PROVIDER_EMAIL,
  E2_PROVIDER_ID,
  E2_PROVIDER_PASSWORD,
} from './fixtures/fake-auth-server'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const AVAILABILITY_FIXTURE_LOCK = path.join(REPO_ROOT, '.local', 'availability-fixture.lock')

async function acquireAvailabilityFixture(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await mkdir(AVAILABILITY_FIXTURE_LOCK)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('availability fixture lock timed out')
}

async function fakeAuthServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetAvailability(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeAuthServerUrl()}/__test__/reset-availability`)
  expect(response.status()).toBe(200)
}

async function signIn(request: APIRequestContext, email: string, password: string): Promise<void> {
  const response = await request.post('/api/auth/login', { data: { email, password } })
  expect(response.status()).toBe(200)
}

async function signInProvider(request: APIRequestContext): Promise<void> {
  await signIn(request, E2_PROVIDER_EMAIL, E2_PROVIDER_PASSWORD)
}

async function signInFreshPatient(request: APIRequestContext): Promise<void> {
  const email = `availability-patient-${randomUUID()}@example.test`
  const password = 'PatientFixturePassword9'
  expect((await request.post('/api/auth/register', { data: { email, password } })).status()).toBe(201)
  await signIn(request, email, password)
}

async function saveAndReadResponse(page: Page): Promise<{
  requestBody: Record<string, unknown>
  responseBody: {
    removedOpenSlots: number
    generatedOpenSlots: number
    preservedOutOfHours: Array<{ patientRef: string; startsAt: string }>
  }
}> {
  const [request, response] = await Promise.all([
    page.waitForRequest((candidate) => candidate.method() === 'PATCH' && candidate.url().includes('/availability')),
    page.waitForResponse((candidate) => candidate.request().method() === 'PATCH' && candidate.url().includes('/availability')),
    page.getByRole('button', { name: 'Save availability' }).click(),
  ])
  expect(response.status()).toBe(200)
  return {
    requestBody: request.postDataJSON() as Record<string, unknown>,
    responseBody: await response.json(),
  }
}

test.describe.serial('provider availability', () => {
  test.beforeAll(acquireAvailabilityFixture)
  test.afterAll(async () => rm(AVAILABILITY_FIXTURE_LOCK, { recursive: true, force: true }))

  test.beforeEach(async ({ request }) => {
    await resetAvailability(request)
  })

  test('live check: saves full availability and renders the API response count and preserved appointment', async ({
    page,
  }) => {
    await signInProvider(page.request)
    await page.setViewportSize({ width: 390, height: 844 })
    const navigation = await page.goto('/provider/availability')
    expect(navigation?.status()).toBe(200)

    await expect(page.getByTestId('availability-form')).toBeVisible()
    await expect(page.getByText('America/Chicago', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Monday open')).toBeChecked()
    await page.getByLabel('Slot length in minutes').fill('30')
    await page.getByRole('button', { name: 'Add block' }).click()
    await page.getByLabel('Block 1 start').fill('2026-08-18T13:00:00-05:00')
    await page.getByLabel('Block 1 end').fill('2026-08-18T14:00:00-05:00')
    await page.getByLabel('Block 1 reason').fill('Team meeting')

    const firstSave = await saveAndReadResponse(page)
    expect(firstSave.requestBody).toMatchObject({
      slotMinutes: 30,
      workingHours: [{ weekday: 1, startsLocal: '09:00', endsLocal: '17:00' }],
      blocks: [
        {
          startsAt: '2026-08-18T13:00:00-05:00',
          endsAt: '2026-08-18T14:00:00-05:00',
          reason: 'Team meeting',
        },
      ],
    })
    await expect(
      page.getByText(`Saved. ${firstSave.responseBody.removedOpenSlots} open slots removed.`, { exact: true }),
    ).toBeVisible()

    await page.getByLabel('Monday end 1').fill('15:00')
    const collisionSave = await saveAndReadResponse(page)
    expect(collisionSave.requestBody).toMatchObject({
      workingHours: [{ weekday: 1, startsLocal: '09:00', endsLocal: '15:00' }],
    })
    expect(collisionSave.responseBody.preservedOutOfHours).toHaveLength(1)
    const collisionList = page.getByTestId('availability-collision-list')
    await expect(collisionList).toContainText('Mon 16:00')
    await expect(collisionList).toContainText('PT-4471')
    await expect(
      page.getByText(`Saved. ${collisionSave.responseBody.removedOpenSlots} open slots removed.`, { exact: true }),
    ).toBeVisible()

    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('Morgan Rivers')
    expect(bodyText).not.toContain('1988-03-14')
    expect(bodyText).not.toMatch(/conflict|edit rejected/i)
  })

  test('a server 422 keeps entered values and surfaces the server message for slot length and overlaps', async ({
    page,
  }) => {
    await signInProvider(page.request)
    await page.goto('/provider/availability')

    await page.getByLabel('Slot length in minutes').fill('45')
    await page.getByRole('button', { name: 'Save availability' }).click()
    await expect(page.locator('.pip-error')).toHaveText('The request could not be validated.')
    await expect(page.getByLabel('Slot length in minutes')).toHaveValue('45')

    await page.getByLabel('Slot length in minutes').fill('30')
    await page.getByRole('button', { name: 'Add Monday window' }).click()
    await page.getByLabel('Monday start 2').fill('10:00')
    await page.getByLabel('Monday end 2').fill('12:00')
    await page.getByRole('button', { name: 'Save availability' }).click()
    await expect(page.locator('.pip-error')).toHaveText('The request could not be validated.')
    await expect(page.getByLabel('Monday start 2')).toHaveValue('10:00')
  })

  test('an initial dependency failure replaces the form with a retryable error', async ({ page }) => {
    await signInProvider(page.request)
    let failNextLoad = true
    await page.route(`**/api/providers/${E2_PROVIDER_ID}/availability`, async (route) => {
      if (!failNextLoad) {
        await route.continue()
        return
      }
      failNextLoad = false
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'availability_unavailable',
          message: 'Availability is temporarily unavailable.',
        }),
      })
    })

    await page.goto('/provider/availability')
    const dependencyError = page.getByTestId('availability-load-error')
    await expect(dependencyError).toContainText('Availability is temporarily unavailable.')
    await expect(page.getByTestId('availability-form')).toHaveCount(0)
    await dependencyError.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByTestId('availability-form')).toBeVisible()
  })

  test('patient sessions and cross-provider reads cannot reach this provider page or data', async ({ page }) => {
    await signInFreshPatient(page.request)
    const patientNavigation = await page.goto('/provider/availability')
    expect(patientNavigation?.status()).toBe(404)
    await expect(page.getByTestId('availability-form')).toHaveCount(0)

    await page.context().clearCookies()
    await signInProvider(page.request)
    const foreign = await page.request.get(`/api/providers/${E2_OTHER_PROVIDER_ID}/availability`)
    expect(foreign.status()).toBe(404)
    const own = await page.request.get(`/api/providers/${E2_PROVIDER_ID}/availability`)
    expect(own.status()).toBe(200)
    expect(await own.json()).toMatchObject({ timeZone: 'America/Chicago' })
  })

  test('provider shell stays a sidebar at phone width and never renders the patient tab bar', async ({ page }) => {
    await signInProvider(page.request)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/provider/availability')

    await expect(page.getByTestId('provider-sidebar')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Schedule' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Availability' })).toBeVisible()
    await expect(page.getByTestId('patient-tabbar')).toHaveCount(0)
  })

  test('static adversarial guards: admin mapping, no hex literals, and no browser count derivation', async () => {
    const providerShell = await readFile(path.join(REPO_ROOT, 'components/shell/ProviderShell.tsx'), 'utf8')
    const providerLayout = await readFile(path.join(REPO_ROOT, 'app/(provider)/layout.tsx'), 'utf8')
    const availabilityPage = await readFile(path.join(REPO_ROOT, 'app/(provider)/provider/availability/page.tsx'), 'utf8')

    expect(providerShell).toContain("admin: [{ href: '/admin/audit', label: 'Audit log' }]")
    expect(providerShell).not.toMatch(/admin:\s*\[[^\]]*(?:Schedule|Availability)/)
    for (const [name, source] of [
      ['ProviderShell', providerShell],
      ['provider layout', providerLayout],
      ['availability page', availabilityPage],
    ] as const) {
      expect(source, name).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
    expect(availabilityPage).toMatch(/summary\.removedOpenSlots/)
    expect(availabilityPage).not.toMatch(/removedOpenSlots\s*[:=][^\n]*(?:filter|reduce|length|workingHours|blocks)/)
  })
})

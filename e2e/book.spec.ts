// JOR-253 — browser coverage for booking's ordering, conflict, and time-zone contract.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import { E2_BOOK_SERVICE_ID } from './fixtures/fake-auth-server'
import { acquireIdentityFixtureLock, IDENTITY_FIXTURE_HOOK_TIMEOUT_MS, releaseIdentityFixtureLock } from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'BookingPatientPassword9'
let lockToken: string | undefined

async function fixtureUrl(): Promise<string> {
  return (JSON.parse(await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')) as { url: string }).url
}

async function reset(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fixtureUrl()}/__test__/reset-identity`)).ok()).toBe(true)
  expect((await request.post(`${await fixtureUrl()}/__test__/reset-booking`)).ok()).toBe(true)
}

async function verifiedPatient(request: APIRequestContext): Promise<void> {
  const email = `booking-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await request.post('/api/identity/verify', { data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' } })).status()).toBe(200)
}

async function chooseFirstSlot(page: Page): Promise<void> {
  await page.goto('/book')
  await page.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
  await page.getByTestId('provider-select').selectOption({ label: 'Dr. Riley Patel' })
  await expect(page.getByTestId('slot-item').first()).toBeVisible()
  await page.getByTestId('slot-item').first().click()
}

async function bookingState(request: APIRequestContext): Promise<{ appointments: Array<{ slot_id: string }> }> {
  return (await (await request.get(`${await fixtureUrl()}/__test__/booking-state`)).json()) as { appointments: Array<{ slot_id: string }> }
}

test.describe.serial('JOR-253 /book', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    lockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(lockToken))
  test.beforeEach(async ({ request }) => {
    await reset(request)
    await verifiedPatient(request)
  })

  // Mandatory adversarial: Another session books a slot between render and confirm: EC-7 and no second appointment.
  test('anotherSessionBooksBetweenRenderAndConfirmShowsEc7AndNoSecondAppointment', async ({ page }) => {
    await chooseFirstSlot(page)
    const slotId = (await page.getByTestId('slot-item').first().getAttribute('data-slot-id')) ?? ''
    expect((await page.request.post(`${await fixtureUrl()}/__test__/book-slot`, { data: { slotId } })).status()).toBe(201)
    await page.getByTestId('book-submit').click()
    await expect(page.getByTestId('booking-conflict')).toHaveText('That slot is no longer available. Someone booked it moments ago. Please choose another time.')
    await expect(page.getByTestId('slot-item').first()).toBeDisabled()
    expect((await bookingState(page.request)).appointments).toHaveLength(1)
  })

  // Mandatory adversarial: Two rapid confirms: one appointment.
  test('twoRapidConfirmsReuseOneIdempotencyKeyAndCreateOneAppointment', async ({ page }) => {
    await chooseFirstSlot(page)
    await Promise.all([page.getByTestId('book-submit').click(), page.getByTestId('book-submit').click()])
    await expect(page.getByTestId('booking-success')).toBeVisible()
    expect((await bookingState(page.request)).appointments).toHaveLength(1)
  })

  test('idempotencyKeyReusedIsDistinctFromTheLoserMessage', async ({ page }) => {
    await page.route('**/api/appointments', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'idempotency_key_reused', message: 'That request key was already used for a different slot.' }),
    }))
    await chooseFirstSlot(page)
    await page.getByTestId('book-submit').click()
    await expect(page.getByRole('alert')).toContainText('This confirmation key was already used. Choose a slot again.')
    await expect(page.getByTestId('booking-conflict')).toHaveCount(0)
  })

  // Mandatory adversarial: Availability regeneration after listing: no crash or booking nonexistent slot.
  test('availabilityRegenerationAfterListingDoesNotBookNonexistentSlot', async ({ page }) => {
    await chooseFirstSlot(page)
    await page.request.post(`${await fixtureUrl()}/__test__/reset-booking`)
    await page.getByTestId('book-submit').click()
    await expect(page.getByTestId('booking-conflict')).toBeVisible()
    expect((await bookingState(page.request)).appointments).toHaveLength(0)
  })

  // Mandatory adversarial: slots: [].
  test('emptySlotsRendersCleanState', async ({ page }) => {
    await page.route('**/api/slots?**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ slots: [] }) }))
    await page.goto('/book')
    await page.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
    await page.getByTestId('provider-select').selectOption({ label: 'Dr. Riley Patel' })
    await expect(page.getByTestId('slot-empty')).toBeVisible()
  })

  // Mandatory adversarial: A service with no providers.
  test('serviceWithNoProvidersRendersCleanState', async ({ page }) => {
    await page.goto('/book')
    await page.getByTestId('service-select').selectOption('88778877-8877-4877-8877-887788778877')
    await expect(page.getByTestId('provider-empty')).toBeVisible()
  })

  // Mandatory adversarial: Viewer zone differs from provider zone: every rendered time has an abbreviation.
  test('viewerZoneDiffersFromProviderZoneAndEveryRenderedTimeHasAbbreviation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await chooseFirstSlot(page)
    for (const text of await page.getByTestId('slot-item').allTextContents()) expect(text).toMatch(/\b(?:[A-Z]{2,4}|GMT[+-]\d+)\b/)
    await expect(page.getByText('Provider time zone: America/New_York.')).toBeVisible()
    const first = page.getByTestId('slot-item').first()
    expect((await first.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  })

  test('serviceSelectionNarrowsProvidersWithoutFilteringSelectedProviderSlots', async ({ page }) => {
    await chooseFirstSlot(page)
    const slotCount = await page.getByTestId('slot-item').count()
    await page.getByTestId('service-select').selectOption('77887788-7788-4788-8788-778877887788')
    await expect(page.getByTestId('slot-item')).toHaveCount(slotCount)
  })

  test('liveCheckBooksOpenSlotAndNextRenderRemovesIt', async ({ page }) => {
    await chooseFirstSlot(page)
    const bookedSlotId = (await page.getByTestId('slot-item').first().getAttribute('data-slot-id')) ?? ''
    await page.getByTestId('book-submit').click()
    await expect(page.getByTestId('booking-success')).toContainText('Dr. Riley Patel')
    await page.reload()
    await page.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
    await page.getByTestId('provider-select').selectOption({ label: 'Dr. Riley Patel' })
    await expect(page.locator(`[data-slot-id="${bookedSlotId}"]`)).toHaveCount(0)
  })
})

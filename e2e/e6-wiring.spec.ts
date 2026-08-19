// JOR-240 — E6's live availability wiring proof. This spec follows the real
// page -> route -> scheduling module -> committed fake Supabase fixture path.
// JOR-242 remains the DST proof; JOR-202, JOR-198, and JOR-225 remain the
// slot-generation and appointment-preservation domain proofs.
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  E2_OTHER_PROVIDER_EMAIL,
  E2_PROVIDER_EMAIL,
  E2_PROVIDER_ID,
  E2_PROVIDER_PASSWORD,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'
import { toLocal, toRfc3339, zonedTimeToInstant } from '../lib/time/zones'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PROVIDER_TIME_ZONE = 'America/Chicago'
const today = new Date(`${toLocal(PROVIDER_TIME_ZONE, new Date()).date}T00:00:00Z`)
today.setUTCDate(today.getUTCDate() + ((9 - today.getUTCDay()) % 7 || 7))
const blockDate = today.toISOString().slice(0, 10)
const BLOCK = {
  startsAt: toRfc3339(PROVIDER_TIME_ZONE, zonedTimeToInstant(PROVIDER_TIME_ZONE, blockDate, '13:00')),
  endsAt: toRfc3339(PROVIDER_TIME_ZONE, zonedTimeToInstant(PROVIDER_TIME_ZONE, blockDate, '14:00')),
  reason: 'E6 in-window meeting',
} as const
const WIDE_HOURS = [
  { weekday: 1, startsLocal: '08:00', endsLocal: '18:00' },
  { weekday: 2, startsLocal: '09:00', endsLocal: '17:00' },
] as const
const NARROWED_HOURS = [
  { weekday: 1, startsLocal: '08:00', endsLocal: '15:00' },
  { weekday: 2, startsLocal: '09:00', endsLocal: '17:00' },
] as const
const PRESERVED_APPOINTMENT = {
  appointmentId: '33773377-3377-4377-8377-337733773377',
  startsAt: '2026-08-17T16:00:00-05:00',
  endsAt: '2026-08-17T16:30:00-05:00',
  patientRef: 'PT-4471',
} as const

type Availability = {
  timeZone: string
  slotMinutes: number
  workingHours: Array<{ weekday: number; startsLocal: string; endsLocal: string }>
  blocks: Array<{ id: string; startsAt: string; endsAt: string; reason: string | null }>
}

type SaveSummary = {
  removedOpenSlots: number
  generatedOpenSlots: number
  preservedOutOfHours: Array<{
    appointmentId: string
    startsAt: string
    endsAt: string
    patientRef: string
  }>
}

let identityFixtureLockToken: string | undefined

async function fakeAuthServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetAvailability(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeAuthServerUrl()}/__test__/reset-availability`)
  expect(response.status()).toBe(200)
}

async function signIn(request: APIRequestContext, email: string): Promise<void> {
  const response = await request.post('/api/auth/login', {
    data: { email, password: E2_PROVIDER_PASSWORD },
  })
  expect(response.status()).toBe(200)
}

async function saveAvailability(page: Page): Promise<{
  requestBody: Record<string, unknown>
  responseBody: SaveSummary
}> {
  const responsePromise = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'PATCH' &&
      new URL(candidate.url()).pathname === `/api/providers/${E2_PROVIDER_ID}/availability`,
  )
  await page.getByRole('button', { name: 'Save availability' }).click()
  const response = await responsePromise
  expect(response.status(), await response.text()).toBe(200)
  return {
    requestBody: response.request().postDataJSON() as Record<string, unknown>,
    responseBody: (await response.json()) as SaveSummary,
  }
}

test.describe.serial('JOR-240 E6 availability wiring', () => {
  // Availability reads append audit events to the same mutable fixture state
  // used by the other identity-aware suites, so E6 takes the shared lease.
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetAvailability(request))

  test('acceptance + mandatory adversarial: availabilityRoundTripRejectsWrongZoneLostStateNoSlotReductionAndBookedIdentityMutationOrPhiLeak', async function availabilityRoundTripRejectsWrongZoneLostStateNoSlotReductionAndBookedIdentityMutationOrPhiLeak({
    page,
  }) {
    await signIn(page.request, E2_PROVIDER_EMAIL)
    const navigation = await page.goto('/provider/availability')
    expect(navigation?.status()).toBe(200)
    await expect(page.getByTestId('availability-form')).toBeVisible()
    await expect(page.locator('.pip-time-zone')).toHaveText('Time zone: America/Chicago')

    await page.getByLabel('Slot length in minutes').fill('20')
    await page.getByLabel('Monday start 1').fill('08:00')
    await page.getByLabel('Monday end 1').fill('18:00')
    await page.getByLabel('Tuesday open').check()

    const withoutBlock = await saveAvailability(page)
    expect(withoutBlock.requestBody).toEqual({
      slotMinutes: 20,
      workingHours: WIDE_HOURS,
      blocks: [],
    })
    expect(withoutBlock.responseBody.generatedOpenSlots).toBeGreaterThan(0)
    expect(withoutBlock.responseBody.preservedOutOfHours).toEqual([])

    await page.getByRole('button', { name: 'Add block' }).click()
    await page.getByLabel('Block 1 start').fill(BLOCK.startsAt)
    await page.getByLabel('Block 1 end').fill(BLOCK.endsAt)
    await page.getByLabel('Block 1 reason').fill(BLOCK.reason)
    const withBlock = await saveAvailability(page)
    expect(withBlock.requestBody).toEqual({
      slotMinutes: 20,
      workingHours: WIDE_HOURS,
      blocks: [BLOCK],
    })
    expect(withBlock.responseBody.generatedOpenSlots).toBeLessThan(withoutBlock.responseBody.generatedOpenSlots)
    await expect(
      page.getByText(`Saved. ${withBlock.responseBody.removedOpenSlots} open slots removed.`, { exact: true }),
    ).toBeVisible()

    const roundTripResponse = await page.request.get(`/api/providers/${E2_PROVIDER_ID}/availability`)
    expect(roundTripResponse.status()).toBe(200)
    expect((await roundTripResponse.json()) as Availability).toEqual({
      timeZone: 'America/Chicago',
      slotMinutes: 20,
      workingHours: WIDE_HOURS,
      blocks: [
        {
          id: `availability-block-${E2_PROVIDER_ID}-0`,
          ...BLOCK,
        },
      ],
    })

    await page.getByLabel('Monday end 1').fill('15:00')
    const narrowed = await saveAvailability(page)
    expect(narrowed.requestBody).toEqual({
      slotMinutes: 20,
      workingHours: NARROWED_HOURS,
      blocks: [BLOCK],
    })
    expect(narrowed.responseBody).toEqual({
      removedOpenSlots: withBlock.responseBody.generatedOpenSlots,
      generatedOpenSlots: expect.any(Number),
      preservedOutOfHours: [PRESERVED_APPOINTMENT],
    })
    expect(narrowed.responseBody.generatedOpenSlots).toBeGreaterThan(0)

    await expect(page.getByText('These booked appointments are now outside your hours and have been kept:')).toBeVisible()
    await expect(page.getByTestId('availability-collision-list')).toHaveText('Mon 16:00 · PT-4471')
    const renderedPage = await page.locator('body').innerText()
    expect(renderedPage).not.toContain('Morgan Rivers')
    expect(renderedPage).not.toContain('1988-03-14')
  })

  test('acceptance + mandatory adversarial: providerOwnershipRejectsCrossProviderReadsAndEditsWhileOwnerCanRead', async function providerOwnershipRejectsCrossProviderReadsAndEditsWhileOwnerCanRead({
    page,
  }) {
    const availabilityPath = `/api/providers/${E2_PROVIDER_ID}/availability`
    const seededAvailability = {
      timeZone: 'America/Chicago',
      slotMinutes: 30,
      workingHours: [{ weekday: 1, startsLocal: '09:00', endsLocal: '17:00' }],
      blocks: [],
    }

    await signIn(page.request, E2_PROVIDER_EMAIL)
    const ownerReadBefore = await page.request.get(availabilityPath)
    expect(ownerReadBefore.status()).toBe(200)
    expect(await ownerReadBefore.json()).toEqual(seededAvailability)

    await page.context().clearCookies()
    await signIn(page.request, E2_OTHER_PROVIDER_EMAIL)
    const deniedRead = await page.request.get(availabilityPath)
    expect(deniedRead.status()).toBe(404)
    expect(await deniedRead.json()).toEqual({
      error: 'not_found',
      message: 'The requested resource was not found.',
    })
    const deniedEdit = await page.request.patch(availabilityPath, {
      data: {
        slotMinutes: 20,
        workingHours: WIDE_HOURS,
        blocks: [BLOCK],
      },
    })
    expect(deniedEdit.status()).toBe(404)
    expect(await deniedEdit.json()).toEqual({
      error: 'not_found',
      message: 'The requested resource was not found.',
    })

    await page.context().clearCookies()
    await signIn(page.request, E2_PROVIDER_EMAIL)
    const ownerReadAfter = await page.request.get(availabilityPath)
    expect(ownerReadAfter.status()).toBe(200)
    expect(await ownerReadAfter.json()).toEqual(seededAvailability)
  })
})

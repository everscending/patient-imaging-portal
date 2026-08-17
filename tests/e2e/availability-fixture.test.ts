// JOR-284 — contract tests for the shared live Supabase fixture. These stay
// below the page/API layer so JOR-223 can consume the fixture unchanged.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  E2_OTHER_PROVIDER_EMAIL,
  E2_PROVIDER_ACCOUNT_ID,
  E2_PROVIDER_EMAIL,
  E2_PROVIDER_ID,
  E2_PROVIDER_PASSWORD,
  startFakeAuthServer,
} from '../../e2e/fixtures/fake-auth-server'
import type { FakeAuthServer } from '../../e2e/fixtures/fake-auth-server'

let fixture: FakeAuthServer

async function providerToken(email: string): Promise<string> {
  const response = await fetch(`${fixture.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: E2_PROVIDER_PASSWORD }),
  })
  expect(response.status).toBe(200)
  return (await response.json() as { access_token: string }).access_token
}

function request(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${fixture.url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  })
}

async function apply(token: string, body: Record<string, unknown>): Promise<Response> {
  return request('/rest/v1/rpc/apply_provider_availability', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ownAvailability = {
  p_provider_id: E2_PROVIDER_ID,
  p_actor_user_id: E2_PROVIDER_ACCOUNT_ID,
  p_slot_minutes: 45,
  p_working_hours: [{ weekday: 1, startsLocal: '09:00', endsLocal: '15:00' }],
  p_blocks: [{ startsAt: '2026-08-18T13:00:00-05:00', endsAt: '2026-08-18T14:00:00-05:00', reason: 'Team meeting' }],
}

describe('JOR-284 shared provider availability fixture', () => {
  beforeAll(async () => {
    fixture = await startFakeAuthServer()
  })
  afterAll(async () => fixture.close())
  beforeEach(async () => {
    const response = await fetch(`${fixture.url}/__test__/reset-availability`, { method: 'POST' })
    expect(response.status).toBe(200)
  })

  test('crossProviderAvailabilityAccessIsDeniedWithoutOwnerData', async () => {
    const otherToken = await providerToken(E2_OTHER_PROVIDER_EMAIL)
    const read = await request(`/rest/v1/providers?id=eq.${E2_PROVIDER_ID}`, otherToken)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual([])

    const hours = await request(`/rest/v1/working_hours?provider_id=eq.${E2_PROVIDER_ID}`, otherToken)
    expect(await hours.json()).toEqual([])
    const blocks = await request(`/rest/v1/availability_blocks?provider_id=eq.${E2_PROVIDER_ID}`, otherToken)
    expect(await blocks.json()).toEqual([])

    const write = await apply(otherToken, ownAvailability)
    expect(write.status).toBe(403)
    const error = await write.text()
    expect(error).not.toContain('Dr. Avery Chen')
    expect(error).not.toContain(E2_PROVIDER_ID)

    const ownToken = await providerToken(E2_PROVIDER_EMAIL)
    const ownHours = await request(`/rest/v1/working_hours?provider_id=eq.${E2_PROVIDER_ID}`, ownToken)
    expect(await ownHours.json()).toEqual([{ provider_id: E2_PROVIDER_ID, weekday: 1, starts_local: '09:00:00', ends_local: '17:00:00' }])
  })

  test('narrowedHoursPreserveBookedAppointmentWithReferenceOnlyAndDeterministicCounts', async () => {
    const token = await providerToken(E2_PROVIDER_EMAIL)
    const first = await apply(token, { ...ownAvailability, p_slots: ['[first)', '[second)'] })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual([
      {
        removed_open_slots: 0,
        generated_open_slots: 2,
        preserved_out_of_hours: [
          {
            appointmentId: '33773377-3377-4377-8377-337733773377',
            startsAt: '2026-08-17T16:00:00-05:00',
            endsAt: '2026-08-17T16:30:00-05:00',
            patientRef: 'PT-4471',
          },
        ],
      },
    ])

    const retry = await apply(token, { ...ownAvailability, p_slots: ['[second)'] })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject([{ removed_open_slots: 2, generated_open_slots: 1 }])

    const blocks = await request(`/rest/v1/availability_blocks?provider_id=eq.${E2_PROVIDER_ID}`, token)
    expect(await blocks.json()).toEqual([
      expect.objectContaining({
        id: `availability-block-${E2_PROVIDER_ID}-0`,
        provider_id: E2_PROVIDER_ID,
        reason: 'Team meeting',
      }),
    ])

    const provider = await request(`/rest/v1/providers?id=eq.${E2_PROVIDER_ID}`, token)
    expect(await provider.json()).toEqual([
      expect.objectContaining({ id: E2_PROVIDER_ID, slot_minutes: 45 }),
    ])
  })

  test('unknownProviderActorCannotApplyAvailability', async () => {
    const token = await providerToken(E2_PROVIDER_EMAIL)
    const rejected = await apply(token, {
      ...ownAvailability,
      p_actor_user_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(rejected.status).toBe(403)

    const provider = await request(`/rest/v1/providers?id=eq.${E2_PROVIDER_ID}`, token)
    expect(await provider.json()).toEqual([
      expect.objectContaining({ id: E2_PROVIDER_ID, slot_minutes: 30 }),
    ])
  })
})

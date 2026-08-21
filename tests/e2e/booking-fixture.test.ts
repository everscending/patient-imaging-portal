import { afterEach, expect, test, vi } from 'vitest'

import {
  E2_OTHER_PROVIDER_ID,
  E2_PROVIDER_ID,
  startFakeAuthServer,
  type FakeAuthServer,
} from '../../e2e/fixtures/fake-auth-server'

const INSIDE_NOTICE_APPOINTMENT_ID = '22552255-2255-4255-8255-225522552255'
let fixture: FakeAuthServer | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
  vi.restoreAllMocks()
})

test('ordinary mobile booking fixture has a wide day in every supported viewer time zone', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-20T07:12:00.000Z'))
  fixture = await startFakeAuthServer()
  const state = await fetch(`${fixture.url}/__test__/booking-state`).then((response) => response.json()) as {
    slots: Array<{ provider_id: string; starts_at: string }>
  }
  const slots = state.slots.filter(({ provider_id }) => provider_id === E2_OTHER_PROVIDER_ID)

  expect(slots).toHaveLength(5)
  for (const timeZone of Intl.supportedValuesOf('timeZone')) {
    const days = slots.map(({ starts_at }) =>
      new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone }).format(new Date(starts_at)),
    )
    const largestDay = Math.max(...[...new Set(days)].map((day) => days.filter((candidate) => candidate === day).length))
    expect(largestDay, timeZone).toBeGreaterThanOrEqual(3)
  }
})

test.each(['reschedule_appointment', 'cancel_appointment'] as const)(
  '%s rejects a patient change at the exact 24-hour notice boundary',
  async (rpc) => {
    fixture = await startFakeAuthServer()
    const signup = await fetch(`${fixture.url}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${rpc}@example.test`, password: 'BoundaryPassword9' }),
    })
    const session = await signup.json() as { access_token: string; user: { id: string } }
    const headers = {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    }
    const patients = await fetch(`${fixture.url}/rest/v1/patients?patient_ref=eq.PT-4471`, { headers })
      .then((response) => response.json()) as Array<{ id: string }>
    expect(await fetch(`${fixture.url}/rest/v1/rpc/link_patient_identity`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_patient_id: patients[0]!.id,
        p_caller_id: session.user.id,
        p_attempted_patient_ref: 'PT-4471',
        p_source_ref: 'booking-fixture-test',
        p_attempted_at: new Date().toISOString(),
      }),
    }).then((response) => response.json())).toBe('linked_now')

    const appointments = await fetch(
      `${fixture.url}/rest/v1/appointments?id=eq.${INSIDE_NOTICE_APPOINTMENT_ID}`,
      { headers },
    ).then((response) => response.json()) as Array<{ slots: { starts_at: string } }>
    const booking = await fetch(`${fixture.url}/__test__/booking-state`).then((response) => response.json()) as {
      slots: Array<{ id: string; provider_id: string; starts_at: string }>
    }
    const target = booking.slots.find(({ provider_id, starts_at }) =>
      provider_id === E2_PROVIDER_ID && Date.parse(starts_at) > Date.now(),
    )!
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse(appointments[0]!.slots.starts_at) - 24 * 60 * 60 * 1_000,
    )

    const response = await fetch(`${fixture.url}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_appointment_id: INSIDE_NOTICE_APPOINTMENT_ID,
        p_actor_user_id: session.user.id,
        p_minimum_notice: '24 hours',
        ...(rpc === 'reschedule_appointment' ? { p_slot_id: target.id } : {}),
      }),
    })
    expect(await response.json()).toEqual([{ result_error: 'minimum_notice' }])
  },
)

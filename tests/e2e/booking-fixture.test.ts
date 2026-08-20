import { afterEach, expect, test, vi } from 'vitest'

import { startFakeAuthServer, type FakeAuthServer } from '../../e2e/fixtures/fake-auth-server'

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
    slots: Array<{ starts_at: string }>
  }

  expect(state.slots).toHaveLength(5)
  for (const timeZone of Intl.supportedValuesOf('timeZone')) {
    const days = state.slots.map(({ starts_at }) =>
      new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone }).format(new Date(starts_at)),
    )
    const largestDay = Math.max(...[...new Set(days)].map((day) => days.filter((candidate) => candidate === day).length))
    expect(largestDay, timeZone).toBeGreaterThanOrEqual(3)
  }
})

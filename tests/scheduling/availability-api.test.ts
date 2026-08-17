import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { guardMock, callerMock, getMock, applyMock, actorMock } = vi.hoisted(() => ({
  guardMock: vi.fn(),
  callerMock: vi.fn(),
  getMock: vi.fn(),
  applyMock: vi.fn(),
  actorMock: vi.fn(),
}))

class FakeAvailabilityValidationError extends Error {}

vi.mock('../../lib/access/guard', () => ({ guardPhiAccess: guardMock, resolveScheduleActor: actorMock }))
vi.mock('../../lib/access/identity', () => ({ resolveCallerId: callerMock }))
vi.mock('../../lib/scheduling/availability', () => ({
  getAvailability: getMock,
  applyAvailability: applyMock,
  AvailabilityValidationError: FakeAvailabilityValidationError,
}))

const PROVIDER_ID = '11111111-1111-4111-8111-111111111111'
const CALLER_ID = '22222222-2222-4222-8222-222222222222'
const context = { params: Promise.resolve({ providerId: PROVIDER_ID }) }

let route: typeof import('../../app/api/providers/[providerId]/availability/route')

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test-project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')
  vi.stubEnv('SOURCE_REF_SALT', 'test-source-ref-salt')
  route = await import('../../app/api/providers/[providerId]/availability/route')
})

afterAll(() => vi.unstubAllEnvs())

beforeEach(() => {
  vi.clearAllMocks()
  callerMock.mockResolvedValue(CALLER_ID)
  guardMock.mockResolvedValue({ ok: true, patientId: null })
  actorMock.mockResolvedValue({ kind: 'provider', userId: CALLER_ID })
})

function patchRequest(body: unknown): Request {
  return new Request(`http://localhost/api/providers/${PROVIDER_ID}/availability`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validBody = {
  slotMinutes: 30,
  workingHours: [{ weekday: 1, startsLocal: '09:00', endsLocal: '17:00' }],
  blocks: [{ startsAt: '2026-08-17T12:00:00-05:00', endsAt: '2026-08-17T13:00:00-05:00', reason: 'meeting' }],
}

describe('GET /api/providers/:providerId/availability', () => {
  test('returns the exact availability wire shape after the schedule guard grants access', async () => {
    const payload = { timeZone: 'America/Chicago', slotMinutes: 30, workingHours: validBody.workingHours, blocks: [] }
    getMock.mockResolvedValue(payload)
    const response = await route.GET(new Request('http://localhost'), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(payload)
    expect(guardMock).toHaveBeenCalledWith(
      { kind: 'provider', userId: CALLER_ID },
      { kind: 'schedule', id: PROVIDER_ID },
      'schedule.view',
    )
  })

  test('another provider or patient actor is indistinguishable from a missing provider', async () => {
    guardMock.mockResolvedValue({ ok: false, status: 404 })
    const response = await route.GET(new Request('http://localhost'), context)
    expect(response.status).toBe(404)
    expect(getMock).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/providers/:providerId/availability', () => {
  test('returns 200 with accept-and-flag counts and preserved patient references only', async () => {
    const result = {
      removedOpenSlots: 14,
      generatedOpenSlots: 22,
      preservedOutOfHours: [{
        appointmentId: '33333333-3333-4333-8333-333333333333',
        startsAt: '2026-08-17T10:00:00-05:00',
        endsAt: '2026-08-17T10:30:00-05:00',
        patientRef: 'PT-0001',
      }],
    }
    applyMock.mockResolvedValue(result)
    const response = await route.PATCH(patchRequest(validBody), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(applyMock).toHaveBeenCalledWith({ providerId: PROVIDER_ID, actorUserId: CALLER_ID, ...validBody })
  })

  test('out_of_hours is never accepted from the caller', async () => {
    const response = await route.PATCH(patchRequest({ ...validBody, out_of_hours: true }), context)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
    expect(applyMock).not.toHaveBeenCalled()
  })

  test('a no-session request is 401 before actor resolution or the PHI guard', async () => {
    callerMock.mockResolvedValue(null)
    guardMock.mockResolvedValue({ ok: false, status: 401 })
    const response = await route.PATCH(patchRequest(validBody), context)
    expect(response.status).toBe(401)
    expect(actorMock).not.toHaveBeenCalled()
    expect(guardMock).not.toHaveBeenCalled()
    expect(applyMock).not.toHaveBeenCalled()
  })

  test('authorization is resolved before a malformed body is disclosed', async () => {
    callerMock.mockResolvedValue(null)
    guardMock.mockResolvedValue({ ok: false, status: 401 })
    const response = await route.PATCH(patchRequest({ out_of_hours: true }), context)
    expect(response.status).toBe(401)
    expect(actorMock).not.toHaveBeenCalled()
    expect(guardMock).not.toHaveBeenCalled()
    expect(applyMock).not.toHaveBeenCalled()
  })

  test('DST-incompatible slot lengths are a generic 422 with no database detail', async () => {
    applyMock.mockRejectedValue(new FakeAvailabilityValidationError())
    const response = await route.PATCH(patchRequest({ ...validBody, slotMinutes: 45 }), context)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
  })
})

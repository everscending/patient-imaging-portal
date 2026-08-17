import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { guardMock, actorMock, callerMock, bookMock, listMock, rescheduleMock, cancelMock, transitionMock } = vi.hoisted(() => ({
  guardMock: vi.fn(), actorMock: vi.fn(), callerMock: vi.fn(), bookMock: vi.fn(), listMock: vi.fn(),
  rescheduleMock: vi.fn(), cancelMock: vi.fn(), transitionMock: vi.fn(),
}))
vi.mock('../../lib/access/guard', () => ({ guardPhiAccess: guardMock, resolveScheduleActor: actorMock }))
vi.mock('../../lib/access/identity', () => ({ resolveCallerId: callerMock }))
vi.mock('../../lib/scheduling/booking', () => ({
  bookForActor: bookMock, listAppointments: listMock, reschedule: rescheduleMock, cancel: cancelMock, transition: transitionMock,
}))

const ID = '11111111-1111-4111-8111-111111111111'
const SLOT = '22222222-2222-4222-8222-222222222222'
const SERVICE = '33333333-3333-4333-8333-333333333333'
const ACTOR = '44444444-4444-4444-8444-444444444444'
const context = { params: Promise.resolve({ id: ID }) }
const dto = { id: ID, startsAt: '2030-01-01T09:00:00-06:00', endsAt: '2030-01-01T10:00:00-06:00', status: 'requested', providerName: 'Dr. A', serviceName: 'MRI', outOfHours: false, canChange: true, changeDeadline: '2029-12-31T09:00:00-06:00', allowedTransitions: ['cancelled'] }
let collection: typeof import('../../app/api/appointments/route')
let item: typeof import('../../app/api/appointments/[id]/route')

function request(body: unknown): Request {
  return new Request('http://localhost/api/appointments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
function patch(body: unknown): Request {
  return new Request(`http://localhost/api/appointments/${ID}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test-project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')
  vi.stubEnv('SOURCE_REF_SALT', 'test-source-ref-salt')
  collection = await import('../../app/api/appointments/route')
  item = await import('../../app/api/appointments/[id]/route')
})
afterAll(() => vi.unstubAllEnvs())
beforeEach(() => {
  vi.clearAllMocks(); callerMock.mockResolvedValue(ACTOR); actorMock.mockResolvedValue({ kind: 'patient', userId: ACTOR }); guardMock.mockResolvedValue({ ok: true, patientId: 'patient' })
  bookMock.mockResolvedValue({ ok: true, appointment: dto, reused: false }); listMock.mockResolvedValue([dto]); rescheduleMock.mockResolvedValue({ ok: true, appointment: dto }); cancelMock.mockResolvedValue({ ok: true, appointment: { ...dto, status: 'cancelled', allowedTransitions: [] } }); transitionMock.mockResolvedValue({ ok: true, appointment: dto })
})

describe('POST /api/appointments', () => {
  test('missing_nonUuid_oversized_idempotency_key_are_validation_failed', async () => {
    for (const key of [undefined, 'not-a-uuid', 'a'.repeat(65537)]) {
      const body = { slotId: SLOT, serviceId: SERVICE, ...(key === undefined ? {} : { idempotencyKey: key }) }
      const response = await collection.POST(request(body)); expect(response.status).toBe(422)
    }
    expect(bookMock).not.toHaveBeenCalled()
  })
  test('forged_patientId_is_validation_failed', async () => {
    const response = await collection.POST(request({ slotId: SLOT, serviceId: SERVICE, idempotencyKey: ID, patientId: ID }))
    expect(response.status).toBe(422); expect(bookMock).not.toHaveBeenCalled()
  })
  test('book_result_errors_map_to_their_pinned_status_and_envelope', async () => {
    const cases = [
      ['slot_unavailable', 409, 'That slot is no longer available.'],
      ['idempotency_key_reused', 409, 'That request key was already used for a different slot.'],
      ['service_not_offered', 422, 'This provider does not offer that service.'],
    ] as const
    for (const [error, status, message] of cases) {
      bookMock.mockResolvedValueOnce({ ok: false, error })
      const response = await collection.POST(request({ slotId: SLOT, serviceId: SERVICE, idempotencyKey: ID }))
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error, message })
    }
  })
  test('concurrent_same_key_same_slot_post_produces_201_then_200_and_no_route_booking_audit', async () => {
    bookMock.mockResolvedValueOnce({ ok: true, appointment: dto, reused: false }).mockResolvedValueOnce({ ok: true, appointment: dto, reused: true })
    const body = { slotId: SLOT, serviceId: SERVICE, idempotencyKey: ID }
    const [one, two] = await Promise.all([collection.POST(request(body)), collection.POST(request(body))])
    expect([one.status, two.status].sort()).toEqual([200, 201])
    expect(await one.json()).toEqual({ id: ID, slotId: SLOT, startsAt: dto.startsAt, endsAt: dto.endsAt, status: 'requested', providerName: 'Dr. A', serviceName: 'MRI' })
    expect(await two.json()).toEqual({ id: ID, slotId: SLOT, startsAt: dto.startsAt, endsAt: dto.endsAt, status: 'requested', providerName: 'Dr. A', serviceName: 'MRI' })
    expect(bookMock).toHaveBeenCalledTimes(2) // booking.ts, never this route, owns booking audit rows
  })
})

describe('GET /api/appointments', () => {
  test('get_ten_rows_creates_one_collection_guard_audit_row', async () => {
    listMock.mockResolvedValue(Array.from({ length: 10 }, () => dto)); const response = await collection.GET()
    expect(response.status).toBe(200); expect(guardMock).toHaveBeenCalledOnce(); expect(guardMock).toHaveBeenCalledWith({ kind: 'patient', userId: ACTOR }, { kind: 'collection', of: 'appointment' }, 'appointment.view')
    expect(await response.json()).toEqual({ appointments: Array.from({ length: 10 }, () => dto) })
  })
  test('get_zero_rows_still_creates_one_collection_guard_audit_row', async () => {
    listMock.mockResolvedValue([]); const response = await collection.GET(); expect(response.status).toBe(200); expect(guardMock).toHaveBeenCalledOnce()
    expect(await response.json()).toEqual({ appointments: [] })
  })
})

describe('PATCH /api/appointments/:id', () => {
  test('cancelled_transition_and_missing_transition_status_are_validation_failed', async () => {
    for (const body of [{ action: 'transition', status: 'cancelled' }, { action: 'transition' }]) expect((await item.PATCH(patch(body), context)).status).toBe(422)
    expect(transitionMock).not.toHaveBeenCalled()
  })
  test('multiple_or_unknown_actions_and_reschedule_slotId_missing_are_validation_failed', async () => {
    for (const body of [{ action: 'cancel', slotId: SLOT }, { action: 'unknown' }, { action: 'reschedule' }]) expect((await item.PATCH(patch(body), context)).status).toBe(422)
  })
  test('cross_patient_patch_is_404_before_domain_call', async () => {
    guardMock.mockResolvedValue({ ok: false, status: 404 }); expect((await item.PATCH(patch({ action: 'cancel' }), context)).status).toBe(404); expect(cancelMock).not.toHaveBeenCalled()
  })
  test('patient_requested_to_confirmed_uses_pinned_invalid_transition_copy', async () => {
    transitionMock.mockResolvedValue({ ok: false, error: 'invalid_transition' }); const response = await item.PATCH(patch({ action: 'transition', status: 'confirmed' }), context)
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ error: 'invalid_transition', message: "That change is not allowed from this appointment's current status." })
  })
  test('change_result_errors_map_to_their_pinned_status_and_envelope', async () => {
    const cases = [
      ['slot_unavailable', 409, 'That slot is no longer available.'],
      ['minimum_notice', 422, 'Changes are not allowed within 24 hours of the appointment.'],
      ['not_reschedulable', 422, 'This appointment can no longer be changed.'],
    ] as const
    for (const [error, status, message] of cases) {
      rescheduleMock.mockResolvedValueOnce({ ok: false, error })
      const response = await item.PATCH(patch({ action: 'reschedule', slotId: SLOT }), context)
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error, message })
    }
  })
  test('successful_cancel_returns_the_complete_list_dto', async () => {
    const response = await item.PATCH(patch({ action: 'cancel' }), context)
    expect(await response.json()).toEqual({ ...dto, status: 'cancelled', allowedTransitions: [] })
  })
})

describe('identity and authorization dependency failures', () => {
  const cases = [
    {
      name: 'POST identity',
      fail: () => callerMock.mockRejectedValueOnce(new Error('identity unavailable')),
      invoke: () => collection.POST(request({ slotId: SLOT, serviceId: SERVICE, idempotencyKey: ID })),
      envelope: { error: 'booking_unavailable', message: 'Booking is temporarily unavailable.' },
    },
    {
      name: 'GET identity',
      fail: () => callerMock.mockRejectedValueOnce(new Error('identity unavailable')),
      invoke: () => collection.GET(),
      envelope: { error: 'appointments_unavailable', message: 'Appointments are temporarily unavailable.' },
    },
    {
      name: 'GET actor resolution',
      fail: () => actorMock.mockRejectedValueOnce(new Error('membership unavailable')),
      invoke: () => collection.GET(),
      envelope: { error: 'appointments_unavailable', message: 'Appointments are temporarily unavailable.' },
    },
    {
      name: 'GET PHI guard',
      fail: () => guardMock.mockRejectedValueOnce(new Error('audit unavailable')),
      invoke: () => collection.GET(),
      envelope: { error: 'appointments_unavailable', message: 'Appointments are temporarily unavailable.' },
    },
    {
      name: 'PATCH identity',
      fail: () => callerMock.mockRejectedValueOnce(new Error('identity unavailable')),
      invoke: () => item.PATCH(patch({ action: 'cancel' }), context),
      envelope: { error: 'appointments_unavailable', message: 'Appointments are temporarily unavailable.' },
    },
    {
      name: 'PATCH actor resolution',
      fail: () => actorMock.mockRejectedValueOnce(new Error('membership unavailable')),
      invoke: () => item.PATCH(patch({ action: 'cancel' }), context),
      envelope: { error: 'appointments_unavailable', message: 'Appointments are temporarily unavailable.' },
    },
    {
      name: 'PATCH PHI guard',
      fail: () => guardMock.mockRejectedValueOnce(new Error('audit unavailable')),
      invoke: () => item.PATCH(patch({ action: 'cancel' }), context),
      envelope: { error: 'appointments_unavailable', message: 'Appointments are temporarily unavailable.' },
    },
  ]

  test.each(cases)('$name returns the shared 503 envelope', async ({ fail, invoke, envelope }) => {
    fail()
    const response = await invoke()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(envelope)
  })
})

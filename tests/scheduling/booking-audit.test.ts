import { beforeEach, describe, expect, test, vi } from 'vitest'

const { anonClientMock, auditMock, configMock, fromMock, rpcMock } = vi.hoisted(() => ({
  anonClientMock: vi.fn(),
  auditMock: vi.fn(),
  configMock: { appBaseUrl: 'http://localhost:4310', minChangeNoticeHours: 24 },
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('../../lib/config', () => ({ config: configMock }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'patient-session-token' }) }),
}))
vi.mock('../../lib/audit/events', () => ({ recordAuditEvent: auditMock }))
vi.mock('../../lib/db/client', () => ({ anonClient: anonClientMock }))

import { book } from '../../lib/scheduling/booking'

const APPOINTMENT_ID = '11111111-1111-4111-8111-111111111111'
const SLOT_ID = '22222222-2222-4222-8222-222222222222'
const SERVICE_ID = '33333333-3333-4333-8333-333333333333'
const ACTOR_USER_ID = '44444444-4444-4444-8444-444444444444'
const PATIENT_ID = '55555555-5555-4555-8555-555555555555'
const KEY = '66666666-6666-4666-8666-666666666666'

function successRow(overrides: Record<string, unknown> = {}) {
  return {
    result_error: null,
    result_reused: false,
    appointment_id: APPOINTMENT_ID,
    appointment_slot_id: SLOT_ID,
    starts_at: '2030-01-04T18:00:00.000Z',
    ends_at: '2030-01-04T19:00:00.000Z',
    appointment_status: 'requested',
    provider_name: 'Dr. Rivera',
    provider_time_zone: 'America/Chicago',
    service_name: 'MRI follow-up',
    out_of_hours: false,
    ...overrides,
  }
}

function bookInput() {
  return { patientId: PATIENT_ID, slotId: SLOT_ID, serviceId: SERVICE_ID, idempotencyKey: KEY, actorUserId: ACTOR_USER_ID }
}

beforeEach(() => {
  rpcMock.mockReset()
  auditMock.mockReset()
  fromMock.mockReset()
  anonClientMock.mockReset()
  fromMock.mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: PATIENT_ID }, error: null }),
    }
    return query
  })
  anonClientMock.mockReturnValue({ from: fromMock, rpc: rpcMock })
  auditMock.mockResolvedValue(undefined)
})

// Migration 017's book_appointment wrapper commits the granted or denied
// booking.create row inside the booking transaction (ADR-0014). The
// TypeScript layer must therefore write NO booking.create audit row of its
// own — a second writer here would double-log every outcome. The positive
// assertions (granted on create and replay, denied on every refusal) live in
// tests/scheduling/booking-concurrency.test.ts against a real Postgres.
describe('booking.create audit ownership stays in the database transaction', () => {
  test('fresh_booking_makes_no_typescript_audit_call', async () => {
    rpcMock.mockResolvedValue({ data: [successRow()], error: null })
    const result = await book(bookInput())
    expect(result.ok).toBe(true)
    expect(auditMock).not.toHaveBeenCalled()
  })

  test('refused_booking_makes_no_typescript_audit_call', async () => {
    for (const error of ['slot_unavailable', 'idempotency_key_reused', 'service_not_offered'] as const) {
      rpcMock.mockResolvedValue({ data: [successRow({ result_error: error, appointment_id: null, result_reused: null })], error: null })
      const result = await book(bookInput())
      expect(result).toEqual({ ok: false, error })
      expect(auditMock).not.toHaveBeenCalled()
    }
  })

  test('idempotent_replay_makes_no_typescript_audit_call', async () => {
    rpcMock.mockResolvedValue({ data: [successRow({ result_reused: true })], error: null })
    const result = await book(bookInput())
    expect(result.ok && result.reused).toBe(true)
    expect(auditMock).not.toHaveBeenCalled()
  })
})

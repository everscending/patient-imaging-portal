import { beforeEach, describe, expect, test, vi } from 'vitest'

const { anonClientMock, auditMock, fromMock } = vi.hoisted(() => ({
  anonClientMock: vi.fn(),
  auditMock: vi.fn(),
  fromMock: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'dual-role-session' }) }),
}))
vi.mock('../../lib/config', () => ({
  config: { appBaseUrl: 'http://localhost:4310', minChangeNoticeHours: 24 },
}))
vi.mock('../../lib/audit/events', () => ({ recordAuditEvent: auditMock }))
vi.mock('../../lib/db/client', () => ({ anonClient: anonClientMock }))

import { transition } from '../../lib/scheduling/booking'

const APPOINTMENT_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222'

type Query = {
  select: () => Query
  eq: () => Query
  update: (value: { status: string }) => Query
  insert: (value: Record<string, string>) => Promise<{ error: null }>
  maybeSingle: () => Promise<{ data: unknown; error: null }>
}

const appointment = {
  id: APPOINTMENT_ID,
  status: 'requested',
  out_of_hours: false,
  slots: { starts_at: '2030-01-03T15:00:00.000Z', ends_at: '2030-01-03T16:00:00.000Z' },
  providers: { full_name: 'Dr. Dual Role', time_zone: 'America/Chicago' },
  services: { name: 'MRI follow-up' },
}

let roleRows: Record<'patients' | 'providers' | 'staff_admins', object | null>
let updateRows: Array<{ status: string }>
let transitionRows: Array<Record<string, string>>

beforeEach(() => {
  vi.clearAllMocks()
  roleRows = { patients: null, providers: null, staff_admins: null }
  updateRows = []
  transitionRows = []
  fromMock.mockImplementation((table: string) => {
    let updatedStatus: string | null = null
    const query = {} as Query
    query.select = () => query
    query.eq = () => query
    query.update = (value) => {
      updatedStatus = value.status
      updateRows.push(value)
      return query
    }
    query.insert = async (value) => {
      transitionRows.push(value)
      return { error: null }
    }
    query.maybeSingle = async () => {
      if (table in roleRows) return { data: roleRows[table as keyof typeof roleRows], error: null }
      if (table === 'appointments') {
        return { data: updatedStatus === null ? appointment : { ...appointment, status: updatedStatus }, error: null }
      }
      return { data: null, error: null }
    }
    return query
  })
  anonClientMock.mockReturnValue({ from: fromMock })
})

describe('persisted appointment transition role authority', () => {
  test.each([
    ['provider', { patients: { id: 'patient-id' }, providers: { id: 'provider-id' }, staff_admins: null }],
    ['admin', { patients: { id: 'patient-id' }, providers: null, staff_admins: { id: 'admin-id' } }],
  ] as const)('%s with a patient row keeps clinician-first requested-to-confirmed authority', async (_role, rows) => {
    roleRows = rows

    await expect(transition({
      appointmentId: APPOINTMENT_ID,
      status: 'confirmed',
      actorUserId: ACTOR_USER_ID,
    })).resolves.toMatchObject({ ok: true, appointment: { status: 'confirmed' } })

    expect(updateRows).toEqual([{ status: 'confirmed' }])
    expect(transitionRows).toEqual([{
      appointment_id: APPOINTMENT_ID,
      from_status: 'requested',
      to_status: 'confirmed',
      actor_user_id: ACTOR_USER_ID,
    }])
    expect(auditMock).toHaveBeenCalledOnce()
  })

  test('patient-only requested-to-confirmed remains denied without persisted side effects', async () => {
    roleRows.patients = { id: 'patient-id' }

    await expect(transition({
      appointmentId: APPOINTMENT_ID,
      status: 'confirmed',
      actorUserId: ACTOR_USER_ID,
    })).resolves.toEqual({ ok: false, error: 'invalid_transition' })

    expect(updateRows).toEqual([])
    expect(transitionRows).toEqual([])
    expect(auditMock).not.toHaveBeenCalled()
  })
})

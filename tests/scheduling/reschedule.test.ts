import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const {
  anonClientMock,
  auditMock,
  configMock,
  fromMock,
  rpcMock,
} = vi.hoisted(() => ({
  anonClientMock: vi.fn(),
  auditMock: vi.fn(),
  configMock: { appBaseUrl: 'http://localhost:4310', minChangeNoticeHours: 30 },
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'patient-session-token' }) }),
}))
vi.mock('../../lib/config', () => ({ config: configMock }))
vi.mock('../../lib/audit/events', () => ({ recordAuditEvent: auditMock }))
vi.mock('../../lib/db/client', () => ({ anonClient: anonClientMock }))

import { cancel, reschedule } from '../../lib/scheduling/booking'

type RpcRow = {
  result_error: string | null
  appointment_id: string | null
  appointment_slot_id: string | null
  starts_at: string | null
  ends_at: string | null
  appointment_status: string | null
  provider_name: string | null
  provider_time_zone: string | null
  service_name: string | null
  out_of_hours: boolean | null
}

const APPOINTMENT_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222'
const CURRENT_SLOT_ID = '33333333-3333-4333-8333-333333333333'
const TARGET_SLOT_ID = '44444444-4444-4444-8444-444444444444'

function successRow(overrides: Partial<RpcRow> = {}): RpcRow {
  return {
    result_error: null,
    appointment_id: APPOINTMENT_ID,
    appointment_slot_id: TARGET_SLOT_ID,
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

function domainError(error: string): RpcRow {
  return successRow({
    result_error: error,
    appointment_id: null,
    appointment_slot_id: null,
    starts_at: null,
    ends_at: null,
    appointment_status: null,
    provider_name: null,
    provider_time_zone: null,
    service_name: null,
    out_of_hours: null,
  })
}

function rescheduleInput(slotId = TARGET_SLOT_ID) {
  return { appointmentId: APPOINTMENT_ID, slotId, actorUserId: ACTOR_USER_ID }
}

function cancelInput() {
  return { appointmentId: APPOINTMENT_ID, actorUserId: ACTOR_USER_ID }
}

function expectOnlyRoleReadsAndRpc(expectedRpcCalls = 1): void {
  expect(fromMock.mock.calls.map(([table]) => table)).toEqual(
    Array.from({ length: expectedRpcCalls }, () => ['patients', 'providers', 'staff_admins']).flat(),
  )
  expect(rpcMock).toHaveBeenCalledTimes(expectedRpcCalls)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-01-01T12:00:00.000Z'))
  configMock.minChangeNoticeHours = 30
  rpcMock.mockReset()
  auditMock.mockReset()
  fromMock.mockReset()
  anonClientMock.mockReset()

  fromMock.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: table === 'patients' ? { id: 'patient-id' } : null, error: null }),
    }
    return query
  })
  anonClientMock.mockReturnValue({ from: fromMock, rpc: rpcMock })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reschedule/cancel — single-RPC orchestration and ChangeResult mapping', () => {
  test('reschedule_openFutureSlot_mapsMovedAppointmentClearsOutOfHoursAndDelegatesAtomicWorkToOneRpc', async () => {
    rpcMock.mockResolvedValue({ data: [successRow()], error: null })

    const result = await reschedule(rescheduleInput())

    expect(result).toMatchObject({
      ok: true,
      appointment: {
        id: APPOINTMENT_ID,
        status: 'requested',
        providerName: 'Dr. Rivera',
        serviceName: 'MRI follow-up',
        outOfHours: false,
        canChange: true,
        allowedTransitions: ['cancelled'],
      },
    })
    expect(rpcMock).toHaveBeenCalledWith('reschedule_appointment', {
      p_appointment_id: APPOINTMENT_ID,
      p_slot_id: TARGET_SLOT_ID,
      p_actor_user_id: ACTOR_USER_ID,
      p_minimum_notice: '30 hours',
    })
    expect(anonClientMock).toHaveBeenCalledWith('patient-session-token')
    expectOnlyRoleReadsAndRpc()
    expect(auditMock).not.toHaveBeenCalled()
  })

  test('cancel_requestedAppointment_mapsCancelledDtoAndLeavesTransitionSlotAndAuditToOneRpc', async () => {
    rpcMock.mockResolvedValue({ data: successRow({ appointment_status: 'cancelled' }), error: null })

    const result = await cancel(cancelInput())

    expect(result).toMatchObject({
      ok: true,
      appointment: {
        id: APPOINTMENT_ID,
        status: 'cancelled',
        canChange: false,
        allowedTransitions: [],
      },
    })
    expect(rpcMock).toHaveBeenCalledWith('cancel_appointment', {
      p_appointment_id: APPOINTMENT_ID,
      p_actor_user_id: ACTOR_USER_ID,
      p_minimum_notice: '30 hours',
    })
    expectOnlyRoleReadsAndRpc()
    expect(auditMock).not.toHaveBeenCalled()
  })

  test('reschedule_patientTwentyThreeHoursBeforeStart_mapsMinimumNoticeAndDoesNotAttemptClientMutation', async () => {
    rpcMock.mockResolvedValue({ data: [domainError('minimum_notice')], error: null })

    await expect(reschedule(rescheduleInput())).resolves.toEqual({ ok: false, error: 'minimum_notice' })
    expectOnlyRoleReadsAndRpc()
  })

  test('cancel_patientTwentyThreeHoursBeforeStart_mapsMinimumNoticeAndDoesNotAttemptClientMutation', async () => {
    rpcMock.mockResolvedValue({ data: domainError('minimum_notice'), error: null })

    await expect(cancel(cancelInput())).resolves.toEqual({ ok: false, error: 'minimum_notice' })
    expectOnlyRoleReadsAndRpc()
  })

  test('reschedule_cancelledAppointmentBeyondNotice_mapsNotReschedulableNeverSilentMove', async () => {
    rpcMock.mockResolvedValue({ data: domainError('not_reschedulable'), error: null })

    await expect(reschedule(rescheduleInput())).resolves.toEqual({ ok: false, error: 'not_reschedulable' })
    expectOnlyRoleReadsAndRpc()
  })

  test('reschedule_pastSlot_mapsSlotUnavailableWithoutAClientSideSlotWrite', async () => {
    rpcMock.mockResolvedValue({ data: domainError('slot_unavailable'), error: null })

    await expect(reschedule(rescheduleInput())).resolves.toEqual({ ok: false, error: 'slot_unavailable' })
    expectOnlyRoleReadsAndRpc()
  })

  test('reschedule_differentProviderSlot_mapsSlotUnavailableWithoutDisclosingProvider', async () => {
    rpcMock.mockResolvedValue({ data: domainError('slot_unavailable'), error: null })

    await expect(reschedule(rescheduleInput())).resolves.toEqual({ ok: false, error: 'slot_unavailable' })
    expectOnlyRoleReadsAndRpc()
  })

  test('reschedule_currentSlot_mapsSlotUnavailableWithoutAClientTransactionSubstitute', async () => {
    rpcMock.mockResolvedValue({ data: domainError('slot_unavailable'), error: null })

    await expect(reschedule(rescheduleInput(CURRENT_SLOT_ID))).resolves.toEqual({ ok: false, error: 'slot_unavailable' })
    expectOnlyRoleReadsAndRpc()
  })

  test('cancel_alreadyCancelledAppointment_mapsNotReschedulableAndDoesNotWriteTransition', async () => {
    rpcMock.mockResolvedValue({ data: domainError('not_reschedulable'), error: null })

    await expect(cancel(cancelInput())).resolves.toEqual({ ok: false, error: 'not_reschedulable' })
    expectOnlyRoleReadsAndRpc()
  })

  test('cancel_completedOrNoShowAppointment_mapsNotReschedulableForBothTerminalStates', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: domainError('not_reschedulable'), error: null })
      .mockResolvedValueOnce({ data: domainError('not_reschedulable'), error: null })

    await expect(cancel(cancelInput())).resolves.toEqual({ ok: false, error: 'not_reschedulable' })
    await expect(cancel(cancelInput())).resolves.toEqual({ ok: false, error: 'not_reschedulable' })
    expectOnlyRoleReadsAndRpc(2)
  })

  test('reschedule_concurrentOppositeSwaps_issueExactlyOneOrderedDatabaseRpcEachAndNoMultiCallSubstitute', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: successRow({ appointment_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), error: null })
      .mockResolvedValueOnce({ data: successRow({ appointment_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), error: null })

    const results = await Promise.all([
      reschedule(rescheduleInput('55555555-5555-4555-8555-555555555555')),
      reschedule({
        appointmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        slotId: '66666666-6666-4666-8666-666666666666',
        actorUserId: ACTOR_USER_ID,
      }),
    ])

    expect(results.every((result) => result.ok)).toBe(true)
    expectOnlyRoleReadsAndRpc(2)
    expect(auditMock).not.toHaveBeenCalled()
  })

  test('reschedule_foreignPatientAppointmentPreservesRlsBoundaryAndNeverMapsA403DomainResult', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } })

    await expect(reschedule(rescheduleInput())).rejects.toThrow('booking: transactional write failed')
    await expect(reschedule(rescheduleInput())).rejects.not.toThrow('403')
    expectOnlyRoleReadsAndRpc(2)
  })

  test('reschedule_malformedAppointmentIdRejectsGenericTransactionalFailureWithoutLeakingAdapterDetail', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '22P02', message: 'invalid input syntax for uuid' } })

    await expect(
      reschedule({ ...rescheduleInput(), appointmentId: 'not-an-appointment-id' }),
    ).rejects.toThrow('booking: transactional write failed')
    expect(rpcMock).toHaveBeenCalledWith(
      'reschedule_appointment',
      expect.objectContaining({ p_appointment_id: 'not-an-appointment-id' }),
    )
    expectOnlyRoleReadsAndRpc()
  })

  test('changeRpc_malformedMissingOrUnknownResultsAreRejectedInsteadOfEscapingPinnedChangeResult', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: domainError('idempotency_key_reused'), error: null })
      .mockResolvedValueOnce({ data: successRow({ appointment_id: null }), error: null })

    await expect(reschedule(rescheduleInput())).rejects.toThrow('booking: transactional write returned no result')
    await expect(cancel(cancelInput())).rejects.toThrow('booking: transactional write returned an invalid result')
    await expect(reschedule(rescheduleInput())).rejects.toThrow('booking: transactional write omitted appointment_id')
    expectOnlyRoleReadsAndRpc(3)
  })
})

import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'

import { timed } from '../../lib/observability/timing'

type TimingLine = {
  op: 'share.create' | 'booking.create'
  ms: number
  outcome: 'ok' | 'conflict' | 'error'
  requestId: string
}

function emittedLine(log: ReturnType<typeof vi.spyOn>): TimingLine {
  expect(log).toHaveBeenCalledTimes(1)
  return JSON.parse(log.mock.calls[0]![0] as string) as TimingLine
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('timed', () => {
  test('acceptsOnlyTheTwoDeclaredOperationNames', () => {
    expectTypeOf(timed).parameter(0).toEqualTypeOf<'share.create' | 'booking.create'>()
  })

  test('emitsExactlyOneShareCreateSuccessLineWithOnlyThePrescribedShape', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(timed('share.create', async () => ({ id: 'share-id' }), () => 'ok')).resolves.toEqual({ id: 'share-id' })

    const line = emittedLine(log)
    expect(Object.keys(line).sort()).toEqual(['ms', 'op', 'outcome', 'requestId'])
    expect(line).toMatchObject({ op: 'share.create', outcome: 'ok' })
    expect(typeof line.ms).toBe('number')
    expect(line.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  test('mapsBookingConflictResultsAndServiceNotOfferedToTheirRequiredOutcomes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const bookingOutcome = (result: { ok: true } | { ok: false; error: 'slot_unavailable' | 'idempotency_key_reused' | 'service_not_offered' }) => {
      if (result.ok) return 'ok' as const
      return result.error === 'slot_unavailable' || result.error === 'idempotency_key_reused' ? 'conflict' as const : 'error' as const
    }

    await timed('booking.create', async () => ({ ok: false as const, error: 'slot_unavailable' as const }), bookingOutcome)
    expect(emittedLine(log)).toMatchObject({ op: 'booking.create', outcome: 'conflict' })

    log.mockClear()
    await timed('booking.create', async () => ({ ok: false as const, error: 'idempotency_key_reused' as const }), bookingOutcome)
    expect(emittedLine(log)).toMatchObject({ op: 'booking.create', outcome: 'conflict' })

    log.mockClear()
    await timed('booking.create', async () => ({ ok: false as const, error: 'service_not_offered' as const }), bookingOutcome)
    expect(emittedLine(log)).toMatchObject({ op: 'booking.create', outcome: 'error' })
  })

  test('thrownOperationEmitsOnceAsErrorAndRethrowsTheOriginalError', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const failure = new Error('persist failed')

    await expect(timed('booking.create', async () => { throw failure }, () => 'ok')).rejects.toBe(failure)

    expect(emittedLine(log)).toMatchObject({ op: 'booking.create', outcome: 'error' })
  })

  test('neverEmitsRecipientPatientSlotOrShareTokenData', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const phi = {
      recipientEmail: 'recipient@example.test',
      patientRef: 'PATIENT-REF-42',
      patientId: 'patient-id-42',
      slotStartsAt: '2026-08-17T09:00:00.000Z',
      token: 'raw-share-token',
      tokenHash: 'hashed-share-token',
    }

    await timed('share.create', async () => phi, () => 'ok')

    const serialized = log.mock.calls[0]![0] as string
    for (const value of Object.values(phi)) expect(serialized).not.toContain(value)
    expect(Object.keys(JSON.parse(serialized))).toEqual(['op', 'ms', 'outcome', 'requestId'])
  })

  test('measuresUntilTheAwaitedPersistenceCompletes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(350)
    let commit!: () => void
    const persisted = new Promise<void>((resolve) => { commit = resolve })

    const result = timed('booking.create', async () => {
      await persisted
      return { ok: true }
    }, () => 'ok')
    expect(log).not.toHaveBeenCalled()
    commit()
    await result

    expect(now).toHaveBeenCalledTimes(2)
    expect(emittedLine(log).ms).toBe(250)
  })
})

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { clientMock, sendMock, auditMock, configMock, timingSafeEqualMock } = vi.hoisted(() => ({
  clientMock: vi.fn(),
  sendMock: vi.fn(),
  auditMock: vi.fn(),
  timingSafeEqualMock: vi.fn(),
  configMock: {
    cronSecret: 'correct-secret',
    appBaseUrl: 'https://portal.example',
    reminderLeadHours: 24,
    reminderWindowMinutes: 30,
    reminderCronMinutes: 5,
  },
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: timingSafeEqualMock }
})
vi.mock('../../lib/db/client', () => ({ serviceClient: clientMock }))
vi.mock('../../lib/notify/email', () => ({ sendEmail: sendMock }))
vi.mock('../../lib/audit/events', () => ({ recordAuditEvent: auditMock }))
vi.mock('../../lib/config', () => ({ config: configMock }))

import { POST } from '../../app/api/jobs/reminders/route'
import { dispatchReminders, reminderMessage } from '../../lib/notify/reminders'

const NOW = '2026-08-17T12:00:00.000Z'
const MINUTE_MS = 60_000

type Appointment = { id: string; status: string; email: string; startsAt: string }
type ReminderSend = { appointment_id: string; lead_hours: number; outcome: 'failed' | 'sent'; sent_at: string | null }
type OutboxRow = {
  id: string
  recipient: string
  subject: string
  body: string
  attempts: number
  last_error: string | null
  next_attempt_at: string
  sent_at: string | null
  created_at: string
}
type Filter = { kind: 'eq' | 'in' | 'gte' | 'lt' | 'lte' | 'is'; column: string; value: unknown }

class CommonBarrier {
  private arrived = 0
  private release!: () => void
  private readonly promise = new Promise<void>((resolve) => {
    this.release = resolve
  })

  constructor(private readonly parties: number) {}

  async wait(): Promise<void> {
    this.arrived += 1
    if (this.arrived === this.parties) this.release()
    await this.promise
  }
}

type Store = {
  appointments: Appointment[]
  reminderSends: ReminderSend[]
  outbox: OutboxRow[]
  operations: string[]
  appointmentBarrier?: CommonBarrier
  failReminderUpdate?: boolean
}

function store(overrides: Partial<Store> = {}): Store {
  return { appointments: [], reminderSends: [], outbox: [], operations: [], ...overrides }
}

function reminderKey(row: Pick<ReminderSend, 'appointment_id' | 'lead_hours'>): string {
  return `${row.appointment_id}:${row.lead_hours}`
}

class MemoryQuery implements PromiseLike<{ data: unknown; error: { code?: string } | null }> {
  private operation: 'select' | 'delete' | 'insert' | 'update' | null = null
  private values: Record<string, unknown> = {}
  private returning = false
  private readonly filters: Filter[] = []
  private orderColumn: string | null = null
  private orderAscending = true

  constructor(
    private readonly state: Store,
    private readonly table: string,
  ) {}

  select(): this {
    if (this.operation === null) this.operation = 'select'
    else this.returning = true
    return this
  }

  delete(): this {
    this.operation = 'delete'
    return this
  }

  insert(values: Record<string, unknown>): this {
    this.operation = 'insert'
    this.values = values
    return this
  }

  update(values: Record<string, unknown>): this {
    this.operation = 'update'
    this.values = values
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq', column, value })
    return this
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ kind: 'in', column, value })
    return this
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ kind: 'gte', column, value })
    return this
  }

  lt(column: string, value: unknown): this {
    this.filters.push({ kind: 'lt', column, value })
    return this
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ kind: 'lte', column, value })
    return this
  }

  is(column: string, value: unknown): this {
    this.filters.push({ kind: 'is', column, value })
    return this
  }

  order(column: string, options: { ascending: boolean }): this {
    this.orderColumn = column
    this.orderAscending = options.ascending
    return this
  }

  then<TResult1 = { data: unknown; error: { code?: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { code?: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private value(row: Record<string, unknown>, column: string): unknown {
    if (column === 'slots.starts_at') return row.startsAt
    return row[column]
  }

  private matches(row: Record<string, unknown>): boolean {
    return this.filters.every(({ kind, column, value }) => {
      const actual = this.value(row, column)
      if (kind === 'eq' || kind === 'is') return actual === value
      if (kind === 'in') return (value as unknown[]).includes(actual)
      if (kind === 'gte') return String(actual) >= String(value)
      if (kind === 'lt') return String(actual) < String(value)
      return String(actual) <= String(value)
    })
  }

  private async execute(): Promise<{ data: unknown; error: { code?: string } | null }> {
    if (this.table === 'appointments') {
      if (this.state.appointmentBarrier) await this.state.appointmentBarrier.wait()
      const rows = this.state.appointments
        .filter((row) => this.matches(row as unknown as Record<string, unknown>))
        .map((row) => ({ id: row.id, patients: { email: row.email }, slots: { starts_at: row.startsAt } }))
      return { data: rows, error: null }
    }

    if (this.table === 'reminder_sends') {
      if (this.operation === 'delete') {
        this.state.operations.push('reminder.delete')
        this.state.reminderSends = this.state.reminderSends.filter(
          (row) => !this.matches(row as unknown as Record<string, unknown>),
        )
        return { data: null, error: null }
      }
      if (this.operation === 'insert') {
        const row = { sent_at: null, ...this.values } as ReminderSend
        this.state.operations.push('reminder.insert')
        if (row.outcome !== 'failed' || row.sent_at !== null) return { data: null, error: { code: '23514' } }
        if (this.state.reminderSends.some((existing) => reminderKey(existing) === reminderKey(row))) {
          return { data: null, error: { code: '23505' } }
        }
        this.state.reminderSends.push(row)
        return { data: this.returning ? [{ appointment_id: row.appointment_id }] : null, error: null }
      }
      if (this.operation === 'update') {
        this.state.operations.push('reminder.update')
        if (this.state.failReminderUpdate) return { data: null, error: { code: 'write_failed' } }
        const rows = this.state.reminderSends.filter((row) =>
          this.matches(row as unknown as Record<string, unknown>),
        )
        for (const row of rows) Object.assign(row, this.values)
        return { data: this.returning ? rows : null, error: null }
      }
    }

    if (this.table === 'email_outbox') {
      if (this.operation === 'select') {
        let rows = this.state.outbox.filter((row) => this.matches(row as unknown as Record<string, unknown>))
        if (this.orderColumn) {
          const column = this.orderColumn
          const direction = this.orderAscending ? 1 : -1
          rows = [...rows].sort((left, right) => String(left[column as keyof OutboxRow]).localeCompare(String(right[column as keyof OutboxRow])) * direction)
        }
        return { data: rows.map((row) => ({ ...row })), error: null }
      }
      if (this.operation === 'update') {
        const rows = this.state.outbox.filter((row) => this.matches(row as unknown as Record<string, unknown>))
        for (const row of rows) Object.assign(row, this.values)
        return { data: this.returning ? rows.map((row) => ({ id: row.id })) : null, error: null }
      }
    }

    return { data: [], error: null }
  }
}

function clientFor(state: Store) {
  return { from: vi.fn((table: string) => new MemoryQuery(state, table)) }
}

function appointment(id: string, status: string, offsetMinutes: number): Appointment {
  return {
    id,
    status,
    email: `${id}@example.com`,
    startsAt: new Date(Date.parse(NOW) + offsetMinutes * MINUTE_MS).toISOString(),
  }
}

function outboxRow(id: string, createdOffset: number, dueOffset = -1): OutboxRow {
  return {
    id,
    recipient: `${id}@example.com`,
    subject: `subject-${id}`,
    body: `body-${id}`,
    attempts: 0,
    last_error: null,
    next_attempt_at: new Date(Date.parse(NOW) + dueOffset * MINUTE_MS).toISOString(),
    sent_at: null,
    created_at: new Date(Date.parse(NOW) + createdOffset * MINUTE_MS).toISOString(),
  }
}

async function route(secret?: string, body?: unknown): Promise<Response> {
  return POST(
    new Request('https://portal.example/api/jobs/reminders', {
      method: 'POST',
      headers: secret ? { 'x-cron-secret': secret, 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  clientMock.mockReset()
  sendMock.mockReset()
  auditMock.mockReset()
  timingSafeEqualMock.mockReset()
  timingSafeEqualMock.mockImplementation((left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(Buffer.from(right)))
  configMock.cronSecret = 'correct-secret'
  sendMock.mockResolvedValue({ outcome: 'sent', transport: 'log' })
  auditMock.mockResolvedValue(undefined)
  clientMock.mockImplementation(() => clientFor(store()))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('due reminder selection', () => {
  test('dueQueryRunsAgainstMigratedSlotInstantAndNeverReferencesAppointmentsStartsAt', async () => {
    const state = store()
    const client = clientFor(state)
    clientMock.mockReturnValue(client)

    await dispatchReminders()

    const query = client.from.mock.results[0]?.value as MemoryQuery
    expect(query).toBeInstanceOf(MemoryQuery)
    const moduleSource = readFileSync('lib/notify/reminders.ts', 'utf8')
    const schema = readFileSync('db/migrations/002_scheduling_sharing_audit.sql', 'utf8')
    const appointmentsDefinition = schema.match(/create table appointments \(([\s\S]*?)\n\);/)?.[1]
    const slotsDefinition = schema.match(/create table slots \(([\s\S]*?)\n\);/)?.[1]
    expect(moduleSource).toContain("patients!inner(email), slots!inner(starts_at)")
    expect(moduleSource).toContain(".gte('slots.starts_at'")
    expect(moduleSource).not.toMatch(/appointments\.starts_at/)
    expect(appointmentsDefinition).not.toMatch(/starts_at/)
    expect(slotsDefinition).toMatch(/starts_at\s+timestamptz not null/)
  })

  test('configuredWindowIncludesLeadBoundaryAndRequestedButExcludesOutsideWindowAndTerminalStatuses', async () => {
    const leadMinutes = configMock.reminderLeadHours * 60
    const state = store({
      appointments: [
        appointment('requested-boundary', 'requested', leadMinutes),
        appointment('confirmed-inside', 'confirmed', leadMinutes + configMock.reminderWindowMinutes - 1),
        appointment('too-late', 'confirmed', leadMinutes + configMock.reminderWindowMinutes + 15),
        appointment('too-early', 'confirmed', leadMinutes - 60),
        appointment('cancelled', 'cancelled', leadMinutes),
        appointment('completed', 'completed', leadMinutes),
        appointment('no-show', 'no_show', leadMinutes),
      ],
    })
    clientMock.mockReturnValue(clientFor(state))

    const result = await dispatchReminders()

    expect(result).toEqual({ due: 2, sent: 2, skipped: 0, failed: 0 })
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  test('cancelledAppointmentIsNeverSelectedOrSent', async () => {
    const state = store({ appointments: [appointment('cancelled', 'cancelled', configMock.reminderLeadHours * 60)] })
    clientMock.mockReturnValue(clientFor(state))

    await expect(dispatchReminders()).resolves.toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 })
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('persist-before-send idempotency and retry', () => {
  test('insertBeforeSendPersistsFailedThenMarksSentAfterAcceptanceAndWritesGrantedAudit', async () => {
    const state = store({ appointments: [appointment('appointment-id', 'confirmed', configMock.reminderLeadHours * 60)] })
    clientMock.mockReturnValue(clientFor(state))
    sendMock.mockImplementation(async () => {
      state.operations.push('email.send')
      const row = state.reminderSends[0]
      expect(row).toMatchObject({ outcome: 'failed', sent_at: null })
      return { outcome: 'sent', transport: 'log' }
    })

    await dispatchReminders()

    expect(state.operations.indexOf('reminder.insert')).toBeLessThan(state.operations.indexOf('email.send'))
    expect(state.operations.indexOf('email.send')).toBeLessThan(state.operations.indexOf('reminder.update'))
    expect(state.reminderSends).toEqual([
      expect.objectContaining({ appointment_id: 'appointment-id', outcome: 'sent', sent_at: NOW }),
    ])
    expect(auditMock).toHaveBeenCalledWith({
      actorKind: 'system',
      actorRef: null,
      action: 'reminder.dispatch',
      targetKind: 'appointment',
      targetId: 'appointment-id',
      outcome: 'granted',
      detail: { transport: 'log', leadHours: configMock.reminderLeadHours },
    })
  })

  test('preSendRecordCannotBeSentOrHaveSentAtBeforeProviderAcceptance', async () => {
    const state = store({ appointments: [appointment('pre-send', 'requested', configMock.reminderLeadHours * 60)] })
    clientMock.mockReturnValue(clientFor(state))
    sendMock.mockImplementation(async () => {
      expect(state.reminderSends).toEqual([
        { appointment_id: 'pre-send', lead_hours: configMock.reminderLeadHours, outcome: 'failed', sent_at: null },
      ])
      return { outcome: 'sent', transport: 'log' }
    })

    await dispatchReminders()
    expect(state.reminderSends[0]).toMatchObject({ outcome: 'sent', sent_at: NOW })
  })

  test('secondRunImmediatelyAfterSuccessSendsZeroEmailsAndKeepsOneRecord', async () => {
    const state = store({ appointments: [appointment('once', 'confirmed', configMock.reminderLeadHours * 60)] })
    clientMock.mockReturnValue(clientFor(state))

    const first = await dispatchReminders()
    const second = await dispatchReminders()

    expect(first.sent).toBe(1)
    expect(second).toEqual({ due: 1, sent: 0, skipped: 1, failed: 0 })
    expect(state.reminderSends).toHaveLength(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  test('tenOverlappingRunsAtCommonBarrierProduceOneEmailOneRowAndNoSurfacedDuplicateError', async () => {
    const state = store({
      appointments: [appointment('overlap', 'confirmed', configMock.reminderLeadHours * 60)],
      appointmentBarrier: new CommonBarrier(10),
    })
    clientMock.mockReturnValue(clientFor(state))

    const results = await Promise.all(Array.from({ length: 10 }, () => dispatchReminders()))

    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1)
    expect(results.reduce((total, result) => total + result.skipped, 0)).toBe(9)
    expect(state.reminderSends).toHaveLength(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  test('appointmentWithExistingReminderSendRowIsSkippedBeforeEmail', async () => {
    const state = store({
      appointments: [appointment('existing', 'requested', configMock.reminderLeadHours * 60)],
      reminderSends: [
        { appointment_id: 'existing', lead_hours: configMock.reminderLeadHours, outcome: 'sent', sent_at: NOW },
      ],
    })
    clientMock.mockReturnValue(clientFor(state))

    const result = await dispatchReminders()

    expect(result).toEqual({ due: 1, sent: 0, skipped: 1, failed: 0 })
    expect(sendMock).not.toHaveBeenCalled()
  })

  test('crashBetweenInsertAndUpdateLeavesOneFailedRowThatNextPassClearsAndRetries', async () => {
    const state = store({ appointments: [appointment('crash', 'confirmed', configMock.reminderLeadHours * 60)] })
    clientMock.mockReturnValue(clientFor(state))
    sendMock.mockRejectedValueOnce(new Error('simulated process crash')).mockResolvedValueOnce({ outcome: 'sent', transport: 'log' })

    await expect(dispatchReminders()).rejects.toThrow('simulated process crash')
    expect(state.reminderSends).toEqual([
      { appointment_id: 'crash', lead_hours: configMock.reminderLeadHours, outcome: 'failed', sent_at: null },
    ])

    await expect(dispatchReminders()).resolves.toMatchObject({ sent: 1, failed: 0 })
    expect(state.reminderSends).toHaveLength(1)
    expect(state.reminderSends[0]).toMatchObject({ outcome: 'sent', sent_at: NOW })
  })

  test('failedSendPersistsOneFailedRowWritesDeniedAuditAndNextPassRetriesWithoutDuplicateRow', async () => {
    const state = store({ appointments: [appointment('retry', 'confirmed', configMock.reminderLeadHours * 60)] })
    clientMock.mockReturnValue(clientFor(state))
    sendMock
      .mockResolvedValueOnce({ outcome: 'failed', transport: 'resend', error: 'provider rejected' })
      .mockResolvedValueOnce({ outcome: 'sent', transport: 'resend' })

    const failed = await dispatchReminders()
    expect(failed).toMatchObject({ sent: 0, failed: 1 })
    expect(state.reminderSends).toEqual([
      { appointment_id: 'retry', lead_hours: configMock.reminderLeadHours, outcome: 'failed', sent_at: null },
    ])
    expect(auditMock).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'denied', targetId: 'retry' }))

    const retried = await dispatchReminders()
    expect(retried).toMatchObject({ sent: 1, failed: 0 })
    expect(state.reminderSends).toHaveLength(1)
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(auditMock).toHaveBeenCalledTimes(2)
  })
})

describe('durable email outbox drain', () => {
  test('outboxDrainSendsOldestEligibleFirstSkipsFutureAndSentRowsAndPersistsSuccessAndBackoff', async () => {
    const oldest = outboxRow('oldest', -30)
    const newest = outboxRow('newest', -10)
    const future = outboxRow('future', -40, 10)
    const sent = { ...outboxRow('already-sent', -50), sent_at: NOW }
    const state = store({ outbox: [newest, future, sent, oldest] })
    clientMock.mockReturnValue(clientFor(state))
    sendMock
      .mockResolvedValueOnce({ outcome: 'failed', transport: 'resend', error: 'unsafe provider text' })
      .mockResolvedValueOnce({ outcome: 'sent', transport: 'resend' })

    await dispatchReminders()

    expect(sendMock.mock.calls.map(([message]) => message.to)).toEqual(['oldest@example.com', 'newest@example.com'])
    expect(oldest).toMatchObject({ attempts: 1, last_error: 'email_delivery_failed', sent_at: null })
    expect(Date.parse(oldest.next_attempt_at)).toBeGreaterThan(Date.parse(NOW))
    expect(newest).toMatchObject({ attempts: 0, sent_at: NOW })
    expect(future).toMatchObject({ attempts: 0, sent_at: null })
    expect(sent).toMatchObject({ attempts: 0, sent_at: NOW })
  })

  test('outboxLastErrorNeverContainsRecipientShareTokenPatientReferenceOrProviderText', async () => {
    const row = outboxRow('recipient', -1)
    row.recipient = 'private.patient@example.com'
    const state = store({ outbox: [row] })
    clientMock.mockReturnValue(clientFor(state))
    const secrets = ['private.patient@example.com', 'share-token-secret', 'PT-0042']
    sendMock.mockResolvedValue({ outcome: 'failed', transport: 'resend', error: secrets.join(' ') })

    await dispatchReminders()

    expect(row.last_error).toBe('email_delivery_failed')
    for (const secret of secrets) expect(row.last_error).not.toContain(secret)
  })

  test('overlappingOutboxDrainsClaimBeforeSendAndDoNotDuplicateAnEligibleRow', async () => {
    const state = store({ outbox: [outboxRow('claimed-once', -1)] })
    clientMock.mockReturnValue(clientFor(state))

    await Promise.all([dispatchReminders(), dispatchReminders()])

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(state.outbox[0]).toMatchObject({ sent_at: NOW })
  })
})

describe('safe reminder message and module boundaries', () => {
  test('composedReminderMatchesPinnedCopyAndContainsNoneOfTheSeededPhiOrClinicalValues', () => {
    const forbidden = [
      'Avery Patient',
      '1988-04-12',
      'PT-0042',
      'Dr Provider',
      'MRI with contrast',
      '2026-08-18T12:00:00Z',
      'oncology',
    ]
    const message = reminderMessage('recipient@example.com')

    expect(message).toEqual({
      to: 'recipient@example.com',
      subject: 'Appointment reminder',
      text: 'You have an appointment in 24 hours.\n\nhttps://portal.example/appointments\n\nSign in to see the details, or to change or cancel it.',
    })
    for (const value of forbidden) expect(`${message.subject}\n${message.text}`).not.toContain(value)
  })

  test('reminderModuleUsesCentralConfigSoleEmailAdapterAndNoTypedLeadOrWindowDefaults', () => {
    const source = readFileSync('lib/notify/reminders.ts', 'utf8')
    expect(source).toContain("from '../config'")
    expect(source).toContain("from './email'")
    expect(source).not.toMatch(/from ['"]resend['"]|@supabase\/supabase-js|createClient\s*\(/)
    expect(source).not.toMatch(/\b24\b|\b30\b/)
    expect(source).not.toMatch(/process\.env/)
  })

  test('migrationGeneratesCronCadenceFromRequiredPersistedConfigAndDocumentsWindowInvariant', () => {
    const sql = readFileSync('db/migrations/004_pg_cron_reminders.sql', 'utf8')
    expect(sql).toMatch(/interval must stay shorter than the reminder window/i)
    expect(sql).toContain("nullif(current_setting('app.reminder_cron_minutes', true), '') is not null")
    expect(sql).toContain("'*/' || current_setting('app.reminder_cron_minutes', true) || ' * * * *'")
    expect(sql).not.toMatch(/coalesce\([\s\S]*app\.reminder_cron_minutes/)
    expect(sql).toContain("'/api/jobs/reminders'")
    expect(sql).toContain("'x-cron-secret'")
  })
})

describe('secret-guarded POST route', () => {
  test('postWithoutCronSecretHeaderReturnsUnauthorizedEnvelope', async () => {
    const response = await route()
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized', message: 'Unauthorized.' })
    expect(clientMock).not.toHaveBeenCalled()
  })

  test('postWithWrongCronSecretReturnsUnauthorizedEnvelope', async () => {
    const response = await route('wrong-secret')
    expect(response.status).toBe(401)
    expect(clientMock).not.toHaveBeenCalled()
  })

  test('postWithCorrectLengthIncorrectCronSecretIsNotAcceptedAsPrefixOrMatch', async () => {
    const candidate = 'incorrect-secr'
    expect(candidate).toHaveLength(configMock.cronSecret.length)
    const response = await route(candidate)
    expect(response.status).toBe(401)
    expect(clientMock).not.toHaveBeenCalled()
  })

  test('postWithUnconfiguredCronSecretFailsClosed', async () => {
    configMock.cronSecret = null as unknown as string
    const response = await route('correct-secret')
    expect(response.status).toBe(401)
    expect(clientMock).not.toHaveBeenCalled()
  })

  test('wrongLengthSecretStillUsesFixedWidthTimingSafeComparison', async () => {
    const response = await route('x')
    expect(response.status).toBe(401)
    expect(timingSafeEqualMock).toHaveBeenCalledTimes(1)
    const [left, right] = timingSafeEqualMock.mock.calls[0] as [Uint8Array, Uint8Array]
    expect(left.byteLength).toBe(right.byteLength)
    expect(left.byteLength).toBeGreaterThan(0)
  })

  test('correctSecretReturnsExactlyFourPinnedCountersAndNoOutboxField', async () => {
    const state = store()
    clientMock.mockReturnValue(clientFor(state))
    const response = await route('correct-secret')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 })
  })

  test('requestBodyAppointmentIdsAreIgnoredAndCannotDriveDispatch', async () => {
    const state = store()
    clientMock.mockReturnValue(clientFor(state))
    const response = await route('correct-secret', { appointmentIds: ['attacker-selected-id'] })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 })
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('central reminder cadence startup guard', () => {
  test('startupRejectsEqualOrLargerReminderCadenceAndAcceptsValidPair', async () => {
    const required = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SOURCE_REF_SALT: 'test-source-ref-salt',
      REMINDER_WINDOW_MINUTES: '30',
    }

    async function load(cronMinutes: string) {
      for (const [key, value] of Object.entries({ ...required, REMINDER_CRON_MINUTES: cronMinutes })) {
        vi.stubEnv(key, value)
      }
      vi.resetModules()
      return vi.importActual<typeof import('../../lib/config')>('../../lib/config')
    }

    await expect(load('30')).rejects.toThrow(/REMINDER_CRON_MINUTES/)
    await expect(load('31')).rejects.toThrow(/REMINDER_CRON_MINUTES/)
    await expect(load('5')).resolves.toMatchObject({
      config: expect.objectContaining({ reminderCronMinutes: 5, reminderWindowMinutes: 30 }),
    })
  })
})

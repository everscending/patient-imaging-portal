import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { clientMock, sendMock, auditMock, configMock } = vi.hoisted(() => ({
  clientMock: vi.fn(),
  sendMock: vi.fn(),
  auditMock: vi.fn(),
  configMock: {
    cronSecret: 'correct-secret', appBaseUrl: 'https://portal.example', reminderLeadHours: 24,
    reminderWindowMinutes: 30, reminderCronMinutes: 5,
  },
}))
vi.mock('../../lib/db/client', () => ({ serviceClient: clientMock }))
vi.mock('../../lib/notify/email', () => ({ sendEmail: sendMock }))
vi.mock('../../lib/audit/events', () => ({ recordAuditEvent: auditMock }))
vi.mock('../../lib/config', () => ({ config: configMock }))

import { POST } from '../../app/api/jobs/reminders/route'
import { dispatchReminders, reminderMessage } from '../../lib/notify/reminders'

type Result = { data: unknown; error: unknown }
function query(result: Result) {
  const builder = {} as Record<string, ReturnType<typeof vi.fn>>
  for (const method of ['select', 'in', 'gte', 'lt', 'is', 'lte', 'order', 'eq', 'delete', 'insert', 'update']) {
    builder[method] = vi.fn(() => builder)
  }
  builder.then = vi.fn((resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject))
  return builder
}

function clientWith(results: Record<string, Result[]>) {
  return {
    from: vi.fn((table: string) => query(results[table]?.shift() ?? { data: [], error: null })),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-17T12:00:00.000Z'))
  clientMock.mockReset(); sendMock.mockReset(); auditMock.mockReset()
  configMock.cronSecret = 'correct-secret'
  sendMock.mockResolvedValue({ outcome: 'sent', transport: 'log' })
  auditMock.mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('reminder dispatch', () => {
  test('dueQueryJoinsSlotsUsesConfiguredWindowAndSelectsRequestedAndConfirmedOnly', async () => {
    const client = clientWith({ appointments: [{ data: [], error: null }], email_outbox: [{ data: [], error: null }] })
    clientMock.mockReturnValue(client)
    await dispatchReminders()
    const due = client.from.mock.results[0]?.value as Record<string, ReturnType<typeof vi.fn>>
    expect(due.select).toHaveBeenCalledWith('id, patients!inner(email), slots!inner(starts_at)')
    expect(due.in).toHaveBeenCalledWith('status', ['requested', 'confirmed'])
    expect(due.gte).toHaveBeenCalledWith('slots.starts_at', expect.any(String))
    expect(due.lt).toHaveBeenCalledWith('slots.starts_at', expect.any(String))
    expect(readFileSync('lib/notify/reminders.ts', 'utf8')).not.toMatch(/appointments\.starts_at/)
  })

  test('insertBeforeSendPersistsFailedThenMarksSentAndWritesAudit', async () => {
    const client = clientWith({
      appointments: [{ data: [{ id: 'appointment-id', patients: [{ email: 'recipient@example.com' }] }], error: null }],
      reminder_sends: [{ data: null, error: null }, { data: [{ appointment_id: 'appointment-id' }], error: null }, { data: null, error: null }],
      email_outbox: [{ data: [], error: null }],
    })
    clientMock.mockReturnValue(client)
    await dispatchReminders()
    const insert = (client.from.mock.results[2]?.value as Record<string, ReturnType<typeof vi.fn>>).insert
    expect(insert).toHaveBeenCalledWith({ appointment_id: 'appointment-id', lead_hours: configMock.reminderLeadHours, outcome: 'failed' })
    expect(sendMock).toHaveBeenCalledAfter(insert)
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'reminder.dispatch', outcome: 'granted', detail: { transport: 'log', leadHours: configMock.reminderLeadHours } }))
  })

  test('messageIsPinnedGenericCopyWithoutSeededPhi', () => {
    expect(reminderMessage('recipient@example.com')).toEqual({
      to: 'recipient@example.com', subject: 'Appointment reminder',
      text: 'You have an appointment in 24 hours.\n\nhttps://portal.example/appointments\n\nSign in to see the details, or to change or cancel it.',
    })
  })

  test('routeRejectsMissingWrongPrefixAndUnconfiguredSecrets', async () => {
    for (const secret of [null, 'wrong-secret', 'correct']) {
      const response = await POST(new Request('https://portal.example/api/jobs/reminders', { method: 'POST', headers: secret ? { 'x-cron-secret': secret } : {} }))
      expect(response.status).toBe(401)
    }
    configMock.cronSecret = null as unknown as string
    const response = await POST(new Request('https://portal.example/api/jobs/reminders', { method: 'POST', headers: { 'x-cron-secret': 'correct-secret' } }))
    expect(response.status).toBe(401)
  })
})

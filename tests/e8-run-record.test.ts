import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { startE8AcceptanceFixture, type E8AcceptanceFixture } from './fixtures/e8-acceptance'
import { readE8RunRecord, writeE8RunRecord } from './fixtures/e8-run-record'

let fixture: E8AcceptanceFixture

beforeAll(async () => {
  fixture = await startE8AcceptanceFixture()
}, 180_000)

afterAll(async () => {
  if (fixture) await fixture.close()
}, 60_000)

describe.sequential('E8 live reminder acceptance through POST /api/jobs/reminders', () => {
  test('missing and wrong cron secrets return 401 and write no reminder row', async () => {
    const missing = await fixture.runJob()
    const wrong = await fixture.runJob('wrong-e8-secret')

    expect(missing).toMatchObject({ status: 401, body: { error: 'unauthorized', message: 'Unauthorized.' } })
    expect(wrong).toMatchObject({ status: 401, body: { error: 'unauthorized', message: 'Unauthorized.' } })
    expect(await fixture.reminderRows()).toEqual([])
  })

  test('two sequential HTTP runs send one reminder and preserve one durable send row', async () => {
    const [appointmentId] = await fixture.prepareDueAppointments(1)

    const first = await fixture.runAuthorizedJob()
    const second = await fixture.runAuthorizedJob()

    expect(first).toEqual({ status: 200, body: { due: 1, sent: 1, skipped: 0, failed: 0 } })
    expect(second).toEqual({ status: 200, body: { due: 1, sent: 0, skipped: 1, failed: 0 } })
    expect(await fixture.reminderRows()).toHaveLength(1)
    expect((await fixture.reminderRows())[0]).toMatchObject({ leadHours: 24, outcome: 'sent' })
    expect(await fixture.mailMessages()).toEqual([{
      to: expect.any(String),
      subject: 'Appointment reminder',
      text: `You have an appointment in 24 hours.\n\n${fixture.appBaseUrl()}/appointments\n\nSign in to see the details, or to change or cancel it.`,
    }])
    expect(fixture.dispatchLogs()).toHaveLength(1)
    expect(await fixture.dispatchAudits()).toEqual([{
      appointmentId,
      outcome: 'granted',
      transport: 'log',
      leadHours: 24,
    }])
  })

  test('a pre-existing durable send row suppresses dispatch', async () => {
    const [appointmentId] = await fixture.prepareDueAppointments(1)
    await fixture.insertPreexistingSend(appointmentId)

    const result = await fixture.runAuthorizedJob()

    expect(result).toEqual({ status: 200, body: { due: 1, sent: 0, skipped: 1, failed: 0 } })
    expect(await fixture.reminderRows()).toHaveLength(1)
    expect(await fixture.mailMessages()).toEqual([])
    expect(fixture.dispatchLogs()).toEqual([])
  })

  test('a due outbox row is claimed and completed through the real REST boundary', async () => {
    const [appointmentId] = await fixture.prepareDueAppointments(1)
    await fixture.insertPreexistingSend(appointmentId)
    const outboxId = await fixture.insertDueOutboxMessage()

    const result = await fixture.runAuthorizedJob()

    expect(result).toEqual({ status: 200, body: { due: 1, sent: 0, skipped: 1, failed: 0 } })
    expect(await fixture.outboxRows()).toEqual([{
      id: outboxId,
      attempts: 0,
      nextAttemptAt: expect.any(String),
      sentAt: expect.any(String),
      lastError: null,
    }])
    expect(await fixture.mailMessages()).toContainEqual({
      to: 'outbox@example.test',
      subject: 'Share notice',
      text: 'A secure link is ready.',
    })
  })

  test('a failed outbox delivery persists the bounded retry update through the real REST boundary', async () => {
    const [appointmentId] = await fixture.prepareDueAppointments(1)
    await fixture.insertPreexistingSend(appointmentId)
    const outboxId = await fixture.insertDueOutboxMessage('invalid-recipient')

    const result = await fixture.runAuthorizedJob()

    expect(result).toEqual({ status: 200, body: { due: 1, sent: 0, skipped: 1, failed: 0 } })
    expect(await fixture.outboxRows()).toEqual([{
      id: outboxId,
      attempts: 1,
      nextAttemptAt: expect.any(String),
      sentAt: null,
      lastError: 'email_delivery_failed',
    }])
    expect(await fixture.mailMessages()).toEqual([])
  })

  test('an explicit transport rejection is retried and then sent without a duplicate row', async () => {
    const [appointmentId] = await fixture.prepareDueAppointments(1, 'invalid-recipient')

    const failed = await fixture.runAuthorizedJob()
    expect(failed).toEqual({ status: 200, body: { due: 1, sent: 0, skipped: 0, failed: 1 } })
    expect((await fixture.reminderRows())[0]).toMatchObject({ outcome: 'failed' })
    expect((await fixture.reminderRows())[0].retryableAt).not.toBeNull()
    expect(await fixture.mailMessages()).toEqual([])
    const failedAudits = await fixture.dispatchAudits()
    expect(failedAudits).toEqual([{
      appointmentId,
      outcome: 'denied',
      transport: 'log',
      leadHours: 24,
    }])
    const failedAuditDetails = failedAudits.map(({ outcome, transport, leadHours }) => ({ outcome, transport, leadHours }))
    expect(fixture.phiTerms().filter((term) => JSON.stringify(failedAuditDetails).includes(term))).toEqual([])

    await fixture.setAppointmentRecipient(appointmentId, 'recovered@example.test')
    const retried = await fixture.runAuthorizedJob()

    expect(retried).toEqual({ status: 200, body: { due: 1, sent: 1, skipped: 0, failed: 0 } })
    expect(await fixture.reminderRows()).toHaveLength(1)
    expect((await fixture.reminderRows())[0]).toMatchObject({ outcome: 'sent' })
    expect(await fixture.mailMessages()).toHaveLength(1)
    expect(fixture.dispatchLogs()).toHaveLength(1)
    expect(await fixture.dispatchAudits()).toEqual([
      { appointmentId, outcome: 'denied', transport: 'log', leadHours: 24 },
      { appointmentId, outcome: 'granted', transport: 'log', leadHours: 24 },
    ])
  })

  test('ten barrier-released HTTP runs deliver the measured due set at least 99 percent with zero duplicates or PHI', async () => {
    const appointmentIds = await fixture.prepareDueAppointments(10)
    const measuredStart = new Date().toISOString()
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve))
    const pending = Array.from({ length: 10 }, async () => {
      await barrier
      return fixture.runAuthorizedJob()
    })
    releaseBarrier()
    const results = await Promise.all(pending)
    const measuredEnd = new Date().toISOString()

    expect(results.every((result) => result.status === 200)).toBe(true)
    const responseTotals = results.reduce(
      (totals, result) => {
        for (const key of ['due', 'sent', 'skipped', 'failed'] as const) totals[key] += Number(result.body[key])
        return totals
      },
      { due: 0, sent: 0, skipped: 0, failed: 0 },
    )
    const rows = await fixture.reminderRows()
    const messages = await fixture.mailMessages()
    const logs = fixture.dispatchLogs()
    const audits = await fixture.dispatchAudits()
    const duplicateRecipients = messages.length - new Set(messages.map((message) => message.to)).size
    const expectedBody = `You have an appointment in 24 hours.\n\n${fixture.appBaseUrl()}/appointments\n\nSign in to see the details, or to change or cancel it.`
    const scannedText = [
      ...messages.map((message) => JSON.stringify(message)),
      ...logs.map((log) => JSON.stringify(log)),
      ...audits.map(({ outcome, transport, leadHours }) => JSON.stringify({ outcome, transport, leadHours })),
    ].join('\n')
    const leakedTerms = fixture.phiTerms().filter((term) => scannedText.includes(term))
    const deliveryRate = messages.length / appointmentIds.length

    expect(responseTotals).toEqual({ due: 100, sent: 10, skipped: 90, failed: 0 })
    expect(rows).toHaveLength(10)
    expect(rows.every((row) => row.outcome === 'sent')).toBe(true)
    expect(messages).toHaveLength(10)
    expect(messages.every((message) => message.subject === 'Appointment reminder' && message.text === expectedBody)).toBe(true)
    expect(logs).toHaveLength(10)
    expect(audits).toHaveLength(10)
    expect(audits.every((audit) => audit.outcome === 'granted')).toBe(true)
    expect(duplicateRecipients).toBe(0)
    expect(leakedTerms).toEqual([])
    expect(deliveryRate).toBeGreaterThanOrEqual(0.99)

    await writeE8RunRecord({
      schemaVersion: 1,
      ticket: 'JOR-207',
      sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      measuredWindow: { startedAt: measuredStart, endedAt: measuredEnd },
      requests: results.length,
      uniqueDue: appointmentIds.length,
      responseTotals,
      durableRowCount: rows.length,
      dispatchCount: logs.length,
      duplicateCount: duplicateRecipients,
      deliveryRate,
      phiScan: { passed: leakedTerms.length === 0, termCount: fixture.phiTerms().length },
    })
    expect(await readE8RunRecord()).toMatchObject({
      ticket: 'JOR-207',
      uniqueDue: 10,
      durableRowCount: 10,
      dispatchCount: 10,
      duplicateCount: 0,
      deliveryRate: 1,
      phiScan: { passed: true },
    })
  }, 120_000)
})

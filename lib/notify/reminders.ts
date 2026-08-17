import 'server-only'

import { recordAuditEvent } from '../audit/events'
import { config } from '../config'
import { serviceClient } from '../db/client'
import { sendEmail, type EmailMessage, type SendOutcome } from './email'

type DueAppointment = { id: string; patients: { email: string }[] | null }
type OutboxRow = { id: string; recipient: string; subject: string; body: string; attempts: number }

export type ReminderRun = { due: number; sent: number; skipped: number; failed: number }

const REMINDER_SUBJECT = 'Appointment reminder'

export function reminderMessage(recipient: string): EmailMessage {
  return {
    to: recipient,
    subject: REMINDER_SUBJECT,
    text: `You have an appointment in ${config.reminderLeadHours} hours.\n\n${config.appBaseUrl}/appointments\n\nSign in to see the details, or to change or cancel it.`,
  }
}

async function audit(appointmentId: string, result: SendOutcome): Promise<void> {
  await recordAuditEvent({
    actorKind: 'system',
    actorRef: null,
    action: 'reminder.dispatch',
    targetKind: 'appointment',
    targetId: appointmentId,
    outcome: result.outcome === 'sent' ? 'granted' : 'denied',
    detail: { transport: result.transport, leadHours: config.reminderLeadHours },
  })
}

// Provider error text is untrusted: it can contain the recipient, a token, or
// PHI. The durable outbox retains only this public, non-identifying category.
function safeProviderCode(): string {
  return 'email_delivery_failed'
}

async function drainOutbox(client: ReturnType<typeof serviceClient>): Promise<void> {
  const { data, error } = await client
    .from('email_outbox')
    .select('id, recipient, subject, body, attempts')
    .is('sent_at', null)
    .lte('next_attempt_at', new Date().toISOString())
    .order('created_at', { ascending: true })
  if (error || !data) return

  for (const row of data as OutboxRow[]) {
    const result = await sendEmail({ to: row.recipient, subject: row.subject, text: row.body })
    if (result.outcome === 'sent') {
      await client.from('email_outbox').update({ sent_at: new Date().toISOString() }).eq('id', row.id).is('sent_at', null)
      continue
    }
    const attempts = row.attempts + 1
    const nextAttemptAt = new Date(Date.now() + config.reminderCronMinutes * attempts * 60_000).toISOString()
    await client
      .from('email_outbox')
      .update({ attempts, next_attempt_at: nextAttemptAt, last_error: safeProviderCode() })
      .eq('id', row.id)
      .is('sent_at', null)
  }
}

/** Dispatches due reminders then drains durable share-email work. */
export async function dispatchReminders(): Promise<ReminderRun> {
  const client = serviceClient()
  const leadStart = new Date(Date.now() + config.reminderLeadHours * 60 * 60_000).toISOString()
  const leadEnd = new Date(Date.now() + (config.reminderLeadHours * 60 + config.reminderWindowMinutes) * 60_000).toISOString()
  const { data, error } = await client
    .from('appointments')
    .select('id, patients!inner(email), slots!inner(starts_at)')
    .in('status', ['requested', 'confirmed'])
    .gte('slots.starts_at', leadStart)
    .lt('slots.starts_at', leadEnd)
  if (error) throw new Error('reminder due query unavailable')

  const run: ReminderRun = { due: (data ?? []).length, sent: 0, skipped: 0, failed: 0 }
  for (const appointment of (data ?? []) as DueAppointment[]) {
    // A previous failed pre-send record represents an ordinary retry. This is
    // the only delete in the build; a sent record can never satisfy it.
    await client.from('reminder_sends').delete().eq('appointment_id', appointment.id).eq('lead_hours', config.reminderLeadHours).eq('outcome', 'failed')
    const { data: inserted, error: insertError } = await client
      .from('reminder_sends')
      .insert({ appointment_id: appointment.id, lead_hours: config.reminderLeadHours, outcome: 'failed' })
      .select('appointment_id')
    if (insertError) {
      // A conflicting primary key means another run owns the send; conflict is
      // expected under overlapping cron invocations and is never surfaced.
      run.skipped += 1
      continue
    }
    if (!inserted?.length) {
      run.skipped += 1
      continue
    }
    const result = await sendEmail(reminderMessage(appointment.patients?.[0]?.email ?? ''))
    await audit(appointment.id, result)
    if (result.outcome === 'sent') {
      const { error: updateError } = await client
        .from('reminder_sends')
        .update({ outcome: 'sent', sent_at: new Date().toISOString() })
        .eq('appointment_id', appointment.id)
        .eq('lead_hours', config.reminderLeadHours)
      if (updateError) throw new Error('reminder send update unavailable')
      run.sent += 1
    } else {
      run.failed += 1
    }
  }
  await drainOutbox(client)
  return run
}

import 'server-only'

import { recordAuditEvent } from '../audit/events'
import { config } from '../config'
import { serviceClient } from '../db/client'
import { sendEmail, type EmailMessage, type SendOutcome } from './email'

type RelatedPatient = { email: string }
type DueAppointment = { id: string; patients: RelatedPatient | RelatedPatient[] | null }
type OutboxRow = {
  id: string
  recipient: string
  subject: string
  body: string
  attempts: number
  next_attempt_at: string
}
export type ReminderRun = { due: number; sent: number; skipped: number; failed: number }

const REMINDER_SUBJECT = 'Appointment reminder'
const MINUTES_PER_HOUR = 60
const MILLISECONDS_PER_MINUTE = 60_000

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

function patientEmail(appointment: DueAppointment): string {
  const patient = Array.isArray(appointment.patients) ? appointment.patients[0] : appointment.patients
  return patient?.email ?? ''
}

async function drainOutbox(client: ReturnType<typeof serviceClient>): Promise<void> {
  const { data, error } = await client
    .from('email_outbox')
    .select('id, recipient, subject, body, attempts, next_attempt_at')
    .is('sent_at', null)
    .lt('attempts', config.emailOutboxMaxAttempts)
    .lte('next_attempt_at', new Date().toISOString())
    .order('created_at', { ascending: true })
  if (error || !data) return

  for (const row of data as OutboxRow[]) {
    // Move the eligible row's due instant forward as an atomic lease. Matching
    // the value read above means only one overlapping drain receives the row
    // from UPDATE ... RETURNING and therefore only one calls the adapter.
    const claimedUntil = new Date(Date.now() + config.reminderCronMinutes * MILLISECONDS_PER_MINUTE).toISOString()
    const { data: claimed, error: claimError } = await client
      .from('email_outbox')
      .update({ next_attempt_at: claimedUntil })
      .eq('id', row.id)
      .is('sent_at', null)
      .eq('next_attempt_at', row.next_attempt_at)
      .select('id')
    if (claimError) throw new Error('email outbox claim unavailable')
    if (!claimed?.length) continue

    const result = await sendEmail({ to: row.recipient, subject: row.subject, text: row.body })
    if (result.outcome === 'sent') {
      const { error: sentError } = await client
        .from('email_outbox')
        .update({ sent_at: new Date().toISOString() })
        .eq('id', row.id)
        .is('sent_at', null)
      if (sentError) throw new Error('email outbox completion unavailable')
      continue
    }
    const attempts = row.attempts + 1
    const nextAttemptAt = new Date(
      Date.now() + config.reminderCronMinutes * attempts * MILLISECONDS_PER_MINUTE,
    ).toISOString()
    const { error: failureError } = await client
      .from('email_outbox')
      .update({ attempts, next_attempt_at: nextAttemptAt, last_error: safeProviderCode() })
      .eq('id', row.id)
      .is('sent_at', null)
    if (failureError) throw new Error('email outbox retry unavailable')
  }
}

/** Dispatches due reminders then drains durable share-email work. */
export async function dispatchReminders(): Promise<ReminderRun> {
  const client = serviceClient()
  const leadMinutes = config.reminderLeadHours * MINUTES_PER_HOUR
  const leadStart = new Date(Date.now() + leadMinutes * MILLISECONDS_PER_MINUTE).toISOString()
  const leadEnd = new Date(
    Date.now() + (leadMinutes + config.reminderWindowMinutes) * MILLISECONDS_PER_MINUTE,
  ).toISOString()
  const { data, error } = await client
    .from('appointments')
    .select('id, patients!inner(email), slots!inner(starts_at)')
    .in('status', ['requested', 'confirmed'])
    .gte('slots.starts_at', leadStart)
    .lt('slots.starts_at', leadEnd)
  if (error) throw new Error('reminder due query unavailable')

  const run: ReminderRun = { due: (data ?? []).length, sent: 0, skipped: 0, failed: 0 }
  for (const appointment of (data ?? []) as DueAppointment[]) {
    const { data: claimed, error: claimError } = await client.rpc('claim_reminder_send', {
      p_appointment_id: appointment.id,
      p_lead_hours: config.reminderLeadHours,
      p_claim_lease_minutes: config.reminderCronMinutes,
    })
    if (claimError) throw new Error('reminder send claim unavailable')
    if (!claimed) {
      run.skipped += 1
      continue
    }
    const result = await sendEmail(reminderMessage(patientEmail(appointment)))
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
      // Only an explicit provider rejection is safe to retry. An exception or
      // process death leaves retryable_at null because the provider may have
      // accepted the email before the response was lost.
      const { error: retryError } = await client
        .from('reminder_sends')
        .update({ retryable_at: new Date().toISOString() })
        .eq('appointment_id', appointment.id)
        .eq('lead_hours', config.reminderLeadHours)
        .eq('outcome', 'failed')
        .is('retryable_at', null)
      if (retryError) throw new Error('reminder retry unavailable')
      run.failed += 1
    }
  }
  await drainOutbox(client)
  return run
}

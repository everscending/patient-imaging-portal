'use client'

import { useState } from 'react'

export type Appointment = {
  id: string
  startsAt: string
  endsAt: string
  status: string
  providerName: string
  serviceName: string
  outOfHours: boolean
  canChange: boolean
  changeDeadline: string
  allowedTransitions: string[]
}

export const NOTICE_LOCKED_MESSAGE = 'Changes are not allowed within 24 hours of the start. Call the clinic.'

function viewerDateTime(value: string): string {
  const instant = new Date(value)
  if (Number.isNaN(instant.valueOf())) return value
  const parts = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZoneName: 'short',
  }).formatToParts(instant)
  return parts.map((part) => part.value).join('')
}

function statusWords(status: string): string {
  const words = status.replaceAll('_', '-').toLowerCase()
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`
}

function offeredActions(appointment: Appointment): { reschedule: boolean; cancel: boolean; noticeLocked: boolean } {
  const reschedule = appointment.canChange
  const cancel = appointment.allowedTransitions.includes('cancelled')
  return { reschedule, cancel, noticeLocked: !reschedule && !cancel }
}

function AppointmentDetails({ appointment }: { appointment: Appointment }) {
  return (
    <>
      <time dateTime={appointment.startsAt}>{viewerDateTime(appointment.startsAt)}</time>
      <span>{appointment.providerName}</span>
      <span>{appointment.serviceName}</span>
      <span aria-label={`Status: ${statusWords(appointment.status)}`}>Status: {statusWords(appointment.status)}</span>
    </>
  )
}

export function AppointmentTableRow({ appointment, onUpdated }: AppointmentCardProps) {
  return (
    <AppointmentItem appointment={appointment} onUpdated={onUpdated} asTableRow />
  )
}

type AppointmentCardProps = {
  appointment: Appointment
  onUpdated: (appointment: Appointment) => void
}

export function AppointmentCard({ appointment, onUpdated }: AppointmentCardProps) {
  return <AppointmentItem appointment={appointment} onUpdated={onUpdated} />
}

function AppointmentItem({ appointment, onUpdated, asTableRow = false }: AppointmentCardProps & { asTableRow?: boolean }) {
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [slotId, setSlotId] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const actions = offeredActions(appointment)

  async function patch(body: Record<string, string>): Promise<void> {
    setSaving(true)
    setMessage(null)
    try {
      const response = await fetch(`/api/appointments/${appointment.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json() as Appointment | { error?: string; message?: string }
      if (!response.ok) {
        const error = payload as { error?: string; message?: string }
        setMessage(error.error === 'minimum_notice' || error.error === 'not_reschedulable' ? NOTICE_LOCKED_MESSAGE : error.message ?? 'Unable to change this appointment.')
        return
      }
      onUpdated(payload as Appointment)
      setRescheduleOpen(false)
      setSlotId('')
    } catch {
      setMessage('Unable to change this appointment.')
    } finally {
      setSaving(false)
    }
  }

  const controls = (
    <div className="pip-appointment-actions">
      {actions.noticeLocked ? <p data-testid="appointment-notice-locked">{NOTICE_LOCKED_MESSAGE}</p> : null}
      {actions.reschedule ? (
        <button className="pip-appointment-button" data-testid="appointment-reschedule" type="button" disabled={saving} onClick={() => setRescheduleOpen(true)}>
          Reschedule
        </button>
      ) : null}
      {actions.cancel ? (
        <button className="pip-appointment-button" data-testid="appointment-cancel" type="button" disabled={saving} onClick={() => void patch({ action: 'cancel' })}>
          Cancel
        </button>
      ) : null}
      {rescheduleOpen ? (
        <form className="pip-appointment-reschedule-form" onSubmit={(event) => { event.preventDefault(); void patch({ action: 'reschedule', slotId }) }}>
          <label>
            New appointment slot ID
            <input required value={slotId} onChange={(event) => setSlotId(event.target.value)} />
          </label>
          <button className="pip-appointment-button" type="submit" disabled={saving}>Confirm reschedule</button>
        </form>
      ) : null}
      {message ? <p className="pip-error" role="alert">{message}</p> : null}
    </div>
  )

  const annotation = appointment.outOfHours ? (
    <p data-testid="appointment-out-of-hours"><strong>Outside hours</strong>. Your appointment is unaffected.</p>
  ) : null

  if (asTableRow) {
    return (
      <tr data-testid="appointment-item">
        <td><AppointmentDetails appointment={appointment} /></td>
        <td>{annotation}</td>
        <td>{controls}</td>
      </tr>
    )
  }

  return (
    <article className="pip-appointment-card" data-testid="appointment-item">
      <AppointmentDetails appointment={appointment} />
      {annotation}
      {controls}
    </article>
  )
}

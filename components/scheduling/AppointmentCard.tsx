'use client'

import { useState } from 'react'
import SlotList from './SlotList'

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
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
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
  const terminal = ['cancelled', 'completed', 'no_show'].includes(appointment.status)
  return { reschedule, cancel, noticeLocked: !terminal && !reschedule && !cancel }
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

type AppointmentCardProps = {
  appointment: Appointment
  onUpdated: (appointment: Appointment) => void
}

type SlotOption = { id: string; startsAt: string; endsAt: string }
type OpenSlots = { providerTimeZone: string; slots: SlotOption[] }

export function AppointmentCard({ appointment, onUpdated }: AppointmentCardProps) {
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [openSlots, setOpenSlots] = useState<OpenSlots | null>(null)
  const [slotsFailed, setSlotsFailed] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<SlotOption | null>(null)
  const [unavailableSlotIds, setUnavailableSlotIds] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const actions = offeredActions(appointment)

  function openReschedule(): void {
    setRescheduleOpen(true)
    setMessage(null)
    setSelectedSlot(null)
    setSlotsFailed(false)
    setOpenSlots(null)
    void fetch(`/api/appointments/${appointment.id}/slots`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('slots unavailable')
        return await response.json() as OpenSlots
      })
      .then(setOpenSlots)
      .catch(() => setSlotsFailed(true))
  }

  function closeReschedule(): void {
    setRescheduleOpen(false)
    setSelectedSlot(null)
    setMessage(null)
  }

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
        // The picked time was taken while the patient decided: grey it out in
        // the picker (same treatment as the booking page) and let them pick
        // another, rather than making them start over.
        if (response.status === 409 && body.slotId) {
          setUnavailableSlotIds((current) => new Set(current).add(body.slotId))
          setSelectedSlot(null)
        }
        setMessage(error.message ?? 'Unable to change this appointment.')
        return
      }
      onUpdated(payload as Appointment)
      closeReschedule()
    } catch {
      setMessage('Unable to change this appointment.')
    } finally {
      setSaving(false)
    }
  }

  const controls = (
    <div className="pip-appointment-actions">
      {actions.noticeLocked ? <p data-testid="appointment-notice-locked">{NOTICE_LOCKED_MESSAGE}</p> : null}
      {actions.reschedule && !rescheduleOpen ? (
        <button className="pip-appointment-button" data-testid="appointment-reschedule" type="button" disabled={saving} onClick={openReschedule}>
          Reschedule
        </button>
      ) : null}
      {actions.cancel && !rescheduleOpen ? (
        <button className="pip-appointment-button" data-testid="appointment-cancel" type="button" disabled={saving} onClick={() => void patch({ action: 'cancel' })}>
          Cancel
        </button>
      ) : null}
      {rescheduleOpen ? (
        <div className="pip-appointment-reschedule" data-testid="appointment-reschedule-panel">
          <p className="pip-appointment-reschedule-heading">Pick a new time for this appointment.</p>
          {!openSlots && !slotsFailed ? (
            <p aria-busy="true" role="status">Loading open times…</p>
          ) : null}
          {slotsFailed ? (
            <p role="alert">Open times are temporarily unavailable. Please try again.</p>
          ) : null}
          {openSlots ? (
            <SlotList
              slots={openSlots.slots}
              viewerTimeZone={Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}
              providerTimeZone={openSlots.providerTimeZone}
              selectedSlotId={selectedSlot?.id ?? null}
              unavailableSlotIds={unavailableSlotIds}
              onSelect={(slot) => { setSelectedSlot(slot); setMessage(null) }}
            />
          ) : null}
          <div className="pip-appointment-reschedule-actions">
            {selectedSlot ? (
              <button
                className="pip-appointment-button"
                data-testid="appointment-reschedule-confirm"
                type="button"
                disabled={saving}
                onClick={() => void patch({ action: 'reschedule', slotId: selectedSlot.id })}
              >
                Move to {viewerDateTime(selectedSlot.startsAt)}
              </button>
            ) : null}
            <button className="pip-appointment-button" type="button" disabled={saving} onClick={closeReschedule}>
              Keep current time
            </button>
          </div>
        </div>
      ) : null}
      {message ? <p className="pip-error" role="alert">{message}</p> : null}
    </div>
  )

  const annotation = appointment.outOfHours ? (
    <p data-testid="appointment-out-of-hours"><strong>Outside hours</strong>. Your appointment is unaffected.</p>
  ) : null

  return (
    <tr className="pip-appointment-card" data-testid="appointment-item">
      <td><AppointmentDetails appointment={appointment} /></td>
      <td>{annotation}</td>
      <td>{controls}</td>
    </tr>
  )
}

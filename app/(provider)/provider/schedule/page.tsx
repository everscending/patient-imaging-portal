'use client'

import { useEffect, useState } from 'react'
import { useProviderShell } from '../../../../components/shell/ProviderShell'
import type { AppointmentDto } from '../../../../lib/scheduling/booking'

type Transition = AppointmentDto['allowedTransitions'][number]
type Schedule = {
  timeZone: string
  slots: Array<{
    id: string
    startsAt: string
    endsAt: string
    status: 'open' | 'booked'
    appointment: null | {
      id: string
      patientRef: string
      serviceName: string
      status: AppointmentDto['status']
      outOfHours: boolean
      allowedTransitions: AppointmentDto['allowedTransitions']
    }
  }>
}

function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function time(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(instant))
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function shiftDay(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00Z`)
  instant.setUTCDate(instant.getUTCDate() + days)
  return instant.toISOString().slice(0, 10)
}

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`))
}

const ACTION_LABELS: Partial<Record<Transition, string>> = {
  confirmed: 'Confirm',
  completed: 'Complete',
  cancelled: 'Cancel',
  no_show: 'Mark no-show',
}

function actionLabel(status: Transition): string {
  return ACTION_LABELS[status] ?? status
}

export default function ProviderSchedulePage() {
  const { timeZone: shellTimeZone } = useProviderShell()
  if (!shellTimeZone) throw new Error('Provider schedule requires a provider identity')
  const [date, setDate] = useState(() => todayIn(shellTimeZone))
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => setHydrated(true), [])

  useEffect(() => {
    let cancelled = false
    setSchedule(null)
    setError(null)
    void fetch(`/api/provider/schedule?date=${encodeURIComponent(date)}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as Schedule | { message?: string }
        if (!response.ok) throw new Error('message' in body ? body.message : 'Schedule could not be loaded.')
        if (!cancelled) setSchedule(body as Schedule)
      })
      .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : 'Schedule could not be loaded.'))
    return () => { cancelled = true }
  }, [date])

  async function change(appointmentId: string, status: Transition): Promise<void> {
    setError(null)
    const body = status === 'cancelled' ? { action: 'cancel' } : { action: 'transition', status }
    try {
      const response = await fetch(`/api/appointments/${appointmentId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const appointment = await response.json() as AppointmentDto & { message?: string }
      if (!response.ok) throw new Error(appointment.message ?? 'Appointment could not be updated.')
      setSchedule((current) => current && {
        ...current,
        slots: current.slots.map((slot) => slot.appointment?.id !== appointmentId ? slot : {
          ...slot,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          appointment: {
            ...slot.appointment,
            status: appointment.status,
            serviceName: appointment.serviceName,
            outOfHours: appointment.outOfHours,
            allowedTransitions: appointment.allowedTransitions,
          },
        }),
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Appointment could not be updated.')
    }
  }

  const validDate = DATE_PATTERN.test(date)
  const booked = schedule?.slots.filter((slot) => slot.status === 'booked').length ?? 0
  const open = schedule ? schedule.slots.length - booked : 0

  return (
    <section data-testid="provider-schedule" className="pip-sched">
      <header className="pip-sched-header">
        <div>
          <h1 className="pip-sched-title">{validDate ? dayLabel(date) : 'Schedule'}</h1>
          <p className="pip-sched-summary">
            {schedule ? <>{booked} booked · {open} open · </> : null}
            <span>{schedule?.timeZone ?? shellTimeZone}</span>
          </p>
        </div>
        <div className="pip-sched-datenav">
          <button
            type="button" className="pip-slot-day-arrow" aria-label="Previous day"
            disabled={!hydrated || !validDate} onClick={() => setDate(shiftDay(date, -1))}
          >‹</button>
          <input
            id="schedule-date" type="date" aria-label="Date" className="pip-input"
            value={date} disabled={!hydrated} onChange={(event) => setDate(event.target.value)}
          />
          <button
            type="button" className="pip-slot-day-arrow" aria-label="Next day"
            disabled={!hydrated || !validDate} onClick={() => setDate(shiftDay(date, 1))}
          >›</button>
          <button
            type="button" className="pip-button-secondary" disabled={!hydrated}
            onClick={() => setDate(todayIn(shellTimeZone))}
          >Today</button>
        </div>
      </header>
      {error ? <p role="alert" className="pip-error pip-sched-alert">{error}</p> : null}
      {!schedule && !error ? <p className="pip-notice">Loading schedule…</p> : null}
      <div className="pip-sched-day">
        {schedule?.slots.map((slot) => (
          <article
            data-testid="provider-schedule-row" key={slot.id}
            className={`pip-sched-row pip-sched-row--${slot.status === 'open' ? 'open' : slot.appointment?.status ?? 'open'}`}
          >
            <p className="pip-sched-time">
              {time(slot.startsAt, schedule.timeZone)}<span className="pip-sched-time-end">–{time(slot.endsAt, schedule.timeZone)}</span>
            </p>
            {slot.status === 'open' || !slot.appointment ? (
              <div className="pip-sched-detail">
                <p className="pip-sched-open">Open</p>
                {slot.appointment?.status === 'cancelled' ? <p className="pip-sched-note">Previous booking cancelled.</p> : null}
              </div>
            ) : (
              <div className="pip-sched-detail">
                <p className="pip-sched-line">
                  {slot.appointment.patientRef} · {slot.appointment.serviceName} · <span className={`pip-sched-badge pip-sched-badge--${slot.appointment.status}`}>{slot.appointment.status}</span>
                </p>
                {slot.appointment.outOfHours ? <p className="pip-sched-oow">Outside hours — this appointment is unaffected.</p> : null}
                {slot.appointment.allowedTransitions.length > 0 ? (
                  <div className="pip-sched-actions">
                    {slot.appointment.allowedTransitions.map((status) => (
                      <button
                        data-testid="provider-transition-action" key={status} type="button"
                        className={`pip-button-secondary pip-sched-action${status === 'cancelled' ? ' pip-sched-action--cancel' : ''}`}
                        onClick={() => void change(slot.appointment!.id, status)}
                      >
                        {actionLabel(status)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </article>
        ))}
      </div>
      {schedule?.slots.length === 0 ? <p className="pip-notice">No slots for this day.</p> : null}
    </section>
  )
}

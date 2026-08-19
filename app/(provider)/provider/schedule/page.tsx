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
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(instant))
}

function actionLabel(status: Transition): string {
  return status === 'no_show' ? 'Mark no-show' : status[0]!.toUpperCase() + status.slice(1)
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

  return (
    <section data-testid="provider-schedule">
      <h1>Schedule</h1>
      <p>Time zone: <strong>{schedule?.timeZone ?? shellTimeZone}</strong></p>
      <label htmlFor="schedule-date">Date</label>
      <input id="schedule-date" type="date" value={date} disabled={!hydrated} onChange={(event) => setDate(event.target.value)} />
      {error ? <p role="alert">{error}</p> : null}
      {!schedule && !error ? <p>Loading schedule…</p> : null}
      {schedule?.slots.map((slot) => (
        <article data-testid="provider-schedule-row" key={slot.id}>
          <p>{time(slot.startsAt, schedule.timeZone)}–{time(slot.endsAt, schedule.timeZone)}</p>
          {!slot.appointment ? <p>Open</p> : (
            <>
              <p>{slot.appointment.patientRef} · {slot.appointment.serviceName} · {slot.appointment.status}</p>
              {slot.appointment.outOfHours ? <p>Outside hours — this appointment is unaffected.</p> : null}
              {slot.appointment.allowedTransitions.map((status) => (
                <button data-testid="provider-transition-action" key={status} type="button" onClick={() => void change(slot.appointment!.id, status)}>
                  {actionLabel(status)}
                </button>
              ))}
            </>
          )}
        </article>
      ))}
      {schedule?.slots.length === 0 ? <p>No slots for this day.</p> : null}
    </section>
  )
}

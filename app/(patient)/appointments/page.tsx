'use client'

import { useEffect, useState } from 'react'
import { AppointmentCard, type Appointment } from '../../../components/scheduling/AppointmentCard'

function isAppointment(value: unknown): value is Appointment {
  if (!value || typeof value !== 'object') return false
  const appointment = value as Record<string, unknown>
  return typeof appointment.id === 'string' && typeof appointment.startsAt === 'string' && typeof appointment.endsAt === 'string' &&
    typeof appointment.status === 'string' && typeof appointment.providerName === 'string' && typeof appointment.serviceName === 'string' &&
    typeof appointment.outOfHours === 'boolean' && typeof appointment.canChange === 'boolean' && typeof appointment.changeDeadline === 'string' &&
    Array.isArray(appointment.allowedTransitions) && appointment.allowedTransitions.every((transition) => typeof transition === 'string')
}

function readAppointments(value: unknown): Appointment[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).appointments)) {
    throw new Error('appointments response is invalid')
  }
  const appointments = (value as { appointments: unknown[] }).appointments
  if (!appointments.every(isAppointment)) throw new Error('appointments response omitted allowedTransitions or another required field')
  return appointments
}

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<Appointment[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let active = true
    void fetch('/api/appointments', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('appointments unavailable')
      return readAppointments(await response.json())
    }).then((items) => {
      if (active) setAppointments(items)
    }).catch((error: unknown) => {
      if (!active) return
      if (error instanceof Error && error.message.includes('allowedTransitions')) throw error
      setUnavailable(true)
    })
    return () => { active = false }
  }, [])

  function replace(updated: Appointment): void {
    setAppointments((current) => current?.map((appointment) => appointment.id === updated.id ? updated : appointment) ?? current)
  }

  return (
    <main className="pip-appointments-page">
      <h1>Appointments</h1>
      {unavailable ? <p role="alert">Appointments are temporarily unavailable.</p> : null}
      {appointments?.length === 0 ? <p data-testid="appointments-empty"><strong>No appointments yet</strong> — booked appointments appear here.</p> : null}
      {appointments && appointments.length > 0 ? (
        <section aria-label="Appointments" data-testid="appointment-list">
          <table className="pip-appointment-table">
            <caption className="pip-visually-hidden">Appointments</caption>
            <thead><tr><th scope="col">Appointment</th><th scope="col">Annotation</th><th scope="col">Actions</th></tr></thead>
            <tbody>{appointments.map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} onUpdated={replace} />)}</tbody>
          </table>
        </section>
      ) : null}
      <style>{`
        .pip-appointments-page { max-width: 72rem; margin: 0 auto; overflow-wrap: anywhere; }
        .pip-appointment-card { display: grid; gap: 0.5rem; min-width: 0; padding: 1rem; border: 1px solid var(--pip-color-base-300); border-radius: 0.75rem; background: var(--pip-color-base-100); }
        .pip-appointment-card td { display: block; padding: 0; border: 0; }
        .pip-appointment-card td:first-child > span, .pip-appointment-card td:first-child > time { display: block; margin-bottom: 0.25rem; }
        .pip-appointment-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
        .pip-appointment-actions p { margin: 0; }
        .pip-appointment-button { min-width: var(--pip-tap-target); min-height: var(--pip-tap-target); padding: 0.5rem 0.75rem; border: 1px solid var(--pip-color-primary); border-radius: 0.5rem; color: var(--pip-color-primary); background: var(--pip-color-base-100); font: inherit; font-weight: 600; }
        .pip-appointment-button:focus-visible, .pip-appointment-reschedule-form input:focus-visible { outline: 2px solid var(--pip-color-accent); outline-offset: 2px; }
        .pip-appointment-reschedule-form { display: flex; flex-wrap: wrap; align-items: end; gap: 0.5rem; width: 100%; }
        .pip-appointment-reschedule-form label { display: grid; gap: 0.25rem; font-weight: 600; }
        .pip-appointment-reschedule-form input { min-height: var(--pip-tap-target); max-width: 100%; border: 1px solid var(--pip-color-base-300); border-radius: 0.5rem; padding: 0.5rem; color: var(--pip-color-base-content); background: var(--pip-color-base-100); font: inherit; }
        .pip-appointment-table { display: block; width: 100%; border-collapse: collapse; }
        .pip-appointment-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
        .pip-appointment-table tbody { display: grid; gap: 0.75rem; }
        @media (min-width: 768px) {
          .pip-appointment-table { display: table; }
          .pip-appointment-table thead { position: static; width: auto; height: auto; overflow: visible; clip: auto; clip-path: none; white-space: normal; }
          .pip-appointment-table tbody { display: table-row-group; }
          .pip-appointment-card { display: table-row; padding: 0; border: 0; border-radius: 0; background: transparent; }
          .pip-appointment-card td { display: table-cell; padding: 0.75rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--pip-color-base-300); }
        }
      `}</style>
    </main>
  )
}

import { z } from 'zod'

import { guardPhiAccess, resolveScheduleActor } from '../../../../lib/access/guard'
import { resolveCallerId } from '../../../../lib/access/identity'
import { config } from '../../../../lib/config'
import { anonClient } from '../../../../lib/db/client'
import { allowedTransitions, type AppointmentStatus } from '../../../../lib/scheduling/lifecycle'
import { SESSION_COOKIE_NAME } from '../../../../lib/session-cookie'
import { zonedTimeToInstant } from '../../../../lib/time/zones'
import { errorResponse } from '../../../../lib/validation/envelope'
import { cookies } from 'next/headers'

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const UNKNOWN_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000'

type SlotRow = { id: string; starts_at: string; ends_at: string; status: 'open' | 'booked' }
type AppointmentRow = {
  id: string
  slot_id: string
  status: AppointmentStatus
  out_of_hours: boolean
  patients: { patient_ref: string } | Array<{ patient_ref: string }> | null
  services: { name: string } | Array<{ name: string }> | null
}

function nextDate(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`)
  instant.setUTCDate(instant.getUTCDate() + 1)
  return instant.toISOString().slice(0, 10)
}

function validCalendarDate(date: string): boolean {
  return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
}

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

export async function GET(request: Request): Promise<Response> {
  let callerId: string | null
  let actor: Awaited<ReturnType<typeof resolveScheduleActor>> | { kind: 'provider'; userId: string }
  try {
    callerId = await resolveCallerId()
    actor = callerId ? await resolveScheduleActor(callerId) : { kind: 'provider', userId: UNKNOWN_ACCOUNT_ID }
  } catch {
    return errorResponse(503, 'schedule_unavailable', 'Schedule is temporarily unavailable.')
  }

  // This is intentionally before date validation: every request to this PHI
  // surface is one audited schedule.view decision, including malformed input.
  let access: Awaited<ReturnType<typeof guardPhiAccess>>
  try {
    const providerId = actor.kind === 'provider' ? actor.userId : UNKNOWN_ACCOUNT_ID
    // The guard resolves provider membership itself; its schedule id must be
    // the provider row, obtained below from the caller-scoped provider read.
    if (!callerId || actor.kind !== 'provider') {
      access = await guardPhiAccess(actor, { kind: 'schedule', id: UNKNOWN_ACCOUNT_ID }, 'schedule.view')
      if (!access.ok) return denied(access.status)
      return denied(404)
    }
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
    if (!token) return denied(401)
    const client = anonClient(token)
    const providerResult = await client.from('providers').select('id,time_zone').eq('user_id', callerId).maybeSingle()
    const provider = providerResult.data as { id: string; time_zone: string } | null
    if (providerResult.error || !provider) {
      access = await guardPhiAccess(actor, { kind: 'schedule', id: providerId }, 'schedule.view')
      if (!access.ok) return denied(access.status)
      return denied(404)
    }
    const requestedProviderId = new URL(request.url).searchParams.get('providerId') ?? provider.id
    access = await guardPhiAccess(actor, { kind: 'schedule', id: requestedProviderId }, 'schedule.view')
    if (!access.ok) return denied(access.status)
    if (requestedProviderId !== provider.id) return denied(404)

    const dateResult = DateSchema.safeParse(new URL(request.url).searchParams.get('date'))
    if (!dateResult.success || !validCalendarDate(dateResult.data)) {
      return errorResponse(422, 'validation_failed', 'Date must be a calendar date (YYYY-MM-DD).')
    }
    const startsAt = zonedTimeToInstant(provider.time_zone, dateResult.data, '00:00:00').toISOString()
    const endsAt = zonedTimeToInstant(provider.time_zone, nextDate(dateResult.data), '00:00:00').toISOString()
    const { data: slotData, error: slotError } = await client
      .from('slots')
      .select('id,starts_at,ends_at,status')
      .eq('provider_id', provider.id)
      .gte('starts_at', startsAt)
      .lt('starts_at', endsAt)
      .order('starts_at')
    if (slotError) throw new Error('schedule slots read failed')
    const slots = (slotData ?? []) as SlotRow[]
    const slotIds = slots.map((slot) => slot.id)
    const appointmentsResult = slotIds.length === 0
      ? { data: [] as AppointmentRow[], error: null }
      : await client
        .from('appointments')
        .select('id,slot_id,status,out_of_hours,patients!inner(patient_ref),services!inner(name)')
        .in('slot_id', slotIds)
    if (appointmentsResult.error) throw new Error('schedule appointments read failed')
    const appointments = new Map((appointmentsResult.data as AppointmentRow[]).map((appointment) => [appointment.slot_id, appointment]))
    const now = new Date()

    return Response.json({
      timeZone: provider.time_zone,
      slots: slots.map((slot) => {
        const appointment = appointments.get(slot.id)
        if (!appointment) return { id: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at, status: slot.status, appointment: null }
        const patient = Array.isArray(appointment.patients) ? appointment.patients[0] : appointment.patients
        const service = Array.isArray(appointment.services) ? appointment.services[0] : appointment.services
        const starts = new Date(slot.starts_at)
        return {
          id: slot.id,
          startsAt: slot.starts_at,
          endsAt: slot.ends_at,
          status: slot.status,
          appointment: {
            id: appointment.id,
            patientRef: patient?.patient_ref ?? '',
            serviceName: service?.name ?? '',
            status: appointment.status,
            outOfHours: appointment.out_of_hours,
            allowedTransitions: allowedTransitions({
              status: appointment.status,
              role: 'provider',
              startsAt: starts,
              changeDeadline: new Date(starts.getTime() - config.minChangeNoticeHours * 60 * 60 * 1_000),
              now,
            }),
          },
        }
      }),
    }, { status: 200 })
  } catch {
    return errorResponse(503, 'schedule_unavailable', 'Schedule is temporarily unavailable.')
  }
}

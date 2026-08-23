// Open slots a patient may reschedule this appointment onto: the same
// provider's open future grid, served against the appointment so the client
// never needs provider/service ids of its own. RLS scopes the appointment
// read; a row the caller cannot see 404s exactly like the PATCH route.
import { guardPhiAccess, resolveScheduleActor } from '../../../../../lib/access/guard'
import { resolveAuthenticatedSession, resolveCallerId } from '../../../../../lib/access/identity'
import { config } from '../../../../../lib/config'
import { anonClient } from '../../../../../lib/db/client'
import { appointmentParamsSchema, parseParams } from '../../../../../lib/validation'
import { errorResponse } from '../../../../../lib/validation/envelope'

// The booking window is the generated grid's horizon — the ADR-0012 stated
// parameter, never a hardcoded twin of it (ADR-0008's no-duplicate rule).
const SLOT_WINDOW_DAYS = config.slotHorizonDays

type RouteContext = { params: Promise<{ id: string }> }

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const callerId = await resolveCallerId()
    if (!callerId) return denied(401)
    const params = parseParams(appointmentParamsSchema, await context.params)
    if (!params.ok) return params.response
    const actor = await resolveScheduleActor(callerId)
    const access = await guardPhiAccess(actor, { kind: 'appointment', id: params.value.id }, 'appointment.view')
    if (!access.ok) return denied(access.status)
    const session = await resolveAuthenticatedSession()
    if (!session) return denied(401)
    const client = anonClient(session.accessToken)

    const { data: appointment, error: appointmentError } = await client
      .from('appointments')
      .select('id, provider_id, providers!inner(time_zone)')
      .eq('id', params.value.id)
      .maybeSingle()
    if (appointmentError) return errorResponse(503, 'appointments_unavailable', 'Appointments are temporarily unavailable.')
    if (!appointment) return denied(404)
    const provider = Array.isArray(appointment.providers) ? appointment.providers[0] : appointment.providers

    const from = new Date()
    const to = new Date(from)
    to.setDate(to.getDate() + SLOT_WINDOW_DAYS)
    const { data, error } = await client
      .from('slots')
      .select('id, starts_at, ends_at')
      .eq('provider_id', appointment.provider_id)
      .eq('status', 'open')
      .gt('starts_at', from.toISOString())
      .lt('starts_at', to.toISOString())
      .order('starts_at')
    if (error) return errorResponse(503, 'appointments_unavailable', 'Appointments are temporarily unavailable.')

    return Response.json({
      providerTimeZone: (provider as { time_zone: string } | null)?.time_zone ?? 'UTC',
      slots: (data ?? []).map((slot) => ({ id: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at })),
    })
  } catch {
    return errorResponse(503, 'appointments_unavailable', 'Appointments are temporarily unavailable.')
  }
}

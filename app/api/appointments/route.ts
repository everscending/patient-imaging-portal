import { z } from 'zod'
import { guardPhiAccess, resolveScheduleActor } from '../../../lib/access/guard'
import { resolveCallerId } from '../../../lib/access/identity'
import { bookForActor, listAppointments } from '../../../lib/scheduling/booking'
import { parseBody, uuidSchema } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

const CreateSchema = z.object({
  slotId: uuidSchema,
  serviceId: uuidSchema,
  idempotencyKey: z.string().uuid(),
}).strict()

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(CreateSchema, request)
  if (!parsed.ok) return parsed.response
  const callerId = await resolveCallerId()
  if (!callerId) return denied(401)
  try {
    const result = await bookForActor({ ...parsed.value, actorUserId: callerId })
    if (!result.ok) {
      const status = result.error === 'service_not_offered' ? 422 : 409
      return errorResponse(status, result.error, result.error === 'service_not_offered' ? 'This service is not offered for that slot.' : 'The appointment could not be booked.')
    }
    const { id, startsAt, endsAt, status, providerName, serviceName } = result.appointment
    return Response.json({ id, slotId: parsed.value.slotId, startsAt, endsAt, status, providerName, serviceName }, { status: result.reused ? 200 : 201 })
  } catch {
    return errorResponse(503, 'booking_unavailable', 'Booking is temporarily unavailable.')
  }
}

export async function GET(): Promise<Response> {
  const callerId = await resolveCallerId()
  const actor = callerId ? await resolveScheduleActor(callerId) : { kind: 'patient' as const, userId: '' }
  const access = await guardPhiAccess(actor, { kind: 'collection', of: 'appointment' }, 'appointment.view')
  if (!access.ok) return denied(access.status)
  if (!callerId) return denied(401)
  try {
    return Response.json(await listAppointments(callerId), { status: 200 })
  } catch {
    return errorResponse(503, 'appointments_unavailable', 'Appointments are temporarily unavailable.')
  }
}

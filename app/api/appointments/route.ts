import { z } from 'zod'
import { guardPhiAccess, resolveScheduleActor } from '../../../lib/access/guard'
import { resolveCallerId } from '../../../lib/access/identity'
import { bookForActor, listAppointments, type BookResult } from '../../../lib/scheduling/booking'
import { parseBody, uuidSchema } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

const CreateSchema = z.object({
  slotId: uuidSchema,
  serviceId: uuidSchema,
  idempotencyKey: z.string().uuid(),
}).strict()
type BookError = Extract<BookResult, { ok: false }>['error']
const BOOK_ERROR_RESPONSES = {
  slot_unavailable: { status: 409, message: 'That slot is no longer available.' },
  idempotency_key_reused: { status: 409, message: 'That request key was already used for a different slot.' },
  service_not_offered: { status: 422, message: 'This provider does not offer that service.' },
} as const satisfies Record<BookError, { status: number; message: string }>

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(CreateSchema, request)
  if (!parsed.ok) return parsed.response
  try {
    const callerId = await resolveCallerId()
    if (!callerId) return denied(401)
    const result = await bookForActor({ ...parsed.value, actorUserId: callerId })
    if (!result.ok) {
      const mapping = BOOK_ERROR_RESPONSES[result.error]
      return errorResponse(mapping.status, result.error, mapping.message)
    }
    const { id, startsAt, endsAt, status, providerName, serviceName } = result.appointment
    return Response.json({ id, slotId: parsed.value.slotId, startsAt, endsAt, status, providerName, serviceName }, { status: result.reused ? 200 : 201 })
  } catch {
    return errorResponse(503, 'booking_unavailable', 'Booking is temporarily unavailable.')
  }
}

export async function GET(): Promise<Response> {
  try {
    const callerId = await resolveCallerId()
    const actor = callerId ? await resolveScheduleActor(callerId) : { kind: 'patient' as const, userId: '' }
    const access = await guardPhiAccess(actor, { kind: 'collection', of: 'appointment' }, 'appointment.view')
    if (!access.ok) return denied(access.status)
    if (!callerId) return denied(401)
    return Response.json({ appointments: await listAppointments(callerId) }, { status: 200 })
  } catch {
    return errorResponse(503, 'appointments_unavailable', 'Appointments are temporarily unavailable.')
  }
}

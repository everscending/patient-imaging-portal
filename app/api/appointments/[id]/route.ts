import { z } from 'zod'
import { guardPhiAccess, resolveScheduleActor } from '../../../../lib/access/guard'
import { resolveCallerId } from '../../../../lib/access/identity'
import { cancel, reschedule, transition } from '../../../../lib/scheduling/booking'
import { clinicianTransitionStatuses } from '../../../../lib/scheduling/lifecycle'
import { parseBody, parseParams, uuidSchema } from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

const ParamsSchema = z.object({ id: uuidSchema }).strict()
const PatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reschedule'), slotId: uuidSchema }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('transition'), status: z.enum(clinicianTransitionStatuses) }).strict(),
])
type RouteContext = { params: Promise<{ id: string }> }

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const params = parseParams(ParamsSchema, await context.params)
  if (!params.ok) return params.response
  const body = await parseBody(PatchSchema, request)
  if (!body.ok) return body.response
  const callerId = await resolveCallerId()
  const actor = callerId ? await resolveScheduleActor(callerId) : { kind: 'patient' as const, userId: '' }
  const access = await guardPhiAccess(actor, { kind: 'appointment', id: params.value.id }, 'appointment.view')
  if (!access.ok) return denied(access.status)
  if (!callerId) return denied(401)
  try {
    const result = body.value.action === 'reschedule'
      ? await reschedule({ appointmentId: params.value.id, slotId: body.value.slotId, actorUserId: callerId })
      : body.value.action === 'cancel'
        ? await cancel({ appointmentId: params.value.id, actorUserId: callerId })
        : await transition({ appointmentId: params.value.id, status: body.value.status, actorUserId: callerId })
    if (!result.ok) {
      if (result.error === 'invalid_transition') return errorResponse(422, 'invalid_transition', "That change is not allowed from this appointment's current status.")
      const status = result.error === 'slot_unavailable' ? 409 : 422
      return errorResponse(status, result.error, 'The appointment could not be changed.')
    }
    return Response.json(result.appointment, { status: 200 })
  } catch {
    return errorResponse(503, 'appointments_unavailable', 'Appointments are temporarily unavailable.')
  }
}

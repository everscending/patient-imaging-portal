import { guardPhiAccess, resolveScheduleActor } from '../../../../lib/access/guard'
import { resolveCallerId } from '../../../../lib/access/identity'
import { cancel, reschedule, transition, type ChangeResult } from '../../../../lib/scheduling/booking'
import { appointmentParamsSchema, appointmentPatchSchema, parseBody, parseParams } from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

type ChangeError = Extract<ChangeResult, { ok: false }>['error']
const CHANGE_ERROR_RESPONSES = {
  slot_unavailable: { status: 409, message: 'That slot is no longer available.' },
  minimum_notice: { status: 422, message: 'Changes are not allowed within 24 hours of the appointment.' },
  not_reschedulable: { status: 422, message: 'This appointment can no longer be changed.' },
} as const satisfies Record<ChangeError, { status: number; message: string }>
type RouteContext = { params: Promise<{ id: string }> }

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const params = parseParams(appointmentParamsSchema, await context.params)
  if (!params.ok) return params.response
  try {
    const callerId = await resolveCallerId()
    const actor = callerId ? await resolveScheduleActor(callerId) : { kind: 'patient' as const, userId: '' }
    const access = await guardPhiAccess(actor, { kind: 'appointment', id: params.value.id }, 'appointment.view')
    if (!access.ok) return denied(access.status)
    if (!callerId) return denied(401)
    const body = await parseBody(appointmentPatchSchema, request)
    if (!body.ok) return body.response
    const result = body.value.action === 'reschedule'
      ? await reschedule({ appointmentId: params.value.id, slotId: body.value.slotId, actorUserId: callerId })
      : body.value.action === 'cancel'
        ? await cancel({ appointmentId: params.value.id, actorUserId: callerId })
        : await transition({ appointmentId: params.value.id, status: body.value.status, actorUserId: callerId })
    if (!result.ok) {
      if (result.error === 'invalid_transition') return errorResponse(422, 'invalid_transition', "That change is not allowed from this appointment's current status.")
      const mapping = CHANGE_ERROR_RESPONSES[result.error]
      return errorResponse(mapping.status, result.error, mapping.message)
    }
    return Response.json(result.appointment, { status: 200 })
  } catch {
    return errorResponse(503, 'appointments_unavailable', 'Appointments are temporarily unavailable.')
  }
}

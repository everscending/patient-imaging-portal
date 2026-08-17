import { guardPhiAccess, resolveScheduleActor } from '../../../../../lib/access/guard'
import { resolveCallerId } from '../../../../../lib/access/identity'
import {
  applyAvailability,
  AvailabilityValidationError,
  getAvailability,
} from '../../../../../lib/scheduling/availability'
import { availabilityParamsSchema, availabilityPatchSchema, parseBody, parseParams } from '../../../../../lib/validation'
import { errorResponse } from '../../../../../lib/validation/envelope'


type RouteContext = { params: Promise<{ providerId: string }> }
const UNKNOWN_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000'

async function authenticate(): Promise<{ ok: true; callerId: string | null } | { ok: false; response: Response }> {
  try {
    return { ok: true, callerId: await resolveCallerId() }
  } catch {
    return { ok: false, response: errorResponse(503, 'availability_unavailable', 'Availability is temporarily unavailable.') }
  }
}

async function authorize(providerId: string, callerId: string | null): Promise<{ ok: true; callerId: string } | { ok: false; response: Response }> {
  let actor: Awaited<ReturnType<typeof resolveScheduleActor>>
  try {
    actor = callerId
      ? await resolveScheduleActor(callerId)
      : { kind: 'provider', userId: UNKNOWN_ACCOUNT_ID }
  } catch {
    return { ok: false, response: errorResponse(503, 'availability_unavailable', 'Availability is temporarily unavailable.') }
  }
  let decision: Awaited<ReturnType<typeof guardPhiAccess>>
  try {
    decision = await guardPhiAccess(actor, { kind: 'schedule', id: providerId }, 'schedule.view')
  } catch {
    return { ok: false, response: errorResponse(503, 'availability_unavailable', 'Availability is temporarily unavailable.') }
  }
  if (!decision.ok) {
    return {
      ok: false,
      response:
        decision.status === 401
          ? errorResponse(401, 'session_required', 'Sign in to continue.')
          : errorResponse(404, 'not_found', 'The requested resource was not found.'),
    }
  }
  if (!callerId) return { ok: false, response: errorResponse(401, 'session_required', 'Sign in to continue.') }
  return { ok: true, callerId }
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const authentication = await authenticate()
  if (!authentication.ok) return authentication.response
  if (!authentication.callerId) {
    const authorization = await authorize((await context.params).providerId, null)
    return authorization.ok ? errorResponse(401, 'session_required', 'Sign in to continue.') : authorization.response
  }
  const parsedParams = parseParams(availabilityParamsSchema, await context.params)
  if (!parsedParams.ok) return parsedParams.response
  const authorization = await authorize(parsedParams.value.providerId, authentication.callerId)
  if (!authorization.ok) return authorization.response

  try {
    return Response.json(await getAvailability(parsedParams.value.providerId), { status: 200 })
  } catch {
    return errorResponse(503, 'availability_unavailable', 'Availability is temporarily unavailable.')
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const authentication = await authenticate()
  if (!authentication.ok) return authentication.response
  if (!authentication.callerId) {
    const authorization = await authorize((await context.params).providerId, null)
    return authorization.ok ? errorResponse(401, 'session_required', 'Sign in to continue.') : authorization.response
  }
  const parsedParams = parseParams(availabilityParamsSchema, await context.params)
  if (!parsedParams.ok) return parsedParams.response
  const parsedBody = await parseBody(availabilityPatchSchema, request)
  if (!parsedBody.ok) return parsedBody.response
  const authorization = await authorize(parsedParams.value.providerId, authentication.callerId)
  if (!authorization.ok) return authorization.response

  try {
    const result = await applyAvailability({
      providerId: parsedParams.value.providerId,
      actorUserId: authorization.callerId,
      ...parsedBody.value,
    })
    return Response.json(result, { status: 200 })
  } catch (error) {
    if (error instanceof AvailabilityValidationError) {
      return errorResponse(422, 'validation_failed', 'The request could not be validated.')
    }
    return errorResponse(503, 'availability_unavailable', 'Availability could not be saved.')
  }
}

import { z } from 'zod'
import { guardPhiAccess } from '../../../../../lib/access/guard'
import { resolveCallerId } from '../../../../../lib/access/identity'
import {
  applyAvailability,
  AvailabilityValidationError,
  getAvailability,
  resolveScheduleActor,
} from '../../../../../lib/scheduling/availability'
import { parseBody, parseParams, uuidSchema } from '../../../../../lib/validation'
import { errorResponse } from '../../../../../lib/validation/envelope'

const ParamsSchema = z.object({ providerId: uuidSchema }).strict()
const WallTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
const PatchSchema = z
  .object({
    slotMinutes: z.number().int().min(5).max(240),
    workingHours: z.array(z.object({
      weekday: z.number().int().min(0).max(6),
      startsLocal: WallTimeSchema,
      endsLocal: WallTimeSchema,
    }).strict()).max(64),
    blocks: z.array(z.object({
      startsAt: z.string().datetime({ offset: true }),
      endsAt: z.string().datetime({ offset: true }),
      reason: z.string().trim().max(500).nullable().optional(),
    }).strict()).max(256),
  })
  .strict()

type RouteContext = { params: Promise<{ providerId: string }> }
const UNKNOWN_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000'

async function authorize(providerId: string): Promise<{ ok: true; callerId: string } | { ok: false; response: Response }> {
  let callerId: string | null
  let actor: Awaited<ReturnType<typeof resolveScheduleActor>>
  try {
    callerId = await resolveCallerId()
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
  const parsedParams = parseParams(ParamsSchema, await context.params)
  if (!parsedParams.ok) return parsedParams.response
  const authorization = await authorize(parsedParams.value.providerId)
  if (!authorization.ok) return authorization.response

  try {
    return Response.json(await getAvailability(parsedParams.value.providerId), { status: 200 })
  } catch {
    return errorResponse(503, 'availability_unavailable', 'Availability is temporarily unavailable.')
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const parsedParams = parseParams(ParamsSchema, await context.params)
  if (!parsedParams.ok) return parsedParams.response
  const parsedBody = await parseBody(PatchSchema, request)
  if (!parsedBody.ok) return parsedBody.response
  const authorization = await authorize(parsedParams.value.providerId)
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

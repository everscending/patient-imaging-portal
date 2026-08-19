import { guardPhiAccess, resolveScheduleActor } from '../../../../lib/access/guard'
import { resolveAuthenticatedSession } from '../../../../lib/access/identity'
import { anonClient } from '../../../../lib/db/client'
import { studyDetail } from '../../../../lib/imaging/studies'
import { parseParams, studyParamsSchema } from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}
export async function GET(_: Request, context: { params: Promise<Record<string, string>> }): Promise<Response> {
  const session = await resolveAuthenticatedSession()
  const parsed = parseParams(studyParamsSchema, await context.params)
  if (!parsed.ok) return parsed.response
  const actor = session ? await resolveScheduleActor(session.userId) : { kind: 'patient' as const, userId: '' }
  const access = await guardPhiAccess(actor, { kind: 'study', id: parsed.value.studyId }, 'study.view')
  if (!access.ok) return denied(access.status)
  if (!session) return denied(401)
  const detail = await studyDetail(anonClient(session.accessToken), parsed.value.studyId)
  return detail ? Response.json(detail) : denied(404)
}

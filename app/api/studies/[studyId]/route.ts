import { authenticatePhiRequest, guardAuthenticatedPhiAccess, type Actor } from '../../../../lib/access/guard'
import { anonClient } from '../../../../lib/db/client'
import { studyDetail } from '../../../../lib/imaging/studies'
import { parseParams, studyParamsSchema } from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

async function resolveActor(accessToken: string, userId: string): Promise<Actor> {
  const client = anonClient(accessToken)
  const [{ data: admin }, { data: provider }] = await Promise.all([
    client.from('staff_admins').select('id').eq('user_id', userId).maybeSingle(),
    client.from('providers').select('id').eq('user_id', userId).maybeSingle(),
  ])
  if (admin) return { kind: 'admin', userId }
  if (provider) return { kind: 'provider', userId }
  return { kind: 'patient', userId }
}

export async function GET(_: Request, context: { params: Promise<Record<string, string>> }): Promise<Response> {
  const authentication = await authenticatePhiRequest()
  const session = authentication.status === 'authenticated' ? authentication.session : null
  const parsed = parseParams(studyParamsSchema, await context.params)
  if (!parsed.ok) return parsed.response
  const actor = session ? await resolveActor(session.accessToken, session.userId) : { kind: 'patient' as const, userId: '' }
  let access
  try {
    access = await guardAuthenticatedPhiAccess(
      actor,
      { kind: 'study', id: parsed.value.studyId },
      'study.view',
      authentication,
    )
  } catch {
    return errorResponse(503, 'imaging_unavailable', 'Imaging is temporarily unavailable.')
  }
  if (!access.ok) return denied(access.status)
  if (!session) return denied(401)
  const detail = await studyDetail(anonClient(session.accessToken), parsed.value.studyId)
  if (!detail) return denied(404)
  const publicDetail = { ...detail }
  delete publicDetail.imageSigningFailed
  return Response.json(publicDetail)
}

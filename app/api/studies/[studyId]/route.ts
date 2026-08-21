import { authenticatePhiRequest, guardAuthenticatedPhiAccess } from '../../../../lib/access/guard'
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
  const authentication = await authenticatePhiRequest()
  const session = authentication.status === 'authenticated' ? authentication.session : null
  const parsed = parseParams(studyParamsSchema, await context.params)
  if (!parsed.ok) return parsed.response
  let access
  try {
    // The guard round classifies the account itself — patient, provider, or
    // admin — so the route never spends a round resolving the role first.
    access = await guardAuthenticatedPhiAccess(
      { kind: 'account', userId: session?.userId ?? '' },
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

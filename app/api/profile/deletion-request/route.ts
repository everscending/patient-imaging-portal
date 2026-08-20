import { resolveAuthenticatedSession } from '../../../../lib/access/identity'
import {
  authorizeDeletionRequest,
  recordInvalidDeletionRequest,
  submitDeletionRequest,
} from '../../../../lib/profile/deletion-requests'
import { deletionRequestSchema, parseBody } from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

export async function POST(request: Request): Promise<Response> {
  const session = await resolveAuthenticatedSession()
  let access: Awaited<ReturnType<typeof authorizeDeletionRequest>>
  try {
    access = await authorizeDeletionRequest(session?.userId ?? '')
  } catch {
    return errorResponse(503, 'deletion_request_unavailable', 'The request could not be recorded. Try again.')
  }
  if (!access.ok) {
    if (access.status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
    if (access.status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
    return errorResponse(404, 'not_found', 'The requested resource was not found.')
  }
  if (!session) return errorResponse(503, 'deletion_request_unavailable', 'The request could not be recorded. Try again.')

  const parsed = await parseBody(deletionRequestSchema, request)
  if (!parsed.ok) {
    try {
      await recordInvalidDeletionRequest(session.accessToken)
    } catch {
      return errorResponse(503, 'deletion_request_unavailable', 'The request could not be recorded. Try again.')
    }
    return parsed.response
  }

  try {
    const result = await submitDeletionRequest(session.accessToken)
    if (!result.ok) {
      return result.error === 'request_already_open'
        ? errorResponse(409, 'request_already_open', 'A deletion request is already open.')
        : errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
    }
    return Response.json({ status: result.status, requestedAt: result.requestedAt }, { status: 202 })
  } catch {
    return errorResponse(503, 'deletion_request_unavailable', 'The request could not be recorded. Try again.')
  }
}

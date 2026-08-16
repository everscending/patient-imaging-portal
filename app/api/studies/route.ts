import { cookies } from 'next/headers'
import { guardPhiAccess } from '../../../lib/access/guard'
import { resolveCallerId } from '../../../lib/access/identity'
import { anonClient } from '../../../lib/db/client'
import { listStudies } from '../../../lib/imaging/studies'
import { SESSION_COOKIE_NAME } from '../../../lib/session-cookie'
import { errorResponse } from '../../../lib/validation/envelope'

function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

export async function GET(): Promise<Response> {
  const callerId = await resolveCallerId()
  const access = await guardPhiAccess({ kind: 'patient', userId: callerId ?? '' }, { kind: 'collection', of: 'study' }, 'study.view')
  if (!access.ok) return denied(access.status)
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (!token) return denied(401)
  return Response.json(await listStudies(anonClient(token)))
}

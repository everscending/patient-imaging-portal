import { cookies } from 'next/headers'

import type { Actor } from '../../../lib/access/guard'
import { resolveCallerId } from '../../../lib/access/identity'
import { listReports } from '../../../lib/reports/reports'
import { SESSION_COOKIE_NAME } from '../../../lib/session-cookie'
import { errorResponse } from '../../../lib/validation/envelope'

function accessError(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested report could not be found.')
}

export async function GET(): Promise<Response> {
  const cookieStore = await cookies()
  const accessToken = cookieStore.get(SESSION_COOKIE_NAME)?.value
  const callerId = await resolveCallerId()
  if (!accessToken || !callerId) return accessError(401)

  const actor: Actor = { kind: 'patient', userId: callerId }
  const result = await listReports(actor, accessToken)
  if (!result.ok) return accessError(result.status)
  return Response.json({ reports: result.value }, { status: 200 })
}

import type { Actor } from '../../../../lib/access/guard'
import { resolveAuthenticatedSession } from '../../../../lib/access/identity'
import { anonClient } from '../../../../lib/db/client'
import { getReport } from '../../../../lib/reports/reports'
import { parseParams, reportParamsSchema } from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

function accessError(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested report could not be found.')
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

export async function GET(_request: Request, context: { params: Promise<{ reportId: string }> }): Promise<Response> {
  const session = await resolveAuthenticatedSession()
  if (!session) return accessError(401)

  const parsed = parseParams(reportParamsSchema, await context.params)
  if (!parsed.ok) return parsed.response

  const actor = await resolveActor(session.accessToken, session.userId)
  const result = await getReport(actor, session.accessToken, parsed.value.reportId)
  if (!result.ok) return accessError(result.status)
  return Response.json(result.value, { status: 200 })
}

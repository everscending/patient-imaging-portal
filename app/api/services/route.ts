import type {} from '../../../lib/access/guard'
import { resolveAuthenticatedSession } from '../../../lib/access/identity'
import { anonClient } from '../../../lib/db/client'
import { parseQuery, servicesQuerySchema } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

function sessionRequired(): Response {
  return errorResponse(401, 'session_required', 'Sign in to continue.')
}

export async function GET(request: Request): Promise<Response> {
  const session = await resolveAuthenticatedSession()
  if (!session) return sessionRequired()
  const parsed = parseQuery(servicesQuerySchema, new URL(request.url))
  if (!parsed.ok) return parsed.response
  const client = anonClient(session.accessToken)

  const { data, error } = await client.from('services').select('id, slug, name').order('name')
  if (error) {
    console.error(JSON.stringify({ op: 'services.list', dependency: 'database', outcome: 'down' }))
    return errorResponse(503, 'services_unavailable', 'Services are temporarily unavailable.')
  }

  return Response.json({ services: (data ?? []).map((service) => ({ id: service.id, slug: service.slug, name: service.name })) })
}

import type {} from '../../../lib/access/guard'
import { resolveAuthenticatedSession } from '../../../lib/access/identity'
import { anonClient } from '../../../lib/db/client'
import { parseQuery, providersQuerySchema } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

function sessionRequired(): Response {
  return errorResponse(401, 'session_required', 'Sign in to continue.')
}

type Provider = { id: string; full_name: string; time_zone: string }
type ProviderJoin = { providers: Provider | Provider[] | null }

export async function GET(request: Request): Promise<Response> {
  const session = await resolveAuthenticatedSession()
  if (!session) return sessionRequired()
  const parsed = parseQuery(providersQuerySchema, new URL(request.url))
  if (!parsed.ok) return parsed.response
  const client = anonClient(session.accessToken)

  const { data, error } = await client
    .from('provider_services')
    .select('providers(id, full_name, time_zone)')
    .eq('service_id', parsed.value.serviceId)
  if (error) return errorResponse(500, 'providers_unavailable', 'Providers are temporarily unavailable.')

  const providers = ((data ?? []) as unknown as ProviderJoin[])
    .flatMap(({ providers }) => providers === null ? [] : Array.isArray(providers) ? providers : [providers])
    .map((provider) => ({ id: provider.id, fullName: provider.full_name, timeZone: provider.time_zone }))
  return Response.json({ providers })
}

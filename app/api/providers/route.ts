import { cookies } from 'next/headers'
import { z } from 'zod'
import type {} from '../../../lib/access/guard'
import { anonClient } from '../../../lib/db/client'
import { SESSION_COOKIE_NAME } from '../../../lib/session-cookie'
import { parseQuery, uuidSchema } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

const ProvidersQuerySchema = z.object({ serviceId: uuidSchema }).strict()

function sessionRequired(): Response {
  return errorResponse(401, 'session_required', 'Sign in to continue.')
}

async function authenticatedClient(): Promise<ReturnType<typeof anonClient> | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (!token) return null
  const client = anonClient(token)
  const { data, error } = await client.auth.getUser(token)
  return error || !data.user ? null : client
}

type Provider = { id: string; full_name: string; time_zone: string }
type ProviderJoin = { providers: Provider | Provider[] | null }

export async function GET(request: Request): Promise<Response> {
  const parsed = parseQuery(ProvidersQuerySchema, request)
  if (!parsed.ok) return parsed.response

  const client = await authenticatedClient()
  if (!client) return sessionRequired()

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

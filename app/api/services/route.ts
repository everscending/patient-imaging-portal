import { cookies } from 'next/headers'
import { z } from 'zod'
import type {} from '../../../lib/access/guard'
import { anonClient } from '../../../lib/db/client'
import { SESSION_COOKIE_NAME } from '../../../lib/session-cookie'
import { parseQuery } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

const ServicesQuerySchema = z.object({}).strict()

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

export async function GET(request: Request): Promise<Response> {
  const parsed = parseQuery(ServicesQuerySchema, request)
  if (!parsed.ok) return parsed.response

  const client = await authenticatedClient()
  if (!client) return sessionRequired()

  const { data, error } = await client.from('services').select('id, slug, name').order('name')
  if (error) return errorResponse(500, 'services_unavailable', 'Services are temporarily unavailable.')

  return Response.json({ services: (data ?? []).map((service) => ({ id: service.id, slug: service.slug, name: service.name })) })
}

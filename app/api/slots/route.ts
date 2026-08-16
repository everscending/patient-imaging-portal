import { cookies } from 'next/headers'
import { z } from 'zod'
import type { Actor } from '../../../lib/access/guard'
import { anonClient } from '../../../lib/db/client'
import { SESSION_COOKIE_NAME } from '../../../lib/session-cookie'
import { parseQuery, uuidSchema } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

const SlotsQuerySchema = z
  .object({
    providerId: uuidSchema,
    serviceId: uuidSchema,
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(({ from, to }) => new Date(to) > new Date(from))

function sessionRequired(): Response {
  return errorResponse(401, 'session_required', 'Sign in to continue.')
}

async function authenticatedClient(): Promise<{ client: ReturnType<typeof anonClient>; actor: Actor } | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (!token) return null
  const client = anonClient(token)
  const { data, error } = await client.auth.getUser(token)
  return error || !data.user ? null : { client, actor: { kind: 'patient', userId: data.user.id } }
}

export async function GET(request: Request): Promise<Response> {
  const parsed = parseQuery(SlotsQuerySchema, request)
  if (!parsed.ok) return parsed.response

  const session = await authenticatedClient()
  if (!session) return sessionRequired()

  const { data: offering, error: offeringError } = await session.client
    .from('provider_services')
    .select('provider_id')
    .eq('provider_id', parsed.value.providerId)
    .eq('service_id', parsed.value.serviceId)
    .maybeSingle()
  if (offeringError) return errorResponse(500, 'slots_unavailable', 'Slots are temporarily unavailable.')
  if (!offering) return errorResponse(422, 'service_not_offered', 'This provider does not offer that service.')

  // The service proves provider eligibility above. Slots themselves remain the
  // provider's one shared grid, and future is decided by this server clock.
  const { data, error } = await session.client
    .from('slots')
    .select('id, starts_at, ends_at')
    .eq('provider_id', parsed.value.providerId)
    .eq('status', 'open')
    .gt('starts_at', new Date().toISOString())
    .gte('starts_at', parsed.value.from)
    .lt('starts_at', parsed.value.to)
    .order('starts_at')
  if (error) return errorResponse(500, 'slots_unavailable', 'Slots are temporarily unavailable.')

  return Response.json({
    slots: (data ?? []).map((slot) => ({ id: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at })),
  })
}

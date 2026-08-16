import { cookies } from 'next/headers'
import { z } from 'zod'

import type { Actor } from '../../../lib/access/guard'
import { resolveCallerId } from '../../../lib/access/identity'
import { anonClient } from '../../../lib/db/client'
import { listShareLinks, mintShareLink } from '../../../lib/share/links'
import { SESSION_COOKIE_NAME } from '../../../lib/session-cookie'
import { parseBody } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

const CreateShareSchema = z.object({
  resourceKind: z.enum(['image', 'report']),
  resourceId: z.string().uuid(),
  recipientEmail: z.string().trim().email().max(320),
}).strict()

void (null as unknown as Actor)

function accessError(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}

async function caller(): Promise<{ userId: string; patientId: string | null } | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  const userId = await resolveCallerId()
  if (!token || !userId) return null
  const { data, error } = await anonClient(token).from('patients').select('id').eq('user_id', userId).maybeSingle()
  if (error) return null
  return { userId, patientId: data ? (data as { id: string }).id : null }
}

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(CreateShareSchema, request)
  if (!parsed.ok) return parsed.response
  const actor = await caller()
  if (!actor) return accessError(401)
  if (!actor.patientId) return accessError(403)
  try {
    const share = await mintShareLink({ patientId: actor.patientId, actorUserId: actor.userId, ...parsed.value })
    return Response.json({ id: share.id, url: share.url, expiresAt: share.expiresAt, recipientEmail: share.recipientEmail }, { status: 201 })
  } catch {
    // A guard denial deliberately looks identical to an absent resource.
    return errorResponse(404, 'not_found', 'The requested resource was not found.')
  }
}

export async function GET(): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  const userId = await resolveCallerId()
  if (!token || !userId) return accessError(401)
  try {
    const result = await listShareLinks({ actorUserId: userId, accessToken: token })
    if (!result.ok) return accessError(result.status)
    return Response.json({ shares: result.shares })
  } catch {
    return errorResponse(503, 'shares_unavailable', 'Share links are temporarily unavailable.')
  }
}

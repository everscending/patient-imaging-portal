import { cookies } from 'next/headers'
import { z } from 'zod'

import type { Actor } from '../../../../lib/access/guard'
import { resolveCallerId } from '../../../../lib/access/identity'
import { anonClient } from '../../../../lib/db/client'
import { revokeShareLink } from '../../../../lib/share/links'
import { SESSION_COOKIE_NAME } from '../../../../lib/session-cookie'
import { parseParams, uuidSchema } from '../../../../lib/validation'
import { errorResponse, noContentResponse } from '../../../../lib/validation/envelope'

const ParamsSchema = z.object({ id: uuidSchema })

void (null as unknown as Actor)

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = parseParams(ParamsSchema, await context.params)
  if (!parsed.ok) return parsed.response
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  const userId = await resolveCallerId()
  if (!token || !userId) return errorResponse(401, 'session_required', 'Sign in to continue.')
  const { data, error } = await anonClient(token).from('patients').select('id').eq('user_id', userId).maybeSingle()
  if (error || !data) return errorResponse(404, 'not_found', 'The requested resource was not found.')
  try {
    const result = await revokeShareLink({ id: parsed.value.id, patientId: (data as { id: string }).id, actorUserId: userId })
    if (!result.ok) return errorResponse(404, 'not_found', 'The requested resource was not found.')
    return noContentResponse()
  } catch {
    return errorResponse(404, 'not_found', 'The requested resource was not found.')
  }
}

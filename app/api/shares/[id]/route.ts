import type { Actor } from '../../../../lib/access/guard'
import { resolveAuthenticatedSession } from '../../../../lib/access/identity'
import { revokeShareLink } from '../../../../lib/share/links'
import { parseParams, shareParamsSchema } from '../../../../lib/validation'
import { errorResponse, noContentResponse } from '../../../../lib/validation/envelope'

void (null as unknown as Actor)

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await resolveAuthenticatedSession()
  if (!session) return errorResponse(401, 'session_required', 'Sign in to continue.')
  const parsed = parseParams(shareParamsSchema, await context.params)
  if (!parsed.ok) return parsed.response
  try {
    const result = await revokeShareLink({ id: parsed.value.id, actorUserId: session.userId })
    if (!result.ok) return errorResponse(404, 'not_found', 'The requested resource was not found.')
    return noContentResponse()
  } catch {
    return errorResponse(404, 'not_found', 'The requested resource was not found.')
  }
}

import { z } from 'zod'

import type { Actor } from '../../../../lib/access/guard'
import { resolveShareToken, sharedPayload } from '../../../../lib/share/links'
import { parseParams } from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

const ParamsSchema = z.object({ token: z.string().min(1).max(512) })
const noStoreHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  Expires: '0',
}

const unavailable = (): Response => {
  const response = errorResponse(410, 'share_unavailable', 'This link is no longer available.')
  for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value)
  return response
}

void (null as unknown as Actor)

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const parsed = parseParams(ParamsSchema, await context.params)
  if (!parsed.ok) return unavailable()
  try {
    const resolved = await resolveShareToken(parsed.value.token)
    if (!resolved.ok) return unavailable()
    const payload = await sharedPayload(resolved)
    if (!payload) return unavailable()
    return Response.json(
      { resourceKind: resolved.resourceKind, payload, expiresAt: resolved.expiresAt },
      { headers: noStoreHeaders },
    )
  } catch {
    return unavailable()
  }
}

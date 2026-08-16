import { cookies } from 'next/headers'
import { z } from 'zod'
import { guardPhiAccess } from '../../../../../../lib/access/guard'
import { resolveCallerId } from '../../../../../../lib/access/identity'
import { anonClient } from '../../../../../../lib/db/client'
import { clipManifest } from '../../../../../../lib/imaging/studies'
import { SESSION_COOKIE_NAME } from '../../../../../../lib/session-cookie'
import { parseParams, uuidSchema } from '../../../../../../lib/validation'
import { errorResponse } from '../../../../../../lib/validation/envelope'

const Params = z.object({ studyId: uuidSchema, clipId: uuidSchema }).strict()
function denied(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  if (status === 403) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
  return errorResponse(404, 'not_found', 'The requested resource was not found.')
}
export async function GET(_: Request, context: { params: Promise<Record<string, string>> }): Promise<Response> {
  const parsed = parseParams(Params, await context.params)
  if (!parsed.ok) return parsed.response
  const callerId = await resolveCallerId()
  const access = await guardPhiAccess({ kind: 'patient', userId: callerId ?? '' }, { kind: 'clip', id: parsed.value.clipId }, 'clip.view')
  if (!access.ok) return denied(access.status)
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (!token) return denied(401)
  const manifest = await clipManifest(anonClient(token), parsed.value.studyId, parsed.value.clipId)
  return manifest ? Response.json(manifest) : denied(404)
}

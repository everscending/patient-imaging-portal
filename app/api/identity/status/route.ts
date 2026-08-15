// app/api/identity/status/route.ts — whether FR-2 has already linked the
// caller's account. Never expires and never flips back (ADR-0011).
import { getIdentityStatus, resolveCallerId } from '../../../../lib/access/identity'
import { errorResponse } from '../../../../lib/validation/envelope'

export async function GET(): Promise<Response> {
  const callerId = await resolveCallerId()
  if (!callerId) return errorResponse(401, 'session_required', 'Sign in to continue.')

  const result = await getIdentityStatus(callerId)
  return Response.json(result, { status: 200 })
}

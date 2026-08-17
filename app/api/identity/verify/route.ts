// app/api/identity/verify/route.ts — FR-2's second factor. Not on
// middleware.ts's matcher (that gates the six §7 "verified patient" routes,
// not the verification endpoint itself), so the session check happens here,
// before any identity_attempts row can be written.
import { computeSourceRef, resolveCallerId, verifyIdentity } from '../../../../lib/access/identity'
import { errorResponse } from '../../../../lib/validation/envelope'
import { identityVerifyRequestSchema, parseBody } from '../../../../lib/validation'

export async function POST(request: Request): Promise<Response> {
  const callerId = await resolveCallerId()
  if (!callerId) return errorResponse(401, 'session_required', 'Sign in to continue.')
  const parsed = await parseBody(identityVerifyRequestSchema, request)
  if (!parsed.ok) return parsed.response

  const { patientRef, dateOfBirth } = parsed.value
  const sourceRef = computeSourceRef(request)
  const result = await verifyIdentity({ callerId, patientRef, dateOfBirth, sourceRef })

  // One response for a wrong reference, a wrong date of birth, and an
  // active lockout (§6, ADR-0004, ADR-0008) — no field-level detail, no hint
  // that a lock is in effect.
  if (!result.ok) {
    return errorResponse(400, 'identity_mismatch', 'The reference and date of birth did not match.')
  }

  return Response.json({ patientRef: result.patientRef, linkedAt: result.linkedAt }, { status: 200 })
}

// app/api/identity/verify/route.ts — FR-2's second factor. Not on
// middleware.ts's matcher (that gates the six §7 "verified patient" routes,
// not the verification endpoint itself), so the session check happens here,
// before any identity_attempts row can be written.
import { z } from 'zod'
import { computeSourceRef, resolveCallerId, verifyIdentity } from '../../../../lib/access/identity'
import { errorResponse } from '../../../../lib/validation/envelope'
import { parseBody } from '../../../../lib/validation'

// .strict() rejects an extra patientId or userId field outright. The date
// pattern is exact-length (YYYY-MM-DD): "1988-3-14", "14/03/1988", an empty
// string and an oversized string all fail the same regex, ahead of any
// database contact.
const VerifyRequestSchema = z
  .object({
    patientRef: z.string().trim().min(1).max(64),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(VerifyRequestSchema, request)
  if (!parsed.ok) return parsed.response

  const callerId = await resolveCallerId()
  if (!callerId) return errorResponse(401, 'session_required', 'Sign in to continue.')

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

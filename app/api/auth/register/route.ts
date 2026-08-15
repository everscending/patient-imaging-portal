// app/api/auth/register/route.ts — the browser never calls Supabase Auth
// directly (ADR-0012 #15); this is the one server hop between the register
// form and the provider. lib/validation runs first, always (EC-12).
import { z } from 'zod'
import { authClient } from '../../../../lib/db/client'
import { errorResponse } from '../../../../lib/validation/envelope'
import { parseBody } from '../../../../lib/validation'

// 254 is RFC 5321's practical email length ceiling — well under it for any
// real address, and small enough that a 10 KB email is 422 here rather than
// reaching the provider. .strict() rejects an extra patientRef, patientId or
// role field outright (§4: registration links no patient record, ever).
const RegisterRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(8).max(128),
  })
  .strict()

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(RegisterRequestSchema, request)
  if (!parsed.ok) return parsed.response

  const { email, password } = parsed.value
  const { data, error } = await authClient().auth.signUp({ email, password })

  // Supabase's own anti-enumeration shape: signing up with an email that's
  // already registered returns the existing user with no session and no
  // identities, not an error. Mapped to the pinned 409 here.
  if (!error && data.user && !data.session && data.user.identities?.length === 0) {
    return errorResponse(409, 'email_in_use', 'An account with that email already exists.')
  }

  if (error || !data.user) {
    return errorResponse(422, 'validation_failed', 'The request could not be validated.')
  }

  // ADR-0011: registration creates an account and nothing more. Nothing here
  // touches patients.user_id — only a successful FR-2 verification does.
  return Response.json({ userId: data.user.id }, { status: 201 })
}

// The only route the register form posts to (ADR-0012 #15, UX_SPEC §4.1).
// The browser never calls Supabase Auth directly: this handler validates
// through lib/validation first, then delegates hashing and account creation
// to Supabase Auth (ADR-0004, SEC-7). It writes no patients row and no
// patients.user_id — registration creates an account and nothing more (§4).
import { z } from 'zod'
import { authClient } from '../../../../lib/db/client'
import { errorResponse } from '../../../../lib/validation/envelope'
import { parseBody } from '../../../../lib/validation'

// RFC 5321's 254-octet mailbox ceiling — rejects a 10 KB email outright
// rather than relying on the email-format regex alone. bcrypt (Supabase
// Auth's own hasher, ADR-0004) truncates past 72 bytes, so a longer password
// is capped here instead of silently losing entropy server-side.
const registerSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(72),
  })
  .strict()

function isAlreadyRegistered(error: { code?: string; status?: number; message: string }): boolean {
  if (error.code === 'user_already_exists') return true
  return /already registered|already exists/i.test(error.message)
}

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(registerSchema, request)
  if (!parsed.ok) return parsed.response

  const { email, password } = parsed.value
  const { data, error } = await authClient().auth.signUp({ email, password })

  if (error) {
    if (isAlreadyRegistered(error)) {
      return errorResponse(409, 'email_in_use', 'An account with that email already exists.')
    }
    return errorResponse(422, 'validation_failed', 'The request could not be validated.')
  }

  // Confirmations disabled (project setting, ADR-0012 #9's demo project):
  // a duplicate signUp still surfaces as an empty `identities` array with no
  // error, rather than an AuthApiError, on some Supabase configurations.
  if (!data.user || data.user.identities?.length === 0) {
    return errorResponse(409, 'email_in_use', 'An account with that email already exists.')
  }

  return Response.json({ userId: data.user.id }, { status: 201 })
}

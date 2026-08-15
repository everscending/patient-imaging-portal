// The only route the sign-in form posts to (ADR-0012 #15, UX_SPEC §4.1).
// Validates through lib/validation first, then delegates to Supabase Auth,
// which owns hashing and session issue (ADR-0004, SEC-7). A wrong email and
// a wrong password return the identical response — GoTrue itself does not
// distinguish them, so no branch here can either (§6).
import { z } from 'zod'
import { authClient } from '../../../../lib/db/client'
import { errorResponse } from '../../../../lib/validation/envelope'
import { parseBody } from '../../../../lib/validation'
import { SESSION_COOKIE_NAME } from '../../../../lib/session-cookie'

const loginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(72),
  })
  .strict()

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(loginSchema, request)
  if (!parsed.ok) return parsed.response

  const { email, password } = parsed.value
  const { data, error } = await authClient().auth.signInWithPassword({ email, password })

  // One identical response for a wrong email and a wrong password (§6) —
  // every failure path from signInWithPassword lands here, with no
  // field-level branch that could leak which one was wrong.
  if (error || !data.session || !data.user) {
    return errorResponse(401, 'invalid_credentials', 'That email or password is not correct.')
  }

  const expiresAt = new Date(data.session.expires_at! * 1000).toISOString()
  const maxAgeSeconds = Math.max(1, Math.floor(data.session.expires_at! - Date.now() / 1000))
  const isHttps = new URL(request.url).protocol === 'https:'

  const response = Response.json({ userId: data.user.id, expiresAt }, { status: 200 })
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${data.session.access_token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (isHttps) cookieParts.push('Secure')
  response.headers.set('Set-Cookie', cookieParts.join('; '))
  return response
}

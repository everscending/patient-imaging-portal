// app/api/auth/login/route.ts — the browser never calls Supabase Auth
// directly (ADR-0012 #15). lib/validation runs first, always (EC-12).
import { NextResponse } from 'next/server'
import { authClient } from '../../../../lib/db/client'
import { setSessionCookie } from '../../../../lib/session-cookie'
import { errorResponse } from '../../../../lib/validation/envelope'
import { loginRequestSchema, parseBody } from '../../../../lib/validation'

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(loginRequestSchema, request)
  if (!parsed.ok) return parsed.response

  const { email, password } = parsed.value
  const { data, error } = await authClient().auth.signInWithPassword({ email, password })

  // A wrong email and a wrong password return one identical response (§6) —
  // distinguishing them would confirm which email addresses have accounts.
  if (error || !data.session || !data.user) {
    return errorResponse(401, 'invalid_credentials', 'Invalid email or password.')
  }

  const expiresAtSeconds = data.session.expires_at ?? Math.floor(Date.now() / 1000) + data.session.expires_in
  const response = NextResponse.json(
    { userId: data.user.id, expiresAt: new Date(expiresAtSeconds * 1000).toISOString() },
    { status: 200 },
  )
  setSessionCookie(response, data.session.access_token)
  return response
}

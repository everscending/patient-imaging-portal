// app/api/auth/login/route.ts — the browser never calls Supabase Auth
// directly (ADR-0012 #15). lib/validation runs first, always (EC-12).
import { NextResponse } from 'next/server'
import { anonClient, authClient } from '../../../../lib/db/client'
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
    {
      userId: data.user.id,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      role: await resolveRole(data.session.access_token, data.user.id),
    },
    { status: 200 },
  )
  setSessionCookie(response, data.session.access_token)
  return response
}

// Same precedence as the scheduling guard: a dual-role clinician acts as
// provider/admin. An account with no role row yet (registered, not linked)
// is a patient-to-be.
async function resolveRole(accessToken: string, userId: string): Promise<'patient' | 'provider' | 'admin'> {
  const client = anonClient(accessToken)
  const [provider, admin] = await Promise.all([
    client.from('providers').select('id').eq('user_id', userId).maybeSingle(),
    client.from('staff_admins').select('id').eq('user_id', userId).maybeSingle(),
  ])
  if (!provider.error && provider.data) return 'provider'
  if (!admin.error && admin.data) return 'admin'
  return 'patient'
}

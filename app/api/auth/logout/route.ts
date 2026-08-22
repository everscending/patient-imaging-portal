// app/api/auth/logout/route.ts — logout clears the session cookie AND revokes
// the token server-side (AUDIT.md #6). Clearing the cookie alone left a captured
// copy of the access token usable until its natural ~60-minute expiry; revoking
// it at GoTrue kills it now. Revocation is best-effort — a failure must not block
// logout, and the cookie clear below still ends this browser's session.
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { config } from '../../../../lib/config'
import { SESSION_COOKIE_NAME, clearSessionCookie } from '../../../../lib/session-cookie'

export async function POST(): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (token) {
    try {
      await fetch(`${config.supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
    } catch {
      // token still expires on its own; the cookie clear below ends this session
    }
  }
  const response = NextResponse.json({ ok: true }, { status: 200 })
  clearSessionCookie(response)
  return response
}

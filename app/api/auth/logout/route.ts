// app/api/auth/logout/route.ts — logout is cookie expiry: the cookie is the
// only thing binding this browser to the Supabase session, and middleware
// revalidates the token on every request, so a cleared cookie ends access
// immediately. No Supabase call needed (the token itself expires on its own
// short TTL).
import { NextResponse } from 'next/server'
import { clearSessionCookie } from '../../../../lib/session-cookie'

export async function POST(): Promise<Response> {
  const response = NextResponse.json({ ok: true }, { status: 200 })
  clearSessionCookie(response)
  return response
}

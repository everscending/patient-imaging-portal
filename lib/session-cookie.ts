// lib/session-cookie.ts — the one place that names the session cookie
// (JOR-229). The login route and middleware's session check both need the
// exact same name and options; a mismatch here is a whole-app outage, not a
// per-route bug.
import type { NextRequest, NextResponse } from 'next/server'
import { config } from './config'

export const SESSION_COOKIE_NAME = 'pip_session'

// Supabase Auth issues and expires the token (ADR-0004, ADR-0012 #6); this
// cookie only carries it. No TTL is read or written here — the cookie
// outlives the token, and a request carrying an expired token is rejected
// by middleware's getUser() revalidation, never by a locally-computed expiry.
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  // Derived from config.appBaseUrl rather than read from the raw
  // environment — lib/config.ts is the only reader of it (ARCHITECTURE.md
  // §2, §8).
  secure: config.appBaseUrl.startsWith('https://'),
  path: '/',
}

/** Issues the session cookie carrying the caller's Supabase access token. */
export function setSessionCookie(response: NextResponse, accessToken: string): void {
  response.cookies.set(SESSION_COOKIE_NAME, accessToken, COOKIE_OPTIONS)
}

/** Reads the access token a request presents, or null if it presents none. */
export function getSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null
}

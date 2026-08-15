// middleware.ts — session check for every patient route, and the
// /verify?next= redirect for the six §7 "verified patient" routes (JOR-229).
// A convenience only: the real authorization is lib/access/guard.ts on every
// PHI route (a later ticket). Ownership failure there is 404, never 403 —
// this file never returns 404, only 401/403/a redirect.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { authClient } from './lib/db/client'
import { getSessionToken } from './lib/session-cookie'
import { errorResponse } from './lib/validation/envelope'

// §7's URL map: exactly these three stems (each covering its nested pages —
// /studies/[studyId], /studies/[studyId]/clips/[clipId], /reports/[reportId])
// need the account linked to a patient record. /profile, /appointments and
// /book need a session only.
const VERIFIED_PATIENT_STEMS = new Set(['studies', 'reports', 'shares'])
const SESSION_ONLY_STEMS = new Set(['profile', 'appointments', 'book'])

function classifyPath(pathname: string): { apiRoute: boolean; stem: string } {
  const apiRoute = pathname.startsWith('/api/')
  const withoutApiPrefix = apiRoute ? pathname.slice('/api'.length) : pathname
  const stem = withoutApiPrefix.split('/').filter(Boolean)[0] ?? ''
  return { apiRoute, stem }
}

const FALLBACK_NEXT_PATH = '/studies'

// Open-redirect guard for the value middleware itself puts in ?next= (always
// a same-origin pathname it just read off the request, but sanitized anyway
// rather than trusted implicitly): rejects an absolute URL, a
// protocol-relative //host path, and a javascript: URI, falling back to
// FALLBACK_NEXT_PATH.
function sanitizeNextPath(raw: string): string {
  if (!raw) return FALLBACK_NEXT_PATH
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return FALLBACK_NEXT_PATH
  }
  if (!decoded.startsWith('/')) return FALLBACK_NEXT_PATH
  if (decoded.startsWith('//')) return FALLBACK_NEXT_PATH
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return FALLBACK_NEXT_PATH
  return decoded
}

// The account-link seam for a future FR-2 ticket: a successful identity
// verification is expected to set this on the Supabase user via the service
// role admin API. Nothing in this repo sets it yet, so every session reads
// as unlinked — the correct behaviour until that ticket lands (ADR-0011).
function isLinkedToPatient(user: { app_metadata?: Record<string, unknown> }): boolean {
  return Boolean(user.app_metadata?.patient_id)
}

export async function middleware(request: NextRequest): Promise<Response> {
  const { pathname } = request.nextUrl
  const { apiRoute, stem } = classifyPath(pathname)

  const requiresVerified = VERIFIED_PATIENT_STEMS.has(stem)
  const requiresSession = requiresVerified || SESSION_ONLY_STEMS.has(stem)
  if (!requiresSession) return NextResponse.next()

  const token = getSessionToken(request)
  const { data, error } = token
    ? await authClient().auth.getUser(token)
    : { data: { user: null }, error: null }

  if (error || !data.user) {
    if (apiRoute) return errorResponse(401, 'session_required', 'Sign in to continue.')
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (requiresVerified && !isLinkedToPatient(data.user)) {
    if (apiRoute) {
      return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')
    }
    const verifyUrl = new URL('/verify', request.url)
    verifyUrl.searchParams.set('next', sanitizeNextPath(pathname))
    return NextResponse.redirect(verifyUrl)
  }

  return NextResponse.next()
}

// lib/db/client.ts pulls in lib/config.ts, which reads .env.test off disk
// (JOR-270) — a Node built-in the default Edge middleware runtime cannot
// bundle. The session check calls the same Supabase auth client every route
// handler uses, so Node, not Edge, is the correct runtime here.
export const runtime = 'nodejs'

export const config = {
  matcher: [
    '/studies',
    '/studies/:path*',
    '/reports',
    '/reports/:path*',
    '/shares',
    '/shares/:path*',
    '/profile',
    '/profile/:path*',
    '/appointments',
    '/appointments/:path*',
    '/book',
    '/book/:path*',
    '/api/studies',
    '/api/studies/:path*',
    '/api/reports',
    '/api/reports/:path*',
    '/api/shares',
    '/api/shares/:path*',
    '/api/profile',
    '/api/profile/:path*',
    '/api/appointments',
    '/api/appointments/:path*',
    '/api/book',
    '/api/book/:path*',
  ],
}

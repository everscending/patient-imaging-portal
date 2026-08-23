// middleware.ts — session check for every patient page, and the
// /verify?next= redirect for the six §7 "verified patient" page routes.
// API authorization stays in lib/access/guard.ts so its decision and audit
// write remain paired. Ownership failure there is 404, never 403.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { anonClient, authClient } from './lib/db/client'
import { getSessionToken } from './lib/session-cookie'

// §7's URL map: every patient stem (each covering its nested pages —
// /studies/[studyId], /studies/[studyId]/clips/[clipId], /reports/[reportId])
// needs the account linked to a patient record. Verification is the first
// stop after login: an unverified session is redirected to /verify from any
// of these, so /verify itself is the only patient page a session can use
// before linking.
const VERIFIED_PATIENT_STEMS = new Set(['studies', 'reports', 'shares', 'profile', 'appointments', 'book'])

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
  // Browsers and the WHATWG URL parser treat '\' as '/', so '/\evil.com'
  // resolves off-origin despite passing the startsWith('/') check (AUDIT.md #5).
  if (decoded.includes('\\')) return FALLBACK_NEXT_PATH
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return FALLBACK_NEXT_PATH
  return decoded
}

// ADR-0011 makes patients.user_id the complete, permanent result of identity
// verification. Middleware reads that link through the caller-scoped client;
// auth metadata is deliberately not a second source of truth.
async function isLinkedToPatient(accessToken: string, userId: string): Promise<boolean> {
  const { data, error } = await anonClient(accessToken).from('patients').select('id').eq('user_id', userId).maybeSingle()
  return !error && data !== null
}

export async function middleware(request: NextRequest): Promise<Response> {
  const { pathname } = request.nextUrl
  const { apiRoute, stem } = classifyPath(pathname)

  // API routes own their guard and its paired audit write. Letting middleware
  // answer first would turn a 401/403 into an unaudited access decision.
  if (apiRoute) return NextResponse.next()

  const requiresVerified = VERIFIED_PATIENT_STEMS.has(stem)
  if (!requiresVerified) return NextResponse.next()

  const token = getSessionToken(request)
  // A missing cookie is an unauthenticated request, not a navigation flow.
  // Return no body so a direct protected-page request cannot disclose a
  // rendered patient shell or PHI. A present but invalid/expired cookie still
  // takes the established login redirect below.
  if (!token) return new NextResponse(null, { status: 401 })
  const { data, error } = await authClient().auth.getUser(token)

  if (error || !data.user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (!(await isLinkedToPatient(token, data.user.id))) {
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

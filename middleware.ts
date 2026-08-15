// Session check and the /verify?next= redirect for locked routes
// (ARCHITECTURE.md §5, §7). A convenience only, never the authorization: the
// real PHI guard (lib/access/guard.ts, a later ticket) still runs on every
// PHI route and its ownership failure is 404, never 403 (ADR-0011). Page
// routes redirect; API routes return the guard's status codes and are never
// redirected (§5's status table is the API contract).
//
// The pinned `patients` schema (ARCHITECTURE.md §3) has no migration in this
// worktree yet — no ticket has created db/migrations/ — so there is no
// `patients.user_id` to read here. Until that lands, "linked" is tracked on
// the Supabase Auth user itself, as `app_metadata.patientRef`: FR-2's future
// /verify implementation is expected to set it the same way this ticket's
// tests do, through the Auth admin API.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { authClient } from './lib/db/client'
import { errorResponse } from './lib/validation/envelope'
import { SESSION_COOKIE_NAME, sanitizeNextPath } from './lib/session-cookie'

export { SESSION_COOKIE_NAME, sanitizeNextPath }

const PUBLIC_PAGE_PATHS = new Set(['/', '/login', '/register', '/verify'])
const PUBLIC_PAGE_PREFIXES = ['/s/']

const SESSION_ONLY_PAGE_PATHS = new Set(['/profile', '/appointments', '/book'])
const VERIFIED_PAGE_PREFIXES = ['/studies', '/reports', '/shares']

// No trailing slash — matchesPrefix already treats each entry as exact-or-
// followed-by-/ (a bare '/api/auth/' here would need pathname to start with
// '/api/auth//' and never match).
const PUBLIC_API_PREFIXES = ['/api/auth', '/api/health', '/api/jobs', '/api/s']
const VERIFIED_API_PREFIXES = ['/api/studies', '/api/reports', '/api/shares']

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

type SessionState = { authenticated: false } | { authenticated: true; linked: boolean }

async function readSession(request: NextRequest): Promise<SessionState> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!token) return { authenticated: false }

  try {
    const { data, error } = await authClient().auth.getUser(token)
    if (error || !data.user) return { authenticated: false }
    const linked = typeof data.user.app_metadata?.patientRef === 'string'
    return { authenticated: true, linked }
  } catch {
    return { authenticated: false }
  }
}

function jsonUnauthorized(): Response {
  return errorResponse(401, 'unauthorized', 'A valid session is required.')
}

function jsonVerificationRequired(): Response {
  return errorResponse(403, 'identity_verification_required', 'Identity verification is required.')
}

function redirectToLogin(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL('/login', request.url))
}

function redirectToVerify(request: NextRequest): NextResponse {
  const next = sanitizeNextPath(request.nextUrl.pathname + request.nextUrl.search)
  const url = new URL('/verify', request.url)
  url.searchParams.set('next', next)
  return NextResponse.redirect(url)
}

export async function middleware(request: NextRequest): Promise<Response> {
  const { pathname } = request.nextUrl

  if (pathname.startsWith('/api/')) {
    if (matchesPrefix(pathname, PUBLIC_API_PREFIXES)) return NextResponse.next()

    const session = await readSession(request)
    if (!session.authenticated) return jsonUnauthorized()

    if (matchesPrefix(pathname, VERIFIED_API_PREFIXES) && !session.linked) {
      return jsonVerificationRequired()
    }
    return NextResponse.next()
  }

  if (PUBLIC_PAGE_PATHS.has(pathname) || PUBLIC_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next()
  }

  const isSessionOnlyPage = SESSION_ONLY_PAGE_PATHS.has(pathname)
  const isVerifiedPage = matchesPrefix(pathname, VERIFIED_PAGE_PREFIXES)
  if (!isSessionOnlyPage && !isVerifiedPage) return NextResponse.next()

  const session = await readSession(request)
  if (!session.authenticated) return redirectToLogin(request)

  if (isVerifiedPage && !session.linked) return redirectToVerify(request)

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs',
}

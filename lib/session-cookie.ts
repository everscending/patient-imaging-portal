// The session cookie name and the ?next= sanitizer, split out of
// middleware.ts so they can be imported (by the login route, the patient
// layout, and e2e/auth.spec.ts) without pulling in lib/db/client.ts's
// 'server-only' guard — that guard throws unconditionally outside Next's own
// bundler (e.g. under Playwright's or Vitest's plain-Node module loader),
// and these two exports have nothing to do with the Supabase credentials
// that guard protects.
export const SESSION_COOKIE_NAME = 'pip_session'

// The fallback a sanitized-but-rejected `next` value resolves to (mandatory
// adversarial tests: an absolute URL, a protocol-relative path, or a
// javascript: URI is never honored).
const SAFE_NEXT_FALLBACK = '/studies'

/**
 * Accepts only an in-app, same-origin path. Anything else — an absolute
 * URL, a protocol-relative `//host` path, a `javascript:` URI, or a missing
 * value — resolves to SAFE_NEXT_FALLBACK.
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  if (!raw) return SAFE_NEXT_FALLBACK
  if (!raw.startsWith('/')) return SAFE_NEXT_FALLBACK
  if (raw.startsWith('//')) return SAFE_NEXT_FALLBACK
  if (raw.startsWith('/\\')) return SAFE_NEXT_FALLBACK
  // A scheme can sneak in after a leading slash on some parsers
  // (e.g. "/\tjavascript:..."); reject anything shaped like one.
  if (/^\/[^/]*[a-z][a-z0-9+.-]*:/i.test(raw)) return SAFE_NEXT_FALLBACK
  return raw
}

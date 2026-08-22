// lib/access/login-throttle.ts — brute-force protection for the password login
// (AUDIT.md #2). Mirrors the identity-verification lockout (lib/access/identity.ts):
// count recent FAILED attempts per email and per source within a window, and lock
// when either crosses the threshold. Written and read only by the login route as
// the service role — login_attempts (db/migrations/016) is service-role-only.
//
// The login route relays every attempt through the app server, so Supabase's own
// per-IP limiter sees one address for all users; this restores per-caller limits.
import 'server-only'

import { createHash } from 'node:crypto'

import { config } from '../config'
import { serviceClient } from '../db/client'
// The pinned source-ref definition (ADR-0012 #20): sha256(salt + first
// x-forwarded-for entry), no raw address stored. Reused so login and identity
// hash a caller's source identically.
export { computeSourceRef } from './identity'

type ServiceClient = ReturnType<typeof serviceClient>

/** sha256(salt + normalized email). No raw address is stored (SEC-6). */
export function emailHash(email: string): string {
  return createHash('sha256').update(config.sourceRefSalt + email.trim().toLowerCase()).digest('hex')
}

async function countRecentFailures(
  client: ServiceClient,
  column: 'email_hash' | 'source_ref',
  value: string,
  windowStart: string,
): Promise<number> {
  const { count, error } = await client
    .from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
    .eq('succeeded', false)
    .gte('attempted_at', windowStart)
  if (error) throw new Error(`login-throttle: failed to read login_attempts: ${error.message}`)
  return count ?? 0
}

/** True when this email OR this source has too many recent failures — either
 *  alone locks (ADR-0008's per-reference-and-per-source shape).
 *
 *  Fails OPEN: if the attempt store is unreachable this returns false rather
 *  than throwing. A brute-force rate limiter must not take login down when its
 *  bookkeeping table is unavailable — the password check remains authoritative. */
export async function isLoginLocked(client: ServiceClient, hashedEmail: string, sourceRef: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - config.loginLockoutMinutes * 60_000).toISOString()
  try {
    const [byEmail, bySource] = await Promise.all([
      countRecentFailures(client, 'email_hash', hashedEmail, windowStart),
      countRecentFailures(client, 'source_ref', sourceRef, windowStart),
    ])
    return byEmail >= config.loginMaxAttempts || bySource >= config.loginMaxAttempts
  } catch {
    // No PHI/credentials in the log line (SEC-6).
    console.error(JSON.stringify({ event: 'login_throttle.read_failed', category: 'login_throttle_unavailable' }))
    return false
  }
}

export async function recordLoginAttempt(
  client: ServiceClient,
  fields: { hashedEmail: string; sourceRef: string; succeeded: boolean },
): Promise<void> {
  const { error } = await client.from('login_attempts').insert({
    email_hash: fields.hashedEmail,
    source_ref: fields.sourceRef,
    succeeded: fields.succeeded,
  })
  if (error) throw new Error(`login-throttle: failed to record login_attempts row: ${error.message}`)
}

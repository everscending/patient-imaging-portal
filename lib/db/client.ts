// lib/db/client.ts — the ONLY module importing @supabase/supabase-js
import type { SupabaseClient } from '@supabase/supabase-js'

// Throws when this module is reached from a Client Component bundle
// (ARCHITECTURE.md §8) — evaluated before the config import below so the
// guard fires even when the caller never gets far enough to need a token.
import 'server-only'

import { createClient } from '@supabase/supabase-js'

import { config } from '../config'

/** The caller's own session — RLS policies (§4) evaluate. Default for PHI reads. */
export function anonClient(accessToken: string): SupabaseClient {
  // A missing token would build a client that reads as an unauthenticated
  // session — §4 answers that with zero rows, which looks like "no data"
  // rather than "a bug". Reject outright instead.
  if (!accessToken) {
    throw new Error('anonClient: accessToken is required')
  }
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

/** Service role. Legal in FR-2 identity verification, share-token resolution,
 *  the reminder job, the audit writer's single-row unauthenticated fallback,
 *  the login brute-force throttle (app/api/auth/login), and outbound-email
 *  enqueue (lib/notify/email.ts) — the last two write tables that migration 016
 *  locks to the service role (login_attempts, email_outbox). Nowhere else. */
export function serviceClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
}

/** Unauthenticated client for Supabase Auth flows only — register and login
 *  (JOR-229, ADR-0012 #15). No session exists yet to attach as a bearer
 *  token, and none of these calls touch a table RLS would gate, so neither
 *  anonClient nor serviceClient fits. Legal nowhere but the two auth routes
 *  and the middleware session check. */
export function authClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey)
}

/** Updates the caller's own Auth metadata with the caller's bearer token.
 *
 * Supabase JS's auth.updateUser() requires a locally persisted full session,
 * including the refresh token. The app deliberately stores only the access
 * token in its HTTP-only session cookie, so the server uses the equivalent
 * GoTrue wire call directly. This stays account-scoped: the service role is
 * not involved and Auth derives the target account from the bearer token.
 */
export async function updateOwnAccountMetadata(
  accessToken: string,
  metadata: { full_name: string; phone: string | null },
): Promise<boolean> {
  if (!accessToken) throw new Error('updateOwnAccountMetadata: accessToken is required')

  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: metadata }),
    cache: 'no-store',
  })
  return response.ok
}

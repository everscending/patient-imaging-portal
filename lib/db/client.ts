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

/** Service role. Legal in exactly three places: FR-2 identity verification,
 *  share-token resolution, and the reminder job. Nowhere else. */
export function serviceClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
}

/** Anon key, no bearer token — the two auth routes' only legal caller of
 *  Supabase Auth (ADR-0012 #15): register (signUp) and log in
 *  (signInWithPassword) happen before a session exists, so anonClient's
 *  required accessToken does not apply, and serviceClient stays reserved for
 *  its three PHI-adjacent call sites above. */
export function authClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey)
}

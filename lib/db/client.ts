// lib/db/client.ts — the ONLY module importing @supabase/supabase-js
import type { SupabaseClient } from '@supabase/supabase-js'

// Throws when this module is reached from a Client Component bundle
// (ARCHITECTURE.md §8) — evaluated before the config import below so the
// guard fires even when the caller never gets far enough to need a token.
import 'server-only'

import { createClient } from '@supabase/supabase-js'

import { config } from '../config'

// None of these clients are handed a browser to live in — every call is one
// request-scoped read, and the caller's own session cookie is the source of
// truth for the next request too. Without this, GoTrueClient starts a
// background refresh-token setInterval on construction (auth-js's
// _handleVisibilityChange: "in non-browser environments the refresh token
// ticker runs always"), which outlives the request in a long-running server
// and, in tests/db/client.test.ts's real (unmocked) clients, keeps the
// process alive past test completion.
const SERVER_AUTH_OPTIONS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }

/** The caller's own session — RLS policies (§4) evaluate. Default for PHI reads. */
export function anonClient(accessToken: string): SupabaseClient {
  // A missing token would build a client that reads as an unauthenticated
  // session — §4 answers that with zero rows, which looks like "no data"
  // rather than "a bug". Reject outright instead.
  if (!accessToken) {
    throw new Error('anonClient: accessToken is required')
  }
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    ...SERVER_AUTH_OPTIONS,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

/** Service role. Legal in exactly three places: FR-2 identity verification,
 *  share-token resolution, and the reminder job. Nowhere else. */
export function serviceClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, SERVER_AUTH_OPTIONS)
}

/** Unauthenticated client for Supabase Auth flows only — register and login
 *  (JOR-229, ADR-0012 #15). No session exists yet to attach as a bearer
 *  token, and none of these calls touch a table RLS would gate, so neither
 *  anonClient nor serviceClient fits. Legal nowhere but the two auth routes
 *  and the middleware session check. */
export function authClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, SERVER_AUTH_OPTIONS)
}

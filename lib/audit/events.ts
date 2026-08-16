// lib/audit/events.ts — the ONLY writer to audit_events (ARCHITECTURE.md §2, §3).
import 'server-only'

import { cookies } from 'next/headers'

import { anonClient, authClient, serviceClient } from '../db/client'
import { SESSION_COOKIE_NAME } from '../session-cookie'

// §3's CHECK constraint carries the same 22 strings, verbatim
// (tests/db/migration-002.test.ts proves the migration and this type agree).
export type AuditAction =
  | 'identity.verify'
  | 'identity.lockout'
  | 'identity.link'
  | 'study.view'
  | 'image.view'
  | 'clip.view'
  | 'report.view'
  | 'share.create'
  | 'share.use'
  | 'share.revoke'
  | 'share.view'
  | 'booking.create'
  | 'booking.reschedule'
  | 'booking.cancel'
  | 'appointment.view'
  | 'appointment.transition'
  | 'schedule.view'
  | 'availability.update'
  | 'availability.collision'
  | 'reminder.dispatch'
  | 'audit.view'
  | 'profile.deletion_request'

export type RecordAuditEventInput = {
  actorKind: 'account' | 'share_recipient' | 'system'
  actorRef: string | null
  action: AuditAction
  targetKind: string
  targetId: string | null
  outcome: 'granted' | 'denied'
  detail?: Record<string, string | number | boolean> // never PHI (SEC-6)
}

// The same type anonClient() already returns — reusing it via ReturnType
// keeps this file from having to import a Supabase SDK type directly, which
// only lib/db/client.ts may do (ARCHITECTURE.md §2 row 3).
type WriteClient = ReturnType<typeof anonClient>

type DetailValue = string | number | boolean

// SEC-6/SEC-7: detail is a closed schema, not a denylist. An exact key alone
// is not enough for string fields: restricting transport to its public enum
// also prevents a credential from being hidden under an approved key.
const AUDIT_DETAIL_VALUE_RULES: Record<string, (value: DetailValue) => boolean> = {
  count: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  successful: (value) => typeof value === 'boolean',
  transport: (value) => value === 'log' || value === 'resend',
  leadHours: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
}

function detailIsApproved(detail: RecordAuditEventInput['detail']): boolean {
  if (!detail) return true
  return Object.entries(detail).every(([key, value]) => AUDIT_DETAIL_VALUE_RULES[key]?.(value) === true)
}

// Never PHI (SEC-6): the exact log shape is allowlisted. Adapter errors and
// thrown values can echo rejected inputs, so none of their fields are logged.
function logWriteFailure(action: AuditAction): void {
  console.error(JSON.stringify({ event: 'audit_events.write_failed', action, failureCategory: 'audit_write_failure' }))
}

// The pinned recordAuditEvent signature carries no accessToken parameter, so
// the caller's session is read off the request the same way middleware.ts
// reads it — the session cookie (lib/session-cookie.ts) — except here there
// is no NextRequest in scope, so it comes from next/headers instead.
async function callerAccessToken(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null
}

function serviceRoleAllowed(input: RecordAuditEventInput): boolean {
  return input.actorKind === 'account' && input.outcome === 'denied'
}

async function writeClient(input: RecordAuditEventInput): Promise<WriteClient> {
  // Share recipients are intentionally unauthenticated. Select the elevated
  // single-row writer before looking at any ambient account cookie.
  if (input.actorKind === 'share_recipient') return serviceClient()

  const accessToken = await callerAccessToken()
  if (accessToken) {
    try {
      const { data, error } = await authClient().auth.getUser(accessToken)
      if (!error && data.user) return anonClient(accessToken)
    } catch {
      // A caller could not be established. Only the explicitly eligible
      // denied-account case below may cross to the single-row fallback.
    }
  }
  if (serviceRoleAllowed(input)) return serviceClient()
  throw new Error('recordAuditEvent: no authenticated caller available for this audit event')
}

/**
 * Appends one row to audit_events. Resolves void either way: a failed
 * append is logged (SEC-6: no PHI) and never rethrown into the caller's
 * response path — the guard's contract is a GuardResult, not an exception.
 *
 * An unapproved `detail` key or value is a caller bug, not a write failure,
 * so it throws synchronously instead of being logged and dropped.
 */
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  if (!detailIsApproved(input.detail)) {
    // Do not echo the rejected key or value: either can itself contain PHI or
    // a credential and this exception may be captured by an outer logger.
    throw new Error('recordAuditEvent: detail contains an unapproved key or value — SEC-6/SEC-7')
  }

  try {
    const client = await writeClient(input)
    const { error } = await client.from('audit_events').insert({
      actor_kind: input.actorKind,
      actor_ref: input.actorRef,
      action: input.action,
      target_kind: input.targetKind,
      target_id: input.targetId,
      outcome: input.outcome,
      detail: input.detail ?? null,
    })
    if (error) logWriteFailure(input.action)
  } catch {
    logWriteFailure(input.action)
  }
}

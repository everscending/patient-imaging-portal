// lib/audit/events.ts — the ONLY writer to audit_events (ARCHITECTURE.md §2, §3).
import 'server-only'

import { serviceClient } from '../db/client'

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

// The same type serviceClient() already returns — reusing it via ReturnType
// keeps this file from having to import a Supabase SDK type directly, which
// only lib/db/client.ts may do (ARCHITECTURE.md §2 row 3).
type WriteClient = ReturnType<typeof serviceClient>

// SEC-6: detail carries identifiers, counts and outcomes only. These are the
// PHI-shaped keys a caller could plausibly reach for by mistake — a closed
// blocklist, not a schema, because `detail`'s value type is already closed to
// string | number | boolean by RecordAuditEventInput.
const FORBIDDEN_DETAIL_KEYS = new Set(['fullName', 'name', 'dateOfBirth', 'dob', 'patientRef', 'email', 'phone', 'storageKey', 'error'])

function forbiddenDetailKey(detail: RecordAuditEventInput['detail']): string | null {
  if (!detail) return null
  for (const key of Object.keys(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key)) return key
  }
  return null
}

const MAX_LOGGED_ERROR_LENGTH = 300

function shortError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, MAX_LOGGED_ERROR_LENGTH)
  if (typeof error === 'string') return error.slice(0, MAX_LOGGED_ERROR_LENGTH)
  return 'audit_events insert failed'
}

// Never PHI (SEC-6): only the action and a short adapter-side error string —
// never `detail`, never a raw Postgres error string.
function logWriteFailure(action: AuditAction, error: string): void {
  console.error(JSON.stringify({ event: 'audit_events.write_failed', action, error }))
}

/**
 * Appends one row to audit_events. Resolves void either way: a failed
 * append is logged (SEC-6: no PHI) and never rethrown into the caller's
 * response path — the guard's contract is a GuardResult, not an exception.
 *
 * A `detail` object carrying a PHI-shaped key is a caller bug, not a write
 * failure, so it throws synchronously instead of being logged and dropped.
 */
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  const badKey = forbiddenDetailKey(input.detail)
  if (badKey) {
    throw new Error(`recordAuditEvent: detail must not carry a PHI-shaped key ("${badKey}") — SEC-6`)
  }

  try {
    const client: WriteClient = serviceClient()
    const { error } = await client.from('audit_events').insert({
      actor_kind: input.actorKind,
      actor_ref: input.actorRef,
      action: input.action,
      target_kind: input.targetKind,
      target_id: input.targetId,
      outcome: input.outcome,
      detail: input.detail ?? null,
    })
    if (error) logWriteFailure(input.action, error.message)
  } catch (error) {
    logWriteFailure(input.action, shortError(error))
  }
}

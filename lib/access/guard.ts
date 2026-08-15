// lib/access/guard.ts — the single PHI seam (ARCHITECTURE.md §5).
import type { AuditAction } from '../audit/events'
import { recordAuditEvent } from '../audit/events'

export type Actor =
  | { kind: 'patient'; userId: string }
  | { kind: 'provider'; userId: string }
  | { kind: 'admin'; userId: string }
  | { kind: 'share_recipient'; shareLinkId: string }

export type PhiTarget =
  | { kind: 'study'; id: string }
  | { kind: 'image'; id: string }
  | { kind: 'clip'; id: string }
  | { kind: 'report'; id: string }
  | { kind: 'appointment'; id: string }
  | { kind: 'schedule'; id: string } // id = provider id
  | { kind: 'collection'; of: 'study' | 'report' | 'appointment' | 'share' }
  | { kind: 'audit_log' } // no id — the whole log, admin only

// `patientId` is null for targets that have no single patient: a provider
// reading their own schedule, or an admin reading the audit log. A success
// shape that always promises a patient id is unsatisfiable for those.
export type GuardResult = { ok: true; patientId: string | null } | { ok: false; status: 401 | 403 | 404 }

function assertNever(value: never): never {
  throw new Error(`lib/access/guard.ts: unreachable variant ${JSON.stringify(value)}`)
}

function actorAuditFields(actor: Actor): { actorKind: 'account' | 'share_recipient'; actorRef: string } {
  switch (actor.kind) {
    case 'patient':
    case 'provider':
    case 'admin':
      return { actorKind: 'account', actorRef: actor.userId }
    case 'share_recipient':
      return { actorKind: 'share_recipient', actorRef: actor.shareLinkId }
    default:
      return assertNever(actor)
  }
}

function targetAuditFields(target: PhiTarget): { targetKind: string; targetId: string | null } {
  switch (target.kind) {
    case 'study':
    case 'image':
    case 'clip':
    case 'report':
    case 'appointment':
    case 'schedule':
      return { targetKind: target.kind, targetId: target.id }
    case 'collection':
      // §5: a collection read writes one row with target_id null and
      // target_kind `<of>_list`.
      return { targetKind: `${target.of}_list`, targetId: null }
    case 'audit_log':
      return { targetKind: 'audit_log', targetId: null }
    default:
      return assertNever(target)
  }
}

/**
 * Verifies session, identity link, and ownership; writes exactly one
 * audit event either way. Never throws for an authorization failure —
 * the caller maps `status` straight to a response.
 *
 * Ownership failure returns 404, never 403: a 403 confirms the resource
 * exists, which is itself a cross-patient leak under FR-6.
 *
 * Stub (JOR-238): always denies. T17 fills in the session, identity-link and
 * ownership checks; until then every call writes one denied row and returns
 * 401 — never throws, so no caller learns the wrong error path from it.
 */
export async function guardPhiAccess(actor: Actor, target: PhiTarget, action: AuditAction): Promise<GuardResult> {
  const { actorKind, actorRef } = actorAuditFields(actor)
  const { targetKind, targetId } = targetAuditFields(target)

  await recordAuditEvent({
    actorKind,
    actorRef,
    action,
    targetKind,
    targetId,
    outcome: 'denied',
  })

  return { ok: false, status: 401 }
}

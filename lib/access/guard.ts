// lib/access/guard.ts — the single PHI seam (ARCHITECTURE.md §5).
import 'server-only'

import { cookies } from 'next/headers'
import type { AuditAction } from '../audit/events'
import { recordAuditEvent } from '../audit/events'
import { anonClient, authClient, serviceClient } from '../db/client'
import { SESSION_COOKIE_NAME } from '../session-cookie'

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

// Same type anonClient() and serviceClient() already return (both are
// SupabaseClient) — reused via ReturnType so this file never has to name
// the Supabase SDK type directly (only lib/db/client.ts may import it).
type Client = ReturnType<typeof anonClient>

type PatientLinkRow = { id: string }
type ProviderRow = { id: string }
type OwnedRow = { id: string; patient_id: string }
type ReportRow = { id: string; patient_id: string; status: 'preliminary' | 'signed' }
type ReportWithStudyRow = { id: string; patient_id: string; study_id: string }
type StudyRow = { id: string; patient_id: string; visit_id: string }
type VisitRow = { id: string }
type ShareLinkRow = { id: string; patient_id: string; image_id: string | null; report_id: string | null }

// study/image/clip/appointment share the same ownership shape for a patient
// or an admin actor: one row, keyed by id (and by patient_id for a patient).
const PATIENT_SCOPED_TABLES: Record<'study' | 'image' | 'clip' | 'appointment', string> = {
  study: 'studies',
  image: 'images',
  clip: 'cine_clips',
  appointment: 'appointments',
}

async function fetchRow<T>(client: Client, table: string, filters: Array<[string, string]>): Promise<T | null> {
  let query = client.from(table).select('*')
  for (const [column, value] of filters) {
    query = query.eq(column, value)
  }
  const { data, error } = await query.maybeSingle()
  if (error) throw new Error(`guard: failed to read ${table}: ${error.message}`)
  return (data as T | null) ?? null
}

// Reads the caller's session the same way lib/audit/events.ts and
// lib/access/identity.ts do — the session cookie, via next/headers, since
// there is no NextRequest in scope here either.
async function callerAccessToken(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null
}

async function decidePatientReport(client: Client, reportId: string, patientId: string): Promise<GuardResult> {
  const report = await fetchRow<ReportRow>(client, 'reports', [
    ['id', reportId],
    ['patient_id', patientId],
  ])
  if (!report) return { ok: false, status: 404 }
  // FR-7: the signed-only rule is a patient visibility rule — a provider or
  // admin actor never reaches this function, so it never needs to check it.
  if (report.status === 'preliminary') return { ok: false, status: 404 }
  return { ok: true, patientId }
}

async function decidePatient(client: Client, userId: string, target: PhiTarget): Promise<GuardResult> {
  // §4: the identity link is patients.user_id, read through the caller's own
  // client under the patients_self policy — zero rows for an unlinked or
  // deleted-underneath-them account, identical to "never linked" (ADR-0011).
  const patient = await fetchRow<PatientLinkRow>(client, 'patients', [['user_id', userId]])
  if (!patient) return { ok: false, status: 403 }
  const patientId = patient.id

  switch (target.kind) {
    case 'collection':
      // §5/ADR-0012: no per-item check — there is no named item. Rows
      // themselves stay scoped by RLS; this grant never widens what returns.
      return { ok: true, patientId }
    case 'schedule':
    case 'audit_log':
      // No ownership definition for a patient actor on either target.
      return { ok: false, status: 404 }
    case 'report':
      return decidePatientReport(client, target.id, patientId)
    case 'study':
    case 'image':
    case 'clip':
    case 'appointment': {
      const row = await fetchRow<OwnedRow>(client, PATIENT_SCOPED_TABLES[target.kind], [
        ['id', target.id],
        ['patient_id', patientId],
      ])
      return row ? { ok: true, patientId } : { ok: false, status: 404 }
    }
    default:
      return assertNever(target)
  }
}

async function decideStudyForProvider(client: Client, studyId: string, providerId: string): Promise<GuardResult> {
  const study = await fetchRow<StudyRow>(client, 'studies', [['id', studyId]])
  if (!study) return { ok: false, status: 404 }
  const visit = await fetchRow<VisitRow>(client, 'visits', [
    ['id', study.visit_id],
    ['provider_id', providerId],
  ])
  if (!visit) return { ok: false, status: 404 }
  return { ok: true, patientId: study.patient_id }
}

async function decideReportForProvider(client: Client, reportId: string, providerId: string): Promise<GuardResult> {
  const report = await fetchRow<ReportWithStudyRow>(client, 'reports', [['id', reportId]])
  if (!report) return { ok: false, status: 404 }
  const study = await fetchRow<StudyRow>(client, 'studies', [['id', report.study_id]])
  if (!study) return { ok: false, status: 404 }
  const visit = await fetchRow<VisitRow>(client, 'visits', [
    ['id', study.visit_id],
    ['provider_id', providerId],
  ])
  if (!visit) return { ok: false, status: 404 }
  // §5: preliminary is a patient visibility rule (FR-7) — a provider reading
  // their own patient's report sees it whatever its status.
  return { ok: true, patientId: report.patient_id }
}

async function decideProvider(client: Client, userId: string, target: PhiTarget): Promise<GuardResult> {
  switch (target.kind) {
    case 'collection':
      return { ok: true, patientId: null }
    case 'audit_log':
      return { ok: false, status: 404 }
    case 'image':
    case 'clip':
      // §4 RLS grants a provider no read path to images or cine clips at all
      // (images_own/clips_own key on patient_id only) — no ownership
      // definition exists for this actor/target pair, so it always fails.
      return { ok: false, status: 404 }
    case 'schedule': {
      const provider = await fetchRow<ProviderRow>(client, 'providers', [['user_id', userId]])
      if (!provider) return { ok: false, status: 404 }
      return provider.id === target.id ? { ok: true, patientId: null } : { ok: false, status: 404 }
    }
    case 'appointment': {
      const provider = await fetchRow<ProviderRow>(client, 'providers', [['user_id', userId]])
      if (!provider) return { ok: false, status: 404 }
      const row = await fetchRow<OwnedRow>(client, 'appointments', [
        ['id', target.id],
        ['provider_id', provider.id],
      ])
      return row ? { ok: true, patientId: row.patient_id } : { ok: false, status: 404 }
    }
    case 'study': {
      const provider = await fetchRow<ProviderRow>(client, 'providers', [['user_id', userId]])
      if (!provider) return { ok: false, status: 404 }
      return decideStudyForProvider(client, target.id, provider.id)
    }
    case 'report': {
      const provider = await fetchRow<ProviderRow>(client, 'providers', [['user_id', userId]])
      if (!provider) return { ok: false, status: 404 }
      return decideReportForProvider(client, target.id, provider.id)
    }
    default:
      return assertNever(target)
  }
}

async function decideAdmin(client: Client, target: PhiTarget): Promise<GuardResult> {
  switch (target.kind) {
    case 'collection':
    case 'audit_log':
      // §5: admin ownership is "always true, and always audited" — the
      // audit write happens unconditionally in guardPhiAccess below.
      return { ok: true, patientId: null }
    case 'schedule': {
      const provider = await fetchRow<ProviderRow>(client, 'providers', [['id', target.id]])
      return provider ? { ok: true, patientId: null } : { ok: false, status: 404 }
    }
    case 'study':
    case 'image':
    case 'clip':
    case 'appointment': {
      const row = await fetchRow<OwnedRow>(client, PATIENT_SCOPED_TABLES[target.kind], [['id', target.id]])
      return row ? { ok: true, patientId: row.patient_id } : { ok: false, status: 404 }
    }
    case 'report': {
      // Preliminary is allowed for admin (§5) — no status check needed.
      const row = await fetchRow<ReportRow>(client, 'reports', [['id', target.id]])
      return row ? { ok: true, patientId: row.patient_id } : { ok: false, status: 404 }
    }
    default:
      return assertNever(target)
  }
}

// A share recipient carries no session at all (UX_SPEC §4.8: "the only
// PHI-bearing route reachable without a session"), so there is no auth.uid()
// to key an anonClient read on. Reading the already-resolved share_links row
// by its id is the guard's own layer of ARCHITECTURE.md §4's "share-link
// resolution (where there is no auth.uid() to key on)" — one of the three
// legal service-role uses. The raw-token-to-shareLinkId match, and any
// expiry/revocation check, belong to the not-yet-built module that resolves
// the token and calls this guard — this function only re-checks that the
// target is the exact resource that shareLinkId names (FR-9).
async function decideShareRecipient(shareLinkId: string, target: PhiTarget): Promise<GuardResult> {
  if (target.kind !== 'image' && target.kind !== 'report') return { ok: false, status: 404 }

  const link = await fetchRow<ShareLinkRow>(serviceClient(), 'share_links', [['id', shareLinkId]])
  if (!link) return { ok: false, status: 404 }

  const namedId = target.kind === 'image' ? link.image_id : link.report_id
  if (namedId !== target.id) return { ok: false, status: 404 }

  return { ok: true, patientId: link.patient_id }
}

type AccessDecision = {
  result: GuardResult
  authenticatedUserId?: string
}

async function decide(actor: Actor, target: PhiTarget): Promise<AccessDecision> {
  if (actor.kind === 'share_recipient') {
    return { result: await decideShareRecipient(actor.shareLinkId, target) }
  }

  const token = await callerAccessToken()
  if (!token) return { result: { ok: false, status: 401 } }

  const { data, error } = await authClient().auth.getUser(token)
  if (error || !data.user) return { result: { ok: false, status: 401 } }

  const authenticatedUserId = data.user.id
  if (actor.userId !== authenticatedUserId) {
    return { result: { ok: false, status: 401 }, authenticatedUserId }
  }

  const client = anonClient(token)

  switch (actor.kind) {
    case 'patient':
      return { result: await decidePatient(client, authenticatedUserId, target), authenticatedUserId }
    case 'provider':
      return { result: await decideProvider(client, authenticatedUserId, target), authenticatedUserId }
    case 'admin':
      return { result: await decideAdmin(client, target), authenticatedUserId }
    default:
      return assertNever(actor)
  }
}

/**
 * Verifies session, identity link, and ownership; writes exactly one
 * audit event either way. Never throws for an authorization failure —
 * the caller maps `status` straight to a response.
 *
 * Ownership failure returns 404, never 403: a 403 confirms the resource
 * exists, which is itself a cross-patient leak under FR-6.
 */
export async function guardPhiAccess(actor: Actor, target: PhiTarget, action: AuditAction): Promise<GuardResult> {
  const { actorKind, actorRef } = actorAuditFields(actor)
  const { targetKind, targetId } = targetAuditFields(target)

  // Never throws out of this function (never a 500): an unexpected failure
  // anywhere in decide() — a dropped connection, a deleted-underneath-them
  // row surfacing as something other than a clean zero-row read — collapses
  // to the same conservative denial a missing session gets.
  let accessDecision: AccessDecision
  try {
    accessDecision = await decide(actor, target)
  } catch {
    accessDecision = { result: { ok: false, status: 401 } }
  }

  const decision = accessDecision.result

  await recordAuditEvent({
    actorKind,
    actorRef: accessDecision.authenticatedUserId ?? actorRef,
    action,
    targetKind,
    targetId,
    outcome: decision.ok ? 'granted' : 'denied',
  })

  return decision
}

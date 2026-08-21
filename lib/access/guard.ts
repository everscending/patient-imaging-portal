// lib/access/guard.ts — the single PHI seam (ARCHITECTURE.md §5).
import 'server-only'

import { cookies } from 'next/headers'
import type { AuditAction } from '../audit/events'
import { recordPhiAccessDecision, recordRequiredPhiAccessDecision } from '../audit/events'
import { anonClient, authClient, serviceClient } from '../db/client'
import { SESSION_COOKIE_NAME } from '../session-cookie'

export type Actor =
  | { kind: 'patient'; userId: string }
  | { kind: 'provider'; userId: string }
  | { kind: 'admin'; userId: string }
  | { kind: 'share_recipient'; shareLinkId: string }
  | { kind: 'anonymous' }

export type PhiTarget =
  | { kind: 'study'; id: string }
  | { kind: 'image'; id: string }
  | { kind: 'clip'; id: string }
  | { kind: 'report'; id: string }
  | { kind: 'appointment'; id: string }
  | { kind: 'patient'; id: string | null }
  | { kind: 'schedule'; id: string } // id = provider id
  | { kind: 'share_link'; id: string | null } // null = unresolved share token
  | { kind: 'collection'; of: 'study' | 'report' | 'appointment' | 'share' }
  | { kind: 'audit_log' } // no id — the whole log, admin only

// `patientId` is null for targets that have no single patient: a provider
// reading their own schedule, or an admin reading the audit log. A success
// shape that always promises a patient id is unsatisfiable for those.
export type GuardResult = { ok: true; patientId: string | null } | { ok: false; status: 401 | 403 | 404 }

const authenticatedSession = Symbol('authenticatedSession')
export type AuthenticatedSession = {
  accessToken: string
  userId: string
  readonly [authenticatedSession]: true
}

type SessionAuthentication =
  | { status: 'authenticated'; session: AuthenticatedSession }
  | { status: 'unauthenticated' }
  | { status: 'unavailable' }

declare const phiRequestAuthentication: unique symbol
export type PhiRequestAuthentication = SessionAuthentication & {
  readonly [phiRequestAuthentication]: true
}
const phiRequestAuthentications = new WeakSet<object>()

function assertNever(value: never): never {
  throw new Error(`lib/access/guard.ts: unreachable variant ${JSON.stringify(value)}`)
}

function actorAuditFields(actor: Actor): { actorKind: 'account' | 'share_recipient' | 'anonymous'; actorRef: string | null } {
  switch (actor.kind) {
    case 'patient':
    case 'provider':
    case 'admin':
      // The supplied account id is only a claim until the session is
      // authenticated. Missing/invalid sessions must not attribute an
      // elevated audit write to that unauthenticated value.
      return { actorKind: 'account', actorRef: null }
    case 'share_recipient':
      return { actorKind: 'share_recipient', actorRef: actor.shareLinkId }
    case 'anonymous':
      return { actorKind: 'anonymous', actorRef: null }
    default:
      return assertNever(actor)
  }
}

const COLLECTION_ACTIONS: Record<Extract<PhiTarget, { kind: 'collection' }>['of'], AuditAction> = {
  study: 'study.view',
  report: 'report.view',
  appointment: 'appointment.view',
  share: 'share.view',
}

function recordedAction(target: PhiTarget, requestedAction: AuditAction): AuditAction {
  return target.kind === 'collection' ? COLLECTION_ACTIONS[target.of] : requestedAction
}

function targetAuditFields(target: PhiTarget): { targetKind: string; targetId: string | null } {
  switch (target.kind) {
    case 'study':
    case 'image':
    case 'clip':
    case 'report':
    case 'appointment':
    case 'patient':
    case 'schedule':
    case 'share_link':
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
type StaffAdminRow = { id: string }
type OwnedRow = { id: string; patient_id: string }
type ReportRow = { id: string; patient_id: string; status: 'preliminary' | 'signed' }
type ReportWithStudyRow = { id: string; patient_id: string; study_id: string }
type StudyRow = { id: string; patient_id: string; visit_id: string }
type VisitRow = { id: string }
type ShareLinkRow = { id: string; patient_id: string; image_id: string | null; report_id: string | null; expires_at: string; revoked_at: string | null }
type PatientImagingGrantRow = { patient_id: string | null; status: number }

// study/image/clip/appointment share the same ownership shape for a patient
// or an admin actor: one row, keyed by id (and by patient_id for a patient).
const PATIENT_SCOPED_TABLES: Record<'study' | 'image' | 'clip' | 'appointment', string> = {
  study: 'studies',
  image: 'images',
  clip: 'cine_clips',
  appointment: 'appointments',
}

async function fetchRow<T>(client: Client, table: string, columns: string, filters: Array<[string, string]>): Promise<T | null> {
  let query = client.from(table).select(columns)
  for (const [column, value] of filters) {
    query = query.eq(column, value)
  }
  const { data, error } = await query.maybeSingle()
  if (error) throw new Error('guard: authorization dependency read failed')
  return (data as T | null) ?? null
}

// Reads the caller's session the same way lib/audit/events.ts and
// lib/access/identity.ts do — the session cookie, via next/headers, since
// there is no NextRequest in scope here either.
async function callerAccessToken(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null
}

function authenticatedRequest(result: SessionAuthentication): PhiRequestAuthentication {
  const authentication = Object.freeze(result) as PhiRequestAuthentication
  phiRequestAuthentications.add(authentication)
  return authentication
}

export async function authenticatePhiRequest(): Promise<PhiRequestAuthentication> {
  try {
    const accessToken = await callerAccessToken()
    if (!accessToken) return authenticatedRequest({ status: 'unauthenticated' })

    const { data, error } = await authClient().auth.getUser(accessToken)
    if (error) {
      return authenticatedRequest(error.status === 401 || error.status === 403
        ? { status: 'unauthenticated' }
        : { status: 'unavailable' })
    }
    if (!data.user) return authenticatedRequest({ status: 'unauthenticated' })
    const session = Object.freeze({ accessToken, userId: data.user.id, [authenticatedSession]: true as const })
    return authenticatedRequest({ status: 'authenticated', session })
  } catch {
    return authenticatedRequest({ status: 'unavailable' })
  }
}

/** Resolves the authenticated account's schedule-facing role without trusting
 * a role supplied by the request. Availability routes use the returned Actor
 * for their single guard call. */
export async function resolveScheduleActor(userId: string): Promise<
  { kind: 'provider'; userId: string } | { kind: 'admin'; userId: string } | { kind: 'patient'; userId: string }
> {
  const token = await callerAccessToken()
  if (!token) throw new Error('guard: authenticated session is unavailable')
  const client = anonClient(token)
  const [provider, admin] = await Promise.all([
    fetchRow<ProviderRow>(client, 'providers', 'id', [['user_id', userId]]),
    fetchRow<StaffAdminRow>(client, 'staff_admins', 'id', [['user_id', userId]]),
  ])
  if (provider) return { kind: 'provider', userId }
  if (admin) return { kind: 'admin', userId }
  return { kind: 'patient', userId }
}

async function decidePatientReport(client: Client, reportId: string, patientId: string): Promise<GuardResult> {
  const report = await fetchRow<ReportRow>(client, 'reports', 'id, patient_id, status', [
    ['id', reportId],
    ['patient_id', patientId],
  ])
  if (!report) return { ok: false, status: 404 }
  // FR-7: the signed-only rule is a patient visibility rule — a provider or
  // admin actor never reaches this function, so it never needs to check it.
  if (report.status === 'preliminary') return { ok: false, status: 404 }
  return { ok: true, patientId }
}

async function decidePatientImagingGrant(
  client: Client,
  target: Extract<PhiTarget, { kind: 'study' | 'clip' }>,
): Promise<GuardResult> {
  const { data, error } = await client.rpc('grant_patient_imaging_access', {
    p_target_kind: target.kind,
    p_target_id: target.id,
  })
  const grant = data as PatientImagingGrantRow | null
  if (error || !grant) throw new Error('guard: authorization dependency read failed')
  if (grant.status === 200 && typeof grant.patient_id === 'string') {
    return { ok: true, patientId: grant.patient_id }
  }
  if ((grant.status === 403 || grant.status === 404) && grant.patient_id === null) {
    return { ok: false, status: grant.status }
  }
  throw new Error('guard: authorization dependency returned an invalid grant')
}

async function decidePatient(client: Client, userId: string, target: PhiTarget): Promise<GuardResult> {
  // §4: the identity link is patients.user_id, read through the caller's own
  // client under the patients_self policy — zero rows for an unlinked or
  // deleted-underneath-them account, identical to "never linked" (ADR-0011).
  const patient = await fetchRow<PatientLinkRow>(client, 'patients', 'id', [['user_id', userId]])
  if (!patient) return { ok: false, status: 403 }
  const patientId = patient.id

  switch (target.kind) {
    case 'patient':
      return target.id === null || target.id === patientId
        ? { ok: true, patientId }
        : { ok: false, status: 404 }
    case 'collection':
      // §5/ADR-0012: no per-item check — there is no named item. Rows
      // themselves stay scoped by RLS; this grant never widens what returns.
      return { ok: true, patientId }
    case 'schedule':
    case 'audit_log':
      // No ownership definition for a patient actor on either target.
      return { ok: false, status: 404 }
    case 'share_link': {
      if (target.id === null) return { ok: false, status: 404 }
      const row = await fetchRow<OwnedRow>(client, 'share_links', 'id, patient_id', [
        ['id', target.id],
        ['patient_id', patientId],
      ])
      return row ? { ok: true, patientId } : { ok: false, status: 404 }
    }
    case 'report':
      return decidePatientReport(client, target.id, patientId)
    case 'study':
    case 'image':
    case 'clip':
    case 'appointment': {
      const row = await fetchRow<OwnedRow>(client, PATIENT_SCOPED_TABLES[target.kind], 'id, patient_id', [
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
  const study = await fetchRow<StudyRow>(client, 'studies', 'id, patient_id, visit_id', [['id', studyId]])
  if (!study) return { ok: false, status: 404 }
  const visit = await fetchRow<VisitRow>(client, 'visits', 'id', [
    ['id', study.visit_id],
    ['provider_id', providerId],
  ])
  if (!visit) return { ok: false, status: 404 }
  return { ok: true, patientId: study.patient_id }
}

async function decideReportForProvider(client: Client, reportId: string, providerId: string): Promise<GuardResult> {
  const report = await fetchRow<ReportWithStudyRow>(client, 'reports', 'id, patient_id, study_id', [['id', reportId]])
  if (!report) return { ok: false, status: 404 }
  const study = await fetchRow<StudyRow>(client, 'studies', 'id, patient_id, visit_id', [['id', report.study_id]])
  if (!study) return { ok: false, status: 404 }
  const visit = await fetchRow<VisitRow>(client, 'visits', 'id', [
    ['id', study.visit_id],
    ['provider_id', providerId],
  ])
  if (!visit) return { ok: false, status: 404 }
  // §5: preliminary is a patient visibility rule (FR-7) — a provider reading
  // their own patient's report sees it whatever its status.
  return { ok: true, patientId: report.patient_id }
}

async function decideProvider(client: Client, userId: string, target: PhiTarget): Promise<GuardResult> {
  // SEC-2: matching the authenticated account id is not enough to establish
  // the claimed role. Resolve provider membership through the caller's own
  // client before any provider-specific grant, including a collection.
  const provider = await fetchRow<ProviderRow>(client, 'providers', 'id', [['user_id', userId]])
  if (!provider) return { ok: false, status: 404 }

  switch (target.kind) {
    case 'collection':
      return { ok: true, patientId: null }
    case 'audit_log':
    case 'share_link':
    case 'patient':
      return { ok: false, status: 404 }
    case 'image':
    case 'clip':
      // §4 RLS grants a provider no read path to images or cine clips at all
      // (images_own/clips_own key on patient_id only) — no ownership
      // definition exists for this actor/target pair, so it always fails.
      return { ok: false, status: 404 }
    case 'schedule':
      return provider.id === target.id ? { ok: true, patientId: null } : { ok: false, status: 404 }
    case 'appointment': {
      const row = await fetchRow<OwnedRow>(client, 'appointments', 'id, patient_id', [
        ['id', target.id],
        ['provider_id', provider.id],
      ])
      return row ? { ok: true, patientId: row.patient_id } : { ok: false, status: 404 }
    }
    case 'study':
      return decideStudyForProvider(client, target.id, provider.id)
    case 'report':
      return decideReportForProvider(client, target.id, provider.id)
    default:
      return assertNever(target)
  }
}

async function decideAdmin(client: Client, userId: string, target: PhiTarget): Promise<GuardResult> {
  // SEC-2: "admin owns every target" applies only after the authenticated
  // account is proven to be staff. Query membership with the caller-scoped
  // client before collection, audit-log, or target-specific access.
  const admin = await fetchRow<StaffAdminRow>(client, 'staff_admins', 'id', [['user_id', userId]])
  if (!admin) return { ok: false, status: 404 }

  switch (target.kind) {
    case 'collection':
    case 'audit_log':
      // §5: admin ownership is "always true, and always audited" — the
      // audit write happens unconditionally in guardPhiAccess below.
      return { ok: true, patientId: null }
    case 'share_link':
    case 'patient':
      return { ok: false, status: 404 }
    case 'schedule': {
      const provider = await fetchRow<ProviderRow>(client, 'providers', 'id', [['id', target.id]])
      return provider ? { ok: true, patientId: null } : { ok: false, status: 404 }
    }
    case 'study':
    case 'image':
    case 'clip':
    case 'appointment': {
      const row = await fetchRow<OwnedRow>(client, PATIENT_SCOPED_TABLES[target.kind], 'id, patient_id', [['id', target.id]])
      return row ? { ok: true, patientId: row.patient_id } : { ok: false, status: 404 }
    }
    case 'report': {
      // Preliminary is allowed for admin (§5) — no status check needed.
      const row = await fetchRow<ReportRow>(client, 'reports', 'id, patient_id, status', [['id', target.id]])
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
// legal service-role uses. The token resolver owns the raw-token-to-link-id
// match; this guard re-checks that the link is active and names the exact
// target before granting access (FR-9).
async function decideShareRecipient(shareLinkId: string, target: PhiTarget): Promise<GuardResult> {
  if (target.kind !== 'image' && target.kind !== 'report') return { ok: false, status: 404 }

  const link = await fetchRow<ShareLinkRow>(serviceClient(), 'share_links', 'id, patient_id, image_id, report_id, expires_at, revoked_at', [['id', shareLinkId]])
  if (!link) return { ok: false, status: 404 }
  if (link.revoked_at !== null || Date.parse(link.expires_at) <= Date.now()) return { ok: false, status: 404 }

  const namedId = target.kind === 'image' ? link.image_id : link.report_id
  if (namedId !== target.id) return { ok: false, status: 404 }

  return { ok: true, patientId: link.patient_id }
}

type AccessDecision = {
  result: GuardResult
  authenticatedUserId?: string
  session?: AuthenticatedSession
  dependencyFailed?: boolean
  auditRecorded?: boolean
}

async function decide(
  actor: Actor,
  target: PhiTarget,
  action: AuditAction,
  authentication?: SessionAuthentication,
): Promise<AccessDecision> {
  if (actor.kind === 'anonymous') return { result: { ok: false, status: 404 } }

  if (actor.kind === 'share_recipient') {
    try {
      return { result: await decideShareRecipient(actor.shareLinkId, target) }
    } catch {
      return { result: { ok: false, status: 404 }, dependencyFailed: true }
    }
  }

  const sessionResult = authentication ?? await authenticatePhiRequest()
  if (sessionResult.status === 'unavailable') {
    return { result: { ok: false, status: 404 }, dependencyFailed: true }
  }
  if (sessionResult.status === 'unauthenticated') return { result: { ok: false, status: 401 } }

  const { accessToken: token, userId: authenticatedUserId } = sessionResult.session
  if (actor.userId !== authenticatedUserId) {
    return { result: { ok: false, status: 401 }, authenticatedUserId, session: sessionResult.session }
  }

  const client = anonClient(token)

  try {
    switch (actor.kind) {
      case 'patient': {
        if (
          (target.kind === 'study' && action === 'study.view')
          || (target.kind === 'clip' && action === 'clip.view')
        ) {
          return {
            result: await decidePatientImagingGrant(client, target),
            authenticatedUserId,
            session: sessionResult.session,
            auditRecorded: true,
          }
        }
        return { result: await decidePatient(client, authenticatedUserId, target), authenticatedUserId, session: sessionResult.session }
      }
      case 'provider':
        return { result: await decideProvider(client, authenticatedUserId, target), authenticatedUserId, session: sessionResult.session }
      case 'admin':
        return { result: await decideAdmin(client, authenticatedUserId, target), authenticatedUserId, session: sessionResult.session }
      default:
        return assertNever(actor)
    }
  } catch {
    return { result: { ok: false, status: 404 }, authenticatedUserId, session: sessionResult.session, dependencyFailed: true }
  }
}

async function guardWithAuthentication(
  actor: Actor,
  target: PhiTarget,
  action: AuditAction,
  authentication?: SessionAuthentication,
  options?: { grantedAudit: 'transactional-rpc' },
): Promise<GuardResult> {
  const { actorKind, actorRef } = actorAuditFields(actor)
  const { targetKind, targetId } = targetAuditFields(target)

  const accessDecision = await decide(actor, target, action, authentication)
  const decision = accessDecision.result

  if (!accessDecision.auditRecorded) {
    const audit = {
      actorKind,
      actorRef: accessDecision.authenticatedUserId ?? actorRef,
      action: recordedAction(target, action),
      targetKind,
      targetId,
      outcome: decision.ok ? 'granted' : 'denied',
    } as const

    if (options?.grantedAudit === 'transactional-rpc') {
      if (!decision.ok) await recordRequiredPhiAccessDecision(audit, accessDecision.session)
    } else {
      await recordPhiAccessDecision(audit, accessDecision.session)
    }
  }

  if (accessDecision.dependencyFailed) {
    throw new Error('guardPhiAccess: authorization dependency unavailable')
  }

  return decision
}

/**
 * Authenticates the session, checks the identity link and ownership, and
 * writes exactly one audit event either way. An ADR-0014 transaction may own
 * the granted row; its denials remain required here and fail closed.
 *
 * Ownership failure returns 404, never 403: a 403 confirms the resource
 * exists, which is itself a cross-patient leak under FR-6.
 */
export async function guardPhiAccess(
  actor: Actor,
  target: PhiTarget,
  action: AuditAction,
  options: { grantedAudit: 'transactional-rpc' } | undefined = undefined,
): Promise<GuardResult> {
  return guardWithAuthentication(actor, target, action, undefined, options)
}

/** Reuses one guard-authenticated request for authorization and its awaited
 * audit decision. The private runtime brand rejects caller-built contexts. */
export async function guardAuthenticatedPhiAccess(
  actor: Actor,
  target: PhiTarget,
  action: AuditAction,
  authentication: PhiRequestAuthentication,
  options: { grantedAudit: 'transactional-rpc' } | undefined = undefined,
): Promise<GuardResult> {
  if (!phiRequestAuthentications.has(authentication)) {
    throw new Error('guardPhiAccess: invalid request authentication')
  }
  return guardWithAuthentication(actor, target, action, authentication, options)
}

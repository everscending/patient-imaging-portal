// lib/access/identity.ts — FR-2 verification: match, attempt recording,
// derived lockout, and the one-time `patients.user_id` link (ADR-0011,
// ADR-0004, ADR-0008, ARCHITECTURE.md §4). The service role is legal here —
// one of exactly three uses (lib/db/client.ts): the caller is by definition
// not yet linked to the `patients` row being matched, so `patients_self`
// returns zero rows for them, and `identity_attempts` has no app-role write
// policy at all (§4).
import 'server-only'

import { createHash, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import type { AuditAction } from '../audit/events'
import { recordAuditEvent } from '../audit/events'
import { config } from '../config'
import { authClient, serviceClient } from '../db/client'
import { SESSION_COOKIE_NAME } from '../session-cookie'

export type VerifyOutcome = { ok: true; patientRef: string; linkedAt: string } | { ok: false }

export type StatusResult = { linked: true; patientRef: string; linkedAt: string } | { linked: false }

type ServiceClient = ReturnType<typeof serviceClient>

type PatientRow = { id: string; patient_ref: string; date_of_birth: string; user_id: string | null }

// ADR-0012 #20, pinned: sha256(salt + the first x-forwarded-for entry). The
// first entry is the client's own address; later entries are proxies —
// taking the last would collapse every caller behind one proxy onto a single
// source_ref. No raw address is ever stored (SEC-6): only this digest is.
export function computeSourceRef(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for') ?? ''
  const firstEntry = forwardedFor.split(',')[0]?.trim() ?? ''
  return createHash('sha256').update(config.sourceRefSalt + firstEntry).digest('hex')
}

// Reads the caller's session the same way lib/audit/events.ts does — no
// NextRequest in scope in a route handler that also needs the raw `Request`
// for computeSourceRef — then resolves it to an account id via Supabase
// Auth. Null covers both "no cookie" and "cookie doesn't resolve to a user".
export async function resolveCallerId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!token) return null
  const { data, error } = await authClient().auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

// A fixed dummy so the comparison below runs the same shape whether or not a
// row was found (ADR-0004: "the date-of-birth comparison runs on a
// constant-shape code path whether or not a row was found"). Comparing
// sha256 digests with timingSafeEqual, rather than the raw strings, avoids
// both a length-dependent short-circuit and a first-differing-byte
// short-circuit.
const DUMMY_DATE_OF_BIRTH = '1900-01-01'

function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest()
  const digestB = createHash('sha256').update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

async function countRecentFailures(
  client: ServiceClient,
  column: 'attempted_patient_ref' | 'source_ref',
  value: string,
  windowStart: string,
): Promise<number> {
  const { count, error } = await client
    .from('identity_attempts')
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
    .eq('succeeded', false)
    .gte('attempted_at', windowStart)
  if (error) throw new Error(`identity: failed to read identity_attempts: ${error.message}`)
  return count ?? 0
}

async function recordAttempt(
  client: ServiceClient,
  fields: { attemptedPatientRef: string; sourceRef: string; userId: string; succeeded: boolean; attemptedAt: string },
): Promise<void> {
  const { error } = await client.from('identity_attempts').insert({
    attempted_patient_ref: fields.attemptedPatientRef,
    source_ref: fields.sourceRef,
    user_id: fields.userId,
    succeeded: fields.succeeded,
    attempted_at: fields.attemptedAt,
  })
  if (error) throw new Error(`identity: failed to record identity_attempts row: ${error.message}`)
}

// The one successful attempt a linked account ever has (ADR-0011: the link
// is permanent, and a repeat submission from the same account writes no
// second row of any kind) — so this always resolves at most one row.
async function findLinkedAt(client: ServiceClient, userId: string): Promise<string | null> {
  const { data, error } = await client
    .from('identity_attempts')
    .select('attempted_at')
    .eq('user_id', userId)
    .eq('succeeded', true)
    .order('attempted_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`identity: failed to read identity_attempts: ${error.message}`)
  return (data as { attempted_at: string } | null)?.attempted_at ?? null
}

async function recordIdentityAudit(
  callerId: string,
  action: AuditAction,
  outcome: 'granted' | 'denied',
  targetId: string | null,
): Promise<void> {
  await recordAuditEvent({
    actorKind: 'account',
    actorRef: callerId,
    action,
    targetKind: 'patient',
    targetId,
    outcome,
  })
}

type LinkOutcome = 'linked_now' | 'already_by_caller' | 'claimed_by_other'

// The one write in the whole build that sets `patients.user_id` (§4) — moved
// into the `link_patient_identity` Postgres function (db/migrations/004_...)
// so that write and its `identity_attempts` success row commit or fail
// together in one transaction (ADR-0011's pinned design decision, AC1).
// PostgREST gives no cross-call transaction, so two sequential `.from(...)`
// calls here could not do that; a single `.rpc(...)` call runs the whole
// function body, update and insert together, as one transaction. The
// function's own conditional `where user_id is null` makes the write itself
// the single source of truth for "only when the column is currently null" —
// a second, unlucky concurrent caller for the same never-before-linked
// patient loses the race and is told so, rather than both callers reading
// back a false success.
async function attemptLink(
  client: ServiceClient,
  patientId: string,
  callerId: string,
  fields: { attemptedPatientRef: string; sourceRef: string; attemptedAt: string },
): Promise<LinkOutcome> {
  const { data, error } = await client.rpc('link_patient_identity', {
    p_patient_id: patientId,
    p_caller_id: callerId,
    p_attempted_patient_ref: fields.attemptedPatientRef,
    p_source_ref: fields.sourceRef,
    p_attempted_at: fields.attemptedAt,
  })
  if (error) throw new Error(`identity: failed to link patients.user_id: ${error.message}`)
  return data as LinkOutcome
}

export type VerifyInput = { callerId: string; patientRef: string; dateOfBirth: string; sourceRef: string }

export async function verifyIdentity(input: VerifyInput): Promise<VerifyOutcome> {
  const { callerId, patientRef, dateOfBirth, sourceRef } = input
  const client = serviceClient()
  const now = new Date()
  const nowIso = now.toISOString()
  const windowStart = new Date(now.getTime() - config.identityLockoutMinutes * 60_000).toISOString()

  const [refFailures, sourceFailures] = await Promise.all([
    countRecentFailures(client, 'attempted_patient_ref', patientRef, windowStart),
    countRecentFailures(client, 'source_ref', sourceRef, windowStart),
  ])
  // Independently per reference AND per source (ADR-0008) — either alone locks.
  const locked = refFailures >= config.identityMaxAttempts || sourceFailures >= config.identityMaxAttempts

  if (locked) {
    // Still recorded as a failed attempt (§6): one response for wrong
    // reference, wrong date of birth and an active lockout.
    await recordAttempt(client, { attemptedPatientRef: patientRef, sourceRef, userId: callerId, succeeded: false, attemptedAt: nowIso })
    await recordIdentityAudit(callerId, 'identity.lockout', 'denied', null)
    return { ok: false }
  }

  const { data: patientData, error: patientError } = await client
    .from('patients')
    .select('id, patient_ref, date_of_birth, user_id')
    .eq('patient_ref', patientRef)
    .maybeSingle()
  if (patientError) throw new Error(`identity: failed to read patients: ${patientError.message}`)
  const patient = patientData as PatientRow | null

  const dobMatches = constantTimeEqual(dateOfBirth, patient?.date_of_birth ?? DUMMY_DATE_OF_BIRTH)
  const linkedToSomeoneElse = patient !== null && patient.user_id !== null && patient.user_id !== callerId
  const matched = patient !== null && dobMatches && !linkedToSomeoneElse

  if (!matched) {
    await recordAttempt(client, { attemptedPatientRef: patientRef, sourceRef, userId: callerId, succeeded: false, attemptedAt: nowIso })
    await recordIdentityAudit(callerId, 'identity.verify', 'denied', patient?.id ?? null)
    return { ok: false }
  }

  const matchedPatient = patient as PatientRow

  if (matchedPatient.user_id === callerId) {
    // Already linked to this exact account (ADR-0011): the column is
    // already non-null and only a null column may be written, so a repeat
    // submission is a harmless no-op read — no second attempt row, no
    // second audit row.
    const linkedAt = await findLinkedAt(client, callerId)
    return { ok: true, patientRef: matchedPatient.patient_ref, linkedAt: linkedAt ?? nowIso }
  }

  const linkOutcome = await attemptLink(client, matchedPatient.id, callerId, { attemptedPatientRef: patientRef, sourceRef, attemptedAt: nowIso })

  if (linkOutcome === 'claimed_by_other') {
    await recordAttempt(client, { attemptedPatientRef: patientRef, sourceRef, userId: callerId, succeeded: false, attemptedAt: nowIso })
    await recordIdentityAudit(callerId, 'identity.verify', 'denied', matchedPatient.id)
    return { ok: false }
  }

  if (linkOutcome === 'already_by_caller') {
    const linkedAt = await findLinkedAt(client, callerId)
    return { ok: true, patientRef: matchedPatient.patient_ref, linkedAt: linkedAt ?? nowIso }
  }

  // linkOutcome === 'linked_now' — the succeeded=true identity_attempts row
  // was already written inside link_patient_identity's own transaction.
  await recordIdentityAudit(callerId, 'identity.verify', 'granted', matchedPatient.id)
  await recordIdentityAudit(callerId, 'identity.link', 'granted', matchedPatient.id)

  return { ok: true, patientRef: matchedPatient.patient_ref, linkedAt: nowIso }
}

export async function getIdentityStatus(callerId: string): Promise<StatusResult> {
  const client = serviceClient()
  const { data, error } = await client.from('patients').select('patient_ref, user_id').eq('user_id', callerId).maybeSingle()
  if (error) throw new Error(`identity: failed to read patients: ${error.message}`)
  const patient = data as { patient_ref: string; user_id: string } | null
  if (!patient) return { linked: false }

  const linkedAt = await findLinkedAt(client, callerId)
  return { linked: true, patientRef: patient.patient_ref, linkedAt: linkedAt ?? new Date().toISOString() }
}

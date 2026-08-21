// tests/access/guard.test.ts — guardPhiAccess's own tests (JOR-262). T15
// (JOR-238) pinned Actor/PhiTarget/GuardResult and the stub; this ticket
// fills in the real session, identity-link, ownership and audit logic and
// tests it here. Same reason as tests/access/identity.test.ts: no PostgREST
// server in this repo's harness, and no live route in this ticket (ADR-0012,
// "No live-app contact in this ticket") — lib/db/client.ts's anonClient(),
// serviceClient() and authClient(), next/headers's cookies(),
// lib/session-cookie.ts and lib/audit/events.ts are all stubbed; a minimal
// in-memory Postgrest-shaped fake stands in for the tables the guard reads.
//
// Bullet → test function:
//
// Acceptance criteria
//   every row of §5's status table, reproduced by a real call
//     → statusTableRowsReproducedByRealCalls
//   every row of §5's ownership table, reproduced by a real call
//     → ownershipTableReproducedByRealCalls
//   no-session call → 401, one denied audit row
//     → noSessionReturnsFourOhOneAndAuditsOneDeniedRow
//   unlinked patient actor → 403
//     → unlinkedPatientReturnsFourOhThree
//   patient A reaching patient B's target → 404, distinct from unlinked's 403
//     → patientAReachingPatientBTargetReturnsFourOhFourDistinctFromUnlinkedFourOhThree
//   a foreign study/image/clip/report/appointment and a nonexistent id are
//   indistinguishable 404s
//     → foreignPatientAndNonexistentIdBothReturnIndistinguishableFourOhFour
//   preliminary report: 404 for patient, ok for provider and admin
//     → preliminaryReportFourOhFourForPatientAllowedForProviderAndAdmin
//   schedule and audit_log return ok with patientId null for legal actors
//     → scheduleAndAuditLogReturnOkWithNullPatientIdForLegalActors
//   collection with linked patient actor: ok for all four `of` values
//     → collectionWithLinkedPatientReturnsOkForAllFourOfValues
//   collection writes exactly one row whether the list has 0, 1 or 50 rows
//     → collectionWritesExactlyOneRowRegardlessOfListSize
//   collection's recorded action is the *.view action of that kind
//     → collectionRecordedActionMatchesViewActionOfKind
//   collection grant returns no rows of its own
//     → collectionGrantReturnsNoRowsOfItsOwn
//   unlinked/no-session on collection rejected
//     → unlinkedOrNoSessionOnCollectionRejected
//   exactly one audit_events row per call, counted across the whole table
//     → exactlyOneAuditRowPerCallCountedAcrossWholeTable
//   signature and exported types match the current §5 interface
//     → signatureAndExportedTypesMatchCurrentArchitecture
//
// Mandatory adversarial tests
//   patient naming another patient's studyId → 404, identical to a random UUID
//     → patientNamingAnotherPatientsStudyIdReturnsFourOhFourIdenticalToRandomUuid
//   patient naming another patient's imageId/clipId/reportId/appointmentId → 404 each
//     → patientNamingAnotherPatientsImageClipReportAppointmentReturnsFourOhFourEach
//   provider naming a study belonging to another provider's visit → 404
//     → providerNamingStudyFromAnotherProvidersVisitReturnsFourOhFour
//   provider naming another provider's schedule → 404
//     → providerNamingAnotherProvidersScheduleReturnsFourOhFour
//   patient naming their own preliminary report → 404, never 403
//     → patientNamingOwnPreliminaryReportReturnsFourOhFourNeverFourOhThree
//   patient linked to a different patient reaching this target → 404
//     → patientLinkedToDifferentPatientReachingTargetReturnsFourOhFour
//   patient never linked → 403, not 200, not 404
//     → patientNeverLinkedReturnsFourOhThreeNotTwoHundredNotFourOhFour
//   linked patient row deleted underneath them → rejected, never a 500
//     → patientWhoseLinkedPatientRowDeletedUnderneathThemRejectedNeverFiveHundred
//   share_recipient naming any resource other than the one its link names → 404
//     → shareRecipientNamingResourceOtherThanItsShareLinkNamesReturnsFourOhFour
//   list read over a seeded 50-item list writes exactly one audit row
//     → collectionOverFiftyItemListWritesExactlyOneAuditRow
//   collection audit row with non-null target_id or wrong target_kind rejected
//     → collectionAuditRowNonNullTargetIdOrWrongTargetKindRejected
//   unlinked account reaching a collection → 403, not 200, not empty list
//     → unlinkedAccountReachingCollectionReturnsFourOhThreeNotOkNotEmptyList
//   collection grant never returns another patient's rows (RLS still scopes)
//     → collectionGrantNeverReturnsAnotherPatientsRows
//   a guarded call producing zero or two audit rows → rejected
//     → guardedCallProducingZeroOrTwoAuditRowsRejected
//   expired session JWT → 401
//     → expiredSessionJwtReturnsFourOhOne
//   patient actor userId differs from the authenticated session user → 401,
//   no claimed-identity lookup, one denial audit attributed to the session user
//     → patientActorMismatchReturnsFourOhOneWithoutClaimedIdentityLookup
//   provider actor userId differs from the authenticated session user → 401,
//   no claimed-identity lookup, one denial audit attributed to the session user
//     → providerActorMismatchReturnsFourOhOneWithoutClaimedIdentityLookup
//   admin actor userId differs from the authenticated session user → 401,
//   no target lookup, one denial audit attributed to the session user
//     → adminActorMismatchReturnsFourOhOneWithoutTargetLookup
//   patient account claims the provider role for a collection → denied
//     → patientAccountCannotClaimProviderRoleForCollection
//   patient account claims the admin role for a collection or audit_log → denied
//     → patientAccountCannotClaimAdminRoleForCollectionOrAuditLog

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../../lib/config', () => ({ config: {} }))

type FakeRow = Record<string, unknown>

const {
  db,
  auditCalls,
  anonClientMock,
  serviceClientMock,
  authClientMock,
  recordRequiredPhiAccessDecisionMock,
  selectedColumns,
  resetFake,
  setReadFailureTable,
  setAuthFailureMode,
  setCallerHasSession,
  setSessionTokenValid,
  setSessionUserId,
  hasCallerSession,
  FAKE_SESSION_COOKIE_NAME,
  FAKE_ACCESS_TOKEN,
} = vi.hoisted(() => {
  const tables: Record<string, FakeRow[]> = {
    patients: [],
    providers: [],
    staff_admins: [],
    visits: [],
    studies: [],
    images: [],
    cine_clips: [],
    reports: [],
    appointments: [],
    share_links: [],
  }
  const audits: FakeRow[] = []
  let sessionPresent = true
  let sessionValid = true
  let sessionUserId = 'session-user'
  let readFailureTable: string | null = null
  let authFailureMode: 'none' | 'throw' | 'dependency-error' = 'none'
  const selections: Array<{ table: string; columns: string }> = []
  const requiredAuditMock = vi.fn(async (input: FakeRow) => {
    audits.push(input)
  })

  function matches(row: FakeRow, filters: Array<[string, unknown]>): boolean {
    return filters.every(([column, value]) => row[column] === value)
  }

  function makeClient() {
    return {
      async rpc(name: string, input: FakeRow) {
        if (name !== 'grant_patient_imaging_access') {
          throw new Error(`fake client: unexpected rpc "${name}"`)
        }
        const targetKind = input.p_target_kind
        const targetId = input.p_target_id
        if ((targetKind !== 'study' && targetKind !== 'clip') || typeof targetId !== 'string') {
          return { data: null, error: { message: 'invalid imaging grant input' } }
        }
        const table = targetKind === 'study' ? 'studies' : 'cine_clips'
        if (readFailureTable === 'patients' || readFailureTable === table) {
          return { data: null, error: { message: 'SECRET_DATABASE_ERROR_MUST_NOT_ESCAPE' } }
        }
        const patient = tables.patients!.find((row) => row.user_id === sessionUserId)
        const owned = patient
          ? tables[table]!.some((row) => row.id === targetId && row.patient_id === patient.id)
          : false
        const status = patient ? (owned ? 200 : 404) : 403
        audits.push({
          actorKind: 'account',
          actorRef: sessionUserId,
          action: targetKind === 'study' ? 'study.view' : 'clip.view',
          targetKind,
          targetId,
          outcome: owned ? 'granted' : 'denied',
        })
        return {
          data: { patient_id: owned ? patient!.id : null, status },
          error: null,
        }
      },
      from(table: string) {
        if (!(table in tables)) throw new Error(`fake client: unexpected table "${table}"`)
        const filters: Array<[string, unknown]> = []
        const api = {
          select(columns: string) {
            selections.push({ table, columns })
            return api
          },
          eq(column: string, value: unknown) {
            filters.push([column, value])
            return api
          },
          async maybeSingle() {
            if (table === readFailureTable) {
              return { data: null, error: { message: 'SECRET_DATABASE_ERROR_MUST_NOT_ESCAPE' } }
            }
            const row = tables[table]?.find((candidate) => matches(candidate, filters)) ?? null
            return { data: row, error: null }
          },
        }
        return api
      },
    }
  }

  return {
    db: tables,
    auditCalls: audits,
    anonClientMock: vi.fn(() => makeClient()),
    serviceClientMock: vi.fn(() => makeClient()),
    authClientMock: vi.fn(() => ({
      auth: {
        async getUser(token: string) {
          if (authFailureMode === 'throw') throw new Error('SECRET_AUTH_ERROR_MUST_NOT_ESCAPE')
          if (authFailureMode === 'dependency-error') {
            return { data: { user: null }, error: { message: 'SECRET_AUTH_ERROR_MUST_NOT_ESCAPE', status: 503 } }
          }
          if (!sessionValid || token !== 'fake-caller-access-token') {
            return { data: { user: null }, error: { message: 'invalid token', status: 401 } }
          }
          return { data: { user: { id: sessionUserId } }, error: null }
        },
      },
    })),
    recordRequiredPhiAccessDecisionMock: requiredAuditMock,
    selectedColumns: selections,
    resetFake: () => {
      for (const key of Object.keys(tables)) tables[key]!.length = 0
      audits.length = 0
      sessionPresent = true
      sessionValid = true
      sessionUserId = 'session-user'
      readFailureTable = null
      authFailureMode = 'none'
      selections.length = 0
    },
    setReadFailureTable: (table: string | null) => {
      readFailureTable = table
    },
    setAuthFailureMode: (mode: 'none' | 'throw' | 'dependency-error') => {
      authFailureMode = mode
    },
    setCallerHasSession: (next: boolean) => {
      sessionPresent = next
    },
    setSessionTokenValid: (next: boolean) => {
      sessionValid = next
    },
    setSessionUserId: (next: string) => {
      sessionUserId = next
    },
    hasCallerSession: () => sessionPresent,
    FAKE_SESSION_COOKIE_NAME: 'pip_session',
    FAKE_ACCESS_TOKEN: 'fake-caller-access-token',
  }
})

vi.mock('../../lib/db/client', () => ({
  anonClient: anonClientMock,
  serviceClient: serviceClientMock,
  authClient: authClientMock,
}))

vi.mock('../../lib/session-cookie', () => ({
  SESSION_COOKIE_NAME: FAKE_SESSION_COOKIE_NAME,
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name !== FAKE_SESSION_COOKIE_NAME) return undefined
      if (!hasCallerSession()) return undefined
      return { value: FAKE_ACCESS_TOKEN }
    },
  }),
}))

vi.mock('../../lib/audit/events', () => ({
  recordAuditEvent: vi.fn(async (input: FakeRow) => {
    auditCalls.push(input)
  }),
  recordPhiAccessDecision: vi.fn(async (input: FakeRow) => {
    auditCalls.push(input)
  }),
  recordRequiredPhiAccessDecision: recordRequiredPhiAccessDecisionMock,
}))

import type { Actor, GuardResult, PhiTarget } from '../../lib/access/guard'
import {
  authenticatePhiRequest,
  guardAuthenticatedPhiAccess,
  guardPhiAccess as guardPhiAccessRaw,
} from '../../lib/access/guard'
import type { AuditAction } from '../../lib/audit/events'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

function expectOk(result: GuardResult): { ok: true; patientId: string | null } {
  if (!result.ok) throw new Error(`expected ok:true, got ${JSON.stringify(result)}`)
  return result
}

async function guardPhiAccess(actor: Actor, target: PhiTarget, action: AuditAction): Promise<GuardResult> {
  if (actor.kind !== 'share_recipient' && actor.kind !== 'anonymous') setSessionUserId(actor.userId)
  return guardPhiAccessRaw(actor, target, action)
}

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

function seedPatient(overrides: Partial<{ id: string; user_id: string | null }> = {}) {
  const row = { id: overrides.id ?? nextId('patient'), user_id: overrides.user_id ?? null }
  db.patients!.push(row)
  return row
}

function seedProvider(overrides: Partial<{ id: string; user_id: string | null }> = {}) {
  const row = { id: overrides.id ?? nextId('provider'), user_id: overrides.user_id ?? null }
  db.providers!.push(row)
  return row
}

function seedAdmin(overrides: Partial<{ id: string; user_id: string }> = {}) {
  const row = { id: overrides.id ?? nextId('admin'), user_id: overrides.user_id ?? nextId('admin-user') }
  db.staff_admins!.push(row)
  return row
}

function seedVisit(overrides: { id?: string; patient_id: string; provider_id: string }) {
  const row = { id: overrides.id ?? nextId('visit'), patient_id: overrides.patient_id, provider_id: overrides.provider_id }
  db.visits!.push(row)
  return row
}

function seedStudy(overrides: { id?: string; visit_id: string; patient_id: string }) {
  const row = { id: overrides.id ?? nextId('study'), visit_id: overrides.visit_id, patient_id: overrides.patient_id }
  db.studies!.push(row)
  return row
}

function seedImage(overrides: { id?: string; study_id: string; patient_id: string }) {
  const row = { id: overrides.id ?? nextId('image'), study_id: overrides.study_id, patient_id: overrides.patient_id }
  db.images!.push(row)
  return row
}

function seedClip(overrides: { id?: string; study_id: string; patient_id: string }) {
  const row = { id: overrides.id ?? nextId('clip'), study_id: overrides.study_id, patient_id: overrides.patient_id }
  db.cine_clips!.push(row)
  return row
}

function seedReport(overrides: { id?: string; study_id: string; patient_id: string; status: 'preliminary' | 'signed' }) {
  const row = {
    id: overrides.id ?? nextId('report'),
    study_id: overrides.study_id,
    patient_id: overrides.patient_id,
    status: overrides.status,
  }
  db.reports!.push(row)
  return row
}

function seedAppointment(overrides: { id?: string; patient_id: string; provider_id: string }) {
  const row = { id: overrides.id ?? nextId('appt'), patient_id: overrides.patient_id, provider_id: overrides.provider_id }
  db.appointments!.push(row)
  return row
}

function seedShareLink(overrides: { id?: string; patient_id: string; image_id?: string | null; report_id?: string | null; expires_at?: string; revoked_at?: string | null }) {
  const row = {
    id: overrides.id ?? nextId('share'),
    patient_id: overrides.patient_id,
    image_id: overrides.image_id ?? null,
    report_id: overrides.report_id ?? null,
    expires_at: overrides.expires_at ?? '2099-01-01T00:00:00.000Z',
    revoked_at: overrides.revoked_at ?? null,
  }
  db.share_links!.push(row)
  return row
}

beforeEach(() => {
  resetFake()
  anonClientMock.mockClear()
  serviceClientMock.mockClear()
  authClientMock.mockClear()
  recordRequiredPhiAccessDecisionMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("AC: every row of §5's status table, reproduced by a real guardPhiAccess call", () => {
  test('statusTableRowsReproducedByRealCalls', async function statusTableRowsReproducedByRealCalls() {
    // No session, or expired session -> 401
    setCallerHasSession(false)
    const noSession = await guardPhiAccess({ kind: 'patient', userId: 'st-nosession' }, { kind: 'study', id: 'irrelevant' }, 'study.view')
    expect(noSession).toEqual({ ok: false, status: 401 })
    setCallerHasSession(true)

    // Patient actor, session valid, account not linked -> 403
    const unlinked = await guardPhiAccess({ kind: 'patient', userId: 'st-unlinked' }, { kind: 'study', id: 'irrelevant' }, 'study.view')
    expect(unlinked).toEqual({ ok: false, status: 403 })

    // Target belongs to another patient (patient actor) -> 404
    seedPatient({ id: 'st-self', user_id: 'st-user-self' })
    const otherPatient = seedPatient({ id: 'st-other', user_id: 'st-user-other' })
    const providerX = seedProvider({ id: 'st-prov-x', user_id: 'st-user-prov-x' })
    seedProvider({ id: 'st-prov-y', user_id: 'st-user-prov-y' })
    const visitOther = seedVisit({ patient_id: otherPatient.id, provider_id: providerX.id })
    const studyOther = seedStudy({ visit_id: visitOther.id, patient_id: otherPatient.id })
    const foreignTarget = await guardPhiAccess({ kind: 'patient', userId: 'st-user-self' }, { kind: 'study', id: studyOther.id }, 'study.view')
    expect(foreignTarget).toEqual({ ok: false, status: 404 })

    // Target belongs to another provider (provider actor) -> 404
    const foreignProviderTarget = await guardPhiAccess({ kind: 'provider', userId: 'st-user-prov-y' }, { kind: 'study', id: studyOther.id }, 'study.view')
    expect(foreignProviderTarget).toEqual({ ok: false, status: 404 })

    // Resource does not exist -> 404
    const missing = await guardPhiAccess({ kind: 'patient', userId: 'st-user-self' }, { kind: 'study', id: 'st-study-does-not-exist' }, 'study.view')
    expect(missing).toEqual({ ok: false, status: 404 })

    // Report preliminary, patient actor -> 404
    const visitSelf = seedVisit({ patient_id: 'st-self', provider_id: providerX.id })
    const studySelf = seedStudy({ visit_id: visitSelf.id, patient_id: 'st-self' })
    const prelimReport = seedReport({ study_id: studySelf.id, patient_id: 'st-self', status: 'preliminary' })
    const patientPrelim = await guardPhiAccess({ kind: 'patient', userId: 'st-user-self' }, { kind: 'report', id: prelimReport.id }, 'report.view')
    expect(patientPrelim).toEqual({ ok: false, status: 404 })

    // Report preliminary, provider or admin actor -> allowed
    const providerPrelim = await guardPhiAccess({ kind: 'provider', userId: 'st-user-prov-x' }, { kind: 'report', id: prelimReport.id }, 'report.view')
    expect(providerPrelim).toEqual({ ok: true, patientId: 'st-self' })
    seedAdmin({ user_id: 'st-admin' })
    const adminPrelim = await guardPhiAccess({ kind: 'admin', userId: 'st-admin' }, { kind: 'report', id: prelimReport.id }, 'report.view')
    expect(adminPrelim).toEqual({ ok: true, patientId: 'st-self' })
  })
})

describe("AC: every row of §5's ownership table, reproduced by a real guardPhiAccess call", () => {
  test('ownershipTableReproducedByRealCalls', async function ownershipTableReproducedByRealCalls() {
    // patient: requires the FR-2 link; "owns" means target.patient_id equals
    // the caller's own patient.
    seedPatient({ id: 'ot-p1', user_id: 'ot-user-p1' })
    const provider = seedProvider({ id: 'ot-prov', user_id: 'ot-user-prov' })
    const visit = seedVisit({ patient_id: 'ot-p1', provider_id: provider.id })
    const study = seedStudy({ visit_id: visit.id, patient_id: 'ot-p1' })
    const ownedByPatient = await guardPhiAccess({ kind: 'patient', userId: 'ot-user-p1' }, { kind: 'study', id: study.id }, 'study.view')
    expect(ownedByPatient).toEqual({ ok: true, patientId: 'ot-p1' })

    // provider: no link required; "owns" means target.provider_id equals the
    // caller's own provider — for a study, via its visit.
    const ownedByProvider = await guardPhiAccess({ kind: 'provider', userId: 'ot-user-prov' }, { kind: 'study', id: study.id }, 'study.view')
    expect(ownedByProvider).toEqual({ ok: true, patientId: 'ot-p1' })
    expect(db.patients!.some((row) => row.user_id === 'ot-user-prov')).toBe(false)

    // admin: always true, and always audited (SEC-2)
    seedAdmin({ user_id: 'ot-admin' })
    const beforeAdminCount = auditCalls.length
    const ownedByAdmin = await guardPhiAccess({ kind: 'admin', userId: 'ot-admin' }, { kind: 'study', id: study.id }, 'study.view')
    expect(ownedByAdmin).toEqual({ ok: true, patientId: 'ot-p1' })
    expect(auditCalls.length).toBe(beforeAdminCount + 1)
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ outcome: 'granted', actorRef: 'ot-admin' })

    // share_recipient: the target is the exact resource the (already
    // validated) token's link names, and nothing else.
    const image = seedImage({ study_id: study.id, patient_id: 'ot-p1' })
    seedShareLink({ id: 'ot-share', patient_id: 'ot-p1', image_id: image.id })
    const ownedByShareRecipient = await guardPhiAccess({ kind: 'share_recipient', shareLinkId: 'ot-share' }, { kind: 'image', id: image.id }, 'image.view')
    expect(ownedByShareRecipient).toEqual({ ok: true, patientId: 'ot-p1' })
  })
})

describe('AC: a no-session call returns 401 and appends one denied audit row', () => {
  test('noSessionReturnsFourOhOneAndAuditsOneDeniedRow', async function noSessionReturnsFourOhOneAndAuditsOneDeniedRow() {
    setCallerHasSession(false)
    const before = auditCalls.length
    const result = await guardPhiAccess({ kind: 'patient', userId: 'ns-x' }, { kind: 'study', id: 'ns-study' }, 'study.view')
    expect(result).toEqual({ ok: false, status: 401 })
    expect(auditCalls.length).toBe(before + 1)
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ outcome: 'denied' })
  })
})

describe('AC: an unlinked patient actor returns 403', () => {
  test('unlinkedPatientReturnsFourOhThree', async function unlinkedPatientReturnsFourOhThree() {
    const result = await guardPhiAccess({ kind: 'patient', userId: 'ul-never-linked' }, { kind: 'study', id: 'ul-study' }, 'study.view')
    expect(result).toEqual({ ok: false, status: 403 })
  })
})

describe("AC: patient A reaching patient B's target returns 404, distinct from an unlinked account's 403", () => {
  test('patientAReachingPatientBTargetReturnsFourOhFourDistinctFromUnlinkedFourOhThree', async function patientAReachingPatientBTargetReturnsFourOhFourDistinctFromUnlinkedFourOhThree() {
    seedPatient({ id: 'ab-pa', user_id: 'ab-user-a' })
    const patientB = seedPatient({ id: 'ab-pb', user_id: 'ab-user-b' })
    const provider = seedProvider({ id: 'ab-prov', user_id: 'ab-user-prov' })
    const visitB = seedVisit({ patient_id: patientB.id, provider_id: provider.id })
    const studyB = seedStudy({ visit_id: visitB.id, patient_id: patientB.id })

    const crossPatient = await guardPhiAccess({ kind: 'patient', userId: 'ab-user-a' }, { kind: 'study', id: studyB.id }, 'study.view')
    expect(crossPatient).toEqual({ ok: false, status: 404 })

    const unlinked = await guardPhiAccess({ kind: 'patient', userId: 'ab-never-linked' }, { kind: 'study', id: studyB.id }, 'study.view')
    expect(unlinked).toEqual({ ok: false, status: 403 })
  })
})

describe('AC: a foreign resource and a nonexistent id return the same 404, for every id-shaped kind', () => {
  test('foreignPatientAndNonexistentIdBothReturnIndistinguishableFourOhFour', async function foreignPatientAndNonexistentIdBothReturnIndistinguishableFourOhFour() {
    seedPatient({ id: 'fi-pa', user_id: 'fi-user-a' })
    const patientB = seedPatient({ id: 'fi-pb', user_id: 'fi-user-b' })
    const provider = seedProvider({ id: 'fi-prov', user_id: 'fi-user-prov' })
    const visitB = seedVisit({ patient_id: patientB.id, provider_id: provider.id })
    const studyB = seedStudy({ visit_id: visitB.id, patient_id: patientB.id })
    const imageB = seedImage({ study_id: studyB.id, patient_id: patientB.id })
    const clipB = seedClip({ study_id: studyB.id, patient_id: patientB.id })
    const reportB = seedReport({ study_id: studyB.id, patient_id: patientB.id, status: 'signed' })
    const apptB = seedAppointment({ patient_id: patientB.id, provider_id: provider.id })

    const cases: Array<[PhiTarget['kind'], string, AuditAction]> = [
      ['study', studyB.id, 'study.view'],
      ['image', imageB.id, 'image.view'],
      ['clip', clipB.id, 'clip.view'],
      ['report', reportB.id, 'report.view'],
      ['appointment', apptB.id, 'appointment.view'],
    ]

    for (const [kind, foreignId, action] of cases) {
      const foreign = await guardPhiAccess({ kind: 'patient', userId: 'fi-user-a' }, { kind, id: foreignId } as PhiTarget, action)
      const nonexistent = await guardPhiAccess({ kind: 'patient', userId: 'fi-user-a' }, { kind, id: 'fi-does-not-exist' } as PhiTarget, action)
      expect(foreign).toEqual({ ok: false, status: 404 })
      expect(nonexistent).toEqual({ ok: false, status: 404 })
      expect(foreign).toEqual(nonexistent)
    }
  })
})

describe('AC: a preliminary report is 404 for its own patient and allowed for the visit\'s provider and for admin', () => {
  test('preliminaryReportFourOhFourForPatientAllowedForProviderAndAdmin', async function preliminaryReportFourOhFourForPatientAllowedForProviderAndAdmin() {
    const patient = seedPatient({ id: 'pr-patient', user_id: 'pr-user' })
    const provider = seedProvider({ id: 'pr-prov', user_id: 'pr-user-prov' })
    const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
    const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })
    const report = seedReport({ study_id: study.id, patient_id: patient.id, status: 'preliminary' })

    const patientResult = await guardPhiAccess({ kind: 'patient', userId: 'pr-user' }, { kind: 'report', id: report.id }, 'report.view')
    expect(patientResult).toEqual({ ok: false, status: 404 })

    const providerResult = await guardPhiAccess({ kind: 'provider', userId: 'pr-user-prov' }, { kind: 'report', id: report.id }, 'report.view')
    expect(providerResult).toEqual({ ok: true, patientId: patient.id })

    seedAdmin({ user_id: 'pr-admin' })
    const adminResult = await guardPhiAccess({ kind: 'admin', userId: 'pr-admin' }, { kind: 'report', id: report.id }, 'report.view')
    expect(adminResult).toEqual({ ok: true, patientId: patient.id })
  })
})

describe("AC: {kind:'schedule'} and {kind:'audit_log'} return ok with patientId null for their legal actors", () => {
  test('scheduleAndAuditLogReturnOkWithNullPatientIdForLegalActors', async function scheduleAndAuditLogReturnOkWithNullPatientIdForLegalActors() {
    const provider = seedProvider({ id: 'sa-prov', user_id: 'sa-user-prov' })

    const ownSchedule = await guardPhiAccess({ kind: 'provider', userId: 'sa-user-prov' }, { kind: 'schedule', id: provider.id }, 'schedule.view')
    expect(ownSchedule).toEqual({ ok: true, patientId: null })

    seedAdmin({ user_id: 'sa-admin' })
    const adminSchedule = await guardPhiAccess({ kind: 'admin', userId: 'sa-admin' }, { kind: 'schedule', id: provider.id }, 'schedule.view')
    expect(adminSchedule).toEqual({ ok: true, patientId: null })

    const adminAuditLog = await guardPhiAccess({ kind: 'admin', userId: 'sa-admin' }, { kind: 'audit_log' }, 'audit.view')
    expect(adminAuditLog).toEqual({ ok: true, patientId: null })
  })
})

describe("AC: {kind:'collection'} with a linked patient actor returns ok for each of the four `of` values", () => {
  test('collectionWithLinkedPatientReturnsOkForAllFourOfValues', async function collectionWithLinkedPatientReturnsOkForAllFourOfValues() {
    const patient = seedPatient({ id: 'cw-patient', user_id: 'cw-user' })
    const cases: Array<['study' | 'report' | 'appointment' | 'share', AuditAction]> = [
      ['study', 'study.view'],
      ['report', 'report.view'],
      ['appointment', 'appointment.view'],
      ['share', 'share.view'],
    ]
    for (const [of, action] of cases) {
      const result = await guardPhiAccess({ kind: 'patient', userId: 'cw-user' }, { kind: 'collection', of }, action)
      expect(result).toEqual({ ok: true, patientId: patient.id })
    }
  })
})

describe('AC: a collection call writes exactly one audit row whether the list has 0, 1 or 50 rows', () => {
  test('collectionWritesExactlyOneRowRegardlessOfListSize', async function collectionWritesExactlyOneRowRegardlessOfListSize() {
    seedPatient({ id: 'cl-empty', user_id: 'cl-user-empty' })
    const beforeEmpty = auditCalls.length
    await guardPhiAccess({ kind: 'patient', userId: 'cl-user-empty' }, { kind: 'collection', of: 'study' }, 'study.view')
    expect(auditCalls.length).toBe(beforeEmpty + 1)

    const patientOne = seedPatient({ id: 'cl-one', user_id: 'cl-user-one' })
    const providerOne = seedProvider({ id: 'cl-prov-one', user_id: 'cl-user-prov-one' })
    const visitOne = seedVisit({ patient_id: patientOne.id, provider_id: providerOne.id })
    seedStudy({ visit_id: visitOne.id, patient_id: patientOne.id })
    const beforeOne = auditCalls.length
    await guardPhiAccess({ kind: 'patient', userId: 'cl-user-one' }, { kind: 'collection', of: 'study' }, 'study.view')
    expect(auditCalls.length).toBe(beforeOne + 1)

    const patientFifty = seedPatient({ id: 'cl-fifty', user_id: 'cl-user-fifty' })
    const providerFifty = seedProvider({ id: 'cl-prov-fifty', user_id: 'cl-user-prov-fifty' })
    for (let i = 0; i < 50; i++) {
      const visit = seedVisit({ patient_id: patientFifty.id, provider_id: providerFifty.id })
      seedStudy({ visit_id: visit.id, patient_id: patientFifty.id })
    }
    const beforeFifty = auditCalls.length
    const result = await guardPhiAccess({ kind: 'patient', userId: 'cl-user-fifty' }, { kind: 'collection', of: 'study' }, 'study.view')
    expect(auditCalls.length).toBe(beforeFifty + 1)
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ targetKind: 'study_list', targetId: null })
    expect(result).toEqual({ ok: true, patientId: patientFifty.id })
  })
})

describe("AC: a collection read's recorded action is the *.view action of that kind", () => {
  test('collectionRecordedActionMatchesViewActionOfKind', async function collectionRecordedActionMatchesViewActionOfKind() {
    const patient = seedPatient({ id: 'ca-patient', user_id: 'ca-user' })
    void patient
    const cases: Array<['study' | 'report' | 'appointment' | 'share', AuditAction]> = [
      ['study', 'study.view'],
      ['report', 'report.view'],
      ['appointment', 'appointment.view'],
      ['share', 'share.view'],
    ]
    for (const [of, action] of cases) {
      await guardPhiAccess({ kind: 'patient', userId: 'ca-user' }, { kind: 'collection', of }, action)
      expect(auditCalls[auditCalls.length - 1]).toMatchObject({ action })
    }

    await guardPhiAccess({ kind: 'patient', userId: 'ca-user' }, { kind: 'collection', of: 'report' }, 'study.view')
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ action: 'report.view' })
  })
})

describe('SEC-5: ownership checks select only the columns they need', () => {
  test('ownershipQueriesNeverSelectStar', async function ownershipQueriesNeverSelectStar() {
    const patient = seedPatient({ id: 'minimum-patient', user_id: 'minimum-user' })
    const provider = seedProvider({ id: 'minimum-provider', user_id: 'minimum-provider-user' })
    const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
    const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })
    const image = seedImage({ study_id: study.id, patient_id: patient.id })

    await guardPhiAccess({ kind: 'patient', userId: 'minimum-user' }, { kind: 'image', id: image.id }, 'image.view')

    expect(selectedColumns.length).toBeGreaterThan(0)
    expect(selectedColumns.map(({ columns }) => columns)).not.toContain('*')
  })
})

describe('dependency failures are not reported as authentication failures', () => {
  test('ownershipReadFailureAuditsThenThrowsSanitizedDependencyError', async function ownershipReadFailureAuditsThenThrowsSanitizedDependencyError() {
    setReadFailureTable('patients')

    await expect(
      guardPhiAccess({ kind: 'patient', userId: 'dependency-user' }, { kind: 'collection', of: 'study' }, 'study.view'),
    ).rejects.toThrow('guardPhiAccess: authorization dependency unavailable')

    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({ actorKind: 'account', actorRef: 'dependency-user', outcome: 'denied' })
  })

  test.each(['throw', 'dependency-error'] as const)(
    'authenticationDependencyFailureAuditsThenThrowsSanitizedError: %s',
    async function authenticationDependencyFailureAuditsThenThrowsSanitizedError(mode) {
      setAuthFailureMode(mode)

      await expect(
        guardPhiAccess({ kind: 'patient', userId: 'auth-dependency-user' }, { kind: 'collection', of: 'study' }, 'study.view'),
      ).rejects.toThrow('guardPhiAccess: authorization dependency unavailable')

      expect(auditCalls).toHaveLength(1)
      expect(auditCalls[0]).toMatchObject({ actorKind: 'account', actorRef: null, outcome: 'denied' })
    },
  )
})

describe('AC: a collection grant returns no rows of its own', () => {
  test('collectionGrantReturnsNoRowsOfItsOwn', async function collectionGrantReturnsNoRowsOfItsOwn() {
    const patient = seedPatient({ id: 'cg-patient', user_id: 'cg-user' })
    const result = await guardPhiAccess({ kind: 'patient', userId: 'cg-user' }, { kind: 'collection', of: 'report' }, 'report.view')
    expect(result).toEqual({ ok: true, patientId: patient.id })
    expect(Object.keys(result).sort()).toEqual(['ok', 'patientId'])
  })
})

describe('AC: unlinked patient or no session on a collection are rejected the same as on a detail target', () => {
  test('unlinkedOrNoSessionOnCollectionRejected', async function unlinkedOrNoSessionOnCollectionRejected() {
    const unlinked = await guardPhiAccess({ kind: 'patient', userId: 'uc-never-linked' }, { kind: 'collection', of: 'appointment' }, 'appointment.view')
    expect(unlinked).toEqual({ ok: false, status: 403 })

    setCallerHasSession(false)
    const noSession = await guardPhiAccess({ kind: 'patient', userId: 'uc-someone' }, { kind: 'collection', of: 'appointment' }, 'appointment.view')
    expect(noSession).toEqual({ ok: false, status: 401 })
    setCallerHasSession(true)
  })
})

describe('AC: exactly one audit_events row is appended per call, counted across the whole table', () => {
  test('exactlyOneAuditRowPerCallCountedAcrossWholeTable', async function exactlyOneAuditRowPerCallCountedAcrossWholeTable() {
    const patient = seedPatient({ id: 'ea-patient', user_id: 'ea-user' })
    const provider = seedProvider({ id: 'ea-prov', user_id: 'ea-user-prov' })
    const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
    const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })

    const scenarios: Array<[Actor, PhiTarget, AuditAction]> = [
      [{ kind: 'patient', userId: 'ea-user' }, { kind: 'study', id: study.id }, 'study.view'],
      [{ kind: 'patient', userId: 'ea-never-linked' }, { kind: 'study', id: study.id }, 'study.view'],
      [{ kind: 'patient', userId: 'ea-user' }, { kind: 'study', id: 'ea-nonexistent' }, 'study.view'],
      [{ kind: 'patient', userId: 'ea-user' }, { kind: 'collection', of: 'study' }, 'study.view'],
    ]

    for (const [actor, target, action] of scenarios) {
      const before = auditCalls.length
      await guardPhiAccess(actor, target, action)
      expect(auditCalls.length).toBe(before + 1)
    }
  })
})

describe("AC: guard.ts's exported signature and types match ARCHITECTURE.md §5", () => {
  test('signatureAndExportedTypesMatchCurrentArchitecture', function signatureAndExportedTypesMatchCurrentArchitecture() {
    const source = readFileSync(path.join(REPO_ROOT, 'lib', 'access', 'guard.ts'), 'utf8')
    expect(source).toContain(
      `export type Actor =
  | { kind: 'patient'; userId: string }
  | { kind: 'provider'; userId: string }
  | { kind: 'admin'; userId: string }
  | { kind: 'share_recipient'; shareLinkId: string }
  | { kind: 'anonymous' }`,
    )
    expect(source).toContain(
      `export type PhiTarget =
  | { kind: 'study'; id: string }
  | { kind: 'image'; id: string }
  | { kind: 'clip'; id: string }
  | { kind: 'report'; id: string }
  | { kind: 'appointment'; id: string }
  | { kind: 'patient'; id: string | null }
  | { kind: 'schedule'; id: string } // id = provider id
  | { kind: 'share_link'; id: string | null } // null = unresolved share token
  | { kind: 'collection'; of: 'study' | 'report' | 'appointment' | 'share' }
  | { kind: 'audit_log' } // no id — the whole log, admin only`,
    )
    expect(source).toContain(
      'export type GuardResult = { ok: true; patientId: string | null } | { ok: false; status: 401 | 403 | 404 }',
    )
    expect(source).toContain(`export async function guardPhiAccess(
  actor: Actor,
  target: PhiTarget,
  action: AuditAction,
  options: { grantedAudit: 'transactional-rpc' } | undefined = undefined,
): Promise<GuardResult> {`)
    expect(source).toContain('export async function authenticatePhiRequest(): Promise<PhiRequestAuthentication> {')
    expect(source).toContain(`export async function guardAuthenticatedPhiAccess(
  actor: Actor,
  target: PhiTarget,
  action: AuditAction,
  authentication: PhiRequestAuthentication,
  options: { grantedAudit: 'transactional-rpc' } | undefined = undefined,
): Promise<GuardResult> {`)
  })
})

describe('transactional PHI audit handoff', () => {
  test('ownedPatientTargetDefersGrantButForeignTargetRequiresOneDeniedAudit', async () => {
    seedPatient({ id: 'profile-patient-a', user_id: 'profile-user-a' })
    seedPatient({ id: 'profile-patient-b', user_id: 'profile-user-b' })
    setSessionUserId('profile-user-a')
    const authentication = await authenticatePhiRequest()

    const own = await guardAuthenticatedPhiAccess(
      { kind: 'patient', userId: 'profile-user-a' },
      { kind: 'patient', id: null },
      'profile.deletion_request',
      authentication,
      { grantedAudit: 'transactional-rpc' },
    )
    expect(own).toEqual({ ok: true, patientId: 'profile-patient-a' })
    expect(auditCalls).toHaveLength(0)

    const foreign = await guardPhiAccessRaw(
      { kind: 'patient', userId: 'profile-user-a' },
      { kind: 'patient', id: 'profile-patient-b' },
      'profile.deletion_request',
      { grantedAudit: 'transactional-rpc' },
    )
    expect(foreign).toEqual({ ok: false, status: 404 })
    expect(auditCalls).toEqual([
      expect.objectContaining({
        actorRef: 'profile-user-a',
        action: 'profile.deletion_request',
        targetKind: 'patient',
        targetId: 'profile-patient-b',
        outcome: 'denied',
      }),
    ])
    expect(recordRequiredPhiAccessDecisionMock).toHaveBeenCalledTimes(1)
  })
})

describe("mandatory adversarial: patient naming another patient's studyId", () => {
  test('patientNamingAnotherPatientsStudyIdReturnsFourOhFourIdenticalToRandomUuid', async function patientNamingAnotherPatientsStudyIdReturnsFourOhFourIdenticalToRandomUuid() {
    seedPatient({ id: 'm1-pa', user_id: 'm1-user-a' })
    const patientB = seedPatient({ id: 'm1-pb', user_id: 'm1-user-b' })
    const provider = seedProvider({ id: 'm1-prov', user_id: 'm1-user-prov' })
    const visitB = seedVisit({ patient_id: patientB.id, provider_id: provider.id })
    const studyB = seedStudy({ visit_id: visitB.id, patient_id: patientB.id })

    const foreignResult = await guardPhiAccess({ kind: 'patient', userId: 'm1-user-a' }, { kind: 'study', id: studyB.id }, 'study.view')
    const randomUuidResult = await guardPhiAccess(
      { kind: 'patient', userId: 'm1-user-a' },
      { kind: 'study', id: '11111111-1111-1111-1111-111111111111' },
      'study.view',
    )
    expect(foreignResult).toEqual({ ok: false, status: 404 })
    expect(foreignResult).toEqual(randomUuidResult)
  })
})

describe("mandatory adversarial: patient naming another patient's imageId, clipId, reportId, appointmentId", () => {
  test('patientNamingAnotherPatientsImageClipReportAppointmentReturnsFourOhFourEach', async function patientNamingAnotherPatientsImageClipReportAppointmentReturnsFourOhFourEach() {
    seedPatient({ id: 'm2-pa', user_id: 'm2-user-a' })
    const patientB = seedPatient({ id: 'm2-pb', user_id: 'm2-user-b' })
    const provider = seedProvider({ id: 'm2-prov', user_id: 'm2-user-prov' })
    const visitB = seedVisit({ patient_id: patientB.id, provider_id: provider.id })
    const studyB = seedStudy({ visit_id: visitB.id, patient_id: patientB.id })
    const imageB = seedImage({ study_id: studyB.id, patient_id: patientB.id })
    const clipB = seedClip({ study_id: studyB.id, patient_id: patientB.id })
    const reportB = seedReport({ study_id: studyB.id, patient_id: patientB.id, status: 'signed' })
    const apptB = seedAppointment({ patient_id: patientB.id, provider_id: provider.id })

    const cases: Array<[PhiTarget, AuditAction]> = [
      [{ kind: 'image', id: imageB.id }, 'image.view'],
      [{ kind: 'clip', id: clipB.id }, 'clip.view'],
      [{ kind: 'report', id: reportB.id }, 'report.view'],
      [{ kind: 'appointment', id: apptB.id }, 'appointment.view'],
    ]
    for (const [target, action] of cases) {
      const result = await guardPhiAccess({ kind: 'patient', userId: 'm2-user-a' }, target, action)
      expect(result).toEqual({ ok: false, status: 404 })
    }
  })
})

describe("mandatory adversarial: provider naming a study belonging to another provider's visit", () => {
  test('providerNamingStudyFromAnotherProvidersVisitReturnsFourOhFour', async function providerNamingStudyFromAnotherProvidersVisitReturnsFourOhFour() {
    const patient = seedPatient({ id: 'm3-patient', user_id: 'm3-user-patient' })
    const providerA = seedProvider({ id: 'm3-prov-a', user_id: 'm3-user-prov-a' })
    seedProvider({ id: 'm3-prov-b', user_id: 'm3-user-prov-b' })
    const visit = seedVisit({ patient_id: patient.id, provider_id: providerA.id })
    const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })

    const result = await guardPhiAccess({ kind: 'provider', userId: 'm3-user-prov-b' }, { kind: 'study', id: study.id }, 'study.view')
    expect(result).toEqual({ ok: false, status: 404 })
  })
})

describe("mandatory adversarial: provider naming {kind:'schedule'} for another provider's id", () => {
  test('providerNamingAnotherProvidersScheduleReturnsFourOhFour', async function providerNamingAnotherProvidersScheduleReturnsFourOhFour() {
    seedProvider({ id: 'm4-prov-a', user_id: 'm4-user-prov-a' })
    const providerB = seedProvider({ id: 'm4-prov-b', user_id: 'm4-user-prov-b' })
    const result = await guardPhiAccess({ kind: 'provider', userId: 'm4-user-prov-a' }, { kind: 'schedule', id: providerB.id }, 'schedule.view')
    expect(result).toEqual({ ok: false, status: 404 })
  })
})

describe('mandatory adversarial: patient naming their own preliminary report', () => {
  test('patientNamingOwnPreliminaryReportReturnsFourOhFourNeverFourOhThree', async function patientNamingOwnPreliminaryReportReturnsFourOhFourNeverFourOhThree() {
    const patient = seedPatient({ id: 'm5-patient', user_id: 'm5-user' })
    const provider = seedProvider({ id: 'm5-prov', user_id: 'm5-user-prov' })
    const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
    const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })
    const report = seedReport({ study_id: study.id, patient_id: patient.id, status: 'preliminary' })

    const result = await guardPhiAccess({ kind: 'patient', userId: 'm5-user' }, { kind: 'report', id: report.id }, 'report.view')
    expect(result).toEqual({ ok: false, status: 404 })
    expect(result).not.toEqual({ ok: false, status: 403 })
  })
})

describe('mandatory adversarial: a patient linked to a different patient reaches this target', () => {
  test('patientLinkedToDifferentPatientReachingTargetReturnsFourOhFour', async function patientLinkedToDifferentPatientReachingTargetReturnsFourOhFour() {
    seedPatient({ id: 'm6-self', user_id: 'm6-user' })
    const otherPatient = seedPatient({ id: 'm6-other', user_id: 'm6-other-user' })
    const provider = seedProvider({ id: 'm6-prov', user_id: 'm6-user-prov' })
    const appt = seedAppointment({ patient_id: otherPatient.id, provider_id: provider.id })

    const result = await guardPhiAccess({ kind: 'patient', userId: 'm6-user' }, { kind: 'appointment', id: appt.id }, 'appointment.view')
    expect(result).toEqual({ ok: false, status: 404 })
  })
})

describe('mandatory adversarial: a patient who has never linked', () => {
  test('patientNeverLinkedReturnsFourOhThreeNotTwoHundredNotFourOhFour', async function patientNeverLinkedReturnsFourOhThreeNotTwoHundredNotFourOhFour() {
    const result = await guardPhiAccess({ kind: 'patient', userId: 'm7-never-linked' }, { kind: 'collection', of: 'study' }, 'study.view')
    expect(result).toEqual({ ok: false, status: 403 })
  })
})

describe('mandatory adversarial: a linked patient row deleted underneath the caller', () => {
  test('patientWhoseLinkedPatientRowDeletedUnderneathThemRejectedNeverFiveHundred', async function patientWhoseLinkedPatientRowDeletedUnderneathThemRejectedNeverFiveHundred() {
    const patient = seedPatient({ id: 'm8-patient', user_id: 'm8-user' })
    const index = db.patients!.indexOf(patient)
    db.patients!.splice(index, 1)

    const result = await guardPhiAccess({ kind: 'patient', userId: 'm8-user' }, { kind: 'study', id: 'm8-study' }, 'study.view')
    expect(result).toEqual({ ok: false, status: 403 })
  })
})

describe('mandatory adversarial: share_recipient naming any resource other than the one its share link names', () => {
  test('shareRecipientNamingResourceOtherThanItsShareLinkNamesReturnsFourOhFour', async function shareRecipientNamingResourceOtherThanItsShareLinkNamesReturnsFourOhFour() {
    const patient = seedPatient({ id: 'm9-patient', user_id: 'm9-user' })
    const provider = seedProvider({ id: 'm9-prov', user_id: 'm9-user-prov' })
    const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
    const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })
    const namedImage = seedImage({ study_id: study.id, patient_id: patient.id })
    const otherImage = seedImage({ study_id: study.id, patient_id: patient.id })
    seedShareLink({ id: 'm9-share', patient_id: patient.id, image_id: namedImage.id })

    const result = await guardPhiAccess({ kind: 'share_recipient', shareLinkId: 'm9-share' }, { kind: 'image', id: otherImage.id }, 'image.view')
    expect(result).toEqual({ ok: false, status: 404 })
  })
})

describe('mandatory adversarial: patient share-link revocation ownership', () => {
  test('patientShareLinkOwnershipGrantsOwnedAndDeniesForeignOrMissingWithOneAuditEach', async function patientShareLinkOwnershipGrantsOwnedAndDeniesForeignOrMissingWithOneAuditEach() {
    const patient = seedPatient({ id: 'revoke-patient', user_id: 'revoke-user' })
    const otherPatient = seedPatient({ id: 'revoke-other-patient', user_id: 'revoke-other-user' })
    const owned = seedShareLink({ id: 'revoke-owned', patient_id: patient.id })
    const foreign = seedShareLink({ id: 'revoke-foreign', patient_id: otherPatient.id })
    const target = (id: string): PhiTarget => ({ kind: 'share_link', id })

    const results = [
      await guardPhiAccess({ kind: 'patient', userId: 'revoke-user' }, target(owned.id), 'share.revoke'),
      await guardPhiAccess({ kind: 'patient', userId: 'revoke-user' }, target(foreign.id), 'share.revoke'),
      await guardPhiAccess({ kind: 'patient', userId: 'revoke-user' }, target('revoke-missing'), 'share.revoke'),
    ]

    expect(results).toEqual([
      { ok: true, patientId: patient.id },
      { ok: false, status: 404 },
      { ok: false, status: 404 },
    ])
    expect(auditCalls).toEqual([
      expect.objectContaining({ action: 'share.revoke', targetKind: 'share_link', targetId: owned.id, outcome: 'granted' }),
      expect.objectContaining({ action: 'share.revoke', targetKind: 'share_link', targetId: foreign.id, outcome: 'denied' }),
      expect.objectContaining({ action: 'share.revoke', targetKind: 'share_link', targetId: 'revoke-missing', outcome: 'denied' }),
    ])
    expect(serviceClientMock).not.toHaveBeenCalled()
  })
})

describe('mandatory adversarial: a list read over a seeded 50-item list writes exactly one audit row', () => {
  test('collectionOverFiftyItemListWritesExactlyOneAuditRow', async function collectionOverFiftyItemListWritesExactlyOneAuditRow() {
    const patient = seedPatient({ id: 'm10-patient', user_id: 'm10-user' })
    const provider = seedProvider({ id: 'm10-prov', user_id: 'm10-user-prov' })
    for (let i = 0; i < 50; i++) {
      const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
      seedStudy({ visit_id: visit.id, patient_id: patient.id })
    }
    const before = auditCalls.length
    const result = await guardPhiAccess({ kind: 'patient', userId: 'm10-user' }, { kind: 'collection', of: 'study' }, 'study.view')
    expect(result).toEqual({ ok: true, patientId: patient.id })
    expect(auditCalls.length).toBe(before + 1)
  })
})

describe('mandatory adversarial: a collection audit row with a non-null target_id or the wrong target_kind', () => {
  test('collectionAuditRowNonNullTargetIdOrWrongTargetKindRejected', async function collectionAuditRowNonNullTargetIdOrWrongTargetKindRejected() {
    seedPatient({ id: 'm11-patient', user_id: 'm11-user' })
    await guardPhiAccess({ kind: 'patient', userId: 'm11-user' }, { kind: 'collection', of: 'appointment' }, 'appointment.view')
    const row = auditCalls[auditCalls.length - 1]
    expect(row).toMatchObject({ targetId: null, targetKind: 'appointment_list' })
    expect(row!.targetId).not.toBe('appointment')
    expect(row!.targetKind).not.toBe('appointment')
  })
})

describe('mandatory adversarial: an unlinked account reaching a collection', () => {
  test('unlinkedAccountReachingCollectionReturnsFourOhThreeNotOkNotEmptyList', async function unlinkedAccountReachingCollectionReturnsFourOhThreeNotOkNotEmptyList() {
    const result = await guardPhiAccess({ kind: 'patient', userId: 'm12-never-linked' }, { kind: 'collection', of: 'share' }, 'share.view')
    expect(result).toEqual({ ok: false, status: 403 })
    // Never { ok: true, ... } with an attached (empty) list — GuardResult has
    // no row-carrying shape at all, so "empty list" is not a distinct case.
  })
})

describe("mandatory adversarial: a collection grant never returns another patient's rows", () => {
  test('collectionGrantNeverReturnsAnotherPatientsRows', async function collectionGrantNeverReturnsAnotherPatientsRows() {
    const patientA = seedPatient({ id: 'm13-pa', user_id: 'm13-user-a' })
    const patientB = seedPatient({ id: 'm13-pb', user_id: 'm13-user-b' })

    const resultA = await guardPhiAccess({ kind: 'patient', userId: 'm13-user-a' }, { kind: 'collection', of: 'study' }, 'study.view')
    const resultB = await guardPhiAccess({ kind: 'patient', userId: 'm13-user-b' }, { kind: 'collection', of: 'study' }, 'study.view')

    expect(expectOk(resultA).patientId).toBe(patientA.id)
    expect(expectOk(resultB).patientId).toBe(patientB.id)
    expect(expectOk(resultA).patientId).not.toBe(expectOk(resultB).patientId)
    // Rows themselves stay scoped by RLS (§4) — the grant carries no row
    // data at all for either caller to leak.
    expect(Object.keys(resultA).sort()).toEqual(['ok', 'patientId'])
    expect(Object.keys(resultB).sort()).toEqual(['ok', 'patientId'])
  })
})

describe('mandatory adversarial: a guarded call producing zero or two audit rows', () => {
  test('guardedCallProducingZeroOrTwoAuditRowsRejected', async function guardedCallProducingZeroOrTwoAuditRowsRejected() {
    setCallerHasSession(false)
    const beforeDenied = auditCalls.length
    await guardPhiAccess({ kind: 'patient', userId: 'm14-nosession' }, { kind: 'study', id: 'm14-study' }, 'study.view')
    expect(auditCalls.length).toBe(beforeDenied + 1)
    expect(auditCalls.length).not.toBe(beforeDenied)
    expect(auditCalls.length).not.toBe(beforeDenied + 2)
    setCallerHasSession(true)

    seedPatient({ id: 'm14-patient', user_id: 'm14-user' })
    const beforeGranted = auditCalls.length
    await guardPhiAccess({ kind: 'patient', userId: 'm14-user' }, { kind: 'collection', of: 'study' }, 'study.view')
    expect(auditCalls.length).toBe(beforeGranted + 1)
    expect(auditCalls.length).not.toBe(beforeGranted)
    expect(auditCalls.length).not.toBe(beforeGranted + 2)
  })
})

describe('mandatory adversarial: expired session JWT', () => {
  test('expiredSessionJwtReturnsFourOhOne', async function expiredSessionJwtReturnsFourOhOne() {
    setSessionTokenValid(false)
    const result = await guardPhiAccess({ kind: 'patient', userId: 'm15-user' }, { kind: 'study', id: 'm15-study' }, 'study.view')
    expect(result).toEqual({ ok: false, status: 401 })
    setSessionTokenValid(true)
  })
})

describe('mandatory adversarial: a patient actor cannot claim a different authenticated account', () => {
  test(
    'patientActorMismatchReturnsFourOhOneWithoutClaimedIdentityLookup',
    async function patientActorMismatchReturnsFourOhOneWithoutClaimedIdentityLookup() {
      const authenticatedUserId = 'm16-authenticated-user'
      const claimedUserId = 'm16-spoofed-patient-user'
      const patient = seedPatient({ id: 'm16-patient', user_id: claimedUserId })
      const provider = seedProvider({ id: 'm16-provider', user_id: 'm16-provider-user' })
      const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
      const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })
      setSessionUserId(authenticatedUserId)

      const result = await guardPhiAccessRaw({ kind: 'patient', userId: claimedUserId }, { kind: 'study', id: study.id }, 'study.view')

      expect(result).toEqual({ ok: false, status: 401 })
      expect(anonClientMock).not.toHaveBeenCalled()
      expect(auditCalls).toHaveLength(1)
      expect(auditCalls[0]).toMatchObject({ actorKind: 'account', actorRef: authenticatedUserId, outcome: 'denied' })
      expect(auditCalls[0]!.actorRef).not.toBe(claimedUserId)
    },
  )
})

describe('mandatory adversarial: a provider actor cannot claim a different authenticated account', () => {
  test(
    'providerActorMismatchReturnsFourOhOneWithoutClaimedIdentityLookup',
    async function providerActorMismatchReturnsFourOhOneWithoutClaimedIdentityLookup() {
      const authenticatedUserId = 'm17-authenticated-user'
      const claimedUserId = 'm17-spoofed-provider-user'
      const patient = seedPatient({ id: 'm17-patient', user_id: 'm17-patient-user' })
      const provider = seedProvider({ id: 'm17-provider', user_id: claimedUserId })
      const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
      const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })
      setSessionUserId(authenticatedUserId)

      const result = await guardPhiAccessRaw({ kind: 'provider', userId: claimedUserId }, { kind: 'study', id: study.id }, 'study.view')

      expect(result).toEqual({ ok: false, status: 401 })
      expect(anonClientMock).not.toHaveBeenCalled()
      expect(auditCalls).toHaveLength(1)
      expect(auditCalls[0]).toMatchObject({ actorKind: 'account', actorRef: authenticatedUserId, outcome: 'denied' })
      expect(auditCalls[0]!.actorRef).not.toBe(claimedUserId)
    },
  )
})

describe('mandatory adversarial: an admin actor cannot claim a different authenticated account', () => {
  test('adminActorMismatchReturnsFourOhOneWithoutTargetLookup', async function adminActorMismatchReturnsFourOhOneWithoutTargetLookup() {
    const authenticatedUserId = 'm18-authenticated-user'
    const claimedUserId = 'm18-spoofed-admin-user'
    const patient = seedPatient({ id: 'm18-patient', user_id: 'm18-patient-user' })
    const provider = seedProvider({ id: 'm18-provider', user_id: 'm18-provider-user' })
    const visit = seedVisit({ patient_id: patient.id, provider_id: provider.id })
    const study = seedStudy({ visit_id: visit.id, patient_id: patient.id })
    setSessionUserId(authenticatedUserId)

    const result = await guardPhiAccessRaw({ kind: 'admin', userId: claimedUserId }, { kind: 'study', id: study.id }, 'study.view')

    expect(result).toEqual({ ok: false, status: 401 })
    expect(anonClientMock).not.toHaveBeenCalled()
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({ actorKind: 'account', actorRef: authenticatedUserId, outcome: 'denied' })
    expect(auditCalls[0]!.actorRef).not.toBe(claimedUserId)
  })
})

describe('mandatory adversarial: an authenticated patient account cannot claim the provider role', () => {
  test('patientAccountCannotClaimProviderRoleForCollection', async function patientAccountCannotClaimProviderRoleForCollection() {
    const patientUserId = 'm19-patient-user'
    seedPatient({ id: 'm19-patient', user_id: patientUserId })

    const result = await guardPhiAccess({ kind: 'provider', userId: patientUserId }, { kind: 'collection', of: 'study' }, 'study.view')

    expect(result).toEqual({ ok: false, status: 404 })
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({ actorKind: 'account', actorRef: patientUserId, outcome: 'denied' })
  })
})

describe('mandatory adversarial: an authenticated patient account cannot claim the admin role', () => {
  test('patientAccountCannotClaimAdminRoleForCollectionOrAuditLog', async function patientAccountCannotClaimAdminRoleForCollectionOrAuditLog() {
    const patientUserId = 'm20-patient-user'
    seedPatient({ id: 'm20-patient', user_id: patientUserId })

    const targets: Array<[PhiTarget, AuditAction]> = [
      [{ kind: 'collection', of: 'report' }, 'report.view'],
      [{ kind: 'audit_log' }, 'audit.view'],
    ]

    for (const [target, action] of targets) {
      const before = auditCalls.length
      const result = await guardPhiAccess({ kind: 'admin', userId: patientUserId }, target, action)

      expect(result).toEqual({ ok: false, status: 404 })
      expect(auditCalls).toHaveLength(before + 1)
      expect(auditCalls[before]).toMatchObject({ actorKind: 'account', actorRef: patientUserId, outcome: 'denied' })
    }
  })
})

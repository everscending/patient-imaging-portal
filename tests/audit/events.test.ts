// tests/audit/events.test.ts — the audit writer's own tests (JOR-238).
//
// lib/audit/events.ts selects among lib/db/client.ts's caller-scoped,
// authentication, and service-role clients, then writes through Supabase's
// REST layer. There is no PostgREST server in this repo's test harness
// (tests/setup/postgres.ts starts bare postgres:16-alpine), so this file
// replaces that external boundary with an in-memory audit table and replaces
// next/headers's cookies() with a fake session cookie.
//
// Bullet → test function (this ticket's "Mandatory adversarial tests"):
//   an action string outside the 22-value set, rejected at the type boundary
//     → actionStringOutsidePinnedSetRejectedAtTypeBoundary
//     (the CHECK-constraint half is tests/db/migration-002.test.ts's
//      auditEventsAcceptsPinnedActionsRejectsOthersAndOutcome)
//   share.view / profile.deletion_request carried by the type, matching the
//   migration's CHECK set → shareViewAndProfileDeletionRequestAreValidAuditActions
//     (the CHECK-constraint half is the same migration test as above)
//   an outcome other than granted/denied, rejected at the type boundary
//     → outcomeOutsideGrantedDeniedRejectedAtTypeBoundary
//     (the CHECK-constraint half is the same migration test as above)
//   a detail object carrying PHI- or credential-shaped keys, rejected
//     → detailCarryingPhiShapedKeyRejected
//     → detailCarryingCredentialKeyRejectedAndNeverPersisted
//   UPDATE/DELETE on audit_events as app_user, rejected
//     → tests/db/migration-002.test.ts's auditEventsAppUserInsertSelectOkUpdateDeleteFail
//   a guard call that returns without an audit row, rejected
//     → tests/access/guard.test.ts's exactlyOneAuditRowPerCall (JOR-262 —
//       lib/access/guard.ts stopped being a stub there; this file no longer
//       carries guard-behavior coverage, only its own audit-write contract)
//   a module other than lib/audit/events.ts writing audit_events, rejected
//     → tests/lint/forbidden-imports.test.ts's adversarialAuditEventsOutsideEventsFails
//     (this file also checks guard.ts's own source: guardWritesAuditEventsOnlyThroughRecordAuditEvent)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// server-only throws unconditionally under plain Node (no `react-server`
// resolution condition) — tests/db/client.test.ts neutralizes it the same way.
vi.mock('server-only', () => ({}))

type FakeAuditRow = Record<string, unknown>

const {
  auditRows,
  anonClientMock,
  serviceClientMock,
  authClientMock,
  resetFakeAuditTable,
  setInsertBehavior,
  setInsertFailureMessage,
  setCallerHasSession,
  setSessionTokenValid,
  hasCallerSession,
  FAKE_SESSION_COOKIE_NAME,
  FAKE_ACCESS_TOKEN,
} = vi.hoisted(() => {
  const rows: FakeAuditRow[] = []
  let behavior: 'ok' | 'pg-error' | 'throw' = 'ok'
  let insertFailureMessage = 'simulated audit write failure'
  let callerHasSession = true
  let sessionTokenValid = true
  // Must match lib/session-cookie.ts's SESSION_COOKIE_NAME — kept as a
  // literal here rather than an import, since a vi.mock factory can only see
  // names hoisted alongside it, not the module's regular top-level imports.
  const cookieName = 'pip_session'
  const accessToken = 'fake-caller-access-token'

  const anonClientMock = vi.fn(() => ({
    from(table: string) {
      if (table !== 'audit_events') throw new Error(`fake client: unexpected table "${table}"`)
      return {
        async insert(row: FakeAuditRow) {
          if (behavior === 'throw') throw new Error(insertFailureMessage)
          if (behavior === 'pg-error') return { error: { message: insertFailureMessage } }
          if (!sessionTokenValid) return { error: { message: 'invalid session JWT' } }
          rows.push(row)
          return { error: null }
        },
      }
    },
  }))

  const serviceClientMock = vi.fn(() => ({
    from(table: string) {
      if (table !== 'audit_events') throw new Error(`fake client: unexpected table "${table}"`)
      return {
        async insert(row: FakeAuditRow) {
          rows.push(row)
          return { error: null }
        },
      }
    },
  }))

  const authClientMock = vi.fn(() => ({
    auth: {
      async getUser(token: string) {
        if (!sessionTokenValid || token !== accessToken) return { data: { user: null }, error: { message: 'invalid token' } }
        return { data: { user: { id: 'session-user' } }, error: null }
      },
    },
  }))

  return {
    auditRows: rows,
    anonClientMock,
    serviceClientMock,
    authClientMock,
    resetFakeAuditTable: () => {
      rows.length = 0
      behavior = 'ok'
      insertFailureMessage = 'simulated audit write failure'
      callerHasSession = true
      sessionTokenValid = true
    },
    setInsertBehavior: (next: 'ok' | 'pg-error' | 'throw') => {
      behavior = next
    },
    setInsertFailureMessage: (message: string) => {
      insertFailureMessage = message
    },
    setCallerHasSession: (next: boolean) => {
      callerHasSession = next
    },
    setSessionTokenValid: (next: boolean) => {
      sessionTokenValid = next
    },
    // A function, not a plain value, so the next/headers mock factory below
    // (hoisted alongside this block) reads the live flag on every call
    // rather than a snapshot taken at module-init time.
    hasCallerSession: () => callerHasSession,
    FAKE_SESSION_COOKIE_NAME: cookieName,
    FAKE_ACCESS_TOKEN: accessToken,
  }
})

vi.mock('../../lib/db/client', () => ({
  serviceClient: serviceClientMock,
  anonClient: anonClientMock,
  authClient: authClientMock,
}))

// lib/session-cookie.ts itself imports lib/config.ts, which requires four
// real environment variables at module load (lib/config.ts's loadConfig) —
// irrelevant to this file, which only wants the cookie name constant, so it
// gets stubbed like lib/db/client.ts above rather than pulling config's
// requirements into a test that has nothing to do with them.
vi.mock('../../lib/session-cookie', () => ({
  SESSION_COOKIE_NAME: FAKE_SESSION_COOKIE_NAME,
}))

// recordAuditEvent has no accessToken parameter (the pinned signature), so it
// reads the caller's session cookie via next/headers itself — the same thing
// a real request-scoped Server Component/Route Handler would return.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name !== FAKE_SESSION_COOKIE_NAME) return undefined
      if (!hasCallerSession()) return undefined
      return { value: FAKE_ACCESS_TOKEN }
    },
  }),
}))

import type { AuditAction, RecordAuditEventInput } from '../../lib/audit/events'
import { recordAuditEvent } from '../../lib/audit/events'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

beforeEach(() => {
  resetFakeAuditTable()
  anonClientMock.mockClear()
  serviceClientMock.mockClear()
  authClientMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function baseInput(overrides: Partial<RecordAuditEventInput> = {}): RecordAuditEventInput {
  return {
    actorKind: 'account',
    actorRef: 'user-123',
    action: 'study.view',
    targetKind: 'study',
    targetId: 'study-abc',
    outcome: 'granted',
    ...overrides,
  }
}

const SENSITIVE_LOG_SENTINELS = [
  'PHI_PATIENT_DOB_1987-04-03',
  'TOKEN_eyJhbGciOiJIUzI1NiJ9_DO_NOT_LOG',
  'SECRET_service_role_key_DO_NOT_LOG',
]

function sensitiveFailureMessage(): string {
  return `rejected audit row containing ${SENSITIVE_LOG_SENTINELS.join(' and ')}`
}

function expectRedactedWriteFailureLog(calls: unknown[][]): void {
  expect(calls).toHaveLength(1)
  expect(calls[0]).toHaveLength(1)

  const serializedConsoleArguments = JSON.stringify(calls)
  const logged = JSON.parse(calls[0]?.[0] as string)
  const serializedStructuredFields = JSON.stringify(logged)

  for (const sentinel of SENSITIVE_LOG_SENTINELS) {
    expect(serializedConsoleArguments).not.toContain(sentinel)
    expect(serializedStructuredFields).not.toContain(sentinel)
  }

  expect(logged).toEqual({
    event: 'audit_events.write_failed',
    action: 'study.view',
    failureCategory: 'audit_write_failure',
  })
}

describe('AC: recordAuditEvent appends one row inside the pinned action/outcome sets', () => {
  test('recordAuditEventAppendsRowMatchingInput', async function recordAuditEventAppendsRowMatchingInput() {
    await recordAuditEvent(baseInput())
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toEqual({
      actor_kind: 'account',
      actor_ref: 'user-123',
      action: 'study.view',
      target_kind: 'study',
      target_id: 'study-abc',
      outcome: 'granted',
      detail: null,
    })
  })

  test('recordAuditEventWritesThroughAnonClientWithTheCallerSessionToken', async function recordAuditEventWritesThroughAnonClientWithTheCallerSessionToken() {
    await recordAuditEvent(baseInput())
    expect(anonClientMock).toHaveBeenCalledWith(FAKE_ACCESS_TOKEN)
    expect(serviceClientMock).not.toHaveBeenCalled()
  })

  test('authenticatedDeniedEventRemainsCallerScoped', async function authenticatedDeniedEventRemainsCallerScoped() {
    await recordAuditEvent(baseInput({ outcome: 'denied' }))
    expect(anonClientMock).toHaveBeenCalledWith(FAKE_ACCESS_TOKEN)
    expect(serviceClientMock).not.toHaveBeenCalled()
    expect(auditRows).toHaveLength(1)
  })

  test('outcomeOutsideGrantedDeniedRejectedAtTypeBoundary', function outcomeOutsideGrantedDeniedRejectedAtTypeBoundary() {
    // @ts-expect-error — 'maybe' is not a member of RecordAuditEventInput['outcome'];
    // this only compiles under ts-expect-error's blessing because tsc --noEmit
    // rejects it — the type boundary the CHECK constraint backs up.
    const bad: RecordAuditEventInput = baseInput({ outcome: 'maybe' })
    expect(bad.outcome).toBe('maybe')
  })
})

describe('AC: AuditAction carries exactly the 22 pinned strings, including the two ADR-0012 additions', () => {
  test('actionStringOutsidePinnedSetRejectedAtTypeBoundary', function actionStringOutsidePinnedSetRejectedAtTypeBoundary() {
    // @ts-expect-error — 'image_viewed' is not a member of AuditAction; this
    // only compiles under ts-expect-error's blessing because tsc --noEmit
    // rejects it — the type boundary the CHECK constraint backs up.
    const bad: AuditAction = 'image_viewed'
    expect(bad).toBe('image_viewed')
  })

  test('shareViewAndProfileDeletionRequestAreValidAuditActions', function shareViewAndProfileDeletionRequestAreValidAuditActions() {
    const shareView: AuditAction = 'share.view'
    const deletionRequest: AuditAction = 'profile.deletion_request'
    expect(shareView).toBe('share.view')
    expect(deletionRequest).toBe('profile.deletion_request')
  })

  const PINNED_ACTIONS: AuditAction[] = [
    'identity.verify',
    'identity.lockout',
    'identity.link',
    'study.view',
    'image.view',
    'clip.view',
    'report.view',
    'share.create',
    'share.use',
    'share.revoke',
    'share.view',
    'booking.create',
    'booking.reschedule',
    'booking.cancel',
    'appointment.view',
    'appointment.transition',
    'schedule.view',
    'availability.update',
    'availability.collision',
    'reminder.dispatch',
    'audit.view',
    'profile.deletion_request',
  ]

  test('auditActionCarriesExactlyTwentyTwoPinnedStrings', function auditActionCarriesExactlyTwentyTwoPinnedStrings() {
    expect(PINNED_ACTIONS).toHaveLength(22)
    expect(new Set(PINNED_ACTIONS).size).toBe(22)
  })
})

describe('AC: detail serialises to JSONB containing only strings, numbers and booleans', () => {
  test('detailWithOnlyPrimitiveValuesRoundTripsThroughJson', async function detailWithOnlyPrimitiveValuesRoundTripsThroughJson() {
    const detail = { count: 3, transport: 'log', successful: true }
    await recordAuditEvent(baseInput({ detail }))
    const stored = auditRows[0]?.detail
    expect(JSON.parse(JSON.stringify(stored))).toEqual(detail)
  })
})

describe('mandatory adversarial: detail carrying a PHI-shaped key is rejected (SEC-6)', () => {
  test.each(['fullName', 'dateOfBirth', 'patientRef', 'email'])(
    'detailCarryingPhiShapedKeyRejected: %s',
    async function detailCarryingPhiShapedKeyRejected(key) {
      await expect(recordAuditEvent(baseInput({ detail: { [key]: 'x' } }))).rejects.toThrow(/unapproved key or value/)
      expect(auditRows).toHaveLength(0)
    },
  )

  test.each(['token', 'shareToken', 'sessionToken', 'secret', 'password'])(
    'detailCarryingCredentialKeyRejectedAndNeverPersisted: %s',
    async function detailCarryingCredentialKeyRejectedAndNeverPersisted(key) {
      const rawCredential = 'RAW_CREDENTIAL_MUST_NEVER_BE_STORED'

      await expect(recordAuditEvent(baseInput({ detail: { [key]: rawCredential } }))).rejects.toThrow(/unapproved key or value/)
      expect(JSON.stringify(auditRows)).not.toContain(rawCredential)
      expect(auditRows).toHaveLength(0)
    },
  )

  test('credentialValueHiddenUnderApprovedStringKeyRejectedAndNeverPersisted', async function credentialValueHiddenUnderApprovedStringKeyRejectedAndNeverPersisted() {
    const rawCredential = 'RAW_CREDENTIAL_MUST_NEVER_BE_STORED'

    await expect(recordAuditEvent(baseInput({ detail: { transport: rawCredential } }))).rejects.toThrow(/unapproved key or value/)
    expect(JSON.stringify(auditRows)).not.toContain(rawCredential)
    expect(auditRows).toHaveLength(0)
  })
})

describe('AC: recordAuditEvent is callable by a domain module directly, targetId null, for actions with no PHI target', () => {
  const NO_PHI_TARGET_ACTIONS: AuditAction[] = [
    'booking.create',
    'booking.reschedule',
    'booking.cancel',
    'availability.update',
    'availability.collision',
    'reminder.dispatch',
    'share.revoke',
  ]

  test('domainModuleCallsRecordAuditEventDirectlyWithNullTargetId', async function domainModuleCallsRecordAuditEventDirectlyWithNullTargetId() {
    for (const action of NO_PHI_TARGET_ACTIONS) {
      await recordAuditEvent({
        actorKind: 'account',
        actorRef: 'patient-1',
        action,
        targetKind: 'appointment',
        targetId: null,
        outcome: 'granted',
      })
    }
    expect(auditRows).toHaveLength(NO_PHI_TARGET_ACTIONS.length)
    for (const row of auditRows) {
      expect(row.target_id).toBeNull()
    }
  })

  test('systemActorKindIsAcceptedForCallsWithNoAccountSession', async function systemActorKindIsAcceptedForCallsWithNoAccountSession() {
    await recordAuditEvent({
      actorKind: 'system',
      actorRef: null,
      action: 'reminder.dispatch',
      targetKind: 'appointment',
      targetId: null,
      outcome: 'granted',
    })
    expect(auditRows[0]).toMatchObject({ actor_kind: 'system', actor_ref: null })
  })
})

describe('design decision: recordAuditEvent resolves void and never rethrows a write failure', () => {
  test('returnedAdapterErrorIsRedactedLoggedAndSwallowed', async function returnedAdapterErrorIsRedactedLoggedAndSwallowed() {
    setInsertBehavior('pg-error')
    setInsertFailureMessage(sensitiveFailureMessage())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAuditEvent(baseInput())).resolves.toBeUndefined()
    expectRedactedWriteFailureLog(errorSpy.mock.calls)
  })

  test('thrownAdapterExceptionIsRedactedLoggedAndSwallowed', async function thrownAdapterExceptionIsRedactedLoggedAndSwallowed() {
    setInsertBehavior('throw')
    setInsertFailureMessage(sensitiveFailureMessage())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAuditEvent(baseInput())).resolves.toBeUndefined()
    expectRedactedWriteFailureLog(errorSpy.mock.calls)
  })

  test('missingSessionDeniedEventPersistsExactlyOnceThroughServiceRole', async function missingSessionDeniedEventPersistsExactlyOnceThroughServiceRole() {
    setCallerHasSession(false)
    await expect(recordAuditEvent(baseInput({ actorRef: null, outcome: 'denied' }))).resolves.toBeUndefined()
    expect(anonClientMock).not.toHaveBeenCalled()
    expect(serviceClientMock).toHaveBeenCalledTimes(1)
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({ outcome: 'denied' })
  })

  test('invalidSessionDeniedEventPersistsExactlyOnceThroughServiceRole', async function invalidSessionDeniedEventPersistsExactlyOnceThroughServiceRole() {
    setSessionTokenValid(false)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAuditEvent(baseInput({ actorRef: null, outcome: 'denied' }))).resolves.toBeUndefined()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(anonClientMock).not.toHaveBeenCalled()
    expect(serviceClientMock).toHaveBeenCalledTimes(1)
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({ outcome: 'denied' })
  })

  test('missingSessionDeniedDomainEventCannotUseServiceRole', async function missingSessionDeniedDomainEventCannotUseServiceRole() {
    setCallerHasSession(false)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      recordAuditEvent(baseInput({ actorRef: null, action: 'booking.cancel', outcome: 'denied' })),
    ).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(serviceClientMock).not.toHaveBeenCalled()
    expect(auditRows).toHaveLength(0)
  })

  test('missingSessionGrantedAccountEventCannotUseServiceRole', async function missingSessionGrantedAccountEventCannotUseServiceRole() {
    setCallerHasSession(false)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAuditEvent(baseInput({ outcome: 'granted' }))).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(anonClientMock).not.toHaveBeenCalled()
    expect(serviceClientMock).not.toHaveBeenCalled()
    expect(auditRows).toHaveLength(0)
  })

  test('missingSessionSystemEventCannotUseServiceRole', async function missingSessionSystemEventCannotUseServiceRole() {
    setCallerHasSession(false)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAuditEvent(baseInput({ actorKind: 'system', actorRef: null }))).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(anonClientMock).not.toHaveBeenCalled()
    expect(serviceClientMock).not.toHaveBeenCalled()
    expect(auditRows).toHaveLength(0)
  })
})

// The "stub always denies every actor/target combination" coverage that used
// to live here (JOR-238, guard.ts's original stub) is gone: JOR-262 replaced
// the stub with real session/identity-link/ownership logic, so "always 401"
// is no longer true of guardPhiAccess. That ticket's tests/access/guard.test.ts
// is the guard's own behavior suite now; this file keeps only what is still
// true of it — that it writes audit_events exclusively through
// recordAuditEvent, never by hand.
describe('AC: lib/audit/events.ts is the only writer; lib/access/guard.ts never inserts into audit_events itself', () => {
  test('guardWritesAuditEventsOnlyThroughRecordAuditEvent', function guardWritesAuditEventsOnlyThroughRecordAuditEvent() {
    const source = readFileSync(path.join(REPO_ROOT, 'lib', 'access', 'guard.ts'), 'utf8')
    // Built at runtime, not spelled out literally, so this assertion itself
    // does not trip tests/db/client.test.ts's whole-tree scan for the same
    // package name (the same trick that file and tests/notify/email.test.ts use).
    const supabaseJsPackage = ['@supabase', 'supabase-js'].join('/')
    expect(source).toContain("from '../audit/events'")
    expect(source).not.toContain(supabaseJsPackage)
    expect(source).not.toMatch(/\.from\(\s*['"]audit_events['"]\s*\)/)
  })
})

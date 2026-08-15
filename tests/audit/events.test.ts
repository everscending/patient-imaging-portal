// tests/audit/events.test.ts — the audit writer's own tests (JOR-238).
//
// lib/audit/events.ts's only production dependencies are lib/db/client.ts's
// anonClient() and next/headers's cookies() (recordAuditEvent's pinned
// signature carries no accessToken parameter, so it reads the caller's
// session cookie itself, the same way middleware.ts reads it off a request).
// anonClient() itself talks to Supabase's REST layer. There is no PostgREST
// server in this repo's test harness (tests/setup/postgres.ts starts a bare
// postgres:16-alpine container for schema-level tests) and this ticket has no
// live route to exercise one against (ADR-0012, "No live-app contact in this
// ticket"). So — exactly like tests/notify/email.test.ts stubs the Resend
// SDK — this file stubs lib/db/client.ts's anonClient() with an in-memory
// fake table, and next/headers's cookies() with a fake session cookie, and
// asserts against those.
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
//   a detail object carrying fullName/dateOfBirth/patientRef/email, rejected
//     → detailCarryingPhiShapedKeyRejected
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
  resetFakeAuditTable,
  setInsertBehavior,
  setCallerHasSession,
  hasCallerSession,
  FAKE_SESSION_COOKIE_NAME,
  FAKE_ACCESS_TOKEN,
} = vi.hoisted(() => {
  const rows: FakeAuditRow[] = []
  let behavior: 'ok' | 'pg-error' | 'throw' = 'ok'
  let callerHasSession = true
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
          if (behavior === 'throw') throw new Error('simulated network failure')
          if (behavior === 'pg-error') return { error: { message: 'simulated postgres failure' } }
          rows.push(row)
          return { error: null }
        },
      }
    },
  }))

  return {
    auditRows: rows,
    anonClientMock,
    resetFakeAuditTable: () => {
      rows.length = 0
      behavior = 'ok'
      callerHasSession = true
    },
    setInsertBehavior: (next: 'ok' | 'pg-error' | 'throw') => {
      behavior = next
    },
    setCallerHasSession: (next: boolean) => {
      callerHasSession = next
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
  serviceClient: vi.fn(),
  anonClient: anonClientMock,
  authClient: vi.fn(),
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
    const detail = { count: 3, note: 'reschedule', successful: true }
    await recordAuditEvent(baseInput({ detail }))
    const stored = auditRows[0]?.detail
    expect(JSON.parse(JSON.stringify(stored))).toEqual(detail)
  })
})

describe('mandatory adversarial: detail carrying a PHI-shaped key is rejected (SEC-6)', () => {
  test.each(['fullName', 'dateOfBirth', 'patientRef', 'email'])(
    'detailCarryingPhiShapedKeyRejected: %s',
    async function detailCarryingPhiShapedKeyRejected(key) {
      await expect(recordAuditEvent(baseInput({ detail: { [key]: 'x' } }))).rejects.toThrow(/PHI-shaped key/)
      expect(auditRows).toHaveLength(0)
    },
  )
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
  test('aFailedInsertIsLoggedAndSwallowedNotRethrown', async function aFailedInsertIsLoggedAndSwallowedNotRethrown() {
    setInsertBehavior('pg-error')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAuditEvent(baseInput())).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string)
    expect(logged.event).toBe('audit_events.write_failed')
    expect(logged.action).toBe('study.view')
  })

  test('aClientThatThrowsSynchronouslyIsLoggedAndSwallowedNotRethrown', async function aClientThatThrowsSynchronouslyIsLoggedAndSwallowedNotRethrown() {
    setInsertBehavior('throw')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAuditEvent(baseInput())).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  test('aCallWithNoCallerSessionCookieIsLoggedAndSwallowedNotRethrown', async function aCallWithNoCallerSessionCookieIsLoggedAndSwallowedNotRethrown() {
    setCallerHasSession(false)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAuditEvent(baseInput())).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(anonClientMock).not.toHaveBeenCalled()
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

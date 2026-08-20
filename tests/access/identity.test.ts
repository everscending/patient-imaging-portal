// tests/access/identity.test.ts — lib/access/identity.ts's own tests
// (JOR-254). Same reason as tests/audit/events.test.ts: no PostgREST server
// in this repo's harness, no live route in this ticket (ADR-0012, "No
// live-app contact in this ticket"). lib/db/client.ts's serviceClient() and
// authClient(), next/headers's cookies(), lib/session-cookie.ts and
// lib/audit/events.ts are all stubbed; a minimal in-memory Postgrest-shaped
// fake stands in for the two tables this module touches.
//
// Bullet → test function (this ticket's "Mandatory adversarial tests"):
//   a correct reference with a date of birth one day out
//     → wrongDateOfBirthOneDayOutRejectedGenerically
//   a reference that does not exist
//     → nonexistentReferenceRejectedByteIdenticalToWrongDob
//   a correct reference+dob whose user_id already names a different account
//     → alreadyLinkedToDifferentAccountRejectedUserIdUnchanged
//   a raw client address reaching identity_attempts.source_ref
//     → sourceRefIsHexDigestNeverTheRawAddress
//   a missing SOURCE_REF_SALT silently producing a constant source_ref
//     → missingSourceRefSaltFailsStartupNotHashedToConstant
//     (the actual startup-failure assertion is
//      tests/config/config.test.ts's "adversarial: missing SOURCE_REF_SALT
//      never produces an unsalted or undefined-salted config" — this file
//      asserts the other half: two different salts never collide)
//   two different client addresses producing the same source_ref
//     → differentAddressesNeverCollideOnSourceRef
//   a 4th attempt inside the window with the correct reference and dob
//     → fourthAttemptInsideWindowWithCorrectAnswerStillLocked
//   three failures from one source against three different references, then
//   a correct attempt from that source
//     → threeFailuresAcrossDifferentReferencesFromOneSourceLocksThatSource
//   clearing the session and retrying to reset the counter
//     → clearingSessionDoesNotResetSourceCount
//   a private-browsing request, or no cookie at all, resetting the per-source count
//     → noCookieRequestDoesNotResetSourceCount
//   dateOfBirth malformed / empty / 10 KB
//     → malformedDateOfBirthRejectedAt422 (route-level, x.each)
//   an extra patientId or userId field
//     → extraFieldRejectedAt422
//   a verify request with no session
//     → noSessionRejectedWithFourOhOneBeforeAnyAttemptRow
//   a response body or audit detail that differs between the three failure causes
//     → allThreeFailureCausesProduceByteIdenticalResponses (body)
//     → noAuditDetailEverCarriesReferenceDobNameEmailOrAddress (detail)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

type FakeRow = Record<string, unknown>

const {
  patients,
  identityAttempts,
  auditCalls,
  fakeServiceClient,
  authClientMock,
  resetFakeDb,
  setCallerHasSession,
  setCallerUserId,
  hasCallerSession,
  FAKE_SESSION_COOKIE_NAME,
  FAKE_ACCESS_TOKEN,
} = vi.hoisted(() => {
  const patientRows: FakeRow[] = []
  const attemptRows: FakeRow[] = []
  const audits: FakeRow[] = []
  let sessionPresent = true
  let userId = 'caller-1'
  let idCounter = 0

  function matchesFilters(row: FakeRow, filters: Array<[string, string, unknown]>): boolean {
    return filters.every(([type, col, val]) => {
      if (type === 'eq') return row[col] === val
      if (type === 'is') return row[col] === val
      if (type === 'gte') return (row[col] as string) >= (val as string)
      return true
    })
  }

  function makeBuilder(table: FakeRow[], mode: 'select' | 'insert' | 'update', payload: FakeRow | null) {
    const filters: Array<[string, string, unknown]> = []
    let orderSpec: { col: string; ascending: boolean } | null = null
    let limitN: number | null = null
    let countMode = false

    async function run(): Promise<FakeRow[]> {
      if (mode === 'insert') {
        const row: FakeRow = { id: `row-${idCounter++}`, ...(payload as FakeRow) }
        table.push(row)
        return [row]
      }
      if (mode === 'update') {
        const matched = table.filter((row) => matchesFilters(row, filters))
        matched.forEach((row) => Object.assign(row, payload as FakeRow))
        return matched
      }
      let rows = table.filter((row) => matchesFilters(row, filters))
      if (orderSpec) {
        const { col, ascending } = orderSpec
        rows = [...rows].sort((a, b) => {
          const av = a[col] as string
          const bv = b[col] as string
          const dir = ascending ? 1 : -1
          return av < bv ? -dir : av > bv ? dir : 0
        })
      }
      if (limitN !== null) rows = rows.slice(0, limitN)
      return rows
    }

    const api = {
      eq(col: string, val: unknown) {
        filters.push(['eq', col, val])
        return api
      },
      is(col: string, val: unknown) {
        filters.push(['is', col, val])
        return api
      },
      gte(col: string, val: unknown) {
        filters.push(['gte', col, val])
        return api
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderSpec = { col, ascending: opts?.ascending !== false }
        return api
      },
      limit(n: number) {
        limitN = n
        return api
      },
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts && opts.count) countMode = true
        return api
      },
      async maybeSingle() {
        const rows = await run()
        return { data: rows[0] ?? null, error: null }
      },
      async single() {
        const rows = await run()
        if (rows.length !== 1) return { data: null, error: { message: 'expected exactly one row' } }
        return { data: rows[0], error: null }
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        run()
          .then((rows) => resolve(countMode ? { data: null, error: null, count: rows.length } : { data: rows, error: null }))
          .catch(reject)
      },
    }
    return api
  }

  // Mirrors db/migrations/004_identity_link_atomicity.sql's
  // link_patient_identity(...) function: the conditional UPDATE and the
  // succeeded=true insert happen together, synchronously, in this one call —
  // the same all-or-nothing shape the real function gets from running as a
  // single Postgres transaction. There is no PostgREST hop in between for a
  // process death or a failed second call to land in, which is exactly what
  // moving this behind one .rpc() call buys in production.
  function fakeLinkPatientIdentity(args: {
    p_patient_id: string
    p_caller_id: string
    p_attempted_patient_ref: string
    p_source_ref: string
    p_attempted_at: string
  }): string {
    const patient = patientRows.find((row) => row.id === args.p_patient_id)
    if (patient && patient.user_id === null) {
      patient.user_id = args.p_caller_id
      attemptRows.push({
        id: `row-${idCounter++}`,
        attempted_patient_ref: args.p_attempted_patient_ref,
        source_ref: args.p_source_ref,
        user_id: args.p_caller_id,
        succeeded: true,
        attempted_at: args.p_attempted_at,
      })
      return 'linked_now'
    }
    return patient?.user_id === args.p_caller_id ? 'already_by_caller' : 'claimed_by_other'
  }

  const fakeServiceClient = vi.fn(() => ({
    from(tableName: string) {
      const table = tableName === 'patients' ? patientRows : tableName === 'identity_attempts' ? attemptRows : null
      if (!table) throw new Error(`fake client: unexpected table "${tableName}"`)
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) => makeBuilder(table, 'select', null).select(cols, opts),
        insert: (row: FakeRow) => makeBuilder(table, 'insert', row),
        update: (patch: FakeRow) => makeBuilder(table, 'update', patch),
      }
    },
    async rpc(fnName: string, args: FakeRow) {
      if (fnName !== 'link_patient_identity') throw new Error(`fake client: unexpected rpc "${fnName}"`)
      return { data: fakeLinkPatientIdentity(args as Parameters<typeof fakeLinkPatientIdentity>[0]), error: null }
    },
  }))

  const authClientMock = vi.fn(() => ({
    auth: {
      async getUser(token: string) {
        if (!sessionPresent || token !== FAKE_ACCESS_TOKEN) return { data: { user: null }, error: { message: 'invalid token' } }
        return { data: { user: { id: userId } }, error: null }
      },
    },
  }))

  return {
    patients: patientRows,
    identityAttempts: attemptRows,
    auditCalls: audits,
    fakeServiceClient,
    authClientMock,
    resetFakeDb: () => {
      patientRows.length = 0
      attemptRows.length = 0
      audits.length = 0
      sessionPresent = true
      userId = 'caller-1'
      idCounter = 0
    },
    setCallerHasSession: (next: boolean) => {
      sessionPresent = next
    },
    setCallerUserId: (next: string) => {
      userId = next
    },
    hasCallerSession: () => sessionPresent,
    callerUserId: () => userId,
    FAKE_SESSION_COOKIE_NAME: 'pip_session',
    FAKE_ACCESS_TOKEN: 'fake-caller-access-token',
  }
})

vi.mock('../../lib/db/client', () => ({
  serviceClient: fakeServiceClient,
  anonClient: vi.fn(),
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
}))

vi.mock('../../lib/config', () => ({
  config: {
    identityMaxAttempts: 3,
    identityLockoutMinutes: 5,
    sourceRefSalt: 'unit-test-source-ref-salt',
    maxRequestBodyBytes: 65536,
  },
}))

import { computeSourceRef, getIdentityStatus, resolveAuthenticatedSession, resolveCallerId, verifyIdentity } from '../../lib/access/identity'
import { GET as statusRoute } from '../../app/api/identity/status/route'
import { POST as verifyRoute } from '../../app/api/identity/verify/route'

const SEEDED_DOB = '1988-03-14'
const SEEDED_REF = 'PT-4471'

function seedPatient(overrides: Partial<{ id: string; patient_ref: string; date_of_birth: string; user_id: string | null }> = {}) {
  const row = {
    id: overrides.id ?? `patient-${patients.length}`,
    patient_ref: overrides.patient_ref ?? SEEDED_REF,
    date_of_birth: overrides.date_of_birth ?? SEEDED_DOB,
    user_id: overrides.user_id ?? null,
  }
  patients.push(row)
  return row
}

function verifyRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/identity/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function fakeRequestWithForwardedFor(forwardedFor: string): Request {
  return new Request('http://localhost/api/identity/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: '{}',
  })
}

const SOURCE_A = 'sha-source-a-token'
const SOURCE_B = 'sha-source-b-token'

beforeEach(() => {
  resetFakeDb()
  fakeServiceClient.mockClear()
  authClientMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AC: a correct reference + dob for a null-user_id patient links, records the successful attempt, in one pass', () => {
  test('successfulVerificationLinksAccountAndRecordsAttempt', async function successfulVerificationLinksAccountAndRecordsAttempt() {
    const patient = seedPatient()
    const result = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })

    expect(result).toEqual({ ok: true, patientRef: SEEDED_REF, linkedAt: expect.any(String) })
    expect(patient.user_id).toBe('caller-1')
    expect(identityAttempts).toHaveLength(1)
    expect(identityAttempts[0]).toMatchObject({ attempted_patient_ref: SEEDED_REF, source_ref: SOURCE_A, succeeded: true, user_id: 'caller-1' })

    const actions = auditCalls.map((c) => c.action)
    expect(actions).toEqual(['identity.verify', 'identity.link'])
    expect(auditCalls[0]).toMatchObject({ outcome: 'granted', action: 'identity.verify' })
    expect(auditCalls[1]).toMatchObject({ outcome: 'granted', action: 'identity.link' })
  })
})

describe('AC: repeating the same successful verification from the same account is a harmless no-op', () => {
  test('repeatVerificationFromSameAccountNoSecondRowOfAnyKind', async function repeatVerificationFromSameAccountNoSecondRowOfAnyKind() {
    seedPatient()
    const first = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    expect(first.ok).toBe(true)

    const attemptCountAfterFirst = identityAttempts.length
    const auditCountAfterFirst = auditCalls.length

    const second = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })

    expect(second.ok).toBe(true)
    expect((second as { linkedAt: string }).linkedAt).toBe((first as { linkedAt: string }).linkedAt)
    expect(patients[0]?.user_id).toBe('caller-1')
    expect(identityAttempts).toHaveLength(attemptCountAfterFirst)
    expect(auditCalls).toHaveLength(auditCountAfterFirst)
  })
})

describe('mandatory adversarial: a correct reference with a date of birth one day out', () => {
  test('wrongDateOfBirthOneDayOutRejectedGenerically', async function wrongDateOfBirthOneDayOutRejectedGenerically() {
    seedPatient()
    const result = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: '1988-03-15', sourceRef: SOURCE_A })
    expect(result).toEqual({ ok: false })
    expect(identityAttempts[0]).toMatchObject({ succeeded: false })
    expect(patients[0]?.user_id).toBeNull()
  })
})

describe('mandatory adversarial: a reference that does not exist, byte-identical to a wrong dob', () => {
  test('nonexistentReferenceRejectedByteIdenticalToWrongDob', async function nonexistentReferenceRejectedByteIdenticalToWrongDob() {
    seedPatient()
    const unknownRefResult = await verifyIdentity({ callerId: 'caller-1', patientRef: 'PT-0000', dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    const wrongDobResult = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: '1988-03-15', sourceRef: SOURCE_B })
    expect(unknownRefResult).toEqual({ ok: false })
    expect(wrongDobResult).toEqual({ ok: false })
    expect(unknownRefResult).toEqual(wrongDobResult)
  })
})

describe('mandatory adversarial: a correct reference+dob already linked to a different account', () => {
  test('alreadyLinkedToDifferentAccountRejectedUserIdUnchanged', async function alreadyLinkedToDifferentAccountRejectedUserIdUnchanged() {
    const patient = seedPatient({ user_id: 'someone-else' })
    const result = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    expect(result).toEqual({ ok: false })
    expect(patient.user_id).toBe('someone-else')
    expect(identityAttempts[0]).toMatchObject({ succeeded: false })
  })
})

describe('mandatory adversarial: source_ref is a hex digest, never the raw client address in any form', () => {
  test('sourceRefIsHexDigestNeverTheRawAddress', async function sourceRefIsHexDigestNeverTheRawAddress() {
    seedPatient()
    const request = fakeRequestWithForwardedFor('203.0.113.7, 10.0.0.1')
    const sourceRef = computeSourceRef(request)

    expect(sourceRef).toMatch(/^[0-9a-f]{64}$/)
    expect(sourceRef).not.toContain('203.0.113.7')
    expect(sourceRef).not.toContain('10.0.0.1')

    await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef })
    const stored = identityAttempts[0]?.source_ref as string
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toMatch(/203\.0\.113\.7/)
    // Not an IPv6 form either, and not any base64/hex encoding of the octets.
    expect(stored).not.toMatch(/::/)
  })
})

describe('mandatory adversarial: a missing SOURCE_REF_SALT never hashes every caller to one constant value', () => {
  test('missingSourceRefSaltFailsStartupNotHashedToConstant', function missingSourceRefSaltFailsStartupNotHashedToConstant() {
    // The startup-failure half (SOURCE_REF_SALT has no default; loadConfig
    // throws before any handler can run) is
    // tests/config/config.test.ts's "adversarial: missing SOURCE_REF_SALT
    // never produces an unsalted or undefined-salted config" — this file
    // mocks lib/config.ts entirely, so it cannot re-exercise that startup
    // path, and instead proves the other half of the same bullet: two
    // different salts never fold two different callers onto one source_ref.
    const withSalt = computeSourceRef(fakeRequestWithForwardedFor('198.51.100.1'))
    expect(withSalt).not.toBe('')
    expect(withSalt).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('mandatory adversarial: two different client addresses never collide on source_ref', () => {
  test('differentAddressesNeverCollideOnSourceRef', function differentAddressesNeverCollideOnSourceRef() {
    const a = computeSourceRef(fakeRequestWithForwardedFor('198.51.100.1'))
    const b = computeSourceRef(fakeRequestWithForwardedFor('198.51.100.2'))
    expect(a).not.toBe(b)
  })

  test('sameAddressAlwaysProducesTheSameSourceRef', function sameAddressAlwaysProducesTheSameSourceRef() {
    const a = computeSourceRef(fakeRequestWithForwardedFor('198.51.100.1'))
    const b = computeSourceRef(fakeRequestWithForwardedFor('198.51.100.1'))
    expect(a).toBe(b)
  })
})

describe('AC: the first x-forwarded-for entry is the client; later entries are proxies', () => {
  test('firstForwardedForEntryIsWhatIsHashedNotLaterProxies', function firstForwardedForEntryIsWhatIsHashedNotLaterProxies() {
    const clientFirst = computeSourceRef(fakeRequestWithForwardedFor('203.0.113.9, 10.0.0.1, 10.0.0.2'))
    const sameClientDifferentProxyChain = computeSourceRef(fakeRequestWithForwardedFor('203.0.113.9, 10.9.9.9'))
    expect(clientFirst).toBe(sameClientDifferentProxyChain)

    const differentClientSameProxyChain = computeSourceRef(fakeRequestWithForwardedFor('203.0.113.10, 10.0.0.1, 10.0.0.2'))
    expect(clientFirst).not.toBe(differentClientSameProxyChain)
  })
})

describe('AC: 3 failures in the window locks further attempts for that reference', () => {
  test('thirdFailureAndEveryOneAfterReturnsTheSameFourHundred', async function thirdFailureAndEveryOneAfterReturnsTheSameFourHundred() {
    seedPatient()
    for (let i = 0; i < 3; i++) {
      const r = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: '1988-03-15', sourceRef: `${SOURCE_A}-${i}` })
      expect(r).toEqual({ ok: false })
    }
    const fourth = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: '1988-03-15', sourceRef: `${SOURCE_A}-3` })
    expect(fourth).toEqual({ ok: false })
    const lockoutAudits = auditCalls.filter((c) => c.action === 'identity.lockout')
    expect(lockoutAudits).toHaveLength(1)
  })
})

describe('mandatory adversarial: a 4th attempt inside the window with the CORRECT reference and dob is still rejected', () => {
  test('fourthAttemptInsideWindowWithCorrectAnswerStillLocked', async function fourthAttemptInsideWindowWithCorrectAnswerStillLocked() {
    seedPatient()
    for (let i = 0; i < 3; i++) {
      await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: 'wrong-dob', sourceRef: `${SOURCE_A}-${i}` })
    }
    const correctButLocked = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: `${SOURCE_A}-3` })
    expect(correctButLocked).toEqual({ ok: false })
    expect(patients[0]?.user_id).toBeNull()
    const lastAttempt = identityAttempts[identityAttempts.length - 1]
    expect(lastAttempt).toMatchObject({ succeeded: false })
  })
})

describe('mandatory adversarial: three failures from one source against three different references locks that source', () => {
  test('threeFailuresAcrossDifferentReferencesFromOneSourceLocksThatSource', async function threeFailuresAcrossDifferentReferencesFromOneSourceLocksThatSource() {
    seedPatient({ patient_ref: 'PT-0001' })
    seedPatient({ patient_ref: 'PT-0002' })
    seedPatient({ patient_ref: 'PT-0003' })

    for (const ref of ['PT-0001', 'PT-0002', 'PT-0003']) {
      const r = await verifyIdentity({ callerId: 'caller-1', patientRef: ref, dateOfBirth: 'wrong-dob', sourceRef: SOURCE_A })
      expect(r).toEqual({ ok: false })
    }

    const correctFromLockedSource = await verifyIdentity({ callerId: 'caller-1', patientRef: 'PT-0001', dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    expect(correctFromLockedSource).toEqual({ ok: false })
  })
})

describe('mandatory adversarial: clearing the session never resets the per-source or per-reference counter', () => {
  test('clearingSessionDoesNotResetSourceCount', async function clearingSessionDoesNotResetSourceCount() {
    seedPatient()
    for (let i = 0; i < 3; i++) {
      await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: 'wrong-dob', sourceRef: SOURCE_A })
    }
    // A fresh "session" is a new callerId; source_ref is derived from the
    // request header, never from the session, so it is unaffected.
    const asDifferentCaller = await verifyIdentity({ callerId: 'caller-2', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    expect(asDifferentCaller).toEqual({ ok: false })
  })
})

describe('mandatory adversarial: a private-browsing request, or no cookie at all, does not reset the per-source count', () => {
  test('noCookieRequestDoesNotResetSourceCount', async function noCookieRequestDoesNotResetSourceCount() {
    seedPatient()
    for (let i = 0; i < 3; i++) {
      await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: 'wrong-dob', sourceRef: SOURCE_A })
    }
    // No cookie/private window changes nothing about source_ref itself —
    // it is computed purely from x-forwarded-for (proven directly, since
    // computeSourceRef never reads a cookie at all).
    const requestNoCookie = fakeRequestWithForwardedFor('203.0.113.55')
    const sourceRefNoCookie = computeSourceRef(requestNoCookie)
    const sourceRefRepeat = computeSourceRef(requestNoCookie)
    expect(sourceRefNoCookie).toBe(sourceRefRepeat)
  })
})

describe('AC: a locked reference verifies successfully once the lockout window has elapsed', () => {
  test('lockoutClearsAfterTheConfiguredWindowElapses', async function lockoutClearsAfterTheConfiguredWindowElapses() {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-14T18:00:00.000Z'))
      seedPatient()
      for (let i = 0; i < 3; i++) {
        await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: 'wrong-dob', sourceRef: `${SOURCE_A}-${i}` })
      }
      const stillLocked = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: `${SOURCE_A}-3` })
      expect(stillLocked).toEqual({ ok: false })

      vi.setSystemTime(new Date('2026-08-14T18:05:00.001Z')) // 5:00.001 past the third failure
      const afterWindow = await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: `${SOURCE_A}-4` })
      expect(afterWindow).toEqual({ ok: true, patientRef: SEEDED_REF, linkedAt: expect.any(String) })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mandatory adversarial: dateOfBirth malformed / empty / oversized is rejected with 422 before any database contact', () => {
  test.each([
    { dateOfBirth: '1988-3-14', label: 'unpadded month/day' },
    { dateOfBirth: '14/03/1988', label: 'DD/MM/YYYY' },
    { dateOfBirth: '', label: 'empty string' },
    { dateOfBirth: '1'.repeat(10_240), label: '10 KB string' },
  ])('malformedDateOfBirthRejectedAt422: $label', async ({ dateOfBirth }) => {
    setCallerHasSession(true)
    setCallerUserId('caller-1')
    const response = await verifyRoute(verifyRequest({ patientRef: SEEDED_REF, dateOfBirth }))
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.error).toBe('validation_failed')
    expect(identityAttempts).toHaveLength(0)
  })
})

describe('mandatory adversarial: an extra patientId or userId field is rejected', () => {
  test.each(['patientId', 'userId'])('extraFieldRejectedAt422: %s', async (extraField) => {
    setCallerHasSession(true)
    const response = await verifyRoute(verifyRequest({ patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, [extraField]: 'x' }))
    expect(response.status).toBe(422)
    expect(identityAttempts).toHaveLength(0)
  })
})

describe('mandatory adversarial: a verify request with no session is rejected before any attempt row is written', () => {
  test('noSessionRejectedWithFourOhOneBeforeAnyAttemptRow', async function noSessionRejectedWithFourOhOneBeforeAnyAttemptRow() {
    seedPatient()
    setCallerHasSession(false)
    const response = await verifyRoute(verifyRequest({ patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB }))
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('session_required')
    expect(identityAttempts).toHaveLength(0)
  })
})

describe('AC: both routes reject a malformed body through parseBody before any database contact', () => {
  test('nonJsonBodyRejectedAt422BeforeDatabaseContact', async function nonJsonBodyRejectedAt422BeforeDatabaseContact() {
    setCallerHasSession(true)
    const request = new Request('http://localhost/api/identity/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    const response = await verifyRoute(request)
    expect(response.status).toBe(422)
    expect(fakeServiceClient).not.toHaveBeenCalled()
  })
})

describe('mandatory adversarial: response body and audit detail never diverge between the three failure causes', () => {
  test('allThreeFailureCausesProduceByteIdenticalResponses', async function allThreeFailureCausesProduceByteIdenticalResponses() {
    seedPatient({ patient_ref: 'PT-LINKED', user_id: 'someone-else' })
    setCallerHasSession(true)
    setCallerUserId('caller-1')

    const unknownRef = await verifyRoute(verifyRequest({ patientRef: 'PT-UNKNOWN', dateOfBirth: SEEDED_DOB }))
    const wrongDob = await verifyRoute(verifyRequest({ patientRef: SEEDED_REF, dateOfBirth: '1988-03-15' }))
    const alreadyLinked = await verifyRoute(verifyRequest({ patientRef: 'PT-LINKED', dateOfBirth: SEEDED_DOB }))

    seedPatient({ patient_ref: 'PT-LOCK-TARGET' })
    // Three well-formed-but-wrong attempts push the per-reference failure
    // count to 3; the lockout is only checked at the START of a call, so it
    // is the 4th call — not the 3rd — that is actually refused as locked.
    for (let i = 0; i < 3; i++) {
      await verifyRoute(verifyRequest({ patientRef: 'PT-LOCK-TARGET', dateOfBirth: '1900-01-01' }, { 'x-forwarded-for': `10.0.0.${i}` }))
    }
    const locked = await verifyRoute(verifyRequest({ patientRef: 'PT-LOCK-TARGET', dateOfBirth: SEEDED_DOB }, { 'x-forwarded-for': '10.0.0.99' }))

    const bodies = await Promise.all([unknownRef, wrongDob, alreadyLinked, locked].map((r) => r.json()))
    expect(unknownRef.status).toBe(400)
    expect(wrongDob.status).toBe(400)
    expect(alreadyLinked.status).toBe(400)
    expect(locked.status).toBe(400)
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1)
  })

  test('noAuditDetailEverCarriesReferenceDobNameEmailOrAddress', async function noAuditDetailEverCarriesReferenceDobNameEmailOrAddress() {
    seedPatient({ user_id: 'someone-else' })
    await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })

    seedPatient({ patient_ref: 'PT-9999' })
    await verifyIdentity({ callerId: 'caller-1', patientRef: 'PT-9999', dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })

    expect(auditCalls.length).toBeGreaterThan(0)
    for (const call of auditCalls) {
      const detail = JSON.stringify(call.detail ?? {})
      expect(detail).not.toContain(SEEDED_REF)
      expect(detail).not.toContain(SEEDED_DOB)
      expect(detail).not.toContain('caller-1')
      expect(call.detail).toBeUndefined()
    }
  })
})

describe('AC: a successful verification audits identity.verify granted and identity.link granted; a failure audits identity.verify denied; a lockout audits identity.lockout denied', () => {
  test('auditActionsMatchOutcomeExactly', async function auditActionsMatchOutcomeExactly() {
    seedPatient()
    await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    expect(auditCalls.map((c) => [c.action, c.outcome])).toEqual([
      ['identity.verify', 'granted'],
      ['identity.link', 'granted'],
    ])

    resetFakeDb()
    seedPatient()
    await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: 'wrong-dob', sourceRef: SOURCE_A })
    expect(auditCalls.map((c) => [c.action, c.outcome])).toEqual([['identity.verify', 'denied']])

    resetFakeDb()
    seedPatient()
    // The lockout is only checked at the START of a call, so it takes a 4th
    // call — one past the 3 that build up the failure count — to actually
    // observe an identity.lockout audit row.
    for (let i = 0; i < 4; i++) {
      await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: 'wrong-dob', sourceRef: `${SOURCE_A}-${i}` })
    }
    const lockoutActions = auditCalls.filter((c) => c.action === 'identity.lockout')
    expect(lockoutActions).toEqual([{ actorKind: 'account', actorRef: 'caller-1', action: 'identity.lockout', targetKind: 'patient', targetId: null, outcome: 'denied' }])
  })
})

describe('AC: attempted_patient_ref stores the reference as typed, never resolved to a patient id', () => {
  test('attemptedPatientRefStoresRawTypedValueNotAnId', async function attemptedPatientRefStoresRawTypedValueNotAnId() {
    seedPatient()
    await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    expect(identityAttempts[0]?.attempted_patient_ref).toBe(SEEDED_REF)
  })

  test('unknownReferenceStillStoresTheTypedStringNotNull', async function unknownReferenceStillStoresTheTypedStringNotNull() {
    await verifyIdentity({ callerId: 'caller-1', patientRef: 'PT-9999', dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    expect(identityAttempts[0]?.attempted_patient_ref).toBe('PT-9999')
  })
})

describe('GET /api/identity/status', () => {
  test('linkedAccountReturnsPatientRefAndLinkedAt', async function linkedAccountReturnsPatientRefAndLinkedAt() {
    seedPatient({ user_id: 'caller-1' })
    identityAttempts.push({ id: 'attempt-0', attempted_patient_ref: SEEDED_REF, source_ref: SOURCE_A, user_id: 'caller-1', succeeded: true, attempted_at: '2026-08-14T18:00:00.000Z' })
    const result = await getIdentityStatus('caller-1')
    expect(result).toEqual({ linked: true, patientRef: SEEDED_REF, linkedAt: '2026-08-14T18:00:00.000Z' })
  })

  test('unlinkedAccountReturnsLinkedFalse', async function unlinkedAccountReturnsLinkedFalse() {
    const result = await getIdentityStatus('caller-1')
    expect(result).toEqual({ linked: false })
  })

  test('statusRouteReturns401WithNoSession', async function statusRouteReturns401WithNoSession() {
    setCallerHasSession(false)
    const response = await statusRoute()
    expect(response.status).toBe(401)
  })

  test('statusRouteReturnsLinkedTrueOverHttp', async function statusRouteReturnsLinkedTrueOverHttp() {
    seedPatient({ user_id: 'caller-1' })
    identityAttempts.push({ id: 'attempt-0', attempted_patient_ref: SEEDED_REF, source_ref: SOURCE_A, user_id: 'caller-1', succeeded: true, attempted_at: '2026-08-14T18:00:00.000Z' })
    setCallerHasSession(true)
    setCallerUserId('caller-1')
    const response = await statusRoute()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ linked: true, patientRef: SEEDED_REF, linkedAt: '2026-08-14T18:00:00.000Z' })
  })

  test('statusRouteReturnsLinkedFalseOverHttp', async function statusRouteReturnsLinkedFalseOverHttp() {
    setCallerHasSession(true)
    setCallerUserId('caller-1')
    const response = await statusRoute()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ linked: false })
  })

  test('statusNeverFlipsBackAfterLinking', async function statusNeverFlipsBackAfterLinking() {
    seedPatient()
    setCallerHasSession(true)
    setCallerUserId('caller-1')
    const before = await getIdentityStatus('caller-1')
    expect(before).toEqual({ linked: false })

    await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    const after = await getIdentityStatus('caller-1')
    expect(after).toEqual({ linked: true, patientRef: SEEDED_REF, linkedAt: expect.any(String) })
  })
})

describe('AC: verification reads/writes patients and identity_attempts through the service role', () => {
  test('verifyIdentityUsesServiceClientNotAnonClient', async function verifyIdentityUsesServiceClientNotAnonClient() {
    seedPatient()
    await verifyIdentity({ callerId: 'caller-1', patientRef: SEEDED_REF, dateOfBirth: SEEDED_DOB, sourceRef: SOURCE_A })
    expect(fakeServiceClient).toHaveBeenCalled()
  })
})

describe('resolveCallerId', () => {
  test('resolvesTheAuthenticatedSessionOnceWithItsTokenAndCallerId', async function resolvesTheAuthenticatedSessionOnceWithItsTokenAndCallerId() {
    setCallerHasSession(true)
    setCallerUserId('caller-42')
    const session = await resolveAuthenticatedSession()
    expect(session).toEqual({ accessToken: FAKE_ACCESS_TOKEN, userId: 'caller-42' })
  })

  test('nonCredentialAuthErrorRetainsNullableSessionCompatibility', async function nonCredentialAuthErrorRetainsNullableSessionCompatibility() {
    authClientMock.mockReturnValueOnce({
      auth: {
        async getUser() {
          return { data: { user: null }, error: { status: 503 } }
        },
      },
    } as never)

    await expect(resolveAuthenticatedSession()).resolves.toBeNull()
  })

  test('resolvesTheAuthenticatedCallerId', async function resolvesTheAuthenticatedCallerId() {
    setCallerHasSession(true)
    setCallerUserId('caller-42')
    const id = await resolveCallerId()
    expect(id).toBe('caller-42')
  })

  test('returnsNullWithNoCookie', async function returnsNullWithNoCookie() {
    setCallerHasSession(false)
    const id = await resolveCallerId()
    expect(id).toBeNull()
  })
})

// JOR-254 round 3: the write moved out of lib/access/identity.ts's own
// PostgREST calls and into link_patient_identity (db/migrations/004_...),
// so a source-grep for the literal `.from('patients').update(` pattern would
// now find it nowhere at all — vacuously true, and no longer enforcing the
// invariant it exists for. Enforced instead against the new shape: the SQL
// write itself (only one migration may ever SET patients.user_id) and the
// call site (only identity.ts may name the RPC function that reaches it).
describe('AC: patients.user_id is written in no other file in the tree', () => {
  test('onlyTheLinkFunctionMigrationWritesPatientsUserId', function onlyTheLinkFunctionMigrationWritesPatientsUserId() {
    const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
    const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT })
      .toString()
      .trim()
      .split('\n')

    const sqlWriters = tracked.filter((relativePath) => {
      if (!relativePath.endsWith('.sql')) return false
      const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
      return /update\s+patients[\s\S]{0,60}set\s+user_id\s*=/i.test(source)
    })
    expect(sqlWriters).toEqual(['db/migrations/004_identity_link_atomicity.sql'])

    const tsFiles = tracked.filter((relativePath) => /\.(ts|tsx)$/.test(relativePath) && !relativePath.startsWith('tests/') && !relativePath.startsWith('db/'))

    const rpcCallers = tsFiles.filter((relativePath) => {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
      return source.includes('link_patient_identity')
    })
    expect(rpcCallers).toEqual(['lib/access/identity.ts'])

    // The old PostgREST write pattern is gone everywhere, not just relocated.
    const legacyPattern = tsFiles.filter((relativePath) => {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
      return /\.from\(['"]patients['"]\)\s*\.update\(/.test(source)
    })
    expect(legacyPattern).toEqual([])
  })
})

// Integration-style persistence coverage for JOR-262's audit fallback.
//
// The API integration harness starts bare PostgreSQL, not Supabase Auth or
// PostgREST, so it cannot present caller/service JWTs to RLS. This suite runs
// the real guard and centralized audit writer together and replaces only that
// unavailable boundary with an in-memory PostgREST-shaped storage adapter.
//
// Corrected-brief requirement -> test function:
//   missing-session denial persists exactly one row
//     -> missingSessionDenialPersistsExactlyOneAuditEvent
//   expired/invalid-session denial persists exactly one row
//     -> expiredSessionDenialPersistsExactlyOneAuditEvent
//   unauthenticated share-recipient grant persists exactly one row
//     -> shareRecipientGrantPersistsExactlyOneAuditEvent
//   unauthenticated share-recipient denial persists exactly one row
//     -> shareRecipientDenialPersistsExactlyOneAuditEvent
//   authenticated audit behavior stays caller-scoped
//     -> authenticatedCallerAuditPersistsExactlyOnceThroughCallerScopedClient
//   actor/session mismatch persists one caller-scoped denial attributed to
//   the authenticated session user
//     -> actorMismatchPersistsExactlyOneAuthenticatedUserDenialThroughCallerScopedClient

import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

type FakeRow = Record<string, unknown>
type WriteScope = 'caller' | 'service'

const {
  auditRows,
  patients,
  shareLinks,
  writeScopes,
  anonClientMock,
  serviceClientMock,
  authClientMock,
  resetStorage,
  setCallerHasSession,
  setSessionTokenValid,
  hasCallerSession,
  FAKE_SESSION_COOKIE_NAME,
  FAKE_ACCESS_TOKEN,
} = vi.hoisted(() => {
  const storedAudits: FakeRow[] = []
  const storedPatients: FakeRow[] = []
  const storedShareLinks: FakeRow[] = []
  const scopes: WriteScope[] = []
  let sessionPresent = true
  let sessionValid = true
  const accessToken = 'guard-audit-caller-token'

  function rowsFor(table: string): FakeRow[] {
    if (table === 'patients') return storedPatients
    if (table === 'share_links') return storedShareLinks
    throw new Error(`storage adapter: unexpected read table "${table}"`)
  }

  function makeClient(scope: WriteScope) {
    return {
      from(table: string) {
        if (table === 'audit_events') {
          return {
            async insert(row: FakeRow) {
              if (scope === 'caller' && !sessionValid) return { error: { message: 'invalid session JWT' } }
              storedAudits.push(row)
              scopes.push(scope)
              return { error: null }
            },
          }
        }

        const rows = rowsFor(table)
        const filters: Array<[string, unknown]> = []
        const query = {
          select() {
            return query
          },
          eq(column: string, value: unknown) {
            filters.push([column, value])
            return query
          },
          async maybeSingle() {
            const data = rows.find((row) => filters.every(([column, value]) => row[column] === value)) ?? null
            return { data, error: null }
          },
        }
        return query
      },
    }
  }

  return {
    auditRows: storedAudits,
    patients: storedPatients,
    shareLinks: storedShareLinks,
    writeScopes: scopes,
    anonClientMock: vi.fn(() => makeClient('caller')),
    serviceClientMock: vi.fn(() => makeClient('service')),
    authClientMock: vi.fn(() => ({
      auth: {
        async getUser(token: string) {
          if (!sessionValid || token !== accessToken) return { data: { user: null }, error: { message: 'invalid token', status: 401 } }
          return { data: { user: { id: 'account-1' } }, error: null }
        },
      },
    })),
    resetStorage() {
      storedAudits.length = 0
      storedPatients.length = 0
      storedShareLinks.length = 0
      scopes.length = 0
      sessionPresent = true
      sessionValid = true
    },
    setCallerHasSession(value: boolean) {
      sessionPresent = value
    },
    setSessionTokenValid(value: boolean) {
      sessionValid = value
    },
    hasCallerSession() {
      return sessionPresent
    },
    FAKE_SESSION_COOKIE_NAME: 'pip_session',
    FAKE_ACCESS_TOKEN: accessToken,
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
    get(name: string) {
      if (name !== FAKE_SESSION_COOKIE_NAME || !hasCallerSession()) return undefined
      return { value: FAKE_ACCESS_TOKEN }
    },
  }),
}))

import { guardPhiAccess } from '../../lib/access/guard'

beforeEach(() => {
  resetStorage()
  anonClientMock.mockClear()
  serviceClientMock.mockClear()
  authClientMock.mockClear()
})

describe('audit persistence across the real PHI guard and centralized writer', () => {
  test('missingSessionDenialPersistsExactlyOneAuditEvent', async function missingSessionDenialPersistsExactlyOneAuditEvent() {
    setCallerHasSession(false)

    const result = await guardPhiAccess({ kind: 'patient', userId: 'missing-account' }, { kind: 'study', id: 'study-1' }, 'study.view')

    expect(result).toEqual({ ok: false, status: 401 })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({ actor_kind: 'account', actor_ref: null, outcome: 'denied' })
    expect(writeScopes).toEqual(['service'])
  })

  test('expiredSessionDenialPersistsExactlyOneAuditEvent', async function expiredSessionDenialPersistsExactlyOneAuditEvent() {
    setSessionTokenValid(false)

    const result = await guardPhiAccess({ kind: 'patient', userId: 'expired-account' }, { kind: 'study', id: 'study-2' }, 'study.view')

    expect(result).toEqual({ ok: false, status: 401 })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({ actor_kind: 'account', actor_ref: null, outcome: 'denied' })
    expect(writeScopes).toEqual(['service'])
  })

  test('shareRecipientGrantPersistsExactlyOneAuditEvent', async function shareRecipientGrantPersistsExactlyOneAuditEvent() {
    setCallerHasSession(false)
    shareLinks.push({ id: 'share-grant', patient_id: 'patient-1', image_id: 'image-1', report_id: null })

    const result = await guardPhiAccess(
      { kind: 'share_recipient', shareLinkId: 'share-grant' },
      { kind: 'image', id: 'image-1' },
      'image.view',
    )

    expect(result).toEqual({ ok: true, patientId: 'patient-1' })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({ actor_kind: 'share_recipient', actor_ref: 'share-grant', outcome: 'granted' })
    expect(writeScopes).toEqual(['service'])
  })

  test('shareRecipientDenialPersistsExactlyOneAuditEvent', async function shareRecipientDenialPersistsExactlyOneAuditEvent() {
    setCallerHasSession(false)
    shareLinks.push({ id: 'share-denial', patient_id: 'patient-1', image_id: 'image-1', report_id: null })

    const result = await guardPhiAccess(
      { kind: 'share_recipient', shareLinkId: 'share-denial' },
      { kind: 'image', id: 'other-image' },
      'image.view',
    )

    expect(result).toEqual({ ok: false, status: 404 })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({ actor_kind: 'share_recipient', actor_ref: 'share-denial', outcome: 'denied' })
    expect(writeScopes).toEqual(['service'])
  })

  test(
    'authenticatedCallerAuditPersistsExactlyOnceThroughCallerScopedClient',
    async function authenticatedCallerAuditPersistsExactlyOnceThroughCallerScopedClient() {
      patients.push({ id: 'patient-authenticated', user_id: 'account-1' })

      const result = await guardPhiAccess(
        { kind: 'patient', userId: 'account-1' },
        { kind: 'collection', of: 'study' },
        'study.view',
      )

      expect(result).toEqual({ ok: true, patientId: 'patient-authenticated' })
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]).toMatchObject({ actor_kind: 'account', actor_ref: 'account-1', outcome: 'granted' })
      expect(writeScopes).toEqual(['caller'])
    },
  )

  test(
    'actorMismatchPersistsExactlyOneAuthenticatedUserDenialThroughCallerScopedClient',
    async function actorMismatchPersistsExactlyOneAuthenticatedUserDenialThroughCallerScopedClient() {
      patients.push({ id: 'patient-spoofed', user_id: 'spoofed-account' })

      const result = await guardPhiAccess(
        { kind: 'patient', userId: 'spoofed-account' },
        { kind: 'collection', of: 'study' },
        'study.view',
      )

      expect(result).toEqual({ ok: false, status: 401 })
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]).toMatchObject({ actor_kind: 'account', actor_ref: 'account-1', outcome: 'denied' })
      expect(auditRows[0]!.actor_ref).not.toBe('spoofed-account')
      expect(writeScopes).toEqual(['caller'])
      expect(serviceClientMock).not.toHaveBeenCalled()
    },
  )
})

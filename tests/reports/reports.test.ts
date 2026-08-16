// tests/reports/reports.test.ts — JOR-194 report read contract.
//
// Mandatory adversarial tests:
//   one audit row for a report-list request → oneAuditRowForReportListRequest
//   a second patient's report in a list → rlsCrossPatientIsolationInList
//   preliminary report included by the list query → signedOnlyListConsistency
//   patient direct read of preliminary → patientPreliminaryDirectReadIs404
//   owning provider/admin preliminary reads → providerAndAdminCanReadPreliminary
//   malformed report id → malformedReportIdIsValidationFailed
//   no session / unlinked identity → noSessionAndUnlinkedIdentityResponses
//   patient name, DOB, or status in a response → responseDataMinimization

import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>

const {
  reportRows,
  fromTables,
  guardCalls,
  anonClientMock,
  guardPhiAccessMock,
  setGuardStatus,
  setSession,
  setActorKind,
  getSession,
  resetFake,
  FAKE_ACCESS_TOKEN,
  FAKE_SESSION_COOKIE_NAME,
} = vi.hoisted(() => {
  const rows: Row[] = []
  const providerRows: Row[] = []
  const adminRows: Row[] = []
  const queriedTables: string[] = []
  const calls: Array<{ actor: unknown; target: unknown; action: unknown }> = []
  let guardStatus: 401 | 403 | 404 | null = null
  let session: { token: string | null; callerId: string | null } = { token: 'report-access-token', callerId: 'patient-account' }
  const token = 'report-access-token'
  const cookieName = 'pip_session'

  function visibleRows(table: string, filters: Array<[string, unknown]>, ordered: boolean): Row[] {
    const tableRows = table === 'reports' ? rows : table === 'providers' ? providerRows : adminRows
    let selected = tableRows.filter((row) => filters.every(([column, value]) => row[column] === value))
    // The fake is deliberately RLS-shaped: only rows explicitly marked as
    // visible reach this client, independently of a route's predicates.
    selected = selected.filter((row) => row.visible !== false)
    if (ordered) selected = [...selected].sort((a, b) => String(b.signed_at).localeCompare(String(a.signed_at)))
    return selected
  }

  const anon = vi.fn((accessToken: string) => {
    void accessToken
    return {
    from(table: string) {
      if (!['reports', 'providers', 'staff_admins'].includes(table)) throw new Error(`unexpected table ${table}`)
      queriedTables.push(table)
      const filters: Array<[string, unknown]> = []
      let ordered = false
      const query = {
        select(columns: string) {
          void columns
          return query
        },
        eq(column: string, value: unknown) {
          filters.push([column, value])
          return query
        },
        order(column: string, options: { ascending?: boolean }) {
          expect(column).toBe('signed_at')
          expect(options).toEqual({ ascending: false })
          ordered = true
          return query
        },
        async maybeSingle() {
          const selected = visibleRows(table, filters, ordered)
          return { data: selected[0] ?? null, error: null }
        },
        then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          try {
            resolve({ data: visibleRows(table, filters, ordered), error: null })
          } catch (error) {
            reject(error)
          }
        },
      }
      return query
    },
  }
  })

  return {
    reportRows: rows,
    fromTables: queriedTables,
    guardCalls: calls,
    anonClientMock: anon,
    guardPhiAccessMock: vi.fn(async (actor: unknown, target: unknown, action: unknown) => {
      calls.push({ actor, target, action })
      if (guardStatus !== null) return { ok: false, status: guardStatus }
      const reportId = (target as { kind?: string; id?: string }).kind === 'report' ? (target as { id?: string }).id : undefined
      const report = rows.find((row) => row.id === reportId)
      if ((actor as { kind?: string }).kind === 'patient' && report?.status === 'preliminary') return { ok: false, status: 404 }
      return { ok: true, patientId: 'patient-1' }
    }),
    setGuardStatus: (status: 401 | 403 | 404 | null) => {
      guardStatus = status
    },
    setSession: (next: { token: string | null; callerId: string | null }) => {
      session = next
    },
    setActorKind: (kind: 'patient' | 'provider' | 'admin', userId: string) => {
      providerRows.length = 0
      adminRows.length = 0
      if (kind === 'provider') providerRows.push({ id: 'provider-1', user_id: userId })
      if (kind === 'admin') adminRows.push({ id: 'admin-1', user_id: userId })
    },
    resetFake: () => {
      rows.length = 0
      providerRows.length = 0
      adminRows.length = 0
      queriedTables.length = 0
      calls.length = 0
      guardStatus = null
      session = { token, callerId: 'patient-account' }
      anon.mockClear()
    },
    getSession: () => session,
    FAKE_ACCESS_TOKEN: token,
    FAKE_SESSION_COOKIE_NAME: cookieName,
  }
})

vi.mock('../../lib/access/guard', () => ({ guardPhiAccess: guardPhiAccessMock }))
vi.mock('../../lib/db/client', () => ({ anonClient: anonClientMock }))
vi.mock('../../lib/access/identity', () => ({ resolveCallerId: async () => getSession().callerId }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: FAKE_SESSION_COOKIE_NAME }))
vi.mock('../../lib/validation', () => ({
  uuidSchema: {},
  parseParams: (_schema: unknown, params: { reportId?: string }) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.reportId ?? '')
      ? { ok: true, value: { reportId: params.reportId } }
      : {
          ok: false,
          response: new Response(JSON.stringify({ error: 'validation_failed', message: 'The request could not be validated.' }), {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          }),
        },
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === FAKE_SESSION_COOKIE_NAME && getSession().token ? { value: getSession().token } : undefined),
  }),
}))

import { listReports } from '../../lib/reports/reports'
import { GET as listRoute } from '../../app/api/reports/route'
import { GET as detailRoute } from '../../app/api/reports/[reportId]/route'

const REPORT_A = '11111111-1111-4111-8111-111111111111'
const REPORT_B = '22222222-2222-4222-8222-222222222222'

function seedSigned(id: string, signedAt: string, visible = true): void {
  reportRows.push({
    id,
    study_id: `study-${id.slice(0, 1)}`,
    status: 'signed',
    signed_at: signedAt,
    findings: 'Findings',
    impression: 'Impression',
    studies: { description: 'Study description' },
    patients: { patient_ref: 'PT-1001', full_name: 'Never returned', date_of_birth: '1988-01-01' },
    providers: { full_name: 'Dr. Rivera' },
    visible,
  })
}

function seedPreliminary(id: string): void {
  reportRows.push({
    id,
    study_id: 'study-preliminary',
    status: 'preliminary',
    signed_at: null,
    findings: 'Preliminary findings',
    impression: 'Preliminary impression',
    studies: { description: 'Preliminary study' },
    patients: { patient_ref: 'PT-1001', full_name: 'Never returned', date_of_birth: '1988-01-01' },
    providers: null,
  })
}

beforeEach(() => {
  resetFake()
})

function configureSession(session: { token: string | null; callerId: string | null }): void {
  setSession(session)
}

describe('reports', () => {
  test('oneAuditRowForReportListRequest', async function oneAuditRowForReportListRequest() {
    seedSigned(REPORT_A, '2026-08-16T10:00:00.000Z')

    const response = await listRoute()

    expect(response.status).toBe(200)
    expect(guardCalls).toEqual([
      { actor: { kind: 'patient', userId: 'patient-account' }, target: { kind: 'collection', of: 'report' }, action: 'report.view' },
    ])
    expect(anonClientMock).toHaveBeenCalledOnce()
    expect(anonClientMock).toHaveBeenCalledWith(FAKE_ACCESS_TOKEN)
  })

  test('rlsCrossPatientIsolationInList', async function rlsCrossPatientIsolationInList() {
    seedSigned(REPORT_A, '2026-08-16T10:00:00.000Z')
    seedSigned(REPORT_B, '2026-08-16T11:00:00.000Z', false)

    const result = await listReports({ kind: 'patient', userId: 'patient-account' }, FAKE_ACCESS_TOKEN)

    expect(result).toEqual({ ok: true, value: [{ id: REPORT_A, studyId: 'study-1', studyDescription: 'Study description', signedAt: '2026-08-16T10:00:00.000Z' }] })
  })

  test('signedOnlyListConsistency', async function signedOnlyListConsistency() {
    seedSigned(REPORT_A, '2026-08-16T10:00:00.000Z')
    seedSigned(REPORT_B, '2026-08-16T11:00:00.000Z')
    seedPreliminary('33333333-3333-4333-8333-333333333333')

    const result = await listReports({ kind: 'patient', userId: 'patient-account' }, FAKE_ACCESS_TOKEN)

    expect(result.ok && result.value.map((report) => report.id)).toEqual([REPORT_B, REPORT_A])
  })

  test('patientPreliminaryDirectReadIs404', async function patientPreliminaryDirectReadIs404() {
    seedPreliminary(REPORT_A)
    setGuardStatus(404)

    const response = await detailRoute(new Request(`http://test/api/reports/${REPORT_A}`), { params: Promise.resolve({ reportId: REPORT_A }) })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found', message: 'The requested report could not be found.' })
    expect(fromTables).not.toContain('reports')
  })

  test('providerAndAdminCanReadPreliminary', async function providerAndAdminCanReadPreliminary() {
    seedPreliminary(REPORT_A)

    configureSession({ token: FAKE_ACCESS_TOKEN, callerId: 'provider-account' })
    setActorKind('provider', 'provider-account')
    const provider = await detailRoute(new Request(`http://test/api/reports/${REPORT_A}`), { params: Promise.resolve({ reportId: REPORT_A }) })

    configureSession({ token: FAKE_ACCESS_TOKEN, callerId: 'admin-account' })
    setActorKind('admin', 'admin-account')
    const admin = await detailRoute(new Request(`http://test/api/reports/${REPORT_A}`), { params: Promise.resolve({ reportId: REPORT_A }) })

    expect(provider.status).toBe(200)
    expect(admin.status).toBe(200)
    expect(await provider.json()).toEqual(expect.objectContaining({ id: REPORT_A, signedAt: null, signedByName: null }))
    expect(await admin.json()).toEqual(expect.objectContaining({ id: REPORT_A, signedAt: null, signedByName: null }))
    expect(guardCalls).toEqual([
      { actor: { kind: 'provider', userId: 'provider-account' }, target: { kind: 'report', id: REPORT_A }, action: 'report.view' },
      { actor: { kind: 'admin', userId: 'admin-account' }, target: { kind: 'report', id: REPORT_A }, action: 'report.view' },
    ])
  })

  test('malformedReportIdIsValidationFailed', async function malformedReportIdIsValidationFailed() {
    const response = await detailRoute(new Request('http://test/api/reports/not-a-uuid'), { params: Promise.resolve({ reportId: 'not-a-uuid' }) })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
    expect(guardCalls).toHaveLength(0)
  })

  test('noSessionAndUnlinkedIdentityResponses', async function noSessionAndUnlinkedIdentityResponses() {
    configureSession({ token: null, callerId: null })
    const noSession = await listRoute()

    configureSession({ token: FAKE_ACCESS_TOKEN, callerId: 'patient-account' })
    setGuardStatus(403)
    const unlinked = await listRoute()

    expect(noSession.status).toBe(401)
    expect(await noSession.json()).toEqual({ error: 'session_required', message: 'Sign in to continue.' })
    expect(unlinked.status).toBe(403)
    expect(await unlinked.json()).toEqual({ error: 'identity_verification_required', message: 'Verify your identity to continue.' })
  })

  test('responseDataMinimization', async function responseDataMinimization() {
    seedSigned(REPORT_A, '2026-08-16T10:00:00.000Z')

    const listResponse = await listRoute()
    const detailResponse = await detailRoute(new Request(`http://test/api/reports/${REPORT_A}`), { params: Promise.resolve({ reportId: REPORT_A }) })
    const list = await listResponse.json()
    const detail = await detailResponse.json()

    expect(Object.keys(list.reports[0]).sort()).toEqual(['id', 'signedAt', 'studyDescription', 'studyId'])
    expect(Object.keys(detail).sort()).toEqual(['findings', 'id', 'impression', 'patientRef', 'signedAt', 'signedByName', 'studyDescription', 'studyId'])
    expect(JSON.stringify({ list, detail })).not.toMatch(/Never returned|1988-01-01|"status"/)
  })
})

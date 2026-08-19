import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

vi.mock('server-only', () => ({}))
type Row = Record<string, unknown>
const { state, serviceMock, cookieMock, signMock } = vi.hoisted(() => ({
  state: { rows: {} as Record<string, Row[]>, persist: (async () => {}) as (row: Row) => Promise<void> },
  serviceMock: vi.fn(), cookieMock: vi.fn(), signMock: vi.fn(),
}))
vi.mock('../../lib/db/client', () => ({ serviceClient: serviceMock }))
vi.mock('next/headers', () => ({ cookies: cookieMock }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('../../lib/imaging/signing', () => ({ signStorageKeys: signMock }))
vi.mock('../../lib/config', () => ({ config: { signedUrlTtlSeconds: 300 } }))

const LINK = '11111111-1111-4111-8111-111111111111'
const PATIENT = '22222222-2222-4222-8222-222222222222'
const IMAGE = '33333333-3333-4333-8333-333333333333'
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

class Query {
  filters: Array<[string, unknown]> = []
  constructor(readonly table: string) {}
  select() { return this }
  eq(k: string, v: unknown) { this.filters.push([k, v]); return this }
  async insert(row: Row) { if (this.table === 'audit_events') await state.persist(row); return { error: null } }
  async maybeSingle() { return { data: (state.rows[this.table] ?? []).find((row) => this.filters.every(([k, v]) => row[k] === v)) ?? null, error: null } }
}
const client = () => ({ from: (table: string) => new Query(table) }) as never
let run: Run
const lit = (v: unknown) => v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`
function psql(sql: string) { return execFileSync('docker', ['exec', 'pip-testpg', 'psql', '-U', 'postgres', '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql], { encoding: 'utf8' }).trim() }
function audits() { const out = psql("select action||'|'||outcome||'|'||coalesce(target_id::text,'-') from audit_events order by id;"); return out ? out.split('\n') : [] }

beforeAll(async () => { run = await startRun(await ensureContainer()); state.persist = async (row) => { psql(`insert into audit_events(actor_kind,actor_ref,action,target_kind,target_id,outcome) values(${lit(row.actor_kind)},${lit(row.actor_ref)},${lit(row.action)},${lit(row.target_kind)},${lit(row.target_id)},${lit(row.outcome)});`) } })
afterAll(async () => stopRun(run))
beforeEach(() => {
  psql('truncate audit_events restart identity;')
  state.rows = { share_links: [], images: [{ id: IMAGE, width: 10, height: 20, ordinal: 1, storage_key: 'image-key', thumb_key: null }] }
  serviceMock.mockReset().mockImplementation(client)
  cookieMock.mockReset().mockResolvedValue({ get: () => ({ value: 'unrelated-patient-session' }) })
  signMock.mockReset().mockImplementation(async (keys: string[]) => keys.map((key) => ({ key, url: `https://signed.example/${key}`, available: true })))
})

import { GET as resolveShare } from '../../app/api/s/[token]/route'
const request = (token: string) => resolveShare(new Request(`https://portal.example/api/s/${token}`), { params: Promise.resolve({ token }) })

describe('bearer share-token public HTTP behavior', () => {
  test('unknownExpiredAndRevokedTokensAreByteIdenticalAndContainNoPayload', async function unknownExpiredAndRevokedTokensAreByteIdenticalAndContainNoPayload() {
    state.rows.share_links.push(
      { id: LINK, patient_id: PATIENT, image_id: IMAGE, report_id: null, token_hash: hash('expired-token'), expires_at: '2020-01-01T00:00:00Z', revoked_at: null },
      { id: LINK, patient_id: PATIENT, image_id: IMAGE, report_id: null, token_hash: hash('revoked-token'), expires_at: '2099-01-01T00:00:00Z', revoked_at: '2026-01-01T00:00:00Z' },
    )
    const responses = await Promise.all(['unknown-token', 'expired-token', 'revoked-token'].map(request))
    const bodies = await Promise.all(responses.map((response) => response.text()))
    expect(responses.map((response) => response.status)).toEqual([410, 410, 410])
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ error: 'share_unavailable', message: 'This link is no longer available.' })]))
    expect(bodies.join('')).not.toMatch(/payload|signed\.example|image-key/)
    expect(signMock).not.toHaveBeenCalled()
  })

  test('validBearerTokenWorksDespiteUnrelatedAmbientSessionAndAuditsRecipientOnce', async function validBearerTokenWorksDespiteUnrelatedAmbientSessionAndAuditsRecipientOnce() {
    state.rows.share_links.push({ id: LINK, patient_id: PATIENT, image_id: IMAGE, report_id: null, token_hash: hash('valid-token'), expires_at: '2099-01-01T00:00:00Z', revoked_at: null })
    const response = await request('valid-token')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ resourceKind: 'image', payload: { id: IMAGE } })
    expect(audits()).toEqual([`share.use|granted|${IMAGE}`])
  })
})

import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

vi.mock('server-only', () => ({}))
type Row = Record<string, unknown>
const { state, anonMock, authMock, serviceMock, cookieMock } = vi.hoisted(() => ({
  state: { token: '', userId: '', tables: {} as Record<string, Row[]>, persist: (async () => {}) as (row: Row) => Promise<void> },
  anonMock: vi.fn(), authMock: vi.fn(), serviceMock: vi.fn(), cookieMock: vi.fn(),
}))
vi.mock('../../lib/db/client', () => ({ anonClient: anonMock, authClient: authMock, serviceClient: serviceMock }))
vi.mock('next/headers', () => ({ cookies: cookieMock }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('../../lib/imaging/signing', () => ({ signStorageKeys: vi.fn(async (keys: string[]) => keys.map((key) => ({ key, url: `https://signed.example/${key}`, available: true }))) }))
vi.mock('../../lib/config', () => ({ config: { appBaseUrl: 'https://portal.example', identityLockoutMinutes: 5, identityMaxAttempts: 3, maxRequestBodyBytes: 65_536, minChangeNoticeHours: 24, shareLinkTtlHours: 48, signedUrlTtlSeconds: 300, sourceRefSalt: 'test-salt' } }))

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111', PATIENT_A = '22222222-2222-4222-8222-222222222222'
const PATIENT_B = '33333333-3333-4333-8333-333333333333', PROVIDER_ACCOUNT = '44444444-4444-4444-8444-444444444444'
const PROVIDER_A = '55555555-5555-4555-8555-555555555555', PROVIDER_B = '66666666-6666-4666-8666-666666666666'
const OWNED_STUDY = '70000000-0000-4000-8000-000000000001', FOREIGN_STUDY = '70000000-0000-4000-8000-000000000011'
const OWNED_CLIP = '71000000-0000-4000-8000-000000000001', FOREIGN_CLIP = '71000000-0000-4000-8000-000000000011'
const OWNED_REPORT = '72000000-0000-4000-8000-000000000001', FOREIGN_REPORT = '72000000-0000-4000-8000-000000000011'
const PRELIM_REPORT = '72000000-0000-4000-8000-000000000012', OWNED_APPT = '73000000-0000-4000-8000-000000000001', FOREIGN_APPT = '73000000-0000-4000-8000-000000000011'
const FOREIGN_IMAGE = '74000000-0000-4000-8000-000000000011', FOREIGN_SHARE = '75000000-0000-4000-8000-000000000011'
const VISIT_A = '76000000-0000-4000-8000-000000000001', VISIT_B = '76000000-0000-4000-8000-000000000011'
const FRESH_ACCOUNT = '77000000-0000-4000-8000-000000000001'
const MISSING_STUDY = '70000000-0000-4000-8000-000000000021', MISSING_CLIP = '71000000-0000-4000-8000-000000000021'
const MISSING_REPORT = '72000000-0000-4000-8000-000000000021', MISSING_APPT = '73000000-0000-4000-8000-000000000021'

class Query {
  filters: Array<[string, unknown]> = []; op: 'select' | 'insert' | 'update' = 'select'; payload: Row = {}; head = false
  constructor(readonly table: string) {}
  select(_columns?: string, options?: { head?: boolean }) { this.head = options?.head === true; return this }
  eq(k: string, v: unknown) { this.filters.push([k, v]); return this }
  gte(k: string, v: unknown) { this.filters.push([k, { gte: v }]); return this }
  lt(k: string, v: unknown) { this.filters.push([k, { lt: v }]); return this }
  in(k: string, v: unknown[]) { this.filters.push([k, { in: v }]); return this }
  order() { return this } limit() { return this }
  insert(v: Row) { this.op = 'insert'; this.payload = v; return this }
  update(v: Row) { this.op = 'update'; this.payload = v; return this }
  match(row: Row) { return this.filters.every(([k, v]) => typeof v === 'object' && v !== null && 'gte' in v ? String(row[k]) >= String(v.gte) : typeof v === 'object' && v !== null && 'lt' in v ? String(row[k]) < String(v.lt) : typeof v === 'object' && v !== null && 'in' in v ? (v.in as unknown[]).includes(row[k]) : row[k] === v) }
  async execute() {
    if (this.op === 'insert') { if (this.table === 'audit_events') await state.persist(this.payload); const row = { id: this.payload.id ?? crypto.randomUUID(), ...this.payload }; (state.tables[this.table] ??= []).push(row); return { data: row, error: null } }
    let rows = (state.tables[this.table] ?? []).filter((row) => this.match(row))
    if (this.table === 'appointments' && this.filters.length === 0) {
      const patient = state.tables.patients.find((row) => row.user_id === state.userId)
      if (patient) rows = rows.filter((row) => row.patient_id === patient.id)
    }
    if (this.op === 'update') rows.forEach((row) => Object.assign(row, this.payload)); return this.head ? { data: null, error: null, count: rows.length } : { data: rows, error: null }
  }
  async maybeSingle() { const r = await this.execute(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data } }
  async single() { return this.maybeSingle() }
  then<TResult1 = { data: unknown; error: null }>(ok?: ((v: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null) { return this.execute().then(ok ?? undefined) }
}
function client() { return { from: (table: string) => new Query(table), async rpc(name: string, input: Row) { if (name !== 'link_patient_identity') throw new Error(name); const patient = state.tables.patients.find((r) => r.id === input.p_patient_id); if (!patient || patient.user_id) return { data: 'claimed_by_other', error: null }; patient.user_id = input.p_caller_id; state.tables.identity_attempts.push({ user_id: input.p_caller_id, succeeded: true, attempted_at: input.p_attempted_at }); return { data: 'linked_now', error: null } } } as never }

let run: Run
function psql(sql: string) { return execFileSync('docker', ['exec', 'pip-testpg', 'psql', '-U', 'postgres', '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql], { encoding: 'utf8' }).trim() }
const lit = (v: unknown) => v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`
function audits() { const out = psql("select action||'|'||outcome||'|'||coalesce(target_id::text,'-') from audit_events order by id;"); return out ? out.split('\n') : [] }
function session(userId: string | null, token = 'caller-token') { state.userId = userId ?? ''; state.token = userId ? token : '' }
function fixtures(): Record<string, Row[]> { return {
  patients: [{ id: PATIENT_A, user_id: ACCOUNT_A, patient_ref: 'PT-0001', date_of_birth: '1980-01-01' }, { id: PATIENT_B, user_id: null, patient_ref: 'PT-0002', date_of_birth: '1990-02-02' }],
  providers: [{ id: PROVIDER_A, user_id: PROVIDER_ACCOUNT, full_name: 'Provider A', time_zone: 'America/Chicago' }, { id: PROVIDER_B, user_id: '88888888-8888-4888-8888-888888888888', full_name: 'Provider B', time_zone: 'America/Chicago' }], staff_admins: [],
  visits: [{ id: VISIT_A, patient_id: PATIENT_A, provider_id: PROVIDER_A, status: 'completed', occurred_at: '2026-01-01T12:00:00Z' }, { id: VISIT_B, patient_id: PATIENT_B, provider_id: PROVIDER_B, status: 'completed', occurred_at: '2026-01-02T12:00:00Z' }],
  studies: [{ id: OWNED_STUDY, patient_id: PATIENT_A, visit_id: VISIT_A, description: 'Owned' }, { id: FOREIGN_STUDY, patient_id: PATIENT_B, visit_id: VISIT_B, description: 'Foreign' }],
  cine_clips: [{ id: OWNED_CLIP, patient_id: PATIENT_A, study_id: OWNED_STUDY, frame_count: 1, default_fps: 12, poster_key: null }, { id: FOREIGN_CLIP, patient_id: PATIENT_B, study_id: FOREIGN_STUDY, frame_count: 1, default_fps: 12, poster_key: null }], cine_frames: [], images: [{ id: FOREIGN_IMAGE, patient_id: PATIENT_B, study_id: FOREIGN_STUDY, width: 10, height: 10, ordinal: 0, storage_key: 'foreign', thumb_key: null }],
  reports: [{ id: OWNED_REPORT, patient_id: PATIENT_A, study_id: OWNED_STUDY, status: 'signed', findings: 'owned', impression: 'owned', signed_at: '2026-01-01T13:00:00Z', studies: { description: 'Owned' }, patients: { patient_ref: 'PT-0001' }, providers: { full_name: 'Provider A' } }, { id: FOREIGN_REPORT, patient_id: PATIENT_B, study_id: FOREIGN_STUDY, status: 'signed', findings: 'private', impression: 'private', signed_at: '2026-01-02T13:00:00Z', studies: { description: 'Foreign' }, patients: { patient_ref: 'PT-0002' }, providers: { full_name: 'Provider B' } }, { id: PRELIM_REPORT, patient_id: PATIENT_B, study_id: FOREIGN_STUDY, status: 'preliminary', findings: 'draft', impression: 'draft', signed_at: null, studies: { description: 'Foreign' }, patients: { patient_ref: 'PT-0002' }, providers: null }],
  appointments: [
    { id: OWNED_APPT, patient_id: PATIENT_A, provider_id: PROVIDER_A, status: 'requested', out_of_hours: false, slots: { starts_at: '2026-08-21T12:00:00Z', ends_at: '2026-08-21T12:30:00Z' }, providers: { full_name: 'Provider A', time_zone: 'America/Chicago' }, services: { name: 'Imaging' } },
    { id: FOREIGN_APPT, patient_id: PATIENT_B, provider_id: PROVIDER_B, status: 'requested', out_of_hours: false, slots: { starts_at: '2026-08-22T12:00:00Z', ends_at: '2026-08-22T12:30:00Z' }, providers: { full_name: 'Provider B', time_zone: 'America/Chicago' }, services: { name: 'Imaging' } },
  ], share_links: [{ id: FOREIGN_SHARE, patient_id: PATIENT_B, image_id: FOREIGN_IMAGE, report_id: null, revoked_at: null }], identity_attempts: [], audit_events: [],
} }

beforeAll(async () => { run = await startRun(await ensureContainer()); state.persist = async (row) => { psql(`insert into audit_events(actor_kind,actor_ref,action,target_kind,target_id,outcome) values(${lit(row.actor_kind)},${lit(row.actor_ref)},${lit(row.action)},${lit(row.target_kind)},${lit(row.target_id)},${lit(row.outcome)});`) } })
afterAll(async () => stopRun(run))
beforeEach(() => { state.tables = fixtures(); session(ACCOUNT_A); psql('truncate audit_events restart identity;'); anonMock.mockReset().mockImplementation(client); serviceMock.mockReset().mockImplementation(client); authMock.mockReset().mockImplementation(() => ({ auth: { async getUser(token: string) { return token === state.token && state.userId ? { data: { user: { id: state.userId } }, error: null } : { data: { user: null }, error: { status: 401 } } }, async signUp() { return { data: { user: { id: FRESH_ACCOUNT, identities: [{}] }, session: null }, error: null } } } })); cookieMock.mockReset().mockImplementation(async () => ({ get: () => state.token ? { value: state.token } : undefined })) })

import { POST as register } from '../../app/api/auth/register/route'
import { PATCH as patchAppointment } from '../../app/api/appointments/[id]/route'
import { GET as appointments } from '../../app/api/appointments/route'
import { POST as verify } from '../../app/api/identity/verify/route'
import { GET as schedule } from '../../app/api/provider/schedule/route'
import { GET as report } from '../../app/api/reports/[reportId]/route'
import { GET as reports } from '../../app/api/reports/route'
import { DELETE as deleteShare } from '../../app/api/shares/[id]/route'
import { POST as share } from '../../app/api/shares/route'
import { GET as clip } from '../../app/api/studies/[studyId]/clips/[clipId]/route'
import { GET as study } from '../../app/api/studies/[studyId]/route'
import { GET as studies } from '../../app/api/studies/route'
const ctx = <T extends Record<string, string>>(v: T): { params: Promise<T> } => ({ params: Promise.resolve(v) })
const json = (url: string, method: string, body: unknown) => new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('cross-patient public HTTP denials', () => {
  test('verifiedPatientAppointmentCollectionExcludesForeignRowsAndAuditsOnce', async function verifiedPatientAppointmentCollectionExcludesForeignRowsAndAuditsOnce() {
    const response = await appointments()
    expect(response.status).toBe(200)
    expect((await response.json() as { appointments: Array<{ id: string }> }).appointments.map(({ id }) => id)).toEqual([OWNED_APPT])
    expect(audits()).toEqual(['appointment.view|granted|-'])
    expect(psql('select count(*) from audit_events where detail is not null;')).toBe('0')
  })
  test('foreignStudyClipReportAndAppointmentIdsAtLeastTenIncrementsAwayReturn404', async function foreignStudyClipReportAndAppointmentIdsAtLeastTenIncrementsAwayReturn404() {
    const before = state.tables.appointments.find((appointment) => appointment.id === FOREIGN_APPT)?.status
    const responses = [
      await study(new Request('https://x'), ctx({ studyId: FOREIGN_STUDY })), await study(new Request('https://x'), ctx({ studyId: MISSING_STUDY })),
      await clip(new Request('https://x'), ctx({ studyId: FOREIGN_STUDY, clipId: FOREIGN_CLIP })), await clip(new Request('https://x'), ctx({ studyId: OWNED_STUDY, clipId: MISSING_CLIP })),
      await report(new Request('https://x'), ctx({ reportId: FOREIGN_REPORT })), await report(new Request('https://x'), ctx({ reportId: MISSING_REPORT })),
      await patchAppointment(json('https://x', 'PATCH', { action: 'cancel' }), ctx({ id: FOREIGN_APPT })), await patchAppointment(json('https://x', 'PATCH', { action: 'cancel' }), ctx({ id: MISSING_APPT })),
    ]
    const bodies = await Promise.all(responses.map((response) => response.text()))
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(404))
    expect([bodies[0], bodies[2], bodies[6]]).toEqual(Array(3).fill(JSON.stringify({ error: 'not_found', message: 'The requested resource was not found.' })))
    expect(bodies[4]).toBe(JSON.stringify({ error: 'not_found', message: 'The requested report could not be found.' }))
    expect(bodies[1]).toBe(bodies[0]); expect(bodies[3]).toBe(bodies[2]); expect(bodies[5]).toBe(bodies[4]); expect(bodies[7]).toBe(bodies[6])
    expect(state.tables.appointments.find((appointment) => appointment.id === FOREIGN_APPT)?.status).toBe(before)
    expect(audits()).toEqual([
      `study.view|denied|${FOREIGN_STUDY}`, `study.view|denied|${MISSING_STUDY}`,
      `clip.view|denied|${FOREIGN_CLIP}`, `clip.view|denied|${MISSING_CLIP}`,
      `report.view|denied|${FOREIGN_REPORT}`, `report.view|denied|${MISSING_REPORT}`,
      `appointment.view|denied|${FOREIGN_APPT}`, `appointment.view|denied|${MISSING_APPT}`,
    ])
    expect(psql('select count(*) from audit_events where detail is not null;')).toBe('0')
  })
  test('foreignShareResourcesAndLinkAreNotCreatedOrRevoked', async function foreignShareResourcesAndLinkAreNotCreatedOrRevoked() {
    const count = state.tables.share_links.length
    const responses = [await share(json('https://x', 'POST', { resourceKind: 'image', resourceId: FOREIGN_IMAGE, recipientEmail: 'r@example.com' })), await share(json('https://x', 'POST', { resourceKind: 'report', resourceId: FOREIGN_REPORT, recipientEmail: 'r@example.com' })), await share(json('https://x', 'POST', { resourceKind: 'clip', resourceId: FOREIGN_CLIP, recipientEmail: 'r@example.com' })), await deleteShare(new Request('https://x', { method: 'DELETE' }), ctx({ id: FOREIGN_SHARE }))]
    expect(responses.map((r) => r.status)).toEqual([404, 404, 422, 404]); expect(state.tables.share_links).toHaveLength(count); expect(state.tables.share_links[0]?.revoked_at).toBeNull()
    expect(audits()).toEqual([`share.create|denied|${FOREIGN_IMAGE}`, `share.create|denied|${FOREIGN_REPORT}`, `share.revoke|denied|${FOREIGN_SHARE}`])
    expect(psql('select count(*) from audit_events where detail is not null;')).toBe('0')
    psql(`insert into auth.users(id) values('${ACCOUNT_A}'); insert into patients(id,user_id,patient_ref,date_of_birth,full_name,email) values('${PATIENT_A}','${ACCOUNT_A}','PT-9001','1980-01-01','A','a@example.com'),('${PATIENT_B}',null,'PT-9002','1990-01-01','B','b@example.com'); insert into providers(id,full_name,time_zone) values('${PROVIDER_B}','Provider','America/Chicago'); insert into visits(id,patient_id,provider_id,occurred_at,status) values('${VISIT_B}','${PATIENT_B}','${PROVIDER_B}',now(),'completed'); insert into studies(id,visit_id,patient_id,description) values('${FOREIGN_STUDY}','${VISIT_B}','${PATIENT_B}','foreign'); insert into images(id,study_id,patient_id,storage_key,width,height,ordinal) values('${FOREIGN_IMAGE}','${FOREIGN_STUDY}','${PATIENT_B}','opaque',10,10,0);`)
    expect(() => psql(`insert into share_links(token_hash,patient_id,image_id,created_by,recipient_email,expires_at) values('${'a'.repeat(64)}','${PATIENT_A}','${FOREIGN_IMAGE}','${ACCOUNT_A}','r@example.com',now()+interval '48 hours');`)).toThrow()
    expect(psql('select count(*) from share_links;')).toBe('0')
  })
  test('providerForeignScheduleStudyReportAndAppointmentReturn404', async function providerForeignScheduleStudyReportAndAppointmentReturn404() {
    session(PROVIDER_ACCOUNT, 'provider-token')
    const responses = [await schedule(new Request(`https://x?date=2026-08-20&providerId=${PROVIDER_B}`)), await study(new Request('https://x'), ctx({ studyId: FOREIGN_STUDY })), await report(new Request('https://x'), ctx({ reportId: FOREIGN_REPORT })), await patchAppointment(json('https://x', 'PATCH', { action: 'cancel' }), ctx({ id: FOREIGN_APPT }))]
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]); expect(audits()).toEqual([`schedule.view|denied|${PROVIDER_B}`, `study.view|denied|${FOREIGN_STUDY}`, `report.view|denied|${FOREIGN_REPORT}`, `appointment.view|denied|${FOREIGN_APPT}`])
    expect(psql('select count(*) from audit_events where detail is not null;')).toBe('0')
  })
  test('unlinkedAndAnonymousRequestsRemainDistinctAndAuditedOnce', async function unlinkedAndAnonymousRequestsRemainDistinctAndAuditedOnce() {
    session(FRESH_ACCOUNT, 'fresh-token'); const unlinked = await study(new Request('https://x'), ctx({ studyId: OWNED_STUDY })); session(null); const anonymous = await study(new Request('https://x'), ctx({ studyId: OWNED_STUDY }))
    expect(unlinked.status).toBe(403); expect(await unlinked.json()).toMatchObject({ error: 'identity_verification_required' }); expect(anonymous.status).toBe(401); expect(await anonymous.json()).toMatchObject({ error: 'session_required' }); expect(audits()).toEqual([`study.view|denied|${OWNED_STUDY}`, `study.view|denied|${OWNED_STUDY}`])
    expect(psql('select count(*) from audit_events where detail is not null;')).toBe('0')
  })
})

describe('fresh-account positive case', () => {
  test('freshlyRegisteredAccountVerifiesThenReadsOwnStudiesAndSignedReports', async function freshlyRegisteredAccountVerifiesThenReadsOwnStudiesAndSignedReports() {
    expect((await register(json('https://x', 'POST', { email: 'fresh@example.com', password: 'StrongPass!2026' }))).status).toBe(201); session(FRESH_ACCOUNT, 'fresh-token')
    expect((await study(new Request('https://x'), ctx({ studyId: FOREIGN_STUDY }))).status).toBe(403)
    expect((await verify(json('https://x', 'POST', { patientRef: 'PT-0002', dateOfBirth: '1990-02-02' }))).status).toBe(200)
    const ownStudies = await studies(), ownReports = await reports(), signed = await report(new Request('https://x'), ctx({ reportId: FOREIGN_REPORT })), preliminary = await report(new Request('https://x'), ctx({ reportId: PRELIM_REPORT }))
    expect(ownStudies.status).toBe(200); expect((await ownStudies.json() as { studies: unknown[] }).studies.length).toBeGreaterThan(0); expect(ownReports.status).toBe(200); expect((await ownReports.json() as { reports: unknown[] }).reports.length).toBeGreaterThan(0); expect(signed.status).toBe(200); expect(preliminary.status).toBe(404)
    expect(audits()).toEqual([
      `study.view|denied|${FOREIGN_STUDY}`, `identity.verify|granted|${PATIENT_B}`,
      `identity.link|granted|${PATIENT_B}`, 'study.view|granted|-', 'report.view|granted|-',
      `report.view|granted|${FOREIGN_REPORT}`, `report.view|denied|${PRELIM_REPORT}`,
    ])
    expect(psql('select count(*) from audit_events where detail is not null;')).toBe('0')
  })
})

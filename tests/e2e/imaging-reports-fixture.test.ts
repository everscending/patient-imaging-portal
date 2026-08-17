// JOR-289 — live fake-service evidence for the E3/E4 imaging successors.
// These tests exercise the fixture's actual HTTP contract; they do not replace
// any product response, route, or guard.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import {
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_STUDY_ID,
  E3_MISSING_CINE_FRAME_INDEX,
  E3_MISSING_CINE_FRAME_STORAGE_KEY,
  E3_SCHEDULED_VISIT_ID,
  E3_SCHEDULED_STUDY_ID,
  E4_CANCELLED_VISIT_ID,
  E4_CANCELLED_STUDY_ID,
  E4_PRELIMINARY_REPORT_ID,
  startFakeAuthServer,
  type FakeAuthServer,
} from '../../e2e/fixtures/fake-auth-server'

type Row = Record<string, unknown>

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let server: FakeAuthServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function request(path: string, init?: RequestInit): Promise<Response> {
  if (!server) server = await startFakeAuthServer()
  return fetch(`${server.url}${path}`, init)
}

async function linkedPatientToken(patientRef: string): Promise<string> {
  const signup = await request('/auth/v1/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `jor-289-${randomUUID()}@example.test`, password: 'FixturePassword9' }),
  })
  const created = (await signup.json()) as { access_token: string; user: { id: string } }
  const patients = (await (await request(`/rest/v1/patients?patient_ref=eq.${patientRef}`)).json()) as Array<{ id: string }>
  expect(patients).toHaveLength(1)
  const linked = await request('/rest/v1/rpc/link_patient_identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_patient_id: patients[0]!.id,
      p_caller_id: created.user.id,
      p_attempted_patient_ref: patientRef,
      p_source_ref: 'fixture-test',
      p_attempted_at: '2026-08-17T00:00:00.000Z',
    }),
  })
  expect(await linked.json()).toBe('linked_now')
  return created.access_token
}

async function patientRows(path: string, token: string): Promise<Row[]> {
  const response = await request(path, { headers: { Authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
  return (await response.json()) as Row[]
}

async function patientObject(path: string, token: string): Promise<Row | null> {
  const response = await request(path, {
    headers: {
      Accept: 'application/vnd.pgrst.object+json',
      Authorization: `Bearer ${token}`,
    },
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Row | null
}

describe('JOR-289 live E3/E4 imaging fixture', () => {
  test('acceptance: seeded patient receives completed evidence while scheduled and cancelled successor studies remain identifiable', async () => {
    const token = await linkedPatientToken('PT-4471')
    const [studies, visits] = await Promise.all([
      patientRows('/rest/v1/studies', token),
      patientRows('/rest/v1/visits', token),
    ])

    expect(studies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: E2_SEEDED_STUDY_ID,
        visit_id: '77447744-7744-4744-8744-774477447744',
        description: 'Seeded abdominal ultrasound',
      }),
      expect.objectContaining({ id: E3_SCHEDULED_STUDY_ID, visit_id: E3_SCHEDULED_VISIT_ID }),
      expect.objectContaining({ id: E4_CANCELLED_STUDY_ID, visit_id: E4_CANCELLED_VISIT_ID }),
    ]))
    expect(visits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '77447744-7744-4744-8744-774477447744', status: 'completed' }),
      expect.objectContaining({ id: E3_SCHEDULED_VISIT_ID, status: 'scheduled' }),
      expect.objectContaining({ id: E4_CANCELLED_VISIT_ID, status: 'cancelled' }),
    ]))
  })

  test('mandatory adversarial: patientAndForeignIsolationKeepsCineFramesCallerScoped', async () => {
    const seededToken = await linkedPatientToken('PT-4471')
    const foreignToken = await linkedPatientToken('PT-5582')

    const [seededFrames, foreignFrames, foreignStudies, foreignVisits, foreignPreliminary] = await Promise.all([
      patientRows(`/rest/v1/cine_frames?clip_id=eq.${E2_SEEDED_CLIP_ID}&order=frame_index.asc`, seededToken),
      patientRows(`/rest/v1/cine_frames?clip_id=eq.${E2_SEEDED_CLIP_ID}&order=frame_index.asc`, foreignToken),
      patientRows(`/rest/v1/studies?id=eq.${E3_SCHEDULED_STUDY_ID}`, foreignToken),
      patientRows(`/rest/v1/visits?id=eq.${E4_CANCELLED_VISIT_ID}`, foreignToken),
      patientObject(`/rest/v1/reports?id=eq.${E4_PRELIMINARY_REPORT_ID}`, foreignToken),
    ])
    expect(seededFrames.map((frame) => frame.frame_index)).toEqual(Array.from({ length: 100 }, (_, index) => index))
    expect(foreignFrames).toEqual([])
    expect(foreignStudies).toEqual([])
    expect(foreignVisits).toEqual([])
    expect(foreignPreliminary).toBeNull()
  })

  test('mandatory adversarial: exactContiguousFramesAndMissingObjectSigningIsolation', async () => {
    const token = await linkedPatientToken('PT-4471')
    const frames = await patientRows(`/rest/v1/cine_frames?clip_id=eq.${E2_SEEDED_CLIP_ID}&order=frame_index.asc`, token)
    const keys = frames.map((frame) => String(frame.storage_key))
    const response = await request('/storage/v1/object/sign/phi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: keys, expiresIn: 300 }),
    })
    const signed = (await response.json()) as Array<{ path: string; signedURL: string | null; error: string | null }>

    expect(response.status).toBe(200)
    expect(signed).toHaveLength(100)
    expect(new Set(keys)).toHaveLength(100)
    for (const key of keys) expect(key).toMatch(UUID_V4_RE)
    expect('cine-frame-042-missing.png').not.toMatch(UUID_V4_RE)
    expect(keys[E3_MISSING_CINE_FRAME_INDEX]).toBe(E3_MISSING_CINE_FRAME_STORAGE_KEY)
    const missing = signed.filter((entry) => entry.error !== null)
    expect(missing).toEqual([{ path: E3_MISSING_CINE_FRAME_STORAGE_KEY, signedURL: null, error: 'Object not found' }])
    const missingObject = await request(
      `/storage/v1/object/sign/phi/${encodeURIComponent(E3_MISSING_CINE_FRAME_STORAGE_KEY)}?token=e2-fixture`,
    )
    expect(missingObject.status).toBe(404)
    expect((await missingObject.arrayBuffer()).byteLength).toBe(0)
    const available = signed.filter((entry) => entry.error === null)
    expect(available).toHaveLength(99)
    await Promise.all(available.map(async (entry) => {
      const object = await request(`/storage/v1${entry.signedURL!}`)
      expect(object.status).toBe(200)
    }))
  })

  test('mandatory adversarial: preliminaryReportValuesSignedOnlyExclusionAndGuardLookupBehavior', async () => {
    const token = await linkedPatientToken('PT-4471')
    const preliminary = await patientObject(`/rest/v1/reports?id=eq.${E4_PRELIMINARY_REPORT_ID}`, token)
    const signed = await patientRows('/rest/v1/reports?status=eq.signed&order=signed_at.desc', token)

    // The first read is the same caller-scoped row shape guardPhiAccess uses
    // to classify a preliminary report before returning its patient-visible 404.
    expect(preliminary).toEqual(expect.objectContaining({
      id: E4_PRELIMINARY_REPORT_ID,
      status: 'preliminary',
      signed_by: null,
      signed_at: null,
      study_id: E4_CANCELLED_STUDY_ID,
    }))
    expect(signed.map((report) => report.id)).not.toContain(E4_PRELIMINARY_REPORT_ID)
  })

  test('mandatory adversarial: mutableIdentityResetPreservesStableEvidence', async () => {
    const firstToken = await linkedPatientToken('PT-4471')
    const [firstFrames, firstPreliminary] = await Promise.all([
      patientRows(`/rest/v1/cine_frames?clip_id=eq.${E2_SEEDED_CLIP_ID}&order=frame_index.asc`, firstToken),
      patientObject(`/rest/v1/reports?id=eq.${E4_PRELIMINARY_REPORT_ID}`, firstToken),
    ])
    expect((await request('/__test__/reset-identity', { method: 'POST' })).status).toBe(200)

    const resetToken = await linkedPatientToken('PT-4471')
    const [frames, preliminary] = await Promise.all([
      patientRows(`/rest/v1/cine_frames?clip_id=eq.${E2_SEEDED_CLIP_ID}&order=frame_index.asc`, resetToken),
      patientObject(`/rest/v1/reports?id=eq.${E4_PRELIMINARY_REPORT_ID}`, resetToken),
    ])
    expect(frames).toEqual(firstFrames)
    expect(preliminary).toEqual(firstPreliminary)
  })
})

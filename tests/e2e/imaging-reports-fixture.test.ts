// JOR-289 — live fake-service evidence for the E3/E4 imaging successors.
// These tests exercise the fixture's actual HTTP contract; they do not replace
// any product response, route, or guard.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import {
  E2_FOREIGN_CLIP_ID,
  E2_FOREIGN_STUDY_ID,
  E2_PROVIDER_ID,
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_IMAGE_ID,
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
  const created = await accountSession()
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

async function accountSession(): Promise<{ access_token: string; user: { id: string } }> {
  const signup = await request('/auth/v1/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `jor-289-${randomUUID()}@example.test`, password: 'FixturePassword9' }),
  })
  const created = (await signup.json()) as { access_token: string; user: { id: string } }
  expect(signup.status).toBe(200)
  return created
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

async function imagingGrant(kind: 'study' | 'clip', id: string, token: string): Promise<Response> {
  return request('/rest/v1/rpc/grant_patient_imaging_access', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_target_kind: kind, p_target_id: id }),
  })
}

describe('JOR-303 patient imaging access-grant fixture', () => {
  test('linked patient study and clip grants each return ownership and append one correlated audit', async () => {
    const token = await linkedPatientToken('PT-4471')

    const study = await imagingGrant('study', E2_SEEDED_STUDY_ID, token)
    const clip = await imagingGrant('clip', E2_SEEDED_CLIP_ID, token)

    expect(study.status).toBe(200)
    expect(await study.json()).toEqual({ patient_id: '44714471-4471-4471-8471-447144714471', status: 200 })
    expect(clip.status).toBe(200)
    expect(await clip.json()).toEqual({ patient_id: '44714471-4471-4471-8471-447144714471', status: 200 })

    const state = (await (await request('/__test__/identity-state')).json()) as {
      patients: Array<{ patient_ref: string; user_id: string | null }>
      auditEvents: Row[]
    }
    const actorId = state.patients.find((patient) => patient.patient_ref === 'PT-4471')?.user_id
    expect(actorId).toEqual(expect.any(String))
    expect(state.auditEvents).toEqual([
      expect.objectContaining({
        actor_kind: 'account',
        actor_ref: actorId,
        action: 'study.view',
        target_kind: 'study',
        target_id: E2_SEEDED_STUDY_ID,
        outcome: 'granted',
      }),
      expect.objectContaining({
        actor_kind: 'account',
        actor_ref: actorId,
        action: 'clip.view',
        target_kind: 'clip',
        target_id: E2_SEEDED_CLIP_ID,
        outcome: 'granted',
      }),
    ])
  })

  test('unlinked, foreign, and missing targets return opaque denials with one audit each', async () => {
    const unlinked = await accountSession()
    const unlinkedGrant = await imagingGrant('study', E2_SEEDED_STUDY_ID, unlinked.access_token)
    expect(unlinkedGrant.status).toBe(200)
    expect(await unlinkedGrant.json()).toEqual({ patient_id: null, status: 403 })

    const token = await linkedPatientToken('PT-4471')
    const denials = await Promise.all([
      imagingGrant('study', E2_FOREIGN_STUDY_ID, token),
      imagingGrant('study', randomUUID(), token),
      imagingGrant('clip', E2_FOREIGN_CLIP_ID, token),
      imagingGrant('clip', randomUUID(), token),
    ])
    for (const denial of denials) {
      expect(denial.status).toBe(200)
      expect(await denial.json()).toEqual({ patient_id: null, status: 404 })
    }

    const state = (await (await request('/__test__/identity-state')).json()) as { auditEvents: Row[] }
    expect(state.auditEvents).toHaveLength(5)
    expect(state.auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor_ref: unlinked.user.id,
        action: 'study.view',
        target_kind: 'study',
        target_id: E2_SEEDED_STUDY_ID,
        outcome: 'denied',
      }),
      expect.objectContaining({
        action: 'study.view',
        target_kind: 'study',
        target_id: E2_FOREIGN_STUDY_ID,
        outcome: 'denied',
      }),
      expect.objectContaining({
        action: 'clip.view',
        target_kind: 'clip',
        target_id: E2_FOREIGN_CLIP_ID,
        outcome: 'denied',
      }),
    ]))
  })

  test('requires an authenticated account and rejects unsupported targets without auditing', async () => {
    const unauthenticated = await request('/rest/v1/rpc/grant_patient_imaging_access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_target_kind: 'study', p_target_id: E2_SEEDED_STUDY_ID }),
    })
    expect(unauthenticated.status).toBe(401)

    const serviceRole = await request('/rest/v1/rpc/grant_patient_imaging_access', {
      method: 'POST',
      headers: {
        apikey: 'fixture-service-role',
        Authorization: 'Bearer fixture-service-role',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_target_kind: 'study', p_target_id: E2_SEEDED_STUDY_ID }),
    })
    expect(serviceRole.status).toBe(401)

    const account = await accountSession()
    const unsupported = await request('/rest/v1/rpc/grant_patient_imaging_access', {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_target_kind: 'report', p_target_id: E2_SEEDED_STUDY_ID }),
    })
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toEqual({ message: 'unsupported imaging target' })

    const state = (await (await request('/__test__/identity-state')).json()) as { auditEvents: Row[] }
    expect(state.auditEvents).toEqual([])
  })
})

describe('JOR-289 live E3/E4 imaging fixture', () => {
  test('patientReadsReferencedProviderButCannotMutateOrReadForeignImaging', async () => {
    const seededToken = await linkedPatientToken('PT-4471')
    const foreignToken = await linkedPatientToken('PT-5582')

    const provider = await patientRows(`/rest/v1/providers?id=eq.${E2_PROVIDER_ID}`, seededToken)
    expect(provider).toEqual([
      expect.objectContaining({ id: E2_PROVIDER_ID, full_name: 'Dr. Avery Chen' }),
    ])

    const mutation = await request(`/rest/v1/providers?id=eq.${E2_PROVIDER_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${seededToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ full_name: 'Patient supplied' }),
    })
    expect(mutation.status).toBe(405)
    expect(await patientRows(`/rest/v1/providers?id=eq.${E2_PROVIDER_ID}`, seededToken)).toEqual([
      expect.objectContaining({ id: E2_PROVIDER_ID, full_name: 'Dr. Avery Chen' }),
    ])
    expect(await patientRows(`/rest/v1/studies?id=eq.${E2_SEEDED_STUDY_ID}`, foreignToken)).toEqual([])
  })

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

describe('JOR-239 live share fixture', () => {
  const serviceHeaders = {
    Accept: 'application/vnd.pgrst.object+json',
    apikey: 'fixture-service-role',
    Authorization: 'Bearer fixture-service-role',
  }

  test('patientMintServiceResolveRevokeAndResetRespectTheFixtureBoundary', async () => {
    const patientToken = await linkedPatientToken('PT-4471')
    const foreignToken = await linkedPatientToken('PT-5582')
    const patientId = String((await patientObject('/rest/v1/patients?patient_ref=eq.PT-4471', patientToken))?.id)
    const row = {
      token_hash: 'fixture-token-hash',
      patient_id: patientId,
      created_by: randomUUID(),
      recipient_email: 'recipient@example.test',
      expires_at: '2099-01-01T00:00:00.000Z',
      image_id: E2_SEEDED_IMAGE_ID,
      report_id: null,
    }

    const denied = await request('/rest/v1/share_links', {
      method: 'POST',
      headers: { Accept: 'application/vnd.pgrst.object+json', Authorization: `Bearer ${foreignToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    })
    expect(denied.status).toBe(403)

    const inserted = await request('/rest/v1/share_links', {
      method: 'POST',
      headers: { Accept: 'application/vnd.pgrst.object+json', Authorization: `Bearer ${patientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    })
    expect(inserted.status).toBe(201)
    const share = (await inserted.json()) as Row
    expect(share).toEqual(expect.objectContaining({ id: expect.any(String), image_id: E2_SEEDED_IMAGE_ID, revoked_at: null }))

    expect(await patientObject(`/rest/v1/share_links?id=eq.${share.id}`, patientToken)).toEqual(expect.objectContaining({ id: share.id }))
    expect(await (await request(`/rest/v1/share_links?token_hash=eq.${row.token_hash}`, { headers: serviceHeaders })).json())
      .toEqual(expect.objectContaining({ id: share.id }))
    expect(await (await request(`/rest/v1/images?id=eq.${E2_SEEDED_IMAGE_ID}`, { headers: serviceHeaders })).json())
      .toEqual(expect.objectContaining({ id: E2_SEEDED_IMAGE_ID }))

    const outbox = await request('/rest/v1/email_outbox', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: 'recipient@example.test', subject: 'Generic notice', body: 'No PHI' }),
    })
    expect(outbox.status).toBe(201)

    const revokedAt = '2026-08-17T12:00:00.000Z'
    expect((await request(`/rest/v1/share_links?id=eq.${share.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${patientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revoked_at: revokedAt }),
    })).status).toBe(204)
    expect(await (await request(`/rest/v1/share_links?id=eq.${share.id}`, { headers: serviceHeaders })).json())
      .toEqual(expect.objectContaining({ id: share.id, revoked_at: revokedAt }))

    expect((await request('/__test__/reset-identity', { method: 'POST' })).status).toBe(200)
    expect(await (await request(`/rest/v1/share_links?id=eq.${share.id}`, { headers: serviceHeaders })).json()).toBeNull()
  })
})

// JOR-191 focused endpoint and manifest coverage.
// Mandatory adversarial bullets → tests:
// audit count/target → listGuardsOnceWithCollectionTarget
// RLS/ownership → foreignStudyStopsBeforeAnyManifestRead
// visit status → incompleteVisitIsHiddenFromEveryManifest
// malformed ids → malformedIdsReturnValidationEnvelopeBeforeGuard
// frame gaps/missing objects → framesRemainIndexedWhenRowsOrObjectsAreMissing
// PHI/storage-key leakage → responsesContainNoStorageKeysOrExtraPhiFields
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { guardMock, callerMock, anonMock, signingMock, cookieMock, reset } = vi.hoisted(() => {
  const guardMock = vi.fn()
  const callerMock = vi.fn()
  const anonMock = vi.fn()
  const signingMock = vi.fn()
  const cookieMock = vi.fn()
  return {
    guardMock,
    callerMock,
    anonMock,
    signingMock,
    cookieMock,
    reset() {
      guardMock.mockReset()
      callerMock.mockReset()
      anonMock.mockReset()
      signingMock.mockReset()
      cookieMock.mockReset()
      guardMock.mockResolvedValue({ ok: true, patientId: 'patient-1' })
      callerMock.mockResolvedValue('account-1')
      cookieMock.mockResolvedValue({ get: () => ({ value: 'caller-token' }) })
      signingMock.mockImplementation(async (keys: string[]) =>
        keys.map((key) => ({ key, url: key === 'missing-object' ? null : `https://signed.example/${key}`, available: key !== 'missing-object' })),
      )
    },
  }
})

vi.mock('../../lib/access/guard', () => ({ guardPhiAccess: guardMock }))
vi.mock('../../lib/access/identity', () => ({
  resolveCallerId: callerMock,
  resolveAuthenticatedSession: async () => {
    const userId = await callerMock()
    return userId ? { accessToken: 'caller-token', userId } : null
  },
}))
vi.mock('../../lib/db/client', () => ({ anonClient: anonMock }))
vi.mock('../../lib/imaging/signing', () => ({ signStorageKeys: signingMock }))
vi.mock('next/headers', () => ({ cookies: cookieMock }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('../../lib/config', () => ({ config: { signedUrlTtlSeconds: 120 } }))

type Data = Record<string, Array<Record<string, unknown>>>

function client(data: Data): never {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = []
      const query = {
        select() {
          return query
        },
        eq(key: string, value: unknown) {
          filters.push([key, value])
          return query
        },
        order() {
          return query
        },
        async maybeSingle() {
          return { data: (data[table] ?? []).find((item) => filters.every(([key, value]) => item[key] === value)) ?? null, error: null }
        },
        then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) {
          return Promise.resolve({ data: (data[table] ?? []).filter((item) => filters.every(([key, value]) => item[key] === value)), error: null }).then(resolve)
        },
      }
      return query
    },
  } as never
}

const studyId = '11111111-1111-4111-8111-111111111111'
const clipId = '22222222-2222-4222-8222-222222222222'

beforeEach(() => reset())

describe('mandatory adversarial: guard target, audit count, and ownership are enforced before data reads', () => {
  test('studyDetailKeepsDualRoleAdminAuthority', async function studyDetailKeepsDualRoleAdminAuthority() {
    anonMock.mockReturnValue(client({
      staff_admins: [{ id: 'admin-1', user_id: 'account-1' }],
      providers: [{ id: 'provider-1', user_id: 'account-1' }],
    }))
    guardMock.mockResolvedValue({ ok: false, status: 404 })
    const { GET } = await import('../../app/api/studies/[studyId]/route')

    await GET(new Request(`http://test/api/studies/${studyId}`), { params: Promise.resolve({ studyId }) })

    expect(guardMock).toHaveBeenCalledWith({ kind: 'admin', userId: 'account-1' }, { kind: 'study', id: studyId }, 'study.view')
  })

  test('studyDetailResolvesProviderRoleBeforeOneForeignOwnershipDecision', async function studyDetailResolvesProviderRoleBeforeOneForeignOwnershipDecision() {
    anonMock.mockReturnValue(client({ providers: [{ id: 'provider-1', user_id: 'account-1' }] }))
    guardMock.mockResolvedValue({ ok: false, status: 404 })
    const { GET } = await import('../../app/api/studies/[studyId]/route')

    const response = await GET(new Request(`http://test/api/studies/${studyId}`), { params: Promise.resolve({ studyId }) })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found', message: 'The requested resource was not found.' })
    expect(guardMock).toHaveBeenCalledTimes(1)
    expect(guardMock).toHaveBeenCalledWith({ kind: 'provider', userId: 'account-1' }, { kind: 'study', id: studyId }, 'study.view')
  })

  test('studyDetailKeepsPatientUnlinkedAndAnonymousDenials', async function studyDetailKeepsPatientUnlinkedAndAnonymousDenials() {
    anonMock.mockReturnValue(client({}))
    const { GET } = await import('../../app/api/studies/[studyId]/route')
    guardMock.mockResolvedValueOnce({ ok: false, status: 403 })
    const unlinked = await GET(new Request(`http://test/api/studies/${studyId}`), { params: Promise.resolve({ studyId }) })

    callerMock.mockResolvedValue(null)
    guardMock.mockResolvedValueOnce({ ok: false, status: 401 })
    const anonymous = await GET(new Request(`http://test/api/studies/${studyId}`), { params: Promise.resolve({ studyId }) })

    expect(unlinked.status).toBe(403)
    expect(await unlinked.json()).toEqual({ error: 'identity_verification_required', message: 'Verify your identity to continue.' })
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: 'session_required', message: 'Sign in to continue.' })
    expect(guardMock).toHaveBeenNthCalledWith(1, { kind: 'patient', userId: 'account-1' }, { kind: 'study', id: studyId }, 'study.view')
    expect(guardMock).toHaveBeenNthCalledWith(2, { kind: 'patient', userId: '' }, { kind: 'study', id: studyId }, 'study.view')
  })

  test('listGuardsOnceWithCollectionTarget', async function listGuardsOnceWithCollectionTarget() {
    anonMock.mockReturnValue(client({ studies: [] }))
    const { GET } = await import('../../app/api/studies/route')
    const response = await GET()
    expect(response.status).toBe(200)
    expect(guardMock).toHaveBeenCalledTimes(1)
    expect(guardMock).toHaveBeenCalledWith({ kind: 'patient', userId: 'account-1' }, { kind: 'collection', of: 'study' }, 'study.view')
    // guardPhiAccess owns the one audit write; handlers never write audit rows.
    expect(JSON.stringify(await response.json())).not.toContain('audit_events')
  })

  test('foreignStudyStopsBeforeAnyManifestRead', async function foreignStudyStopsBeforeAnyManifestRead() {
    anonMock.mockReturnValue(client({}))
    guardMock.mockResolvedValue({ ok: false, status: 404 })
    const { GET } = await import('../../app/api/studies/[studyId]/route')
    const response = await GET(new Request('http://test/api/studies/x'), { params: Promise.resolve({ studyId }) })
    expect(response.status).toBe(404)
    expect(guardMock).toHaveBeenCalledWith({ kind: 'patient', userId: 'account-1' }, { kind: 'study', id: studyId }, 'study.view')
    expect(anonMock).toHaveBeenCalledOnce()
    expect(signingMock).not.toHaveBeenCalled()
  })

  test('owningVerifiedPatientReadsStudyDetail', async function owningVerifiedPatientReadsStudyDetail() {
    anonMock.mockReturnValue(client({
      studies: [{ id: studyId, description: 'Owned study', visit_id: 'visit-1' }],
      visits: [{ id: 'visit-1', status: 'completed', occurred_at: '2026-01-01T00:00:00Z', provider_id: 'provider-1' }],
      providers: [{ id: 'provider-1', full_name: 'Own Provider' }],
      images: [],
      cine_clips: [],
    }))
    const { GET } = await import('../../app/api/studies/[studyId]/route')

    const response = await GET(new Request(`http://test/api/studies/${studyId}`), { params: Promise.resolve({ studyId }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: studyId, description: 'Owned study', images: [], clips: [] })
    expect(guardMock).toHaveBeenCalledWith({ kind: 'patient', userId: 'account-1' }, { kind: 'study', id: studyId }, 'study.view')
  })

  test('unauthenticatedDetailAndClipReadsReachTheirAuditedGuards', async function unauthenticatedDetailAndClipReadsReachTheirAuditedGuards() {
    callerMock.mockResolvedValue(null)
    const { GET: studyGet } = await import('../../app/api/studies/[studyId]/route')
    const { GET: clipGet } = await import('../../app/api/studies/[studyId]/clips/[clipId]/route')

    const studyResponse = await studyGet(new Request(`http://test/api/studies/${studyId}`), { params: Promise.resolve({ studyId }) })
    const clipResponse = await clipGet(new Request(`http://test/api/studies/${studyId}/clips/${clipId}`), { params: Promise.resolve({ studyId, clipId }) })

    expect([studyResponse.status, clipResponse.status]).toEqual([401, 401])
    expect(guardMock).toHaveBeenNthCalledWith(1, { kind: 'patient', userId: '' }, { kind: 'study', id: studyId }, 'study.view')
    expect(guardMock).toHaveBeenNthCalledWith(2, { kind: 'patient', userId: '' }, { kind: 'clip', id: clipId }, 'clip.view')
    expect(JSON.stringify([await studyResponse.json(), await clipResponse.json()])).not.toMatch(new RegExp(`${studyId}|${clipId}`))
  })
})

describe('mandatory adversarial: incomplete visits and malformed ids reveal neither records nor signatures', () => {
  test('isoVisitTimestampBecomesDateOnlyInListAndDetailDtos', async function isoVisitTimestampBecomesDateOnlyInListAndDetailDtos() {
    const { listStudies, studyDetail } = await import('../../lib/imaging/studies')
    const data = {
      studies: [{ id: studyId, description: 'private description', visit_id: 'visit-1' }],
      visits: [{ id: 'visit-1', status: 'completed', occurred_at: '2026-08-16T23:58:59.000-04:00', provider_id: 'provider-1' }],
      providers: [{ id: 'provider-1', full_name: 'Dr Example' }],
      images: [],
      cine_clips: [],
    }

    expect((await listStudies(client(data))).studies[0]?.occurredAt).toBe('2026-08-17')
    expect((await studyDetail(client(data), studyId))?.occurredAt).toBe('2026-08-17')
  })

  test('incompleteVisitIsHiddenFromEveryManifest', async function incompleteVisitIsHiddenFromEveryManifest() {
    const { listStudies, studyDetail, clipManifest } = await import('../../lib/imaging/studies')
    const data = {
      studies: [{ id: studyId, description: 'private description', visit_id: 'visit-1' }],
      visits: [{ id: 'visit-1', status: 'scheduled', occurred_at: '2026-01-01T00:00:00Z', provider_id: 'provider-1' }],
      cine_clips: [{ id: clipId, study_id: studyId, frame_count: 1, default_fps: 12, poster_key: null }],
    }
    expect(await listStudies(client(data))).toEqual({ studies: [] })
    expect(await studyDetail(client(data), studyId)).toBeNull()
    expect(await clipManifest(client(data), studyId, clipId)).toBeNull()
    expect(signingMock).not.toHaveBeenCalled()
  })

  test('malformedIdsReturnValidationEnvelopeBeforeGuard', async function malformedIdsReturnValidationEnvelopeBeforeGuard() {
    const { GET } = await import('../../app/api/studies/[studyId]/clips/[clipId]/route')
    const response = await GET(new Request('http://test/api/studies/nope/clips/nope'), { params: Promise.resolve({ studyId: 'nope', clipId: 'also-nope' }) })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
    expect(guardMock).not.toHaveBeenCalled()
  })
})

describe('mandatory adversarial: frames preserve their declared indexing and keep private keys out of the wire', () => {
  test('unavailableFramesCrossTheApiPageSeamWithoutInventingAUrl', async function unavailableFramesCrossTheApiPageSeamWithoutInventingAUrl() {
    const { clipManifest } = await import('../../lib/imaging/studies')
    const { normalizeClipPayload } = await import('../../app/(patient)/studies/[studyId]/clips/[clipId]/clip-payload')
    const manifest = await clipManifest(
      client({
        cine_clips: [{ id: clipId, study_id: studyId, frame_count: 2, default_fps: 17, poster_key: null }],
        studies: [{ id: studyId, description: 'private description', visit_id: 'visit-1' }],
        visits: [{ id: 'visit-1', status: 'completed', occurred_at: '2026-01-01T00:00:00Z', provider_id: 'provider-1' }],
        cine_frames: [{ clip_id: clipId, frame_index: 0, storage_key: 'frame-a' }],
      }),
      studyId,
      clipId,
    )
    const wirePayload: unknown = await Response.json(manifest).json()

    expect((wirePayload as { frames: unknown[] }).frames).toEqual([
      { index: 0, url: 'https://signed.example/frame-a', available: true },
      { index: 1, available: false },
    ])
    expect(normalizeClipPayload(wirePayload)).toMatchObject({
      frames: [
        { index: 0, url: 'https://signed.example/frame-a', available: true },
        { index: 1, url: null, available: false },
      ],
    })
    expect(normalizeClipPayload({
      ...(wirePayload as Record<string, unknown>),
      frames: [{ index: 0, available: true }],
    })).toBeNull()
  })

  test('framesRemainIndexedWhenRowsOrObjectsAreMissing', async function framesRemainIndexedWhenRowsOrObjectsAreMissing() {
    const { clipManifest } = await import('../../lib/imaging/studies')
    const result = await clipManifest(
      client({
        cine_clips: [{ id: clipId, study_id: studyId, frame_count: 4, default_fps: 17, poster_key: 'poster-secret' }],
        studies: [{ id: studyId, description: 'private description', visit_id: 'visit-1' }],
        visits: [{ id: 'visit-1', status: 'completed', occurred_at: '2026-01-01T00:00:00Z', provider_id: 'provider-1' }],
        cine_frames: [{ clip_id: clipId, frame_index: 0, storage_key: 'frame-a' }, { clip_id: clipId, frame_index: 2, storage_key: 'missing-object' }],
      }),
      studyId,
      clipId,
    )
    expect(result).toMatchObject({ id: clipId, frameCount: 4, defaultFps: 17 })
    expect(result?.frames).toEqual([
      { index: 0, url: 'https://signed.example/frame-a', available: true },
      { index: 1, available: false },
      { index: 2, available: false },
      { index: 3, available: false },
    ])
  })

  test('responsesContainNoStorageKeysOrExtraPhiFields', async function responsesContainNoStorageKeysOrExtraPhiFields() {
    const { studyDetail } = await import('../../lib/imaging/studies')
    const result = await studyDetail(
      client({
        studies: [{ id: studyId, description: 'private description', visit_id: 'visit-1', patient_id: 'leak-me' }],
        visits: [{ id: 'visit-1', status: 'completed', occurred_at: '2026-01-01T00:00:00Z', provider_id: 'provider-1' }],
        images: [{ id: 'image-1', study_id: studyId, width: 10, height: 20, ordinal: 0, storage_key: 'secret-storage-key', thumb_key: 'thumb-storage-key' }],
        cine_clips: [{ id: clipId, study_id: studyId, frame_count: 1, default_fps: 12, poster_key: 'poster-secret' }],
      }),
      studyId,
    )
    const wire = JSON.stringify(result)
    expect(wire).not.toContain('storage_key')
    expect(wire).not.toContain('patient_id')
    expect(Object.keys((result?.images as Array<Record<string, unknown>>)[0] ?? {}).sort()).toEqual(['expiresAt', 'height', 'id', 'ordinal', 'thumbUrl', 'url', 'width'])
  })
})

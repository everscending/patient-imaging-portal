// JOR-220 focused share-link contract.
// The cross-patient/dangling/zero/both-resource structural boundary remains
// covered by tests/db/migration-002.test.ts's
// shareLinksEnforceOwnershipTargetCountAndGeneratedResourceKind.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const {
  serviceMock,
  anonMock,
  guardMock,
  signMock,
  cookieMock,
  callerIdMock,
  errorResponseMock,
} = vi.hoisted(() => ({
  serviceMock: vi.fn(),
  anonMock: vi.fn(),
  guardMock: vi.fn(),
  signMock: vi.fn(),
  cookieMock: vi.fn(),
  callerIdMock: vi.fn(),
  errorResponseMock: vi.fn(),
}))

vi.mock('../../lib/db/client', () => ({ serviceClient: serviceMock, anonClient: anonMock }))
vi.mock('../../lib/access/guard', () => ({ guardPhiAccess: guardMock }))
vi.mock('../../lib/access/identity', () => ({
  resolveCallerId: callerIdMock,
  resolveAuthenticatedSession: async () => {
    const userId = await callerIdMock()
    return userId ? { accessToken: 'caller-token', userId } : null
  },
}))
vi.mock('../../lib/imaging/signing', () => ({ signStorageKeys: signMock }))
vi.mock('next/headers', () => ({ cookies: cookieMock }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('../../lib/validation/envelope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/validation/envelope')>()
  errorResponseMock.mockImplementation(actual.errorResponse)
  return { ...actual, errorResponse: errorResponseMock }
})
vi.mock('../../lib/config', () => ({
  config: {
    appBaseUrl: 'https://portal.example',
    maxRequestBodyBytes: 65_536,
    shareLinkTtlHours: 48,
    signedUrlTtlSeconds: 300,
  },
}))

import { GET as resolveGet } from '../../app/api/s/[token]/route'
import { DELETE as revokeDelete } from '../../app/api/shares/[id]/route'
import { GET as listGet, POST as mintPost } from '../../app/api/shares/route'
import { mintShareLink, revokeShareLink } from '../../lib/share/links'

const LINK_ID = '11111111-1111-4111-8111-111111111111'
const PATIENT_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_PATIENT_ID = '33333333-3333-4333-8333-333333333333'
const IMAGE_ID = '44444444-4444-4444-8444-444444444444'
const REPORT_ID = '55555555-5555-4555-8555-555555555555'
const USER_ID = '66666666-6666-4666-8666-666666666666'
const NOW = new Date('2026-08-16T12:00:00.000Z')
const ACTIVE_UNTIL = '2026-08-18T12:00:00.000Z'

type DbResult = { data: unknown; error: unknown }
type FluentQuery = {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  order: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  then: PromiseLike<DbResult>['then']
}

function query(result: DbResult, rejection?: Error): FluentQuery {
  const builder = {} as FluentQuery
  builder.select = vi.fn(() => builder)
  builder.insert = vi.fn(() => builder)
  builder.update = vi.fn(() => builder)
  builder.eq = vi.fn(() => builder)
  builder.order = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(() => builder)
  builder.single = vi.fn(() => builder)
  builder.then = (onfulfilled, onrejected) => {
    const promise = rejection ? Promise.reject<DbResult>(rejection) : Promise.resolve(result)
    return promise.then(onfulfilled, onrejected)
  }
  return builder
}

function clientFor(queries: Record<string, FluentQuery[]>): { from: ReturnType<typeof vi.fn> } {
  return {
    from: vi.fn((table: string) => {
      const next = queries[table]?.shift()
      if (!next) throw new Error(`unexpected table access: ${table}`)
      return next
    }),
  }
}

function link(overrides: Partial<Record<'id' | 'patient_id' | 'image_id' | 'report_id' | 'expires_at' | 'revoked_at', string | null>> = {}) {
  return {
    id: LINK_ID,
    patient_id: PATIENT_ID,
    image_id: IMAGE_ID,
    report_id: null,
    expires_at: ACTIVE_UNTIL,
    revoked_at: null,
    ...overrides,
  }
}

function jsonRequest(body: unknown): Request {
  return new Request('https://portal.example/api/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function unavailableBody(response: Response): Promise<string> {
  expect(response.status).toBe(410)
  return response.text()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  serviceMock.mockReset()
  anonMock.mockReset()
  guardMock.mockReset()
  signMock.mockReset()
  cookieMock.mockReset()
  callerIdMock.mockReset()
  errorResponseMock.mockClear()
  cookieMock.mockResolvedValue({ get: () => ({ value: 'caller-token' }) })
  callerIdMock.mockResolvedValue(USER_ID)
  guardMock.mockResolvedValue({ ok: true, patientId: PATIENT_ID })
  signMock.mockImplementation(async (keys: string[]) =>
    keys.map((key) => ({ key, url: `https://signed.example/${key}`, available: true })),
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('share minting', () => {
  test('expiredSessionRejectsMalformedBodyBeforeValidationOrDataAccess', async () => {
    callerIdMock.mockResolvedValue(null)
    const request = new Request('https://portal.example/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    })

    const response = await mintPost(request)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'session_required', message: 'Sign in to continue.' })
    expect(request.bodyUsed).toBe(false)
    expect(callerIdMock).toHaveBeenCalledOnce()
    expect(anonMock).not.toHaveBeenCalled()
    expect(guardMock).not.toHaveBeenCalled()
    expect(serviceMock).not.toHaveBeenCalled()
  })

  test('foreignImagesForeignReportsAndPreliminaryReportsReturn404WithoutMintWrites', async () => {
    const patients = [
      query({ data: { id: PATIENT_ID }, error: null }),
      query({ data: { id: PATIENT_ID }, error: null }),
      query({ data: { id: PATIENT_ID }, error: null }),
    ]
    const client = clientFor({ patients })
    anonMock.mockReturnValue(client)
    guardMock.mockResolvedValue({ ok: false, status: 404 })

    const cases = [
      { resourceKind: 'image', resourceId: IMAGE_ID, recipientEmail: 'recipient@example.com' },
      { resourceKind: 'report', resourceId: REPORT_ID, recipientEmail: 'recipient@example.com' },
      { resourceKind: 'report', resourceId: REPORT_ID, recipientEmail: 'recipient@example.com' },
    ]
    const responses = await Promise.all(cases.map((body) => mintPost(jsonRequest(body))))

    for (const response of responses) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found', message: 'The requested resource was not found.' })
    }
    expect(guardMock).toHaveBeenCalledTimes(3)
    expect(client.from).toHaveBeenCalledTimes(3)
    expect(client.from).not.toHaveBeenCalledWith('share_links')
    expect(serviceMock).not.toHaveBeenCalled()
  })

  test('invalidKindsIdsAndEmailsReturn422WithoutAnyWrite', async () => {
    const invalidBodies = [
      { resourceKind: 'clip', resourceId: IMAGE_ID, recipientEmail: 'recipient@example.com' },
      { resourceKind: 'study', resourceId: IMAGE_ID, recipientEmail: 'recipient@example.com' },
      { resourceKind: 'image', resourceId: 'not-a-uuid', recipientEmail: 'recipient@example.com' },
      { resourceKind: 'image', resourceId: IMAGE_ID, recipientEmail: 'not-an-address' },
      { resourceKind: 'image', resourceId: IMAGE_ID, recipientEmail: `${'a'.repeat(310)}@example.com` },
    ]

    for (const body of invalidBodies) {
      const response = await mintPost(jsonRequest(body))
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
    }
    expect(callerIdMock).toHaveBeenCalledTimes(invalidBodies.length)
    expect(guardMock).not.toHaveBeenCalled()
    expect(anonMock).not.toHaveBeenCalled()
    expect(serviceMock).not.toHaveBeenCalled()
  })

  test('tokenPersistenceStoresOnlySha256AndReturnsOnlyThePinnedCreationFields', async () => {
    const patientQuery = query({ data: { id: PATIENT_ID }, error: null })
    const shareQuery = query({ data: { id: LINK_ID }, error: null })
    const outboxQuery = query({ data: null, error: null })
    const client = clientFor({ patients: [patientQuery], share_links: [shareQuery], email_outbox: [outboxQuery] })
    anonMock.mockReturnValue(client)

    const response = await mintPost(jsonRequest({
      resourceKind: 'image',
      resourceId: IMAGE_ID,
      recipientEmail: 'recipient@example.com',
    }))
    const body = await response.json() as Record<string, string>

    expect(response.status).toBe(201)
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'id', 'recipientEmail', 'url'])
    expect(body).toEqual({
      id: LINK_ID,
      url: expect.stringMatching(/^https:\/\/portal\.example\/s\/[A-Za-z0-9_-]{43}$/),
      expiresAt: '2026-08-18T12:00:00.000Z',
      recipientEmail: 'recipient@example.com',
    })

    const rawToken = new URL(body.url).pathname.split('/').at(-1) ?? ''
    expect(Buffer.from(rawToken, 'base64url')).toHaveLength(32)
    const inserted = shareQuery.insert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(inserted.token_hash).toBe(createHash('sha256').update(rawToken).digest('hex'))
    expect(inserted.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(inserted)).not.toContain(rawToken)
    expect(Object.keys(inserted)).not.toContain('token')
    expect(Object.keys(inserted)).not.toContain('url')
    expect(outboxQuery.insert).toHaveBeenCalledOnce()
    const enqueued = outboxQuery.insert.mock.calls[0]?.[0] as Record<string, string>
    expect(Object.keys(enqueued).sort()).toEqual(['body', 'recipient', 'subject'])
    expect(enqueued.subject).toBe('Someone shared a secure medical file with you')
    expect(enqueued.body).toContain(body.url)
    expect(enqueued.body).not.toMatch(new RegExp(`${PATIENT_ID}|${IMAGE_ID}`))
    expect(guardMock).toHaveBeenCalledWith(
      { kind: 'patient', userId: USER_ID },
      { kind: 'image', id: IMAGE_ID },
      'share.create',
    )
    expect(serviceMock).not.toHaveBeenCalled()
  })

  test('outboxFailureKeepsActiveLinkAndNeverSendsInline', async () => {
    const source = readFileSync('lib/share/links.ts', 'utf8')
    expect(source).toMatch(/import\s*\{\s*enqueueEmail\s*\}\s*from\s*['"]\.\.\/notify\/email['"]/)
    expect(source).not.toMatch(/sendEmail\s*\(|from\s*['"]resend['"]|\.emails\.send\s*\(/)

    const returnedErrorOutbox = query({ data: null, error: new Error('queue unavailable') })
    const thrownOutbox = query({ data: null, error: null }, new Error('outbox offline'))
    const callerClient = clientFor({
      patients: [
        query({ data: { id: PATIENT_ID }, error: null }),
        query({ data: { id: PATIENT_ID }, error: null }),
      ],
      share_links: [
        query({ data: { id: LINK_ID }, error: null }),
        query({ data: { id: LINK_ID }, error: null }),
      ],
      email_outbox: [returnedErrorOutbox, thrownOutbox],
    })
    anonMock.mockReturnValue(callerClient)

    const responses = await Promise.all([
      mintPost(jsonRequest({ resourceKind: 'image', resourceId: IMAGE_ID, recipientEmail: 'recipient@example.com' })),
      mintPost(jsonRequest({ resourceKind: 'image', resourceId: IMAGE_ID, recipientEmail: 'recipient@example.com' })),
    ])
    const created = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(201)
      const body = await response.json() as Record<string, string>
      expect(Object.keys(body).sort()).toEqual(['delivery', 'expiresAt', 'id', 'recipientEmail', 'url'])
      expect(body.delivery).toBe('failed')
      return body
    }))
    expect(returnedErrorOutbox.insert).toHaveBeenCalledOnce()
    expect(thrownOutbox.insert).toHaveBeenCalledOnce()
    expect(serviceMock).not.toHaveBeenCalled()

    const active = link()
    const image = {
      id: IMAGE_ID,
      width: 640,
      height: 480,
      ordinal: 1,
      storage_key: 'image-key',
      thumb_key: null,
    }
    const resolverClient = clientFor({
      share_links: [query({ data: active, error: null }), query({ data: active, error: null })],
      images: [query({ data: image, error: null })],
    })
    serviceMock.mockReturnValue(resolverClient)

    const token = new URL(created[0].url).pathname.split('/').at(-1) ?? ''
    const response = await resolveGet(new Request(created[0].url), { params: Promise.resolve({ token }) })
    expect(response.status).toBe(200)
    expect((await response.json() as { payload: { id: string } }).payload.id).toBe(IMAGE_ID)
  })

  test('mintAndRevokeUseOnlyTheAuthenticatedAnonClient', async () => {
    const mintInsert = query({ data: { id: LINK_ID }, error: null })
    const outboxInsert = query({ data: null, error: null })
    const revokeRead = query({ data: link(), error: null })
    const revokeUpdate = query({ data: null, error: null })
    const client = clientFor({
      share_links: [mintInsert, revokeRead, revokeUpdate],
      email_outbox: [outboxInsert],
    })
    anonMock.mockReturnValue(client)

    await mintShareLink({
      patientId: PATIENT_ID,
      actorUserId: USER_ID,
      resourceKind: 'image',
      resourceId: IMAGE_ID,
      recipientEmail: 'recipient@example.com',
    }).then((created) => expect(created.delivery).toBe('sent'))
    await expect(revokeShareLink({ id: LINK_ID, patientId: PATIENT_ID, actorUserId: USER_ID }))
      .resolves.toEqual({ ok: true })

    expect(anonMock).toHaveBeenCalledTimes(2)
    expect(anonMock).toHaveBeenNthCalledWith(1, 'caller-token')
    expect(anonMock).toHaveBeenNthCalledWith(2, 'caller-token')
    expect(serviceMock).not.toHaveBeenCalled()
    expect(revokeUpdate.update).toHaveBeenCalledWith({ revoked_at: NOW.toISOString() })
    expect(guardMock).toHaveBeenCalledWith(
      { kind: 'patient', userId: USER_ID },
      { kind: 'image', id: IMAGE_ID },
      'share.revoke',
    )
  })
})

describe('share listing and revocation', () => {
  test('listWritesOneCollectionAuditAndNeverReturnsSecretsOrUrls', async () => {
    const rows = [
      { ...link(), recipient_email: 'image@example.com', token_hash: 'must-not-leak', url: 'must-not-leak' },
      {
        ...link({ id: '77777777-7777-4777-8777-777777777777', image_id: null, report_id: REPORT_ID }),
        recipient_email: 'report@example.com',
        token_hash: 'must-not-leak',
        url: 'must-not-leak',
      },
    ]
    const listQuery = query({ data: rows, error: null })
    const client = clientFor({ share_links: [listQuery] })
    anonMock.mockReturnValue(client)

    const response = await listGet()
    const body = await response.json() as { shares: Array<Record<string, unknown>> }

    expect(response.status).toBe(200)
    expect(guardMock).toHaveBeenCalledTimes(1)
    expect(guardMock).toHaveBeenCalledWith(
      { kind: 'patient', userId: USER_ID },
      { kind: 'collection', of: 'share' },
      'share.view',
    )
    expect(body.shares).toHaveLength(2)
    for (const share of body.shares) {
      expect(Object.keys(share).sort()).toEqual([
        'expiresAt',
        'id',
        'recipientEmail',
        'resourceId',
        'resourceKind',
        'revokedAt',
        'state',
      ])
      expect(JSON.stringify(share)).not.toContain('must-not-leak')
    }
    expect(listQuery.select).toHaveBeenCalledWith('id, image_id, report_id, recipient_email, expires_at, revoked_at')
    expect(serviceMock).not.toHaveBeenCalled()
  })

  test('deleteOfAnOwnedLinkRevokesItAndMakesItsTokenUnavailable', async () => {
    const patientRead = query({ data: { id: PATIENT_ID }, error: null })
    const ownedRead = query({ data: link(), error: null })
    const revokeUpdate = query({ data: null, error: null })
    const callerClient = clientFor({ patients: [patientRead], share_links: [ownedRead, revokeUpdate] })
    anonMock.mockReturnValue(callerClient)

    const response = await revokeDelete(new Request(`https://portal.example/api/shares/${LINK_ID}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id: LINK_ID }),
    })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(errorResponseMock).not.toHaveBeenCalled()
    expect(revokeUpdate.update).toHaveBeenCalledWith({ revoked_at: NOW.toISOString() })
    expect(guardMock).toHaveBeenCalledWith(
      { kind: 'patient', userId: USER_ID },
      { kind: 'image', id: IMAGE_ID },
      'share.revoke',
    )
    expect(serviceMock).not.toHaveBeenCalled()

    const resolverClient = clientFor({
      share_links: [query({ data: link({ revoked_at: NOW.toISOString() }), error: null })],
    })
    serviceMock.mockReturnValue(resolverClient)
    const unavailable = await resolveGet(new Request('https://portal.example/s/revoked-token'), {
      params: Promise.resolve({ token: 'revoked-token' }),
    })
    expect(await unavailableBody(unavailable)).toBe(
      JSON.stringify({ error: 'share_unavailable', message: 'This link is no longer available.' }),
    )
  })

  test('deleteOwnershipDenialIs404AndDoesNotRevokeTheForeignLink', async () => {
    const patientRead = query({ data: { id: PATIENT_ID }, error: null })
    const foreignRead = query({ data: link({ patient_id: OTHER_PATIENT_ID }), error: null })
    const forbiddenUpdate = query({ data: null, error: null })
    const callerClient = clientFor({ patients: [patientRead], share_links: [foreignRead, forbiddenUpdate] })
    anonMock.mockReturnValue(callerClient)

    const response = await revokeDelete(new Request(`https://portal.example/api/shares/${LINK_ID}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id: LINK_ID }),
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found', message: 'The requested resource was not found.' })
    expect(errorResponseMock).toHaveBeenCalledOnce()
    expect(errorResponseMock).toHaveBeenCalledWith(404, 'not_found', 'The requested resource was not found.')
    expect(forbiddenUpdate.update).not.toHaveBeenCalled()
    expect(serviceMock).not.toHaveBeenCalled()

    const active = link({ patient_id: OTHER_PATIENT_ID })
    const resolverClient = clientFor({
      share_links: [query({ data: active, error: null }), query({ data: active, error: null })],
      images: [query({
        data: { id: IMAGE_ID, width: 10, height: 20, ordinal: 1, storage_key: 'foreign-key', thumb_key: null },
        error: null,
      })],
    })
    serviceMock.mockReturnValue(resolverClient)
    guardMock.mockResolvedValue({ ok: true, patientId: OTHER_PATIENT_ID })
    const stillActive = await resolveGet(new Request('https://portal.example/s/foreign-token'), {
      params: Promise.resolve({ token: 'foreign-token' }),
    })
    expect(stillActive.status).toBe(200)
  })
})

describe('share-token resolution', () => {
  test('unknownExpiredAndRevokedTokensHaveByteIdentical410Envelopes', async () => {
    const unavailableRows = [
      null,
      link({ expires_at: '2026-08-16T11:59:59.000Z' }),
      link({ revoked_at: '2026-08-16T11:59:59.000Z' }),
    ]
    const resolverClient = clientFor({
      share_links: unavailableRows.map((data) => query({ data, error: null })),
    })
    serviceMock.mockReturnValue(resolverClient)

    const bodies: string[] = []
    for (const token of ['unknown-token', 'expired-token', 'revoked-token']) {
      bodies.push(await unavailableBody(await resolveGet(new Request(`https://portal.example/s/${token}`), {
        params: Promise.resolve({ token }),
      })))
    }
    expect(new Set(bodies)).toEqual(new Set([
      JSON.stringify({ error: 'share_unavailable', message: 'This link is no longer available.' }),
    ]))
    expect(signMock).not.toHaveBeenCalled()
    expect(guardMock).toHaveBeenCalledTimes(3)
    expect(guardMock).toHaveBeenNthCalledWith(1,
      { kind: 'share_recipient', shareLinkId: null },
      { kind: 'share_link', id: null },
      'share.use',
    )
    expect(guardMock).toHaveBeenNthCalledWith(2,
      { kind: 'share_recipient', shareLinkId: LINK_ID },
      { kind: 'image', id: IMAGE_ID },
      'share.use',
    )
    expect(guardMock).toHaveBeenNthCalledWith(3,
      { kind: 'share_recipient', shareLinkId: LINK_ID },
      { kind: 'image', id: IMAGE_ID },
      'share.use',
    )
  })

  test('revocationBetweenResolutionAndDisclosureNeverReturnsImageOrReportContent', async () => {
    const activeImage = link()
    const revokedImage = link({ revoked_at: NOW.toISOString() })
    const activeReport = link({ image_id: null, report_id: REPORT_ID })
    const revokedReport = link({ image_id: null, report_id: REPORT_ID, revoked_at: NOW.toISOString() })
    const resolverClient = clientFor({
      share_links: [
        query({ data: activeImage, error: null }),
        query({ data: revokedImage, error: null }),
        query({ data: activeReport, error: null }),
        query({ data: revokedReport, error: null }),
      ],
      images: [query({
        data: { id: IMAGE_ID, width: 10, height: 20, ordinal: 1, storage_key: 'secret-image-key', thumb_key: null },
        error: null,
      })],
      reports: [query({
        data: {
          id: REPORT_ID,
          study_id: '77777777-7777-4777-8777-777777777777',
          findings: 'secret findings',
          impression: 'secret impression',
          signed_at: NOW.toISOString(),
          studies: { description: 'secret description' },
          patients: { patient_ref: 'secret patient' },
          providers: { full_name: 'secret provider' },
        },
        error: null,
      })],
    })
    serviceMock.mockReturnValue(resolverClient)

    const imageResponse = await resolveGet(new Request('https://portal.example/s/image-race'), {
      params: Promise.resolve({ token: 'image-race' }),
    })
    const reportResponse = await resolveGet(new Request('https://portal.example/s/report-race'), {
      params: Promise.resolve({ token: 'report-race' }),
    })
    const imageBody = await unavailableBody(imageResponse)
    const reportBody = await unavailableBody(reportResponse)

    expect(imageBody).toBe(reportBody)
    expect(imageBody).not.toContain('signed.example')
    expect(reportBody).not.toContain('secret findings')
    expect(guardMock).toHaveBeenCalledTimes(2)
  })

  test('resolvedImageAndReportPayloadsArePinnedAndHaveNoSiblingLeakage', async () => {
    const activeImage = link()
    const activeReport = link({ image_id: null, report_id: REPORT_ID })
    const resolverClient = clientFor({
      share_links: [
        query({ data: activeImage, error: null }),
        query({ data: activeImage, error: null }),
        query({ data: activeReport, error: null }),
        query({ data: activeReport, error: null }),
      ],
      images: [query({
        data: { id: IMAGE_ID, width: 640, height: 480, ordinal: 2, storage_key: 'private-key', thumb_key: 'private-thumb' },
        error: null,
      })],
      reports: [query({
        data: {
          id: REPORT_ID,
          study_id: '77777777-7777-4777-8777-777777777777',
          findings: 'findings',
          impression: 'impression',
          signed_at: NOW.toISOString(),
          studies: { description: 'description' },
          patients: { patient_ref: 'PT-00001' },
          providers: { full_name: 'Dr Example' },
        },
        error: null,
      })],
    })
    serviceMock.mockReturnValue(resolverClient)

    const imageResponse = await resolveGet(new Request('https://portal.example/s/image-token'), {
      params: Promise.resolve({ token: 'image-token' }),
    })
    const imageBody = await imageResponse.json() as { resourceKind: string; payload: Record<string, unknown>; expiresAt: string }
    expect(imageResponse.status).toBe(200)
    expect(Object.keys(imageBody).sort()).toEqual(['expiresAt', 'payload', 'resourceKind'])
    expect(imageBody.resourceKind).toBe('image')
    expect(Object.keys(imageBody.payload).sort()).toEqual(['expiresAt', 'height', 'id', 'ordinal', 'thumbUrl', 'url', 'width'])
    expect(imageBody.payload).toEqual({
      id: IMAGE_ID,
      width: 640,
      height: 480,
      ordinal: 2,
      url: 'https://signed.example/private-key',
      thumbUrl: 'https://signed.example/private-thumb',
      expiresAt: '2026-08-16T12:05:00.000Z',
    })
    expect(JSON.stringify(imageBody)).not.toMatch(/storage_key|studyDescription|clips|sibling/)

    const reportResponse = await resolveGet(new Request('https://portal.example/s/report-token'), {
      params: Promise.resolve({ token: 'report-token' }),
    })
    const reportBody = await reportResponse.json() as { resourceKind: string; payload: Record<string, unknown> }
    expect(reportResponse.status).toBe(200)
    expect(reportBody.resourceKind).toBe('report')
    expect(Object.keys(reportBody.payload).sort()).toEqual([
      'findings',
      'id',
      'impression',
      'patientRef',
      'signedAt',
      'signedByName',
      'studyDescription',
      'studyId',
    ])
  })

  test('resolveWritesShareUseAuditBeforeReturningPayload', async () => {
    const active = link()
    const resolverClient = clientFor({
      share_links: [query({ data: active, error: null }), query({ data: active, error: null })],
      images: [query({
        data: { id: IMAGE_ID, width: 10, height: 20, ordinal: 1, storage_key: 'image-key', thumb_key: null },
        error: null,
      })],
    })
    serviceMock.mockReturnValue(resolverClient)

    const response = await resolveGet(new Request('https://portal.example/s/audited-token'), {
      params: Promise.resolve({ token: 'audited-token' }),
    })
    expect(response.status).toBe(200)
    expect(guardMock).toHaveBeenCalledOnce()
    expect(guardMock).toHaveBeenCalledWith(
      { kind: 'share_recipient', shareLinkId: LINK_ID },
      { kind: 'image', id: IMAGE_ID },
      'share.use',
    )
  })
})

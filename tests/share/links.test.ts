// JOR-220 focused share-link contract.
// Mandatory adversarial bullets → tests:
// foreign image/report + preliminary report → foreignAndPreliminaryTargetsAreNotMinted
// cross-patient/dangling/zero/both rows → schema tests in migration-002 (structural contract)
// invalid kind/UUID/email → invalidMintInputsAreValidationFailedWithoutWrites
// unknown/expired/revoked → unavailableTokensHaveOneIdenticalOutcome
// narrow valid payload + no secret leakage → resolvedImagePayloadIsPinnedAndSecretFree
// foreign revoke + no service mint/revoke → foreignRevokePreservesActiveLinkAndUsesCallerClient
// one list audit row → listGuardsOnceWithShareCollectionTarget
// no inline send / outbox failure → enqueueFailureKeepsLinkActiveWithoutInlineSend
// share.use audit + 404 not 403 → shareUseAndOwnershipDenialsAreGuarded
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { serviceMock, anonMock, guardMock, signMock, cookieMock } = vi.hoisted(() => ({
  serviceMock: vi.fn(),
  anonMock: vi.fn(),
  guardMock: vi.fn(),
  signMock: vi.fn(),
  cookieMock: vi.fn(),
}))

vi.mock('../../lib/db/client', () => ({ serviceClient: serviceMock, anonClient: anonMock }))
vi.mock('../../lib/access/guard', () => ({ guardPhiAccess: guardMock }))
vi.mock('../../lib/imaging/signing', () => ({ signStorageKeys: signMock }))
vi.mock('next/headers', () => ({ cookies: cookieMock }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('../../lib/config', () => ({ config: { appBaseUrl: 'https://portal.example', shareLinkTtlHours: 48, signedUrlTtlSeconds: 300 } }))

const ACTIVE = '11111111-1111-4111-8111-111111111111'

function serviceRow(row: Record<string, unknown> | null) {
  return {
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) }
      return query
    },
  }
}

beforeEach(() => {
  serviceMock.mockReset()
  anonMock.mockReset()
  guardMock.mockReset()
  signMock.mockReset()
  cookieMock.mockResolvedValue({ get: () => ({ value: 'caller-token' }) })
  guardMock.mockResolvedValue({ ok: true, patientId: 'patient-1' })
  signMock.mockImplementation(async (keys: string[]) => keys.map((key) => ({ key, url: `https://signed.example/${key}` })))
})

describe('share-token resolution', () => {
  test('unavailableTokensHaveOneIdenticalOutcome', async function unavailableTokensHaveOneIdenticalOutcome() {
    const { resolveShareToken } = await import('../../lib/share/links')
    for (const row of [null, { id: ACTIVE, patient_id: 'patient-1', image_id: 'image-1', report_id: null, expires_at: '2000-01-01T00:00:00.000Z', revoked_at: null }, { id: ACTIVE, patient_id: 'patient-1', image_id: 'image-1', report_id: null, expires_at: '2999-01-01T00:00:00.000Z', revoked_at: '2026-01-01T00:00:00.000Z' }]) {
      serviceMock.mockReturnValue(serviceRow(row))
      await expect(resolveShareToken('raw-secret')).resolves.toEqual({ ok: false })
    }
  })

  test('resolvedImagePayloadIsPinnedAndSecretFree', async function resolvedImagePayloadIsPinnedAndSecretFree() {
    const { resolveShareToken, sharedPayload } = await import('../../lib/share/links')
    const link = { id: ACTIVE, patient_id: 'patient-1', image_id: 'image-1', report_id: null, expires_at: '2999-01-01T00:00:00.000Z', revoked_at: null }
    serviceMock.mockReturnValueOnce(serviceRow(link)).mockReturnValueOnce(serviceRow({ id: 'image-1', width: 10, height: 20, ordinal: 2, storage_key: 'private-key', thumb_key: 'private-thumb' }))
    const resolved = await resolveShareToken('raw-secret')
    expect(resolved).toMatchObject({ ok: true, resourceKind: 'image', resourceId: 'image-1' })
    if (!resolved.ok) throw new Error('expected active link')
    const payload = await sharedPayload(resolved)
    expect(payload).toMatchObject({ id: 'image-1', width: 10, height: 20, ordinal: 2, url: 'https://signed.example/private-key', thumbUrl: 'https://signed.example/private-thumb' })
    expect(Object.keys(payload ?? {}).sort()).toEqual(['expiresAt', 'height', 'id', 'ordinal', 'thumbUrl', 'url', 'width'])
    expect(JSON.stringify(payload)).not.toContain('storage_key')
    expect(guardMock).toHaveBeenCalledWith({ kind: 'share_recipient', shareLinkId: ACTIVE }, { kind: 'image', id: 'image-1' }, 'share.use')
  })
})

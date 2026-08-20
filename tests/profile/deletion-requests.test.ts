import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { authenticationMock, guardMock, rpcMock, anonClientMock } = vi.hoisted(() => {
  const rpc = vi.fn()
  return {
    authenticationMock: vi.fn(async () => ({
      status: 'authenticated',
      session: { accessToken: 'access-token', userId: 'account-1' },
    })),
    guardMock: vi.fn(),
    rpcMock: rpc,
    anonClientMock: vi.fn(() => ({ rpc })),
  }
})

vi.mock('../../lib/access/guard', () => ({
  authenticatePhiRequest: authenticationMock,
  guardAuthenticatedPhiAccess: guardMock,
}))
vi.mock('../../lib/db/client', () => ({ anonClient: anonClientMock }))

import {
  authorizeDeletionRequest,
  recordInvalidDeletionRequest,
  submitDeletionRequest,
} from '../../lib/profile/deletion-requests'
import { authenticatePhiRequest } from '../../lib/access/guard'

beforeEach(() => {
  guardMock.mockReset()
  rpcMock.mockReset()
  anonClientMock.mockClear()
})

describe('profile deletion request domain boundary', () => {
  test('authorizationUsesThePhiGuardAndHandsTheGrantedAuditToTheRpc', async () => {
    guardMock.mockResolvedValue({ ok: true, patientId: 'patient-1' })
    const authentication = await authenticatePhiRequest()

    await expect(authorizeDeletionRequest(authentication)).resolves.toEqual({ ok: true, patientId: 'patient-1' })
    expect(guardMock).toHaveBeenCalledWith(
      { kind: 'patient', userId: 'account-1' },
      { kind: 'patient', id: null },
      'profile.deletion_request',
      authentication,
      { grantedAudit: 'transactional-rpc' },
    )
  })

  test('validSubmissionCallsTheParameterlessMutationSurfaceAndReturnsItsServerFields', async () => {
    rpcMock.mockResolvedValue({
      data: [{ result_error: null, request_status: 'received', requested_at: '2026-08-20T00:00:00Z' }],
      error: null,
    })

    await expect(submitDeletionRequest('access-token')).resolves.toEqual({
      ok: true,
      status: 'received',
      requestedAt: '2026-08-20T00:00:00Z',
    })
    expect(anonClientMock).toHaveBeenCalledWith('access-token')
    expect(rpcMock).toHaveBeenCalledWith('request_profile_deletion', { p_request_valid: true })
  })

  test('duplicateMapsToTheOnlyConflictOutcome', async () => {
    rpcMock.mockResolvedValue({
      data: { result_error: 'request_already_open', request_status: null, requested_at: null },
      error: null,
    })
    await expect(submitDeletionRequest('access-token')).resolves.toEqual({ ok: false, error: 'request_already_open' })
  })

  test('invalidBodyUsesTheSameRpcForOneDurableDeniedAudit', async () => {
    rpcMock.mockResolvedValue({
      data: { result_error: 'validation_failed', request_status: null, requested_at: null },
      error: null,
    })
    await expect(recordInvalidDeletionRequest('access-token')).resolves.toBeUndefined()
    expect(rpcMock).toHaveBeenCalledWith('request_profile_deletion', { p_request_valid: false })
  })

  test.each([
    { data: null, error: { message: 'SECRET_DB_ERROR' } },
    { data: null, error: null },
    { data: { result_error: 'unexpected', request_status: null, requested_at: null }, error: null },
  ])('rpcFailureIsSanitizedAndCannotProduceSuccess: %#', async (result) => {
    rpcMock.mockResolvedValue(result)
    await expect(submitDeletionRequest('access-token')).rejects.toThrow('deletion request transaction failed')
  })
})

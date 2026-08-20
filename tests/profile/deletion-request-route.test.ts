import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../../lib/config', () => ({ config: { maxRequestBodyBytes: 1024 } }))

const {
  anonClientMock,
  auditInsertMock,
  authClientMock,
  authGetUserMock,
  cookieMock,
  rpcMock,
  serviceClientMock,
} = vi.hoisted(() => {
  const rpc = vi.fn()
  const auditInsert = vi.fn()
  return {
    anonClientMock: vi.fn(() => ({ rpc })),
    auditInsertMock: auditInsert,
    authClientMock: vi.fn(),
    authGetUserMock: vi.fn(),
    cookieMock: vi.fn(),
    rpcMock: rpc,
    serviceClientMock: vi.fn(() => ({
      from: vi.fn(() => ({ insert: auditInsert })),
    })),
  }
})

vi.mock('next/headers', () => ({ cookies: cookieMock }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('../../lib/db/client', () => ({
  anonClient: anonClientMock,
  authClient: authClientMock,
  serviceClient: serviceClientMock,
}))

import { POST } from '../../app/api/profile/deletion-request/route'

let releaseAudit: ((result: { error: null }) => void) | undefined

beforeEach(() => {
  vi.clearAllMocks()
  releaseAudit = undefined
  cookieMock.mockResolvedValue({ get: () => ({ value: 'caller-access-token' }) })
  authClientMock.mockImplementation(() => ({ auth: { getUser: authGetUserMock } }))
  auditInsertMock.mockImplementation(() => new Promise<{ error: null }>((resolve) => {
    releaseAudit = resolve
  }))
})

describe('POST /api/profile/deletion-request authentication boundary', () => {
  test.each(['provider-unavailable', 'provider-throws'] as const)(
    '%s fails closed after one authenticated guard attempt and one durable denial',
    async (failure) => {
      if (failure === 'provider-unavailable') {
        authGetUserMock.mockResolvedValue({
          data: { user: null },
          error: { status: 500, message: 'SECRET_AUTH_ERROR_MUST_NOT_ESCAPE' },
        })
      } else {
        authGetUserMock.mockRejectedValue(new Error('SECRET_AUTH_THROW_MUST_NOT_ESCAPE'))
      }

      let outcome: Response | Error | undefined
      const responsePromise = POST(new Request('http://localhost/api/profile/deletion-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }))
      void responsePromise.then(
        (response) => { outcome = response },
        (error: unknown) => { outcome = error instanceof Error ? error : new Error('unknown route failure') },
      )

      await vi.waitFor(() => {
        if (outcome instanceof Error) throw outcome
        expect(auditInsertMock).toHaveBeenCalledTimes(1)
      })
      expect(outcome).toBeUndefined()

      expect(releaseAudit).toBeTypeOf('function')
      releaseAudit?.({ error: null })
      const response = await responsePromise

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: 'deletion_request_unavailable',
        message: 'The request could not be recorded. Try again.',
      })
      expect(authGetUserMock).toHaveBeenCalledTimes(1)
      expect(auditInsertMock).toHaveBeenCalledWith({
        actor_kind: 'account',
        actor_ref: null,
        action: 'profile.deletion_request',
        target_kind: 'patient',
        target_id: null,
        outcome: 'denied',
        detail: null,
      })
      expect(anonClientMock).not.toHaveBeenCalled()
      expect(rpcMock).not.toHaveBeenCalled()
    },
  )
})

import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const {
  anonClientMock,
  authClientMock,
  authGetUserMock,
  clipManifestMock,
  cookieMock,
  dataFromMock,
  getReportMock,
  guardPhiAccessMock,
  revokeShareLinkMock,
  routeState,
  studyDetailMock,
  updateOwnAccountMetadataMock,
} = vi.hoisted(() => {
  const authGetUserMock = vi.fn()
  const dataFromMock = vi.fn()
  return {
    anonClientMock: vi.fn(() => ({ auth: { getUser: authGetUserMock }, from: dataFromMock })),
    authClientMock: vi.fn(() => ({ auth: { getUser: authGetUserMock } })),
    authGetUserMock,
    clipManifestMock: vi.fn(),
    cookieMock: vi.fn(),
    dataFromMock,
    getReportMock: vi.fn(),
    guardPhiAccessMock: vi.fn(),
    revokeShareLinkMock: vi.fn(),
    routeState: { authenticated: false, events: [] as string[] },
    studyDetailMock: vi.fn(),
    updateOwnAccountMetadataMock: vi.fn(),
  }
})

function authenticatedSession(): { accessToken: string; userId: string } | null {
  routeState.events.push('auth')
  return routeState.authenticated ? { accessToken: 'forged-or-valid-token', userId: 'account-1' } : null
}

vi.mock('next/headers', () => ({
  cookies: cookieMock,
}))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('../../lib/config', () => ({ config: { maxRequestBodyBytes: 1024 } }))
vi.mock('../../lib/access/identity', () => ({
  resolveAuthenticatedSession: vi.fn(async () => authenticatedSession()),
  resolveCallerId: vi.fn(async () => authenticatedSession()?.userId ?? null),
}))
vi.mock('../../lib/access/guard', () => ({ guardPhiAccess: guardPhiAccessMock }))
vi.mock('../../lib/db/client', () => ({
  anonClient: anonClientMock,
  authClient: authClientMock,
  updateOwnAccountMetadata: updateOwnAccountMetadataMock,
}))
vi.mock('../../lib/share/links', () => ({ revokeShareLink: revokeShareLinkMock }))
vi.mock('../../lib/reports/reports', () => ({ getReport: getReportMock }))
vi.mock('../../lib/imaging/studies', () => ({
  clipManifest: clipManifestMock,
  studyDetail: studyDetailMock,
}))

import { GET as getProviders } from '../../app/api/providers/route'
import { GET as getReport } from '../../app/api/reports/[reportId]/route'
import { GET as getServices } from '../../app/api/services/route'
import { DELETE as deleteShare } from '../../app/api/shares/[id]/route'
import { GET as getSlots } from '../../app/api/slots/route'
import { PATCH as patchProfile } from '../../app/api/profile/route'
import { GET as getStudy } from '../../app/api/studies/[studyId]/route'
import { GET as getClip } from '../../app/api/studies/[studyId]/clips/[clipId]/route'

type ObservedInvocation = {
  invoke: () => Promise<Response>
  wasInputRead: () => boolean
}

function observedParams<T extends Record<string, string>>(value: T): {
  context: { params: Promise<T> }
  wasRead: () => boolean
} {
  let read = false
  const params = {
    then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((resolved: T) => TResult1 | PromiseLike<TResult1>) | null,
      _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      void _onrejected
      if (!read) routeState.events.push('parse')
      read = true
      return Promise.resolve(onfulfilled ? onfulfilled(value) : (value as unknown as TResult1))
    },
  } as Promise<T>
  return { context: { params }, wasRead: () => read }
}

function observedQuery(url: string): { request: Request; wasRead: () => boolean } {
  let read = false
  const request = {
    get url() {
      if (!read) routeState.events.push('parse')
      read = true
      return url
    },
  } as Request
  return { request, wasRead: () => read }
}

function observedMalformedBody(): { request: Request; wasRead: () => boolean } {
  const source = new Request('http://localhost/api/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: 'not json at all',
  })
  let read = false
  const request = {
    headers: source.headers,
    get body() {
      if (!read) routeState.events.push('parse')
      read = true
      return source.body
    },
  } as Request
  return { request, wasRead: () => read }
}

const malformedAuthenticatedSurfaces: Array<{
  name: string
  create: () => ObservedInvocation
}> = [
  {
    name: 'DELETE /api/shares/:id',
    create: () => {
      const params = observedParams({ id: 'not-a-uuid' })
      return {
        invoke: () => deleteShare(new Request('http://localhost/api/shares/not-a-uuid', { method: 'DELETE' }), params.context),
        wasInputRead: params.wasRead,
      }
    },
  },
  {
    name: 'GET /api/reports/:reportId',
    create: () => {
      const params = observedParams({ reportId: 'not-a-uuid' })
      return {
        invoke: () => getReport(new Request('http://localhost/api/reports/not-a-uuid'), params.context),
        wasInputRead: params.wasRead,
      }
    },
  },
  {
    name: 'GET /api/studies/:studyId',
    create: () => {
      const params = observedParams({ studyId: 'not-a-uuid' })
      return {
        invoke: () => getStudy(new Request('http://localhost/api/studies/not-a-uuid'), params.context),
        wasInputRead: params.wasRead,
      }
    },
  },
  {
    name: 'GET /api/studies/:studyId/clips/:clipId',
    create: () => {
      const params = observedParams({ studyId: 'not-a-uuid', clipId: 'not-a-uuid' })
      return {
        invoke: () => getClip(new Request('http://localhost/api/studies/not-a-uuid/clips/not-a-uuid'), params.context),
        wasInputRead: params.wasRead,
      }
    },
  },
  {
    name: 'GET /api/providers',
    create: () => {
      const query = observedQuery('http://localhost/api/providers?serviceId=not-a-uuid')
      return { invoke: () => getProviders(query.request), wasInputRead: query.wasRead }
    },
  },
  {
    name: 'GET /api/slots',
    create: () => {
      const query = observedQuery('http://localhost/api/slots?providerId=not-a-uuid')
      return { invoke: () => getSlots(query.request), wasInputRead: query.wasRead }
    },
  },
  {
    name: 'GET /api/services',
    create: () => {
      const query = observedQuery('http://localhost/api/services?unexpected=true')
      return { invoke: () => getServices(query.request), wasInputRead: query.wasRead }
    },
  },
  {
    name: 'PATCH /api/profile',
    create: () => {
      const body = observedMalformedBody()
      return { invoke: () => patchProfile(body.request), wasInputRead: body.wasRead }
    },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  routeState.authenticated = false
  routeState.events = []
  cookieMock.mockResolvedValue({ get: () => ({ value: 'forged-or-valid-token' }) })
  authGetUserMock.mockImplementation(async () => {
    routeState.events.push('auth')
    return routeState.authenticated
      ? { data: { user: { id: 'account-1' } }, error: null }
      : { data: { user: null }, error: { message: 'expired' } }
  })
})

describe('session authentication precedes EC-12 input validation', () => {
  test.each(malformedAuthenticatedSurfaces)(
    'expired cookie returns 401 before reading malformed input: $name',
    async ({ create }) => {
      const invocation = create()

      const response = await invocation.invoke()

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'session_required', message: 'Sign in to continue.' })
      expect(invocation.wasInputRead()).toBe(false)
      expect(routeState.events).toEqual(['auth'])
      expect(dataFromMock).not.toHaveBeenCalled()
      expect(guardPhiAccessMock).not.toHaveBeenCalled()
      expect(revokeShareLinkMock).not.toHaveBeenCalled()
      expect(getReportMock).not.toHaveBeenCalled()
      expect(studyDetailMock).not.toHaveBeenCalled()
      expect(clipManifestMock).not.toHaveBeenCalled()
      expect(updateOwnAccountMetadataMock).not.toHaveBeenCalled()
    },
  )

  test.each(malformedAuthenticatedSurfaces)(
    'valid session returns 422 after reading malformed input: $name',
    async ({ create }) => {
      routeState.authenticated = true
      const invocation = create()

      const response = await invocation.invoke()

      expect(response.status).toBe(422)
      await expect(response.json()).resolves.toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
      expect(invocation.wasInputRead()).toBe(true)
      expect(routeState.events).toEqual(['auth', 'parse'])
      expect(dataFromMock).not.toHaveBeenCalled()
      expect(guardPhiAccessMock).not.toHaveBeenCalled()
    },
  )
})

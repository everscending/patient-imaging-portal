import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../../lib/config', () => ({ config: { maxRequestBodyBytes: 65536 } }))

const { cookieState, resetDatabase, fakeClient } = vi.hoisted(() => {
  const cookie = { authenticated: true }
  const db = {
    services: [{ id: '11111111-1111-4111-8111-111111111111', slug: 'renal', name: 'Renal ultrasound', created_at: 'ignored' }],
    providerServices: [{ provider_id: '22222222-2222-4222-8222-222222222222', service_id: '11111111-1111-4111-8111-111111111111' }],
    providers: [{ id: '22222222-2222-4222-8222-222222222222', full_name: 'Dr. Ada', time_zone: 'America/Chicago', slot_minutes: 30 }],
    slots: [
      { id: '33333333-3333-4333-8333-333333333333', provider_id: '22222222-2222-4222-8222-222222222222', status: 'open', starts_at: '2099-01-02T10:00:00.000Z', ends_at: '2099-01-02T10:30:00.000Z' },
      { id: '44444444-4444-4444-8444-444444444444', provider_id: '22222222-2222-4222-8222-222222222222', status: 'booked', starts_at: '2099-01-02T11:00:00.000Z', ends_at: '2099-01-02T11:30:00.000Z' },
      { id: '55555555-5555-4555-8555-555555555555', provider_id: '22222222-2222-4222-8222-222222222222', status: 'open', starts_at: '2000-01-02T10:00:00.000Z', ends_at: '2000-01-02T10:30:00.000Z' },
    ] as Array<Record<string, string>>,
  }
  const reset = () => { cookie.authenticated = true }
  const client = vi.fn(() => ({
    auth: { getUser: async () => cookie.authenticated ? { data: { user: { id: 'account-1' } }, error: null } : { data: { user: null }, error: { message: 'invalid' } } },
    from(table: string) {
      const filters: Array<[string, string]> = []
      const api = {
        select() { return api },
        eq(column: string, value: string) { filters.push(['eq', `${column}:${value}`]); return api },
        gt(column: string, value: string) { filters.push(['gt', `${column}:${value}`]); return api },
        gte(column: string, value: string) { filters.push(['gte', `${column}:${value}`]); return api },
        lt(column: string, value: string) { filters.push(['lt', `${column}:${value}`]); return api },
        order() { return api },
        async maybeSingle() {
          const found = db.providerServices.find((row) => filters.every(([, pair]) => {
            const [column, value] = pair.split(':'); return row[column as keyof typeof row] === value
          }))
          return { data: found ?? null, error: null }
        },
        then(resolve: (value: unknown) => void) {
          if (table === 'services') return resolve({ data: db.services, error: null })
          if (table === 'provider_services') {
            const serviceId = filters.find(([, pair]) => pair.startsWith('service_id:'))?.[1].slice('service_id:'.length)
            const rows = db.providerServices.filter((row) => row.service_id === serviceId).map((row) => ({ providers: db.providers.find((provider) => provider.id === row.provider_id) ?? null }))
            return resolve({ data: rows, error: null })
          }
          const rows = db.slots.filter((slot) => filters.every(([kind, pair]) => {
            const [column, value] = pair.split(':')
            if (kind === 'eq') return slot[column] === value
            if (kind === 'gt') return slot[column] > value
            if (kind === 'gte') return slot[column] >= value
            return slot[column] < value
          }))
          return resolve({ data: rows, error: null })
        },
      }
      return api
    },
  }))
  return { cookieState: cookie, resetDatabase: reset, fakeClient: client }
})

vi.mock('../../lib/db/client', () => ({ anonClient: fakeClient }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => cookieState.authenticated ? { value: 'token' } : undefined }) }))

import { GET as servicesRoute } from '../../app/api/services/route'
import { GET as providersRoute } from '../../app/api/providers/route'
import { GET as slotsRoute } from '../../app/api/slots/route'
import { allowedTransitions, canChange, type AppointmentStatus, type SchedulingRole } from '../../lib/scheduling/lifecycle'

const statuses: AppointmentStatus[] = ['requested', 'confirmed', 'completed', 'cancelled', 'no_show']
const roles: SchedulingRole[] = ['patient', 'provider', 'admin']
const past = new Date('2026-01-01T00:00:00.000Z')
const future = new Date('2026-01-03T00:00:00.000Z')
const now = new Date('2026-01-02T00:00:00.000Z')
const serviceId = '11111111-1111-4111-8111-111111111111'
const providerId = '22222222-2222-4222-8222-222222222222'

beforeEach(resetDatabase)
afterEach(() => vi.clearAllMocks())

function expected(status: AppointmentStatus, role: SchedulingRole, startsAt: Date, deadline: Date): AppointmentStatus[] {
  if (status === 'completed' || status === 'cancelled' || status === 'no_show') return []
  if (status === 'requested') return role === 'patient' ? (now < deadline ? ['cancelled'] : []) : ['confirmed', 'cancelled']
  if (role === 'patient') return now < deadline ? ['cancelled'] : []
  return now > startsAt ? ['completed', 'no_show', 'cancelled'] : ['cancelled']
}

describe('FR-14 and EC-11 lifecycle matrix', () => {
  test('completeFiveStatusThreeRoleTimeDeadlineProduct', () => {
    for (const status of statuses) for (const role of roles) for (const startsAt of [past, future]) for (const deadline of [past, future]) {
      expect(allowedTransitions({ status, role, startsAt, changeDeadline: deadline, now })).toEqual(expected(status, role, startsAt, deadline))
      expect(canChange({ status, changeDeadline: deadline, now })).toBe((status === 'requested' || status === 'confirmed') && now < deadline)
    }
  })

  test('deadlineAndStartAreStrictlyBeforeAndAfter', () => {
    expect(canChange({ status: 'requested', changeDeadline: now, now })).toBe(false)
    expect(allowedTransitions({ status: 'confirmed', role: 'provider', startsAt: now, changeDeadline: future, now })).toEqual(['cancelled'])
  })

  test('terminalStatesHaveNoTransitionsForEveryRole', () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) for (const role of roles) {
      expect(allowedTransitions({ status, role, startsAt: past, changeDeadline: future, now })).toEqual([])
    }
  })
})

describe('FR-11 discovery endpoints', () => {
  test('endpointWireShapesExposeOnlyDiscoveryFields', async () => {
    expect(await (await servicesRoute(new Request('http://localhost/api/services'))).json()).toEqual({ services: [{ id: serviceId, slug: 'renal', name: 'Renal ultrasound' }] })
    expect(await (await providersRoute(new Request(`http://localhost/api/providers?serviceId=${serviceId}`))).json()).toEqual({ providers: [{ id: providerId, fullName: 'Dr. Ada', timeZone: 'America/Chicago' }] })
    expect(await (await slotsRoute(new Request(`http://localhost/api/slots?providerId=${providerId}&serviceId=${serviceId}&from=2099-01-01T00:00:00.000Z&to=2099-01-03T00:00:00.000Z`))).json()).toEqual({ slots: [{ id: '33333333-3333-4333-8333-333333333333', startsAt: '2099-01-02T10:00:00.000Z', endsAt: '2099-01-02T10:30:00.000Z' }] })
  })

  test('unauthenticatedDiscoveryDoesNotRequireIdentityLinkButRequiresSession', async () => {
    cookieState.authenticated = false
    const response = await servicesRoute(new Request('http://localhost/api/services'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'session_required', message: 'Sign in to continue.' })
  })

  test('invalidUuidDateRangeAndUnknownQueryAreValidationFailedBeforeDatabase', async () => {
    for (const url of [
      'http://localhost/api/providers?serviceId=not-a-uuid',
      `http://localhost/api/slots?providerId=not-a-uuid&serviceId=${serviceId}&from=2099-01-01T00:00:00.000Z&to=2099-01-03T00:00:00.000Z`,
      `http://localhost/api/slots?providerId=${providerId}&serviceId=${serviceId}&from=2099-01-03T00:00:00.000Z&to=2099-01-01T00:00:00.000Z`,
      'http://localhost/api/services?unexpected=value',
    ]) {
      const route = url.includes('/providers') ? providersRoute : url.includes('/slots') ? slotsRoute : servicesRoute
      const response = await route(new Request(url))
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
    }
    expect(fakeClient).not.toHaveBeenCalled()
  })

  test('providerNotOfferingRequestedServiceReturnsServiceNotOffered', async () => {
    const response = await slotsRoute(new Request(`http://localhost/api/slots?providerId=${providerId}&serviceId=66666666-6666-4666-8666-666666666666&from=2099-01-01T00:00:00.000Z&to=2099-01-03T00:00:00.000Z`))
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'service_not_offered', message: 'This provider does not offer that service.' })
  })

  test('serviceFiltersProviderEligibilityNotTheProviderSlotGridAndServerEnforcesFutureOpen', async () => {
    const response = await slotsRoute(new Request(`http://localhost/api/slots?providerId=${providerId}&serviceId=${serviceId}&from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`))
    expect(await response.json()).toEqual({ slots: [{ id: '33333333-3333-4333-8333-333333333333', startsAt: '2099-01-02T10:00:00.000Z', endsAt: '2099-01-02T10:30:00.000Z' }] })
  })
})

test('noStatusPairMappingExistsOutsideLifecycleInAppOrComponents', () => {
  const offenders: string[] = []
  for (const root of ['app', 'components']) {
    if (!statSync(root, { throwIfNoEntry: false })) continue
    const walk = (directory: string) => forEachFile(directory, (file) => {
      if (file !== path.join('lib', 'scheduling', 'lifecycle.ts') && /requested[\s\S]{0,160}(confirmed|cancelled)|confirmed[\s\S]{0,160}(completed|no_show|cancelled)/.test(readFileSync(file, 'utf8'))) offenders.push(file)
    })
    walk(root)
  }
  expect(offenders).toEqual([])
})

function forEachFile(directory: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry)
    const stat = statSync(file)
    if (stat.isDirectory()) forEachFile(file, visit)
    else if (/\.(ts|tsx)$/.test(file)) visit(file)
  }
}

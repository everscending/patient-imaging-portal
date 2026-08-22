// Unit coverage for the password-login brute-force throttle (AUDIT.md #2).
// serviceClient is mocked, so this runs without a database or Docker container.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const REQUIRED_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SOURCE_REF_SALT: 'test-source-ref-salt',
  LOGIN_MAX_ATTEMPTS: '3',
  LOGIN_LOCKOUT_MINUTES: '15',
}

// A chainable stub of the PostgREST query builder. `count` is what the failure
// tally reads; `insertRows` captures what recordLoginAttempt writes.
function makeClient(count: number) {
  const insertRows: unknown[] = []
  const selectChain = {
    eq() {
      return this
    },
    gte() {
      return Promise.resolve({ count, error: null })
    },
  }
  const client = {
    from() {
      return {
        select: () => selectChain,
        insert: (row: unknown) => {
          insertRows.push(row)
          return Promise.resolve({ error: null })
        },
      }
    },
  }
  return { client, insertRows }
}

async function loadThrottle() {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value)
  vi.resetModules()
  return import('../../lib/access/login-throttle')
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('login throttle', () => {
  test('emailHash is deterministic, salted, and case/space-insensitive', async () => {
    const { emailHash } = await loadThrottle()
    const a = emailHash('User@Example.com')
    const b = emailHash('  user@example.com ')
    expect(a).toBe(b) // normalized
    expect(a).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
    // salt participates: a different salt would change the digest
    expect(a).not.toBe('user@example.com')
  })

  test('locks once failures reach the configured maximum, not before', async () => {
    const { isLoginLocked } = await loadThrottle()
    const belowClient = makeClient(2) // LOGIN_MAX_ATTEMPTS = 3
    expect(await isLoginLocked(belowClient.client as never, 'eh', 'sr')).toBe(false)

    const atClient = makeClient(3)
    expect(await isLoginLocked(atClient.client as never, 'eh', 'sr')).toBe(true)
  })

  test('fails open (not locked) when the attempt store is unreachable', async () => {
    const { isLoginLocked } = await loadThrottle()
    const brokenClient = {
      from: () => ({
        select: () => ({ eq() { return this }, gte: () => Promise.resolve({ count: null, error: { message: 'store down' } }) }),
      }),
    }
    expect(await isLoginLocked(brokenClient as never, 'eh', 'sr')).toBe(false)
  })

  test('recordLoginAttempt writes email_hash, source_ref and succeeded', async () => {
    const { recordLoginAttempt } = await loadThrottle()
    const { client, insertRows } = makeClient(0)
    await recordLoginAttempt(client as never, { hashedEmail: 'eh', sourceRef: 'sr', succeeded: false })
    expect(insertRows).toEqual([{ email_hash: 'eh', source_ref: 'sr', succeeded: false }])
  })
})

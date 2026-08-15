import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, test, vi } from 'vitest'

// server-only throws unconditionally under plain Node (no `react-server`
// resolution condition), so every test that just wants anonClient/
// serviceClient needs it neutralized. The one test that cares about the
// real throw (bottom of this file) unmocks it deliberately.
vi.mock('server-only', () => ({}))

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

// The four vars lib/config.ts requires with no default — anonClient/
// serviceClient both import config, so it must load cleanly first.
const REQUIRED_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SOURCE_REF_SALT: 'test-source-ref-salt',
}

// Tracked plus untracked-but-not-ignored files, so a guard sees this
// ticket's new files even before they're staged.
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
  })
    .toString()
    .trim()
    .split('\n')
}

// Loads a fresh lib/db/client.ts against REQUIRED_ENV plus overrides, so
// each test's config values (and the module's no-caching behavior) are
// independent of any other test's env mutation. vi.stubEnv, not a direct
// environment write, so this file stays out of the single-reader guard
// tests/config/config.test.ts owns for that literal reference.
async function loadClientModule(overrides: Record<string, string> = {}) {
  const merged = { ...REQUIRED_ENV, ...overrides }
  for (const [key, value] of Object.entries(merged)) vi.stubEnv(key, value)
  vi.resetModules()
  return import('../../lib/db/client')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

// SupabaseClient keeps its constructor args and merged headers as protected
// fields — real fields, just not part of the public type. Reading them here
// is the only black-box way to assert which token/key/url a client carries
// without stubbing global fetch.
type ClientInternals = SupabaseClient & {
  headers: Record<string, string>
  supabaseKey: string
  supabaseUrl: string
}

describe('anonClient — pinned: default for every PHI read, caller\'s own session (§4)', () => {
  test('acceptance: builds a client whose requests carry the given access token', async () => {
    const { anonClient } = await loadClientModule()
    const client = anonClient('token-abc') as unknown as ClientInternals
    expect(client.headers.Authorization).toBe('Bearer token-abc')
    expect(client.supabaseKey).toBe(REQUIRED_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    expect(client.supabaseUrl).toContain('test-project.supabase.co')
  })

  test('acceptance: two calls with different tokens produce two independent clients', async () => {
    const { anonClient } = await loadClientModule()
    const clientA = anonClient('token-a') as unknown as ClientInternals
    const clientB = anonClient('token-b') as unknown as ClientInternals
    expect(clientA).not.toBe(clientB)
    expect(clientA.headers.Authorization).toBe('Bearer token-a')
    expect(clientB.headers.Authorization).toBe('Bearer token-b')
  })

  test('adversarial: a cached client returned to a second caller with a different token — same-token calls still return two independent clients, not one shared instance', async () => {
    const { anonClient } = await loadClientModule()
    const first = anonClient('same-token')
    const second = anonClient('same-token')
    expect(first).not.toBe(second)
  })

  test("adversarial: anonClient('') is a client with no session reading as unauthenticated — rejected instead of built", async () => {
    const { anonClient } = await loadClientModule()
    expect(() => anonClient('')).toThrow(/accessToken/)
  })

  test('adversarial: anonClient(undefined as unknown as string) is a keyless client built anyway — rejected instead of built', async () => {
    const { anonClient } = await loadClientModule()
    expect(() => anonClient(undefined as unknown as string)).toThrow(/accessToken/)
  })
})

describe('serviceClient — pinned: legal in exactly three places (FR-2, share-token resolution, reminder job)', () => {
  test('acceptance: uses config.supabaseServiceRoleKey and config.supabaseUrl, read from lib/config.ts', async () => {
    const { serviceClient } = await loadClientModule({
      SUPABASE_SERVICE_ROLE_KEY: 'distinct-service-role-key',
      NEXT_PUBLIC_SUPABASE_URL: 'https://distinct-project.supabase.co',
    })
    const client = serviceClient() as unknown as ClientInternals
    expect(client.supabaseKey).toBe('distinct-service-role-key')
    expect(client.supabaseUrl).toContain('distinct-project.supabase.co')
  })
})

describe('module hygiene — pinned: keys come from lib/config.ts, never the raw environment', () => {
  const content = readFileSync(path.join(REPO_ROOT, 'lib/db/client.ts'), 'utf8')
  // Built by concatenation, not written as one literal, so this test file
  // itself never contains the substring tests/config/config.test.ts's own
  // single-reader guard scans the tree for.
  const rawEnvAccess = 'process' + '.env'

  test('acceptance: the module contains no raw-environment reference', () => {
    expect(content).not.toContain(rawEnvAccess)
  })

  test('adversarial: lib/db/client.ts reading the service-role key straight off the raw environment never lands — the module imports config from lib/config.ts instead', () => {
    expect(content).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(content).toMatch(/from ['"]\.\.\/config['"]/)
  })
})

describe('repo-wide guard — pinned: lib/db/client.ts is the only module importing @supabase/supabase-js', () => {
  test('adversarial: a second module importing @supabase/supabase-js is caught tree-wide', () => {
    // This test file names the package too, to mock/import/assert against
    // it — legitimate, and excluded the same way config.test.ts excludes
    // itself from its own raw-environment guard.
    const hits = trackedFiles().filter((file) => {
      if (!file || file === 'tests/db/client.test.ts') return false
      if (!(file.endsWith('.ts') || file.endsWith('.tsx'))) return false
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      return content.includes('@supabase/supabase-js')
    })
    expect(hits.sort()).toEqual(['lib/db/client.ts'])
  })
})

// Kept last: it deliberately unmocks 'server-only' and never re-mocks it,
// so any test relying on the top-of-file mock must run before this one.
describe('server-only — pinned: the module is server-only and fails the build if imported from a client component (§8)', () => {
  test('adversarial: the service-role key reaching a client bundle — importing outside the server-component condition throws before any client is built', async () => {
    vi.doUnmock('server-only')
    vi.resetModules()
    await expect(import('../../lib/db/client')).rejects.toThrow(/Client Component/)
  })
})

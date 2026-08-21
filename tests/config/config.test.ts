import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The four variables lib/config.ts requires with no default (ADR-0012, SEC-6/7).
const REQUIRED_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SOURCE_REF_SALT: 'test-source-ref-salt',
}

// Every variable §8 assigns to lib/config.ts, in §8's order.
const ALL_ENV_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_PRACTICE_NAME',
  'APP_BASE_URL',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'EMAIL_TRANSPORT',
  'EMAIL_OUTBOX_MAX_ATTEMPTS',
  'EMAIL_SEND_TIMEOUT_MS',
  'CRON_SECRET',
  'SHARE_LINK_TTL_HOURS',
  'MIN_CHANGE_NOTICE_HOURS',
  'REMINDER_LEAD_HOURS',
  'IDENTITY_MAX_ATTEMPTS',
  'IDENTITY_LOCKOUT_MINUTES',
  'SIGNED_URL_TTL_SECONDS',
  'SLOT_HORIZON_DAYS',
  'MAX_REQUEST_BODY_BYTES',
  'SOURCE_REF_SALT',
  'REMINDER_WINDOW_MINUTES',
  'REMINDER_CRON_MINUTES',
  'SEED_SOURCE_SEED',
  'PORT',
  'TEST_PG_PORT',
]

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ALL_ENV_KEYS) savedEnv[key] = process.env[key]
  for (const key of ALL_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ALL_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

// Loads a fresh lib/config.ts module against REQUIRED_ENV plus overrides.
// `undefined` in overrides deletes the key (simulates "unset"), matching
// how process.env actually behaves — assigning undefined stringifies it.
async function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const merged = { ...REQUIRED_ENV, ...overrides }
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  return import('../../lib/config')
}

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

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

describe('defaults — acceptance: config reads every default with only the four required vars set', () => {
  test('every default value matches ARCHITECTURE.md §8', async () => {
    const { config } = await loadConfig()
    expect(config.shareLinkTtlHours).toBe(48)
    expect(config.minChangeNoticeHours).toBe(24)
    expect(config.reminderLeadHours).toBe(24)
    expect(config.emailOutboxMaxAttempts).toBe(5)
    expect(config.emailSendTimeoutMs).toBe(10_000)
    expect(config.identityMaxAttempts).toBe(3)
    expect(config.identityLockoutMinutes).toBe(5)
    expect(config.signedUrlTtlSeconds).toBe(300)
    expect(config.slotHorizonDays).toBe(60)
    expect(config.maxRequestBodyBytes).toBe(65536)
    expect(config.reminderWindowMinutes).toBe(30)
    expect(config.reminderCronMinutes).toBe(5)
    expect(config.seedSourceSeed).toBe('patient-imaging-portal')
    expect(config.appBaseUrl).toBe('http://localhost:4310')
    expect(config.port).toBe(4310)
    expect(config.testPgPort).toBeNull()
    expect(config.resendApiKey).toBeNull()
    expect(config.resendFrom).toBeNull()
    expect(config.cronSecret).toBeNull()
    expect(config.practiceName).toBe('Patient Imaging Portal')
  })
})

describe('required variables — acceptance: fail loudly, never print a value', () => {
  test('missing SUPABASE_SERVICE_ROLE_KEY fails startup naming the variable', async () => {
    await expect(loadConfig({ SUPABASE_SERVICE_ROLE_KEY: undefined })).rejects.toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    )
  })

  test('missing SOURCE_REF_SALT fails startup naming the variable', async () => {
    await expect(loadConfig({ SOURCE_REF_SALT: undefined })).rejects.toThrow(/SOURCE_REF_SALT/)
  })

  test('adversarial: missing NEXT_PUBLIC_SUPABASE_URL fails instead of continuing with undefined', async () => {
    await expect(loadConfig({ NEXT_PUBLIC_SUPABASE_URL: undefined })).rejects.toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    )
  })

  test('adversarial: empty-string SUPABASE_SERVICE_ROLE_KEY is treated as missing, not present', async () => {
    await expect(loadConfig({ SUPABASE_SERVICE_ROLE_KEY: '' })).rejects.toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    )
  })

  test('adversarial: missing SOURCE_REF_SALT never produces an unsalted or undefined-salted config', async () => {
    // sourceRefSalt has no default anywhere in Config — the only way to avoid
    // an unsalted source_ref is for module load to throw before config exists.
    await expect(loadConfig({ SOURCE_REF_SALT: undefined })).rejects.toThrow(Error)
  })

  test('adversarial: a config error never includes the variable value', async () => {
    const secret = 'super-secret-token-xyz-should-never-appear'
    await expect(loadConfig({ IDENTITY_LOCKOUT_MINUTES: secret })).rejects.toThrow(
      /IDENTITY_LOCKOUT_MINUTES/,
    )
    try {
      await loadConfig({ IDENTITY_LOCKOUT_MINUTES: secret })
      throw new Error('expected loadConfig to throw')
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret)
    }
  })
})

describe('numeric validation — acceptance + adversarial: NaN, zero, negative, non-integer all fail', () => {
  test('adversarial: SHARE_LINK_TTL_HOURS=abc is a NaN that fails startup instead of reaching a caller', async () => {
    await expect(loadConfig({ SHARE_LINK_TTL_HOURS: 'abc' })).rejects.toThrow(/SHARE_LINK_TTL_HOURS/)
  })

  test('adversarial: IDENTITY_MAX_ATTEMPTS=0 fails startup instead of a lockout that never locks', async () => {
    await expect(loadConfig({ IDENTITY_MAX_ATTEMPTS: '0' })).rejects.toThrow(/IDENTITY_MAX_ATTEMPTS/)
  })

  test('adversarial: IDENTITY_MAX_ATTEMPTS=-1 fails startup instead of a lockout that never locks', async () => {
    await expect(loadConfig({ IDENTITY_MAX_ATTEMPTS: '-1' })).rejects.toThrow(/IDENTITY_MAX_ATTEMPTS/)
  })

  test('adversarial: SIGNED_URL_TTL_SECONDS=300.5 is a non-integer TTL that fails startup', async () => {
    await expect(loadConfig({ SIGNED_URL_TTL_SECONDS: '300.5' })).rejects.toThrow(
      /SIGNED_URL_TTL_SECONDS/,
    )
  })

  test.each(['0', '-1', '1.5', 'not-a-number'])(
    'adversarial: EMAIL_OUTBOX_MAX_ATTEMPTS=%s fails startup',
    async (value) => {
      await expect(loadConfig({ EMAIL_OUTBOX_MAX_ATTEMPTS: value })).rejects.toThrow(
        /EMAIL_OUTBOX_MAX_ATTEMPTS/,
      )
    },
  )

  test.each(['0', '-1', '1.5', 'not-a-number'])(
    'adversarial: EMAIL_SEND_TIMEOUT_MS=%s fails startup',
    async (value) => {
      await expect(loadConfig({ EMAIL_SEND_TIMEOUT_MS: value })).rejects.toThrow(
        /EMAIL_SEND_TIMEOUT_MS/,
      )
    },
  )
})

describe('reminder cadence — acceptance: refuses to start when cron cadence is not smaller than the window', () => {
  test('adversarial: REMINDER_CRON_MINUTES=30 with REMINDER_WINDOW_MINUTES=30 fails (>=, not >)', async () => {
    await expect(
      loadConfig({ REMINDER_CRON_MINUTES: '30', REMINDER_WINDOW_MINUTES: '30' }),
    ).rejects.toThrow(/REMINDER_CRON_MINUTES/)
  })

  test('a cadence above the window fails', async () => {
    await expect(
      loadConfig({ REMINDER_CRON_MINUTES: '31', REMINDER_WINDOW_MINUTES: '30' }),
    ).rejects.toThrow(/REMINDER_CRON_MINUTES/)
  })

  test('5 against 30 starts', async () => {
    const { config } = await loadConfig({ REMINDER_CRON_MINUTES: '5', REMINDER_WINDOW_MINUTES: '30' })
    expect(config.reminderCronMinutes).toBe(5)
    expect(config.reminderWindowMinutes).toBe(30)
  })
})

describe('email transport — acceptance + adversarial: resend/log only, log fallback without a key (GAP-3)', () => {
  test('RESEND_API_KEY absent resolves emailTransport to log', async () => {
    const { config } = await loadConfig()
    expect(config.emailTransport).toBe('log')
  })

  test('RESEND_API_KEY present resolves emailTransport to resend by default', async () => {
    const { config } = await loadConfig({ RESEND_API_KEY: 're_test_key' })
    expect(config.emailTransport).toBe('resend')
  })

  test('adversarial: EMAIL_TRANSPORT=smtp is outside resend|log and fails startup', async () => {
    await expect(loadConfig({ EMAIL_TRANSPORT: 'smtp' })).rejects.toThrow(/EMAIL_TRANSPORT/)
  })

  test('resendApiKey, resendFrom, cronSecret are nullable so every flow runs without a live key (GAP-3)', async () => {
    const { config } = await loadConfig()
    expect(config.resendApiKey).toBeNull()
    expect(config.resendFrom).toBeNull()
    expect(config.cronSecret).toBeNull()
  })
})

describe('.env.example — acceptance + adversarial: complete, ordered, placeholders only, no secrets', () => {
  const envExample = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8')
  const envExampleKeys = envExample
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0])

  test('lists all 25 §8 rows, in §8 order, and nothing else', () => {
    expect(envExampleKeys).toEqual(ALL_ENV_KEYS)
    expect(envExampleKeys).toHaveLength(25)
  })

  test('ADR-0011: IDENTITY_UNLOCK_TTL_MINUTES appears nowhere in the app/config surface this ticket owns', () => {
    // Scoped to this ticket's file surface (package.json, lib/, app/, tests/,
    // .env.example, scripts/, next.config.ts, tsconfig.json) rather than the
    // whole tree: pre-existing top-level docs (ARCHITECTURE.md §8 etc.) still
    // carry the pre-ADR-0011 table and are not in this ticket's Files touched
    // list — updating them is a documentation ticket's job, not this one's.
    const hits = trackedFiles().filter((file) => {
      if (!file) return false
      const ownedSurface =
        file === 'package.json' ||
        file === 'next.config.ts' ||
        file === 'tsconfig.json' ||
        file === '.env.example' ||
        file.startsWith('lib/') ||
        file.startsWith('app/') ||
        file.startsWith('tests/') ||
        file.startsWith('scripts/')
      // This test file necessarily names the variable in its own test title.
      if (!ownedSurface || file === 'tests/config/config.test.ts') return false
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      return content.includes('IDENTITY_UNLOCK_TTL_MINUTES')
    })
    expect(hits).toEqual([])
  })

  test('adversarial: no value in .env.example is a committed secret (SEC-7)', () => {
    const values = envExample
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#') && line.includes('='))
      .map((line) => line.slice(line.indexOf('=') + 1))

    // A real Supabase/Resend key is a long opaque token; a real salt is high
    // entropy. Every placeholder here is either empty, a stated default, or
    // an obvious "replace-with-*" / example.com marker — never key-shaped.
    const keyShaped = /^(sk_|re_|eyJ)[a-zA-Z0-9_.-]{16,}$/
    for (const value of values) {
      expect(value).not.toMatch(keyShaped)
      expect(value).not.toMatch(/^https?:\/\/(?!localhost)(?!your-)[a-z0-9.-]*\.supabase\.co$/)
    }
  })
})

describe('.env.test fallback — acceptance: Playwright gets a usable value without weakening the real check (JOR-270)', () => {
  const originalArgv1 = process.argv[1]

  afterEach(() => {
    process.argv[1] = originalArgv1
  })

  test('a process whose entrypoint looks like Playwright resolves the four required vars from .env.test when unset', async () => {
    process.argv[1] = '/repo/node_modules/.bin/playwright'
    const { config } = await loadConfig({
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      SOURCE_REF_SALT: undefined,
    })
    expect(config.supabaseUrl).toBe('https://test-project.supabase.co')
    expect(config.supabaseAnonKey).toBe('test-anon-key')
    expect(config.supabaseServiceRoleKey).toBe('test-service-role-key')
    expect(config.sourceRefSalt).toBe('test-source-ref-salt')
  })

  test('adversarial: a real value already set always wins over .env.test, even under Playwright', async () => {
    process.argv[1] = '/repo/node_modules/.bin/playwright'
    const { config } = await loadConfig({ NEXT_PUBLIC_SUPABASE_URL: 'https://real-prod.supabase.co' })
    expect(config.supabaseUrl).toBe('https://real-prod.supabase.co')
  })

  test('adversarial: a non-Playwright entrypoint (e.g. a real deployment) still fails loudly when a required var is missing', async () => {
    process.argv[1] = '/repo/node_modules/.bin/next'
    await expect(loadConfig({ NEXT_PUBLIC_SUPABASE_URL: undefined })).rejects.toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    )
  })
})

describe('repo-wide guards', () => {
  test('process.env readers match the exact allowlist', () => {
    // lib/config.ts is production code's sole reader (ARCHITECTURE.md §2).
    // This test file legitimately touches process.env too, since exercising
    // every branch of config validation requires setting and unsetting it.
    const hits = trackedFiles().filter((file) => {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.mjs') && !file.endsWith('.js')) {
        return false
      }
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      return content.includes('process.env')
    })
    // ARCHITECTURE.md §8 names `TEST_PG_PORT`'s reader as "test harness", not
    // lib/config.ts — JOR-195's tests/setup/postgres.ts and the test files
    // that exercise it are the other legitimate readers this guard allows.
    // JOR-229's e2e/fixtures/start-test-server.mjs and JOR-288's
    // scripts/run-next.mjs are process-launch boundaries that forward values
    // to a child. JOR-295's provisioner is a process-entry boundary that reads
    // only its PROVISION_DEPLOYED_STACK bootstrap flag; application
    // configuration remains owned by lib/config.ts.
    expect(hits.sort()).toEqual([
      'e2e/fixtures/start-test-server.mjs',
      'lib/config.ts',
      'scripts/provision-deployed-stack.ts',
      'scripts/run-next.mjs',
      'tests/config/config.test.ts',
      'tests/gate/gate.test.ts',
      'tests/integration/postgres-harness.test.ts',
      'tests/setup/postgres.ts',
    ])
  })

  test('no bare 3000 in package.json, next.config.ts, or scripts/', () => {
    const candidates = trackedFiles().filter(
      (file) =>
        file === 'package.json' ||
        file === 'next.config.ts' ||
        file.startsWith('scripts/') ||
        file.startsWith('app/') ||
        file.startsWith('lib/'),
    )
    for (const file of candidates) {
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      expect(content, `${file} must not contain a bare 3000`).not.toMatch(/\b3000\b/)
    }
  })
})

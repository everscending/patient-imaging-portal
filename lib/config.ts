// lib/config.ts — the ONLY module reading process.env (ARCHITECTURE.md §2, §8)
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type Config = {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRoleKey: string
  appBaseUrl: string // default 'http://localhost:4310'
  resendApiKey: string | null
  resendFrom: string | null
  emailTransport: 'resend' | 'log' // default 'resend'; 'log' when no key (GAP-3)
  emailOutboxMaxAttempts: number // default 5
  emailSendTimeoutMs: number // default 10000
  cronSecret: string | null
  shareLinkTtlHours: number // default 48
  minChangeNoticeHours: number // default 24
  reminderLeadHours: number // default 24
  identityMaxAttempts: number // default 3
  identityLockoutMinutes: number // default 5
  signedUrlTtlSeconds: number // default 300
  slotHorizonDays: number // default 60 (ADR-0012)
  maxRequestBodyBytes: number // default 65536 — 64 KiB (ADR-0012)
  sourceRefSalt: string // required, no default (ADR-0012)
  reminderWindowMinutes: number // default 30 (ADR-0012)
  reminderCronMinutes: number // default 5; MUST be < reminderWindowMinutes
  seedSourceSeed: string // default 'patient-imaging-portal'
  port: number // default 4310
  testPgPort: number | null // ADR-0013: unset ⇒ ephemeral port
}

// SEC-6, SEC-7: names the variable, never its value.
class ConfigError extends Error {
  constructor(variable: string, reason: string) {
    super(`config: ${reason}: ${variable}`)
    this.name = 'ConfigError'
  }
}

// An empty string is a missing value, not a value.
function readRaw(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value === '') return undefined
  return value
}

function requireString(name: string): string {
  const value = readRaw(name)
  if (value === undefined) throw new ConfigError(name, 'missing required environment variable')
  return value
}

function optionalString(name: string): string | null {
  return readRaw(name) ?? null
}

function stringWithDefault(name: string, fallback: string): string {
  return readRaw(name) ?? fallback
}

// A numeric variable that does not parse, or parses to zero or negative,
// fails startup like a missing required one. Only whole positive digit
// strings pass — no sign, no decimal point, no exponent.
function parsePositiveInt(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new ConfigError(name, 'invalid numeric value')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(name, 'invalid numeric value')
  return value
}

function intWithDefault(name: string, fallback: number): number {
  const raw = readRaw(name)
  if (raw === undefined) return fallback
  return parsePositiveInt(name, raw)
}

function optionalPositiveInt(name: string): number | null {
  const raw = readRaw(name)
  if (raw === undefined) return null
  return parsePositiveInt(name, raw)
}

// Backs the four required variables with .env.test placeholders, but only
// when Playwright's own CLI is the one requiring this module — never for
// `next build`/`next start`/`next dev`, and never for Vitest, which manages
// its own env per test (tests/config/config.test.ts relies on being able to
// unset a required variable and see loadConfig reject). A variable already
// set in the real environment always wins (fallback only fills gaps), so a
// real deployment that's missing one still fails loudly.
function applyTestEnvFallback(): void {
  const isPlaywright = process.argv[1]?.includes('playwright') ?? false
  if (!isPlaywright) return

  const envTestPath = path.resolve(__dirname, '..', '.env.test')
  if (!existsSync(envTestPath)) return

  for (const line of readFileSync(envTestPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue
    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function loadConfig(): Config {
  applyTestEnvFallback()

  const supabaseUrl = requireString('NEXT_PUBLIC_SUPABASE_URL')
  const supabaseAnonKey = requireString('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  const supabaseServiceRoleKey = requireString('SUPABASE_SERVICE_ROLE_KEY')
  const sourceRefSalt = requireString('SOURCE_REF_SALT')

  const appBaseUrl = stringWithDefault('APP_BASE_URL', 'http://localhost:4310')
  const resendApiKey = optionalString('RESEND_API_KEY')
  const resendFrom = optionalString('RESEND_FROM')
  const cronSecret = optionalString('CRON_SECRET')

  const emailTransportRaw = optionalString('EMAIL_TRANSPORT')
  if (emailTransportRaw !== null && emailTransportRaw !== 'resend' && emailTransportRaw !== 'log') {
    throw new ConfigError('EMAIL_TRANSPORT', 'invalid value, must be resend or log')
  }
  // resolves to 'log' when RESEND_API_KEY is absent, regardless of the
  // requested transport — GAP-3 requires every flow to run without a live key.
  const emailTransport: 'resend' | 'log' = resendApiKey === null ? 'log' : emailTransportRaw ?? 'resend'
  const emailOutboxMaxAttempts = intWithDefault('EMAIL_OUTBOX_MAX_ATTEMPTS', 5)
  const emailSendTimeoutMs = intWithDefault('EMAIL_SEND_TIMEOUT_MS', 10_000)

  const shareLinkTtlHours = intWithDefault('SHARE_LINK_TTL_HOURS', 48)
  const minChangeNoticeHours = intWithDefault('MIN_CHANGE_NOTICE_HOURS', 24)
  const reminderLeadHours = intWithDefault('REMINDER_LEAD_HOURS', 24)
  const identityMaxAttempts = intWithDefault('IDENTITY_MAX_ATTEMPTS', 3)
  const identityLockoutMinutes = intWithDefault('IDENTITY_LOCKOUT_MINUTES', 5)
  const signedUrlTtlSeconds = intWithDefault('SIGNED_URL_TTL_SECONDS', 300)
  const slotHorizonDays = intWithDefault('SLOT_HORIZON_DAYS', 60)
  const maxRequestBodyBytes = intWithDefault('MAX_REQUEST_BODY_BYTES', 65536)
  const reminderWindowMinutes = intWithDefault('REMINDER_WINDOW_MINUTES', 30)
  const reminderCronMinutes = intWithDefault('REMINDER_CRON_MINUTES', 5)
  const seedSourceSeed = stringWithDefault('SEED_SOURCE_SEED', 'patient-imaging-portal')
  const port = intWithDefault('PORT', 4310)
  const testPgPort = optionalPositiveInt('TEST_PG_PORT')

  // The comparison is >=, not >: a cadence equal to the window already
  // drifts a band open under any scheduler jitter (ADR-0012).
  if (reminderCronMinutes >= reminderWindowMinutes) {
    throw new ConfigError('REMINDER_CRON_MINUTES', 'must be smaller than REMINDER_WINDOW_MINUTES')
  }

  return {
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    appBaseUrl,
    resendApiKey,
    resendFrom,
    emailTransport,
    emailOutboxMaxAttempts,
    emailSendTimeoutMs,
    cronSecret,
    shareLinkTtlHours,
    minChangeNoticeHours,
    reminderLeadHours,
    identityMaxAttempts,
    identityLockoutMinutes,
    signedUrlTtlSeconds,
    slotHorizonDays,
    maxRequestBodyBytes,
    sourceRefSalt,
    reminderWindowMinutes,
    reminderCronMinutes,
    seedSourceSeed,
    port,
    testPgPort,
  }
}

export const config: Config = loadConfig()

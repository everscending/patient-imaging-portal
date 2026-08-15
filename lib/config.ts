// lib/config.ts — the ONLY module reading process.env (ARCHITECTURE.md §2, §8)
export type Config = {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRoleKey: string
  appBaseUrl: string // default 'http://localhost:4310'
  resendApiKey: string | null
  resendFrom: string | null
  emailTransport: 'resend' | 'log' // default 'resend'; 'log' when no key (GAP-3)
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

function loadConfig(): Config {
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

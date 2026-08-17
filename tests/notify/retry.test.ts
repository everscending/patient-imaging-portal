import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type { EmailMessage, SendOutcome } from '../../lib/notify/email'
import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const { sendMock, ResendMock } = vi.hoisted(() => {
  const sendMock = vi.fn()
  const ResendMock = vi.fn().mockImplementation(() => ({ emails: { send: sendMock } }))
  return { sendMock, ResendMock }
})

vi.mock('resend', () => ({ Resend: ResendMock }))

const REQUIRED_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SOURCE_REF_SALT: 'test-source-ref-salt',
}

let dbRun: Run

beforeAll(async () => {
  dbRun = await startRun(await ensureContainer())
}, 120_000)

afterAll(async () => {
  if (dbRun) await stopRun(dbRun)
})

async function loadEmail(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...REQUIRED_ENV, ...overrides })) {
    vi.stubEnv(key, value)
  }
  vi.resetModules()
  return import('../../lib/notify/email')
}

beforeEach(() => {
  sendMock.mockReset()
  ResendMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('bounded email delivery', () => {
  test('a never-settling provider resolves as a sanitized failure at the configured timeout', async () => {
    vi.useFakeTimers()
    sendMock.mockReturnValue(new Promise(() => {}))
    const { sendEmail } = await loadEmail({
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'clinic@example.com',
      EMAIL_SEND_TIMEOUT_MS: '25',
    })
    const message: EmailMessage = {
      to: 'private.patient@example.com',
      subject: 'A share token must stay private',
      text: 'https://portal.example/s/secret-share-token',
    }
    let settled: SendOutcome | undefined

    void sendEmail(message).then((outcome) => { settled = outcome })
    await vi.advanceTimersByTimeAsync(25)

    expect(settled).toEqual({
      outcome: 'failed',
      transport: 'resend',
      error: 'email delivery timed out',
    })
    expect(JSON.stringify(settled)).not.toMatch(
      /private\.patient@example\.com|secret-share-token|A share token must stay private/,
    )
  })

  test('provider errors that echo message secrets are replaced with a safe code', async () => {
    sendMock.mockRejectedValue(
      new Error('private.patient@example.com rejected https://portal.example/s/secret-share-token'),
    )
    const { sendEmail } = await loadEmail({
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'clinic@example.com',
    })

    await expect(sendEmail({
      to: 'private.patient@example.com',
      subject: 'A share token must stay private',
      text: 'https://portal.example/s/secret-share-token',
    })).resolves.toEqual({
      outcome: 'failed',
      transport: 'resend',
      error: 'email delivery failed',
    })
  })
})

describe('durable enqueue', () => {
  test('enqueueEmail writes exactly one message row through the authenticated client', async () => {
    const insert = vi.fn().mockResolvedValue({ data: null, error: null })
    const from = vi.fn(() => ({ insert }))
    const { enqueueEmail } = await loadEmail()
    const message: EmailMessage = {
      to: 'recipient@example.com',
      subject: 'Someone shared a secure medical file with you',
      text: 'A patient shared a secure file: https://portal.example/s/opaque-token',
    }

    await expect(enqueueEmail({ from } as never, message)).resolves.toBe(true)
    expect(from).toHaveBeenCalledOnce()
    expect(from).toHaveBeenCalledWith('email_outbox')
    expect(insert).toHaveBeenCalledOnce()
    expect(insert).toHaveBeenCalledWith({
      recipient: message.to,
      subject: message.subject,
      body: message.text,
    })
  })
})

describe('reminder retry authority', () => {
  test('migration grants application role neither delete nor atomic claim authority', () => {
    const grants = readFileSync('db/migrations/003_rls.sql', 'utf8')
    const claim = readFileSync('db/migrations/004_pg_cron_reminders.sql', 'utf8')

    expect(grants).toMatch(/grant insert, update on[\s\S]*reminder_sends to app_user;/)
    expect(grants).not.toMatch(/grant[^;]*delete[^;]*reminder_sends[^;]*to app_user;/i)
    expect(claim).toContain(
      'revoke execute on function claim_reminder_send(uuid, integer, integer) from app_user;',
    )
  })

  test.each([
    'delete from reminder_sends;',
    "select claim_reminder_send('00000000-0000-4000-8000-000000000000'::uuid, 24, 5);",
  ])('application role receives insufficient_privilege for %s', (statement) => {
    expect(() => execFileSync(
      'docker',
      [
        'exec', 'pip-testpg', 'psql', '-U', 'postgres', '-d', dbRun.dbName,
        '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', `set role app_user; ${statement}`,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    )).toThrow(/42501|permission denied/i)
  })
})

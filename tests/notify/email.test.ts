import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EmailMessage } from '../../lib/notify/email'

// Stubs the Resend SDK (the design decision: "Tests exercise the Resend path
// through an injected/stubbed SDK client"). lib/notify/email.ts is the only
// production module that imports 'resend', so this is the only test file
// that needs to reach past that boundary.
const { sendMock, ResendMock, mkdirMock, writeFileMock } = vi.hoisted(() => {
  const sendMock = vi.fn()
  const ResendMock = vi.fn().mockImplementation(() => ({ emails: { send: sendMock } }))
  return { sendMock, ResendMock, mkdirMock: vi.fn(), writeFileMock: vi.fn() }
})
vi.mock('resend', () => ({ Resend: ResendMock }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  mkdirMock.mockImplementation(actual.mkdir)
  writeFileMock.mockImplementation(actual.writeFile)
  return { ...actual, mkdir: mkdirMock, writeFile: writeFileMock }
})

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const MAIL_DIR = path.join(REPO_ROOT, '.local', 'mail')

const REQUIRED_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SOURCE_REF_SALT: 'test-source-ref-salt',
}

beforeEach(async () => {
  sendMock.mockReset()
  ResendMock.mockClear()
  await rm(MAIL_DIR, { recursive: true, force: true })
})

// vi.stubEnv/unstubAllEnvs, not a direct assignment: this file must stay off
// the repo-wide "only lib/config.ts reads the environment" guard's radar
// (tests/config/config.test.ts), the same way tests/setup/postgres.ts does —
// by never spelling that global out literally.
afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await rm(MAIL_DIR, { recursive: true, force: true })
})

// Loads a fresh lib/notify/email.ts against REQUIRED_ENV plus overrides, the
// same pattern tests/config/config.test.ts uses so each test sees its own
// resolved config.emailTransport.
async function loadEmail(overrides: Record<string, string | undefined> = {}) {
  const merged = { ...REQUIRED_ENV, ...overrides }
  for (const [key, value] of Object.entries(merged)) {
    vi.stubEnv(key, value)
  }
  vi.resetModules()
  return import('../../lib/notify/email')
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
  })
    .toString()
    .trim()
    .split('\n')
}

async function mailFiles(): Promise<string[]> {
  try {
    return await readdir(MAIL_DIR)
  } catch {
    return []
  }
}

// UX_SPEC.md §4.15 — the two bodies this adapter ever carries, verbatim.
// A caller (T31, T48) fills {url}/{expiry}/{appUrl} before calling sendEmail;
// this adapter never edits the result.
const SHARE_LINK_SUBJECT = 'Someone shared a secure medical file with you'
function shareLinkText(url: string, expiry: string): string {
  return `A patient has shared a secure file with you through their clinic's portal.\n\n${url}\n\nThe link works until ${expiry} and can be revoked by the person who shared it at any time. Opening it is recorded.\n\nIf you were not expecting this, ignore this message.`
}

const APPOINTMENT_REMINDER_SUBJECT = 'Appointment reminder'
function appointmentReminderText(appUrl: string): string {
  return `You have an appointment in 24 hours.\n\n${appUrl}/appointments\n\nSign in to see the details, or to change or cancel it.`
}

describe('log transport — acceptance: GAP-3 keyless fallback', () => {
  test('RESEND_API_KEY absent resolves transport to log and returns sent without touching the SDK', async () => {
    const { sendEmail } = await loadEmail()
    const result = await sendEmail({
      to: 'recipient@example.com',
      subject: SHARE_LINK_SUBJECT,
      text: shareLinkText('https://app.example.com/s/tok_abc123', 'Friday 16 May at 14:20 UTC'),
    })
    expect(result).toEqual({ outcome: 'sent', transport: 'log' })
    expect(ResendMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })

  test('writes exactly one .local/mail/<id>.json per message, and a share URL can be read back out of it', async () => {
    const { sendEmail } = await loadEmail()
    const before = await mailFiles()
    const message: EmailMessage = {
      to: 'recipient@example.com',
      subject: SHARE_LINK_SUBJECT,
      text: shareLinkText('https://app.example.com/s/tok_abc123?x=1', 'Friday 16 May at 14:20 UTC'),
    }
    await sendEmail(message)
    const after = await mailFiles()
    const created = after.filter((file) => !before.includes(file))
    expect(created).toHaveLength(1)

    const written = JSON.parse(await readFile(path.join(MAIL_DIR, created[0]), 'utf8'))
    expect(written.to).toBe(message.to)
    expect(written.subject).toBe(message.subject)
    expect(written.text).toBe(message.text)

    const [, extractedUrl] = written.text.match(/(https:\/\/\S+)/)
    expect(extractedUrl).toBe('https://app.example.com/s/tok_abc123?x=1')
  })

  test('sendEmail passes the pinned share-link and reminder bodies through verbatim, never rewriting them', async () => {
    const { sendEmail } = await loadEmail()
    const reminder: EmailMessage = {
      to: 'recipient@example.com',
      subject: APPOINTMENT_REMINDER_SUBJECT,
      text: appointmentReminderText('https://app.example.com'),
    }
    await sendEmail(reminder)
    const files = await mailFiles()
    const written = JSON.parse(await readFile(path.join(MAIL_DIR, files[files.length - 1]), 'utf8'))
    expect(written.subject).toBe('Appointment reminder')
    expect(written.text).toBe(
      "You have an appointment in 24 hours.\n\nhttps://app.example.com/appointments\n\nSign in to see the details, or to change or cancel it.",
    )
  })

  test('a log transport filesystem failure resolves with a fixed safe outcome', async () => {
    const blockedCwd = await mkdtemp(path.join(tmpdir(), 'email-log-write-failure-'))
    await writeFile(path.join(blockedCwd, '.local'), 'not a directory')
    const originalCwd = process.cwd()

    try {
      process.chdir(blockedCwd)
      const { sendEmail } = await loadEmail()
      await expect(sendEmail({
        to: 'recipient@example.com',
        subject: APPOINTMENT_REMINDER_SUBJECT,
        text: appointmentReminderText('https://app.example.com'),
      })).resolves.toEqual({ outcome: 'failed', transport: 'log', error: 'email delivery failed' })
    } finally {
      process.chdir(originalCwd)
      await rm(blockedCwd, { recursive: true, force: true })
    }
  })

  test('a never-settling log transport write is bounded by the configured timeout', async () => {
    vi.useFakeTimers()
    writeFileMock.mockImplementationOnce(() => new Promise<void>(() => {}))

    try {
      const { sendEmail } = await loadEmail({ EMAIL_SEND_TIMEOUT_MS: '25' })
      const outcome = sendEmail({
        to: 'recipient@example.com',
        subject: APPOINTMENT_REMINDER_SUBJECT,
        text: appointmentReminderText('https://app.example.com'),
      })
      await vi.advanceTimersByTimeAsync(25)

      const settled = await Promise.race([outcome, Promise.resolve('still pending' as const)])
      expect(settled).toEqual({ outcome: 'failed', transport: 'log', error: 'email delivery failed' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('application log line — acceptance + adversarial: id and domain only (UX_SPEC §4.15, SEC-6)', () => {
  test('the log line for a send carries the message id and the recipient domain', async () => {
    const { sendEmail } = await loadEmail()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await sendEmail({
      to: 'recipient@example.com',
      subject: APPOINTMENT_REMINDER_SUBJECT,
      text: appointmentReminderText('https://app.example.com'),
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(typeof logged.id).toBe('string')
    expect(logged.id.length).toBeGreaterThan(0)
    expect(logged.domain).toBe('example.com')
  })

  test('adversarial: a recipient address, including its local part, never reaches the application log line', async () => {
    const { sendEmail } = await loadEmail()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await sendEmail({
      to: 'jane.doe@example.com',
      subject: APPOINTMENT_REMINDER_SUBJECT,
      text: appointmentReminderText('https://app.example.com'),
    })
    const loggedLines = logSpy.mock.calls.map((call) => String(call[0]))
    for (const line of loggedLines) {
      expect(line).not.toContain('jane.doe@example.com')
      expect(line).not.toContain('jane.doe')
    }
  })

  test('adversarial: a share token, and a URL carrying it, never reach the application log line', async () => {
    const { sendEmail } = await loadEmail()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const token = 'tok_super_secret_share_credential_9f8e7d'
    await sendEmail({
      to: 'recipient@example.com',
      subject: SHARE_LINK_SUBJECT,
      text: shareLinkText(`https://app.example.com/s/${token}`, 'Friday 16 May at 14:20 UTC'),
    })
    const loggedLines = logSpy.mock.calls.map((call) => String(call[0]))
    for (const line of loggedLines) {
      expect(line).not.toContain(token)
      expect(line).not.toContain(`https://app.example.com/s/${token}`)
    }
  })
})

describe('resend transport — acceptance: one message, one SDK call', () => {
  test('EMAIL_TRANSPORT=resend with a key present produces exactly one SDK call and returns sent/resend', async () => {
    sendMock.mockResolvedValue({ data: { id: 'resend-msg-1' }, error: null })
    const { sendEmail } = await loadEmail({
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'clinic@example.com',
      EMAIL_TRANSPORT: 'resend',
    })
    const message: EmailMessage = {
      to: 'recipient@example.com',
      subject: APPOINTMENT_REMINDER_SUBJECT,
      text: appointmentReminderText('https://app.example.com'),
    }
    const result = await sendEmail(message)
    expect(result).toEqual({ outcome: 'sent', transport: 'resend' })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith({
      from: 'clinic@example.com',
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
  })

  test('RESEND_FROM is read from config and used as the sender for every message, never inlined', async () => {
    sendMock.mockResolvedValue({ data: { id: 'x' }, error: null })
    const messageArgs = () => ({
      to: 'recipient@example.com',
      subject: APPOINTMENT_REMINDER_SUBJECT,
      text: appointmentReminderText('https://app.example.com'),
    })

    const { sendEmail: sendA } = await loadEmail({
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'a-sender@example.com',
    })
    await sendA(messageArgs())
    expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'a-sender@example.com' }))

    sendMock.mockClear()
    const { sendEmail: sendB } = await loadEmail({
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'b-sender@example.com',
    })
    await sendB(messageArgs())
    expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'b-sender@example.com' }))
  })

  test('an SDK-reported error (not a throw) returns outcome failed with a fixed safe error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'invalid from address' } })
    const { sendEmail } = await loadEmail({ RESEND_API_KEY: 're_test_key', RESEND_FROM: 'clinic@example.com' })
    const result = await sendEmail({
      to: 'recipient@example.com',
      subject: APPOINTMENT_REMINDER_SUBJECT,
      text: appointmentReminderText('https://app.example.com'),
    })
    expect(result.outcome).toBe('failed')
    expect(result.transport).toBe('resend')
    expect(result.error).toBe('email delivery failed')
  })
})

describe('mandatory adversarial — sendEmail never throws', () => {
  test('an SDK client that rejects surfaces as outcome failed and the promise still resolves', async () => {
    sendMock.mockRejectedValue(new Error('network timeout'))
    const { sendEmail } = await loadEmail({ RESEND_API_KEY: 're_test_key', RESEND_FROM: 'clinic@example.com' })
    await expect(
      sendEmail({
        to: 'recipient@example.com',
        subject: APPOINTMENT_REMINDER_SUBJECT,
        text: appointmentReminderText('https://app.example.com'),
      }),
    ).resolves.toEqual({ outcome: 'failed', transport: 'resend', error: expect.any(String) })
  })

  test('an SDK client that throws synchronously surfaces as outcome failed and the promise still resolves', async () => {
    sendMock.mockImplementation(() => {
      throw new Error('client misconfigured')
    })
    const { sendEmail } = await loadEmail({ RESEND_API_KEY: 're_test_key', RESEND_FROM: 'clinic@example.com' })
    await expect(
      sendEmail({
        to: 'recipient@example.com',
        subject: APPOINTMENT_REMINDER_SUBJECT,
        text: appointmentReminderText('https://app.example.com'),
      }),
    ).resolves.toEqual({ outcome: 'failed', transport: 'resend', error: expect.any(String) })
  })
})

describe('mandatory adversarial — message validation, rejected not truncated', () => {
  test('an empty or missing to is rejected as failed without invoking any transport', async () => {
    const { sendEmail } = await loadEmail()
    const before = await mailFiles()

    const empty = await sendEmail({ to: '', subject: APPOINTMENT_REMINDER_SUBJECT, text: 'x' })
    expect(empty.outcome).toBe('failed')

    // Simulates a caller crossing an untyped boundary (e.g. a parsed request
    // body) where `to` is simply absent, not just empty.
    const missing = await sendEmail(
      JSON.parse('{"subject":"Appointment reminder","text":"x"}') as EmailMessage,
    )
    expect(missing.outcome).toBe('failed')

    expect(await mailFiles()).toEqual(before)
    expect(sendMock).not.toHaveBeenCalled()
  })

  test('a to that is not a syntactically valid address is rejected as failed', async () => {
    const { sendEmail } = await loadEmail()
    const result = await sendEmail({ to: 'not-an-email', subject: APPOINTMENT_REMINDER_SUBJECT, text: 'x' })
    expect(result.outcome).toBe('failed')
  })

  test('an oversized subject is rejected as failed rather than silently truncated', async () => {
    const { sendEmail } = await loadEmail()
    const before = await mailFiles()
    const result = await sendEmail({
      to: 'recipient@example.com',
      subject: 'a'.repeat(999),
      text: appointmentReminderText('https://app.example.com'),
    })
    expect(result.outcome).toBe('failed')
    expect(await mailFiles()).toEqual(before)
  })

  test('oversized text is rejected as failed rather than silently truncated', async () => {
    const { sendEmail } = await loadEmail()
    const before = await mailFiles()
    const result = await sendEmail({
      to: 'recipient@example.com',
      subject: APPOINTMENT_REMINDER_SUBJECT,
      text: 'a'.repeat(20_001),
    })
    expect(result.outcome).toBe('failed')
    expect(await mailFiles()).toEqual(before)
  })
})

describe('mandatory adversarial — error never carries PHI or a credential', () => {
  test('a provider error echoing a seven-character patient reference is replaced by a fixed safe error', async () => {
    sendMock.mockRejectedValue(new Error('smtp rejected PT-1234'))
    const { sendEmail } = await loadEmail({ RESEND_API_KEY: 're_test_key', RESEND_FROM: 'clinic@example.com' })
    const result = await sendEmail({ to: 'recipient@example.com', subject: 'x', text: 'PT-1234' })

    expect(result).toEqual({ outcome: 'failed', transport: 'resend', error: 'email delivery failed' })
    expect(result.error).not.toContain('PT-1234')
  })

  test('a mapped error never contains a patient name, date of birth, patient reference, address, or share token', async () => {
    sendMock.mockRejectedValue(new Error('smtp rejected: mailbox unavailable'))
    const { sendEmail } = await loadEmail({ RESEND_API_KEY: 're_test_key', RESEND_FROM: 'clinic@example.com' })
    // Deliberately not a pinned body — proves the adapter's error mapping
    // never echoes the caller's own message content back out.
    const phiText =
      'Reminder for Jane Q. Doe (PT-1234), DOB 1990-01-01: https://app.example.com/s/tok_secret999'
    const result = await sendEmail({ to: 'recipient@example.com', subject: 'x', text: phiText })
    expect(result.outcome).toBe('failed')
    expect(result.error).not.toContain('Jane')
    expect(result.error).not.toContain('Doe')
    expect(result.error).not.toContain('PT-1234')
    expect(result.error).not.toContain('1990-01-01')
    expect(result.error).not.toContain('recipient@example.com')
    expect(result.error).not.toContain('tok_secret999')
    expect(result.error).toBe('email delivery failed')
  })
})

describe('repo-wide guards', () => {
  test('no module other than lib/notify/email.ts imports the resend SDK', () => {
    const hits = trackedFiles().filter((file) => {
      if (!file || (!file.endsWith('.ts') && !file.endsWith('.tsx'))) return false
      if (file === 'lib/notify/email.ts') return false
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      return /from\s+['"]resend['"]/.test(content) || /require\(\s*['"]resend['"]\s*\)/.test(content)
    })
    expect(hits).toEqual([])
  })

  test('lib/notify/email.ts contains no direct environment-variable reference', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'lib', 'notify', 'email.ts'), 'utf8')
    // Built at runtime, not spelled out literally, so this assertion itself
    // does not trip tests/config/config.test.ts's whole-tree scan for the
    // same substring.
    const envAccess = ['process', 'env'].join('.')
    expect(content).not.toContain(envAccess)
  })

  test('this test file opens no listening socket and binds no fixed port', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'tests', 'notify', 'email.test.ts'), 'utf8')
    const listenCall = ['', 'listen('].join('.')
    expect(content).not.toContain(listenCall)
  })
})

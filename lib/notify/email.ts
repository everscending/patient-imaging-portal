// lib/notify/email.ts — the ONLY caller of the Resend SDK (ARCHITECTURE.md §2,
// REQUIREMENTS.md GAP-3). Transport is config.emailTransport (lib/config.ts);
// this module never reads the environment directly (§8).
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Resend } from 'resend'
import { config } from '../config'
import type { anonClient } from '../db/client'

export type EmailMessage = { to: string; subject: string; text: string }
export type SendOutcome = {
  outcome: 'sent' | 'failed'
  transport: 'resend' | 'log'
  error?: string // never PHI
}

type EmailOutboxClient = Pick<ReturnType<typeof anonClient>, 'from'>

/** Persists a message for the reminder job using the caller's authenticated client. */
export async function enqueueEmail(client: EmailOutboxClient, message: EmailMessage): Promise<boolean> {
  try {
    const { error } = await client.from('email_outbox').insert({
      recipient: message.to,
      subject: message.subject,
      body: message.text,
    })
    return !error
  } catch {
    return false
  }
}

/** Transport is config.emailTransport; 'log' records the message instead of
 *  sending it, and still returns outcome 'sent'. Bodies carry no PHI (SEC-9). */
export async function sendEmail(message: EmailMessage): Promise<SendOutcome> {
  const validationError = validate(message)
  if (validationError) {
    return { outcome: 'failed', transport: config.emailTransport, error: validationError }
  }
  if (config.emailTransport === 'log') return sendViaLog(message)
  return sendViaResend(message)
}

// RFC 5322's unfolded header line length. text has no protocol limit of its
// own; both pinned bodies (UX_SPEC §4.15) are under 400 characters, so a
// generous cap catches a caller bug without ever truncating real copy.
const MAX_SUBJECT_LENGTH = 998
const MAX_TEXT_LENGTH = 20_000
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Never echoes the offending value — the value may itself be the PHI-shaped
// or credential-shaped thing under test (SEC-6, SEC-9).
function validate(message: EmailMessage): string | null {
  if (!message.to) return 'recipient address is required'
  if (!ADDRESS_PATTERN.test(message.to)) return 'recipient address is not a valid email address'
  if (message.subject.length > MAX_SUBJECT_LENGTH) return 'subject exceeds the adapter limit'
  if (message.text.length > MAX_TEXT_LENGTH) return 'text exceeds the adapter limit'
  return null
}

function domainOf(address: string): string {
  return address.slice(address.indexOf('@') + 1)
}

// The whole log-line contract (UX_SPEC §4.15, SEC-6): id and domain, nothing
// that could reach a recipient address or the token a share link carries.
function logSend(id: string, to: string, transport: SendOutcome['transport']): void {
  console.log(JSON.stringify({ event: 'email.sent', id, domain: domainOf(to), transport }))
}

// GAP-3: a keyless environment still exercises the whole flow. The whole
// message — including the link — lands on disk, which is gitignored and not
// a log line, so a keyless end-to-end test can read a share link back out.
async function sendViaLog(message: EmailMessage): Promise<SendOutcome> {
  const id = randomUUID()
  const dir = path.join('.local', 'mail')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ to: message.to, subject: message.subject, text: message.text }, null, 2),
  )
  logSend(id, message.to, 'log')
  return { outcome: 'sent', transport: 'log' }
}

const MAX_ERROR_LENGTH = 500

class EmailTimeoutError extends Error {
  constructor() {
    super('email delivery timed out')
    this.name = 'EmailTimeoutError'
  }
}

function withinTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EmailTimeoutError()), config.emailSendTimeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// A provider code or message only — never the message this adapter was
// asked to send, so a caller's own text can never surface through here.
function shortError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, MAX_ERROR_LENGTH)
  if (typeof error === 'string') return error.slice(0, MAX_ERROR_LENGTH)
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message.slice(0, MAX_ERROR_LENGTH)
  }
  return 'resend send failed'
}

function safeTransportError(error: unknown, message: EmailMessage): string {
  const mapped = shortError(error)
  const sensitiveValues = [message.to, message.subject, ...message.text.split(/\s+/)]
    .filter((value) => value.length >= 8)
  return sensitiveValues.some((value) => mapped.includes(value)) ? 'email delivery failed' : mapped
}

// Wrapped in try/catch rather than relying on async auto-wrapping: a
// synchronous throw from the SDK must map to outcome 'failed' too, not just
// a rejected client.emails.send() promise (P7, CQ-3 — sendEmail never rejects).
async function sendViaResend(message: EmailMessage): Promise<SendOutcome> {
  const apiKey = config.resendApiKey
  const from = config.resendFrom
  if (!apiKey) return { outcome: 'failed', transport: 'resend', error: 'no resend api key configured' }
  if (!from) return { outcome: 'failed', transport: 'resend', error: 'no resend from address configured' }

  try {
    const client = new Resend(apiKey)
    const result = await withinTimeout(
      client.emails.send({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    )
    if (result.error) {
      return { outcome: 'failed', transport: 'resend', error: safeTransportError(result.error, message) }
    }
    logSend(result.data?.id ?? randomUUID(), message.to, 'resend')
    return { outcome: 'sent', transport: 'resend' }
  } catch (error) {
    if (error instanceof EmailTimeoutError) {
      return { outcome: 'failed', transport: 'resend', error: error.message }
    }
    return { outcome: 'failed', transport: 'resend', error: safeTransportError(error, message) }
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { AuditAction } from '../audit/events'
import { config } from '../config'
import { errorResponse } from './envelope'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; response: Response }

// Fixed and generic by construction (never interpolates a submitted value, a
// field path, or a stack trace) so every validation_failed response satisfies
// EC-12's no-PHI-in-errors rule without per-call review.
const VALIDATION_FAILED_MESSAGE = 'The request could not be validated.'

function validationFailed<T>(): ParseResult<T> {
  return { ok: false, response: errorResponse(422, 'validation_failed', VALIDATION_FAILED_MESSAGE) }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // A broken request stream is still malformed input. Its transport error is
    // never allowed to replace the shared, no-PHI validation envelope.
  }
}

/**
 * Rejects a malformed, oversized or out-of-range body with 422 validation_failed.
 * "Oversized" is larger than `config.maxRequestBodyBytes` (ADR-0012).
 */
export async function parseBody<T>(schema: ZodType<T>, request: Request): Promise<ParseResult<T>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return validationFailed()
  }

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > config.maxRequestBodyBytes) {
    return validationFailed()
  }

  if (request.body === null) {
    return validationFailed()
  }

  // Enforced while streaming, not after `.text()`, so an oversized payload is
  // never fully materialised (ADR-0012) — the reader is cancelled the instant
  // the running total crosses the limit.
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > config.maxRequestBodyBytes) {
        await cancelReader(reader)
        return validationFailed()
      }
      chunks.push(value)
    }
  } catch {
    await cancelReader(reader)
    return validationFailed()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  let json: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    json = text.length === 0 ? undefined : JSON.parse(text)
  } catch {
    return validationFailed()
  }

  try {
    const result = schema.safeParse(json)
    if (!result.success) return validationFailed()
    return { ok: true, value: result.data }
  } catch {
    return validationFailed()
  }
}

/** Validates the request's query string. Unknown parameters are rejected. */
export function parseQuery<T>(schema: ZodType<T>, url: URL): ParseResult<T> {
  const query: Record<string, string | string[]> = {}
  try {
    for (const [key, value] of url.searchParams) {
      const previous = query[key]
      query[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value]
    }
  } catch {
    return validationFailed()
  }

  const result = schema.safeParse(query)
  if (!result.success) return validationFailed()
  return { ok: true, value: result.data }
}

/** Validates a route's path parameters — a non-uuid id is 422, never a 500. */
export function parseParams<T>(
  schema: ZodType<T>,
  params: Record<string, string | string[]>,
): ParseResult<T> {
  const result = schema.safeParse(params)
  if (!result.success) return validationFailed()
  return { ok: true, value: result.data }
}

// Shared primitive for path/body/query fields that name a database id
// (ADR-0012): rejects a non-uuid before it can reach Postgres as a malformed
// query parameter.
export const uuidSchema: ZodType<string> = z.string().uuid()

const rfc3339Schema = z.string().datetime({ offset: true })
const wallTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)

/** Booking request and route schemas (EC-12). */
export const appointmentCreateSchema = z.object({
  slotId: uuidSchema,
  serviceId: uuidSchema,
  idempotencyKey: uuidSchema,
}).strict()
export const appointmentParamsSchema = z.object({ id: uuidSchema }).strict()
export const appointmentPatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reschedule'), slotId: uuidSchema }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('transition'), status: z.enum(['confirmed', 'completed', 'no_show']) }).strict(),
])
export const slotsQuerySchema = z.object({
  providerId: uuidSchema,
  serviceId: uuidSchema,
  from: rfc3339Schema,
  to: rfc3339Schema,
}).strict().refine(({ from, to }) => new Date(to) > new Date(from))
export const providersQuerySchema = z.object({ serviceId: uuidSchema }).strict()

/** Provider availability request and route schemas (EC-12). */
export const availabilityParamsSchema = z.object({ providerId: uuidSchema }).strict()
export const availabilityPatchSchema = z.object({
  slotMinutes: z.number().int().min(5).max(240),
  workingHours: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    startsLocal: wallTimeSchema,
    endsLocal: wallTimeSchema,
  }).strict()).max(64),
  blocks: z.array(z.object({
    startsAt: rfc3339Schema,
    endsAt: rfc3339Schema,
    reason: z.string().trim().max(500).nullable().optional(),
  }).strict()).max(256),
}).strict()

/** Image and report access path schemas (EC-12). */
export const studyParamsSchema = z.object({ studyId: uuidSchema }).strict()
export const studyClipParamsSchema = z.object({ studyId: uuidSchema, clipId: uuidSchema }).strict()
export const reportParamsSchema = z.object({ reportId: uuidSchema }).strict()

/** Sharing request and route schemas (EC-12). */
export const createShareSchema = z.object({
  resourceKind: z.enum(['image', 'report']),
  resourceId: uuidSchema,
  recipientEmail: z.string().trim().email().max(320),
}).strict()
export const shareParamsSchema = z.object({ id: uuidSchema }).strict()
export const shareTokenParamsSchema = z.object({ token: z.string().min(1).max(512) }).strict()

/** Auth and profile request schemas (EC-12). */
export const registerRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
}).strict()
export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
}).strict()
export const profilePatchSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.union([z.string().trim().min(1).max(64), z.null()]),
}).strict()
export const deletionRequestSchema = z.object({}).strict()

/** Remaining API request schemas; route handlers never declare schemas. */
export const servicesQuerySchema = z.object({}).strict()
export const identityVerifyRequestSchema = z.object({
  patientRef: z.string().trim().min(1).max(64),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict()

const auditActions = [
  'identity.verify',
  'identity.lockout',
  'identity.link',
  'study.view',
  'image.view',
  'clip.view',
  'report.view',
  'share.create',
  'share.use',
  'share.revoke',
  'share.view',
  'booking.create',
  'booking.reschedule',
  'booking.cancel',
  'appointment.view',
  'appointment.transition',
  'schedule.view',
  'availability.update',
  'availability.collision',
  'reminder.dispatch',
  'audit.view',
  'profile.deletion_request',
] as const satisfies readonly AuditAction[]

const auditLogQueryFields = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    actorRef: z.string().uuid().optional(),
    action: z.enum(auditActions).optional(),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict()

/** Shared query schema for the admin audit read; unknown keys are rejected. */
export const auditLogQuerySchema = auditLogQueryFields.superRefine((query, context) => {
  if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
    context.addIssue({ code: 'custom', message: 'from must not be after to' })
  }
})

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>

export type AuditLogCursor = {
  id: string
  occurredAt: string
  filters: Omit<AuditLogQuery, 'cursor'>
}

const auditLogCursorSchema = z
  .object({
    id: z.string().regex(/^\d+$/),
    occurredAt: z.string().datetime({ offset: true }),
    filters: auditLogQueryFields.omit({ cursor: true }),
  })
  .strict()

const AUDIT_LOG_CURSOR_PURPOSE = 'audit-log-cursor-v1'

function authenticateAuditLogCursor(payload: string): Buffer {
  return createHmac('sha256', config.sourceRefSalt)
    .update(AUDIT_LOG_CURSOR_PURPOSE)
    .update('\0')
    .update(payload)
    .digest()
}

/** Decodes only cursors issued for the same audit-log filter tuple. */
export function parseAuditLogCursor(cursor: string | undefined, query: AuditLogQuery): AuditLogCursor | null {
  if (!cursor) return { id: '', occurredAt: '', filters: withoutAuditLogCursor(query) }
  try {
    const [payload, signature, extra] = cursor.split('.')
    if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null

    const decodedPayload = Buffer.from(payload, 'base64url')
    if (decodedPayload.toString('base64url') !== payload) return null
    const submittedSignature = Buffer.from(signature, 'base64url')
    const expectedSignature = authenticateAuditLogCursor(payload)
    if (submittedSignature.length !== expectedSignature.length || !timingSafeEqual(submittedSignature, expectedSignature)) {
      return null
    }

    const decoded = decodedPayload.toString('utf8')
    const parsed = auditLogCursorSchema.safeParse(JSON.parse(decoded))
    if (!parsed.success || !sameAuditLogFilters(parsed.data.filters, withoutAuditLogCursor(query))) return null
    return parsed.data
  } catch {
    return null
  }
}

export function createAuditLogCursor(cursor: AuditLogCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  return `${payload}.${authenticateAuditLogCursor(payload).toString('base64url')}`
}

function withoutAuditLogCursor(query: AuditLogQuery): Omit<AuditLogQuery, 'cursor'> {
  const { cursor: _cursor, ...filters } = query
  void _cursor
  return filters
}

function sameAuditLogFilters(left: Omit<AuditLogQuery, 'cursor'>, right: Omit<AuditLogQuery, 'cursor'>): boolean {
  return left.from === right.from && left.to === right.to && left.actorRef === right.actorRef && left.action === right.action
}

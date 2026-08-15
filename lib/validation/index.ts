import { z } from 'zod'
import type { ZodType } from 'zod'
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

/**
 * Rejects a malformed, oversized or out-of-range body with 422 validation_failed.
 * "Oversized" is larger than `config.maxRequestBodyBytes` (65536, ADR-0012).
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
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > config.maxRequestBodyBytes) {
      await reader.cancel()
      return validationFailed()
    }
    chunks.push(value)
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

  const result = schema.safeParse(json)
  if (!result.success) return validationFailed()
  return { ok: true, value: result.data }
}

/** Validates the request's query string. Unknown parameters are rejected. */
export function parseQuery<T>(schema: ZodType<T>, request: Request): ParseResult<T> {
  let query: Record<string, string>
  try {
    query = Object.fromEntries(new URL(request.url).searchParams)
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
  params: Record<string, string | string[] | undefined>,
): ParseResult<T> {
  const result = schema.safeParse(params)
  if (!result.success) return validationFailed()
  return { ok: true, value: result.data }
}

// Shared primitive for path/body/query fields that name a database id
// (ADR-0012): rejects a non-uuid before it can reach Postgres as a malformed
// query parameter.
export const uuidSchema: ZodType<string> = z.string().uuid()

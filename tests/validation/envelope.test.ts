import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

// lib/config.ts is the only module allowed to read environment variables
// (tests/config/config.test.ts enforces this repo-wide); stub it here rather
// than setting variables, since this ticket only needs maxRequestBodyBytes.
vi.mock('../../lib/config', () => ({ config: { maxRequestBodyBytes: 65536 } }))

import { config } from '../../lib/config'
import { errorResponse, noContentResponse } from '../../lib/validation/envelope'
import { parseBody, parseParams, parseQuery, uuidSchema } from '../../lib/validation'

// Mirrors a typical route body schema: two required fields, unknown keys
// rejected, a bounded numeric range.
const patientBodySchema = z
  .object({
    name: z.string().min(1),
    age: z.number().int().min(0).max(120),
  })
  .strict()

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive(),
  })
  .strict()

const studyParamsSchema = z
  .object({
    studyId: uuidSchema,
  })
  .strict()

function jsonRequest(body: string, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/patients', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  })
}

function queryUrl(search: string): URL {
  return new URL(`http://localhost/api/slots${search}`)
}

async function readEnvelope(response: Response): Promise<{ error: string; message: string }> {
  return (await response.json()) as { error: string; message: string }
}

function responseConstructionOffenders(): string[] {
  const roots = ['lib', 'app']
  const offenders: string[] = []

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (full === path.join('lib', 'validation', 'envelope.ts')) continue
      const source = readFileSync(full, 'utf-8')
      if (/new Response\(/.test(source)) offenders.push(full)
    }
  }

  for (const root of roots) walk(root)
  return offenders
}

describe('errorResponse', () => {
  test('errorResponse_returnsExactShapeAndStatus', async () => {
    const response = errorResponse(422, 'validation_failed', 'The request could not be validated.')
    expect(response.status).toBe(422)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(['error', 'message'])
    expect(body).toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
  })

  test('noContentResponse_returnsGenuinelyEmpty204', async () => {
    const response = noContentResponse()
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    await expect(response.text()).resolves.toBe('')
  })

  test('responseConstructionGuard_rejectsDirectResponseInRouteModules', () => {
    const plantedRouteDir = path.join('app', 'api', '__response-construction-guard-test__')
    const plantedRoute = path.join(plantedRouteDir, 'route.ts')
    mkdirSync(plantedRouteDir, { recursive: true })
    writeFileSync(plantedRoute, 'export function GET() { return new Response(null) }')

    try {
      expect(responseConstructionOffenders()).toContain(plantedRoute)
    } finally {
      rmSync(plantedRouteDir, { recursive: true, force: true })
    }
  })

  test('responseConstructionGuard_allowsOnlyEnvelopeModuleToConstructResponses', () => {
    expect(responseConstructionOffenders()).toEqual([])
  })
})

describe('parseBody', () => {
  test('parseBody_rejectsTruncatedJson', async () => {
    const result = await parseBody(patientBodySchema, jsonRequest('{'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(422)
    expect((await readEnvelope(result.response)).error).toBe('validation_failed')
  })

  test('parseBody_rejectsNonJsonContentType', async () => {
    const result = await parseBody(patientBodySchema, jsonRequest('{"name":"Alex","age":30}', 'text/plain'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(422)
    expect((await readEnvelope(result.response)).error).toBe('validation_failed')
  })

  test('parseBody_rejectsEmptyBodyWhenFieldsRequired', async () => {
    const result = await parseBody(patientBodySchema, jsonRequest(''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect((await readEnvelope(result.response)).error).toBe('validation_failed')
  })

  test('parseBody_rejectsUnknownKeyAlongsideValidFields', async () => {
    const result = await parseBody(
      patientBodySchema,
      jsonRequest(JSON.stringify({ name: 'Alex', age: 30, role: 'admin' })),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect((await readEnvelope(result.response)).error).toBe('validation_failed')
  })

  test('parseBody_rejectsOutOfRangeNumber', async () => {
    const result = await parseBody(patientBodySchema, jsonRequest(JSON.stringify({ name: 'Alex', age: 999 })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect((await readEnvelope(result.response)).error).toBe('validation_failed')
  })

  test('parseBody_rejectsBodyOneByteOverLimit', async () => {
    const oversized = 'a'.repeat(config.maxRequestBodyBytes + 1)
    const request = new Request('http://localhost/api/patients', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(oversized.length) },
      body: oversized,
    })
    const result = await parseBody(patientBodySchema, request)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(422)
    expect((await readEnvelope(result.response)).error).toBe('validation_failed')
  })

  test('parseBody_acceptsValidBody', async () => {
    const result = await parseBody(patientBodySchema, jsonRequest(JSON.stringify({ name: 'Alex', age: 30 })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ name: 'Alex', age: 30 })
  })

  test('parseBody_neverThrowsForMalformedInput', async () => {
    await expect(parseBody(patientBodySchema, jsonRequest('not json at all'))).resolves.toMatchObject({ ok: false })
    await expect(parseBody(patientBodySchema, jsonRequest(''))).resolves.toMatchObject({ ok: false })
  })
})

describe('parseQuery', () => {
  test('parseQuery_rejectsNonIntegerLimit', () => {
    const result = parseQuery(listQuerySchema, queryUrl('?limit=abc'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(422)
  })

  test('parseQuery_rejectsUndeclaredParameterAlongsideValidOnes', async () => {
    const result = parseQuery(listQuerySchema, queryUrl('?limit=10&unexpected=1'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect((await readEnvelope(result.response)).error).toBe('validation_failed')
  })

  test('parseQuery_acceptsValidQuery', () => {
    const result = parseQuery(listQuerySchema, queryUrl('?limit=10'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ limit: 10 })
  })

  test('parseQuery_neverThrowsForAnyInput', () => {
    expect(() => parseQuery(listQuerySchema, queryUrl('?limit=%zz'))).not.toThrow()
  })
})

describe('parseParams', () => {
  test('parseParams_rejectsNonUuidId', () => {
    const result = parseParams(studyParamsSchema, { studyId: 'not-a-uuid' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(422)
  })

  test('parseParams_acceptsValidUuid', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const result = parseParams(studyParamsSchema, { studyId: id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ studyId: id })
  })

  test('parseParams_neverThrowsForArrayShapedParam', () => {
    expect(() => parseParams(studyParamsSchema, { studyId: ['a', 'b'] })).not.toThrow()
    const result = parseParams(studyParamsSchema, { studyId: ['a', 'b'] })
    expect(result.ok).toBe(false)
  })
})

describe('message safety', () => {
  test('parseBody_errorMessageNeverContainsTheRejectedValue', async () => {
    const secret = 'sensitive-patient-value-42'
    const result = await parseBody(patientBodySchema, jsonRequest(JSON.stringify({ name: secret, age: 999 })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    const envelope = await readEnvelope(result.response)
    expect(envelope.message).not.toContain(secret)
    expect(envelope.message).not.toContain('999')
    expect(envelope.message.toLowerCase()).not.toContain('stack')
  })

  test('parseParams_errorMessageNeverContainsTheRejectedValue', async () => {
    const rejected = 'not-a-uuid-but-looks-legit-9001'
    const result = parseParams(studyParamsSchema, { studyId: rejected })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const envelope = await readEnvelope(result.response)
    expect(envelope.message).not.toContain(rejected)
  })
})

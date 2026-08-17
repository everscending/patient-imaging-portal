import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'

vi.mock('../../lib/config', () => ({ config: { maxRequestBodyBytes: 65_536 } }))

import { config } from '../../lib/config'
import {
  appointmentCreateSchema,
  appointmentPatchSchema,
  availabilityPatchSchema,
  createShareSchema,
  loginRequestSchema,
  parseBody,
  parseParams,
  parseQuery,
  providersQuerySchema,
  registerRequestSchema,
  slotsQuerySchema,
  studyClipParamsSchema,
  studyParamsSchema,
} from '../../lib/validation'

const uuid = '11111111-1111-4111-8111-111111111111'
const laterUuid = '22222222-2222-4222-8222-222222222222'

function body(value: string): Request {
  return new Request('http://localhost/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: value })
}

async function expectValidationFailure(result: Awaited<ReturnType<typeof parseBody>> | ReturnType<typeof parseParams> | ReturnType<typeof parseQuery>): Promise<void> {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.response.status).toBe(422)
  await expect(result.response.json()).resolves.toEqual({ error: 'validation_failed', message: 'The request could not be validated.' })
}

async function expectOversized(schema: Parameters<typeof parseBody>[0]): Promise<void> {
  await expectValidationFailure(await parseBody(schema, body('x'.repeat(config.maxRequestBodyBytes + 1))))
}

describe('booking surface', () => {
  test('booking_rejectsMalformedOversizedAndOutOfRangeRequests', async () => {
    await expectValidationFailure(await parseBody(appointmentCreateSchema, body('{')))
    await expectOversized(appointmentCreateSchema)
    await expectValidationFailure(await parseBody(appointmentPatchSchema, body(JSON.stringify({ action: 'transition', status: 'requested' }))))
  })

  test('booking_rejectsNonJsonScalarExtraFieldsAndInvalidActions', async () => {
    await expectValidationFailure(await parseBody(appointmentCreateSchema, body('not json at all')))
    await expectValidationFailure(await parseBody(appointmentCreateSchema, body('[]')))
    await expectValidationFailure(await parseBody(appointmentCreateSchema, body(JSON.stringify({ slotId: uuid, serviceId: laterUuid, idempotencyKey: uuid, role: 'admin' }))))
    await expectValidationFailure(await parseBody(appointmentPatchSchema, body(JSON.stringify({ action: 'delete' }))))
  })

  test('booking_rejectsInvalidQueriesAndPathParameters', async () => {
    await expectValidationFailure(parseQuery(slotsQuerySchema, new URL(`http://localhost/api/slots?providerId=${uuid}&serviceId=${laterUuid}&from=2026-08-14%2009:00&to=2026-08-15T09:00:00Z`)))
    await expectValidationFailure(parseQuery(providersQuerySchema, new URL(`http://localhost/api/providers?serviceId=${uuid}&unexpected=1`)))
    await expectValidationFailure(parseParams(studyParamsSchema, { studyId: '1' }))
  })
})

describe('availability surface', () => {
  test('availability_rejectsMalformedOversizedAndOutOfRangeRequests', async () => {
    await expectValidationFailure(await parseBody(availabilityPatchSchema, body('[]')))
    await expectOversized(availabilityPatchSchema)
    await expectValidationFailure(await parseBody(availabilityPatchSchema, body(JSON.stringify({
      slotMinutes: 0,
      workingHours: [{ weekday: 7, startsLocal: '25:00', endsLocal: '09:00' }],
      blocks: [],
    }))))
  })

  test('availability_rejectsExtraFieldsAndBothSlotMinuteBounds', async () => {
    const valid = { workingHours: [], blocks: [] }
    await expectValidationFailure(await parseBody(availabilityPatchSchema, body(JSON.stringify({ ...valid, slotMinutes: 10_000 }))))
    await expectValidationFailure(await parseBody(availabilityPatchSchema, body(JSON.stringify({ ...valid, slotMinutes: 30, unexpected: true }))))
  })
})

describe('image and report access surface', () => {
  test('access_rejectsMalformedAndOutOfRangePathParameters', async () => {
    await expectValidationFailure(parseParams(studyParamsSchema, { studyId: "' or 1=1--" }))
    await expectValidationFailure(parseParams(studyClipParamsSchema, { studyId: uuid, clipId: 'not-a-uuid' }))
  })
})

describe('sharing surface', () => {
  test('sharing_rejectsMalformedOversizedAndOutOfRangeRequests', async () => {
    await expectValidationFailure(await parseBody(createShareSchema, body('not json')))
    await expectOversized(createShareSchema)
    await expectValidationFailure(await parseBody(createShareSchema, body(JSON.stringify({ resourceKind: 'clip', resourceId: uuid, recipientEmail: 'not-an-email' }))))
  })

  test('sharing_rejectsExtraFieldsAndOversizedRecipientEmail', async () => {
    await expectValidationFailure(await parseBody(createShareSchema, body(JSON.stringify({ resourceKind: 'image', resourceId: uuid, recipientEmail: 'person@example.test', unexpected: true }))))
    const recipientEmail = `${'a'.repeat(310)}@example.test`
    await expectValidationFailure(await parseBody(createShareSchema, body(JSON.stringify({ resourceKind: 'image', resourceId: uuid, recipientEmail }))))
  })
})

describe('auth surface', () => {
  test('auth_rejectsMalformedOversizedAndOutOfRangeRequests', async () => {
    await expectValidationFailure(await parseBody(registerRequestSchema, body(JSON.stringify({ email: 'not-an-email' }))))
    await expectOversized(loginRequestSchema)
    await expectValidationFailure(await parseBody(loginRequestSchema, body(JSON.stringify({ email: 'person@example.test', password: '' }))))
  })

  test('auth_rejectsDeeplyNestedBodiesWithoutEchoingCredentials', async () => {
    const password = 'do-not-echo-this-password'
    const nested = JSON.stringify({ email: 'person@example.test', password, nested: { a: { b: { c: { d: true } } } } })
    const result = await parseBody(loginRequestSchema, body(nested))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(422)
      expect(await result.response.text()).not.toContain(password)
    }
  })

  test('auth_rejectsTenMegabytePasswordBeforeProviderInput', async () => {
    const password = 'x'.repeat(10 * 1024 * 1024)
    await expectValidationFailure(await parseBody(loginRequestSchema, body(JSON.stringify({ email: 'person@example.test', password }))))
  })
})

describe('shared module routing guard', () => {
  test('queryAndPathSurfacesUseSharedParsersRatherThanHandlerSchemas', () => {
    for (const route of [
      'app/api/slots/route.ts',
      'app/api/providers/route.ts',
      'app/api/studies/[studyId]/route.ts',
      'app/api/studies/[studyId]/clips/[clipId]/route.ts',
      'app/api/reports/[reportId]/route.ts',
    ]) {
      const source = readFileSync(route, 'utf8')
      expect(source).toContain('lib/validation')
      expect(source).not.toContain("from 'zod'")
    }
  })
})

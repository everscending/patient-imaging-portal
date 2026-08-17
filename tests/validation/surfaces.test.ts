import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'

const DEFAULT_TEST_BODY_LIMIT = 1024
const { testConfig, signInMock, signUpMock } = vi.hoisted(() => ({
  testConfig: { appBaseUrl: 'http://localhost:4310', maxRequestBodyBytes: 1024 },
  signInMock: vi.fn(),
  signUpMock: vi.fn(),
}))

vi.mock('../../lib/config', () => ({ config: testConfig }))
vi.mock('../../lib/db/client', () => ({
  authClient: () => ({ auth: { signInWithPassword: signInMock, signUp: signUpMock } }),
}))

import { POST as login } from '../../app/api/auth/login/route'
import { POST as register } from '../../app/api/auth/register/route'
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
  profilePatchSchema,
  providersQuerySchema,
  registerRequestSchema,
  reportParamsSchema,
  shareParamsSchema,
  shareTokenParamsSchema,
  slotsQuerySchema,
  studyClipParamsSchema,
  studyParamsSchema,
} from '../../lib/validation'

const uuid = '11111111-1111-4111-8111-111111111111'
const laterUuid = '22222222-2222-4222-8222-222222222222'
const validAppointment = { slotId: uuid, serviceId: laterUuid, idempotencyKey: uuid }
const validAvailability = {
  slotMinutes: 30,
  workingHours: [{ weekday: 1, startsLocal: '09:00', endsLocal: '17:00' }],
  blocks: [],
}
const validShare = { resourceKind: 'image', resourceId: uuid, recipientEmail: 'person@example.test' }
const bodySurfaceSchemas: Array<Parameters<typeof parseBody>[0]> = [
  appointmentCreateSchema,
  appointmentPatchSchema,
  availabilityPatchSchema,
  createShareSchema,
  registerRequestSchema,
  loginRequestSchema,
  profilePatchSchema,
]

afterEach(() => {
  testConfig.maxRequestBodyBytes = DEFAULT_TEST_BODY_LIMIT
  vi.clearAllMocks()
})

function body(value: string): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: value,
  })
}

async function expectValidationFailure(
  result: Awaited<ReturnType<typeof parseBody>> | ReturnType<typeof parseParams> | ReturnType<typeof parseQuery>,
): Promise<void> {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.response.status).toBe(422)
  await expect(result.response.json()).resolves.toEqual({
    error: 'validation_failed',
    message: 'The request could not be validated.',
  })
}

function paddedJson(value: unknown, byteLength: number): string {
  const serialized = JSON.stringify(value)
  const serializedBytes = new TextEncoder().encode(serialized).byteLength
  if (serializedBytes > byteLength) throw new Error('test payload exceeds requested byte length')
  return `${serialized}${' '.repeat(byteLength - serializedBytes)}`
}

async function expectOneByteOversized(schema: Parameters<typeof parseBody>[0], value: unknown): Promise<void> {
  const payload = paddedJson(value, config.maxRequestBodyBytes + 1)
  expect(new TextEncoder().encode(payload)).toHaveLength(config.maxRequestBodyBytes + 1)
  await expectValidationFailure(await parseBody(schema, body(payload)))
}

function streamedPasswordRequest(passwordBytes: number): {
  request: Request
  wasCancelled: () => boolean
  producedBytes: () => number
} {
  const encoder = new TextEncoder()
  const sentinel = 'credential-sentinel'
  const opening = encoder.encode(`{"email":"person@example.test","password":"${sentinel}`)
  const closing = encoder.encode('"}')
  let remainingPasswordBytes = passwordBytes - encoder.encode(sentinel).byteLength
  let phase: 'opening' | 'password' | 'closing' | 'done' = 'opening'
  let cancelled = false
  let produced = 0

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 'opening') {
        phase = 'password'
        produced += opening.byteLength
        controller.enqueue(opening)
        return
      }
      if (phase === 'password' && remainingPasswordBytes > 0) {
        const chunk = new Uint8Array(Math.min(16 * 1024, remainingPasswordBytes))
        chunk.fill('x'.charCodeAt(0))
        remainingPasswordBytes -= chunk.byteLength
        produced += chunk.byteLength
        controller.enqueue(chunk)
        return
      }
      if (phase === 'password') phase = 'closing'
      if (phase === 'closing') {
        phase = 'done'
        produced += closing.byteLength
        controller.enqueue(closing)
        controller.close()
      }
    },
    cancel() {
      cancelled = true
    },
  })

  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit

  return {
    request: new Request('http://localhost/api/auth/register', init),
    wasCancelled: () => cancelled,
    producedBytes: () => produced,
  }
}

describe('shared malformed input contract', () => {
  test('bodyThatIsNotJsonAtAllIsRejectedOnEveryBodySurface', async function bodyThatIsNotJsonAtAllIsRejectedOnEveryBodySurface() {
    for (const schema of bodySurfaceSchemas) {
      await expectValidationFailure(await parseBody(schema, body('not json at all')))
    }
  })

  test('validJsonThatIsNotAnObjectIsRejectedOnEveryBodySurface', async function validJsonThatIsNotAnObjectIsRejectedOnEveryBodySurface() {
    for (const schema of bodySurfaceSchemas) {
      await expectValidationFailure(await parseBody(schema, body('[]')))
    }
  })

  test('oneByteAboveConfiguredLimitIsRejectedOnEveryBodySurface', async function oneByteAboveConfiguredLimitIsRejectedOnEveryBodySurface() {
    await expectOneByteOversized(appointmentCreateSchema, validAppointment)
    await expectOneByteOversized(appointmentPatchSchema, { action: 'cancel' })
    await expectOneByteOversized(availabilityPatchSchema, validAvailability)
    await expectOneByteOversized(createShareSchema, validShare)
    await expectOneByteOversized(registerRequestSchema, { email: 'person@example.test', password: 'valid-password' })
    await expectOneByteOversized(loginRequestSchema, { email: 'person@example.test', password: 'valid-password' })
    await expectOneByteOversized(profilePatchSchema, { fullName: 'Patient One', phone: null })
  })

  test('bodyLimitTracksConfigWithoutAValidationLayerThreshold', async function bodyLimitTracksConfigWithoutAValidationLayerThreshold() {
    const payload = paddedJson(validAppointment, 512)
    testConfig.maxRequestBodyBytes = new TextEncoder().encode(payload).byteLength
    expect((await parseBody(appointmentCreateSchema, body(payload))).ok).toBe(true)

    testConfig.maxRequestBodyBytes -= 1
    await expectValidationFailure(await parseBody(appointmentCreateSchema, body(payload)))
  })

  test('deeplyNestedBodyDesignedToExhaustTheParserIsRejected', async function deeplyNestedBodyDesignedToExhaustTheParserIsRejected() {
    const depth = 2048
    const nested = `{"email":"person@example.test","password":"valid-password","nested":${'{"nested":'.repeat(depth)}null${'}'.repeat(depth + 1)}`
    testConfig.maxRequestBodyBytes = new TextEncoder().encode(nested).byteLength
    await expectValidationFailure(await parseBody(loginRequestSchema, body(nested)))
  })
})

describe('booking and availability ranges', () => {
  test('bookingRejectsExtraFieldsMissingIdempotencyAndDeleteAction', async function bookingRejectsExtraFieldsMissingIdempotencyAndDeleteAction() {
    await expectValidationFailure(await parseBody(appointmentCreateSchema, body(JSON.stringify({ slotId: uuid, serviceId: laterUuid }))))
    await expectValidationFailure(await parseBody(appointmentCreateSchema, body(JSON.stringify({ ...validAppointment, role: 'admin' }))))
    await expectValidationFailure(await parseBody(appointmentPatchSchema, body(JSON.stringify({ action: 'delete' }))))
  })

  test('transitionRequestedStatusIsOutsideThePinnedSet', async function transitionRequestedStatusIsOutsideThePinnedSet() {
    await expectValidationFailure(await parseBody(appointmentPatchSchema, body(JSON.stringify({ action: 'transition', status: 'requested' }))))
  })

  test('availabilityRejectsExtraFieldsAndBothSlotMinuteBounds', async function availabilityRejectsExtraFieldsAndBothSlotMinuteBounds() {
    await expectValidationFailure(await parseBody(availabilityPatchSchema, body(JSON.stringify({ ...validAvailability, slotMinutes: 0 }))))
    await expectValidationFailure(await parseBody(availabilityPatchSchema, body(JSON.stringify({ ...validAvailability, slotMinutes: 10_000 }))))
    await expectValidationFailure(await parseBody(availabilityPatchSchema, body(JSON.stringify({ ...validAvailability, unexpected: true }))))
  })

  test('availabilityRejectsWeekdaySevenInvalidWallTimeAndNaiveTimestamp', async function availabilityRejectsWeekdaySevenInvalidWallTimeAndNaiveTimestamp() {
    await expectValidationFailure(await parseBody(availabilityPatchSchema, body(JSON.stringify({
      slotMinutes: 30,
      workingHours: [{ weekday: 7, startsLocal: '25:00', endsLocal: '09:00' }],
      blocks: [{ startsAt: '2026-08-14 09:00', endsAt: '2026-08-14T10:00:00Z' }],
    }))))
  })
})

describe('sharing, access, and query ranges', () => {
  test('sharingRejectsClipKindMalformedAndOversizedRecipientEmail', async function sharingRejectsClipKindMalformedAndOversizedRecipientEmail() {
    await expectValidationFailure(await parseBody(createShareSchema, body(JSON.stringify({ ...validShare, resourceKind: 'clip' }))))
    await expectValidationFailure(await parseBody(createShareSchema, body(JSON.stringify({ ...validShare, recipientEmail: 'not-an-email' }))))
    await expectValidationFailure(await parseBody(createShareSchema, body(JSON.stringify({ ...validShare, recipientEmail: `${'a'.repeat(310)}@example.test` }))))
    await expectValidationFailure(await parseBody(createShareSchema, body(JSON.stringify({ ...validShare, unexpected: true }))))
  })

  test('sqlShapedAndShortStudyIdsAreRejectedWithoutDatabaseText', async function sqlShapedAndShortStudyIdsAreRejectedWithoutDatabaseText() {
    for (const studyId of ['1', "' or 1=1--"]) {
      const result = parseParams(studyParamsSchema, { studyId })
      await expectValidationFailure(result)
    }
    await expectValidationFailure(parseParams(studyClipParamsSchema, { studyId: uuid, clipId: 'not-a-uuid' }))
    await expectValidationFailure(parseParams(reportParamsSchema, { reportId: 'not-a-uuid' }))
    await expectValidationFailure(parseParams(shareParamsSchema, { id: 'not-a-uuid' }))
    await expectValidationFailure(parseParams(shareTokenParamsSchema, { token: '' }))
  })

  test('unknownAndRepeatedDiscoveryQueryParametersAreRejected', async function unknownAndRepeatedDiscoveryQueryParametersAreRejected() {
    await expectValidationFailure(parseQuery(providersQuerySchema, new URL(`http://localhost/api/providers?serviceId=${uuid}&unexpected=1`)))
    await expectValidationFailure(parseQuery(providersQuerySchema, new URL(`http://localhost/api/providers?serviceId=${uuid}&serviceId=${laterUuid}`)))
    await expectValidationFailure(parseQuery(slotsQuerySchema, new URL(`http://localhost/api/slots?providerId=${uuid}&serviceId=${laterUuid}&from=2026-08-14T09:00:00Z&to=2026-08-15T09:00:00Z&unexpected=1`)))
    await expectValidationFailure(parseQuery(slotsQuerySchema, new URL(`http://localhost/api/slots?providerId=${uuid}&serviceId=${laterUuid}&from=2026-08-14%2009:00&to=2026-08-15T09:00:00Z`)))
  })
})

describe('auth provider boundary', () => {
  test('registerTenMegabytePasswordIsCancelledEarlyAndNeverLoggedOrSent', async function registerTenMegabytePasswordIsCancelledEarlyAndNeverLoggedOrSent() {
    const streamed = streamedPasswordRequest(10 * 1024 * 1024)
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined))
    try {
      const response = await register(streamed.request)
      expect(response.status).toBe(422)
      expect(streamed.wasCancelled()).toBe(true)
      expect(streamed.producedBytes()).toBeLessThan(10 * 1024 * 1024)
      expect(signUpMock).not.toHaveBeenCalled()
      expect(consoleSpies.flatMap((spy) => spy.mock.calls).flat().join(' ')).not.toContain('credential-sentinel')
    } finally {
      for (const spy of consoleSpies) spy.mockRestore()
    }
  })

  test('malformedLoginEmailIsRejectedBeforeSupabaseAuth', async function malformedLoginEmailIsRejectedBeforeSupabaseAuth() {
    const [registerResponse, loginResponse] = await Promise.all([
      register(body(JSON.stringify({ email: 'not-an-email', password: 'valid-password' }))),
      login(body(JSON.stringify({ email: 'not-an-email', password: 'valid-password' }))),
    ])
    expect(registerResponse.status).toBe(422)
    expect(loginResponse.status).toBe(422)
    expect(signUpMock).not.toHaveBeenCalled()
    expect(signInMock).not.toHaveBeenCalled()
  })

  test('authMissingFieldsAndOversizedPasswordFieldsUseTheSharedEnvelope', async function authMissingFieldsAndOversizedPasswordFieldsUseTheSharedEnvelope() {
    await expectValidationFailure(await parseBody(registerRequestSchema, body(JSON.stringify({ email: 'person@example.test' }))))
    await expectValidationFailure(await parseBody(loginRequestSchema, body(JSON.stringify({ email: 'person@example.test', password: 'x'.repeat(129) }))))
  })
})

describe('shared module route guard', () => {
  test('everyQueryAndPathSurfaceCallsTheSharedParserAndDefinesNoHandlerSchema', function everyQueryAndPathSurfaceCallsTheSharedParserAndDefinesNoHandlerSchema() {
    const routes = [
      ['parseQuery', 'app/api/admin/audit/route.ts'],
      ['parseQuery', 'app/api/services/route.ts'],
      ['parseQuery', 'app/api/slots/route.ts'],
      ['parseQuery', 'app/api/providers/route.ts'],
      ['parseParams', 'app/api/appointments/[id]/route.ts'],
      ['parseParams', 'app/api/providers/[providerId]/availability/route.ts'],
      ['parseParams', 'app/api/studies/[studyId]/route.ts'],
      ['parseParams', 'app/api/studies/[studyId]/clips/[clipId]/route.ts'],
      ['parseParams', 'app/api/reports/[reportId]/route.ts'],
      ['parseParams', 'app/api/shares/[id]/route.ts'],
      ['parseParams', 'app/api/s/[token]/route.ts'],
      ['parseBody', 'app/api/appointments/route.ts'],
      ['parseBody', 'app/api/appointments/[id]/route.ts'],
      ['parseBody', 'app/api/providers/[providerId]/availability/route.ts'],
      ['parseBody', 'app/api/shares/route.ts'],
      ['parseBody', 'app/api/auth/register/route.ts'],
      ['parseBody', 'app/api/auth/login/route.ts'],
      ['parseBody', 'app/api/profile/route.ts'],
      ['parseBody', 'app/api/identity/verify/route.ts'],
    ] as const

    for (const [parser, route] of routes) {
      const source = readFileSync(route, 'utf8')
      expect(source).toContain('lib/validation')
      expect(source).toContain(`${parser}(`)
      expect(source).not.toContain("from 'zod'")
    }
  })

  test('validationFailureEnvelopeNeverEchoesInputFieldPathsOrStackText', async function validationFailureEnvelopeNeverEchoesInputFieldPathsOrStackText() {
    const rejected = 'patient-name-password-and-phi'
    const result = await parseBody(profilePatchSchema, body(JSON.stringify({ fullName: rejected, phone: rejected, extra: rejected })))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const responseBody = await result.response.text()
      expect(responseBody).not.toContain(rejected)
      expect(responseBody).not.toMatch(/fullName|phone|extra|stack|database/i)
    }
  })
})

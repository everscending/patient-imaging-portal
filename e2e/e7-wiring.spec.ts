// JOR-205 — E7's live booking and appointment-lifecycle proof.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

import { config } from '../lib/config'

import {
  E2_BOOK_SERVICE_ID,
  E2_OTHER_PROVIDER_EMAIL,
  E2_OTHER_PROVIDER_ID,
  E2_PROVIDER_EMAIL,
  E2_PROVIDER_ID,
  E2_PROVIDER_ACCOUNT_ID,
  E2_PROVIDER_PASSWORD,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REAL_DEL4 = config.playwrightBaseUrl !== null
const REAL_PATIENT_EMAIL = 'patient@demo.pip.test'
const REAL_PASSWORD = 'DemoPass!2026'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'E7PatientPassword9'
const INSIDE_NOTICE_APPOINTMENT_ID = '22552255-2255-4255-8255-225522552255'
const OUTSIDE_NOTICE_APPOINTMENT_ID = '22662266-2266-4266-8266-226622662266'
const REQUESTED_PROVIDER_APPOINTMENT_ID = '26000000-0000-4000-8000-000000000101'
const CANCELLED_PROVIDER_APPOINTMENT_ID = '26000000-0000-4000-8000-000000000102'
const FUTURE_CONFIRMED_APPOINTMENT_ID = '26000000-0000-4000-8000-000000000103'
let identityFixtureLockToken: string | undefined

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function reset(request: APIRequestContext): Promise<void> {
  const fixture = await fakeServerUrl()
  expect((await request.post(`${fixture}/__test__/reset-identity`)).status()).toBe(200)
  expect((await request.post(`${fixture}/__test__/reset-booking`)).status()).toBe(200)
}

async function verifiedPatient(request: APIRequestContext): Promise<void> {
  const email = `e7-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await request.post('/api/identity/verify', {
    data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
  })).status()).toBe(200)
}

async function chooseFirstSlot(page: Page): Promise<string> {
  await page.goto('/book')
  await page.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
  await page.getByTestId('provider-select').selectOption(E2_OTHER_PROVIDER_ID)
  const first = page.getByTestId('slot-item').first()
  await expect(first).toBeVisible()
  const slotId = await first.getAttribute('data-slot-id')
  expect(slotId).toBeTruthy()
  await first.click()
  return slotId!
}

test.describe.serial('JOR-205 E7 scheduling wiring', () => {
  test.skip(REAL_DEL4, 'the real DEL-4 preflight owns this mode')
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))

  test('outsideNoticeAppointmentReschedulesThroughTheRunningApi', async function outsideNoticeAppointmentReschedulesThroughTheRunningApi({
    page,
  }) {
    await reset(page.request)
    await verifiedPatient(page.request)
    const from = new Date().toISOString()
    const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000).toISOString()
    const beforeResponse = await page.request.get('/api/appointments')
    expect(beforeResponse.status()).toBe(200)
    const before = (await beforeResponse.json()) as {
      appointments: Array<{ id: string; startsAt: string; providerName: string }>
    }
    const source = before.appointments.find(({ id }) => id === OUTSIDE_NOTICE_APPOINTMENT_ID)!
    const crossProviderResponse = await page.request.get('/api/slots', {
      params: { providerId: E2_OTHER_PROVIDER_ID, serviceId: E2_BOOK_SERVICE_ID, from, to },
    })
    const crossProviderSlots = (await crossProviderResponse.json()) as { slots: Array<{ id: string }> }
    const bookingState = (await (await page.request.get(`${await fakeServerUrl()}/__test__/booking-state`)).json()) as {
      slots: Array<{ id: string; provider_id: string; starts_at: string }>
    }
    const pastSameProviderSlot = bookingState.slots.find(({ provider_id, starts_at }) =>
      provider_id === E2_PROVIDER_ID && Date.parse(starts_at) <= Date.now(),
    )!
    for (const slotId of [crossProviderSlots.slots[0]!.id, pastSameProviderSlot.id]) {
      const rejected = await page.request.patch(`/api/appointments/${OUTSIDE_NOTICE_APPOINTMENT_ID}`, {
        data: { action: 'reschedule', slotId },
      })
      expect(rejected.status()).toBe(409)
      expect(await rejected.json()).toEqual({
        error: 'slot_unavailable',
        message: 'That slot is no longer available.',
      })
    }
    const slotsResponse = await page.request.get('/api/slots', {
      params: { providerId: E2_PROVIDER_ID, serviceId: E2_BOOK_SERVICE_ID, from, to },
    })
    expect(slotsResponse.status()).toBe(200)
    const { slots } = (await slotsResponse.json()) as { slots: Array<{ id: string; startsAt: string }> }
    expect(slots.length).toBeGreaterThan(0)
    const target = slots[0]!

    const response = await page.request.patch(`/api/appointments/${OUTSIDE_NOTICE_APPOINTMENT_ID}`, {
      data: { action: 'reschedule', slotId: target.id },
    })
    expect(response.status(), await response.text()).toBe(200)
    const moved = (await response.json()) as { id: string; startsAt: string; providerName: string }
    expect(moved.id).toBe(OUTSIDE_NOTICE_APPOINTMENT_ID)
    expect(Date.parse(moved.startsAt)).toBe(Date.parse(target.startsAt))
    expect(moved.providerName).toBe(source.providerName)

    const appointmentsResponse = await page.request.get('/api/appointments')
    expect(appointmentsResponse.status()).toBe(200)
    const { appointments } = (await appointmentsResponse.json()) as {
      appointments: Array<{ id: string; startsAt: string }>
    }
    expect(Date.parse(appointments.find(({ id }) => id === moved.id)!.startsAt)).toBe(Date.parse(target.startsAt))

    const openSlotsAfter = await page.request.get('/api/slots', {
      params: { providerId: E2_PROVIDER_ID, serviceId: E2_BOOK_SERVICE_ID, from, to },
    })
    expect((await openSlotsAfter.json()) as { slots: Array<{ id: string }> }).toEqual({
      slots: expect.not.arrayContaining([expect.objectContaining({ id: target.id })]),
    })

    const freedSourceResponse = await page.request.get('/api/slots', {
      params: { providerId: E2_PROVIDER_ID, serviceId: E2_BOOK_SERVICE_ID, from, to },
    })
    expect(freedSourceResponse.status()).toBe(200)
    const freedSource = (await freedSourceResponse.json()) as { slots: Array<{ startsAt: string }> }
    expect(freedSource.slots.some(({ startsAt }) =>
      Math.trunc(Date.parse(startsAt) / 1_000) === Math.trunc(Date.parse(source.startsAt) / 1_000),
    )).toBe(true)

    const cancelResponse = await page.request.patch(`/api/appointments/${OUTSIDE_NOTICE_APPOINTMENT_ID}`, {
      data: { action: 'cancel' },
    })
    expect(cancelResponse.status(), await cancelResponse.text()).toBe(200)
    expect((await cancelResponse.json()) as { status: string }).toEqual(expect.objectContaining({ status: 'cancelled' }))
    const openAfterCancelResponse = await page.request.get('/api/slots', {
      params: { providerId: E2_PROVIDER_ID, serviceId: E2_BOOK_SERVICE_ID, from, to },
    })
    const openAfterCancel = (await openAfterCancelResponse.json()) as { slots: Array<{ id: string }> }
    expect(openAfterCancel.slots).toContainEqual(expect.objectContaining({ id: target.id }))

    const fixtureState = (await (await page.request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json()) as {
      auditEvents: Array<{ action: string; target_id: string | null; detail: unknown }>
    }
    expect(fixtureState.auditEvents).toContainEqual(expect.objectContaining({
      action: 'booking.reschedule',
      target_id: moved.id,
      detail: null,
    }))
    expect(fixtureState.auditEvents).toContainEqual(expect.objectContaining({
      action: 'booking.cancel',
      target_id: moved.id,
      detail: null,
    }))
  })

  test('bookingRetryAndPatientRequestedToConfirmedUseThePersistedAppointment', async function bookingRetryAndPatientRequestedToConfirmedUseThePersistedAppointment({
    page,
  }) {
    await reset(page.request)
    await verifiedPatient(page.request)
    const from = new Date().toISOString()
    const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000).toISOString()
    const slotsResponse = await page.request.get('/api/slots', {
      params: { providerId: E2_OTHER_PROVIDER_ID, serviceId: E2_BOOK_SERVICE_ID, from, to },
    })
    const { slots } = (await slotsResponse.json()) as { slots: Array<{ id: string }> }
    expect(slots.length).toBeGreaterThanOrEqual(2)
    const idempotencyKey = randomUUID()
    const body = { slotId: slots[0]!.id, serviceId: E2_BOOK_SERVICE_ID, idempotencyKey }

    const createdResponse = await page.request.post('/api/appointments', { data: body })
    expect(createdResponse.status()).toBe(201)
    const created = (await createdResponse.json()) as { id: string; status: string }
    expect(created.status).toBe('requested')

    const retriedResponse = await page.request.post('/api/appointments', { data: body })
    expect(retriedResponse.status()).toBe(200)
    expect((await retriedResponse.json()) as { id: string }).toEqual(expect.objectContaining({ id: created.id }))

    const reusedForDifferentSlot = await page.request.post('/api/appointments', {
      data: { ...body, slotId: slots[1]!.id },
    })
    expect(reusedForDifferentSlot.status()).toBe(409)
    expect(await reusedForDifferentSlot.json()).toEqual({
      error: 'idempotency_key_reused',
      message: 'That request key was already used for a different slot.',
    })

    const patientConfirm = await page.request.patch(`/api/appointments/${created.id}`, {
      data: { action: 'transition', status: 'confirmed' },
    })
    expect(patientConfirm.status()).toBe(422)
    expect(await patientConfirm.json()).toEqual({
      error: 'invalid_transition',
      message: "That change is not allowed from this appointment's current status.",
    })

    const appointmentsResponse = await page.request.get('/api/appointments')
    const { appointments } = (await appointmentsResponse.json()) as {
      appointments: Array<{ id: string; status: string }>
    }
    expect(appointments).toContainEqual(expect.objectContaining({ id: created.id, status: 'requested' }))
    const fixtureState = (await (await page.request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json()) as {
      auditEvents: Array<{ action: string; target_id: string | null }>
    }
    // Two granted rows: the original create and the EC-10 replay — SEC-4
    // records every request, replays included.
    expect(fixtureState.auditEvents.filter(({ action, target_id }) =>
      action === 'booking.create' && target_id === created.id,
    )).toHaveLength(2)
  })

  test('insideNoticeRescheduleAndCancelStayLockedByTheServerAndUi', async function insideNoticeRescheduleAndCancelStayLockedByTheServerAndUi({
    page,
  }) {
    await reset(page.request)
    await verifiedPatient(page.request)
    await page.goto('/appointments')
    await expect(page.getByTestId('appointment-notice-locked')).toHaveText(
      'Changes are not allowed within 24 hours of the start. Call the clinic.',
    )
    const bookingState = (await (await page.request.get(`${await fakeServerUrl()}/__test__/booking-state`)).json()) as {
      slots: Array<{ id: string }>
    }
    const targetSlotId = bookingState.slots[0]!.id
    for (const data of [
      { action: 'reschedule', slotId: targetSlotId },
      { action: 'cancel' },
    ]) {
      const response = await page.request.patch(`/api/appointments/${INSIDE_NOTICE_APPOINTMENT_ID}`, { data })
      expect(response.status()).toBe(422)
      expect(await response.json()).toEqual({
        error: 'minimum_notice',
        message: 'Changes are not allowed within 24 hours of the appointment.',
      })
    }
    const appointmentsResponse = await page.request.get('/api/appointments')
    const { appointments } = (await appointmentsResponse.json()) as {
      appointments: Array<{ id: string; status: string }>
    }
    expect(appointments).toContainEqual(expect.objectContaining({
      id: INSIDE_NOTICE_APPOINTMENT_ID,
      status: 'confirmed',
    }))
  })

  test('patientAndProviderForeignSchedulingReadsAreConcealedAs404', async function patientAndProviderForeignSchedulingReadsAreConcealedAs404({
    page,
  }) {
    await reset(page.request)
    await verifiedPatient(page.request)
    const foreignAppointment = await page.request.patch(`/api/appointments/${CANCELLED_PROVIDER_APPOINTMENT_ID}`, {
      data: { action: 'cancel' },
    })
    expect(foreignAppointment.status()).toBe(404)

    await page.context().clearCookies()
    expect((await page.request.post('/api/auth/login', {
      data: { email: E2_OTHER_PROVIDER_EMAIL, password: E2_PROVIDER_PASSWORD },
    })).status()).toBe(200)
    const foreignSchedule = await page.request.get('/api/provider/schedule', {
      params: { date: '2026-08-17', providerId: E2_PROVIDER_ID },
    })
    expect(foreignSchedule.status()).toBe(404)
  })

  test('providerLifecyclePermitsOnlyTheRoleAndTimeLegalTransitionsAndAuditsEachChange', async function providerLifecyclePermitsOnlyTheRoleAndTimeLegalTransitionsAndAuditsEachChange({
    page,
  }) {
    await reset(page.request)
    expect((await page.request.post(`${await fakeServerUrl()}/__test__/reset-availability`)).status()).toBe(200)
    expect((await page.request.post('/api/auth/login', {
      data: { email: E2_PROVIDER_EMAIL, password: E2_PROVIDER_PASSWORD },
    })).status()).toBe(200)

    for (const status of ['confirmed', 'completed'] as const) {
      const response = await page.request.patch(`/api/appointments/${REQUESTED_PROVIDER_APPOINTMENT_ID}`, {
        data: { action: 'transition', status },
      })
      expect(response.status(), await response.text()).toBe(200)
      expect((await response.json()) as { status: string }).toEqual(expect.objectContaining({ status }))
    }
    for (const [id, status] of [
      [CANCELLED_PROVIDER_APPOINTMENT_ID, 'completed'],
      [FUTURE_CONFIRMED_APPOINTMENT_ID, 'no_show'],
    ] as const) {
      const response = await page.request.patch(`/api/appointments/${id}`, {
        data: { action: 'transition', status },
      })
      expect(response.status()).toBe(422)
      expect(await response.json()).toEqual(expect.objectContaining({ error: 'invalid_transition' }))
    }

    const fixtureState = (await (await page.request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json()) as {
      auditEvents: Array<{
        actor_ref: string | null
        action: string
        target_id: string | null
        detail: unknown
      }>
    }
    const transitions = fixtureState.auditEvents.filter(({ action, target_id }) =>
      action === 'appointment.transition' && target_id === REQUESTED_PROVIDER_APPOINTMENT_ID,
    )
    expect(transitions).toHaveLength(2)
    expect(transitions.every(({ detail }) => detail === null)).toBe(true)
    expect(JSON.stringify(transitions)).not.toMatch(/Morgan Rivers|1988-03-14|PT-4471/)
  })

  test('patientBooksAnOpenFutureSlotAndTheSlotDisappearsImmediately', async function patientBooksAnOpenFutureSlotAndTheSlotDisappearsImmediately({
    page,
  }) {
    await reset(page.request)
    await verifiedPatient(page.request)
    const slotId = await chooseFirstSlot(page)
    const statuses: number[] = []
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/appointments') {
        statuses.push(response.status())
      }
    })
    await Promise.all([
      page.getByTestId('book-submit').click(),
      page.getByTestId('book-submit').click(),
    ])
    await expect.poll(() => statuses.sort()).toEqual([200, 201])
    await expect(page.getByTestId('booking-success')).toContainText('Appointment requested')
    const bookingState = (await (await page.request.get(`${await fakeServerUrl()}/__test__/booking-state`)).json()) as {
      appointments: unknown[]
    }
    expect(bookingState.appointments).toHaveLength(1)

    await page.reload()
    await page.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
    await page.getByTestId('provider-select').selectOption(E2_OTHER_PROVIDER_ID)
    await expect(page.locator(`[data-slot-id="${slotId}"]`)).toHaveCount(0)
  })

  test('bookingRaceShowsThePinnedEc7LoserMessageAndKeepsOneAppointment', async function bookingRaceShowsThePinnedEc7LoserMessageAndKeepsOneAppointment({
    page,
  }) {
    await reset(page.request)
    await verifiedPatient(page.request)
    const slotId = await chooseFirstSlot(page)
    expect((await page.request.post(`${await fakeServerUrl()}/__test__/book-slot`, {
      data: { slotId },
    })).status()).toBe(201)
    await page.getByTestId('book-submit').click()
    await expect(page.getByTestId('booking-conflict')).toHaveText(
      'That slot is no longer available. Someone booked it moments ago. Please choose another time.',
    )
    await expect(page.locator(`[data-slot-id="${slotId}"]`)).toBeDisabled()
    const bookingState = (await (await page.request.get(`${await fakeServerUrl()}/__test__/booking-state`)).json()) as {
      appointments: unknown[]
    }
    expect(bookingState.appointments).toHaveLength(1)
  })

  test('simultaneousRequestsForOneSlotHaveOneSuccessAndClearLosers', async function simultaneousRequestsForOneSlotHaveOneSuccessAndClearLosers({
    page,
  }) {
    await reset(page.request)
    await verifiedPatient(page.request)
    const bookingState = (await (await page.request.get(`${await fakeServerUrl()}/__test__/booking-state`)).json()) as {
      slots: Array<{ id: string }>
    }
    const slotId = bookingState.slots[0]!.id
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      page.request.post('/api/appointments', {
        data: { slotId, serviceId: E2_BOOK_SERVICE_ID, idempotencyKey: randomUUID() },
      }),
    ))
    expect(responses.map((response) => response.status()).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409])
    for (const response of responses.filter((response) => response.status() === 409)) {
      expect(await response.json()).toEqual({
        error: 'slot_unavailable',
        message: 'That slot is no longer available.',
      })
    }
    const after = (await (await page.request.get(`${await fakeServerUrl()}/__test__/booking-state`)).json()) as {
      appointments: unknown[]
    }
    expect(after.appointments).toHaveLength(1)
  })

  test('fullWalkWritesTargetedPhiFreeAuditRowsForEveryMutation', async function fullWalkWritesTargetedPhiFreeAuditRowsForEveryMutation({
    page,
  }) {
    await reset(page.request)
    await verifiedPatient(page.request)
    const fixture = await fakeServerUrl()
    const initialState = (await (await page.request.get(`${fixture}/__test__/identity-state`)).json()) as {
      patients: Array<{ patient_ref: string; user_id: string | null }>
    }
    const patientActor = initialState.patients.find(({ patient_ref }) => patient_ref === 'PT-4471')!.user_id!
    const bookingState = (await (await page.request.get(`${fixture}/__test__/booking-state`)).json()) as {
      slots: Array<{ id: string; provider_id: string }>
    }
    const bookingSlot = bookingState.slots[0]!
    const moveSlot = bookingState.slots.find(({ provider_id }) => provider_id === E2_PROVIDER_ID)!
    const bookingResponse = await page.request.post('/api/appointments', {
      data: {
        slotId: bookingSlot.id,
        serviceId: E2_BOOK_SERVICE_ID,
        idempotencyKey: randomUUID(),
      },
    })
    expect(bookingResponse.status()).toBe(201)
    const booked = (await bookingResponse.json()) as { id: string }

    const moved = await page.request.patch(`/api/appointments/${OUTSIDE_NOTICE_APPOINTMENT_ID}`, {
      data: { action: 'reschedule', slotId: moveSlot.id },
    })
    expect(moved.status()).toBe(200)
    expect((await page.request.patch(`/api/appointments/${OUTSIDE_NOTICE_APPOINTMENT_ID}`, {
      data: { action: 'cancel' },
    })).status()).toBe(200)

    expect((await page.request.post(`${fixture}/__test__/reset-availability`)).status()).toBe(200)
    await page.context().clearCookies()
    expect((await page.request.post('/api/auth/login', {
      data: { email: E2_PROVIDER_EMAIL, password: E2_PROVIDER_PASSWORD },
    })).status()).toBe(200)
    expect((await page.request.patch(`/api/appointments/${REQUESTED_PROVIDER_APPOINTMENT_ID}`, {
      data: { action: 'transition', status: 'confirmed' },
    })).status()).toBe(200)

    const state = (await (await page.request.get(`${fixture}/__test__/identity-state`)).json()) as {
      auditEvents: Array<{
        actor_ref: string | null
        action: string
        target_id: string | null
        detail: unknown
      }>
    }
    const expected = [
      { actor_ref: patientActor, action: 'booking.create', target_id: booked.id },
      { actor_ref: patientActor, action: 'booking.reschedule', target_id: OUTSIDE_NOTICE_APPOINTMENT_ID },
      { actor_ref: patientActor, action: 'booking.cancel', target_id: OUTSIDE_NOTICE_APPOINTMENT_ID },
      { actor_ref: E2_PROVIDER_ACCOUNT_ID, action: 'appointment.transition', target_id: REQUESTED_PROVIDER_APPOINTMENT_ID },
    ]
    for (const row of expected) {
      expect(state.auditEvents).toContainEqual(expect.objectContaining({ ...row, detail: null }))
    }
    expect(JSON.stringify(state.auditEvents.map(({ detail }) => detail))).not.toMatch(
      /Morgan Rivers|1988-03-14|PT-4471/,
    )
  })
})

test.describe('JOR-205 E7 real DEL-4 preflight', () => {
  test.skip(!REAL_DEL4, 'requires the credential-free local DEL-4 runtime')
  test('seededPatientBooksReschedulesAndCancelsThroughThePublicApi', async ({ request }) => {
    expect((await request.post('/api/auth/login', {
      data: { email: REAL_PATIENT_EMAIL, password: REAL_PASSWORD },
    })).status()).toBe(200)

    const services = (await (await request.get('/api/services')).json()) as { services: Array<{ id: string }> }
    expect(services.services.length).toBeGreaterThan(0)
    const serviceId = services.services[0]!.id
    const providers = (await (await request.get('/api/providers', { params: { serviceId } })).json()) as {
      providers: Array<{ id: string }>
    }
    expect(providers.providers.length).toBeGreaterThan(0)
    const providerId = providers.providers[0]!.id
    const from = new Date(Date.now() + 25 * 60 * 60 * 1_000).toISOString()
    const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000).toISOString()
    const slots = (await (await request.get('/api/slots', { params: { providerId, serviceId, from, to } })).json()) as {
      slots: Array<{ id: string }>
    }
    expect(slots.slots.length).toBeGreaterThanOrEqual(2)

    const created = await request.post('/api/appointments', {
      data: { slotId: slots.slots[0]!.id, serviceId, idempotencyKey: randomUUID() },
    })
    expect(created.status(), await created.text()).toBe(201)
    const appointment = (await created.json()) as { id: string }

    expect((await request.patch(`/api/appointments/${appointment.id}`, {
      data: { action: 'reschedule', slotId: slots.slots[1]!.id },
    })).status()).toBe(200)
    expect((await request.patch(`/api/appointments/${appointment.id}`, {
      data: { action: 'cancel' },
    })).status()).toBe(200)
  })
})

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const PASSWORD = 'CorrectHorseBattery9'
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
let identityFixtureLockToken: string | undefined

async function fakeAuthServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fakeAuthServerUrl()}/__test__/reset-identity`)).status()).toBe(200)
}

async function registerAndLink(
  page: Page,
  patient = { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
): Promise<string> {
  const email = `empty-${Date.now()}-${Math.random()}@example.test`
  expect((await page.request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  const login = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } })
  expect(login.status()).toBe(200)
  expect((await page.request.post('/api/identity/verify', {
    data: patient,
    headers: { 'x-forwarded-for': `192.0.2.${Math.floor(Math.random() * 200) + 1}` },
  })).status()).toBe(200)
  return ((await login.json()) as { userId: string }).userId
}

test.beforeAll(async () => {
  test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
  identityFixtureLockToken = await acquireIdentityFixtureLock()
})
test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
test.beforeEach(async ({ request }) => resetIdentity(request))

test('zero-row lists keep their containers and render the pinned empty-state copy', async ({ page }) => {
  await registerAndLink(page, { patientRef: 'PT-6600', dateOfBirth: '1990-01-02' })

  const cases = [
    ['/studies', 'study-list', 'study-card', 'No images yet — images appear here once a completed visit has been processed by the clinic.'],
    ['/reports', 'report-list', 'report-item', 'No reports yet — a report appears here once your clinician has signed it.'],
    ['/appointments', 'appointment-list', 'appointment-item', 'No appointments yet — booked appointments appear here.'],
    ['/shares', 'share-list', 'share-row', "You haven't shared anything yet — sharing an image or a report creates a link here."],
  ] as const

  for (const [path, listHook, rowHook, copy] of cases) {
    await page.goto(path)
    const list = page.getByTestId(listHook)
    await expect(list).toBeVisible()
    await expect(list.getByText(copy, { exact: true })).toBeVisible()
    await expect(page.getByTestId(rowHook)).toHaveCount(0)
  }
})

test('deletion request validates the caller and body, records one row, audits both outcomes, and rejects a duplicate', async ({ page }) => {
  const route = '/api/profile/deletion-request'
  expect((await page.request.post(route, { data: {} })).status()).toBe(401)

  const callerId = await registerAndLink(page)
  expect((await page.request.post(route, { data: { patientId: '55825582-5582-4582-8582-558255825582' } })).status()).toBe(422)
  expect((await page.request.post(route, {
    data: '{',
    headers: { 'Content-Type': 'application/json' },
  })).status()).toBe(422)

  const accepted = await page.request.post(route, { data: {} })
  expect(accepted.status()).toBe(202)
  expect(await accepted.json()).toEqual({ status: 'received', requestedAt: expect.any(String) })

  const duplicate = await page.request.post(route, { data: {} })
  expect(duplicate.status()).toBe(409)
  expect(await duplicate.json()).toEqual({
    error: 'request_already_open',
    message: expect.any(String),
  })

  const state = await (await page.request.get(`${await fakeAuthServerUrl()}/__test__/identity-state`)).json() as {
    deletionRequests: Array<{ patient_id: string; requested_by: string; status: string }>
    auditEvents: Array<{ action: string; outcome: string }>
  }
  expect(state.deletionRequests).toHaveLength(1)
  expect(state.deletionRequests[0]).toMatchObject({
    patient_id: '44714471-4471-4471-8471-447144714471',
    status: 'received',
  })
  expect(state.deletionRequests[0]?.requested_by).toBe(callerId)
  expect(state.auditEvents.filter((event) => event.action === 'profile.deletion_request')).toEqual([
    expect.objectContaining({ outcome: 'granted' }),
    expect.objectContaining({ outcome: 'denied' }),
  ])
})

test('profile confirms before requesting deletion and renders submitted and already-open states', async ({ page }) => {
  await registerAndLink(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/profile')
  await expect(page.getByTestId('profile-form')).toBeVisible()

  await page.getByRole('button', { name: 'Request deletion' }).click()
  const dialog = page.getByRole('dialog', { name: 'Request data deletion' })
  await expect(dialog).toBeVisible()
  for (const button of [
    dialog.getByRole('button', { name: 'Cancel' }),
    dialog.getByRole('button', { name: 'Confirm deletion request' }),
  ]) {
    const box = await button.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  const afterCancel = await (await page.request.get(`${await fakeAuthServerUrl()}/__test__/identity-state`)).json() as {
    deletionRequests: unknown[]
  }
  expect(afterCancel.deletionRequests).toHaveLength(0)

  await page.getByRole('button', { name: 'Request deletion' }).click()
  await dialog.getByRole('button', { name: 'Confirm deletion request' }).click()
  await expect(page.getByText("We've received your request. The clinic will be in touch. Your images, reports and appointments stay available until then.", { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('profile-form')).toBeVisible()
  await page.getByRole('button', { name: 'Request deletion' }).click()
  await dialog.getByRole('button', { name: 'Confirm deletion request' }).click()
  await expect(page.getByText('You already have a request open. The clinic will be in touch about it.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('concurrent deletion requests create at most one open row without a server error', async ({ page }) => {
  await registerAndLink(page)
  const responses = await Promise.all([
    page.request.post('/api/profile/deletion-request', { data: {} }),
    page.request.post('/api/profile/deletion-request', { data: {} }),
  ])
  expect(responses.map((response) => response.status()).sort()).toEqual([202, 409])

  const state = await (await page.request.get(`${await fakeAuthServerUrl()}/__test__/identity-state`)).json() as {
    deletionRequests: unknown[]
  }
  expect(state.deletionRequests).toHaveLength(1)
})

test('retention policy names every required record class and deletion residue', async () => {
  const policy = await readFile(path.join(REPO_ROOT, 'docs/retention-and-deletion.md'), 'utf8')
  for (const recordClass of [
    'images',
    'cine clips',
    'frames',
    'reports',
    'appointments',
    'appointment transitions',
    'identity attempts',
    'share links',
    'deletion requests',
    'audit events',
  ]) {
    expect(policy.toLowerCase()).toContain(recordClass)
  }
  expect(policy).toContain('300 seconds')
  expect(policy).toContain('access grant')
  expect(policy).toMatch(/append-only/i)
})

test('deletion request is insert-only and cannot erase or revoke patient data', async () => {
  const route = await readFile(path.join(REPO_ROOT, 'app/api/profile/deletion-request/route.ts'), 'utf8')
  expect(route).not.toMatch(/\.delete\s*\(|\.update\s*\(|serviceClient/)
  expect(route).toContain(".from('deletion_requests')")
})

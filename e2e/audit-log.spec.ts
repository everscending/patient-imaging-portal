// JOR-206 — live admin audit-log coverage against the real route and screen.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { config } from '../lib/config'
import {
  E2_PROVIDER_EMAIL,
  E2_PROVIDER_PASSWORD,
} from './fixtures/fake-auth-server'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'
const IDENTITY_FIXTURE_LOCK = path.join(REPO_ROOT, '.local', 'identity-fixture.lock')

async function acquireIdentityFixture(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await mkdir(IDENTITY_FIXTURE_LOCK)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('identity fixture lock timed out')
}

async function fakeAuthServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetAuditLog(request: APIRequestContext): Promise<void> {
  const authUrl = await fakeAuthServerUrl()
  expect((await request.post(`${authUrl}/__test__/reset-identity`)).status()).toBe(200)
}

async function seedAndSignInAdmin(request: APIRequestContext): Promise<string> {
  const authUrl = await fakeAuthServerUrl()
  const email = 'admin@demo.pip.test'
  const seed = await request.post(`${authUrl}/__test__/seed-admin`, { data: { email, password: PASSWORD } })
  expect(seed.status()).toBe(200)
  const { userId } = (await seed.json()) as { userId: string }
  const response = await request.post('/api/auth/login', { data: { email, password: PASSWORD } })
  expect(response.status()).toBe(200)
  return userId
}

test.describe('GET /api/admin/audit and /admin/audit', () => {
  test.beforeAll(acquireIdentityFixture)
  test.afterAll(async () => rm(IDENTITY_FIXTURE_LOCK, { recursive: true, force: true }))

  test('mandatory adversarial: patientProviderAndNoSessionCannotReadAuditLog', async ({ request, playwright }) => {
    await resetAuditLog(request)
    expect((await request.get('/api/admin/audit')).status()).toBe(401)

    const patient = await playwright.request.newContext({ baseURL: `http://localhost:${config.port}` })
    const patientResponse = await patient.post('/api/auth/register', { data: { email: 'audit-patient@example.test', password: PASSWORD } })
    expect(patientResponse.status()).toBe(201)
    await patient.post('/api/auth/login', { data: { email: 'audit-patient@example.test', password: PASSWORD } })
    expect((await patient.get('/api/admin/audit')).status()).toBe(404)

    const provider = await playwright.request.newContext({ baseURL: `http://localhost:${config.port}` })
    expect((await provider.post('/api/auth/login', {
      data: { email: E2_PROVIDER_EMAIL, password: E2_PROVIDER_PASSWORD },
    })).status()).toBe(200)
    expect((await provider.get('/api/admin/audit')).status()).toBe(404)
    await patient.dispose()
    await provider.dispose()

    const adminId = await seedAndSignInAdmin(request)
    const auditRead = await request.get('/api/admin/audit')
    expect(auditRead.status()).toBe(200)
    const { events } = (await auditRead.json()) as {
      events: Array<{ action: string; actorRef: string | null; outcome: string }>
    }
    expect(events.filter((event) => event.action === 'audit.view' && event.outcome === 'denied')).toHaveLength(3)
    expect(events).toContainEqual(expect.objectContaining({
      action: 'audit.view',
      actorRef: adminId,
      outcome: 'granted',
    }))
  })

  test('mandatory adversarial: invalidAuditQueriesAndForeignCursorReturnShared422', async ({ request }) => {
    await resetAuditLog(request)
    await seedAndSignInAdmin(request)
    for (const suffix of [
      '?action=image.viewed',
      '?from=2026-02-02T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
      '?cursor=not-a-cursor',
      '?unexpected=true',
    ]) {
      const response = await request.get(`/api/admin/audit${suffix}`)
      expect(response.status(), suffix).toBe(422)
      expect(await response.json()).toEqual({ error: 'validation_failed', message: expect.any(String) })
    }

    const foreignCursor = Buffer.from(
      JSON.stringify({ id: '1', occurredAt: '2026-01-01T00:00:00.000Z', filters: { action: 'study.view' } }),
    ).toString('base64url')
    expect((await request.get(`/api/admin/audit?action=report.view&cursor=${encodeURIComponent(foreignCursor)}`)).status()).toBe(422)

    const auditedRead = await request.get('/api/admin/audit')
    const { events } = (await auditedRead.json()) as { events: Array<{ action: string; outcome: string }> }
    expect(events.filter((event) => event.action === 'audit.view' && event.outcome === 'granted')).toHaveLength(6)
  })

  test('mandatory adversarial: unsupportedMethodsAreRejected', async ({ request }) => {
    await seedAndSignInAdmin(request)
    for (const method of ['post', 'patch', 'delete'] as const) {
      expect((await request[method]('/api/admin/audit')).status(), method).toBe(405)
    }
  })

  test('mandatory adversarial: auditLogCursorPagesWithoutDuplicates', async ({ request }) => {
    await resetAuditLog(request)
    await seedAndSignInAdmin(request)
    for (let index = 0; index < 51; index += 1) {
      expect((await request.get('/api/admin/audit')).status()).toBe(200)
    }

    const firstPage = await request.get('/api/admin/audit')
    expect(firstPage.status()).toBe(200)
    const first = (await firstPage.json()) as { events: Array<{ id: string }>; nextCursor: string | null }
    expect(first.events).toHaveLength(50)
    expect(first.nextCursor).not.toBeNull()

    const secondPage = await request.get(`/api/admin/audit?cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
    expect(secondPage.status()).toBe(200)
    const second = (await secondPage.json()) as { events: Array<{ id: string }>; nextCursor: string | null }
    expect(second.events.length).toBeGreaterThan(0)
    expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(
      first.events.length + second.events.length,
    )
  })

  test('acceptance: fromToActorAndActionFiltersConstrainRows', async ({ request }) => {
    await resetAuditLog(request)
    const adminId = await seedAndSignInAdmin(request)
    const query = new URLSearchParams({
      from: '2020-01-01T00:00:00.000Z',
      to: '2030-01-01T00:00:00.000Z',
      actorRef: adminId,
      action: 'audit.view',
    })
    const response = await request.get(`/api/admin/audit?${query}`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as {
      events: Array<{ action: string; actorRef: string | null }>
      nextCursor: string | null
    }
    expect(body.events.length).toBeGreaterThan(0)
    expect(body.nextCursor).toBeNull()
    expect(body.events.every((event) => event.action === 'audit.view' && event.actorRef === adminId)).toBe(true)
  })

  test('mandatory adversarial: routeUsesSharedParseQueryForAuditQuery', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'app/api/admin/audit/route.ts'), 'utf8')
    expect(source).toContain('parseQuery(auditLogQuerySchema, request)')
    expect(source).not.toContain('searchParams')
  })

  test('acceptance: seededAdminSeesDeniedAndGrantedRowsThenOwnAuditViewAfterReload', async ({ request, browser }) => {
    await resetAuditLog(request)
    const patient = await browser.newContext()
    await patient.request.post('/api/auth/register', { data: { email: 'audit-denied@example.test', password: PASSWORD } })
    await patient.request.post('/api/auth/login', { data: { email: 'audit-denied@example.test', password: PASSWORD } })
    expect((await patient.request.get('/api/admin/audit')).status()).toBe(404)
    await patient.close()

    const adminId = await seedAndSignInAdmin(request)
    const read = await request.get('/api/admin/audit')
    expect(read.status()).toBe(200)
    const body = (await read.json()) as { events: Array<Record<string, unknown>>; nextCursor: string | null }
    expect(Object.keys(body).sort()).toEqual(['events', 'nextCursor'])
    expect(body.events).not.toHaveLength(0)
    for (const event of body.events) {
      expect(Object.keys(event).sort()).toEqual([
        'action', 'actorKind', 'actorRef', 'id', 'occurredAt', 'outcome', 'targetId', 'targetKind',
      ])
    }

    const state = await request.storageState()
    const admin = await browser.newContext({ storageState: state })
    const page = await admin.newPage()
    await page.goto('/admin/audit')
    await expect(page.getByTestId('audit-log')).toHaveCount(1)
    await expect(page.getByTestId('audit-row')).toHaveCount(body.events.length + 1)
    await expect(page.getByTestId('audit-row').filter({ hasText: 'Denied' }).first()).toBeVisible()
    await expect(page.getByTestId('audit-row').filter({ hasText: 'Granted' }).first()).toBeVisible()
    await expect(page.getByRole('link')).toHaveCount(1)
    const bodyText = await page.locator('body').innerText()
    for (const phi of [
      'Morgan Rivers',
      '1988-03-14',
      'morgan.rivers@example.test',
      'Seeded abdominal ultrasound',
      'No acute abnormality.',
      'Normal seeded study.',
    ]) {
      expect(bodyText).not.toContain(phi)
    }
    await page.reload()
    await expect(page.getByTestId('audit-row')).toHaveCount(body.events.length + 2)
    await expect(page.getByTestId('audit-row').filter({ hasText: new RegExp(`${adminId}.*audit\\.view`) }).first()).toBeVisible()
    await admin.close()
  })
})

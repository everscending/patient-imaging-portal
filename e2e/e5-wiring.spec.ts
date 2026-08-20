// JOR-248 — E5's live share/deliver/open/revoke/expire/audit proof.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'

import { config } from '../lib/config'
import {
  E2_SEEDED_IMAGE_ID,
  E2_SEEDED_REPORT_ID,
  E5_CRON_SECRET,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const MAIL_DIR = path.join(REPO_ROOT, '.local', 'mail')
const PASSWORD = 'CorrectHorseBattery9'
const UNAVAILABLE_COPY = 'This link is no longer available. Secure links expire and can be revoked by the person who shared them. Ask them to send a new one.'
let identityFixtureLockToken: string | undefined

type CreatedShare = { id: string; url: string; expiresAt: string; recipientEmail: string }
type AuditEvent = { action: string; actorRef: string | null; targetId: string | null; outcome: string }

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function reset(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)).status()).toBe(200)
}

async function registerAndLink(request: APIRequestContext): Promise<void> {
  const email = `jor-248-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await request.post('/api/identity/verify', {
    data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
  })).status()).toBe(200)
}

async function createShare(request: APIRequestContext, resourceKind: 'image' | 'report', resourceId: string): Promise<CreatedShare> {
  const recipientEmail = `${resourceKind}-${randomUUID()}@example.test`
  const response = await request.post('/api/shares', { data: { resourceKind, resourceId, recipientEmail } })
  expect(response.status(), `minting the ${resourceKind} share must not require an email key`).toBe(201)
  return response.json() as Promise<CreatedShare>
}

async function createImageAndReportShares(request: APIRequestContext): Promise<[CreatedShare, CreatedShare]> {
  return [
    await createShare(request, 'image', E2_SEEDED_IMAGE_ID),
    await createShare(request, 'report', E2_SEEDED_REPORT_ID),
  ]
}

async function newFilesSince(before: Set<string>): Promise<Array<{ name: string; text: string }>> {
  const names = await readdir(MAIL_DIR).catch(() => [])
  return Promise.all(names.filter((name) => !before.has(name)).map(async (name) => ({
    name,
    text: await readFile(path.join(MAIL_DIR, name), 'utf8'),
  })))
}

async function anonymousPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  return { context, page: await context.newPage() }
}

async function unavailableText(page: Page): Promise<string> {
  const screen = page.getByTestId('share-unavailable')
  await expect(screen).toBeVisible()
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Link unavailable')
  await expect(screen.getByText(UNAVAILABLE_COPY, { exact: true })).toBeVisible()
  await expect(page.getByTestId('image-viewer')).toHaveCount(0)
  await expect(page.getByTestId('report-view')).toHaveCount(0)
  return screen.innerText()
}

async function seedAndSignInAdmin(request: APIRequestContext): Promise<void> {
  const email = `jor-248-admin-${randomUUID()}@example.test`
  expect((await request.post(`${await fakeServerUrl()}/__test__/seed-admin`, {
    data: { email, password: PASSWORD },
  })).status()).toBe(200)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

async function auditEvents(request: APIRequestContext, action: 'share.create' | 'share.use'): Promise<AuditEvent[]> {
  const response = await request.get(`/api/admin/audit?action=${action}`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { events: AuditEvent[] }).events
}

test.describe.serial('JOR-248 E5 sharing wiring', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => {
    await reset(request)
    await registerAndLink(request)
  })

  test('acceptance: imageAndReportMintAndLogTransportDeliverGenericLinkOnlyEmailWithoutAKey', async ({ request }) => {
    const beforeMail = new Set(await readdir(MAIL_DIR).catch(() => []))
    const startedAt = Date.now()
    const [imageShare, reportShare] = await createImageAndReportShares(request)
    const mintedBy = Date.now()

    expect(config.shareLinkTtlHours).toBe(48)
    for (const share of [imageShare, reportShare]) {
      expect(Date.parse(share.expiresAt)).toBeGreaterThanOrEqual(startedAt + 48 * 60 * 60 * 1000)
      expect(Date.parse(share.expiresAt)).toBeLessThanOrEqual(mintedBy + 48 * 60 * 60 * 1000)
    }
    const dispatch = await request.post('/api/jobs/reminders', { headers: { 'x-cron-secret': E5_CRON_SECRET } })
    expect(dispatch.status(), 'the durable share-email queue must drain through the real log transport').toBe(200)

    const delivered = await newFilesSince(beforeMail)
    expect(delivered).toHaveLength(2)
    const wire = delivered.map(({ text }) => JSON.parse(text) as { to: string; subject: string; text: string })
    expect(new Set(wire.map((message) => message.to))).toEqual(new Set([imageShare.recipientEmail, reportShare.recipientEmail]))
    for (const message of wire) {
      expect(message.subject).toBe('Someone shared a secure medical file with you')
      expect([imageShare.url, reportShare.url].some((url) => message.text.includes(url))).toBe(true)
      expect(message.text).not.toMatch(/Morgan Rivers|PT-4471|abdominal ultrasound|No acute abnormality|Normal seeded study/i)
    }
  })

  test('acceptance: anonymousRecipientGetsExactlyTheSharedImageOrReportAndNoNavigation', async ({ request, browser }) => {
    const [imageShare, reportShare] = await createImageAndReportShares(request)
    const { context, page } = await anonymousPage(browser)
    try {
      await page.goto(new URL(imageShare.url).pathname)
      await expect(page.getByTestId('image-viewer')).toBeVisible()
      await expect(page.getByTestId('image-filmstrip')).toHaveCount(0)
      await expect(page.getByTestId('report-view')).toHaveCount(0)
      await expect(page.locator('a, nav')).toHaveCount(0)

      await page.goto(new URL(reportShare.url).pathname)
      await expect(page.getByTestId('report-view')).toBeVisible()
      await expect(page.getByTestId('report-findings')).toContainText('No acute abnormality.')
      await expect(page.getByTestId('image-viewer')).toHaveCount(0)
      await expect(page.locator('a, nav')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Share|Print/ })).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('acceptance: expiredAndRevokedLinksAreIdenticallyUnavailableAndNeverRevealContent', async ({ request, browser }) => {
    const [imageShare, reportShare] = await createImageAndReportShares(request)
    const revokedRecipient = await anonymousPage(browser)
    const expiredRecipient = await anonymousPage(browser)
    try {
      await revokedRecipient.page.goto(new URL(imageShare.url).pathname)
      await expect(revokedRecipient.page.getByTestId('image-viewer')).toBeVisible()
      expect((await request.delete(`/api/shares/${imageShare.id}`)).status()).toBe(204)
      await revokedRecipient.page.reload()
      const revoked = await unavailableText(revokedRecipient.page)

      await expiredRecipient.page.goto(new URL(reportShare.url).pathname)
      await expect(expiredRecipient.page.getByTestId('report-view')).toBeVisible()
      expect((await request.post(`${await fakeServerUrl()}/__test__/expire-share`, {
        data: { shareId: reportShare.id },
      })).status()).toBe(200)
      await expiredRecipient.page.reload()
      expect(await unavailableText(expiredRecipient.page)).toBe(revoked)
    } finally {
      await revokedRecipient.context.close()
      await expiredRecipient.context.close()
    }
  })

  test('acceptance: shareCreateAndShareUseAuditsIdentifyRecipientByShareLinkId', async ({ request, browser, playwright }) => {
    const [imageShare, reportShare] = await createImageAndReportShares(request)
    for (const share of [imageShare, reportShare]) {
      const recipient = await anonymousPage(browser)
      await recipient.page.goto(new URL(share.url).pathname)
      await expect(recipient.page.getByTestId('shared-resource')).toBeVisible()
      await recipient.context.close()
    }

    const admin = await playwright.request.newContext({ baseURL: `http://localhost:${config.port}` })
    try {
      await seedAndSignInAdmin(admin)
      const created = await auditEvents(admin, 'share.create')
      const used = await auditEvents(admin, 'share.use')
      expect(created.filter((event) => event.outcome === 'granted')).toHaveLength(2)
      expect(new Set(used.filter((event) => event.outcome === 'granted').map((event) => event.actorRef)))
        .toEqual(new Set([imageShare.id, reportShare.id]))
    } finally {
      await admin.dispose()
    }
  })
})

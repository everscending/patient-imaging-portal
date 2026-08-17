import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const UNAVAILABLE_COPY = 'This link is no longer available. Secure links expire and can be revoked by the person who shared them. Ask them to send a new one.'
const PASSWORD = 'CorrectHorseBattery9'
const IMAGE = {
  id: '10000000-0000-4000-8000-000000000001', width: 1024, height: 768, ordinal: 1,
  url: '/fixture/full.png', thumbUrl: '/fixture/thumb.png', expiresAt: '2099-01-01T00:00:00.000Z',
}
const REPORT = {
  id: 'bb88bb88-bb88-4b22-8000-bb88bb88bb88', studyId: '99669966-9966-4966-8966-996699669966',
  studyDescription: 'Shared ultrasound', patientRef: 'PT-4471', findings: 'No acute abnormality.',
  impression: 'Normal seeded study.', signedByName: 'Dr. Avery Chen', signedAt: '2026-08-12T16:00:00.000Z',
}
const AUTHORIZED_TICKET_FILES = new Set([
  'app/api/s/[token]/route.ts',
  'app/s/[token]/page.tsx',
  'components/share/SharedResource.tsx',
  'e2e/e2-wiring.spec.ts',
  'e2e/fixtures/fake-auth-server.ts',
  'e2e/image-viewer.spec.ts',
  'e2e/reports.spec.ts',
  'e2e/share-recipient.spec.ts',
  'lib/reports/ReportView.tsx',
  'next.config.ts',
  'tests/e2e/imaging-reports-fixture.test.ts',
])
let identityFixtureLockToken: string | undefined

async function source(file: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, file), 'utf8')
}

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  expect(response.ok()).toBe(true)
}

async function registerAndLink(request: APIRequestContext): Promise<void> {
  const email = `jor-239-${randomUUID()}@example.com`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect(
    (
      await request.post('/api/identity/verify', {
        data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
      })
    ).status(),
  ).toBe(200)
}

async function stubShareApi(page: Page, token: string, body: unknown): Promise<{ revoke: () => void }> {
  let revoked = false
  await page.route(`**/api/s/${token}`, async (route) => {
    if (revoked) {
      await route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'share_unavailable', message: 'This link is no longer available.' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return { revoke: () => { revoked = true } }
}

async function unavailableText(page: Page): Promise<string> {
  const screen = page.getByTestId('share-unavailable')
  await expect(screen).toBeVisible()
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Link unavailable')
  await expect(screen.getByText(UNAVAILABLE_COPY, { exact: true })).toBeVisible()
  return screen.innerText()
}

test.describe.serial('JOR-239 shared recipient', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetIdentity(request))

  test('activeImageRendersOneSharedViewerWithoutSiblingNavigationOrExtraResourceFetches', async ({ page }) => {
    const token = `fresh-image-${randomUUID()}`
    await stubShareApi(page, token, { resourceKind: 'image', payload: IMAGE, expiresAt: '2099-01-01T00:00:00.000Z' })
    const apiRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/')) apiRequests.push(new URL(request.url()).pathname)
    })

    await page.goto(`/s/${token}`)
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    await expect(page.getByTestId('image-filmstrip')).toHaveCount(0)
    await expect(page.locator('a')).toHaveCount(0)
    await expect(page.getByTestId('share-create')).toHaveCount(0)
    await page.getByTestId('zoom-in').click()
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 125%')
    await page.getByTestId('image-canvas').focus()
    await page.keyboard.press('ArrowRight')
    await page.setViewportSize({ width: 390, height: 844 })
    for (const control of await page.locator('[data-testid="image-zoom"] button').all()) {
      const box = await control.boundingBox()
      expect(box?.width).toBeGreaterThanOrEqual(44)
      expect(box?.height).toBeGreaterThanOrEqual(44)
    }
    expect(apiRequests).toEqual([`/api/s/${token}`])
  })

  test('activeReportRendersSharedReportWithoutShareOrPrint', async ({ page }) => {
    const token = `fresh-report-${randomUUID()}`
    await stubShareApi(page, token, { resourceKind: 'report', payload: REPORT, expiresAt: '2099-01-01T00:00:00.000Z' })

    await page.goto(`/s/${token}`)
    await expect(page.getByTestId('report-view')).toBeVisible()
    await expect(page.getByTestId('report-findings')).toContainText(REPORT.findings)
    await expect(page.getByTestId('report-impression')).toContainText(REPORT.impression)
    await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Print' })).toHaveCount(0)
    await expect(page.locator('a')).toHaveCount(0)
  })

  test('expiredContentLeakageAndUnknownTokensRenderIdenticalUnavailableScreen', async ({ page }) => {
    const expired = `expired-${randomUUID()}`
    const unknown = `unknown-${randomUUID()}`
    await page.route(`**/api/s/${expired}`, (route) => route.fulfill({ status: 410, body: JSON.stringify({ error: 'share_unavailable', message: 'This link is no longer available.' }) }))
    await page.route(`**/api/s/${unknown}`, (route) => route.fulfill({ status: 410, body: JSON.stringify({ error: 'share_unavailable', message: 'This link is no longer available.' }) }))

    await page.goto(`/s/${expired}`)
    const expiredScreen = await unavailableText(page)
    await expect(page.getByTestId('image-viewer')).toHaveCount(0)
    await expect(page.getByTestId('report-view')).toHaveCount(0)
    await page.goto(`/s/${unknown}`)
    expect(await unavailableText(page)).toBe(expiredScreen)
  })

  test('mintedLinkOpensAnonymouslyThenRevocationMatchesUnknownWithoutApiMocks', async ({ browser, page }) => {
    await registerAndLink(page.request)
    const created = await page.request.post('/api/shares', {
      data: { resourceKind: 'image', resourceId: IMAGE.id, recipientEmail: 'recipient@example.test' },
    })
    expect(created.status()).toBe(201)
    const share = (await created.json()) as { id: string; url: string }
    expect(share.id).toEqual(expect.any(String))
    const sharePath = new URL(share.url).pathname

    const recipientContext = await browser.newContext()
    const recipient = await recipientContext.newPage()
    try {
      await recipient.goto(sharePath)
      await expect(recipient.getByTestId('image-viewer')).toBeVisible()

      expect((await page.request.delete(`/api/shares/${share.id}`)).status()).toBe(204)
      await recipient.reload()
      const revokedScreen = await unavailableText(recipient)
      await expect(recipient.getByTestId('image-viewer')).toHaveCount(0)

      await recipient.goto(`/s/${randomUUID()}`)
      expect(await unavailableText(recipient)).toBe(revokedScreen)
    } finally {
      await recipientContext.close()
    }
  })

  test('noindexNoStoreAndNoPhiOrRawTokenLeakageArePinned', async ({ page }) => {
    const token = `raw-token-${randomUUID()}`
    await stubShareApi(page, token, { resourceKind: 'report', payload: REPORT, expiresAt: '2099-01-01T00:00:00.000Z' })
    const response = await page.goto(`/s/${token}`)
    expect(response?.headers()['cache-control']).toContain('no-store')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
    const visible = await page.locator('body').innerText()
    expect(visible).not.toContain(token)
    expect(visible).not.toContain('Morgan Rivers')
    expect(visible).not.toContain('1988-03-14')
    expect(await page.locator('a[href*="/s/"]').count()).toBe(0)

    const [pageSource, sharedSource, apiSource, configSource] = await Promise.all([
      source('app/s/[token]/page.tsx'), source('components/share/SharedResource.tsx'), source('app/api/s/[token]/route.ts'), source('next.config.ts'),
    ])
    expect(pageSource).toContain('index: false')
    expect(sharedSource).toContain("variant=\"shared\"")
    expect(sharedSource).toContain('images={[share.payload]}')
    expect(sharedSource).not.toMatch(/href=|<a\\b|<nav\\b|PatientShell|ProviderShell/)
    expect(apiSource).toContain("'Cache-Control': 'no-store")
    expect(configSource).toContain("source: '/s/:token'")
    expect(configSource).toContain('no-store')
    const mergeBase = execFileSync('git', ['merge-base', 'origin/main', 'HEAD']).toString().trim()
    const changedFiles = execFileSync('git', ['diff', '--name-only', mergeBase])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(changedFiles.filter((file) => !AUTHORIZED_TICKET_FILES.has(file))).toEqual([])
  })
})

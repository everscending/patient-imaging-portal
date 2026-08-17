import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const UNAVAILABLE_COPY = 'This link is no longer available. Secure links expire and can be revoked by the person who shared them. Ask them to send a new one.'
const IMAGE = {
  id: '10000000-0000-4000-8000-000000000001', width: 1024, height: 768, ordinal: 1,
  url: '/fixture/full.png', thumbUrl: '/fixture/thumb.png', expiresAt: '2099-01-01T00:00:00.000Z',
}
const REPORT = {
  id: 'bb88bb88-bb88-4b22-8000-bb88bb88bb88', studyId: '99669966-9966-4966-8966-996699669966',
  studyDescription: 'Shared ultrasound', patientRef: 'PT-4471', findings: 'No acute abnormality.',
  impression: 'Normal seeded study.', signedByName: 'Dr. Avery Chen', signedAt: '2026-08-12T16:00:00.000Z',
}

async function source(file: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, file), 'utf8')
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

test.describe('JOR-239 shared recipient', () => {
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

  test('revokedLinkInvalidatesCachedRecipientContentAndMatchesUnknownScreen', async ({ page }) => {
    const token = `fresh-revocable-${randomUUID()}`
    const unknown = `unknown-${randomUUID()}`
    const share = await stubShareApi(page, token, { resourceKind: 'image', payload: IMAGE, expiresAt: '2099-01-01T00:00:00.000Z' })
    await page.route(`**/api/s/${unknown}`, (route) => route.fulfill({ status: 410, body: JSON.stringify({ error: 'share_unavailable', message: 'This link is no longer available.' }) }))

    // The recipient starts without a session. A patient-side revoke changes the
    // token endpoint before the recipient reopens the same URL.
    await page.goto(`/s/${token}`)
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    share.revoke()
    await page.reload()
    const revokedScreen = await unavailableText(page)
    await expect(page.getByTestId('image-viewer')).toHaveCount(0)
    await page.goto(`/s/${unknown}`)
    expect(await unavailableText(page)).toBe(revokedScreen)
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
    const changedFiles = execFileSync('git', ['diff', '--name-only', 'HEAD']).toString()
    expect(changedFiles).not.toContain('lib/reports/ReportView.tsx')
    expect(changedFiles).not.toContain('components/imaging/ImageViewer.tsx')
  })
})

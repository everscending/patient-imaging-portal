import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

import { config } from '../lib/config'
import { E2_FOREIGN_SHARE_ID, E2_SEEDED_REPORT_ID, E2_SEEDED_STUDY_ID } from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'
let identityFixtureLockToken: string | undefined

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  expect(response.ok()).toBe(true)
}

async function registerAndLink(page: import('@playwright/test').Page): Promise<void> {
  const email = `jor-236-${randomUUID()}@example.com`
  expect((await page.request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await page.request.post('/api/identity/verify', { data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' } })).status()).toBe(200)
}

function share(id: string, state: 'active' | 'expired' | 'revoked') {
  return {
    id,
    resourceKind: 'report' as const,
    resourceId: E2_SEEDED_REPORT_ID,
    recipientEmail: `${id}@example.com`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: state === 'revoked' ? new Date().toISOString() : null,
    state,
  }
}

test.describe.serial('JOR-236 sharing', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetIdentity(request))

  test('imageAndReportExposeOneShareCreateControl', async ({ page }) => {
    await registerAndLink(page)
    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`)
    await expect(page.getByTestId('share-create')).toHaveCount(1)
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await expect(page.getByTestId('share-create')).toHaveCount(1)
  })

  test('reportDialogRendersConfiguredTtl', async ({ page }) => {
    await registerAndLink(page)
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await page.getByTestId('share-create').click()
    await expect(page.getByRole('dialog', { name: 'Share secure link' })).toContainText(
      `expires after ${config.shareLinkTtlHours} hours`,
    )
  })

  test('malformedEmailSurfaces422WithoutLink', async ({ page }) => {
    await registerAndLink(page)
    let posted = false
    await page.route('**/api/shares', async (route) => {
      posted = true
      await route.fulfill({ status: 422, contentType: 'application/json', body: '{"message":"Enter a valid recipient email address."}' })
    })
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await page.getByTestId('share-create').click()
    const recipientEmail = page.getByLabel('Recipient email')
    await recipientEmail.fill('not-an-email')
    await page.getByRole('button', { name: 'Send secure link' }).click()
    await expect(recipientEmail).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByText('Enter a valid recipient email address.', { exact: true })).toBeVisible()
    expect(posted).toBe(true)
    await expect(page.getByText('/s/', { exact: false })).toHaveCount(0)
  })

  test('createPostsPinnedPayloadAnd201DoesNotExposeRawToken', async ({ page }) => {
    await registerAndLink(page)
    let payload: unknown
    await page.route('**/api/shares', async (route) => {
      payload = route.request().postDataJSON()
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: randomUUID(), expiresAt: new Date().toISOString(), recipientEmail: 'recipient@example.com' }) })
    })
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await page.getByTestId('share-create').click()
    await page.getByLabel('Recipient email').fill('recipient@example.com')
    await page.getByRole('button', { name: 'Send secure link' }).click()
    await expect(page.getByText('Your secure link was sent to recipient@example.com.')).toBeVisible()
    expect(payload).toEqual({ resourceKind: 'report', resourceId: E2_SEEDED_REPORT_ID, recipientEmail: 'recipient@example.com' })
    await expect(page.getByText('raw-share-token')).toHaveCount(0)
  })

  test('failedDeliveryStatesActiveLinkAndProvidesCopyableUrl', async ({ page }) => {
    await registerAndLink(page)
    await page.route('**/api/shares', (route) => route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: randomUUID(), expiresAt: new Date().toISOString(), recipientEmail: 'recipient@example.com', delivery: 'failed', url: 'https://portal.example/s/copyable-link' }),
    }))
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await page.getByTestId('share-create').click()
    await page.getByLabel('Recipient email').fill('recipient@example.com')
    await page.getByRole('button', { name: 'Send secure link' }).click()
    const dialog = page.getByRole('dialog', { name: 'Share secure link' })
    await expect(dialog.getByRole('alert')).toContainText('Delivery failed, but your secure link is active.')
    await expect(dialog.getByRole('textbox', { name: 'Active share link', exact: true })).toHaveValue('https://portal.example/s/copyable-link')
    await expect(dialog.getByRole('button', { name: 'Copy active share link', exact: true })).toBeVisible()
  })

  test('cineHasNoShareControl', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'app/(patient)/studies/[studyId]/clips/[clipId]/page.tsx'), 'utf8')
    expect(source).not.toMatch(/share-create|ShareDialog|\bShare\b/)
  })

  test('sharesNeverRendersRawTokenAndUsesRevokeNotCancelOrDelete', async ({ page }) => {
    await registerAndLink(page)
    await page.route('**/api/shares', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ shares: [share('active', 'active')] }) }))
    await page.goto('/shares')
    await expect(page.getByTestId('share-list')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('raw-share-token')
    await expect(page.getByRole('button', { name: /Revoke link shared with active@example.com/ })).toBeVisible()
    const source = await readFile(path.join(REPO_ROOT, 'app/(patient)/shares/page.tsx'), 'utf8')
    expect(source).not.toMatch(/\b(Cancel|Delete)\b/)
  })

  test('configuredTtlNeverLiteralizes48', async () => {
    const sources = await Promise.all([
      'components/share/ShareDialog.tsx',
      'lib/reports/ReportView.tsx',
      'app/(patient)/reports/[reportId]/page.tsx',
    ].map((file) => readFile(path.join(REPO_ROOT, file), 'utf8')))
    expect(sources.every((source) => source.includes('shareLinkTtlHours'))).toBe(true)
    expect(sources.join('\n')).not.toContain('48')
  })

  test('shareSurfacesContainNoHexColorLiterals', async () => {
    for (const file of ['components/share/ShareDialog.tsx', 'app/(patient)/shares/page.tsx', 'components/imaging/ImageViewer.tsx']) {
      const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
      expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  })

  test('zeroSharesShowsEmptyState', async ({ page }) => {
    await registerAndLink(page)
    await page.route('**/api/shares', (route) => route.fulfill({ contentType: 'application/json', body: '{"shares":[]}' }))
    await page.goto('/shares')
    await expect(page.getByTestId('share-empty')).toHaveText("You haven't shared anything yet — sharing an image or a report creates a link here.")
    const list = page.getByRole('list', { name: 'Secure share links' })
    await expect(list).toHaveCount(1)
    await expect(list.getByRole('listitem')).toHaveCount(0)
    await expect(list).toHaveAttribute('aria-describedby', 'shares-empty-message')
  })

  test('crossPatientRevokeReturnsOpaque404AndOneDeniedAudit', async ({ page }) => {
    await registerAndLink(page)
    const response = await page.request.delete(`/api/shares/${E2_FOREIGN_SHARE_ID}`)
    expect(response.status()).toBe(404)
    expect(await response.json()).toEqual({
      error: 'not_found',
      message: 'The requested resource was not found.',
    })

    const state = await (await page.request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json() as {
      auditEvents: Array<Record<string, unknown>>
    }
    expect(state.auditEvents.filter((event) => event.action === 'share.revoke')).toEqual([
      expect.objectContaining({
        action: 'share.revoke',
        target_kind: 'share_link',
        target_id: E2_FOREIGN_SHARE_ID,
        outcome: 'denied',
        detail: null,
      }),
    ])
  })

  test('shareStatesUseTextAndActiveRevokeUpdatesWithoutReload', async ({ page }) => {
    await registerAndLink(page)
    await page.route('**/api/shares', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ shares: [share('active', 'active'), share('expired', 'expired'), share('revoked', 'revoked')] }) }))
    await page.route('**/api/shares/active', (route) => route.fulfill({ status: 204 }))
    await page.goto('/shares')
    await expect(page.getByText('Active', { exact: true })).toBeVisible()
    await expect(page.getByText('Expired', { exact: true })).toBeVisible()
    await expect(page.getByText('Revoked', { exact: true })).toBeVisible()
    await expect(page.getByText(/remaining/)).toBeVisible()
    await page.getByTestId('share-revoke').click()
    await expect(page.getByText('Revoked', { exact: true })).toHaveCount(2)
    await expect(page.getByTestId('share-revoke')).toHaveCount(0)
  })

  test('mobileSheetAndSharesControlsAreUsableAt390WithoutHorizontalScroll', async ({ page }) => {
    await registerAndLink(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**/api/shares', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ shares: [share('active', 'active')] }) }))
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await page.getByTestId('share-create').focus()
    await expect(page.getByTestId('share-create')).toBeFocused()
    await page.getByTestId('share-create').click()
    await expect(page.getByRole('dialog', { name: 'Share secure link' })).toHaveAttribute('data-presentation', 'sheet')
    for (const control of [page.getByLabel('Recipient email'), page.getByRole('button', { name: 'Send secure link' }), page.getByRole('button', { name: 'Close share dialog' })]) {
      const box = await control.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.getByRole('button', { name: 'Close share dialog' }).click()
    await page.goto('/shares')
    const revoke = page.getByTestId('share-revoke')
    const box = await revoke.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
})

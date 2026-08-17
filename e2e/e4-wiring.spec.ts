// JOR-233 — E4's live FR-7 confirmation against the committed seeded dataset.
// This signs into the running app and completes the real identity-verification
// flow.  It deliberately never uses a service-role client or edited fixture.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

import {
  E2_FOREIGN_REPORT_ID,
  E2_SEEDED_REPORT_ID,
  E4_PRELIMINARY_REPORT_ID,
} from './fixtures/fake-auth-server'
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

async function signInVerifiedSeededPatient(page: Page): Promise<void> {
  const email = `jor-233-${randomUUID()}@example.com`
  expect((await page.request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect(
    (
      await page.request.post('/api/identity/verify', {
        data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
      })
    ).status(),
  ).toBe(200)
}

test.describe('JOR-233 E4 signed-report wiring', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetIdentity(request))

  test('acceptance: verified patient sees their own signed reports and no others', async function verifiedPatientSeesOnlyOwnSignedReports({ page }) {
    await signInVerifiedSeededPatient(page)
    await page.goto('/reports')

    const signedReports = page.getByRole('list', { name: 'Signed reports' })
    await expect(signedReports).toContainText('Seeded abdominal ultrasound')
    await expect(signedReports).not.toContainText('Other patient study')
    await expect(signedReports.locator(`a[href="/reports/${E2_FOREIGN_REPORT_ID}"]`)).toHaveCount(0)
  })

  test('acceptance: preliminary report is omitted and its direct URL is not found', async function preliminaryReportUrlAnswersNotFound({ page }) {
    await signInVerifiedSeededPatient(page)
    await page.goto('/reports')

    const signedReports = page.getByRole('list', { name: 'Signed reports' })
    await expect(signedReports).not.toContainText('Cancelled seeded follow-up ultrasound')
    await expect(signedReports.locator(`a[href="/reports/${E4_PRELIMINARY_REPORT_ID}"]`)).toHaveCount(0)

    const response = await page.goto(`/reports/${E4_PRELIMINARY_REPORT_ID}`)
    expect(response?.status()).not.toBe(403)
    await expect(page.getByText('404', { exact: true })).toBeVisible()
    await expect(page.getByTestId('report-view')).toHaveCount(0)
  })

  test('acceptance: signed report renders findings, impression, signing provider, and signing time', async function reportScreenIncludesFindingsAndImpression({ page }) {
    await signInVerifiedSeededPatient(page)
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)

    await expect(page.getByTestId('report-findings')).toContainText('No acute abnormality.')
    await expect(page.getByTestId('report-impression')).toContainText('Normal seeded study.')
    await expect(page.getByText('Signing provider', { exact: true })).toBeVisible()
    await expect(page.getByText('Dr. Avery Chen', { exact: true })).toBeVisible()
    await expect(page.getByText('Signed', { exact: true })).toBeVisible()
    await expect(page.getByText(/Aug 12, 2026/)).toBeVisible()
  })

  test('acceptance: report reads cleanly at phone width', async function reportScreenAt390pxHasNoHorizontalPageBodyScroll({ page }) {
    await signInVerifiedSeededPatient(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)

    await expect(page.getByTestId('report-view')).toBeVisible()
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
})

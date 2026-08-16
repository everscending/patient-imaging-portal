// JOR-218 — reports UI acceptance and adversarial checks.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

import { E2_SEEDED_REPORT_ID } from './fixtures/fake-auth-server'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'

async function registerAndLink(page: import('@playwright/test').Page): Promise<void> {
  const email = `jor-218-${randomUUID()}@example.com`
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

test.describe('JOR-218 reports', () => {
  test('preliminaryReportDirectUrlRendersNotFound', async ({ page }) => {
    await registerAndLink(page)
    await page.route('**/api/reports/**', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' })
    })
    await page.goto('/reports/00000000-0000-4000-8000-000000000001')
    await expect(page.getByText('404')).toBeVisible()
    await expect(page.getByTestId('report-view')).toHaveCount(0)
  })

  test('oneRendererEnforcementIsPinned', async () => {
    const rendererPath = path.join(REPO_ROOT, 'lib/reports/ReportView.tsx')
    const source = await readFile(rendererPath, 'utf8')
    const matchingFiles = execFileSync('rg', [
      '--files-with-matches',
      '--glob',
      '*.{ts,tsx}',
      'function\\s+\\w*ReportView|const\\s+\\w*ReportView',
      path.join(REPO_ROOT, 'lib'),
      path.join(REPO_ROOT, 'app'),
      path.join(REPO_ROOT, 'components'),
    ])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(matchingFiles).toEqual([rendererPath])
    expect(source).toMatch(/export type ReportViewProps = \{[\s\S]*id: string[\s\S]*studyId: string[\s\S]*studyDescription: string[\s\S]*patientRef: string[\s\S]*findings: string[\s\S]*impression: string[\s\S]*signedByName: string \| null[\s\S]*signedAt: string \| null[\s\S]*variant: 'portal' \| 'shared'/)
  })

  test('reportRendererHasNoHexColoursOrUnsafeHtml', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'lib/reports/ReportView.tsx'), 'utf8')
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(source).not.toContain('dangerouslySetInnerHTML')
  })

  test('emptyReportListRendersPinnedEmptyState', async ({ page }) => {
    await registerAndLink(page)
    await page.route('**/api/reports', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: '{"reports":[]}' })
    })
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toHaveCount(1)
    await expect(page.getByTestId('reports-empty')).toHaveText(
      'No reports yet — a report appears here once your clinician has signed it.',
    )
  })

  test('reportLayoutAt390pxHasNoHorizontalPageScroll', async ({ page }) => {
    await registerAndLink(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await expect(page.getByTestId('report-view')).toBeVisible()
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Print' })).toBeHidden()
  })

  test('reportNeverLeaksPatientIdentity', async ({ page }) => {
    await registerAndLink(page)
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await expect(page.getByTestId('report-view')).toBeVisible()
    const reportText = await page.getByTestId('report-view').innerText()
    expect(reportText).not.toContain('Morgan Rivers')
    expect(reportText).not.toContain('1988-03-14')
    await expect(page.getByTestId('report-findings')).toContainText('No acute abnormality.')
    await expect(page.getByTestId('report-impression')).toContainText('Normal seeded study.')
  })

  test('reportUsesOneH1StructuredHeadingsAndKeyboardActions', async ({ page }) => {
    await registerAndLink(page)
    await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Report' })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 2, name: 'Findings' })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 2, name: 'Impression' })).toHaveCount(1)
    await page.getByRole('link', { name: 'Share' }).focus()
    await expect(page.getByRole('link', { name: 'Share' })).toBeFocused()
    await page.getByRole('button', { name: 'Print' }).focus()
    await expect(page.getByRole('button', { name: 'Print' })).toBeFocused()
  })

  test('sharedVariantOmitsNavigationShareAndPrint', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'lib/reports/ReportView.tsx'), 'utf8')
    const portalActionStart = source.indexOf("{variant === 'portal' ? (")
    const portalActionEnd = source.indexOf(') : null}', portalActionStart)
    expect(portalActionStart).toBeGreaterThan(-1)
    expect(portalActionEnd).toBeGreaterThan(portalActionStart)
    const beforeActions = source.slice(0, portalActionStart)
    const portalActions = source.slice(portalActionStart, portalActionEnd)
    expect(beforeActions).not.toMatch(/PatientShell|patient-sidebar|patient-tabbar|Share|Print/)
    expect(portalActions).toContain('Share')
    expect(portalActions).toContain('Print')
  })
})

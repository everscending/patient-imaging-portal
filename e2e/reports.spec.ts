// JOR-218 — reports UI acceptance and adversarial checks.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

import { E2_SEEDED_REPORT_ID } from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'
const REPORT_VIEW_DECLARATION = /function\s+\w*ReportView|const\s+\w*ReportView/
let identityFixtureLockToken: string | undefined

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  expect(response.ok()).toBe(true)
}

async function filesWithReportViewDeclaration(directory: string): Promise<string[]> {
  const matches: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      matches.push(...(await filesWithReportViewDeclaration(entryPath)))
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      if (REPORT_VIEW_DECLARATION.test(await readFile(entryPath, 'utf8'))) matches.push(entryPath)
    }
  }

  return matches
}

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

test.describe.serial('JOR-218 reports', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetIdentity(request))

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
    const matchingFiles = (
      await Promise.all(
        ['lib', 'app', 'components'].map((root) => filesWithReportViewDeclaration(path.join(REPO_ROOT, root))),
      )
    )
      .flat()
      .sort()
    expect(matchingFiles).toEqual([rendererPath])
    expect(source).toMatch(/type ReportViewBaseProps = \{\s*report: \{\s*id: string\s*studyId: string\s*studyDescription: string\s*patientRef: string\s*findings: string\s*impression: string\s*signedByName: string\s*signedAt: string\s*\}\s*\}/)
    expect(source).toMatch(/export type ReportViewProps = ReportViewBaseProps & \(\s*\| \{ variant: 'portal'; shareLinkTtlHours: number \}\s*\| \{ variant: 'shared'; shareLinkTtlHours\?: never \}\s*\)/)
  })

  test('reportPathHasNoHexColourLiterals', async () => {
    const sources = await Promise.all([
      readFile(path.join(REPO_ROOT, 'lib/reports/ReportView.tsx'), 'utf8'),
      readFile(path.join(REPO_ROOT, 'app/(patient)/reports/page.tsx'), 'utf8'),
      readFile(path.join(REPO_ROOT, 'app/(patient)/reports/[reportId]/page.tsx'), 'utf8'),
    ])
    expect(sources.join('\n')).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  test('reportPathNeverUsesDangerouslySetInnerHTML', async () => {
    const sources = await Promise.all([
      readFile(path.join(REPO_ROOT, 'lib/reports/ReportView.tsx'), 'utf8'),
      readFile(path.join(REPO_ROOT, 'app/(patient)/reports/page.tsx'), 'utf8'),
      readFile(path.join(REPO_ROOT, 'app/(patient)/reports/[reportId]/page.tsx'), 'utf8'),
    ])
    expect(sources.join('\n')).not.toContain('dangerouslySetInnerHTML')
  })

  test('portalVariantRendersLandedShareDialog', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'lib/reports/ReportView.tsx'), 'utf8')
    expect(source).toContain("import { ShareDialog } from '../../components/share/ShareDialog'")
    expect(source).toMatch(/variant === 'portal'[\s\S]*<ShareDialog[\s\S]*resourceKind="report"[\s\S]*resourceId=\{report\.id\}/)
    expect(source).toContain('shareLinkTtlHours={props.shareLinkTtlHours}')
    expect(source).not.toContain('/shares?reportId=')
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
    const screenSources = await Promise.all([
      readFile(path.join(REPO_ROOT, 'app/(patient)/reports/page.tsx'), 'utf8'),
      readFile(path.join(REPO_ROOT, 'app/(patient)/reports/[reportId]/page.tsx'), 'utf8'),
    ])
    expect(screenSources.join('\n')).not.toMatch(/fullName|full_name|dateOfBirth|date_of_birth/)

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
    await page.getByRole('button', { name: 'Share' }).focus()
    await expect(page.getByRole('button', { name: 'Share' })).toBeFocused()
    await page.getByRole('button', { name: 'Share' }).click()
    await expect(page.getByRole('dialog', { name: 'Share secure link' })).toBeVisible()
    await page.getByRole('button', { name: 'Print' }).focus()
    await expect(page.getByRole('button', { name: 'Print' })).toBeFocused()
  })

  test('sharedVariantOmitsNavigationShareAndPrint', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'lib/reports/ReportView.tsx'), 'utf8')
    const returnedJsx = source.slice(source.indexOf('  return ('))
    const portalBranch = returnedJsx.match(/\{variant === 'portal' \? \([\s\S]*?\) : null\}/)?.[0]
    expect(portalBranch).toBeDefined()
    expect(portalBranch).toContain('<ShareDialog')
    expect(portalBranch).toContain('>\n            Print\n          </button>')
    const sharedSurface = returnedJsx.replace(portalBranch ?? '', '')
    expect(sharedSurface).not.toMatch(/<nav|PatientShell|patient-sidebar|patient-tabbar|<ShareDialog|share-create|>\s*Print\s*</)
  })
})

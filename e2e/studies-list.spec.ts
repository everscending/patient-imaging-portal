import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'

const completedStudies = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    description: 'Left knee MRI',
    occurredAt: '2026-08-12',
    providerName: 'Dr. Ada Lovelace',
    imageCount: 12,
    clipCount: 2,
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    description: 'Shoulder ultrasound',
    occurredAt: '2026-08-10',
    providerName: 'Dr. Grace Hopper',
    imageCount: 1,
    clipCount: 0,
  },
]

async function fakeAuthServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function linkedSession(page: Page): Promise<void> {
  const email = `studies-${Date.now()}-${Math.random()}@example.test`
  await page.request.post('/api/auth/register', { data: { email, password: PASSWORD } })
  await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } })
  const token = (await page.context().cookies()).find((cookie) => cookie.name === 'pip_session')?.value
  expect(token).toBeTruthy()
  await page.request.put(`${await fakeAuthServerUrl()}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { data: { patient_id: '44714471-4471-4471-8471-447144714471' } },
  })
}

async function showStudies(page: Page, body: unknown): Promise<void> {
  await linkedSession(page)
  await page.route('**/api/studies', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/studies')
}

test('acceptance: completedVisitCards_matchSeededData_andScheduledCancelledNeverAppear', async ({ page }) => {
  await showStudies(page, { studies: completedStudies })
  await expect(page.getByTestId('study-list')).toBeVisible()
  await expect(page.getByTestId('study-card')).toHaveCount(2)
  for (const study of completedStudies) {
    await expect(page.getByRole('link', { name: new RegExp(study.description) })).toContainText(study.description)
    await expect(page.getByText(study.providerName, { exact: true })).toBeVisible()
  }
  await expect(page.getByText(/scheduled|cancelled/i)).toHaveCount(0)
})

test('acceptance: zeroCompletedVisits_showsExactEmptyState', async ({ page }) => {
  await showStudies(page, { studies: [] })
  await expect(
    page.getByText('No images yet — images appear here once a completed visit has been processed by the clinic.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('study-list')).toHaveCount(0)
})

test('acceptance: studyCard_keyboardActivationNavigates', async ({ page }) => {
  await showStudies(page, { studies: completedStudies })
  const card = page.getByTestId('study-card').first()
  await card.focus()
  await expect(card).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`/studies/${completedStudies[0].id}`)
})

test('acceptance: studies_mobileLayoutHasNoBodyOverflowAnd44pxCards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await showStudies(page, { studies: completedStudies })
  const card = page.getByTestId('study-card').first()
  const box = await card.boundingBox()
  expect(box?.height).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('mandatory adversarial: studies_slowResponse_keepsLabelledLoadingState', async ({ page }) => {
  await linkedSession(page)
  let releaseResponse: (() => void) | undefined
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  await page.route('**/api/studies', async (route) => {
    await responseReleased
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ studies: completedStudies }) })
  })
  await page.goto('/studies')

  await expect(page.getByRole('status', { name: 'Loading imaging studies' })).toBeVisible()
  expect(releaseResponse).toBeDefined()
  releaseResponse!()
  await expect(page.getByTestId('study-list')).toBeVisible()
})

test('mandatory adversarial: studies_malformedResponse_degradesWithoutStackTraceOrDatabaseString', async ({ page }) => {
  await showStudies(page, { studies: [{ description: 'missing required fields' }] })
  await expect(page.getByTestId('studies-degraded')).toHaveText('Images are temporarily unavailable. Please try again.')
  const body = await page.locator('body').innerText()
  expect(body).not.toMatch(/at .*\(.*:\d+:\d+\)|postgres|database|ECONNREFUSED/i)
})

test('mandatory adversarial: studies_pageDoesNotClientFilterVisitStatus', async () => {
  const source = await readFile(path.join(REPO_ROOT, 'app/(patient)/studies/page.tsx'), 'utf8')
  expect(source).not.toMatch(/(?:study|visit)\s*\.\s*status|status\s*===|status\s*!==/)
  expect(source).not.toMatch(/\.filter\s*\(/)
})

test('mandatory adversarial: studies_unlinkedStateDoesNotRenderStudyPhi', async ({ page }) => {
  await page.goto('/studies')
  await expect(page).toHaveURL(/\/verify\?next=%2Fstudies$/)
  const body = await page.locator('body').innerText()
  for (const study of completedStudies) {
    expect(body).not.toContain(study.description)
    expect(body).not.toContain(study.providerName)
  }
})

test('mandatory adversarial: studies_surfaceHasNoHardcodedHex', async () => {
  for (const file of ['app/(patient)/studies/page.tsx', 'components/imaging/StudyCard.tsx']) {
    expect(await readFile(path.join(REPO_ROOT, file), 'utf8')).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  }
})

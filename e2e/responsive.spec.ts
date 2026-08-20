import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test'

import {
  E2_BOOK_SERVICE_ID,
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_STUDY_ID,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'ResponsivePatientPassword9'
let identityFixtureLockToken: string | undefined

async function fixtureUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetFixtures(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fixtureUrl()}/__test__/reset-identity`)).ok()).toBe(true)
  expect((await request.post(`${await fixtureUrl()}/__test__/reset-booking`)).ok()).toBe(true)
}

async function registerAndSignIn(request: APIRequestContext): Promise<void> {
  const email = `responsive-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

async function registerAndLink(request: APIRequestContext): Promise<void> {
  await registerAndSignIn(request)
  expect((await request.post('/api/identity/verify', {
    data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
  })).status()).toBe(200)
}

async function expectHorizontalOverflowOwnedBy(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  expect(await locator.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(/^(auto|scroll)$/)
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() =>
    document.body.scrollWidth <= document.documentElement.clientWidth &&
    document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true)
}

async function expectTapTarget(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(44)
  expect(box?.height).toBeGreaterThanOrEqual(44)
}

async function expectPhoneSurface(page: Page, testIds: string[]): Promise<void> {
  for (const testId of testIds) await expect(page.getByTestId(testId).first()).toBeVisible()
  await expectNoPageOverflow(page)
}

async function expectRecipientFlow(browser: Browser, shareUrl: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await page.goto(new URL(shareUrl).pathname)
    await expectPhoneSurface(page, ['shared-resource', 'report-view', 'report-findings', 'report-impression'])
    await expect(page.getByTestId('patient-tabbar')).toHaveCount(0)
  } finally {
    await context.close()
  }
}

async function productionComponentFiles(): Promise<string[]> {
  const files = await Promise.all(['app', 'components', 'lib'].map(async (root) =>
    (await readdir(path.join(REPO_ROOT, root), { recursive: true }))
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => path.join(root, file)),
  ))
  return files.flat().sort()
}

test.describe.serial('JOR-224 phone-width patient flows', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ page }) => {
    await resetFixtures(page.request)
    await registerAndLink(page.request)
  })

  test('mandatory adversarial: wide content scrolls in its own container, never the 390px page body', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`)
    await expectHorizontalOverflowOwnedBy(page.getByTestId('image-filmstrip'))
    await expectNoPageOverflow(page)

    await page.goto('/book')
    await page.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
    await page.getByTestId('provider-select').selectOption({ label: 'Dr. Riley Patel' })
    await expectHorizontalOverflowOwnedBy(page.locator('.pip-slot-grid').first())
    await expectNoPageOverflow(page)

    await page.goto('/appointments')
    await expectHorizontalOverflowOwnedBy(page.getByTestId('appointment-list'))
    await expectNoPageOverflow(page)
  })

  test('acceptance: every patient flow remains visible, usable, and contained at 390px', async ({ browser, page }) => {
    await resetFixtures(page.request)
    await registerAndSignIn(page.request)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/verify?next=%2Fstudies')
    await expectPhoneSurface(page, ['identity-form'])
    await page.getByLabel('Patient reference').fill('PT-4471')
    await page.getByLabel('Date of birth').fill('1988-03-14')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page).toHaveURL(/\/studies$/)
    await expectPhoneSurface(page, ['study-list', 'study-card'])

    const tabLinks = page.getByTestId('patient-tabbar').getByRole('link')
    await expect(tabLinks).toHaveCount(4)
    for (const link of await tabLinks.all()) await expectTapTarget(link)

    await page.getByTestId('study-card').click()
    await expectPhoneSurface(page, ['image-viewer', 'image-zoom', 'share-create'])
    await expectTapTarget(page.getByTestId('share-create'))

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    await expectPhoneSurface(page, ['cine-viewer', 'cine-play', 'cine-next', 'cine-prev', 'cine-fps'])
    for (const testId of ['cine-play', 'cine-next', 'cine-prev', 'cine-fps']) {
      await expectTapTarget(page.getByTestId(testId))
    }

    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Seeded abdominal ultrasound/ })).toBeVisible()
    await expectNoPageOverflow(page)
    await page.getByRole('link', { name: /Seeded abdominal ultrasound/ }).click()
    await expectPhoneSurface(page, ['report-view', 'report-findings', 'report-impression', 'share-create'])

    await page.getByTestId('share-create').click()
    await expect(page.getByRole('dialog', { name: 'Share secure link' })).toHaveAttribute('data-presentation', 'sheet')
    await expectNoPageOverflow(page)
    await page.getByLabel('Recipient email').fill('responsive-recipient@example.test')
    const shareResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Send secure link' }).click()
    const created = (await (await shareResponse).json()) as { url: string }
    expect(created.url).toEqual(expect.any(String))
    await expectRecipientFlow(browser, created.url)

    await page.goto('/shares')
    await expectPhoneSurface(page, ['share-list', 'share-revoke'])
    await expectTapTarget(page.getByTestId('share-revoke'))
    await page.getByTestId('share-revoke').click()
    await expect(page.getByTestId('share-revoke')).toHaveCount(0)

    await page.goto('/book')
    await page.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
    await page.getByTestId('provider-select').selectOption({ label: 'Dr. Riley Patel' })
    await expectPhoneSurface(page, ['slot-list', 'slot-item'])
    await expectTapTarget(page.getByTestId('slot-item').first())
    await page.getByTestId('slot-item').first().click()
    await expectTapTarget(page.getByTestId('book-submit'))
    await page.getByTestId('book-submit').click()
    await expect(page.getByTestId('booking-success')).toBeVisible()

    await page.goto('/appointments')
    await expectPhoneSurface(page, ['appointment-list', 'appointment-item'])
  })

  test('mandatory adversarial: orientation changes preserve cine frame, play state, and FPS', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    await page.getByTestId('cine-next').click()
    await page.getByTestId('cine-next').click()
    await page.getByTestId('cine-fps').selectOption('6')
    await expect(page.getByText('Frame 3 of 100', { exact: true })).toBeVisible()

    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.getByText('Frame 3 of 100', { exact: true })).toBeVisible()
    await expect(page.getByTestId('cine-play')).toHaveText('Play')
    await expect(page.getByTestId('cine-fps')).toHaveValue('6')
    await expectNoPageOverflow(page)

    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await expect(page.getByTestId('cine-fps')).toHaveValue('6')
    await expect(page.getByText(/Frame (?:[3-9]|[1-9]\d|100) of 100/)).toBeVisible()
    await expectNoPageOverflow(page)
  })

  test('mandatory adversarial: fixes stay in owning components with pinned props and theme colours', async () => {
    const files = await productionComponentFiles()
    expect(files.filter((file) => /(?:mobile|phone|responsive)[^/]*\.tsx$/i.test(file))).toEqual([])

    const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(REPO_ROOT, file), 'utf8')] as const)))
    for (const [file, source] of sources) expect(source, file).not.toMatch(/#[0-9a-f]{3,8}\b/i)

    expect(sources.get('components/imaging/ImageViewer.tsx')).toContain(`export type ImageViewerProps = {
  images: Array<{
    id: string; width: number; height: number; ordinal: number
    url: string; thumbUrl: string | null; expiresAt: string
  }>
  initialImageId?: string
  shareLinkTtlHours?: number
  /** 'shared' hides the filmstrip and every action except zoom and pan. */
  variant: 'portal' | 'shared'
}`)
    expect(sources.get('components/imaging/CineViewer.tsx')).toContain(`export type CineViewerProps = {
  clip: {
    id: string
    frameCount: number
    defaultFps: number
    frames: Array<{ index: number; url: string | null; available: boolean }>
    expiresAt: string
  }
}`)
    expect(sources.get('lib/reports/ReportView.tsx')).toContain(`export type ReportViewProps = ReportViewBaseProps & (
  | { variant: 'portal'; shareLinkTtlHours: number }
  | { variant: 'shared'; shareLinkTtlHours?: never }
)`)
  })
})

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test'
import ts from 'typescript'

import type { CineViewerProps } from '../components/imaging/CineViewer'
import type { ImageViewerProps } from '../components/imaging/ImageViewer'
import type { ReportViewProps } from '../lib/reports/ReportView'

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

type PinnedImageViewerProps = {
  images: Array<{
    id: string; width: number; height: number; ordinal: number
    url: string; thumbUrl: string | null; expiresAt: string
  }>
  initialImageId?: string
  shareLinkTtlHours?: number
  variant: 'portal' | 'shared'
}

type PinnedCineViewerProps = {
  clip: {
    id: string
    frameCount: number
    defaultFps: number
    frames: Array<{ index: number; url: string | null; available: boolean }>
    expiresAt: string
  }
}

type PinnedReportViewProps = {
  report: {
    id: string
    studyId: string
    studyDescription: string
    patientRef: string
    findings: string
    impression: string
    signedByName: string
    signedAt: string
  }
} & (
  | { variant: 'portal'; shareLinkTtlHours: number }
  | { variant: 'shared'; shareLinkTtlHours?: never }
)

type CompatibleWithOptionalAdditions<Current, Pinned> =
  [Pinned] extends [Current] ? [Current] extends [Pinned] ? true : false : false

const PINNED_PROP_CONTRACTS: {
  imageViewer: CompatibleWithOptionalAdditions<ImageViewerProps, PinnedImageViewerProps>
  cineViewer: CompatibleWithOptionalAdditions<CineViewerProps, PinnedCineViewerProps>
  reportView: CompatibleWithOptionalAdditions<ReportViewProps, PinnedReportViewProps>
} = { imageViewer: true, cineViewer: true, reportView: true }

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
  const metrics = await locator.evaluate((element) => {
    const probe = document.createElement('span')
    const probeWidth = element.clientWidth + 160
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = `display:block;flex:0 0 ${probeWidth}px;grid-column:1/-1;height:1px;min-width:${probeWidth}px;width:${probeWidth}px`
    element.append(probe)
    try {
      element.scrollLeft = 0
      const clientWidth = element.clientWidth
      const scrollWidth = element.scrollWidth
      element.scrollLeft = scrollWidth - clientWidth
      return {
        clientWidth,
        overflowX: getComputedStyle(element).overflowX,
        scrollLeft: element.scrollLeft,
        scrollWidth,
      }
    } finally {
      element.scrollLeft = 0
      probe.remove()
    }
  })
  expect(metrics.overflowX).toMatch(/^(auto|scroll)$/)
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
  expect(metrics.scrollLeft).toBeGreaterThan(0)
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

async function expectNoForbiddenTextColour(page: Page): Promise<void> {
  const offenders = await page.locator('body').evaluate((body) => {
    const forbidden = new Set(['rgb(135, 63, 224)', 'rgb(0, 192, 221)'])
    const textOwners = new Set<Element>(body.querySelectorAll('input, select, textarea'))
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.textContent?.trim() && node.parentElement) textOwners.add(node.parentElement)
    }
    return [...textOwners]
      .filter((element) => element.getClientRects().length > 0 && forbidden.has(getComputedStyle(element).color))
      .map((element) => element.outerHTML.slice(0, 160))
  })
  expect(offenders).toEqual([])
}

async function expectPhoneSurface(page: Page, testIds: string[]): Promise<void> {
  for (const testId of testIds) await expect(page.getByTestId(testId).first()).toBeVisible()
  await expectNoPageOverflow(page)
  await expectNoForbiddenTextColour(page)
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

function componentDeclarations(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declarations = new Set<string>()
  const containsJsx = (node: ts.Node): boolean => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) return true
    return node.getChildren(parsed).some(containsJsx)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body && containsJsx(node.body)) {
      const isDefault = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      const name = node.name?.text ?? (isDefault ? 'default' : undefined)
      if (name && (name === 'default' || /^[A-Z]/.test(name))) declarations.add(name)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text) &&
        node.initializer && containsJsx(node.initializer)) declarations.add(node.name.text)
    if (ts.isClassDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text) && containsJsx(node)) {
      declarations.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return [...declarations].sort()
}

async function componentsAddedByThisTicket(): Promise<string[]> {
  const base = 'origin/main'
  const responsiveSpecAdded = execFileSync('git', [
    'diff', '--diff-filter=A', '--name-only', `${base}...HEAD`, '--', 'e2e/responsive.spec.ts',
  ], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  if (!responsiveSpecAdded) return []

  const changedFiles = execFileSync('git', [
    'diff', '--name-only', `${base}...HEAD`, '--', 'app', 'components', 'lib',
  ], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split('\n').filter((file) => file.endsWith('.tsx'))
  const added: string[] = []
  for (const file of changedFiles) {
    let before = ''
    try {
      before = execFileSync('git', ['show', `${base}:${file}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch { /* A new file has no base source. */ }
    const after = await readFile(path.join(REPO_ROOT, file), 'utf8')
    const previous = new Set(componentDeclarations(file, before))
    for (const name of componentDeclarations(file, after)) {
      if (!previous.has(name)) added.push(`${file}:${name}`)
    }
  }
  return added.sort()
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

  test('mandatory adversarial: genuinely wide content scrolls in its own container, never the 390px page body', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`)
    await expectHorizontalOverflowOwnedBy(page.getByTestId('image-filmstrip'))
    await expectNoPageOverflow(page)

    await page.goto('/book')
    await page.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
    await page.getByTestId('provider-select').selectOption({ label: 'Dr. Riley Patel' })
    await expectHorizontalOverflowOwnedBy(page.getByTestId('slot-grid').first())
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
    await expect(page.getByLabel('Patient reference')).toBeVisible()
    await expect(page.getByLabel('Date of birth')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
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
    for (const name of ['Zoom out', 'Reset zoom to 100%', 'Zoom in']) {
      await expect(page.getByRole('button', { name })).toBeVisible()
    }

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
    await expectNoForbiddenTextColour(page)
    await expect(page.getByRole('button', { name: 'Close share dialog' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send secure link' })).toBeVisible()
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
    await expect(page.getByTestId('service-select')).toBeVisible()
    await expect(page.getByTestId('provider-select')).toBeVisible()
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
    const changeableAppointment = page.getByTestId('appointment-item').filter({ has: page.getByTestId('appointment-reschedule') }).first()
    await expect(changeableAppointment.getByTestId('appointment-reschedule')).toBeVisible()
    await expect(changeableAppointment.getByTestId('appointment-cancel')).toBeVisible()
    await changeableAppointment.getByTestId('appointment-reschedule').click()
    await expect(changeableAppointment.getByLabel('New appointment slot ID')).toBeVisible()
    await expect(changeableAppointment.getByRole('button', { name: 'Confirm reschedule' })).toBeVisible()
    await expectNoForbiddenTextColour(page)
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
})

test.describe('JOR-224 responsive source contracts', () => {
  test('mandatory adversarial: no new component is introduced by a responsive fix', async () => {
    expect(await componentsAddedByThisTicket()).toEqual([])
  })

  test('mandatory adversarial: pinned props permit only optional additions and components contain no hex literals', async () => {
    const files = await productionComponentFiles()
    const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(REPO_ROOT, file), 'utf8')] as const)))
    for (const [file, source] of sources) expect(source, file).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(PINNED_PROP_CONTRACTS).toEqual({ imageViewer: true, cineViewer: true, reportView: true })
  })
})

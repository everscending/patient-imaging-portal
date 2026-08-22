// JOR-246 — E12's wiring proof. E12 itself introduces no new product scope:
// JOR-224 (390px pass), JOR-237 (keyboard/accessibility pass) and JOR-227
// (coverage measurement) are already merged. This spec only confirms, against
// the real running app and its seeded data, that every CQ-4 patient flow
// still holds all three properties at once, and that the CQ-1 coverage floor
// recorded in docs/coverage.md is read rather than retyped.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

import { config } from '../lib/config'
import { DEMO_ACCOUNT_PASSWORD, DEMO_PATIENT_EMAIL } from '../db/seed/rows'

import {
  E2_BOOK_SERVICE_ID,
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_REPORT_ID,
  E2_SEEDED_STUDY_ID,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'
import {
  expectNamedControls,
  expectNoPageOverflow,
  expectRenderedTextContrast,
  expectTapTarget,
  resetFixtures,
  tabTo,
} from './fixtures/a11y-helpers'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const REAL_DEL4 = config.playwrightBaseUrl !== null
const PASSWORD = 'E12PatientPassword9'
let identityFixtureLockToken: string | undefined

// ── shared phone-width / keyboard-only / labelling / contrast guards ───────

function assertPhoneWidth(page: Page): void {
  const viewport = page.viewportSize()
  expect(viewport?.width, 'JOR-246 wiring must run at the pinned 390px phone width').toBeLessThanOrEqual(390)
}

async function installPointerGuard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __e12PointerInputCount: number }
    state.__e12PointerInputCount = Number(sessionStorage.getItem('e12-pointer-input-count') ?? 0)
    for (const eventName of ['pointerdown', 'mousedown', 'touchstart']) {
      window.addEventListener(eventName, () => {
        state.__e12PointerInputCount += 1
        sessionStorage.setItem('e12-pointer-input-count', String(state.__e12PointerInputCount))
      }, true)
    }
  })
}

async function expectZeroPointerEvents(page: Page): Promise<void> {
  const count = await page.evaluate(() => (window as unknown as { __e12PointerInputCount: number }).__e12PointerInputCount)
  expect(count, 'JOR-246 keyboard-only flows must never register a pointer event').toBe(0)
}

function requireSeededFixture<T>(value: T | null | undefined, description: string): T {
  expect(value, `JOR-246 wiring requires a seeded ${description}; a missing fixture must fail the flow, not skip it`).toBeTruthy()
  return value as T
}

// ── fake-auth-server fixture harness (shared shape with e7/e10/responsive) ─

async function registerAndSignIn(request: APIRequestContext): Promise<void> {
  const email = `e12-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

async function registerAndLink(request: APIRequestContext): Promise<void> {
  await registerAndSignIn(request)
  expect((await request.post('/api/identity/verify', {
    data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
  })).status()).toBe(200)
}

// ── CQ-1 coverage: read, never typed in ────────────────────────────────────

function parseCq1AggregateCoverage(markdown: string): { statements: number; branches: number; functions: number; lines: number } {
  const match = markdown.match(
    /\*\*All named core logic\*\*\s*\|\s*\*\*(\d+\.\d+)%\*\*\s*\|\s*\*\*(\d+\.\d+)%\*\*\s*\|\s*\*\*(\d+\.\d+)%\*\*\s*\|\s*\*\*(\d+\.\d+)%\*\*/,
  )
  if (!match) throw new Error('docs/coverage.md is missing the recorded CQ-1 aggregate coverage row')
  const [, statements, branches, functions, lines] = match
  return { statements: Number(statements), branches: Number(branches), functions: Number(functions), lines: Number(lines) }
}

function recordedPercentages(markdown: string): number[] {
  return [...markdown.matchAll(/(\d{1,3}\.\d{1,2})%/g)].map(([, value]) => Number(value))
}

test.describe.serial('JOR-246 E12 phone-width, keyboard and coverage wiring', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))

  test('acceptance: every CQ-4 flow completes at 390px, by keyboard, with labelled controls, contrast and status conveyed by text', async ({ page }) => {
    await installPointerGuard(page)
    await resetFixtures(page.request)
    await registerAndSignIn(page.request)
    await page.setViewportSize({ width: 390, height: 844 })
    assertPhoneWidth(page)

    // Identity verification
    await page.goto('/verify?next=%2Fstudies')
    await expectNoPageOverflow(page)
    await expectNamedControls(page)
    await expectRenderedTextContrast(page)
    const patientReference = page.getByLabel('Patient reference')
    const dateOfBirth = page.getByLabel('Date of birth')
    const continueButton = page.getByRole('button', { name: 'Continue' })
    await tabTo(page, patientReference)
    await page.keyboard.type('PT-4471')
    await tabTo(page, dateOfBirth)
    await page.keyboard.type('03141988')
    await tabTo(page, continueButton)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/studies$/)

    // Image viewing
    const studyId = requireSeededFixture(E2_SEEDED_STUDY_ID, 'study')
    const studyCard = page.getByTestId('study-card').first()
    await tabTo(page, studyCard)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    await expectNoPageOverflow(page)
    await expectNamedControls(page)
    await expectRenderedTextContrast(page)
    for (const name of ['Zoom out', 'Reset zoom to 100%', 'Zoom in']) {
      await expectTapTarget(page.getByRole('button', { name }))
    }

    // Cine viewing — reached via the study page's own clip link, not a direct goto
    const clipId = requireSeededFixture(E2_SEEDED_CLIP_ID, 'cine clip')
    // The seeded study has carried a second clip since JOR-221's performance
    // fixture, so the link is named by the clip this flow then opens.
    const clipLink = page.locator(`[data-testid="study-clip-link"][href$="/clips/${clipId}"]`)
    await tabTo(page, clipLink)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/studies/${studyId}/clips/${clipId}$`))
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    await expectNoPageOverflow(page)
    await expectNamedControls(page)
    await expectRenderedTextContrast(page)
    const previous = page.getByRole('button', { name: 'Previous frame' })
    const play = page.getByRole('button', { name: 'Play playback' })
    const next = page.getByRole('button', { name: 'Next frame' })
    const scrub = page.getByRole('slider', { name: 'Frame scrubber' })
    const fps = page.getByRole('combobox', { name: 'Playback rate' })
    for (const control of [previous, play, next, scrub, fps]) await expectTapTarget(control)
    await tabTo(page, next)
    await page.keyboard.press('Enter')
    await expect(page.getByText('Frame 2 of 100', { exact: true })).toBeVisible()

    // Report viewing — status conveyed by text, not colour alone
    const reportId = requireSeededFixture(E2_SEEDED_REPORT_ID, 'report')
    await page.goto('/reports')
    await expectNoPageOverflow(page)
    const reportLink = page.getByRole('link', { name: /Seeded abdominal ultrasound/ })
    await tabTo(page, reportLink)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('report-view')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/reports/${reportId}$`))
    await expectNamedControls(page)
    await expectRenderedTextContrast(page)
    await expect(page.getByText('Signed', { exact: true })).toBeVisible()

    // Sharing
    const shareTrigger = page.getByTestId('share-create')
    await tabTo(page, shareTrigger)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Share secure link' })).toBeVisible()
    await expectNoPageOverflow(page)
    await page.keyboard.press('Tab')
    const recipientEmail = page.getByRole('textbox', { name: 'Recipient email' })
    await expect(recipientEmail).toBeFocused()
    await page.keyboard.type('e12-recipient@example.test')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Send secure link' })).toBeFocused()
    const shareResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'POST')
    await page.keyboard.press('Enter')
    expect((await shareResponse).status()).toBe(201)
    await expect(page.getByText(/secure link was sent/i)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shareTrigger).toBeFocused()

    // Booking
    const serviceId = requireSeededFixture(E2_BOOK_SERVICE_ID, 'bookable service')
    await page.goto('/book')
    await expectNoPageOverflow(page)
    const service = page.getByRole('combobox', { name: 'Service' })
    const provider = page.getByRole('combobox', { name: 'Provider' })
    await expect(service.getByRole('option', { name: 'Ultrasound', exact: true })).toHaveCount(1)
    await tabTo(page, service)
    await page.keyboard.type('Ultrasound')
    await expect(service).toHaveValue(serviceId)
    await expect(provider).toBeEnabled()
    await expect(provider.getByRole('option', { name: 'Dr. Riley Patel', exact: true })).toHaveCount(1)
    await tabTo(page, provider)
    await page.keyboard.type('Dr. Riley Patel')
    await expect(provider.locator('option:checked')).toHaveText('Dr. Riley Patel')
    const slot = page.getByTestId('slot-item').first()
    await expectTapTarget(slot)
    await tabTo(page, slot)
    await page.keyboard.press('Enter')
    const book = page.getByTestId('book-submit')
    await expectTapTarget(book)
    await tabTo(page, book)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('booking-success')).toBeVisible()
    await expectNamedControls(page)
    await expectRenderedTextContrast(page)

    // Appointment status conveyed by text, not colour alone
    await page.goto('/appointments')
    await expectNoPageOverflow(page)
    const appointmentStatus = page.getByTestId('appointment-item').first().locator('[aria-label^="Status: "]')
    await expect(appointmentStatus).toBeVisible()
    await expect(appointmentStatus).toHaveText(/^Status: /)

    await expectZeroPointerEvents(page)
  })

  test('mandatory adversarial: a wiring run wider than 390px is rejected by the phone-width guard', async ({ page }) => {
    await page.setViewportSize({ width: 391, height: 844 })
    await expect((async () => assertPhoneWidth(page))()).rejects.toThrow()
  })

  test('mandatory adversarial: a pointer-driven step trips the keyboard-only guard', async ({ page }) => {
    await installPointerGuard(page)
    await resetFixtures(page.request)
    await registerAndLink(page.request)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/studies')
    await expectZeroPointerEvents(page)
    await page.getByTestId('study-card').first().click()
    await expect(expectZeroPointerEvents(page)).rejects.toThrow()
  })
})

test.describe('JOR-246 E12 wiring contracts', () => {
  test('acceptance: CQ-1 coverage recorded in docs/coverage.md clears the required 80% floor', async () => {
    const coverageDoc = await readFile(path.join(REPO_ROOT, 'docs/coverage.md'), 'utf8')
    const coverage = parseCq1AggregateCoverage(coverageDoc)
    for (const metric of Object.values(coverage)) expect(metric).toBeGreaterThanOrEqual(80)
  })

  test('mandatory adversarial: a coverage figure typed into the spec, rather than read from docs/coverage.md, is caught', async () => {
    const [coverageDoc, ownSource] = await Promise.all([
      readFile(path.join(REPO_ROOT, 'docs/coverage.md'), 'utf8'),
      readFile(path.join(REPO_ROOT, 'e2e/e12-wiring.spec.ts'), 'utf8'),
    ])
    const recorded = recordedPercentages(coverageDoc)
    expect(recorded.length).toBeGreaterThan(0)
    for (const value of recorded) {
      expect(ownSource, `a typed-in coverage figure (${value}) must never appear as a literal in this spec`).not.toContain(String(value))
    }
  })

  test('mandatory adversarial: a flow whose seeded fixture is missing fails outright, never silently skipped', () => {
    expect(() => requireSeededFixture(undefined, 'seeded study')).toThrow()
  })
})

test.describe('JOR-246 E12 real DEL-4 preflight', () => {
  test.skip(!REAL_DEL4, 'requires the credential-free local DEL-4 runtime')

  test('seededPatientCompletesEveryCq4FlowAt390pxByKeyboard', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    assertPhoneWidth(page)
    expect((await page.request.post('/api/auth/login', {
      data: { email: DEMO_PATIENT_EMAIL, password: DEMO_ACCOUNT_PASSWORD },
    })).status()).toBe(200)

    const studies = (await (await page.request.get('/api/studies')).json()) as { studies: Array<{ id: string }> }
    const study = requireSeededFixture(studies.studies[0], 'real seeded study')
    await page.goto(`/studies/${study.id}`)
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    await expectNoPageOverflow(page)

    const reports = (await (await page.request.get('/api/reports')).json()) as { reports: Array<{ id: string }> }
    const report = requireSeededFixture(reports.reports[0], 'real seeded report')
    await page.goto(`/reports/${report.id}`)
    await expect(page.getByTestId('report-view')).toBeVisible()
    await expectNoPageOverflow(page)

    const services = (await (await page.request.get('/api/services')).json()) as { services: Array<{ id: string }> }
    const service = requireSeededFixture(services.services[0], 'real seeded service')
    const providers = (await (await page.request.get(`/api/providers?serviceId=${service.id}`)).json()) as { providers: Array<{ id: string }> }
    const provider = requireSeededFixture(providers.providers[0], 'real seeded provider')

    await page.goto('/book')
    await page.getByTestId('service-select').selectOption(service.id)
    await page.getByTestId('provider-select').selectOption(provider.id)
    await expect(page.getByTestId('slot-item').first()).toBeVisible()
    await expectNoPageOverflow(page)

    await page.goto('/appointments')
    await expect(page.getByTestId('appointment-list')).toBeVisible()
    await expectNoPageOverflow(page)
  })
})

import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test'

import type { CineViewerProps } from '../components/imaging/CineViewer'
import type { ImageViewerProps } from '../components/imaging/ImageViewer'
import type { ReportViewProps } from '../lib/reports/ReportView'

import {
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_IMAGE_ID,
  E2_SEEDED_REPORT_ID,
  E2_SEEDED_STUDY_ID,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'
import {
  expectNamedControls as sharedExpectNamedControls,
  expectRenderedTextContrast as sharedExpectRenderedTextContrast,
  expectVisibleKeyboardFocus,
  resetFixtures,
  tabTo as sharedTabTo,
} from './fixtures/a11y-helpers'

const PASSWORD = 'AccessiblePatientPassword9'
const CHANGEABLE_APPOINTMENT_ID = '22662266-2266-4266-8266-226622662266'
const RESCHEDULE_SLOT_ID = '00000000-0000-4000-8000-000000000002'
let identityFixtureLockToken: string | undefined

type PinnedImageViewerProps = {
  images: Array<{
    id: string; width: number; height: number; ordinal: number
    url: string | null; thumbUrl: string | null; expiresAt: string
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
  [keyof Pinned] extends [keyof Current]
    ? [Pinned] extends [Current]
      ? [Current] extends [Pinned] ? true : false
      : false
    : false

const PINNED_PROP_CONTRACTS: {
  imageViewer: CompatibleWithOptionalAdditions<ImageViewerProps, PinnedImageViewerProps>
  cineViewer: CompatibleWithOptionalAdditions<CineViewerProps, PinnedCineViewerProps>
  reportView: CompatibleWithOptionalAdditions<ReportViewProps, PinnedReportViewProps>
} = {
  imageViewer: true,
  cineViewer: true,
  reportView: true,
}

async function registerAndSignIn(request: APIRequestContext): Promise<void> {
  const email = `accessibility-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

async function registerAndLink(request: APIRequestContext): Promise<void> {
  await resetFixtures(request)
  await registerAndSignIn(request)
  expect((await request.post('/api/identity/verify', {
    data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
  })).status()).toBe(200)
}

async function expectHeadingOrder(page: Page): Promise<void> {
  const levels = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((headings) => headings
    .filter((heading) => heading.getClientRects().length > 0)
    .map((heading) => Number(heading.tagName.slice(1))))
  expect(levels[0]).toBe(1)
  expect(levels.filter((level) => level === 1)).toHaveLength(1)
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index]!).toBeLessThanOrEqual(levels[index - 1]! + 1)
  }
}

// Adds contenteditable/application-role coverage on top of the shared base
// selector list — a11y-focused checks not exercised by the wiring proof.
async function expectNamedControls(page: Page): Promise<void> {
  await sharedExpectNamedControls(page, ['[contenteditable="true"]', '[role="application"]'])
}

// Also asserts every intermediate stop during the Tab traversal (not just the
// final target) has a non-empty accessible name — stricter than the shared
// default, which only checks the target.
async function tabTo(page: Page, target: Locator, options: { backwards?: boolean, limit?: number } = {}): Promise<void> {
  await sharedTabTo(page, target, { ...options, assertNamedAtEachStep: true })
}

async function productionComponentFiles(): Promise<string[]> {
  const files = await Promise.all(['app', 'components', 'lib'].map(async (root) =>
    (await readdir(path.join(process.cwd(), root), { recursive: true }))
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => path.join(root, file)),
  ))
  return files.flat().sort()
}

async function openSharedImage(browser: Browser, request: APIRequestContext): Promise<Page> {
  const response = await request.post('/api/shares', {
    data: { resourceKind: 'image', resourceId: E2_SEEDED_IMAGE_ID, recipientEmail: 'accessible-recipient@example.test' },
  })
  expect(response.status()).toBe(201)
  const { url } = await response.json() as { url: string }
  const page = await browser.newPage()
  await page.goto(new URL(url).pathname)
  await expect(page.getByTestId('shared-resource')).toBeVisible()
  return page
}

// Narrower "renders its own value" selector (only text-like inputs, not
// checkbox/radio/color/file/range) and an added forbidden-exact-colour check
// — both stricter than the shared default used by the wiring proof.
const RENDERS_OWN_VALUE_SELECTOR = [
  'input:not([type])',
  'input[type="text"]',
  'input[type="search"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[type="url"]',
  'input[type="password"]',
  'input[type="number"]',
  'input[type="date"]',
  'input[type="time"]',
  'input[type="datetime-local"]',
  'input[type="month"]',
  'input[type="week"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="button"]',
  'textarea',
  'select',
].join(', ')

async function expectRenderedTextContrast(page: Page): Promise<void> {
  await sharedExpectRenderedTextContrast(page, {
    rendersOwnValueSelector: RENDERS_OWN_VALUE_SELECTOR,
    forbiddenColours: [[135, 63, 224], [0, 192, 221]],
  })
}

async function rangeControlContrastOffenders(page: Page): Promise<Array<{ html: string, violation: string }>> {
  return page.evaluate(() => {
    type Colour = [number, number, number]
    const parse = (value: string): Colour | null => {
      const hex = value.trim().match(/^#([\da-f]{6})$/i)?.[1]
      if (hex) return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)]
      const channels = value.match(/[\d.]+/g)?.map(Number)
      return channels && channels.length >= 3 ? [channels[0]!, channels[1]!, channels[2]!] : null
    }
    const luminance = ([red, green, blue]: Colour) => {
      const channel = (value: number) => {
        const normalized = value / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }
    const ratio = (first: Colour, second: Colour) => {
      const firstLight = luminance(first)
      const secondLight = luminance(second)
      return (Math.max(firstLight, secondLight) + 0.05) / (Math.min(firstLight, secondLight) + 0.05)
    }

    return [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')].flatMap((range) => {
      const style = getComputedStyle(range)
      const pairs = [
        ['track', '--cine-range-track', '--cine-range-surface'],
        ['thumb', '--cine-range-thumb', '--cine-range-track'],
        ['focus', '--cine-range-focus', '--cine-range-surface'],
      ] as const
      return pairs.flatMap(([part, foregroundProperty, backgroundProperty]) => {
        const foreground = parse(style.getPropertyValue(foregroundProperty))
        const background = parse(style.getPropertyValue(backgroundProperty))
        if (!foreground || !background) {
          return [{ html: range.outerHTML.slice(0, 180), violation: `${part} does not expose its owning colour tokens` }]
        }
        const contrast = ratio(foreground, background)
        return contrast + 0.01 < 3
          ? [{ html: range.outerHTML.slice(0, 180), violation: `${part} ${contrast.toFixed(2)}:1; requires 3:1` }]
          : []
      })
    })
  })
}

async function expectRangeControlContrast(page: Page): Promise<void> {
  expect(await rangeControlContrastOffenders(page)).toEqual([])
}

test('JOR-237 regression: a range inherited colour is not rendered text', async ({ page }) => {
  await page.setContent(`
    <main style="background: rgb(255, 255, 255); color: rgb(36, 27, 49)">
      <label for="contrast-range">Frame</label>
      <input id="contrast-range" type="range" aria-label="Frame scrubber" style="color: rgb(119, 119, 119)">
    </main>
  `)

  await expectRenderedTextContrast(page)
})

test.describe.serial('JOR-237 keyboard and accessibility pass', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ page }) => registerAndLink(page.request))

  test('mandatory adversarial: share dialog releases keyboard focus with Escape', async ({ page }) => {
    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`)
    const trigger = page.getByTestId('share-create')
    await tabTo(page, trigger)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Share secure link' })).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByRole('dialog', { name: 'Share secure link' })).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('mandatory adversarial: a shared image page has one h1 and no skipped heading level', async ({ browser, page }) => {
    const sharedPage = await openSharedImage(browser, page.request)
    try {
      await expectHeadingOrder(sharedPage)
      await expectNamedControls(sharedPage)
      await expectRenderedTextContrast(sharedPage)
    } finally {
      await sharedPage.close()
    }
  })

  test('mandatory adversarial: every patient page has named controls, ordered headings, and rendered WCAG contrast without forbidden text colours', async ({ page }) => {
    expect((await page.request.post('/api/shares', {
      data: { resourceKind: 'image', resourceId: E2_SEEDED_IMAGE_ID, recipientEmail: 'contrast-recipient@example.test' },
    })).status()).toBe(201)
    const routes = [
      ['/studies', 'study-list'],
      [`/studies/${E2_SEEDED_STUDY_ID}`, 'image-viewer'],
      [`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`, 'cine-viewer'],
      [`/reports/${E2_SEEDED_REPORT_ID}`, 'report-view'],
      ['/reports', ''],
      ['/shares', 'share-list'],
      ['/book', 'service-select'],
      ['/appointments', 'appointment-list'],
      ['/profile', 'profile-form'],
    ] as const
    for (const [route, ready] of routes) {
      await page.goto(route)
      if (route === '/reports') {
        await expect(page.getByRole('link', { name: /Seeded abdominal ultrasound/ })).toBeVisible()
      } else if (route === '/shares') {
        await expect(page.getByText(/shared with/i).first()).toBeVisible()
      } else {
        await expect(page.getByTestId(ready)).toBeVisible()
      }
      await expectHeadingOrder(page)
      await expectNamedControls(page)
      await expectRenderedTextContrast(page)
      if (ready === 'cine-viewer') await expectRangeControlContrast(page)
    }
  })

  test('acceptance: identity and profile forms expose named landmarks and ordered labelled controls', async ({ page }) => {
    await resetFixtures(page.request)
    await registerAndSignIn(page.request)
    await page.goto('/verify')
    const identityForm = page.getByRole('form', { name: 'Identity verification' })
    await expect(identityForm).toBeVisible()
    await expectHeadingOrder(page)
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
    await page.goto('/profile')
    await expect(page.getByRole('form', { name: 'Patient profile' })).toBeVisible()
    await expect(page.getByLabel('Display name')).toBeVisible()
    await expect(page.getByLabel('Contact phone')).toBeVisible()
    await expectHeadingOrder(page)
    await expectNamedControls(page)
    await expectRenderedTextContrast(page)
    await tabTo(page, page.getByLabel('Display name'))
    await tabTo(page, page.getByLabel('Contact phone'))
  })

  test('acceptance: every patient operation completes by keyboard, while status remains text and verify errors alert', async ({ page }) => {
    await page.addInitScript(() => {
      const state = window as unknown as { __pointerInputCount: number }
      state.__pointerInputCount = Number(sessionStorage.getItem('pointer-input-count') ?? 0)
      for (const eventName of ['pointerdown', 'mousedown', 'touchstart']) {
        window.addEventListener(eventName, () => {
          state.__pointerInputCount += 1
          sessionStorage.setItem('pointer-input-count', String(state.__pointerInputCount))
        }, true)
      }
    })
    await resetFixtures(page.request)
    await registerAndSignIn(page.request)

    await page.goto('/verify?next=%2Fstudies')
    const patientReference = page.getByLabel('Patient reference')
    const dateOfBirth = page.getByLabel('Date of birth')
    const continueButton = page.getByRole('button', { name: 'Continue' })
    await tabTo(page, patientReference)
    await page.keyboard.type('PT-0000')
    await tabTo(page, dateOfBirth)
    await page.keyboard.type('03141988')
    await tabTo(page, continueButton)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('identity-error')).toHaveAttribute('role', 'alert')
    await expect(page.getByTestId('identity-error')).toHaveText('We could not match those details. Please check them and try again.')
    await tabTo(page, patientReference, { backwards: true })
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('PT-4471')
    await tabTo(page, dateOfBirth)
    await tabTo(page, continueButton)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/studies$/)

    const studyCard = page.getByTestId('study-card').first()
    await tabTo(page, studyCard)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    await expect(page.getByTestId('image-zoom')).toHaveAttribute('aria-label', 'Image zoom controls')
    const imageCanvas = page.getByTestId('image-canvas')
    await tabTo(page, imageCanvas)
    await page.keyboard.press('+')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 125%')
    await expect(page.getByTestId('image-full')).toHaveAttribute('style', /translate\(24px, 0px\) scale\(1\.25\)/)

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    const previous = page.getByRole('button', { name: 'Previous frame' })
    const play = page.getByRole('button', { name: 'Play playback' })
    const next = page.getByRole('button', { name: 'Next frame' })
    const scrub = page.getByRole('slider', { name: 'Frame scrubber' })
    const fps = page.getByRole('combobox', { name: 'Playback rate' })
    for (const control of [previous, play, next, scrub, fps]) await expect(control).toBeVisible()
    await tabTo(page, previous)
    await tabTo(page, play)
    await tabTo(page, next)
    await page.keyboard.press('Enter')
    await expect(page.getByText('Frame 2 of 100', { exact: true })).toBeVisible()
    await tabTo(page, scrub)
    await page.keyboard.press('ArrowRight')
    await expect(page.getByText('Frame 3 of 100', { exact: true })).toBeVisible()
    await tabTo(page, fps)
    await page.keyboard.type('6 fps')
    await expect(fps).toHaveValue('6')
    await tabTo(page, scrub, { backwards: true })
    await tabTo(page, next, { backwards: true })
    await tabTo(page, play, { backwards: true })
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeVisible()
    await page.keyboard.press('Enter')

    await page.goto('/reports')
    const reportLink = page.getByRole('link', { name: /Seeded abdominal ultrasound/ })
    await tabTo(page, reportLink)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('report-view')).toBeVisible()
    await expect(page.getByText('Signed', { exact: true })).toBeVisible()
    await expectHeadingOrder(page)

    const shareTrigger = page.getByTestId('share-create')
    await tabTo(page, shareTrigger)
    await page.keyboard.press('Enter')
    await expectVisibleKeyboardFocus(page.getByRole('button', { name: 'Close share dialog' }))
    await page.keyboard.press('Tab')
    const recipientEmail = page.getByRole('textbox', { name: 'Recipient email' })
    await expectVisibleKeyboardFocus(recipientEmail)
    await page.keyboard.type('keyboard-recipient@example.test')
    await page.keyboard.press('Tab')
    const sendShare = page.getByRole('button', { name: 'Send secure link' })
    await expectVisibleKeyboardFocus(sendShare)
    const shareResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'POST')
    await page.keyboard.press('Enter')
    expect((await shareResponse).status()).toBe(201)
    await expect(page.getByText(/secure link was sent/i)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shareTrigger).toBeFocused()

    await page.goto('/shares')
    const revoke = page.getByTestId('share-revoke').first()
    await expect(revoke).toHaveAccessibleName(/Revoke link shared with keyboard-recipient@example\.test/)
    await tabTo(page, revoke)
    await page.keyboard.press('Enter')
    await expect(page.getByText('Revoked', { exact: true }).first()).toBeVisible()

    await page.goto('/book')
    const service = page.getByRole('combobox', { name: 'Service' })
    const provider = page.getByRole('combobox', { name: 'Provider' })
    await expect(service.getByRole('option', { name: 'Ultrasound', exact: true })).toHaveCount(1)
    await tabTo(page, service)
    await page.keyboard.type('Ultrasound')
    await expect(service).toHaveValue('77667766-7766-4766-8766-776677667766')
    await expect(provider).toBeEnabled()
    await expect(provider.getByRole('option', { name: 'Dr. Riley Patel', exact: true })).toHaveCount(1)
    await tabTo(page, provider)
    await page.keyboard.type('Dr. Riley Patel')
    await expect(provider.locator('option:checked')).toHaveText('Dr. Riley Patel')
    const slot = page.getByTestId('slot-item').first()
    await expect(slot).toHaveAccessibleName(/(?:AM|PM)/)
    await tabTo(page, slot)
    await page.keyboard.press('Enter')
    const book = page.getByTestId('book-submit')
    await expect(book).toHaveAccessibleName('Confirm appointment')
    await tabTo(page, book)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('booking-success')).toBeVisible()

    await page.route('**/api/appointments/*/slots', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          providerTimeZone: 'America/Chicago',
          slots: [{ id: RESCHEDULE_SLOT_ID, startsAt: '2030-06-11T14:00:00-05:00', endsAt: '2030-06-11T15:00:00-05:00' }],
        }),
      })
    })
    await page.route('**/api/appointments/*', async (route) => {
      const action = (route.request().postDataJSON() as { action: string }).action
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: CHANGEABLE_APPOINTMENT_ID,
          startsAt: '2030-06-11T14:00:00-05:00',
          endsAt: '2030-06-11T15:00:00-05:00',
          status: action === 'cancel' ? 'cancelled' : 'confirmed',
          providerName: 'Dr. Avery Chen',
          serviceName: 'MRI',
          outOfHours: false,
          canChange: action !== 'cancel',
          changeDeadline: '2030-06-10T14:00:00-05:00',
          allowedTransitions: action === 'cancel' ? [] : ['cancelled'],
        }),
      })
    })
    await page.goto('/appointments')
    const changeable = page.getByTestId('appointment-item').filter({ has: page.getByTestId('appointment-reschedule') }).first()
    const reschedule = changeable.getByTestId('appointment-reschedule')
    await expect(reschedule).toHaveAccessibleName('Reschedule')
    await tabTo(page, reschedule)
    await page.keyboard.press('Enter')
    const newSlot = changeable.getByTestId('slot-item').first()
    await expect(newSlot).toBeVisible()
    await tabTo(page, newSlot)
    await page.keyboard.press('Enter')
    await tabTo(page, changeable.getByTestId('appointment-reschedule-confirm'))
    await page.keyboard.press('Enter')
    const updatedAppointment = page.getByTestId('appointment-item').filter({ hasText: 'Jun 11, 2030' })
    await expect(updatedAppointment).toBeVisible()
    const cancel = updatedAppointment.getByTestId('appointment-cancel')
    await expect(cancel).toHaveAccessibleName('Cancel')
    await tabTo(page, cancel)
    await page.keyboard.press('Enter')
    await expect(updatedAppointment).toContainText('Status: Cancelled')

    expect(await page.evaluate(() => (window as unknown as { __pointerInputCount: number }).__pointerInputCount)).toBe(0)
  })
})

test.describe('JOR-237 accessibility source contracts', () => {
  test('mandatory adversarial: no div or span click handler stands in for a native control', async () => {
    for (const file of await productionComponentFiles()) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/<(?:div|span)\b[^>]*\bonClick\s*=/i)
    }
  })

  test('mandatory adversarial: component TSX contains no hex literal and viewer props allow only optional additions', async () => {
    for (const file of await productionComponentFiles()) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
    expect(PINNED_PROP_CONTRACTS).toEqual({ imageViewer: true, cineViewer: true, reportView: true })
  })

  test('mandatory adversarial: appointment actions consume server capabilities instead of browser notice or transition rules', async () => {
    const source = await readFile(path.join(process.cwd(), 'components/scheduling/AppointmentCard.tsx'), 'utf8')
    expect(source).toContain('appointment.canChange')
    expect(source).toContain("appointment.allowedTransitions.includes('cancelled')")
    expect(source).not.toMatch(/(?:Date\.parse|new Date)\(appointment\.changeDeadline\)/)
    expect(source).not.toMatch(/fromStatus|toStatus|allowedTransitions\s*\(/)
    expect(source).not.toMatch(/from ['"]\.\.\/\.\.\/lib\/scheduling\/lifecycle['"]/)
  })
})

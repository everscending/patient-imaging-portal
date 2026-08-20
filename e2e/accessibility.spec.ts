import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Browser, Page } from '@playwright/test'

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

const PASSWORD = 'AccessiblePatientPassword9'
const CHANGEABLE_APPOINTMENT_ID = '22662266-2266-4266-8266-226622662266'
const RESCHEDULE_SLOT_ID = '00000000-0000-4000-8000-000000000002'
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

async function fixtureUrl(): Promise<string> {
  const raw = await readFile(path.join(process.cwd(), '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetFixtures(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fixtureUrl()}/__test__/reset-identity`)).ok()).toBe(true)
  expect((await request.post(`${await fixtureUrl()}/__test__/reset-booking`)).ok()).toBe(true)
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

async function expectNamedControls(page: Page): Promise<void> {
  const controls = page.locator([
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="application"]',
    '[role="button"]',
  ].join(','))
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index)
    if (!await control.isVisible()) continue
    const html = await control.evaluate((element) => element.outerHTML.slice(0, 180))
    await expect(control, `Unnamed interactive control: ${html}`).toHaveAccessibleName(/\S/)
  }
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

async function expectRenderedTextContrast(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    type Colour = [number, number, number, number]
    const parse = (value: string): Colour | null => {
      const channels = value.match(/[\d.]+/g)?.map(Number)
      if (!channels || channels.length < 3) return null
      return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1]
    }
    const composite = (foreground: Colour, background: Colour): Colour => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3])
      if (alpha === 0) return [0, 0, 0, 0]
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
        alpha,
      ]
    }
    const luminance = ([red, green, blue]: Colour) => {
      const channel = (value: number) => {
        const normalized = value / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }
    const background = (element: Element): Colour => {
      const layers: Colour[] = []
      for (let current: Element | null = element; current; current = current.parentElement) {
        const colour = parse(getComputedStyle(current).backgroundColor)
        if (colour && colour[3] > 0) layers.push(colour)
      }
      return layers.reverse().reduce((result, layer) => composite(layer, result), [255, 255, 255, 1] as Colour)
    }

    return [...document.body.querySelectorAll<HTMLElement>('*')].flatMap((element) => {
      const style = getComputedStyle(element)
      const hasOwnText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
      const isControl = element.matches('button, input, select, textarea')
      const rect = element.getBoundingClientRect()
      if ((!hasOwnText && !isControl) || rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none' || element.matches(':disabled, .pip-visually-hidden')) return []
      const foreground = parse(style.color)
      if (!foreground) return []
      if ((foreground[0] === 135 && foreground[1] === 63 && foreground[2] === 224) ||
          (foreground[0] === 0 && foreground[1] === 192 && foreground[2] === 221)) {
        return [{ html: element.outerHTML.slice(0, 180), violation: `forbidden text colour ${style.color}` }]
      }
      const backdrop = background(element)
      const renderedForeground = composite(foreground, backdrop)
      const light = luminance(renderedForeground)
      const dark = luminance(backdrop)
      const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
      const size = Number.parseFloat(style.fontSize)
      const weight = Number.parseInt(style.fontWeight, 10) || 400
      const minimum = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5
      return ratio + 0.01 < minimum
        ? [{ html: element.outerHTML.slice(0, 180), violation: `${ratio.toFixed(2)}:1; requires ${minimum}:1` }]
        : []
    })
  })
  expect(offenders).toEqual([])
}

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
    await trigger.focus()
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
    await patientReference.focus()
    await page.keyboard.press('Tab')
    await expect(dateOfBirth).toBeFocused()
    for (let tab = 0; tab < 4 && !await continueButton.evaluate((button) => button === document.activeElement); tab += 1) {
      await page.keyboard.press('Tab')
    }
    await expect(continueButton).toBeFocused()

    await patientReference.fill('PT-4471')
    await dateOfBirth.fill('1988-03-14')
    await continueButton.press('Enter')
    await expect(page).toHaveURL(/\/studies$/)
    await page.goto('/profile')
    await expect(page.getByRole('form', { name: 'Patient profile' })).toBeVisible()
    await expect(page.getByLabel('Display name')).toBeVisible()
    await expect(page.getByLabel('Contact phone')).toBeVisible()
    await expectHeadingOrder(page)
    await expectNamedControls(page)
    await expectRenderedTextContrast(page)
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
    await patientReference.fill('PT-0000')
    await dateOfBirth.fill('1988-03-14')
    await page.getByRole('button', { name: 'Continue' }).press('Enter')
    await expect(page.getByTestId('identity-error')).toHaveAttribute('role', 'alert')
    await expect(page.getByTestId('identity-error')).toHaveText('We could not match those details. Please check them and try again.')
    await patientReference.fill('PT-4471')
    await page.getByRole('button', { name: 'Continue' }).press('Enter')
    await expect(page).toHaveURL(/\/studies$/)

    const studyCard = page.getByTestId('study-card').first()
    await studyCard.focus()
    await expect(studyCard).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    await expect(page.getByTestId('image-zoom')).toHaveAttribute('aria-label', 'Image zoom controls')
    const imageCanvas = page.getByTestId('image-canvas')
    await imageCanvas.focus()
    await page.keyboard.press('+')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 125%')
    await expect(page.getByTestId('image-full')).toHaveAttribute('style', /translate\(24px, 0px\) scale\(1\.25\)/)

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    const previous = page.getByRole('button', { name: 'Previous frame' })
    const play = page.getByRole('button', { name: 'Play playback' })
    const next = page.getByRole('button', { name: 'Next frame' })
    const fps = page.getByRole('combobox', { name: 'Playback rate' })
    for (const control of [previous, play, next, fps]) await expect(control).toBeVisible()
    await next.press('Enter')
    await expect(page.getByText('Frame 2 of 100', { exact: true })).toBeVisible()
    await fps.selectOption('6')
    await expect(fps).toHaveValue('6')
    await play.press('Enter')
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeVisible()
    await page.getByRole('button', { name: 'Pause playback' }).press('Enter')

    await page.goto('/reports')
    const reportLink = page.getByRole('link', { name: /Seeded abdominal ultrasound/ })
    await reportLink.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('report-view')).toBeVisible()
    await expect(page.getByText('Signed', { exact: true })).toBeVisible()
    await expectHeadingOrder(page)

    const shareTrigger = page.getByTestId('share-create')
    await shareTrigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Close share dialog' })).toBeFocused()
    await page.keyboard.press('Tab')
    const recipientEmail = page.getByRole('textbox', { name: 'Recipient email' })
    await expect(recipientEmail).toBeFocused()
    await page.keyboard.type('keyboard-recipient@example.test')
    await page.keyboard.press('Tab')
    const sendShare = page.getByRole('button', { name: 'Send secure link' })
    await expect(sendShare).toBeFocused()
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
    await revoke.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Revoked', { exact: true }).first()).toBeVisible()

    await page.goto('/book')
    const service = page.getByRole('combobox', { name: 'Service' })
    const provider = page.getByRole('combobox', { name: 'Provider' })
    await service.focus()
    await service.selectOption('77667766-7766-4766-8766-776677667766')
    await provider.selectOption({ label: 'Dr. Riley Patel' })
    const slot = page.getByTestId('slot-item').first()
    await expect(slot).toHaveAccessibleName(/(?:AM|PM)/)
    await slot.focus()
    await page.keyboard.press('Enter')
    const book = page.getByTestId('book-submit')
    await expect(book).toHaveAccessibleName('Confirm appointment')
    await book.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('booking-success')).toBeVisible()

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
    await reschedule.focus()
    await page.keyboard.press('Enter')
    const newSlot = changeable.getByRole('textbox', { name: 'New appointment slot ID' })
    await newSlot.fill(RESCHEDULE_SLOT_ID)
    await changeable.getByRole('button', { name: 'Confirm reschedule' }).press('Enter')
    const updatedAppointment = page.getByTestId('appointment-item').filter({ hasText: 'Jun 11, 2030' })
    await expect(updatedAppointment).toBeVisible()
    const cancel = updatedAppointment.getByTestId('appointment-cancel')
    await expect(cancel).toHaveAccessibleName('Cancel')
    await cancel.focus()
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

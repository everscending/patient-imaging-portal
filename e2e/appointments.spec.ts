// JOR-257 — patient appointment list actions are server-authorized.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

const PASSWORD = 'CorrectHorseBattery9'
const SLOT_ID = '00000000-0000-4000-8000-000000000002'
const NOTICE = 'Changes are not allowed within 24 hours of the start. Call the clinic.'

type FixtureAppointment = {
  id: string
  startsAt: string
  endsAt: string
  status: string
  providerName: string
  serviceName: string
  outOfHours: boolean
  canChange: boolean
  changeDeadline: string
  allowedTransitions?: string[]
}

function appointment(overrides: Partial<FixtureAppointment> = {}): FixtureAppointment {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    startsAt: '2030-06-10T14:00:00-05:00',
    endsAt: '2030-06-10T15:00:00-05:00',
    status: 'requested',
    providerName: 'Dr. Ada Lovelace',
    serviceName: 'MRI',
    outOfHours: false,
    canChange: true,
    changeDeadline: '2030-06-09T14:00:00-05:00',
    allowedTransitions: ['cancelled'],
    ...overrides,
  }
}

async function signedIn(page: import('@playwright/test').Page): Promise<void> {
  const email = `jor-257-${randomUUID()}@example.test`
  expect((await page.request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

async function show(page: import('@playwright/test').Page, items: FixtureAppointment[]): Promise<void> {
  await page.route('**/api/appointments', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ appointments: items }) }))
  await page.goto('/appointments')
  await expect(page.getByTestId('appointment-list')).toBeVisible()
}

test.describe('JOR-257 appointments', () => {
  test('allowedTransitionsEmpty_hasNoAction', async ({ page }) => {
    await signedIn(page)
    await show(page, [appointment({ allowedTransitions: [], canChange: false })])
    await expect(page.locator('[data-testid="appointment-notice-locked"]:visible')).toHaveText(NOTICE)
    await expect(page.locator('[data-testid="appointment-reschedule"]:visible')).toHaveCount(0)
    await expect(page.locator('[data-testid="appointment-cancel"]:visible')).toHaveCount(0)
  })

  test('canChangeFalseWithTransitions_offersOnlyServerCancel', async ({ page }) => {
    await signedIn(page)
    await show(page, [appointment({ canChange: false, allowedTransitions: ['cancelled'] })])
    await expect(page.locator('[data-testid="appointment-reschedule"]:visible')).toHaveCount(0)
    await expect(page.locator('[data-testid="appointment-cancel"]:visible')).toHaveCount(1)
  })

  test('cancelledOutOfHours_hasAnnotationButNoAction', async ({ page }) => {
    await signedIn(page)
    await show(page, [appointment({ status: 'cancelled', outOfHours: true, canChange: false, allowedTransitions: [] })])
    await expect(page.locator('[data-testid="appointment-out-of-hours"]:visible')).toHaveText('Outside hours. Your appointment is unaffected.')
    await expect(page.locator('[data-testid="appointment-reschedule"]:visible')).toHaveCount(0)
    await expect(page.locator('[data-testid="appointment-cancel"]:visible')).toHaveCount(0)
  })

  test('noShow_serverWithholdsActions', async ({ page }) => {
    await signedIn(page)
    await show(page, [appointment({ status: 'no_show', canChange: false, allowedTransitions: [] })])
    await expect(page.locator('[data-testid="appointment-item"]:visible')).toContainText('Status: No-show')
    await expect(page.locator('[data-testid="appointment-reschedule"]:visible')).toHaveCount(0)
    await expect(page.locator('[data-testid="appointment-cancel"]:visible')).toHaveCount(0)
  })

  test('outOfHours_serverOfferedActionsRemainAvailable', async ({ page }) => {
    await signedIn(page)
    await show(page, [appointment({ outOfHours: true })])
    await expect(page.locator('[data-testid="appointment-out-of-hours"]:visible')).toHaveText('Outside hours. Your appointment is unaffected.')
    await expect(page.locator('[data-testid="appointment-reschedule"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-testid="appointment-cancel"]:visible')).toHaveCount(1)
  })

  test('changeDeadlinePassesWhileOpen_serverRefusalShowsPinnedNotice', async ({ page }) => {
    await signedIn(page)
    await page.route('**/api/appointments/*', (route) => route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"minimum_notice","message":"Changes are not allowed within 24 hours of the appointment."}' }))
    await show(page, [appointment()])
    await page.locator('[data-testid="appointment-cancel"]:visible').click()
    await expect(page.locator('[data-testid="appointment-item"]:visible').getByRole('alert')).toHaveText('Changes are not allowed within 24 hours of the appointment.')
  })

  test('cancelReturningMinimumNotice_leavesItemUnchanged', async ({ page }) => {
    await signedIn(page)
    await page.route('**/api/appointments/*', (route) => route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"minimum_notice","message":"Changes are not allowed within 24 hours of the appointment."}' }))
    await show(page, [appointment()])
    await page.locator('[data-testid="appointment-cancel"]:visible').click()
    await expect(page.locator('[data-testid="appointment-item"]:visible').getByRole('alert')).toHaveText('Changes are not allowed within 24 hours of the appointment.')
    await expect(page.locator('[data-testid="appointment-item"]:visible')).toContainText('Status: Requested')
  })

  test('rescheduleReturningSlotUnavailable_leavesItemUnchanged', async ({ page }) => {
    await signedIn(page)
    await page.route('**/api/appointments/*', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"slot_unavailable","message":"That slot is no longer available."}' }))
    await show(page, [appointment()])
    await page.locator('[data-testid="appointment-reschedule"]:visible').click()
    await page.locator('input:visible').fill(SLOT_ID)
    await page.getByRole('button', { name: 'Confirm reschedule' }).click()
    await expect(page.locator('[data-testid="appointment-item"]:visible').getByRole('alert')).toHaveText('That slot is no longer available.')
    await expect(page.locator('[data-testid="appointment-item"]:visible')).toContainText('Status: Requested')
  })

  test('patchResponseReplacesItemWithoutSecondGet', async ({ page }) => {
    await signedIn(page)
    let collectionReads = 0
    await page.route('**/api/appointments', (route) => {
      collectionReads += 1
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ appointments: [appointment()] }) })
    })
    await page.route('**/api/appointments/*', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(appointment({ status: 'cancelled', canChange: false, allowedTransitions: [] })),
    }))
    await page.goto('/appointments')
    await page.locator('[data-testid="appointment-cancel"]:visible').click()
    await expect(page.locator('[data-testid="appointment-item"]:visible')).toContainText('Status: Cancelled')
    expect(collectionReads).toBe(1)
  })

  test('rescheduleResponseReplacesItemWithNewTime', async ({ page }) => {
    await signedIn(page)
    await page.route('**/api/appointments/*', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(appointment({ startsAt: '2030-06-11T14:00:00-05:00' })),
    }))
    await show(page, [appointment()])
    await page.locator('[data-testid="appointment-reschedule"]:visible').click()
    await page.locator('input:visible').fill(SLOT_ID)
    await page.getByRole('button', { name: 'Confirm reschedule' }).click()
    await expect(page.locator('[data-testid="appointment-item"]:visible')).toContainText('Jun 11, 2030')
  })

  test('appointmentTime_includesViewerZoneAbbreviation', async ({ page }) => {
    await signedIn(page)
    await show(page, [appointment()])
    await expect(page.locator('[data-testid="appointment-item"]:visible time')).toContainText(/(?:AM|PM)\s+[A-Z]{2,5}$/)
  })

  test('zeroAppointments_rendersCleanEmptyState', async ({ page }) => {
    await signedIn(page)
    await page.route('**/api/appointments', (route) => route.fulfill({ contentType: 'application/json', body: '{"appointments":[]}' }))
    await page.goto('/appointments')
    await expect(page.getByTestId('appointments-empty')).toHaveText('You have no appointments.')
    await expect(page.getByTestId('appointment-list')).toHaveCount(0)
  })

  test('missingAllowedTransitions_failsLoudlyWithoutLocalFallback', async ({ page }) => {
    await signedIn(page)
    await page.route('**/api/appointments', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ appointments: [appointment({ allowedTransitions: undefined })] }) }))
    const error = page.waitForEvent('pageerror')
    await page.goto('/appointments')
    await expect(error).resolves.toThrow(/allowedTransitions/)
    await expect(page.getByTestId('appointment-reschedule')).toHaveCount(0)
    await expect(page.getByTestId('appointment-cancel')).toHaveCount(0)
  })

  test('mobileLayoutAndSourceGuards_preserveAccessibleServerDrivenList', async ({ page }) => {
    await signedIn(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await show(page, [appointment({ outOfHours: true })])
    await expect(page.getByRole('heading', { level: 1, name: 'Appointments' })).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    const reschedule = page.locator('[data-testid="appointment-reschedule"]:visible')
    await reschedule.focus()
    await expect(reschedule).toBeFocused()
    const box = await reschedule.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  })
})

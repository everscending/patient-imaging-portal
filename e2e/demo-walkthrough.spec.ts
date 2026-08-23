// e2e/demo-walkthrough.spec.ts — JOR-261's recorded DEL-6 walkthrough.
//
// One re-runnable spec that drives the real app, in DEL-6's exact clause
// order, while the `demo-walkthrough` Playwright project records the screen
// (playwright.config.ts scopes `video` to that project so no other spec
// records). Every segment is a `demoStep`, and every `demoStep` name is a
// DEL-6 clause, so any second of the recording maps back to a requirement:
// the harvested offsets are written to demo-timeline.json and quoted in
// docs/demo.md.
//
// Nothing here is staged or narrated. The no-double-book segment is a real
// race between two live sessions on the genuinely last open slot, and the
// winner is decided by the database, not by this file.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import {
  E2_BOOK_SERVICE_ID,
  E2_PROVIDER_EMAIL,
  E2_PROVIDER_ID,
  E2_OTHER_PROVIDER_ID,
  E2_PROVIDER_PASSWORD,
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_REPORT_ID,
  E2_SEEDED_STUDY_ID,
  E5_CRON_SECRET,
} from './fixtures/fake-auth-server'
import { fixtureUrl } from './fixtures/a11y-helpers'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const ARTIFACT_DIR = path.join(REPO_ROOT, 'test-results', 'demo-walkthrough')
const RECORDING_PATH = path.join(ARTIFACT_DIR, 'demo-walkthrough.webm')
const TIMELINE_PATH = path.join(ARTIFACT_DIR, 'demo-timeline.json')
const MAIL_DIR = path.join(REPO_ROOT, '.local', 'mail')

// The seeded demo patient (fake-auth-server.ts). No real person, ever.
const DEMO_PATIENT_REF = 'PT-4471'
const DEMO_PATIENT_DOB = '1988-03-14'
const DEMO_PASSWORD = 'DemoWalkthroughPassword9'
const PHONE_VIEWPORT = { width: 390, height: 844 }
const DESKTOP_VIEWPORT = { width: 1280, height: 800 }

// Pinned in app/(patient)/book/page.tsx. The loser sees exactly this.
const PINNED_CONFLICT =
  'That slot is no longer available. Someone booked it moments ago. Please choose another time.'

const IMAGE_VIEWER_READY_TIMEOUT_MS = 30_000

// The second seeded provider. Their grid carries the slots the booking and
// race segments consume, which leaves E2_PROVIDER_ID's own grid intact for
// the reschedule segment — a reschedule may only move within one provider.
const RACE_PROVIDER_ID = E2_OTHER_PROVIDER_ID
const RACE_PROVIDER_NAME = 'Dr. Riley Patel' // E2_OTHER_PROVIDER's seeded full_name (not exported)

type StepMark = { step: string; atMs: number }
type ReminderRun = { due: number; sent: number; skipped: number; failed: number }
type Slot = { id: string; startsAt: string }
type CreatedShare = { id: string; url: string; recipientEmail: string }

let identityFixtureLockToken: string | undefined
let recordingStartedAt = 0
const marks: StepMark[] = []
let reminderRun: ReminderRun | undefined
let deliveredByLogTransport = 0

/** A DEL-6 clause. The name is the clause; the offset indexes the recording. */
async function demoStep(name: string, body: () => Promise<void>): Promise<void> {
  marks.push({ step: name, atMs: Date.now() - recordingStartedAt })
  await test.step(name, body)
}

async function openSlots(request: APIRequestContext, providerId: string): Promise<Slot[]> {
  const from = new Date()
  const to = new Date(from)
  to.setDate(to.getDate() + 60)
  const response = await request.get('/api/slots', {
    params: {
      providerId,
      serviceId: E2_BOOK_SERVICE_ID,
      from: from.toISOString(),
      to: to.toISOString(),
    },
  })
  expect(response.status()).toBe(200)
  return (await response.json() as { slots: Slot[] }).slots
}

/** Waits for the booking POST this click provokes and hands back its status. */
async function submitBooking(target: Page): Promise<number> {
  const [response] = await Promise.all([
    target.waitForResponse((candidate) =>
      candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === '/api/appointments'),
    target.getByTestId('book-submit').click(),
  ])
  return response.status()
}

/** service -> provider -> slot, the real /book sequence, up to the confirm. */
async function chooseSlot(target: Page, providerName: string, slotId: string): Promise<void> {
  await target.goto('/book')
  await target.getByTestId('service-select').selectOption(E2_BOOK_SERVICE_ID)
  await target.getByTestId('provider-select').selectOption({ label: providerName })
  await expect(target.getByTestId('slot-list')).toBeVisible()
  await target.locator(`[data-testid="slot-item"][data-slot-id="${slotId}"]`).click()
  await expect(target.getByTestId('book-submit')).toBeVisible()
}

test.describe.serial('JOR-261 — the recorded DEL-6 demo walkthrough', () => {
  // The walkthrough links the seeded patient and edits seeded availability:
  // the same shared, mutable fixture state every identity suite leases.
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))

  test('acceptance: the recorded walkthrough drives every DEL-6 clause, in DEL-6 order', async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(300_000)
    recordingStartedAt = Date.now()
    const recording = page.video()
    expect(recording, 'the demo-walkthrough project must record this run').toBeTruthy()

    expect((await request.post(`${await fixtureUrl()}/__test__/reset-identity`)).ok()).toBe(true)
    expect((await request.post(`${await fixtureUrl()}/__test__/reset-booking`)).ok()).toBe(true)
    expect((await request.post(`${await fixtureUrl()}/__test__/reset-availability`)).ok()).toBe(true)
    await page.setViewportSize(DESKTOP_VIEWPORT)

    const demoEmail = `demo-walkthrough-${randomUUID()}@example.test`
    let imageShare: CreatedShare | undefined
    let reportShare: CreatedShare | undefined

    // ── DEL-6 (1) identity verification -> image viewing -> cine viewing ────
    await demoStep('DEL-6 (1a) patient identity verification', async () => {
      // Registered over the API so the recording opens on the real sign-in
      // form; the password is only ever typed into a password field, which
      // renders dots, and never appears in a URL or in page text.
      expect((await page.request.post('/api/auth/register', {
        data: { email: demoEmail, password: DEMO_PASSWORD },
      })).status()).toBe(201)

      await page.goto('/login')
      await page.getByLabel('Email').fill(demoEmail)
      await page.getByLabel('Password').fill(DEMO_PASSWORD)
      await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page).toHaveURL(/\/appointments$/)

      // The identity gate: an unlinked account asking for studies is sent to
      // /verify, and only the seeded reference and date of birth open it.
      await page.goto('/studies')
      await expect(page).toHaveURL('/verify?next=%2Fstudies')
      await expect(page.getByTestId('identity-form')).toBeVisible()
      await page.getByLabel('Patient reference').fill(DEMO_PATIENT_REF)
      await page.getByLabel('Date of birth').fill(DEMO_PATIENT_DOB)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page).toHaveURL(/\/studies$/)
      await expect(page.getByTestId('study-list')).toBeVisible()
    })

    await demoStep('DEL-6 (1b) image viewing', async () => {
      await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`)
      const viewer = page.getByTestId('image-viewer')
      await expect(viewer).toBeVisible()
      await expect(viewer).toHaveAttribute('data-hydrated', 'true', {
        timeout: IMAGE_VIEWER_READY_TIMEOUT_MS,
      })
    })

    await demoStep('DEL-6 (1c) cine viewing', async () => {
      await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
      await expect(page.getByTestId('cine-viewer')).toBeVisible()
      await expect(page.getByTestId('cine-play')).toBeEnabled()
      await page.getByTestId('cine-play').click()
      await expect(page.getByTestId('cine-play')).toHaveText('Pause')

      // A cine clip is not a shareable resource: createShareSchema admits
      // only 'image' and 'report'. The screen must therefore offer no way to
      // share one — no share control, and no Share affordance of any kind.
      await expect(page.getByTestId('share-create')).toHaveCount(0)
      // Scoped to the clip itself: the shell's "Shares" tab is navigation to
      // the patient's own list, not an action that shares this clip.
      const clip = page.getByTestId('cine-viewer')
      await expect(clip.getByRole('button', { name: /share/i })).toHaveCount(0)
      await expect(clip.getByRole('link', { name: /share/i })).toHaveCount(0)
    })

    // ── DEL-6 (2) secure sharing: an image, a report, then revocation ───────
    await demoStep('DEL-6 (2a) secure sharing of an image', async () => {
      await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`)
      await expect(page.getByTestId('image-viewer')).toBeVisible()
      imageShare = await createShareThroughDialog(page, `image-recipient-${randomUUID()}@example.test`)
      await expectTokenNotOnScreen(page, imageShare)
    })

    await demoStep('DEL-6 (2b) secure sharing of a report', async () => {
      await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
      await expect(page.getByTestId('report-view')).toBeVisible()
      reportShare = await createShareThroughDialog(page, `report-recipient-${randomUUID()}@example.test`)
      await expectTokenNotOnScreen(page, reportShare)
    })

    await demoStep('DEL-6 (2c) revocation on /shares', async () => {
      // The phone segment: /shares on the patient shell, where the bottom
      // tab bar is the navigation.
      await page.setViewportSize(PHONE_VIEWPORT)
      await page.goto('/shares')
      await expect(page.getByTestId('patient-tabbar')).toBeVisible()
      await expect(page.getByTestId('share-list')).toBeVisible()
      await expect(page.getByTestId('share-row')).toHaveCount(2)

      // Neither raw share token may appear away from the screen that issued
      // it — /shares lists the links without ever restating the secret.
      for (const share of [imageShare!, reportShare!]) {
        await expect(page.locator('body')).not.toContainText(tokenOf(share))
      }

      await page.getByTestId('share-revoke').first().click()
      await expect(page.getByTestId('share-revoke')).toHaveCount(1)
      await expect(page.getByText('Revoked', { exact: true })).toHaveCount(1)
      await page.setViewportSize(DESKTOP_VIEWPORT)
    })

    // ── DEL-6 (3) report viewing ───────────────────────────────────────────
    await demoStep('DEL-6 (3) report viewing', async () => {
      await page.goto(`/reports/${E2_SEEDED_REPORT_ID}`)
      const report = page.getByTestId('report-view')
      await expect(report).toBeVisible()
      await expect(report).toContainText('Impression')
    })

    // ── DEL-6 (4) provider availability setup ──────────────────────────────
    await demoStep('DEL-6 (4) provider availability setup', async () => {
      expect((await page.request.post('/api/auth/login', {
        data: { email: E2_PROVIDER_EMAIL, password: E2_PROVIDER_PASSWORD },
      })).status()).toBe(200)
      await page.goto('/provider/availability')
      await expect(page.getByTestId('availability-form')).toBeVisible()
      await page.getByLabel('Slot length in minutes').fill('30')

      // Narrowing Monday's end orphans a booked out-of-hours appointment.
      // ADR-0006: the edit is accepted, the appointment is preserved, and the
      // collision is surfaced rather than silently dropped.
      await page.getByLabel('Monday end 1').fill('15:00')
      const [collisionResponse] = await Promise.all([
        page.waitForResponse((candidate) =>
          candidate.request().method() === 'PATCH' && candidate.url().includes('/availability')),
        page.getByRole('button', { name: 'Save availability' }).click(),
      ])
      expect(collisionResponse.status()).toBe(200)
      await expect(page.getByTestId('availability-collision-list')).toBeVisible()
      await expect(page.getByTestId('availability-collision-list')).toContainText(DEMO_PATIENT_REF)
    })

    // ── DEL-6 (5) patient booking ──────────────────────────────────────────
    await demoStep('DEL-6 (5) patient booking', async () => {
      await signInDemoPatient(page, demoEmail)
      const open = await openSlots(page.request, RACE_PROVIDER_ID)
      expect(open.length, 'the seeded grid must offer slots to book').toBeGreaterThan(1)
      await chooseSlot(page, RACE_PROVIDER_NAME, open[0]!.id)
      expect(await submitBooking(page)).toBe(201)
      await expect(page.getByTestId('booking-success')).toBeVisible()
    })

    // ── DEL-6 (6) the no-double-book behaviour ─────────────────────────────
    await demoStep('DEL-6 (6) the no-double-book behaviour', async () => {
      // Take the grid down to genuinely one open slot, so the race below is a
      // race for the last one.
      let open = await openSlots(page.request, RACE_PROVIDER_ID)
      for (const slot of open.slice(0, -1)) {
        expect((await page.request.post('/api/appointments', {
          data: { slotId: slot.id, serviceId: E2_BOOK_SERVICE_ID, idempotencyKey: randomUUID() },
        })).status()).toBe(201)
      }
      open = await openSlots(page.request, RACE_PROVIDER_ID)
      expect(open, 'exactly one open slot must remain to race for').toHaveLength(1)
      const lastOpenSlot = open[0]!

      // Two live sessions, same patient, same last slot. Both confirm at
      // once; Postgres picks the winner. Nothing here pre-books the slot or
      // narrates an outcome.
      const rival = await context.newPage()
      await chooseSlot(page, RACE_PROVIDER_NAME, lastOpenSlot.id)
      await chooseSlot(rival, RACE_PROVIDER_NAME, lastOpenSlot.id)

      const [mainStatus, rivalStatus] = await Promise.all([
        submitBooking(page),
        submitBooking(rival),
      ])
      expect([mainStatus, rivalStatus].sort(), 'one winner, one clear loser').toEqual([201, 409])

      const loser = mainStatus === 409 ? page : rival
      const winner = mainStatus === 409 ? rival : page
      await expect(loser.getByTestId('booking-conflict')).toHaveText(PINNED_CONFLICT)
      await expect(winner.getByTestId('booking-success')).toBeVisible()
      marks.push({
        step: `DEL-6 (6) race resolved — the ${mainStatus === 409 ? 'recorded' : 'second'} session lost`,
        atMs: Date.now() - recordingStartedAt,
      })

      expect(await openSlots(page.request, RACE_PROVIDER_ID), 'the raced slot is gone').toHaveLength(0)
      await rival.close()
    })

    // ── DEL-6 (7) reschedule and cancel ────────────────────────────────────
    await demoStep('DEL-6 (7a) reschedule', async () => {
      await page.goto('/appointments')
      await expect(page.getByTestId('appointment-list')).toBeVisible()
      // The seeded provider's own grid is untouched by the race above, so it
      // still offers a same-provider slot to move into.
      const target = (await openSlots(page.request, E2_PROVIDER_ID))[0]
      expect(target, 'the seeded provider must still offer a slot to move into').toBeTruthy()

      // Slot lists are per-appointment-provider, so the card must belong to
      // the seeded provider the target slot comes from — not whichever
      // walkthrough-booked appointment happens to sort first.
      const card = page.locator('[data-testid="appointment-item"]:visible')
        .filter({ has: page.getByTestId('appointment-reschedule') })
        .filter({ hasText: 'Dr. Avery Chen' })
        .first()
      await card.getByTestId('appointment-reschedule').click()
      // Opening the panel hides the card's Reschedule button, so the
      // has-reschedule card filter no longer matches; anchor on the panel.
      const panel = page.getByTestId('appointment-reschedule-panel')
      await panel.locator(`[data-testid="slot-item"][data-slot-id="${target!.id}"]`).click()
      const [rescheduled] = await Promise.all([
        page.waitForResponse((candidate) =>
          candidate.request().method() === 'PATCH'
          && new URL(candidate.url()).pathname.startsWith('/api/appointments/')),
        page.getByTestId('appointment-reschedule-confirm').click(),
      ])
      expect(rescheduled.status(), await rescheduled.text()).toBe(200)
    })

    await demoStep('DEL-6 (7b) cancel', async () => {
      const card = page.locator('[data-testid="appointment-item"]:visible')
        .filter({ has: page.getByTestId('appointment-cancel') })
        .first()
      const [cancelled] = await Promise.all([
        page.waitForResponse((candidate) =>
          candidate.request().method() === 'PATCH'
          && new URL(candidate.url()).pathname.startsWith('/api/appointments/')),
        card.getByTestId('appointment-cancel').click(),
      ])
      expect(cancelled.status(), await cancelled.text()).toBe(200)
      // The row that changed, not the first row — the seeded list also holds a
      // locked appointment inside the 24-hour notice window.
      await expect(page.locator('[data-testid="appointment-item"]:visible')
        .filter({ hasText: 'Status: Cancelled' })).toHaveCount(1)
    })

    // ── DEL-6 (8) a reminder being sent ────────────────────────────────────
    await demoStep('DEL-6 (8) a reminder being sent', async () => {
      const before = new Set(await readdir(MAIL_DIR).catch(() => []))
      // The real scheduled job, behind the real shared-secret header. Not a
      // stub, and not a direct call to the transport.
      const dispatch = await page.request.post('/api/jobs/reminders', {
        headers: { 'x-cron-secret': E5_CRON_SECRET },
      })
      expect(dispatch.status()).toBe(200)
      reminderRun = await dispatch.json() as ReminderRun
      expect(reminderRun).toMatchObject({
        due: expect.any(Number),
        sent: expect.any(Number),
        skipped: expect.any(Number),
        failed: expect.any(Number),
      })

      // GAP-3: with no provider key the transport is `log`, which is a real
      // transport — it writes each message to .local/mail. The share emails
      // queued in (2a) and (2b) drain here, which is the delivery this step
      // demonstrates.
      const after = (await readdir(MAIL_DIR).catch(() => []))
        .filter((name) => !before.has(name))
      expect(after.length, 'the log transport must actually deliver').toBeGreaterThan(0)
      deliveredByLogTransport = after.length
      expect((await page.request.post('/api/jobs/reminders')).status(), 'the secret is required').toBe(401)
    })

    // Harvest the timeline beside the recording so docs/demo.md quotes real
    // offsets from a real run rather than estimates.
    await mkdir(ARTIFACT_DIR, { recursive: true })
    await writeFile(TIMELINE_PATH, `${JSON.stringify({
      recordedAt: new Date(recordingStartedAt).toISOString(),
      recording: path.relative(REPO_ROOT, RECORDING_PATH),
      transport: 'log',
      reminderRun,
      deliveredByLogTransport,
      steps: marks,
      totalMs: Date.now() - recordingStartedAt,
    }, null, 2)}\n`)

    await page.close()
    await recording!.saveAs(RECORDING_PATH)
  })
})

function tokenOf(share: CreatedShare): string {
  return new URL(share.url).pathname.replace('/s/', '')
}

/** Opens the share dialog, sends the link, and returns what the API minted. */
async function createShareThroughDialog(target: Page, recipientEmail: string): Promise<CreatedShare> {
  await target.getByTestId('share-create').click()
  await expect(target.getByRole('dialog', { name: 'Share secure link' })).toBeVisible()
  await target.getByLabel('Recipient email').fill(recipientEmail)
  const [response] = await Promise.all([
    target.waitForResponse((candidate) =>
      candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === '/api/shares'),
    target.getByRole('button', { name: 'Send secure link' }).click(),
  ])
  expect(response.status()).toBe(201)
  return await response.json() as CreatedShare
}

/** The issuing screen confirms delivery by recipient, never by secret. */
async function expectTokenNotOnScreen(target: Page, share: CreatedShare): Promise<void> {
  await expect(target.getByText(`Your secure link was sent to ${share.recipientEmail}.`)).toBeVisible()
  await expect(target.locator('body')).not.toContainText(tokenOf(share))
}

async function signInDemoPatient(target: Page, email: string): Promise<void> {
  await target.goto('/login')
  await target.getByLabel('Email').fill(email)
  await target.getByLabel('Password').fill(DEMO_PASSWORD)
  await target.getByRole('button', { name: 'Sign in' }).click()
  await expect(target).toHaveURL(/\/appointments$/)
}

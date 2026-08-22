// JOR-249 — EL-1's Priority-1 regression re-run.
//
// EL-1 (JOR-243) changed how images and cine frames are delivered: a thumbnail
// renders before the full image, the next filmstrip image is prefetched, cine
// frames stream in a bounded read-ahead window, and decoded frames are cached.
// None of that is allowed to cost a Priority-1 acceptance criterion. This spec
// re-asserts every one of them against the running app and its committed
// fixture, so a delivery optimisation that traded correctness for speed fails
// the gate here rather than being written up as a note.
//
// It re-asserts; it does not reinvent. Every criterion below already has a
// primary proof elsewhere (e2-wiring, e3-wiring, verify, studies-list,
// image-viewer, cine-viewer, share-create, share-recipient, playback-frames)
// and this spec deliberately follows those specs' fixtures and idiom.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import { config } from '../lib/config'
import { expectNoPageOverflow, expectTapTarget } from './fixtures/a11y-helpers'
import {
  E2_FOREIGN_CLIP_ID,
  E2_FOREIGN_REPORT_ID,
  E2_FOREIGN_STUDY_ID,
  E2_PERFORMANCE_CLIP_ID,
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_IMAGE_ID,
  E2_SEEDED_STUDY_ID,
  E3_MISSING_CINE_FRAME_INDEX,
  E3_SCHEDULED_STUDY_ID,
  E4_CANCELLED_STUDY_ID,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const PASSWORD = 'CorrectHorseBattery9'
const SEEDED_PATIENT = { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' }
const FIRST_PAINT_DEADLINE_MS = 4_000
let identityFixtureLockToken: string | undefined

async function fakeServerUrl(): Promise<string> {
  const fixture = JSON.parse(await readFile(path.resolve('.local/fake-auth-server.json'), 'utf8')) as { url: string }
  return fixture.url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)).ok()).toBe(true)
}

async function registerAndSignIn(request: APIRequestContext, label: string): Promise<void> {
  const email = `jor-249-${label}-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

async function registerSignInAndVerify(request: APIRequestContext, label: string): Promise<void> {
  await registerAndSignIn(request, label)
  expect((await request.post('/api/identity/verify', { data: SEEDED_PATIENT })).status()).toBe(200)
}

async function verifyAttempt(
  request: APIRequestContext,
  patientRef: string,
  dateOfBirth: string,
  source?: string,
): Promise<{ status: number; text: string }> {
  const response = await request.post('/api/identity/verify', {
    data: { patientRef, dateOfBirth },
    ...(source ? { headers: { 'x-forwarded-for': source } } : {}),
  })
  return { status: response.status(), text: await response.text() }
}

// The fixture advances its own deterministic clock. A wall-clock sleep would
// neither prove five minutes nor be acceptable evidence of the share window.
async function advanceFixtureClock(request: APIRequestContext, milliseconds: number): Promise<void> {
  const sessionToken = (await request.storageState()).cookies.find((cookie) => cookie.name === 'pip_session')?.value
  expect(sessionToken, 'the active test session must expose its HTTP-only cookie to Playwright').toEqual(expect.any(String))
  const response = await request.post(`${await fakeServerUrl()}/__test__/clock`, {
    data: { advanceMs: milliseconds, sessionToken },
  })
  expect(response.status()).toBe(200)
}

async function unavailableText(page: Page): Promise<string> {
  const screen = page.getByTestId('share-unavailable')
  await expect(screen).toBeVisible()
  return screen.innerText()
}

test.describe.serial('JOR-249 EL-1 Priority-1 regression', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetIdentity(request))

  test('regression FR-2: threeFailedAttemptsLockForFiveMinutesBehindOneGenericResponse', async ({ request }) => {
    await registerAndSignIn(request, 'fr2')
    const first = await verifyAttempt(request, 'PT-9999', SEEDED_PATIENT.dateOfBirth)
    const second = await verifyAttempt(request, 'PT-9998', SEEDED_PATIENT.dateOfBirth)
    const third = await verifyAttempt(request, SEEDED_PATIENT.patientRef, '1988-03-16')
    const lockedButCorrect = await verifyAttempt(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)

    expect([first.status, second.status, third.status, lockedButCorrect.status]).toEqual([400, 400, 400, 400])
    // A correct answer during the lock is indistinguishable from a wrong one.
    expect(new Set([first.text, second.text, third.text, lockedButCorrect.text]).size).toBe(1)

    await advanceFixtureClock(request, 4 * 60_000 + 59_000)
    expect((await verifyAttempt(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(400)

    await resetIdentity(request)
    await verifyAttempt(request, 'PT-9999', SEEDED_PATIENT.dateOfBirth)
    await verifyAttempt(request, 'PT-9998', SEEDED_PATIENT.dateOfBirth)
    await verifyAttempt(request, SEEDED_PATIENT.patientRef, '1988-03-16')
    await advanceFixtureClock(request, 5 * 60_000 + 1)
    expect((await verifyAttempt(request, SEEDED_PATIENT.patientRef, SEEDED_PATIENT.dateOfBirth)).status).toBe(200)
  })

  test('regression FR-3: verifiedPatientSeesOnlyOwnCompletedStudies', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'fr3')
    const response = await page.request.get('/api/studies')
    expect(response.status()).toBe(200)
    const studies = (await response.json() as { studies: Array<{ id: string }> }).studies
    const ids = studies.map((study) => study.id)
    expect(ids).toEqual([E2_SEEDED_STUDY_ID])
    expect(ids).not.toContain(E3_SCHEDULED_STUDY_ID)
    expect(ids).not.toContain(E4_CANCELLED_STUDY_ID)
    expect(ids).not.toContain(E2_FOREIGN_STUDY_ID)

    await page.goto('/studies')
    await expect(page.getByTestId('study-list')).toBeVisible()
    await expect(page.getByTestId('study-card')).toHaveCount(1)
    await expect(page.getByText(/scheduled|cancelled|other patient/i)).toHaveCount(0)
  })

  test('regression FR-4: hundredFrameClipPlaysAtManifestDefaultFpsWithUsableControls', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'fr4')
    // The healthy performance clip; the exhaustive no-dropped-frames traversal
    // of all 100 indices stays in e2e/playback-frames.spec.ts, which this
    // ticket re-runs alongside this spec.
    const manifestResponse = await page.request.get(`/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_PERFORMANCE_CLIP_ID}`)
    expect(manifestResponse.status()).toBe(200)
    const manifest = await manifestResponse.json() as { frameCount: number; defaultFps: number }
    expect(manifest.frameCount).toBe(100)

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_PERFORMANCE_CLIP_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    const scrubber = page.getByRole('slider', { name: 'Frame scrubber' })
    await expect(scrubber).toHaveAttribute('aria-valuetext', `Frame 1 of ${manifest.frameCount}`)
    // The control reflects the manifest's own rate, never a literal default.
    await expect(page.getByTestId('cine-fps')).toHaveValue(String(manifest.defaultFps))

    await page.getByTestId('cine-next').click()
    await expect(scrubber).toHaveAttribute('aria-valuetext', `Frame 2 of ${manifest.frameCount}`)
    await page.getByTestId('cine-prev').click()
    await expect(scrubber).toHaveAttribute('aria-valuetext', `Frame 1 of ${manifest.frameCount}`)

    await expect(page.getByTestId('cine-play')).toBeEnabled()
    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await expect(scrubber).not.toHaveAttribute('aria-valuetext', `Frame 1 of ${manifest.frameCount}`)
    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-play')).toHaveText('Play')
  })

  test('regression FR-5: mintedShareCarriesTheConfiguredWindowAndOpensThenRevokes', async ({ browser, page }) => {
    await registerSignInAndVerify(page.request, 'fr5')
    const mintedAt = Date.now()
    const created = await page.request.post('/api/shares', {
      data: { resourceKind: 'image', resourceId: E2_SEEDED_IMAGE_ID, recipientEmail: 'jor-249-recipient@example.test' },
    })
    expect(created.status()).toBe(201)
    const share = await created.json() as { id: string; url: string; expiresAt: string }

    // The stated window, read from configuration rather than written here, so
    // this assertion tracks the requirement instead of restating a number.
    const windowMs = config.shareLinkTtlHours * 60 * 60 * 1_000
    const observedMs = Date.parse(share.expiresAt) - mintedAt
    expect(observedMs).toBeGreaterThan(windowMs - 60_000)
    expect(observedMs).toBeLessThanOrEqual(windowMs + 60_000)

    const recipientContext = await browser.newContext()
    const recipient = await recipientContext.newPage()
    try {
      await recipient.goto(new URL(share.url).pathname)
      await expect(recipient.getByTestId('shared-resource')).toBeVisible()
      expect((await page.request.delete(`/api/shares/${share.id}`)).status()).toBe(204)
      await recipient.reload()
      await unavailableText(recipient)
      await expect(recipient.getByTestId('image-viewer')).toHaveCount(0)
    } finally {
      await recipientContext.close()
    }
  })

  test('regression FR-6: foreignStudyClipAndReportReturn404Never403', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'fr6')
    for (const url of [
      `/api/studies/${E2_FOREIGN_STUDY_ID}`,
      `/api/studies/${E2_FOREIGN_STUDY_ID}/clips/${E2_FOREIGN_CLIP_ID}`,
      `/api/reports/${E2_FOREIGN_REPORT_ID}`,
      `/studies/${E2_FOREIGN_STUDY_ID}`,
    ]) {
      const response = await page.request.get(url)
      expect(response.status(), url).toBe(404)
      expect(response.status(), url).not.toBe(403)
    }
    // A foreign target is concealed as absent; the viewer never half-renders.
    await page.goto(`/studies/${E2_FOREIGN_STUDY_ID}`)
    await expect(page.getByTestId('image-viewer')).toHaveCount(0)
  })

  test('regression EC-1: rejectionNeverNamesTheWrongFieldOrAdmitsALockExists', async ({ page }) => {
    await registerAndSignIn(page.request, 'ec1')
    await page.goto('/verify')
    const rendered: string[] = []
    for (const attempt of [
      { patientRef: 'PT-9999', dateOfBirth: SEEDED_PATIENT.dateOfBirth },
      { patientRef: SEEDED_PATIENT.patientRef, dateOfBirth: '1988-03-16' },
      { patientRef: 'PT-9997', dateOfBirth: '1988-03-17' },
    ]) {
      await page.getByLabel('Patient reference').fill(attempt.patientRef)
      await page.getByLabel('Date of birth').fill(attempt.dateOfBirth)
      await page.getByRole('button', { name: 'Continue' }).click()
      rendered.push(await page.getByTestId('identity-error').innerText())
    }
    expect(new Set(rendered).size, rendered.join(' | ')).toBe(1)
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()

    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toMatch(/locked|lockout|attempts remaining|patient (id|reference) (not found|is wrong)|date of birth (does not|did not) match/i)
  })

  test('regression EC-2: manifestDeclaredGapShowsItsMarkerAndPlaybackContinues', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'ec2')
    const manifestResponse = await page.request.get(`/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    expect(manifestResponse.status()).toBe(200)
    const payload = await manifestResponse.json() as { frames: Array<{ index: number; available: boolean }> }
    // The gap is declared by the API, not inferred from a failed fetch. EL-1's
    // bounded window and frame cache must not have changed that.
    expect(payload.frames[E3_MISSING_CINE_FRAME_INDEX]).toEqual({
      index: E3_MISSING_CINE_FRAME_INDEX,
      available: false,
    })

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    await page.getByRole('slider', { name: 'Frame scrubber' }).fill(String(E3_MISSING_CINE_FRAME_INDEX))
    await expect(page.getByTestId('cine-frame-gap')).toHaveText(`Frame ${E3_MISSING_CINE_FRAME_INDEX} unavailable`)
    await expect(page.getByTestId('cine-play')).toBeEnabled()
    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-frame-gap')).toHaveCount(0)
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
  })

  test('regression EC-3: thumbnailAndLoadingStateArriveBeforeTheFullImage', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'ec3')
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    await session.send('Network.emulateNetworkConditionsByRule', {
      offline: false,
      matchedNetworkConditions: [{
        urlPattern: `${await fakeServerUrl()}/storage/v1/object/sign/phi/full-*`,
        latency: 400,
        downloadThroughput: 16 * 1024,
        uploadThroughput: 16 * 1024,
      }],
    })
    try {
      await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('image-viewer')).toBeVisible()
      // EL-1's thumbnail-first render: something is on screen, and the UI says
      // so, while the full image is still in flight.
      const thumbnail = page.getByTestId('image-thumbnail')
      await expect.poll(
        () => thumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
        { timeout: FIRST_PAINT_DEADLINE_MS },
      ).toBe(true)
      await expect(page.getByTestId('image-loading')).toHaveText('Loading full image…')
      // Controls stay live rather than freezing on the full download. The
      // viewer must be hydrated before a click means anything.
      await expect(page.getByTestId('image-viewer')).toHaveAttribute('data-hydrated', 'true')
      await expect(page.getByTestId('zoom-in')).toBeEnabled()
      await page.getByTestId('zoom-in').click()
      await expect(page.getByTestId('zoom-level')).not.toHaveText('Zoom 100%')
      await expect(page.getByTestId('image-full')).toBeVisible({ timeout: 30_000 })
    } finally {
      await session.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [] })
    }
  })

  test('regression EC-4: smallViewportKeepsTapTargetsAndOrientationPreservesPlayback', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await registerSignInAndVerify(page.request, 'ec4')
    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_PERFORMANCE_CLIP_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('cine-viewer')).toBeVisible()

    for (const control of ['cine-play', 'cine-next', 'cine-prev']) {
      await expectTapTarget(page.getByTestId(control))
    }
    await expectNoPageOverflow(page)

    await page.getByTestId('cine-next').click()
    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.getByRole('slider', { name: 'Frame scrubber' })).not.toHaveAttribute('aria-valuetext', 'Frame 1 of 100')
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await expect(page.getByTestId('cine-fps')).toBeVisible()
  })

  test('regression EC-5: expiredRevokedAndUnknownShareLinksRenderOneIdenticalScreen', async ({ browser, page }) => {
    await registerSignInAndVerify(page.request, 'ec5')
    const mint = async (): Promise<{ id: string; url: string }> => {
      const response = await page.request.post('/api/shares', {
        data: { resourceKind: 'image', resourceId: E2_SEEDED_IMAGE_ID, recipientEmail: 'jor-249-ec5@example.test' },
      })
      expect(response.status()).toBe(201)
      return await response.json() as { id: string; url: string }
    }
    const expiring = await mint()
    const revoking = await mint()

    const recipientContext = await browser.newContext()
    const recipient = await recipientContext.newPage()
    try {
      // Both links work first, so "unavailable" proves expiry and revocation
      // rather than a link that never resolved.
      await recipient.goto(new URL(expiring.url).pathname)
      await expect(recipient.getByTestId('shared-resource')).toBeVisible()

      expect((await page.request.post(`${await fakeServerUrl()}/__test__/expire-share`, {
        data: { shareId: expiring.id },
      })).status()).toBe(200)
      await recipient.reload()
      const expiredScreen = await unavailableText(recipient)
      await expect(recipient.getByTestId('image-viewer')).toHaveCount(0)
      await expect(recipient.getByTestId('shared-resource')).toHaveCount(0)

      await recipient.goto(new URL(revoking.url).pathname)
      await expect(recipient.getByTestId('shared-resource')).toBeVisible()
      expect((await page.request.delete(`/api/shares/${revoking.id}`)).status()).toBe(204)
      await recipient.reload()
      expect(await unavailableText(recipient)).toBe(expiredScreen)

      await recipient.goto(`/s/${randomUUID()}`)
      expect(await unavailableText(recipient)).toBe(expiredScreen)
    } finally {
      await recipientContext.close()
    }
  })
})

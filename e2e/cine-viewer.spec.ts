import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page, Route } from '@playwright/test'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const STUDY_ID = '99669966-9966-4966-8966-996699669966'
const CLIP_ID = 'ee11ee11-ee11-4e11-8e11-ee11ee11ee11'
const PASSWORD = 'CorrectHorseBattery9'
const SEEDED_DATE_OF_BIRTH = '1988-03-14'

type SeededPatient = { patientRef: string; dateOfBirth: string }

type Manifest = {
  id: string
  frameCount: number
  defaultFps: number
  expiresAt: string
  frames: Array<
    | { index: number; url: string; available: true }
    | { index: number; url?: null; available: false }
  >
}

function manifest(frames: Manifest['frames'], defaultFps = 17): Manifest {
  return { id: CLIP_ID, frameCount: frames.length, defaultFps, expiresAt: '2026-08-16T12:00:00.000Z', frames }
}

let identityFixtureLockToken: string | undefined
let seededPatient: SeededPatient

// EL-1 (JOR-243). The bound the viewer states for itself, read from the
// component rather than copied here, so the two can never drift apart.
const CINE_FRAME_WINDOW = Number(
  /export const CINE_FRAME_WINDOW = (\d+)/.exec(
    readFileSync(path.join(REPO_ROOT, 'components/imaging/CineViewer.tsx'), 'utf8'),
  )?.[1],
)

// The viewer's own fetch for the frame on screen and the `<img>` element
// showing it are the same URL, so a browser that does not coalesce them can
// account for one extra request. Nothing else is allowed above the window.
const FRAME_WINDOW_ALLOWANCE = 1

const FRAME_URL_PATTERN = '**/el1-frame-*.png'
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg==',
  'base64',
)

function heldFrameClip(frameCount: number): Manifest['frames'] {
  return Array.from({ length: frameCount }, (_, index) => ({
    index,
    available: true as const,
    url: `/el1-frame-${index}.png`,
  }))
}

/** Intercepts every frame request and holds it until released, so "how many
 *  are in flight at once" is directly observable rather than inferred. */
function holdFrames(page: Page): { started: () => number; inFlight: () => number; release: () => Promise<void> } {
  let started = 0
  const pending: Route[] = []
  void page.route(FRAME_URL_PATTERN, (route) => {
    started += 1
    pending.push(route)
  })
  return {
    started: () => started,
    inFlight: () => pending.length,
    release: async () => {
      for (const route of pending.splice(0, pending.length)) {
        await route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG })
      }
    },
  }
}

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<SeededPatient> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  expect(response.ok()).toBe(true)
  const fixture = (await response.json()) as { patientRef?: unknown }
  expect(fixture.patientRef).toEqual(expect.any(String))
  return { patientRef: fixture.patientRef as string, dateOfBirth: SEEDED_DATE_OF_BIRTH }
}

async function signInLinkedPatient(request: APIRequestContext, patient: SeededPatient): Promise<void> {
  const email = `cine-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  const verification = await request.post('/api/identity/verify', {
    data: patient,
    headers: { 'x-forwarded-for': '192.0.2.214' },
  })
  expect(verification.status(), await verification.text()).toBe(200)
}

async function openClip(page: Page, payload: Manifest): Promise<void> {
  const apiPattern = `**/api/studies/${STUDY_ID}/clips/${CLIP_ID}`
  await page.unroute(apiPattern)
  await page.route(apiPattern, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) }),
  )
  await page.goto(`/studies/${STUDY_ID}/clips/${CLIP_ID}`)
  await expect(page.getByTestId('cine-viewer')).toBeVisible()
}

test.describe.serial('cine viewer', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => {
    seededPatient = await resetIdentity(request)
  })

  test('setup regression: leasedIdentityFixture_resetAndRealVerifyRouteLinkCurrentSeed', async ({ request }) => {
    await signInLinkedPatient(request, seededPatient)
    const state = (await (await request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json()) as {
      patients: Array<{ patient_ref: string; user_id: string | null }>
    }
    expect(state.patients.find((patient) => patient.patient_ref === seededPatient.patientRef)?.user_id).toEqual(
      expect.any(String),
    )
  })

  test('mandatory adversarial: apiDrivenGaps_continuePlaybackWithCorrectDenominatorAndMarkers', async ({ page }) => {
    await signInLinkedPatient(page.request, seededPatient)
    await openClip(page, manifest([
      { index: 0, available: true, url: '/missing-cine-frame.svg' },
      { index: 1, available: false },
    ], 1))
    await expect(page.getByRole('status', { name: 'Loading frame…' })).toBeVisible()
    await expect(page.locator('.cine-viewer__frame')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.cine-viewer__frame img')).toHaveCount(1)
    await expect(page.getByTestId('cine-frame-gap')).toHaveCount(0)
    await expect(page.getByText('1 of 2 frames unavailable — playback continues', { exact: true })).toBeVisible()
    await expect(page.locator('.cine-controls__gap-markers i')).toHaveCount(1)
    await expect(page.getByTestId('cine-prev')).toBeEnabled()
    await expect(page.getByTestId('cine-play')).toBeEnabled()
    await expect(page.getByTestId('cine-next')).toBeEnabled()
    await expect(page.getByTestId('cine-fps')).toBeEnabled()
    await page.getByTestId('cine-next').click()
    await expect(page.getByTestId('cine-frame-gap')).toHaveText('Frame 1 unavailable')

    await openClip(page, manifest([
      { index: 0, available: false },
      { index: 1, available: false },
      { index: 2, available: false },
    ], 1))
    await expect(page.getByTestId('cine-frame-gap')).toHaveText('Frame 0 unavailable')
    await expect(page.getByText('3 of 3 frames unavailable — playback continues', { exact: true })).toBeVisible()
    await expect(page.locator('.cine-controls__gap-markers i')).toHaveCount(3)
    await page.getByTestId('cine-play').click()
    await expect(page.getByText('Frame 1 unavailable', { exact: true })).toBeVisible()
  })

  test('mandatory adversarial: defaultFps_nonOverlayControls_noShareAndOrientationPreservesState', async ({ page }) => {
    await signInLinkedPatient(page.request, seededPatient)
    await openClip(page, manifest([
      { index: 0, available: true, url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' },
      { index: 1, available: true, url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' },
    ], 17))
    await expect(page.getByTestId('cine-fps')).toHaveValue('17')
    await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0)
    await page.getByTestId('cine-next').click()
    await page.getByTestId('cine-fps').selectOption('24')
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.getByText('Frame 2 of 2', { exact: true })).toBeVisible()
    await expect(page.getByTestId('cine-fps')).toHaveValue('24')
    await page.getByTestId('cine-play').click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await expect(page.getByTestId('cine-fps')).toHaveValue('24')
    const frame = await page.locator('.cine-viewer__frame').boundingBox()
    const controls = await page.locator('.cine-controls').boundingBox()
    expect(controls!.y).toBeGreaterThanOrEqual(frame!.y + frame!.height)
  })

  test('mandatory adversarial: hundredFrameClip_keepsFramesInFlightInsideTheStatedWindow', async ({ page }) => {
    await signInLinkedPatient(page.request, seededPatient)
    expect(CINE_FRAME_WINDOW).toBeGreaterThan(0)
    expect(CINE_FRAME_WINDOW).toBeLessThan(100)
    const frames = holdFrames(page)

    await openClip(page, manifest(heldFrameClip(100), 1))

    // Phase one — the frame on screen is fetched alone. Nothing else may
    // compete with the first frame a reader is waiting for.
    await expect.poll(frames.started, { timeout: 15_000 }).toBeGreaterThan(0)
    await expect(page.getByRole('status', { name: 'Loading frame…' })).toBeVisible()
    expect(frames.inFlight()).toBeLessThanOrEqual(1 + FRAME_WINDOW_ALLOWANCE)

    // Phase two — with the first frame settled, the viewer reads ahead of the
    // playhead, and stops at the window it states. A viewer that asked for
    // every frame at once would sit at 100 here.
    await frames.release()
    await expect.poll(frames.inFlight, { timeout: 15_000 }).toBeGreaterThan(1)
    expect(frames.inFlight()).toBeLessThanOrEqual(CINE_FRAME_WINDOW + FRAME_WINDOW_ALLOWANCE)
    expect(frames.started()).toBeLessThan(100)

    // And it keeps draining: each released window is refilled, never
    // exceeded, until the whole clip is loaded and playback is ready.
    for (let round = 0; round < 60 && frames.started() < 100; round++) {
      await frames.release()
      await page.waitForTimeout(50)
      expect(frames.inFlight()).toBeLessThanOrEqual(CINE_FRAME_WINDOW + FRAME_WINDOW_ALLOWANCE)
    }
    expect(frames.started()).toBe(100)
    await frames.release()
    await expect(page.getByTestId('cine-viewer')).toHaveAttribute('data-playback-ready', 'true', { timeout: 30_000 })
    await expect(page.getByTestId('cine-viewer')).toHaveAttribute('data-frame-cache-size', '100')
    await expect(page.getByTestId('cine-play')).toBeEnabled()
  })

  test('mandatory adversarial: loadedFrames_areCachedInTheViewerAndNeverRefetchedOnRevisit', async ({ page }) => {
    await signInLinkedPatient(page.request, seededPatient)
    const frames = holdFrames(page)
    await openClip(page, manifest(heldFrameClip(4), 1))
    for (let round = 0; round < 10 && (frames.started() < 4 || frames.inFlight() > 0); round++) {
      await frames.release()
      await page.waitForTimeout(100)
    }
    await frames.release()
    await expect(page.getByTestId('cine-viewer')).toHaveAttribute('data-frame-cache-size', '4', { timeout: 15_000 })
    const afterFirstPass = frames.started()
    expect(afterFirstPass).toBeLessThanOrEqual(4 + FRAME_WINDOW_ALLOWANCE)

    // Ground already covered costs nothing: stepping back and forth over
    // cached frames issues no request at all.
    for (const control of ['cine-next', 'cine-next', 'cine-prev', 'cine-next', 'cine-prev', 'cine-prev']) {
      await page.getByTestId(control).click()
    }
    await expect(page.getByRole('slider', { name: 'Frame scrubber' })).toHaveAttribute('aria-valuetext', 'Frame 1 of 4')
    expect(frames.started()).toBe(afterFirstPass)
    await expect(page.getByRole('status', { name: 'Loading frame…' })).toHaveCount(0)
  })

  test('mandatory adversarial: failedFrameFetches_neverBecomeGapsTheManifestDidNotDeclare', async ({ page }) => {
    await signInLinkedPatient(page.request, seededPatient)
    // Every frame is declared available and every fetch for it fails. The
    // viewer may show nothing, but it may never invent a gap: gaps come from
    // the manifest, never from a failed or slow fetch (EC-2).
    await page.route(FRAME_URL_PATTERN, (route) => route.fulfill({ status: 404, body: '' }))
    await openClip(page, manifest(heldFrameClip(6), 1))

    await expect(page.getByRole('status', { name: 'Loading frame…' })).toBeVisible()
    await expect(page.getByTestId('cine-frame-gap')).toHaveCount(0)
    await expect(page.locator('.cine-controls__gap-markers i')).toHaveCount(0)
    await expect(page.getByText('frames unavailable — playback continues')).toHaveCount(0)
    await expect(page.getByRole('slider', { name: 'Frame scrubber' })).toHaveAttribute('aria-valuetext', 'Frame 1 of 6')
    for (const control of ['cine-prev', 'cine-next', 'cine-fps']) {
      await expect(page.getByTestId(control)).toBeEnabled()
    }
    await page.getByTestId('cine-next').click()
    await expect(page.getByTestId('cine-frame-gap')).toHaveCount(0)

    // The same six frames, one of them declared unavailable: now — and only
    // now — there is a gap, with the denominator counted from the manifest.
    await openClip(page, manifest(
      heldFrameClip(6).map((frame) => (frame.index === 2 ? { index: 2, available: false as const } : frame)),
      1,
    ))
    await expect(page.getByText('1 of 6 frames unavailable — playback continues', { exact: true })).toBeVisible()
    await expect(page.locator('.cine-controls__gap-markers i')).toHaveCount(1)
    await page.getByRole('slider', { name: 'Frame scrubber' }).fill('2')
    await expect(page.getByTestId('cine-frame-gap')).toHaveText('Frame 2 unavailable')
  })

  test('mandatory adversarial: noFrameOrPosterFetch_startsBeforeTheAuthorizedManifestReturns', async ({ page }) => {
    await signInLinkedPatient(page.request, seededPatient)
    const frames = holdFrames(page)
    let releaseManifest = (): void => {}
    const manifestReleased = new Promise<void>((resolve) => { releaseManifest = resolve })
    const apiPattern = `**/api/studies/${STUDY_ID}/clips/${CLIP_ID}`
    await page.unroute(apiPattern)
    await page.route(apiPattern, async (route) => {
      await manifestReleased
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(manifest(heldFrameClip(8), 1)) })
    })

    await page.goto(`/studies/${STUDY_ID}/clips/${CLIP_ID}`)
    await expect(page.getByText('Loading cine clip…', { exact: true })).toBeVisible()
    // The grant has not returned, so there is no URL to prefetch and nothing
    // may be requested — a viewer that guessed at storage URLs would show up
    // here as a request before the manifest it was supposedly built from.
    await page.waitForTimeout(750)
    expect(frames.started()).toBe(0)

    releaseManifest()
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    await expect.poll(frames.started, { timeout: 15_000 }).toBeGreaterThan(0)
  })

  test('mandatory adversarial: keyboardAccessibleTouchSizedAt390AndNoHardcodedHex', async ({ page }) => {
    await signInLinkedPatient(page.request, seededPatient)
    await page.setViewportSize({ width: 390, height: 844 })
    await openClip(page, manifest([
      { index: 0, available: false },
      { index: 1, available: false },
    ]))
    await expect(page.locator('h1')).toHaveCount(1)
    await page.getByTestId('cine-next').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('cine-frame-gap')).toHaveText('Frame 1 unavailable')
    await expect(page.getByRole('button', { name: 'Previous frame' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Play playback' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next frame' })).toBeVisible()
    await expect(page.getByRole('slider', { name: 'Frame scrubber' })).toHaveAttribute('aria-valuetext', 'Frame 2 of 2')
    await expect(page.getByRole('combobox', { name: 'Playback rate' })).toBeVisible()
    for (const control of [
      page.getByTestId('cine-prev'),
      page.getByTestId('cine-play'),
      page.getByTestId('cine-next'),
      page.getByRole('slider', { name: 'Frame scrubber' }),
      page.getByTestId('cine-fps'),
    ]) {
      const box = await control.boundingBox()
      expect(box!.width).toBeGreaterThanOrEqual(44)
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    for (const file of [
      'app/(patient)/studies/[studyId]/clips/[clipId]/page.tsx',
      'components/imaging/CineViewer.tsx',
      'components/imaging/CineControls.tsx',
    ]) {
      const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
      expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(source).not.toMatch(/share|signStorageKeys/i)
    }
  })
})

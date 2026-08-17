// JOR-231 — E3's end-to-end acceptance proof. This intentionally drives the
// running app against its committed fixture; it does not replace routes,
// manifests, storage, or time with test doubles.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  E2_FOREIGN_CLIP_ID,
  E2_FOREIGN_STUDY_ID,
  E2_SEEDED_CLIP_ID,
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
let identityFixtureLockToken: string | undefined

async function resetIdentity(request: APIRequestContext): Promise<void> {
  // The test-only hook lives on the committed fake Supabase service, not the
  // app. The browser still exercises the real app and its storage client.
  const fixture = JSON.parse(await readFile(path.resolve('.local/fake-auth-server.json'), 'utf8')) as { url: string }
  expect((await request.post(`${fixture.url}/__test__/reset-identity`)).ok()).toBe(true)
}

async function registerSignInAndVerify(request: APIRequestContext): Promise<void> {
  const email = `jor-231-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await request.post('/api/identity/verify', { data: SEEDED_PATIENT })).status()).toBe(200)
}

async function registerAndSignInUnlinked(request: APIRequestContext): Promise<void> {
  const email = `jor-231-unlinked-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

async function openSeededClip(page: Page): Promise<void> {
  await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('cine-viewer')).toBeVisible()
}

test.describe.serial('JOR-231 E3 imaging wiring', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetIdentity(request))

  test('acceptance: verifiedPatientSeesOnlyOwnCompletedStudies', async ({ page }) => {
    await registerSignInAndVerify(page.request)
    const response = await page.request.get('/api/studies')
    expect(response.status()).toBe(200)
    const studies = ((await response.json()) as { studies: Array<{ id: string }> }).studies
    expect(studies.map((study) => study.id)).toEqual([E2_SEEDED_STUDY_ID])
    expect(studies.map((study) => study.id)).not.toContain(E3_SCHEDULED_STUDY_ID)
    expect(studies.map((study) => study.id)).not.toContain(E4_CANCELLED_STUDY_ID)
    expect(studies.map((study) => study.id)).not.toContain(E2_FOREIGN_STUDY_ID)

    await page.goto('/studies')
    await expect(page.getByTestId('study-card')).toHaveCount(1)
    await expect(page.getByTestId('study-card')).toContainText('Seeded abdominal ultrasound')
    await expect(page.getByText(/scheduled seeded|cancelled seeded|other patient/i)).toHaveCount(0)
  })

  test('acceptance: stillImageSupportsZoomAndPan', async ({ page }) => {
    await registerSignInAndVerify(page.request)
    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`)
    const canvas = page.getByTestId('image-canvas')
    await expect(canvas).toBeVisible()
    await page.getByTestId('zoom-in').click()
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 125%')
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + 40, box!.y + 40)
    await page.mouse.down()
    await page.mouse.move(box!.x + 72, box!.y + 58)
    await page.mouse.up()
    await expect(page.getByTestId('image-thumbnail')).toHaveAttribute('style', /translate\(32px, 18px\) scale\(1.25\)/)
  })

  test('acceptance: hundredFrameCinePlaysAtDefaultRateWithUsableControls', async ({ page }) => {
    await registerSignInAndVerify(page.request)
    const manifest = await page.request.get(`/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    expect(manifest.status()).toBe(200)
    expect((await manifest.json()) as unknown).toEqual(expect.objectContaining({ frameCount: 100, defaultFps: 24 }))
    await openSeededClip(page)
    await expect(page.getByTestId('cine-fps')).toHaveValue('24')
    await page.getByTestId('cine-next').click()
    await expect(page.getByRole('slider', { name: 'Frame scrubber' })).toHaveAttribute('aria-valuetext', 'Frame 2 of 100')
    await page.getByTestId('cine-prev').click()
    await expect(page.getByRole('slider', { name: 'Frame scrubber' })).toHaveAttribute('aria-valuetext', 'Frame 1 of 100')
    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await expect(page.getByRole('slider', { name: 'Frame scrubber' })).not.toHaveAttribute('aria-valuetext', 'Frame 1 of 100')
    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-play')).toHaveText('Play')
    await page.getByTestId('cine-fps').selectOption('30')
    await expect(page.getByTestId('cine-fps')).toHaveValue('30')
  })

  test('mandatory adversarial: corruptManifestClipShowsGapMarkerAndNeverCrashesViewer', async ({ page }) => {
    await registerSignInAndVerify(page.request)
    const manifest = await page.request.get(`/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    expect(manifest.status()).toBe(200)
    const payload = (await manifest.json()) as { frames: Array<{ index: number; available: boolean }> }
    expect(payload.frames[E3_MISSING_CINE_FRAME_INDEX]).toEqual({ index: E3_MISSING_CINE_FRAME_INDEX, available: false })
    await openSeededClip(page)
    await page.getByRole('slider', { name: 'Frame scrubber' }).fill(String(E3_MISSING_CINE_FRAME_INDEX))
    await expect(page.getByTestId('cine-frame-gap')).toHaveText(`Frame ${E3_MISSING_CINE_FRAME_INDEX} unavailable`)
    await expect(page.getByTestId('cine-play')).toBeEnabled()
    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-frame-gap')).toHaveCount(0)
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
  })

  test('mandatory adversarial: throttledConnectionKeepsLoadingStateAndControlsResponsive', async ({ page }) => {
    await registerSignInAndVerify(page.request)
    // Warm the real cine route with a denied target before measuring delivery.
    // This loads its Next.js chunk without caching the owned manifest or any
    // frame resource named by the acceptance criterion.
    await page.goto(`/studies/${E2_FOREIGN_STUDY_ID}/clips/${E2_FOREIGN_CLIP_ID}`)
    await expect(page.getByText('This cine clip is unavailable.', { exact: true })).toBeVisible()
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    const fixture = JSON.parse(await readFile(path.resolve('.local/fake-auth-server.json'), 'utf8')) as { url: string }
    const limitedConnection = {
      latency: 400,
      downloadThroughput: 16 * 1024,
      uploadThroughput: 16 * 1024,
    }
    await session.send('Network.emulateNetworkConditionsByRule', {
      offline: false,
      matchedNetworkConditions: [
        { urlPattern: `${new URL(page.url()).origin}/api/studies/*/clips/*`, ...limitedConnection },
        { urlPattern: `${fixture.url}/storage/v1/object/sign/phi/*`, ...limitedConnection },
      ],
    })
    try {
      await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('Loading cine clip…', { exact: true })).toBeVisible()
      await expect(page.getByTestId('cine-viewer')).toBeVisible()
      await expect(page.getByRole('status', { name: 'Loading frame…' })).toBeVisible()
      await expect(page.getByTestId('cine-next')).toBeEnabled()
      await page.getByTestId('cine-next').click()
      await expect(page.getByRole('slider', { name: 'Frame scrubber' })).toHaveAttribute('aria-valuetext', 'Frame 2 of 100')
    } finally {
      await session.send('Network.emulateNetworkConditionsByRule', {
        offline: false,
        matchedNetworkConditions: [],
      })
    }
  })

  test('mandatory adversarial: foreignStudyImageOrClipUrlReturns404Never403', async ({ page }) => {
    await registerSignInAndVerify(page.request)
    for (const url of [
      `/api/studies/${E2_FOREIGN_STUDY_ID}`,
      `/api/studies/${E2_FOREIGN_STUDY_ID}/clips/${E2_FOREIGN_CLIP_ID}`,
      `/studies/${E2_FOREIGN_STUDY_ID}`,
    ]) {
      const response = await page.goto(url)
      expect(response?.status(), url).toBe(404)
    }
  })

  test('mandatory adversarial: unlinkedAccountImagingEndpointsNeverReturn200', async ({ request }) => {
    await registerAndSignInUnlinked(request)
    for (const url of [
      '/api/studies',
      `/api/studies/${E2_SEEDED_STUDY_ID}`,
      `/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`,
    ]) {
      const response = await request.get(url)
      expect(response.status(), url).not.toBe(200)
      expect(response.status(), url).toBe(403)
    }
  })

  test('mandatory adversarial: rotateAt390PreservesPlayback', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await registerSignInAndVerify(page.request)
    await openSeededClip(page)
    await page.getByTestId('cine-next').click()
    await page.getByTestId('cine-play').click()
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.getByRole('slider', { name: 'Frame scrubber' })).not.toHaveAttribute('aria-valuetext', 'Frame 1 of 100')
    await expect(page.getByTestId('cine-play')).toHaveText('Pause')
    await expect(page.getByTestId('cine-fps')).toBeVisible()
  })
})

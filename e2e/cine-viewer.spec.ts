import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const STUDY_ID = '99669966-9966-4966-8966-996699669966'
const CLIP_ID = 'ee11ee11-ee11-4e11-8e11-ee11ee11ee11'
const PASSWORD = 'CorrectHorseBattery9'

type Manifest = {
  id: string
  frameCount: number
  defaultFps: number
  expiresAt: string
  frames: Array<{ index: number; available: boolean; url?: string }>
}

function manifest(frames: Manifest['frames'], defaultFps = 17): Manifest {
  return { id: CLIP_ID, frameCount: frames.length, defaultFps, expiresAt: '2026-08-16T12:00:00.000Z', frames }
}

async function resetIdentity(page: Page): Promise<void> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  const url = (JSON.parse(raw) as { url: string }).url
  expect((await page.request.post(`${url}/__test__/reset-identity`)).status()).toBe(200)
}

async function signInLinkedPatient(page: Page): Promise<void> {
  const email = `cine-${randomUUID()}@example.test`
  expect((await page.request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await page.request.post('/api/identity/verify', { data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' } })).status()).toBe(200)
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
  test.beforeEach(async ({ page }) => {
    await resetIdentity(page)
  })

  test('mandatory adversarial: apiDrivenGaps_continuePlaybackWithCorrectDenominatorAndMarkers', async ({ page }) => {
    await signInLinkedPatient(page)
    await openClip(page, manifest([
      { index: 0, available: true, url: '/missing-cine-frame.svg' },
      { index: 1, available: false },
    ], 1))
    await expect(page.getByText('Loading frame…', { exact: true })).toBeVisible()
    await expect(page.locator('.cine-viewer__frame img')).toHaveCount(1)
    await expect(page.getByTestId('cine-frame-gap')).toHaveCount(0)
    await expect(page.getByText('1 of 2 frames unavailable — playback continues', { exact: true })).toBeVisible()
    await expect(page.locator('.cine-controls__gap-markers i')).toHaveCount(1)

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
    await signInLinkedPatient(page)
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

  test('mandatory adversarial: keyboardAccessibleTouchSizedAt390AndNoHardcodedHex', async ({ page }) => {
    await signInLinkedPatient(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await openClip(page, manifest([{ index: 0, available: false }, { index: 1, available: false }]))
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

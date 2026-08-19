import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { E2_SEEDED_CLIP_ID, E2_SEEDED_STUDY_ID } from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'PlaybackPatientPassword9'
let identityFixtureLockToken: string | undefined

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function signInLinkedPatient(request: APIRequestContext): Promise<void> {
  const reset = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  const patient = await reset.json() as { patientRef: string }
  const email = `playback-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await request.post('/api/identity/verify', {
    data: { patientRef: patient.patientRef, dateOfBirth: '1988-03-14' },
    headers: { 'x-forwarded-for': '192.0.2.221' },
  })).status()).toBe(200)
}

type Manifest = { frameCount: number; defaultFps: number }

test.describe.serial('JOR-221 100-frame playback', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))

  test('manifestDefaultFpsPlaysEveryFrameIndexWithoutDrops', async ({ page }) => {
    test.setTimeout(30_000)
    await signInLinkedPatient(page.request)
    const clipPath = `/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`
    const manifestResponse = await page.request.get(clipPath)
    expect(manifestResponse.status()).toBe(200)
    const manifest = await manifestResponse.json() as Manifest
    expect(manifest.frameCount).toBe(100)

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    await expect(page.getByTestId('cine-fps')).toHaveValue(String(manifest.defaultFps))

    const seen: number[] = []
    await page.exposeFunction('recordPlaybackFrame', (frame: number) => seen.push(frame))
    await page.locator('.cine-controls__counter').evaluate((counter) => {
      const record = () => {
        const frame = Number(counter.textContent?.match(/Frame (\d+) of/)?.[1])
        if (Number.isInteger(frame)) void (globalThis as unknown as { recordPlaybackFrame: (value: number) => Promise<void> }).recordPlaybackFrame(frame)
      }
      record()
      new MutationObserver(record).observe(counter, { childList: true, characterData: true, subtree: true })
    })

    await page.getByTestId('cine-play').click()
    await expect.poll(() => seen.includes(manifest.frameCount), {
      timeout: Math.ceil((manifest.frameCount / manifest.defaultFps + 3) * 1000),
    }).toBe(true)
    await page.getByTestId('cine-play').click()
    expect(seen.slice(0, manifest.frameCount)).toEqual(Array.from({ length: manifest.frameCount }, (_, index) => index + 1))
  })
})

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page, Request } from '@playwright/test'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PLAYBACK_LIVE = process.env.PLAYBACK_LIVE === '1'
const PASSWORD = 'PlaybackPatientPassword9'
let identityFixtureLockToken: string | undefined

type Manifest = {
  frameCount: number
  defaultFps: number
  frames: Array<{ index: number; available: boolean; url: string | null }>
}

type PlaybackSample = { frame: number; renderedFrame: number | null; at: number }

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function signInPatient(request: APIRequestContext): Promise<void> {
  if (PLAYBACK_LIVE) {
    const response = await request.post('/api/auth/login', {
      data: {
        email: process.env.PATIENT_EMAIL ?? 'patient@demo.pip.test',
        password: process.env.PATIENT_PASSWORD ?? 'DemoPass!2026',
      },
    })
    expect(response.status(), await response.text()).toBe(200)
    return
  }

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

async function healthyClip(request: APIRequestContext): Promise<{ studyId: string; clipId: string; manifest: Manifest }> {
  const studiesResponse = await request.get('/api/studies')
  expect(studiesResponse.status(), await studiesResponse.text()).toBe(200)
  const studies = (await studiesResponse.json() as { studies: Array<{ id: string }> }).studies
  if (studies.length === 0) throw new Error('seeded dataset has no visible studies')

  for (const study of studies) {
    const detailResponse = await request.get(`/api/studies/${study.id}`)
    if (detailResponse.status() !== 200) continue
    const detail = await detailResponse.json() as { clips?: Array<{ id: string; frameCount: number }> }
    for (const clip of detail.clips ?? []) {
      if (clip.frameCount !== 100) continue
      const manifestResponse = await request.get(`/api/studies/${study.id}/clips/${clip.id}`)
      if (manifestResponse.status() !== 200) continue
      const manifest = await manifestResponse.json() as Manifest
      if (manifest.frames.length === manifest.frameCount && manifest.frames.every((frame) => frame.available && frame.url)) {
        return { studyId: study.id, clipId: clip.id, manifest }
      }
    }
  }
  throw new Error('seeded dataset has no healthy 100-frame cine clip')
}

function observeFrameConcurrency(page: Page): { result: () => { completed: number; maximum: number }; stop: () => void } {
  const tracked = new Set<Request>()
  let completed = 0
  let maximum = 0
  const begin = (request: Request): void => {
    if (request.resourceType() !== 'image') return
    tracked.add(request)
    maximum = Math.max(maximum, tracked.size)
  }
  const finish = (request: Request): void => {
    if (!tracked.delete(request)) return
    completed += 1
  }
  page.on('request', begin)
  page.on('requestfinished', finish)
  page.on('requestfailed', finish)
  return {
    result: () => ({ completed, maximum }),
    stop: () => {
      page.off('request', begin)
      page.off('requestfinished', finish)
      page.off('requestfailed', finish)
    },
  }
}

test.describe.serial('JOR-221 100-frame playback', () => {
  test.beforeAll(async () => {
    if (PLAYBACK_LIVE) return
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => {
    if (!PLAYBACK_LIVE) await releaseIdentityFixtureLock(identityFixtureLockToken)
  })

  test('manifestDefaultFpsRendersEveryFrameIndexWithoutDrops', async ({ page }) => {
    test.setTimeout(PLAYBACK_LIVE ? 90_000 : 45_000)
    await signInPatient(page.request)
    const target = await healthyClip(page.request)
    expect(target.manifest.frameCount).toBe(100)

    const concurrency = observeFrameConcurrency(page)
    await page.goto(`/studies/${target.studyId}/clips/${target.clipId}`)
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    await expect(page.getByTestId('cine-fps')).toHaveValue(String(target.manifest.defaultFps))
    await expect(page.getByTestId('cine-viewer')).toHaveAttribute('data-playback-ready', 'true', { timeout: 30_000 })
    const preload = concurrency.result()
    concurrency.stop()
    expect(preload.completed).toBeGreaterThanOrEqual(target.manifest.frameCount)
    expect(preload.maximum).toBeGreaterThan(0)
    test.info().annotations.push({ type: 'frame-preload-concurrency', description: String(preload.maximum) })
    console.log(JSON.stringify({ op: 'playback.preload', frames: preload.completed, maxConcurrency: preload.maximum }))

    await page.evaluate(() => {
      const slider = document.querySelector<HTMLInputElement>('input[aria-label="Frame scrubber"]')
      const frameContainer = document.querySelector<HTMLElement>('.cine-viewer__frame')
      if (!slider || !frameContainer) throw new Error('cine playback observer could not find the viewer')
      const samples: PlaybackSample[] = []
      const playbackWindow = window as typeof window & { __jor221Playback?: { observer: MutationObserver; samples: PlaybackSample[] } }
      const record = (): void => {
        const frame = Number(slider.getAttribute('aria-valuetext')?.match(/Frame (\d+) of/)?.[1])
        const image = frameContainer.querySelector<HTMLImageElement>('img')
        const renderedFrame = image?.complete && image.naturalWidth > 0
          ? Number(image.dataset.frameIndex) + 1
          : null
        samples.push({ frame, renderedFrame, at: performance.now() })
      }
      record()
      const observer = new MutationObserver(record)
      observer.observe(slider, { attributes: true, attributeFilter: ['aria-valuetext'] })
      playbackWindow.__jor221Playback = { observer, samples }
    })

    await expect(page.getByTestId('cine-play')).toBeEnabled()
    await page.getByTestId('cine-play').click()
    await expect.poll(
      () => page.evaluate(() => {
        const playbackWindow = window as typeof window & { __jor221Playback?: { samples: PlaybackSample[] } }
        return playbackWindow.__jor221Playback?.samples.length ?? 0
      }),
      { timeout: Math.ceil((target.manifest.frameCount / target.manifest.defaultFps + 4) * 1_000) },
    ).toBeGreaterThan(target.manifest.frameCount)
    await page.getByTestId('cine-play').click()

    const samples = await page.evaluate(() => {
      const playbackWindow = window as typeof window & { __jor221Playback?: { observer: MutationObserver; samples: PlaybackSample[] } }
      if (!playbackWindow.__jor221Playback) throw new Error('cine playback observer was not installed')
      playbackWindow.__jor221Playback.observer.disconnect()
      return playbackWindow.__jor221Playback.samples
    })
    const firstCycle = samples.slice(0, target.manifest.frameCount + 1)
    expect(firstCycle.map(({ frame }) => frame)).toEqual(
      Array.from({ length: target.manifest.frameCount + 1 }, (_, index) => (index % target.manifest.frameCount) + 1),
    )
    expect(firstCycle.slice(0, target.manifest.frameCount).map(({ renderedFrame }) => renderedFrame)).toEqual(
      Array.from({ length: target.manifest.frameCount }, (_, index) => index + 1),
    )
    const expectedCycleMs = target.manifest.frameCount / target.manifest.defaultFps * 1_000
    const observedCycleMs = firstCycle.at(-1)!.at - firstCycle[0]!.at
    expect(observedCycleMs).toBeGreaterThan(expectedCycleMs * 0.75)
    expect(observedCycleMs).toBeLessThan(expectedCycleMs * 1.5)
  })
})

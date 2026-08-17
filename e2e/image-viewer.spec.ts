import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { E2_FOREIGN_STUDY_ID, E2_SEEDED_STUDY_ID } from './fixtures/fake-auth-server'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'
const SEEDED_PATIENT = { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' }
const IDENTITY_FIXTURE_LOCK = path.join(REPO_ROOT, '.local', 'identity-fixture.lock')
const FIRST_IMAGE_ID = '10000000-0000-4000-8000-000000000001'
const SECOND_IMAGE_ID = '10000000-0000-4000-8000-000000000002'
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

let imageServer: Server
let imageServerUrl: string

async function source(file: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, file), 'utf8')
}

async function acquireIdentityFixture(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await mkdir(IDENTITY_FIXTURE_LOCK)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('identity fixture lock timed out')
}

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  expect(response.ok()).toBe(true)
}

async function registerAndSignIn(request: APIRequestContext): Promise<void> {
  const email = `jor-211-${randomUUID()}@example.com`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

async function linkSeededPatient(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/identity/verify', { data: SEEDED_PATIENT })
  expect(response.status()).toBe(200)
}

async function pointViewerToManifest(page: Page): Promise<void> {
  const forwarded = new URL(imageServerUrl)
  await page.setExtraHTTPHeaders({
    'x-forwarded-host': forwarded.host,
    'x-forwarded-proto': forwarded.protocol.slice(0, -1),
  })
}

function holdImage(page: Page, filename: string): { requested: () => boolean; release: () => void } {
  let requested = false
  let releaseRequest = () => {}
  const released = new Promise<void>((resolve) => { releaseRequest = resolve })
  void page.route(`**/${filename}`, async (route) => {
    requested = true
    await released
    await route.fulfill({ body: ONE_PIXEL_PNG, contentType: 'image/png' })
  })
  return { requested: () => requested, release: releaseRequest }
}

async function openViewer(page: Page): Promise<void> {
  await resetIdentity(page.request)
  await registerAndSignIn(page.request)
  await linkSeededPatient(page.request)
  await pointViewerToManifest(page)
  await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('image-viewer')).toBeVisible()
  await expect(page.getByTestId('image-viewer')).toHaveAttribute('data-hydrated', 'true')
}

test.describe('JOR-211 image viewer acceptance and mandatory adversarial coverage', () => {
  test.beforeAll(async () => {
    await acquireIdentityFixture()
    imageServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://image-fixture.local')
      if (url.pathname === `/api/studies/${E2_SEEDED_STUDY_ID}`) {
        const expiresAt = new Date(Date.now() + 300_000).toISOString()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          description: 'Progressive image viewer fixture',
          images: [
            {
              id: FIRST_IMAGE_ID,
              width: 1024,
              height: 768,
              ordinal: 1,
              url: `${imageServerUrl}/full-1.png`,
              thumbUrl: `${imageServerUrl}/thumb-1.png`,
              expiresAt,
            },
            {
              id: SECOND_IMAGE_ID,
              width: 800,
              height: 600,
              ordinal: 2,
              url: `${imageServerUrl}/full-2.png`,
              thumbUrl: null,
              expiresAt,
            },
          ],
        }))
        return
      }
      if (url.pathname === '/thumb-1.png' || url.pathname === '/full-1.png' || url.pathname === '/full-2.png') {
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end(ONE_PIXEL_PNG)
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve, reject) => {
      imageServer.once('error', reject)
      imageServer.listen(0, '127.0.0.1', () => {
        const address = imageServer.address()
        if (address === null || typeof address === 'string') return reject(new Error('image fixture has no TCP port'))
        imageServerUrl = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
  })

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => imageServer.close((error) => error ? reject(error) : resolve()))
    await rm(IDENTITY_FIXTURE_LOCK, { recursive: true, force: true })
  })

  test('pinnedContract_preservesVariantsImageMetadataInitialImageAndZoomPanControls', async function pinnedContract_preservesVariantsImageMetadataInitialImageAndZoomPanControls() {
    const viewer = await source('components/imaging/ImageViewer.tsx')
    for (const field of ['id: string', 'width: number', 'height: number', 'ordinal: number', 'url: string', 'thumbUrl: string | null', 'expiresAt: string']) {
      expect(viewer).toContain(field)
    }
    expect(viewer).toContain('initialImageId?: string')
    expect(viewer).toContain("variant: 'portal' | 'shared'")
    expect(viewer).toContain('data-testid="image-viewer"')
    expect(viewer).toContain('data-testid="image-zoom"')
    expect(viewer).toContain('images.find((image) => image.id === initialImageId)?.id ?? images[0]?.id')
    expect(viewer).toContain('Date.parse(selected.expiresAt)')
    expect(viewer).toContain('window.setTimeout(router.refresh')
  })

  test('throttledFullImage_keepsEveryControlInteractiveUntilReplacement', async function throttledFullImage_keepsEveryControlInteractiveUntilReplacement({ page }) {
    const heldFullImage = holdImage(page, 'full-1.png')
    await openViewer(page)
    try {
      await expect.poll(heldFullImage.requested).toBe(true)
      await expect(page.getByTestId('image-thumbnail')).toBeVisible()
      await expect(page.getByTestId('image-loading')).toHaveText('Loading full image…')
      await expect(page.getByTestId('image-full')).toHaveCSS('opacity', '0')

      for (const testId of ['zoom-out', 'zoom-reset', 'zoom-in']) {
        await expect(page.getByTestId(testId)).toBeEnabled()
      }
      await page.getByTestId('zoom-in').click()
      await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 125%')
      await page.getByTestId('image-canvas').focus()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByTestId('image-thumbnail')).toHaveAttribute('style', /translate\(24px, 0px\) scale\(1.25\)/)

      heldFullImage.release()
      await expect(page.getByTestId('image-full')).toHaveCSS('opacity', '1')
      await expect(page.getByTestId('image-loading')).toHaveCount(0)
      await expect(page.getByTestId('image-thumbnail')).toHaveCount(0)
    } finally {
      heldFullImage.release()
    }
  })

  test('nullThumbnail_showsLabelledLoadingNeverBrokenImage', async function nullThumbnail_showsLabelledLoadingNeverBrokenImage({ page }) {
    const heldSecondImage = holdImage(page, 'full-2.png')
    await openViewer(page)
    try {
      await page.getByTestId(`filmstrip-image-${SECOND_IMAGE_ID}`).click()
      await expect.poll(heldSecondImage.requested).toBe(true)
      await expect(page.getByTestId('image-thumbnail')).toHaveCount(0)
      await expect(page.getByTestId('image-loading')).toHaveText('Loading full image…')
      await expect(page.getByTestId('image-full')).toHaveCSS('opacity', '0')
      await expect(page.getByTestId(`filmstrip-image-${SECOND_IMAGE_ID}`)).toContainText('Loading image 2 thumbnail')
    } finally {
      heldSecondImage.release()
    }
  })

  test('zoomPanReset_workByPointerTouchAndKeyboard', async function zoomPanReset_workByPointerTouchAndKeyboard({ page }) {
    await openViewer(page)
    const canvas = page.getByTestId('image-canvas')
    const thumbnail = page.getByTestId('image-thumbnail')

    await page.getByTestId('zoom-in').click()
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 125%')
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2 + 32, box!.y + box!.height / 2 + 18)
    await page.mouse.up()
    await expect(thumbnail).toHaveAttribute('style', /translate\(32px, 18px\) scale\(1.25\)/)

    await canvas.focus()
    await page.keyboard.press('+')
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 150%')
    await page.keyboard.press('ArrowLeft')
    await expect(thumbnail).toHaveAttribute('style', /translate\(8px, 18px\) scale\(1.5\)/)
    await page.keyboard.press('0')
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 100%')
    await expect(thumbnail).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/)

    await canvas.dispatchEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, pointerId: 41, pointerType: 'touch' })
    await canvas.dispatchEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 100, pointerId: 42, pointerType: 'touch' })
    await canvas.dispatchEvent('pointermove', { bubbles: true, clientX: 240, clientY: 100, pointerId: 42, pointerType: 'touch' })
    await expect(page.getByTestId('zoom-level')).not.toHaveText('Zoom 100%')
    await canvas.dispatchEvent('pointerup', { bubbles: true, clientX: 100, clientY: 100, pointerId: 41, pointerType: 'touch' })
    await canvas.dispatchEvent('pointerup', { bubbles: true, clientX: 240, clientY: 100, pointerId: 42, pointerType: 'touch' })
    await page.getByTestId('zoom-reset').click()
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 100%')
  })

  test('selectionAndZoom_surviveOrientationChange', async function selectionAndZoom_surviveOrientationChange({ page }) {
    await page.setViewportSize({ width: 390, height: 844 })
    await openViewer(page)
    await page.getByTestId(`filmstrip-image-${SECOND_IMAGE_ID}`).click()
    await page.getByTestId('zoom-in').click()
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 125%')
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.getByTestId(`filmstrip-image-${SECOND_IMAGE_ID}`)).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('zoom-level')).toHaveText('Zoom 125%')
  })

  test('mobile390_controlsRemain44pxAndBodyNeverScrollsHorizontally', async function mobile390_controlsRemain44pxAndBodyNeverScrollsHorizontally({ page }) {
    await page.setViewportSize({ width: 390, height: 844 })
    await openViewer(page)
    for (const control of await page.locator('[data-testid="image-zoom"] button, [data-testid="image-filmstrip"] button').all()) {
      const box = await control.boundingBox()
      expect(box?.width).toBeGreaterThanOrEqual(44)
      expect(box?.height).toBeGreaterThanOrEqual(44)
      await expect(control).toHaveAccessibleName(/.+/)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('foreignStudy_returns404Never403OrPartialViewer', async function foreignStudy_returns404Never403OrPartialViewer({ page }) {
    await resetIdentity(page.request)
    await registerAndSignIn(page.request)
    await linkSeededPatient(page.request)
    const apiResponse = await page.request.get(`/api/studies/${E2_FOREIGN_STUDY_ID}`, { maxRedirects: 0 })
    expect(apiResponse.status()).toBe(404)
    expect(apiResponse.status()).not.toBe(403)
    const pageResponse = await page.goto(`/studies/${E2_FOREIGN_STUDY_ID}`)
    expect(pageResponse?.status()).toBe(404)
    await expect(page.getByTestId('image-viewer')).toHaveCount(0)
  })

  test('unlinkedAccount_redirectsToEncodedVerifyPath', async function unlinkedAccount_redirectsToEncodedVerifyPath({ page }) {
    await resetIdentity(page.request)
    await registerAndSignIn(page.request)
    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`)
    await expect(page).toHaveURL(`/verify?next=%2Fstudies%2F${E2_SEEDED_STUDY_ID}`)
    await expect(page.getByTestId('image-viewer')).toHaveCount(0)
  })

  test('page_hasExactlyOneHeadingAndEveryControlHasAName', async function page_hasExactlyOneHeadingAndEveryControlHasAName({ page }) {
    await openViewer(page)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Progressive image viewer fixture')
    for (const control of await page.locator('button, [role="application"]').all()) {
      await expect(control).toHaveAccessibleName(/.+/)
    }
  })

  test('sharedVariant_exposesOnlyZoomAndPanNoFilmstripShareOrSiblingLinks', async function sharedVariant_exposesOnlyZoomAndPanNoFilmstripShareOrSiblingLinks() {
    const viewer = await source('components/imaging/ImageViewer.tsx')
    expect(viewer).toContain("variant === 'portal' && <Filmstrip")
    expect(viewer).not.toMatch(/<Filmstrip[^>]+variant\s*===\s*['"]shared['"]/)
    expect(viewer).not.toMatch(/<a\b|<Link\b|href=|Share image|Sibling study/)
    expect(viewer).not.toContain("variant === 'portal' && <button aria-label=\"Reset zoom to 100%\"")
  })

  test('viewerComponents_useThemeTokensNeverHardcodedHex', async function viewerComponents_useThemeTokensNeverHardcodedHex() {
    const viewer = await source('components/imaging/ImageViewer.tsx')
    const filmstrip = await source('components/imaging/Filmstrip.tsx')
    expect(viewer).toContain('background: var(--pip-color-base-content)')
    expect(viewer).not.toContain('.pip-image-viewer--portal .pip-image-canvas')
    expect(viewer).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(filmstrip).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  test('viewerComponents_neverConstructOrSignUrls', async function viewerComponents_neverConstructOrSignUrls() {
    for (const file of [
      'components/imaging/ImageViewer.tsx',
      'components/imaging/Filmstrip.tsx',
      'app/(patient)/studies/[studyId]/page.tsx',
    ]) {
      const contents = await source(file)
      expect(contents).not.toMatch(/createSignedUrl|createSignedUrls|signStorage|storage\/v1|new URL\([^)]*image/i)
    }
  })
})

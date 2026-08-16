import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

async function source(file: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, file), 'utf8')
}

test.describe('JOR-211 image viewer acceptance and adversarial coverage', () => {
  test('viewerAndZoomTestIds_pointerKeyboardPanAndReset', async function viewerAndZoomTestIds_pointerKeyboardPanAndReset() {
    const viewer = await source('components/imaging/ImageViewer.tsx')
    for (const id of ['image-viewer', 'zoom-out', 'zoom-reset', 'zoom-in', 'zoom-level']) expect(viewer).toContain(`data-testid=\"${id}\"`)
    expect(viewer).toContain('onPointerMove')
    expect(viewer).toContain("event.key === 'ArrowLeft'")
    expect(viewer).toContain("event.key === '0'")
    expect(viewer).toContain('onDoubleClick')
  })

  test('portalSharedBehaviourAndInitialSelection', async function portalSharedBehaviourAndInitialSelection() {
    const viewer = await source('components/imaging/ImageViewer.tsx')
    expect(viewer).toContain("variant === 'portal' && <Filmstrip")
    expect(viewer).toContain("images.find((image) => image.id === initialImageId)?.id ?? images[0]?.id")
    expect(viewer).toContain("variant: 'portal' | 'shared'")
  })

  test('thumbnailFirstNullThumbnailAndInteractiveFullImageLoading', async function thumbnailFirstNullThumbnailAndInteractiveFullImageLoading() {
    const viewer = await source('components/imaging/ImageViewer.tsx')
    expect(viewer).toContain('selected?.thumbUrl &&')
    expect(viewer).toContain('Loading full image…')
    expect(viewer).toContain('onLoad={() => setFullLoaded(true)}')
    expect(viewer).not.toContain('disabled={!fullLoaded}')
  })

  test('themeSurroundMobileOrientationAndMinimumTargets', async function themeSurroundMobileOrientationAndMinimumTargets() {
    const viewer = await source('components/imaging/ImageViewer.tsx')
    const filmstrip = await source('components/imaging/Filmstrip.tsx')
    expect(viewer).toContain('background: var(--pip-color-base-content)')
    expect(viewer).toContain('min-width: var(--pip-tap-target)')
    expect(viewer).toContain('@media (max-width: 390px)')
    expect(filmstrip).toContain('min-width: var(--pip-tap-target)')
    expect(viewer).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(filmstrip).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  test('accessOutcomesFocusableNamedControlsAndNoSigning', async function accessOutcomesFocusableNamedControlsAndNoSigning() {
    const page = await source('app/(patient)/studies/[studyId]/page.tsx')
    const viewer = await source('components/imaging/ImageViewer.tsx')
    expect(page).toContain('/api/studies/${studyId}')
    expect(page).toContain('response.status === 403')
    expect(page).toContain('response.status === 404')
    expect(page).not.toMatch(/createSignedUrl|signStorage|storage\/v1/)
    expect(viewer).toContain('aria-label="Zoom out"')
    expect(viewer).toContain('type="button"')
    expect((page.match(/<h1>/g) ?? [])).toHaveLength(1)
  })
})

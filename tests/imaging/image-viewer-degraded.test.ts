import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

import { ImageViewer } from '../../components/imaging/ImageViewer'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

describe('ImageViewer degraded state', () => {
  test('individually missing images do not report a dependency outage', () => {
    vi.stubGlobal('React', React)
    const images = [{
      id: 'image-1', width: 640, height: 480, ordinal: 1,
      url: null, thumbUrl: null, expiresAt: '2026-08-20T18:00:00.000Z',
    }]

    const html = renderToStaticMarkup(React.createElement(ImageViewer, { images, variant: 'portal' }))

    expect(html).not.toContain('Images are temporarily unavailable… your data is safe')
    expect(html).not.toContain('Try again')
  })

  test('batch signing outage replaces permanent loading with recoverable copy', () => {
    vi.stubGlobal('React', React)
    const images = [{
      id: 'image-1', width: 640, height: 480, ordinal: 1,
      url: null, thumbUrl: null, expiresAt: '2026-08-20T18:00:00.000Z',
    }]

    const html = renderToStaticMarkup(React.createElement(ImageViewer, { images, signingFailed: true, variant: 'portal' }))

    expect(html).toContain('Images are temporarily unavailable… your data is safe')
    expect(html).toContain('Try again')
    expect(html).not.toContain('Loading full image…')
  })
})

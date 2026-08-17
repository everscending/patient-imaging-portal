import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { createShare, presentationForViewport, ShareDialogPanel } from '../../components/share/ShareDialog'

const noop = vi.fn()

function renderPanel(overrides: Partial<Parameters<typeof ShareDialogPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ShareDialogPanel, {
      onClose: noop,
      onCopyLink: noop,
      onRecipientEmailChange: noop,
      onSubmit: noop,
      presentation: 'dialog',
      recipientEmail: 'specialist@example.com',
      shareLinkTtlHours: 48,
      state: { kind: 'form' },
      submitting: false,
      validationError: null,
      ...overrides,
    }),
  )
}

describe('ShareDialog', () => {
  it('renders one named recipient-email control and named focusable actions', () => {
    const html = renderPanel()

    expect(html).toMatch(/role="dialog"/)
    expect(html).toContain('aria-labelledby="share-dialog-title"')
    expect(html.match(/name="recipientEmail"/g)).toHaveLength(1)
    expect(html).toContain('<label for="share-recipient-email">Recipient email</label>')
    expect(html).toContain('aria-label="Close share dialog"')
    expect(html).toContain('aria-label="Send secure link"')
  })

  it('displays recipient-email validation accessibly', () => {
    const html = renderPanel({ recipientEmail: 'not-an-email', validationError: 'Enter a valid recipient email address.' })

    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="share-recipient-email-error"')
    expect(html).toContain('id="share-recipient-email-error"')
    expect(html).toContain('role="alert"')
  })

  it('renders a desktop dialog and mobile sheet selection', () => {
    expect(presentationForViewport(false)).toBe('dialog')
    expect(renderPanel({ presentation: presentationForViewport(false) })).toContain('data-presentation="dialog"')
    expect(presentationForViewport(true)).toBe('sheet')
    expect(renderPanel({ presentation: presentationForViewport(true) })).toContain('data-presentation="sheet"')
  })

  it('states the configured TTL and revocation terminology', () => {
    const html = renderPanel({ shareLinkTtlHours: 72 })

    expect(html).toContain('expires after 72 hours')
    expect(html).toContain('Revoke it at any time')
    expect(html).not.toMatch(/Cancel|Delete/)
  })

  it('keeps the raw share token out of a delivered success state', () => {
    const rawUrl = 'https://portal.example/s/raw-share-token'
    const html = renderPanel({ recipientEmail: 'specialist@example.com', state: { kind: 'success' } })

    expect(html).toContain('Your secure link was sent to specialist@example.com.')
    expect(html).not.toContain(rawUrl)
    expect(html).not.toContain('raw-share-token')
  })

  it('keeps the active-link copy fallback when delivery fails', () => {
    const rawUrl = 'https://portal.example/s/raw-share-token'
    const html = renderPanel({ state: { kind: 'delivery-failed', url: rawUrl } })

    expect(html).toContain('Delivery failed, but your secure link is active.')
    expect(html).toContain(`value="${rawUrl}"`)
    expect(html).toContain('aria-label="Copy active share link"')
  })

  it('posts only the pinned recipient-email create payload', async () => {
    const request = vi.fn().mockResolvedValue({
      json: async () => ({ url: 'https://portal.example/s/raw-share-token' }),
      ok: true,
    })

    await expect(createShare({ resourceKind: 'report', resourceId: 'report-123', recipientEmail: 'specialist@example.com' }, request)).resolves.toEqual({ kind: 'success' })
    expect(request).toHaveBeenCalledWith('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceKind: 'report', resourceId: 'report-123', recipientEmail: 'specialist@example.com' }),
    })
  })

  it('returns the active-link fallback only for a delivery failure', async () => {
    const rawUrl = 'https://portal.example/s/raw-share-token'
    const request = vi.fn().mockResolvedValue({
      json: async () => ({ delivery: 'failed', url: rawUrl }),
      ok: true,
    })

    await expect(createShare({ resourceKind: 'image', resourceId: 'image-123', recipientEmail: 'specialist@example.com' }, request)).resolves.toEqual({ kind: 'delivery-failed', url: rawUrl })
  })
})

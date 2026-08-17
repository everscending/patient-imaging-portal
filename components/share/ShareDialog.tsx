'use client'

import React, { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

export type ShareResourceKind = 'image' | 'report'

export type ShareDialogProps = {
  resourceKind: ShareResourceKind
  resourceId: string
  /** Pass `config.shareLinkTtlHours` from the server component that mounts this control. */
  shareLinkTtlHours: number
  triggerLabel?: string
}

type Presentation = 'dialog' | 'sheet'
type CreatedShare = { id: string; url: string; expiresAt: string; recipientEmail: string; delivery?: 'failed' }
type ShareState =
  | { kind: 'form' }
  | { kind: 'success' }
  | { kind: 'delivery-failed'; url: string }

type ShareCreateResult = Extract<ShareState, { kind: 'success' | 'delivery-failed' }>

export function presentationForViewport(isMobile: boolean): Presentation {
  return isMobile ? 'sheet' : 'dialog'
}

export type ShareDialogPanelProps = {
  presentation: Presentation
  shareLinkTtlHours: number
  recipientEmail: string
  validationError: string | null
  submitting: boolean
  state: ShareState
  onClose: () => void
  onRecipientEmailChange: (email: string) => void
  onSubmit: () => void
  onCopyLink: (url: string) => void
}

/**
 * Keep the JOR-220 request shape at the component seam. A caller only needs
 * to decide where to mount the dialog and which resource it represents.
 */
export async function createShare(
  input: Pick<ShareDialogProps, 'resourceKind' | 'resourceId'> & { recipientEmail: string },
  request: typeof fetch = fetch,
): Promise<ShareCreateResult> {
  const response = await request('/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Partial<CreatedShare> & { message?: string }
  if (!response.ok) {
    throw new Error(body.message ?? 'The secure link could not be created. Try again.')
  }
  return body.delivery === 'failed' && typeof body.url === 'string' ? { kind: 'delivery-failed', url: body.url } : { kind: 'success' }
}

export function ShareDialogPanel({
  presentation,
  shareLinkTtlHours,
  recipientEmail,
  validationError,
  submitting,
  state,
  onClose,
  onRecipientEmailChange,
  onSubmit,
  onCopyLink,
}: ShareDialogPanelProps) {
  const titleId = `share-${presentation}-title`
  const descriptionId = `share-${presentation}-description`

  return (
    <div className={`pip-share-backdrop pip-share-backdrop--${presentation}`}>
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`pip-share-${presentation}`}
        data-presentation={presentation}
        role="dialog"
      >
        <div className="pip-share-heading">
          <h2 id={titleId}>Share secure link</h2>
          <button aria-label="Close share dialog" className="pip-button-secondary" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <p id={descriptionId} className="pip-notice">
          This link expires after {shareLinkTtlHours} hours and you can Revoke it at any time.
        </p>

        {state.kind === 'success' ? (
          <div aria-live="polite" className="pip-share-outcome">
            <p>Your secure link was sent to {recipientEmail}.</p>
          </div>
        ) : state.kind === 'delivery-failed' ? (
          <div aria-live="assertive" className="pip-share-outcome pip-share-outcome--warning" role="alert">
            <p>Delivery failed, but your secure link is active. Copy the active link to share it another way.</p>
            <label className="pip-field" htmlFor="active-share-link">
              Active share link
              <input className="pip-input" id="active-share-link" readOnly type="url" value={state.url} />
            </label>
            <button aria-label="Copy active share link" className="pip-button-primary" onClick={() => onCopyLink(state.url)} type="button">
              Copy active link
            </button>
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault()
              onSubmit()
            }}
          >
            <div className="pip-field">
              <label htmlFor="share-recipient-email">Recipient email</label>
              <input
                aria-describedby={validationError === null ? undefined : 'share-recipient-email-error'}
                aria-invalid={validationError === null ? undefined : true}
                autoComplete="email"
                className="pip-input"
                id="share-recipient-email"
                name="recipientEmail"
                onChange={(event) => onRecipientEmailChange(event.target.value)}
                required
                type="email"
                value={recipientEmail}
              />
              {validationError === null ? null : <p className="pip-error" id="share-recipient-email-error" role="alert">{validationError}</p>}
            </div>
            <button aria-label="Send secure link" className="pip-button-primary" disabled={submitting} type="submit">
              {submitting ? 'Sending secure link…' : 'Send secure link'}
            </button>
          </form>
        )}
      </section>
    </div>
  )
}

export function ShareDialog({ resourceKind, resourceId, shareLinkTtlHours, triggerLabel = 'Share' }: ShareDialogProps) {
  const [open, setOpen] = useState(false)
  const [presentation, setPresentation] = useState<Presentation>('dialog')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [state, setState] = useState<ShareState>({ kind: 'form' })

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const updatePresentation = () => setPresentation(presentationForViewport(query.matches))
    updatePresentation()
    query.addEventListener('change', updatePresentation)
    return () => query.removeEventListener('change', updatePresentation)
  }, [])

  function close(): void {
    setOpen(false)
    setRecipientEmail('')
    setValidationError(null)
    setState({ kind: 'form' })
  }

  async function submit(): Promise<void> {
    const trimmedEmail = recipientEmail.trim()
    setValidationError(null)
    setSubmitting(true)
    try {
      const created = await createShare({ resourceKind, resourceId, recipientEmail: trimmedEmail })
      setRecipientEmail(trimmedEmail)
      setState(created)
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'The secure link could not be created. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function copyLink(url: string): Promise<void> {
    await navigator.clipboard?.writeText(url)
  }

  return (
    <>
      <button aria-haspopup="dialog" className="pip-button-secondary" data-testid="share-create" onClick={() => setOpen(true)} type="button">
        {triggerLabel}
      </button>
      {open ? (
        <ShareDialogPanel
          onClose={close}
          onCopyLink={(url) => { void copyLink(url) }}
          onRecipientEmailChange={(email) => {
            setRecipientEmail(email)
            if (validationError !== null) setValidationError(null)
          }}
          onSubmit={() => { void submit() }}
          presentation={presentation}
          recipientEmail={recipientEmail}
          shareLinkTtlHours={shareLinkTtlHours}
          state={state}
          submitting={submitting}
          validationError={validationError}
        />
      ) : null}
    </>
  )
}

'use client'

import { useEffect, useState, type JSX } from 'react'

import { ImageViewer, type ImageViewerProps } from '../imaging/ImageViewer'
import { ReportView, type ReportViewProps } from '../../lib/reports/ReportView'

const unavailableCopy = 'This link is no longer available. Secure links expire and can be revoked by the person who shared them. Ask them to send a new one.'

type ShareResponse =
  | { resourceKind: 'image'; payload: ImageViewerProps['images'][number]; expiresAt: string }
  | { resourceKind: 'report'; payload: ReportViewProps['report']; expiresAt: string }

function timeRemaining(expiresAt: string): string {
  const milliseconds = Date.parse(expiresAt) - Date.now()
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'less than a minute remaining'
  const minutes = Math.ceil(milliseconds / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} remaining`
  const hours = Math.ceil(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'} remaining`
}

function Unavailable(): JSX.Element {
  return (
    <main className="pip-shared-resource" data-testid="share-unavailable">
      <h1>Link unavailable</h1>
      <p>{unavailableCopy}</p>
    </main>
  )
}

export function SharedResource({ token }: { token: string }): JSX.Element {
  const [share, setShare] = useState<ShareResponse | null>()

  useEffect(() => {
    let active = true
    void fetch(`/api/s/${encodeURIComponent(token)}`, { cache: 'no-store' }).then(async (response) => {
      if (!active) return
      if (!response.ok) {
        setShare(null)
        return
      }
      const body = await response.json() as ShareResponse
      setShare(body.resourceKind === 'image' || body.resourceKind === 'report' ? body : null)
    }).catch(() => {
      if (active) setShare(null)
    })
    return () => { active = false }
  }, [token])

  if (share === undefined) return <main className="pip-shared-resource"><p role="status">Opening secure link…</p></main>
  if (share === null) return <Unavailable />

  return (
    <main className="pip-shared-resource" data-testid="shared-resource">
      <aside aria-label="Secure shared link" className="pip-shared-banner">
        <p>A patient shared this link with you. It is time-limited, and use is recorded.</p>
        <p aria-live="polite">{timeRemaining(share.expiresAt)}.</p>
      </aside>
      {share.resourceKind === 'image' ? (
        <ImageViewer images={[share.payload]} variant="shared" />
      ) : (
        <ReportView report={share.payload} variant="shared" />
      )}
      <style jsx>{`
        .pip-shared-resource { width: min(100%, 72rem); margin: 0 auto; padding: 1rem; box-sizing: border-box; }
        .pip-shared-banner { margin-bottom: 1rem; padding: 0.75rem 1rem; border: 1px solid var(--pip-color-base-300); border-radius: 0.5rem; background: var(--pip-color-base-100); }
        .pip-shared-banner p { margin: 0; }
        .pip-shared-banner p + p { margin-top: 0.25rem; }
      `}</style>
    </main>
  )
}

export { unavailableCopy }

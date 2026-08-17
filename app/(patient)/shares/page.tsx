'use client'

import { useEffect, useState } from 'react'

type ShareState = 'active' | 'expired' | 'revoked'

type Share = {
  id: string
  resourceKind: 'image' | 'report'
  resourceId: string
  recipientEmail: string
  expiresAt: string
  revokedAt: string | null
  state: ShareState
}

function stateLabel(state: ShareState): string {
  return state === 'active' ? 'Active' : state === 'expired' ? 'Expired' : 'Revoked'
}

function remainingTime(expiresAt: string): string {
  const milliseconds = Date.parse(expiresAt) - Date.now()
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'Expires soon'
  const minutes = Math.ceil(milliseconds / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} remaining`
  const hours = Math.ceil(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'} remaining`
}

export default function SharesPage() {
  const [shares, setShares] = useState<Share[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await fetch('/api/shares', { cache: 'no-store' })
        if (!response.ok) throw new Error('Shares are temporarily unavailable.')
        const body = await response.json() as { shares?: Share[] }
        if (active) setShares(Array.isArray(body.shares) ? body.shares : [])
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Shares are temporarily unavailable.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [])

  async function revoke(id: string): Promise<void> {
    setRevokingId(id)
    setError(null)
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('This link could not be revoked. Try again.')
      setShares((current) => current.map((share) => share.id === id ? { ...share, state: 'revoked', revokedAt: new Date().toISOString() } : share))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This link could not be revoked. Try again.')
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <main className="pip-shares-page">
      <style jsx>{`
        .pip-shares-page { width: 100%; max-width: 52rem; margin: 0 auto; overflow-wrap: anywhere; }
        .pip-share-list { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
        .pip-share-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; padding: 1rem; border: 1px solid var(--pip-color-base-300); border-radius: 0.75rem; }
        .pip-share-row p { margin: 0.25rem 0 0; }
        .pip-share-state { font-weight: 700; }
        .pip-share-remaining { color: var(--pip-color-secondary); }
        .pip-share-revoke { min-width: var(--pip-tap-target); min-height: var(--pip-tap-target); padding: 0.5rem 1rem; border: 1px solid var(--pip-color-error); border-radius: 0.5rem; color: var(--pip-color-error); background: var(--pip-color-base-100); font: inherit; font-weight: 600; cursor: pointer; }
        .pip-share-revoke:focus-visible { outline: 2px solid var(--pip-color-accent); outline-offset: 2px; }
        @media (max-width: 390px) { .pip-share-row { grid-template-columns: 1fr; } .pip-share-revoke { width: 100%; } }
      `}</style>
      <h1>Shares</h1>
      {error ? <p className="pip-error" role="alert">{error}</p> : null}
      {loading ? <p aria-live="polite">Loading shares…</p> : null}
      {!loading && !error && shares.length === 0 ? <p data-testid="share-empty">You have not shared any secure links.</p> : null}
      {!loading && shares.length > 0 ? (
        <ul aria-label="Secure share links" className="pip-share-list" data-testid="share-list">
          {shares.map((share) => (
            <li className="pip-share-row" key={share.id}>
              <div>
                <strong>{share.resourceKind === 'image' ? 'Image' : 'Report'} shared with {share.recipientEmail}</strong>
                <p className="pip-share-state">{stateLabel(share.state)}</p>
                {share.state === 'active' ? <p className="pip-share-remaining">{remainingTime(share.expiresAt)}</p> : null}
              </div>
              {share.state === 'active' ? (
                <button aria-label={`Revoke link shared with ${share.recipientEmail}`} className="pip-share-revoke" data-testid="share-revoke" disabled={revokingId === share.id} onClick={() => { void revoke(share.id) }} type="button">
                  {revokingId === share.id ? 'Revoking…' : 'Revoke'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  )
}

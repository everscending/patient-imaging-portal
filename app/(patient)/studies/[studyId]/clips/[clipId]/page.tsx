'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { CineViewer } from '@/components/imaging/CineViewer'
import type { CineViewerProps } from '@/components/imaging/CineViewer'
import { normalizeClipPayload } from './clip-payload'

type Clip = CineViewerProps['clip']

export default function CineClipPage() {
  const params = useParams<{ studyId: string; clipId: string }>()
  const router = useRouter()
  const [clip, setClip] = useState<Clip | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setClip(null)
    setError(null)

    async function loadClip(): Promise<void> {
      try {
        const response = await fetch(`/api/studies/${params.studyId}/clips/${params.clipId}`, { cache: 'no-store' })
        if (!active) return
        if (response.status === 401) {
          router.replace('/login')
          return
        }
        if (!response.ok) {
          setError('This cine clip is unavailable.')
          return
        }
        const payload: unknown = await response.json()
        if (!active) return
        const normalized = normalizeClipPayload(payload)
        if (!normalized) {
          setError('This cine clip is unavailable.')
          return
        }
        setClip(normalized)
      } catch {
        if (active) setError('This cine clip is unavailable.')
      }
    }

    void loadClip()
    return () => {
      active = false
    }
  }, [params.clipId, params.studyId, router])

  return (
    <main className="cine-page">
      <h1>Cine clip</h1>
      {error ? <p className="pip-error" role="alert">{error}</p> : null}
      {clip ? <CineViewer clip={clip} /> : error ? null : <p aria-live="polite">Loading cine clip…</p>}
      <style jsx>{`
        .cine-page { width: 100%; max-width: 60rem; margin: 0 auto; }
        h1 { margin-top: 0; }
      `}</style>
    </main>
  )
}

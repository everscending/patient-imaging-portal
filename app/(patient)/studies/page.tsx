'use client'

import { useEffect, useState } from 'react'
import { StudyCard } from '../../../components/imaging/StudyCard'
import type { StudySummary } from '../../../components/imaging/StudyCard'
import { EmptyState } from '../../../components/system/EmptyState'

type StudiesState =
  | { kind: 'loading' }
  | { kind: 'ready'; studies: StudySummary[] }
  | { kind: 'degraded' }

function isRfc3339Instant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return Number.isFinite(Date.parse(value)) && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isStudy(value: unknown): value is StudySummary {
  if (!value || typeof value !== 'object') return false
  const study = value as Record<string, unknown>
  return (
    typeof study.id === 'string' &&
    study.id.trim().length > 0 &&
    typeof study.description === 'string' &&
    study.description.trim().length > 0 &&
    typeof study.occurredAt === 'string' &&
    isRfc3339Instant(study.occurredAt) &&
    typeof study.providerName === 'string' &&
    study.providerName.trim().length > 0 &&
    isCount(study.imageCount) &&
    isCount(study.clipCount)
  )
}

function readStudies(value: unknown): StudySummary[] | null {
  if (!value || typeof value !== 'object') return null
  const studies = (value as Record<string, unknown>).studies
  if (!Array.isArray(studies) || !studies.every(isStudy)) return null
  return studies
}

export default function StudiesPage() {
  const [state, setState] = useState<StudiesState>({ kind: 'loading' })

  useEffect(() => {
    let current = true

    void fetch('/api/studies', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null
        try {
          return readStudies(await response.json())
        } catch {
          return null
        }
      })
      .then((studies) => {
        if (current) setState(studies === null ? { kind: 'degraded' } : { kind: 'ready', studies })
      })
      .catch(() => {
        if (current) setState({ kind: 'degraded' })
      })

    return () => {
      current = false
    }
  }, [])

  return (
    <main className="pip-studies-page">
      <h1>Imaging</h1>
      <section aria-label="Imaging studies" className="pip-study-list" data-testid="study-list">
        {state.kind === 'loading' ? (
          <p aria-busy="true" aria-label="Loading imaging studies" aria-live="polite" role="status">
            Loading your imaging studies…
          </p>
        ) : null}
        {state.kind === 'degraded' ? (
          <p data-testid="studies-degraded" role="alert">
            Images are temporarily unavailable. Please try again.
          </p>
        ) : null}
        {state.kind === 'ready' ? (
          state.studies.length === 0 ? (
            <EmptyState message="No images yet — images appear here once a completed visit has been processed by the clinic." />
          ) : (
            state.studies.map((study) => <StudyCard key={study.id} study={study} />)
          )
        ) : null}
      </section>
      <style>{`
        .pip-studies-page { max-width: 72rem; margin: 0 auto; overflow-wrap: anywhere; }
        .pip-study-list { display: grid; grid-template-columns: 1fr; gap: 0.75rem; }
        .pip-study-card { display: flex; min-width: 0; min-height: var(--pip-tap-target); padding: 0.75rem; gap: 0.75rem; border: 1px solid var(--pip-color-base-300); border-radius: 0.75rem; color: var(--pip-color-base-content); background: var(--pip-color-base-100); text-decoration: none; }
        .pip-study-card:focus-visible { outline: 2px solid var(--pip-color-accent); outline-offset: 2px; }
        .pip-study-card-thumbnail { display: none; flex: 0 0 7rem; aspect-ratio: 4 / 3; border-radius: 0.5rem; background: var(--pip-color-base-300); }
        .pip-study-card-details { display: grid; min-width: 0; gap: 0.25rem; }
        .pip-study-card-description { font-weight: 700; }
        .pip-study-card-date, .pip-study-card-provider, .pip-study-card-counts { overflow-wrap: anywhere; }
        .pip-study-card-counts { color: var(--pip-color-secondary); }
        @media (min-width: 768px) {
          .pip-study-list { grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
          .pip-study-card { display: grid; }
          .pip-study-card-thumbnail { display: block; width: 100%; }
        }
      `}</style>
    </main>
  )
}

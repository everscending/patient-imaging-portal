import Link from 'next/link'

export type StudySummary = {
  id: string
  description: string
  occurredAt: string
  providerName: string
  imageCount: number
  clipCount: number
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function StudyCard({ study }: { study: StudySummary }) {
  const imageLabel = countLabel(study.imageCount, 'image', 'images')
  const clipLabel = countLabel(study.clipCount, 'cine clip', 'cine clips')
  const accessibleName = `${study.description}, ${study.occurredAt}, ${study.providerName}, ${imageLabel}, ${clipLabel}`

  return (
    <Link className="pip-study-card" data-testid="study-card" href={`/studies/${study.id}`} aria-label={accessibleName}>
      <span className="pip-study-card-thumbnail" aria-hidden="true" />
      <span className="pip-study-card-details">
        <span className="pip-study-card-description">{study.description}</span>
        <time className="pip-study-card-date" dateTime={study.occurredAt}>
          {study.occurredAt}
        </time>
        <span className="pip-study-card-provider">{study.providerName}</span>
        <span className="pip-study-card-counts">
          {imageLabel} · {clipLabel}
        </span>
      </span>
    </Link>
  )
}

'use client'

import { ShareDialog } from '../../components/share/ShareDialog'
import type { JSX } from 'react'

export type ReportViewProps = {
  report: {
    id: string
    studyId: string
    studyDescription: string
    patientRef: string
    findings: string
    impression: string
    signedByName: string
    signedAt: string
  }
  variant: 'portal' | 'shared'
}

function signingTimestamp(value: string): string {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? 'Not recorded'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/** The sole structured-text renderer for portal and shared report views. */
export function ReportView({
  report,
  variant,
}: ReportViewProps): JSX.Element {
  return (
    <article className="pip-report" data-testid="report-view">
      <style>{`
        .pip-report { max-width: 52rem; margin: 0 auto; overflow-wrap: anywhere; }
        .pip-report-header { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; padding: 1rem 0; border-block: 1px solid var(--pip-color-base-300); }
        .pip-report-reference { margin: 0; }
        .pip-report-reference dt { font-size: 0.875rem; font-weight: 600; }
        .pip-report-reference dd { margin: 0.25rem 0 0; }
        .pip-report-section { margin-top: 2rem; }
        .pip-report-section h2 { margin: 0 0 0.5rem; }
        .pip-report-section p { margin: 0; white-space: pre-wrap; }
        .pip-report-actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
        .pip-report-action { display: inline-flex; align-items: center; justify-content: center; min-height: var(--pip-tap-target); min-width: var(--pip-tap-target); padding: 0.5rem 1rem; border: 1px solid var(--pip-color-primary); border-radius: 0.5rem; color: var(--pip-color-primary); background: var(--pip-color-base-100); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
        .pip-report-action:focus-visible { outline: 2px solid var(--pip-color-accent); outline-offset: 2px; }
        @media (max-width: 767px) { .pip-report-header { grid-template-columns: 1fr; } .pip-report-print { display: none; } }
        @media print { .pip-report-actions { display: none; } }
      `}</style>
      <header>
        <h1>Report</h1>
        <dl className="pip-report-header">
          <div className="pip-report-reference">
            <dt>Patient reference</dt>
            <dd>{report.patientRef}</dd>
          </div>
          <div className="pip-report-reference">
            <dt>Study reference</dt>
            <dd>{report.studyDescription} ({report.studyId})</dd>
          </div>
          <div className="pip-report-reference">
            <dt>Signing provider</dt>
            <dd>{report.signedByName ?? 'Not recorded'}</dd>
          </div>
          <div className="pip-report-reference">
            <dt>Signed</dt>
            <dd>{signingTimestamp(report.signedAt)}</dd>
          </div>
        </dl>
      </header>

      <section className="pip-report-section" aria-labelledby="report-findings-heading" data-testid="report-findings">
        <h2 id="report-findings-heading">Findings</h2>
        <p>{report.findings}</p>
      </section>
      <section className="pip-report-section" aria-labelledby="report-impression-heading" data-testid="report-impression">
        <h2 id="report-impression-heading">Impression</h2>
        <p>{report.impression}</p>
      </section>

      {variant === 'portal' ? (
        <div className="pip-report-actions" aria-label="Report actions">
          <span data-testid="share-create">
            <ShareDialog resourceKind="report" resourceId={report.id} shareLinkTtlHours={48} />
          </span>
          <button className="pip-report-action pip-report-print" type="button" onClick={() => window.print()}>
            Print
          </button>
        </div>
      ) : null}
    </article>
  )
}

'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

type ReportListItem = {
  id: string
  studyId: string
  studyDescription: string
  signedAt: string
}

function signedDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? 'Signed report' : `Signed ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)}`
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportListItem[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let active = true
    void fetch('/api/reports', { cache: 'no-store' }).then(async (response) => {
      if (!active) return
      if (!response.ok) {
        setUnavailable(true)
        return
      }
      const payload = (await response.json()) as { reports: ReportListItem[] }
      setReports(payload.reports)
    })
    return () => {
      active = false
    }
  }, [])

  return (
    <main>
      <h1>Reports</h1>
      {unavailable ? <p role="alert">Reports are temporarily unavailable.</p> : null}
      {reports?.length === 0 ? <p data-testid="reports-empty">No reports yet — a report appears here once your clinician has signed it.</p> : null}
      {reports && reports.length > 0 ? (
        <ul aria-label="Signed reports">
          {reports.map((report) => (
            <li key={report.id}>
              <Link href={`/reports/${report.id}`}>
                <strong>{report.studyDescription}</strong>
                <span> — {signedDate(report.signedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  )
}

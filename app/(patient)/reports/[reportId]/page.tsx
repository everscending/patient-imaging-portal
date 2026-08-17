'use client'

import { notFound } from 'next/navigation'
import { useEffect, useState } from 'react'

import { ReportView } from '../../../../lib/reports/ReportView'
import type { ReportViewProps } from '../../../../lib/reports/ReportView'

type DetailPageProps = {
  params: Promise<{ reportId: string }>
}

export default function ReportDetailPage({ params }: DetailPageProps) {
  const [report, setReport] = useState<ReportViewProps['report'] | null>(null)
  const [missing, setMissing] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let active = true
    void params.then(async ({ reportId }) => {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}`, { cache: 'no-store' })
      if (!active) return
      if (response.status === 404) {
        setMissing(true)
        return
      }
      if (!response.ok) {
        setUnavailable(true)
        return
      }
      setReport((await response.json()) as ReportViewProps['report'])
    })
    return () => {
      active = false
    }
  }, [params])

  if (missing) notFound()

  return (
    <main>
      {unavailable ? (
        <>
          <h1>Report</h1>
          <p role="alert">This report is temporarily unavailable.</p>
        </>
      ) : null}
      {report ? <ReportView report={report} variant="portal" /> : null}
    </main>
  )
}

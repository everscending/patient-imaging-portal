import { notFound, redirect } from 'next/navigation'
import { resolveAuthenticatedSession } from '../../../../lib/access/identity'
import { config } from '../../../../lib/config'
import { getReport } from '../../../../lib/reports/reports'
import { ReportView } from '../../../../lib/reports/ReportView'
import type { ReportViewProps } from '../../../../lib/reports/ReportView'

type DetailPageProps = {
  params: Promise<{ reportId: string }>
}

export default async function ReportDetailPage({ params }: DetailPageProps) {
  const { reportId } = await params
  const session = await resolveAuthenticatedSession()
  if (!session) redirect('/login')

  const result = await getReport({ kind: 'patient', userId: session.userId }, session.accessToken, reportId)
  if (!result.ok) {
    if (result.status === 401) redirect('/login')
    if (result.status === 403) redirect(`/verify?next=${encodeURIComponent(`/reports/${reportId}`)}`)
    notFound()
  }

  return (
    <main>
      <ReportView
        report={result.value as ReportViewProps['report']}
        shareLinkTtlHours={config.shareLinkTtlHours}
        variant="portal"
      />
    </main>
  )
}

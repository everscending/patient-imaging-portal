import { config } from '../../../../lib/config'
import { ReportDetailClient } from './ReportDetailClient'

type DetailPageProps = {
  params: Promise<{ reportId: string }>
}

export default async function ReportDetailPage({ params }: DetailPageProps) {
  const { reportId } = await params
  return <ReportDetailClient reportId={reportId} shareLinkTtlHours={config.shareLinkTtlHours} />
}

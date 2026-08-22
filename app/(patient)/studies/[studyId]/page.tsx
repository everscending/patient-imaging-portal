import Link from 'next/link'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { ImageViewer, type ImageViewerProps } from '../../../../components/imaging/ImageViewer'
import { guardPhiAccess } from '../../../../lib/access/guard'
import { resolveCallerId } from '../../../../lib/access/identity'
import { anonClient } from '../../../../lib/db/client'
import { config } from '../../../../lib/config'
import { studyDetail } from '../../../../lib/imaging/studies'
import { SESSION_COOKIE_NAME } from '../../../../lib/session-cookie'

type StudyClip = { id: string; frameCount: number }

type StudyManifest = {
  description: string
  imageSigningFailed: boolean
  images: ImageViewerProps['images']
  clips: StudyClip[]
}

// Signed reports only: RLS scopes rows to the caller, and the status filter
// keeps a preliminary report from leaking even a "report exists" hint.
async function signedReportId(token: string, studyId: string): Promise<string | null> {
  const { data, error } = await anonClient(token)
    .from('reports')
    .select('id')
    .eq('study_id', studyId)
    .eq('status', 'signed')
    .maybeSingle()
  if (error || !data) return null
  return (data as { id: string }).id
}

async function getStudy(studyId: string): Promise<StudyManifest & { reportId: string | null }> {
  const callerId = await resolveCallerId()
  const access = await guardPhiAccess(
    { kind: 'patient', userId: callerId ?? '' },
    { kind: 'study', id: studyId },
    'study.view',
  )
  if (!access.ok) {
    if (access.status === 401) redirect('/login')
    if (access.status === 403) redirect(`/verify?next=${encodeURIComponent(`/studies/${studyId}`)}`)
    notFound()
  }

  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (!token) redirect('/login')
  const [detail, reportId] = await Promise.all([
    studyDetail(anonClient(token), studyId),
    signedReportId(token, studyId),
  ])
  if (!detail) notFound()
  return { ...(detail as StudyManifest), reportId }
}

export default async function StudyPage({ params }: { params: Promise<{ studyId: string }> }) {
  const { studyId } = await params
  const study = await getStudy(studyId)
  return (
    <main>
      <h1>{study.description}</h1>
      {study.reportId ? (
        <p>
          <Link data-testid="study-report-link" href={`/reports/${study.reportId}`}>
            View the signed report for this study
          </Link>
        </p>
      ) : null}
      <ImageViewer images={study.images} signingFailed={study.imageSigningFailed} shareLinkTtlHours={config.shareLinkTtlHours} variant="portal" />
      {study.clips.length > 0 ? (
        <ul className="pip-study-clips" data-testid="study-clip-list">
          {study.clips.map((clip) => (
            <li key={clip.id}>
              <Link className="pip-study-clip-link" data-testid="study-clip-link" href={`/studies/${studyId}/clips/${clip.id}`}>
                Cine clip — {clip.frameCount} frames
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  )
}

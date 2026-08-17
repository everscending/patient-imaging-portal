import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { ImageViewer, type ImageViewerProps } from '../../../../components/imaging/ImageViewer'
import { guardPhiAccess } from '../../../../lib/access/guard'
import { resolveCallerId } from '../../../../lib/access/identity'
import { anonClient } from '../../../../lib/db/client'
import { studyDetail } from '../../../../lib/imaging/studies'
import { SESSION_COOKIE_NAME } from '../../../../lib/session-cookie'

type StudyManifest = { description: string; images: ImageViewerProps['images'] }

async function getStudy(studyId: string): Promise<StudyManifest> {
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
  const detail = await studyDetail(anonClient(token), studyId)
  if (!detail) notFound()
  return detail as StudyManifest
}

export default async function StudyPage({ params }: { params: Promise<{ studyId: string }> }) {
  const { studyId } = await params
  const study = await getStudy(studyId)
  return (
    <main>
      <h1>{study.description}</h1>
      <ImageViewer images={study.images} variant="portal" />
    </main>
  )
}

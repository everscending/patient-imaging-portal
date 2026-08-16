import { cookies, headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { ImageViewer, type ImageViewerProps } from '../../../../components/imaging/ImageViewer'

type StudyManifest = { description: string; images: ImageViewerProps['images'] }

async function getStudy(studyId: string): Promise<StudyManifest> {
  const requestHeaders = await headers()
  const protocol = requestHeaders.get('x-forwarded-proto') ?? 'http'
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host')
  if (!host) notFound()
  const cookie = (await cookies()).toString()
  const response = await fetch(`${protocol}://${host}/api/studies/${studyId}`, {
    cache: 'no-store',
    headers: { cookie },
  })
  if (response.status === 403) redirect(`/verify?next=${encodeURIComponent(`/studies/${studyId}`)}`)
  if (response.status === 404) notFound()
  if (!response.ok) throw new Error('Unable to load this study.')
  return response.json() as Promise<StudyManifest>
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

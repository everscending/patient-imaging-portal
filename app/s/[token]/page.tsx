import type { Metadata } from 'next'

import { SharedResource } from '../../../components/share/SharedResource'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <SharedResource token={token} />
}

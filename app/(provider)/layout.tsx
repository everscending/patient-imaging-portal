// Every staff page resolves the authenticated account to its provider or
// admin row before rendering the desk-user shell. A patient or another
// unrecognized account receives the same 404 as a missing staff surface.
import type { ReactNode } from 'react'
import { notFound, redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import ProviderShell from '../../components/shell/ProviderShell'
import { anonClient, authClient } from '../../lib/db/client'
import { SESSION_COOKIE_NAME } from '../../lib/session-cookie'

type ProviderRow = {
  id: string
  full_name: string
  time_zone: string
}

export default async function ProviderLayout({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (!token) redirect('/login')

  const { data: authentication, error: authenticationError } = await authClient().auth.getUser(token)
  if (authenticationError || !authentication.user) redirect('/login')

  const client = anonClient(token)
  const [{ data: admin, error: adminError }, { data: provider, error: providerError }] = await Promise.all([
    client.from('staff_admins').select('id').eq('user_id', authentication.user.id).maybeSingle(),
    client.from('providers').select('id, full_name, time_zone').eq('user_id', authentication.user.id).maybeSingle(),
  ])
  if (adminError || providerError || (!admin && !provider)) notFound()

  if (admin) {
    return (
      <ProviderShell identity={{ role: 'admin', actorName: 'Administrator' }}>
        {children}
      </ProviderShell>
    )
  }

  const providerIdentity = provider as ProviderRow
  return (
    <ProviderShell
      identity={{
        role: 'provider',
        actorName: providerIdentity.full_name,
        providerId: providerIdentity.id,
        timeZone: providerIdentity.time_zone,
      }}
    >
      {children}
    </ProviderShell>
  )
}

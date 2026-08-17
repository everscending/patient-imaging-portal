// Every provider page resolves the authenticated account to its provider row
// before rendering the desk-user shell. A patient or another unrecognized
// account receives the same 404 as a missing provider surface.
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

  const { data, error } = await anonClient(token)
    .from('providers')
    .select('id, full_name, time_zone')
    .eq('user_id', authentication.user.id)
    .maybeSingle()
  if (error || !data) notFound()

  const provider = data as ProviderRow
  return (
    <ProviderShell
      identity={{
        role: 'provider',
        actorName: provider.full_name,
        providerId: provider.id,
        timeZone: provider.time_zone,
      }}
    >
      {children}
    </ProviderShell>
  )
}

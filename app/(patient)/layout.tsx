// app/(patient)/layout.tsx — wraps every patient route in PatientShell
// (U-1). middleware.ts already refuses an unsessioned request before this
// layout ever renders; the null fallback below is defensive, not load-bearing.
import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import PatientShell from '../../components/shell/PatientShell'
import { authClient } from '../../lib/db/client'
import { config } from '../../lib/config'
import { SESSION_COOKIE_NAME } from '../../lib/session-cookie'

export default async function PatientLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null
  const { data } = token ? await authClient().auth.getUser(token) : { data: { user: null } }
  const patientName = data.user?.email ?? 'Patient'

  return (
    <PatientShell practiceName={config.practiceName} patientName={patientName}>
      {children}
    </PatientShell>
  )
}

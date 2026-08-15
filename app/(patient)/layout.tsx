// Wraps every patient route in the one shell (UX_SPEC §3, U-1). Middleware
// already turned away a missing or expired session before a request ever
// reaches here (middleware.ts) — this layout only resolves a display name
// for the sidebar, it does not re-decide access.
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { authClient } from '../../lib/db/client'
import { PatientShell } from '../../components/shell/PatientShell'
import { SESSION_COOKIE_NAME } from '../../lib/session-cookie'

async function resolvePatientName(): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (!token) return 'Patient'

  const { data } = await authClient().auth.getUser(token)
  if (!data.user) return 'Patient'

  const fullName = data.user.user_metadata?.fullName
  if (typeof fullName === 'string' && fullName.length > 0) return fullName
  return data.user.email ?? 'Patient'
}

export default async function PatientLayout({ children }: { children: ReactNode }) {
  const patientName = await resolvePatientName()
  return <PatientShell patientName={patientName}>{children}</PatientShell>
}

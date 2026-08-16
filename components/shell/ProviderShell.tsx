'use client'

// ProviderShell is the shared desk-user shell from UX_SPEC §3. Provider and
// admin navigation differ, but both remain a left sidebar at every width; the
// patient-only bottom tab bar is never part of this component.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

export type StaffRole = 'provider' | 'admin'

export type ProviderShellIdentity = {
  role: StaffRole
  actorName: string
  providerId?: string
  timeZone?: string
}

const DESTINATIONS = {
  provider: [
    { href: '/provider/schedule', label: 'Schedule' },
    { href: '/provider/availability', label: 'Availability' },
  ],
  admin: [{ href: '/admin/audit', label: 'Audit log' }],
} as const

const StaffIdentityContext = createContext<ProviderShellIdentity | null>(null)

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function useProviderShell(): ProviderShellIdentity {
  const identity = useContext(StaffIdentityContext)
  if (!identity) throw new Error('useProviderShell must be used inside ProviderShell')
  return identity
}

export default function ProviderShell({
  identity,
  children,
}: {
  identity: ProviderShellIdentity
  children: ReactNode
}) {
  const pathname = usePathname()
  const destinations = DESTINATIONS[identity.role]

  return (
    <StaffIdentityContext.Provider value={identity}>
      <div className="pip-staff-shell">
        <aside
          className="pip-staff-sidebar"
          data-testid={`${identity.role}-sidebar`}
          aria-label={`${identity.role === 'provider' ? 'Provider' : 'Admin'} navigation`}
        >
          <p className="pip-staff-name">{identity.actorName}</p>
          <nav aria-label="Primary">
            {destinations.map((destination) => (
              <Link
                key={destination.href}
                href={destination.href}
                aria-current={isCurrent(pathname, destination.href) ? 'page' : undefined}
              >
                {destination.label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="pip-staff-main">{children}</main>
      </div>
    </StaffIdentityContext.Provider>
  )
}

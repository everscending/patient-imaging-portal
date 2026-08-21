'use client'

// components/shell/PatientShell.tsx — U-1: one navigation model, two shapes
// (UX_SPEC §3). Both the tab bar and the sidebar are always in the DOM; CSS
// (app/globals.css, the 768px breakpoint) decides which one is visible, so
// there is no client-side width detection, no hydration flicker, and the
// hidden variant is natively out of the tab order (display: none). No
// verification indicator anywhere (ADR-0011) and no hardcoded hex — every
// colour below is a var(--pip-color-*) token (UX_SPEC §2).
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import Wordmark from '../branding/Wordmark'

const DESTINATIONS = [
  { href: '/studies', label: 'Imaging' },
  { href: '/reports', label: 'Reports' },
  { href: '/appointments', label: 'Visits' },
  { href: '/shares', label: 'Shares' },
] as const

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function PatientShell({
  practiceName,
  patientName,
  children,
}: {
  practiceName: string
  patientName: string
  children: ReactNode
}) {
  const pathname = usePathname()

  return (
    <div className="pip-shell">
      <aside className="pip-shell-sidebar" data-testid="patient-sidebar" aria-label="Patient navigation">
        <Wordmark name={practiceName} />
        <p className="pip-shell-patient-name">{patientName}</p>
        <nav aria-label="Primary">
          {DESTINATIONS.map((destination) => (
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

      <div className="pip-shell-main">{children}</div>

      <nav className="pip-shell-tabbar" data-testid="patient-tabbar" aria-label="Primary">
        {DESTINATIONS.map((destination) => (
          <Link
            key={destination.href}
            href={destination.href}
            aria-current={isCurrent(pathname, destination.href) ? 'page' : undefined}
          >
            {destination.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}

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
import SignOutButton from './SignOutButton'

const DESTINATIONS = [
  { href: '/appointments', label: 'Appointments' },
  { href: '/studies', label: 'Imaging' },
  { href: '/reports', label: 'Reports' },
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
        <Link
          className="pip-shell-patient-name"
          href="/profile"
          aria-current={isCurrent(pathname, '/profile') ? 'page' : undefined}
        >
          {patientName}
        </Link>
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
        <SignOutButton className="pip-shell-sign-out" />
      </aside>

      <div className="pip-shell-main">
        <header className="pip-shell-topbar" data-testid="patient-topbar">
          <Wordmark name={practiceName} />
          <Link
            className="pip-shell-account"
            href="/profile"
            aria-label={`Profile — ${patientName}`}
            aria-current={isCurrent(pathname, '/profile') ? 'page' : undefined}
          >
            {(patientName[0] ?? '?').toUpperCase()}
          </Link>
        </header>
        {children}
      </div>

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

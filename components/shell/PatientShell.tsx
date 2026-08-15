'use client'

// The one navigation model, two shapes (UX_SPEC §3, U-1): a bottom tab bar
// below 768px and a left sidebar at and above it, both rendered from this
// single destination list so the two shapes can never drift out of sync.
// Both layouts stay in the DOM at once; a CSS media query — not JS viewport
// detection — decides which is visible, so there is no client-only render
// pass and no flash of the wrong shape. There is deliberately no
// verification indicator anywhere in here (ADR-0011): nothing expires, so
// there is nothing to count down.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

type Destination = { href: string; label: string; testId: string }

// Order is pinned (UX_SPEC §3): every destination is one tap from every
// other, which is what the DEL-6 walkthrough needs.
const DESTINATIONS: Destination[] = [
  { href: '/studies', label: 'Imaging', testId: 'shell-nav-imaging' },
  { href: '/reports', label: 'Reports', testId: 'shell-nav-reports' },
  { href: '/appointments', label: 'Visits', testId: 'shell-nav-visits' },
  { href: '/shares', label: 'Shares', testId: 'shell-nav-shares' },
]

function isActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function PatientShell({ patientName, children }: { patientName: string; children: ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="pip-shell">
      <aside className="pip-sidebar" aria-label="Patient navigation" data-testid="shell-sidebar">
        <div className="pip-sidebar-name" data-testid="shell-patient-name">
          {patientName}
        </div>
        <ul className="pip-sidebar-list">
          {DESTINATIONS.map((destination) => (
            <li key={destination.href}>
              <Link
                href={destination.href}
                data-testid={destination.testId}
                aria-current={isActive(pathname, destination.href) ? 'page' : undefined}
                className="pip-sidebar-link"
              >
                {destination.label}
              </Link>
            </li>
          ))}
        </ul>
      </aside>

      <div className="pip-content">{children}</div>

      <nav className="pip-tabbar" aria-label="Patient navigation" data-testid="shell-tabbar">
        {DESTINATIONS.map((destination) => (
          <Link
            key={destination.href}
            href={destination.href}
            data-testid={`${destination.testId}-tab`}
            aria-current={isActive(pathname, destination.href) ? 'page' : undefined}
            className="pip-tab-link"
          >
            {destination.label}
          </Link>
        ))}
      </nav>

      <style jsx>{`
        .pip-sidebar {
          display: none;
        }
        .pip-tabbar {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          display: flex;
          background: var(--pip-color-surface-100);
          border-top: 1px solid var(--pip-color-surface-300);
        }
        /* :global — these classes land on <Link> elements produced inside
           .map(), which styled-jsx's scope hash does not reliably reach. */
        :global(.pip-tab-link) {
          flex: 1;
          min-height: 44px;
          min-width: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          text-decoration: none;
          color: var(--pip-color-text);
        }
        :global(.pip-tab-link[aria-current='page']) {
          color: var(--pip-color-primary);
          font-weight: 600;
        }
        .pip-content {
          padding-bottom: 4rem;
        }

        @media (min-width: 768px) {
          .pip-tabbar {
            display: none;
          }
          .pip-shell {
            display: flex;
          }
          .pip-sidebar {
            display: block;
            width: 16rem;
            flex-shrink: 0;
            padding: 1.5rem 1rem;
            background: var(--pip-color-surface-100);
            border-right: 1px solid var(--pip-color-surface-300);
          }
          .pip-sidebar-name {
            font-weight: 600;
            margin-bottom: 1rem;
          }
          .pip-sidebar-list {
            list-style: none;
            margin: 0;
            padding: 0;
          }
          :global(.pip-sidebar-link) {
            display: flex;
            align-items: center;
            min-height: 44px;
            text-decoration: none;
            color: var(--pip-color-text);
          }
          :global(.pip-sidebar-link[aria-current='page']) {
            color: var(--pip-color-primary);
            font-weight: 600;
          }
          .pip-content {
            flex: 1;
            padding-bottom: 0;
          }
        }
      `}</style>
    </div>
  )
}

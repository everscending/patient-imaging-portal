// components/branding/Wordmark.tsx — the one place the practice display
// name is rendered as a mark (JOR-310). Used by the landing page header and
// footer, and by PatientShell/ProviderShell, so branding cannot drift from
// one screen to the next. Pure presentational: the name comes from
// lib/config.ts's NEXT_PUBLIC_PRACTICE_NAME via a prop, never read here
// directly, so this file has no server-only dependency and can be imported
// from a 'use client' component.
export default function Wordmark({ name }: { name: string }) {
  return (
    <span className="pip-wordmark">
      <svg className="pip-wordmark-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="10" fill="var(--pip-color-primary)" />
        <path
          d="M6 13c1.5 0 1.5-4 3-4s1.5 6 3 6 1.5-8 3-8 1.5 4 3 4"
          fill="none"
          stroke="var(--pip-color-base-100)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {name}
    </span>
  )
}

// app/page.tsx — marketing landing page for a subscribed imaging practice
// (JOR-310). Server component, no client JS: every CTA below is a plain
// <Link>, not a button with a handler. Wordmark and copy read
// lib/config.ts's practiceName so a later ticket can't drift the header
// from the shells (components/branding/Wordmark.tsx is the shared piece).
import Image from 'next/image'
import Link from 'next/link'
import Wordmark from '../components/branding/Wordmark'
import { config } from '../lib/config'

const FEATURES = [
  {
    title: 'Zoom into every scan',
    body: 'Pan, zoom, and step through cine clips frame by frame, right in your browser.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="6" fill="none" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <line x1="14.5" y1="14.5" x2="20" y2="20" stroke="var(--pip-color-primary)" strokeWidth="2" strokeLinecap="round" />
        <line x1="10" y1="7" x2="10" y2="13" stroke="var(--pip-color-primary)" strokeWidth="2" strokeLinecap="round" />
        <line x1="7" y1="10" x2="13" y2="10" stroke="var(--pip-color-primary)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Reports you can trust',
    body: 'Every report is signed by the reading provider before it reaches you.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="5" y="3" width="14" height="18" rx="1.5" fill="none" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <line x1="8" y1="8" x2="16" y2="8" stroke="var(--pip-color-primary)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="8" y1="12" x2="16" y2="12" stroke="var(--pip-color-primary)" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M8 16.5c1.5-2 3.5-2 5 0" fill="none" stroke="var(--pip-color-primary)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Book on your schedule',
    body: 'Book, reschedule, or cancel appointments online, whenever it works for you.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="4" y="5" width="16" height="15" rx="1.5" fill="none" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <line x1="4" y1="9" x2="20" y2="9" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <line x1="8" y1="3" x2="8" y2="7" stroke="var(--pip-color-primary)" strokeWidth="2" strokeLinecap="round" />
        <line x1="16" y1="3" x2="16" y2="7" stroke="var(--pip-color-primary)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="9" cy="14" r="1.4" fill="var(--pip-color-primary)" />
      </svg>
    ),
  },
  {
    title: 'Share safely',
    body: 'Send a study or report with a link that expires — never an open-ended copy.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="6" cy="12" r="2.5" fill="none" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <circle cx="18" cy="6" r="2.5" fill="none" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <circle cx="18" cy="18" r="2.5" fill="none" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <line x1="8.2" y1="10.8" x2="15.8" y2="7.2" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <line x1="8.2" y1="13.2" x2="15.8" y2="16.8" stroke="var(--pip-color-primary)" strokeWidth="2" />
      </svg>
    ),
  },
  {
    title: 'Every access recorded',
    body: 'Every time your record is viewed, it is logged, so nothing happens quietly.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" fill="none" stroke="var(--pip-color-primary)" strokeWidth="2" />
        <line x1="12" y1="7" x2="12" y2="12" stroke="var(--pip-color-primary)" strokeWidth="2" strokeLinecap="round" />
        <line x1="12" y1="12" x2="15.5" y2="14" stroke="var(--pip-color-primary)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
] as const

const TRUST_STATEMENTS = [
  'Every request is checked against who you are and what you are allowed to see.',
  'Every access to your images and reports is logged.',
  'Shared links expire automatically — they are never an open-ended copy.',
  'Protected health information is kept out of system logs.',
] as const

function CheckIcon() {
  return (
    <svg className="pip-landing-trust-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" fill="none" stroke="var(--pip-color-accent)" strokeWidth="2" />
      <path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="var(--pip-color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function LandingPage() {
  return (
    <>
      <header className="pip-landing-header">
        <Wordmark name={config.practiceName} />
        <Link href="/login" className="pip-landing-header-signin">
          Sign in
        </Link>
      </header>

      <main>
        <section className="pip-landing-hero">
          <div className="pip-landing-hero-copy">
            <h1>Your imaging care, all in one place</h1>
            <p>
              Review your scans, read signed reports, and manage appointments securely, from any
              device.
            </p>
            <div className="pip-landing-hero-actions">
              <Link href="/login" className="pip-button-primary">
                Sign in
              </Link>
              <Link href="/register" className="pip-landing-secondary-link">
                Create an account
              </Link>
            </div>
          </div>
          <Image
            className="pip-landing-hero-image"
            src="/hero.png"
            alt=""
            width={1040}
            height={512}
            priority
          />
        </section>

        <section className="pip-landing-features" aria-labelledby="pip-landing-features-heading">
          <h2 id="pip-landing-features-heading">What you can do</h2>
          <div className="pip-landing-feature-grid">
            {FEATURES.map((feature) => (
              <article className="pip-landing-feature-card" key={feature.title}>
                <div className="pip-landing-feature-icon">{feature.icon}</div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="pip-landing-trust" aria-labelledby="pip-landing-trust-heading">
          <h2 id="pip-landing-trust-heading">Built with your privacy in mind</h2>
          <ul className="pip-landing-trust-list">
            {TRUST_STATEMENTS.map((statement) => (
              <li key={statement}>
                <CheckIcon />
                <span>{statement}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="pip-landing-footer">
        <Wordmark name={config.practiceName} />
        <Link href="/login">Sign in</Link>
      </footer>
    </>
  )
}

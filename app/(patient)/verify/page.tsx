'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'

const IDENTITY_ERROR = 'We could not match those details. Please check them and try again.'
// Mirrors config.identityMaxAttempts and config.identityLockoutMinutes. The
// production enforcement remains server-side in lib/access/identity.ts; these
// values only control the neutral disabled-button affordance.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 5 * 60_000

function safeNextPath(): string {
  if (typeof window === 'undefined') return '/studies'
  const raw = new URLSearchParams(window.location.search).get('next') ?? '/studies'
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return '/studies'
  }
  // '\' is rejected too: browsers normalize it to '/', so '/\evil.com' would
  // resolve off-origin despite the startsWith('/') check (AUDIT.md #5).
  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    /^[a-z][a-z0-9+.-]*:/i.test(decoded)
  ) {
    return '/studies'
  }
  return decoded
}

export default function VerifyPage() {
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [patientRef, setPatientRef] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')
  const [failures, setFailures] = useState(0)
  const [disabledUntil, setDisabledUntil] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showError, setShowError] = useState(false)

  useEffect(() => {
    let active = true
    void fetch('/api/identity/status', { cache: 'no-store' }).then(async (response) => {
      if (!active) return
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      if (response.ok) {
        const status = (await response.json()) as { linked: boolean }
        if (status.linked) {
          router.replace(safeNextPath())
          return
        }
      }
      setChecking(false)
    })
    return () => {
      active = false
    }
  }, [router])

  useEffect(() => {
    if (disabledUntil === null) return
    const delay = Math.max(0, disabledUntil - Date.now())
    const timer = window.setTimeout(() => {
      setFailures(0)
      setDisabledUntil(null)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [disabledUntil])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting || disabledUntil !== null) return
    setSubmitting(true)
    setShowError(false)

    const response = await fetch('/api/identity/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientRef, dateOfBirth }),
    })

    if (response.ok) {
      router.replace(safeNextPath())
      router.refresh()
      return
    }

    const nextFailures = failures + 1
    setFailures(nextFailures)
    if (nextFailures >= MAX_ATTEMPTS) setDisabledUntil(Date.now() + RETRY_DELAY_MS)
    setShowError(true)
    setSubmitting(false)
  }

  if (checking) {
    return (
      <main className="pip-auth-form" aria-busy="true">
        <h1>Verify your identity</h1>
        <p className="pip-notice">Checking your account…</p>
      </main>
    )
  }

  const disabled = submitting || disabledUntil !== null
  return (
    <main className="pip-auth-form">
      <h1>Verify your identity</h1>
      <p className="pip-notice">This is a one-time step. Once matched, you will not be asked again.</p>

      <form aria-label="Identity verification" data-testid="identity-form" onSubmit={submit} noValidate>
        <div className="pip-field">
          <label htmlFor="patient-reference">Patient reference</label>
          <input
            className="pip-input"
            id="patient-reference"
            name="patientRef"
            autoComplete="off"
            value={patientRef}
            onChange={(event) => setPatientRef(event.target.value)}
            required
          />
        </div>
        <div className="pip-field">
          <label htmlFor="date-of-birth">Date of birth</label>
          <input
            className="pip-input"
            id="date-of-birth"
            name="dateOfBirth"
            type="date"
            value={dateOfBirth}
            onChange={(event) => setDateOfBirth(event.target.value)}
            required
          />
        </div>

        {showError ? (
          <p className="pip-error" data-testid="identity-error" role="alert">
            {IDENTITY_ERROR}
          </p>
        ) : null}
        {disabledUntil !== null ? <p className="pip-notice">Try again in a few minutes</p> : null}

        <button className="pip-button-primary" type="submit" disabled={disabled}>
          {submitting ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </main>
  )
}

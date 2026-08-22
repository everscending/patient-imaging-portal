'use client'

// app/login/page.tsx — FR-1, SEC-7. Posts to this app's own
// /api/auth/login, never to Supabase directly (ADR-0012 #15).
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!response.ok) {
        const body = (await response.json()) as { error: string; message: string }
        setError(body.message)
        return
      }
      const { role } = (await response.json()) as { role?: 'patient' | 'provider' | 'admin' }
      router.push(role === 'provider' ? '/provider/schedule' : role === 'admin' ? '/admin/audit' : '/appointments')
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="pip-auth-form">
      <h1>Sign in</h1>
      <p className="pip-notice">You&apos;ll be signed out after 60 minutes of inactivity.</p>

      {error !== null ? (
        <p className="pip-error" role="alert" data-testid="auth-error">
          {error}
        </p>
      ) : null}

      <form data-testid="login-form" onSubmit={handleSubmit} noValidate>
        <div className="pip-field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="pip-input"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="pip-field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="pip-input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button type="submit" className="pip-button-primary" disabled={submitting}>
          Sign in
        </button>
      </form>

      <p className="pip-notice">
        No account? <a href="/register">Register</a>
      </p>
    </main>
  )
}

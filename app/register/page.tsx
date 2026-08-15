'use client'

// app/register/page.tsx — FR-1, SEC-7. Posts to this app's own
// /api/auth/register, never to Supabase directly (ADR-0012 #15).
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'

export default function RegisterPage() {
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
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!response.ok) {
        const body = (await response.json()) as { error: string; message: string }
        setError(body.message)
        return
      }
      router.push('/login')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="pip-auth-form">
      <h1>Register</h1>
      <p className="pip-notice">You&apos;ll be signed out after 60 minutes of inactivity.</p>

      {error !== null ? (
        <p className="pip-error" role="alert" data-testid="auth-error">
          {error}
        </p>
      ) : null}

      <form data-testid="register-form" onSubmit={handleSubmit} noValidate>
        <div className="pip-field">
          <label htmlFor="register-email">Email</label>
          <input
            id="register-email"
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
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            className="pip-input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button type="submit" className="pip-button-primary" disabled={submitting}>
          Register
        </button>
      </form>

      <p className="pip-notice">
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </main>
  )
}

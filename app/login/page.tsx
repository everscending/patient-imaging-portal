'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'

const SESSION_EXPIRY_SENTENCE = "You'll be signed out after 60 minutes of inactivity."

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // Posts to this app's own route — never to Supabase's own hostname
      // (ADR-0012 #15).
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!response.ok) {
        const body: { message?: string } = await response.json().catch(() => ({}))
        setError(body.message ?? 'That email or password is not correct.')
        return
      }
      router.push('/profile')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: '2rem 1rem',
      }}
    >
      <div style={{ width: '100%', maxWidth: '24rem' }}>
        <h1>Sign in</h1>
        <p>{SESSION_EXPIRY_SENTENCE}</p>

        {error !== null && (
          <p role="alert" data-testid="login-error" style={{ color: 'var(--pip-color-error)' }}>
            {error}
          </p>
        )}

        <form data-testid="login-form" onSubmit={handleSubmit} noValidate>
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="login-email">Email</label>
            <br />
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              style={{ minHeight: '44px', width: '100%' }}
            />
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="login-password">Password</label>
            <br />
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              style={{ minHeight: '44px', width: '100%' }}
            />
          </div>

          <button
            type="submit"
            data-testid="login-submit"
            disabled={submitting}
            style={{
              minHeight: '44px',
              minWidth: '44px',
              width: '100%',
              background: 'var(--pip-color-primary)',
              color: 'var(--pip-color-surface-100)',
              border: 'none',
              borderRadius: '0.375rem',
            }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p>
          Don&apos;t have an account? <a href="/register">Register</a>
        </p>
      </div>
    </main>
  )
}

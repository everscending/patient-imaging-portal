'use client'

// One sign-out behavior for every placement (sidebar, profile page): clear
// the session cookie server-side, then hard-navigate to /login so no client
// state survives the session.
import { useState } from 'react'

export default function SignOutButton({ className }: { className?: string }) {
  const [signingOut, setSigningOut] = useState(false)

  async function signOut(): Promise<void> {
    setSigningOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      window.location.assign('/login')
    }
  }

  return (
    <button className={className} data-testid="sign-out" type="button" disabled={signingOut} onClick={() => void signOut()}>
      {signingOut ? 'Signing out…' : 'Sign out'}
    </button>
  )
}

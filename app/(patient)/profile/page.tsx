'use client'

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'

type Profile = {
  email: string
  fullName: string
  phone: string | null
  patientRef: string | null
}

type DeletionState = 'submitted' | 'already-open' | null

const DELETION_MESSAGES = {
  submitted: "We've received your request. The clinic will be in touch. Your images, reports and appointments stay available until then.",
  'already-open': 'You already have a request open. The clinic will be in touch about it.',
} as const

export default function ProfilePage() {
  const router = useRouter()
  const deletionDialog = useRef<HTMLDialogElement>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDeletion, setConfirmingDeletion] = useState(false)
  const [requestingDeletion, setRequestingDeletion] = useState(false)
  const [deletionState, setDeletionState] = useState<DeletionState>(null)

  useEffect(() => {
    let active = true
    void fetch('/api/profile', { cache: 'no-store' }).then(async (response) => {
      if (!active) return
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      if (!response.ok) {
        setError('The profile is temporarily unavailable.')
        return
      }
      const nextProfile = (await response.json()) as Profile
      setProfile(nextProfile)
      setFullName(nextProfile.fullName)
      setPhone(nextProfile.phone ?? '')
    })
    return () => {
      active = false
    }
  }, [router])

  useEffect(() => {
    const dialog = deletionDialog.current
    if (!dialog) return
    if (confirmingDeletion && !dialog.open) dialog.showModal()
    if (!confirmingDeletion && dialog.open) dialog.close()
  }, [confirmingDeletion])

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setMessage(null)
    setError(null)

    const response = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, phone: phone.trim() === '' ? null : phone }),
    })
    if (!response.ok) {
      setError('The profile could not be saved.')
      setSaving(false)
      return
    }

    const nextProfile = (await response.json()) as Profile
    setProfile(nextProfile)
    setFullName(nextProfile.fullName)
    setPhone(nextProfile.phone ?? '')
    setMessage('Profile saved.')
    setSaving(false)
  }

  async function requestDeletion(): Promise<void> {
    if (requestingDeletion) return
    setRequestingDeletion(true)
    setError(null)

    try {
      const response = await fetch('/api/profile/deletion-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (response.status === 202) setDeletionState('submitted')
      else if (response.status === 409) setDeletionState('already-open')
      else setError('The deletion request could not be recorded. Try again.')
    } catch {
      setError('The deletion request could not be recorded. Try again.')
    } finally {
      setRequestingDeletion(false)
      setConfirmingDeletion(false)
    }
  }

  return (
    <main className="pip-auth-form">
      <h1>Profile</h1>
      {error ? (
        <p className="pip-error" role="alert">
          {error}
        </p>
      ) : null}

      {profile ? (
        <form aria-label="Patient profile" data-testid="profile-form" onSubmit={save}>
          <div className="pip-field">
            <label htmlFor="profile-email">Email</label>
            <input className="pip-input" id="profile-email" type="email" value={profile.email} readOnly />
          </div>
          <div className="pip-field">
            <label htmlFor="profile-full-name">Display name</label>
            <input
              className="pip-input"
              id="profile-full-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              maxLength={200}
              required
            />
          </div>
          <div className="pip-field">
            <label htmlFor="profile-phone">Contact phone</label>
            <input
              className="pip-input"
              id="profile-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={64}
            />
          </div>
          {profile.patientRef !== null ? (
            <div className="pip-field">
              <label htmlFor="profile-patient-reference">Patient reference</label>
              <input
                className="pip-input"
                data-testid="profile-patient-ref"
                id="profile-patient-reference"
                value={profile.patientRef}
                readOnly
              />
            </div>
          ) : null}

          {message ? <p className="pip-notice">{message}</p> : null}
          <button className="pip-button-primary" data-testid="profile-save" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>

          <section className="pip-deletion-request">
            <h2>Data deletion</h2>
            {deletionState ? (
              <p className="pip-notice" role="status">{DELETION_MESSAGES[deletionState]}</p>
            ) : (
              <button className="pip-deletion-open" onClick={() => setConfirmingDeletion(true)} type="button">
                Request deletion
              </button>
            )}
          </section>

          <dialog
            aria-labelledby="deletion-dialog-title"
            className="pip-deletion-dialog"
            onCancel={() => setConfirmingDeletion(false)}
            ref={deletionDialog}
          >
            {confirmingDeletion ? (
              <>
                <h2 id="deletion-dialog-title">Request data deletion</h2>
                <p>This records a request for the clinic to review. It does not delete your data immediately.</p>
                <div className="pip-deletion-actions">
                  <button className="pip-deletion-cancel" disabled={requestingDeletion} onClick={() => setConfirmingDeletion(false)} type="button">
                    Cancel
                  </button>
                  <button
                    autoFocus
                    className="pip-button-primary"
                    disabled={requestingDeletion}
                    onClick={() => { void requestDeletion() }}
                    type="button"
                  >
                    {requestingDeletion ? 'Requesting…' : 'Confirm deletion request'}
                  </button>
                </div>
              </>
            ) : null}
          </dialog>

          <style jsx>{`
            .pip-deletion-request { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--pip-color-base-300); }
            .pip-deletion-open, .pip-deletion-cancel { min-width: var(--pip-tap-target); min-height: var(--pip-tap-target); padding: 0.5rem 1rem; border: 1px solid var(--pip-color-primary); border-radius: 0.5rem; color: var(--pip-color-primary); background: var(--pip-color-base-100); font: inherit; font-weight: 600; }
            .pip-deletion-open:focus-visible, .pip-deletion-cancel:focus-visible { outline: 2px solid var(--pip-color-accent); outline-offset: 2px; }
            .pip-deletion-dialog { width: calc(100% - 2rem); max-width: 28rem; border: 1px solid var(--pip-color-base-300); border-radius: 0.75rem; color: var(--pip-color-base-content); background: var(--pip-color-base-100); }
            .pip-deletion-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.75rem; }
          `}</style>
        </form>
      ) : null}
    </main>
  )
}

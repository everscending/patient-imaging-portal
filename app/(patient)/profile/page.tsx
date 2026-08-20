'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'

type Profile = {
  email: string
  fullName: string
  phone: string | null
  patientRef: string | null
}

export default function ProfilePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        </form>
      ) : null}
    </main>
  )
}

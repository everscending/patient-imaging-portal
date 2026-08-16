'use client'

import { useEffect, useState } from 'react'
import { useProviderShell } from '../../../../components/shell/ProviderShell'

type WorkingHour = {
  weekday: number
  startsLocal: string
  endsLocal: string
}

type EditableBlock = {
  id: string
  startsAt: string
  endsAt: string
  reason: string
}

type Availability = {
  timeZone: string
  slotMinutes: number
  workingHours: WorkingHour[]
  blocks: Array<{
    id: string
    startsAt: string
    endsAt: string
    reason: string | null
  }>
}

type SaveSummary = {
  removedOpenSlots: number
  generatedOpenSlots: number
  preservedOutOfHours: Array<{
    appointmentId: string
    startsAt: string
    endsAt: string
    patientRef: string
  }>
}

type ErrorEnvelope = { error?: string; message?: string }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

function newBlock(): EditableBlock {
  return { id: crypto.randomUUID(), startsAt: '', endsAt: '', reason: '' }
}

function localAppointmentTime(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? ''
  return `${part('weekday')} ${part('hour')}:${part('minute')}`
}

export default function AvailabilityPage() {
  const { providerId, timeZone: shellTimeZone } = useProviderShell()
  if (!providerId || !shellTimeZone) throw new Error('Provider availability requires a provider identity')

  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [timeZone, setTimeZone] = useState(shellTimeZone)
  const [slotMinutes, setSlotMinutes] = useState('30')
  const [workingHours, setWorkingHours] = useState<WorkingHour[]>([])
  const [blocks, setBlocks] = useState<EditableBlock[]>([])
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<SaveSummary | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoadState('loading')
    setLoadError(null)
    void fetch(`/api/providers/${providerId}/availability`, { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as Availability | ErrorEnvelope
        if (!response.ok) throw new Error('message' in body ? body.message : undefined)
        if (cancelled) return
        const availability = body as Availability
        setTimeZone(availability.timeZone)
        setSlotMinutes(String(availability.slotMinutes))
        setWorkingHours(availability.workingHours)
        setBlocks(
          availability.blocks.map((block) => ({
            id: block.id,
            startsAt: block.startsAt,
            endsAt: block.endsAt,
            reason: block.reason ?? '',
          })),
        )
        setLoadState('ready')
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setLoadError(loadError instanceof Error && loadError.message ? loadError.message : 'Availability could not be loaded.')
        setLoadState('failed')
      })
    return () => {
      cancelled = true
    }
  }, [loadAttempt, providerId])

  function windowsFor(weekday: number): WorkingHour[] {
    return workingHours.filter((window) => window.weekday === weekday)
  }

  function replaceWindow(weekday: number, index: number, patch: Partial<WorkingHour>): void {
    setWorkingHours((current) => {
      let seen = -1
      return current.map((window) => {
        if (window.weekday !== weekday) return window
        seen += 1
        return seen === index ? { ...window, ...patch } : window
      })
    })
  }

  function removeWindow(weekday: number, index: number): void {
    setWorkingHours((current) => {
      let seen = -1
      return current.filter((window) => {
        if (window.weekday !== weekday) return true
        seen += 1
        return seen !== index
      })
    })
  }

  function addWindow(weekday: number): void {
    setWorkingHours((current) => [...current, { weekday, startsLocal: '09:00', endsLocal: '17:00' }])
  }

  function setDayOpen(weekday: number, open: boolean): void {
    if (open) addWindow(weekday)
    else setWorkingHours((current) => current.filter((window) => window.weekday !== weekday))
  }

  function updateBlock(index: number, patch: Partial<EditableBlock>): void {
    setBlocks((current) => current.map((block, blockIndex) => (blockIndex === index ? { ...block, ...patch } : block)))
  }

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setSummary(null)
    try {
      const response = await fetch(`/api/providers/${providerId}/availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotMinutes: Number(slotMinutes),
          workingHours: workingHours.toSorted(
            (left, right) => left.weekday - right.weekday || left.startsLocal.localeCompare(right.startsLocal),
          ),
          blocks: blocks.map(({ startsAt, endsAt, reason }) => ({
            startsAt,
            endsAt,
            reason: reason.trim() === '' ? null : reason.trim(),
          })),
        }),
      })
      const body = (await response.json()) as SaveSummary | ErrorEnvelope
      if (!response.ok) {
        setError('message' in body && body.message ? body.message : 'Availability could not be saved.')
        return
      }
      setSummary(body as SaveSummary)
    } catch {
      setError('Availability could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="pip-availability-page">
      <h1>Availability</h1>
      <p className="pip-time-zone">
        Time zone: <strong>{timeZone}</strong>
      </p>

      {loadState === 'loading' ? <p>Loading availability…</p> : null}
      {loadState === 'failed' ? (
        <div className="pip-error" data-testid="availability-load-error" role="alert">
          <p>{loadError}</p>
          <button className="pip-button-secondary" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            Try again
          </button>
        </div>
      ) : null}
      {loadState === 'ready' && error ? <p className="pip-error" role="alert">{error}</p> : null}

      {loadState === 'ready' ? (
        <form data-testid="availability-form" className="pip-availability-form" onSubmit={save}>
          <div className="pip-field">
            <label htmlFor="slot-minutes">Slot length in minutes</label>
            <input
              id="slot-minutes"
              className="pip-input"
              type="number"
              min="5"
              max="240"
              step="1"
              value={slotMinutes}
              onChange={(event) => setSlotMinutes(event.target.value)}
              required
            />
          </div>

          <fieldset className="pip-availability-section">
            <legend>Working hours</legend>
            {WEEKDAYS.map((day, weekday) => {
              const windows = windowsFor(weekday)
              return (
                <fieldset className="pip-weekday" data-testid={`weekday-${weekday}`} key={day}>
                  <legend>{day}</legend>
                  <label className="pip-checkbox-label">
                    <input
                      type="checkbox"
                      checked={windows.length > 0}
                      onChange={(event) => setDayOpen(weekday, event.target.checked)}
                    />
                    {day} open
                  </label>
                  {windows.map((window, index) => (
                    <div className="pip-window-row" key={`${weekday}-${index}`}>
                      <label>
                        {day} start {index + 1}
                        <input
                          className="pip-input"
                          type="time"
                          value={window.startsLocal}
                          onChange={(event) => replaceWindow(weekday, index, { startsLocal: event.target.value })}
                          required
                        />
                      </label>
                      <label>
                        {day} end {index + 1}
                        <input
                          className="pip-input"
                          type="time"
                          value={window.endsLocal}
                          onChange={(event) => replaceWindow(weekday, index, { endsLocal: event.target.value })}
                          required
                        />
                      </label>
                      <button className="pip-button-secondary" type="button" onClick={() => removeWindow(weekday, index)}>
                        Remove {day} window {index + 1}
                      </button>
                    </div>
                  ))}
                  <button className="pip-button-secondary" type="button" onClick={() => addWindow(weekday)}>
                    Add {day} window
                  </button>
                </fieldset>
              )
            })}
          </fieldset>

          <fieldset className="pip-availability-section">
            <legend>Blocks</legend>
            {blocks.length === 0 ? <p>No blocks.</p> : null}
            {blocks.map((block, index) => (
              <fieldset className="pip-block" key={block.id}>
                <legend>Block {index + 1}</legend>
                <label>
                  Block {index + 1} start
                  <input
                    className="pip-input"
                    type="text"
                    inputMode="text"
                    placeholder="2026-08-18T13:00:00-05:00"
                    value={block.startsAt}
                    onChange={(event) => updateBlock(index, { startsAt: event.target.value })}
                    required
                  />
                </label>
                <label>
                  Block {index + 1} end
                  <input
                    className="pip-input"
                    type="text"
                    inputMode="text"
                    placeholder="2026-08-18T14:00:00-05:00"
                    value={block.endsAt}
                    onChange={(event) => updateBlock(index, { endsAt: event.target.value })}
                    required
                  />
                </label>
                <label>
                  Block {index + 1} reason
                  <input
                    className="pip-input"
                    type="text"
                    maxLength={500}
                    value={block.reason}
                    onChange={(event) => updateBlock(index, { reason: event.target.value })}
                  />
                </label>
                <button
                  className="pip-button-secondary"
                  type="button"
                  onClick={() => setBlocks((current) => current.filter((_, blockIndex) => blockIndex !== index))}
                >
                  Remove block {index + 1}
                </button>
              </fieldset>
            ))}
            <button
              className="pip-button-secondary"
              type="button"
              onClick={() => setBlocks((current) => [...current, newBlock()])}
            >
              Add block
            </button>
          </fieldset>

          <button className="pip-button-primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save availability'}
          </button>
        </form>
      ) : null}

      {summary ? (
        <section className="pip-save-summary" aria-live="polite">
          <p><strong>Saved. {summary.removedOpenSlots} open slots removed.</strong></p>
          {summary.preservedOutOfHours.length > 0 ? (
            <>
              <p>These booked appointments are now outside your hours and have been kept:</p>
              <ul data-testid="availability-collision-list">
                {summary.preservedOutOfHours.map((appointment) => (
                  <li key={appointment.appointmentId}>
                    {localAppointmentTime(appointment.startsAt, timeZone)} · {appointment.patientRef}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  )
}

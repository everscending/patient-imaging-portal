'use client'

// Option A ("week rows") availability editor — one row per day, hours as
// removable chips, native datetime-local pickers for time-off blocks, and a
// sticky save bar. Same load/save contract as before: the PATCH payload and
// the availability API are unchanged; blocks are converted between the
// provider zone's RFC 3339 offset form (API) and naive datetime-local values
// (inputs) via lib/time/zones.
import { useEffect, useState } from 'react'
import { useProviderShell } from '../../../../components/shell/ProviderShell'
import { toLocal, toRfc3339, zonedTimeToInstant } from '../../../../lib/time/zones'

type WorkingHour = {
  weekday: number
  startsLocal: string
  endsLocal: string
}

type EditableBlock = {
  id: string
  startsLocal: string
  endsLocal: string
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
  return { id: crypto.randomUUID(), startsLocal: '', endsLocal: '', reason: '' }
}

function rfcToLocalInput(instant: string, timeZone: string): string {
  const local = toLocal(timeZone, new Date(instant))
  return `${local.date}T${local.time.slice(0, 5)}`
}

function localInputToRfc(value: string, timeZone: string): string {
  const [date, time] = value.split('T')
  if (!date || !time) throw new Error(`not a datetime-local value: ${value}`)
  return toRfc3339(timeZone, zonedTimeToInstant(timeZone, date, time.length === 5 ? `${time}:00` : time))
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

function fingerprint(slotMinutes: string, workingHours: WorkingHour[], blocks: EditableBlock[]): string {
  return JSON.stringify({ slotMinutes, workingHours, blocks: blocks.map(({ startsLocal, endsLocal, reason }) => ({ startsLocal, endsLocal, reason })) })
}

// Pre-flight check so the common mistakes get an inline, specific message and
// never reach the API. The server remains the authority for everything else
// (e.g. DST-incompatible slot lengths).
function localProblem(workingHours: WorkingHour[], blocks: EditableBlock[]): { message: string; weekday: number | null } | null {
  for (let weekday = 0; weekday < WEEKDAYS.length; weekday++) {
    const windows = workingHours.filter((window) => window.weekday === weekday)
    for (const window of windows) {
      if (window.endsLocal <= window.startsLocal) {
        return { message: `${WEEKDAYS[weekday]}: a window must end after it starts (${window.startsLocal}–${window.endsLocal}).`, weekday }
      }
    }
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        const a = windows[i]!
        const b = windows[j]!
        if (a.startsLocal < b.endsLocal && b.startsLocal < a.endsLocal) {
          return { message: `${WEEKDAYS[weekday]}: ${b.startsLocal}–${b.endsLocal} overlaps ${a.startsLocal}–${a.endsLocal}.`, weekday }
        }
      }
    }
  }
  for (const block of blocks) {
    if (block.startsLocal && block.endsLocal && block.endsLocal <= block.startsLocal) {
      return { message: 'Time off must end after it starts.', weekday: null }
    }
  }
  return null
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
  const [baseline, setBaseline] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [invalidWeekday, setInvalidWeekday] = useState<number | null>(null)
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
        const loadedSlotMinutes = String(availability.slotMinutes)
        const loadedBlocks = availability.blocks.map((block) => ({
          id: block.id,
          startsLocal: rfcToLocalInput(block.startsAt, availability.timeZone),
          endsLocal: rfcToLocalInput(block.endsAt, availability.timeZone),
          reason: block.reason ?? '',
        }))
        setTimeZone(availability.timeZone)
        setSlotMinutes(loadedSlotMinutes)
        setWorkingHours(availability.workingHours)
        setBlocks(loadedBlocks)
        setBaseline(fingerprint(loadedSlotMinutes, availability.workingHours, loadedBlocks))
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

  function copyToWeekdays(weekday: number): void {
    const template = windowsFor(weekday)
    setWorkingHours((current) => [
      ...current.filter((window) => window.weekday === 0 || window.weekday === 6),
      ...[1, 2, 3, 4, 5].flatMap((target) => template.map((window) => ({ ...window, weekday: target }))),
    ])
  }

  function updateBlock(index: number, patch: Partial<EditableBlock>): void {
    setBlocks((current) => current.map((block, blockIndex) => (blockIndex === index ? { ...block, ...patch } : block)))
  }

  const dirty = loadState === 'ready' && fingerprint(slotMinutes, workingHours, blocks) !== baseline

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setSummary(null)
    const problem = localProblem(workingHours, blocks)
    if (problem) {
      setError(problem.message)
      setInvalidWeekday(problem.weekday)
      return
    }
    setInvalidWeekday(null)
    setSaving(true)
    try {
      const response = await fetch(`/api/providers/${providerId}/availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotMinutes: Number(slotMinutes),
          workingHours: workingHours.toSorted(
            (left, right) => left.weekday - right.weekday || left.startsLocal.localeCompare(right.startsLocal),
          ),
          blocks: blocks.map(({ startsLocal, endsLocal, reason }) => ({
            startsAt: localInputToRfc(startsLocal, timeZone),
            endsAt: localInputToRfc(endsLocal, timeZone),
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
      setBaseline(fingerprint(slotMinutes, workingHours, blocks))
    } catch {
      setError('Availability could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="pip-availability-page">
      <header className="pip-avail-header">
        <div>
          <h1>Availability</h1>
          <p className="pip-time-zone">
            Time zone: <strong>{timeZone}</strong>
          </p>
        </div>
        {loadState === 'ready' ? (
          <div className="pip-field pip-avail-slot-length">
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
              form="availability-form"
            />
          </div>
        ) : null}
      </header>

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
        <form id="availability-form" data-testid="availability-form" className="pip-availability-form" onSubmit={save}>
          <div className="pip-avail-week">
            {WEEKDAYS.map((day, weekday) => {
              const windows = windowsFor(weekday)
              const open = windows.length > 0
              return (
                <div
                  className={`pip-avail-row${open ? '' : ' pip-avail-row--closed'}${invalidWeekday === weekday ? ' pip-avail-row--invalid' : ''}`}
                  data-testid={`weekday-${weekday}`}
                  key={day}
                >
                  <label className="pip-avail-day">
                    <input
                      className="pip-avail-toggle"
                      type="checkbox"
                      checked={open}
                      onChange={(event) => setDayOpen(weekday, event.target.checked)}
                    />
                    <span className="pip-avail-dayname">{day}</span>
                    <span className="pip-visually-hidden"> open</span>
                  </label>
                  <div className="pip-avail-chips">
                    {!open ? <span className="pip-avail-closed">Closed</span> : null}
                    {windows.map((window, index) => (
                      <span className="pip-avail-chip" key={`${weekday}-${index}`}>
                        <label className="pip-visually-hidden" htmlFor={`window-${weekday}-${index}-start`}>
                          {day} start {index + 1}
                        </label>
                        <input
                          id={`window-${weekday}-${index}-start`}
                          className="pip-avail-time"
                          type="time"
                          value={window.startsLocal}
                          onChange={(event) => replaceWindow(weekday, index, { startsLocal: event.target.value })}
                          required
                        />
                        <span aria-hidden="true">–</span>
                        <label className="pip-visually-hidden" htmlFor={`window-${weekday}-${index}-end`}>
                          {day} end {index + 1}
                        </label>
                        <input
                          id={`window-${weekday}-${index}-end`}
                          className="pip-avail-time"
                          type="time"
                          value={window.endsLocal}
                          onChange={(event) => replaceWindow(weekday, index, { endsLocal: event.target.value })}
                          required
                        />
                        <button
                          className="pip-avail-chip-remove"
                          type="button"
                          aria-label={`Remove ${day} window ${index + 1}`}
                          onClick={() => removeWindow(weekday, index)}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    {open ? (
                      <button
                        className="pip-avail-chip pip-avail-chip-add"
                        type="button"
                        aria-label={`Add ${day} window`}
                        onClick={() => addWindow(weekday)}
                      >
                        ＋ hours
                      </button>
                    ) : null}
                  </div>
                  {open ? (
                    <button
                      className="pip-avail-copy"
                      type="button"
                      aria-label={`Copy ${day} to weekdays`}
                      onClick={() => copyToWeekdays(weekday)}
                    >
                      Copy to weekdays
                    </button>
                  ) : <span />}
                </div>
              )
            })}
          </div>

          <section className="pip-avail-blocks" aria-label="Time off">
            <h2 className="pip-avail-blocks-heading">
              Time off <span className="pip-avail-hint">— hides matching open slots; booked appointments are kept and flagged</span>
            </h2>
            {blocks.length === 0 ? <p className="pip-avail-hint">No time off scheduled.</p> : null}
            {blocks.map((block, index) => (
              <div className="pip-avail-block" key={block.id}>
                <label className="pip-visually-hidden" htmlFor={`block-${index}-start`}>Block {index + 1} start</label>
                <input
                  id={`block-${index}-start`}
                  className="pip-input"
                  type="datetime-local"
                  value={block.startsLocal}
                  onChange={(event) => updateBlock(index, { startsLocal: event.target.value })}
                  required
                />
                <label className="pip-visually-hidden" htmlFor={`block-${index}-end`}>Block {index + 1} end</label>
                <input
                  id={`block-${index}-end`}
                  className="pip-input"
                  type="datetime-local"
                  value={block.endsLocal}
                  onChange={(event) => updateBlock(index, { endsLocal: event.target.value })}
                  required
                />
                <label className="pip-visually-hidden" htmlFor={`block-${index}-reason`}>Block {index + 1} reason</label>
                <input
                  id={`block-${index}-reason`}
                  className="pip-input"
                  type="text"
                  placeholder="Reason (optional)"
                  maxLength={500}
                  value={block.reason}
                  onChange={(event) => updateBlock(index, { reason: event.target.value })}
                />
                <button
                  className="pip-avail-chip-remove"
                  type="button"
                  aria-label={`Remove block ${index + 1}`}
                  onClick={() => setBlocks((current) => current.filter((_, blockIndex) => blockIndex !== index))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="pip-button-secondary pip-avail-add-block"
              type="button"
              aria-label="Add block"
              onClick={() => setBlocks((current) => [...current, newBlock()])}
            >
              ＋ Add time off
            </button>
          </section>

          <div className="pip-avail-savebar">
            <span className="pip-avail-hint">
              {dirty ? <strong>Unsaved changes</strong> : 'All changes saved'} · saving regenerates open slots; booked appointments are never moved
            </span>
            <button className="pip-button-primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save availability'}
            </button>
          </div>
        </form>
      ) : null}

      {summary ? (
        <section className="pip-save-summary" aria-live="polite">
          <p><strong>Availability saved. {summary.generatedOpenSlots} open slots regenerated.</strong></p>
          {summary.preservedOutOfHours.length > 0 ? (
            <>
              <p>
                {summary.preservedOutOfHours.length === 1
                  ? 'This booked appointment falls outside your hours and was kept:'
                  : `These ${summary.preservedOutOfHours.length} booked appointments fall outside your hours and were kept:`}
              </p>
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

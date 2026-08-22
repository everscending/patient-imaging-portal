'use client'

// Admin audit log (UX_SPEC §4.13): time · actor · action · target · outcome,
// identifiers only. This screen adds what the API already supported but the
// old UI ignored: action/actor/time filters, cursor pagination, readable
// timestamps, and an outcome badge. Full identifiers stay visible — audit
// review means copying exact IDs, so nothing is truncated.
import { useCallback, useEffect, useState } from 'react'
import { auditActions } from '../../../../lib/audit/actions'

type AuditEvent = {
  id: string
  occurredAt: string
  actorKind: string
  actorRef: string | null
  action: string
  targetKind: string
  targetId: string | null
  outcome: 'granted' | 'denied'
}

type Filters = { action: string; actorRef: string; from: string; to: string }

const EMPTY_FILTERS: Filters = { action: '', actorRef: '', from: '', to: '' }

function queryString(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams()
  if (filters.action) params.set('action', filters.action)
  if (filters.actorRef.trim()) params.set('actorRef', filters.actorRef.trim())
  if (filters.from) params.set('from', new Date(filters.from).toISOString())
  if (filters.to) params.set('to', new Date(filters.to).toISOString())
  if (cursor) params.set('cursor', cursor)
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

function eventTime(instant: string): string {
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.valueOf())) return instant
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(parsed)
}

export default function AuditLogPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async (filters: Filters, cursor: string | null): Promise<void> => {
    if (cursor) setLoadingMore(true)
    else setState('loading')
    try {
      const response = await fetch(`/api/admin/audit${queryString(filters, cursor)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('audit read failed')
      const body = (await response.json()) as { events: AuditEvent[]; nextCursor: string | null }
      setEvents((current) => (cursor ? [...current, ...body.events] : body.events))
      setNextCursor(body.nextCursor)
      setState('ready')
    } catch {
      if (!cursor) setState('failed')
    } finally {
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    void load(EMPTY_FILTERS, null)
  }, [load])

  function apply(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setApplied(draft)
    void load(draft, null)
  }

  function clear(): void {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
    void load(EMPTY_FILTERS, null)
  }

  const denied = events.filter((event) => event.outcome === 'denied').length

  return (
    <section data-testid="audit-log" aria-label="Audit log" className="pip-audit">
      <header className="pip-audit-header">
        <div>
          <h1>Audit log</h1>
          <p className="pip-audit-summary">
            {state === 'ready' ? (
              <>
                {events.length} event{events.length === 1 ? '' : 's'} loaded · {denied} denied
                {nextCursor ? ' · more available' : ''}
              </>
            ) : ' '}
          </p>
        </div>
      </header>

      <form className="pip-audit-filters" aria-label="Audit filters" onSubmit={apply}>
        <label>
          Action
          <select
            className="pip-input"
            value={draft.action}
            onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))}
          >
            <option value="">All actions</option>
            {auditActions.map((action) => <option key={action} value={action}>{action}</option>)}
          </select>
        </label>
        <label>
          Actor ID
          <input
            className="pip-input"
            placeholder="UUID"
            value={draft.actorRef}
            onChange={(event) => setDraft((current) => ({ ...current, actorRef: event.target.value }))}
          />
        </label>
        <label>
          From
          <input
            className="pip-input"
            type="datetime-local"
            value={draft.from}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
          />
        </label>
        <label>
          To
          <input
            className="pip-input"
            type="datetime-local"
            value={draft.to}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
          />
        </label>
        <div className="pip-audit-filter-actions">
          <button className="pip-button-primary" type="submit">Apply filters</button>
          <button className="pip-button-secondary" type="button" onClick={clear}>Clear</button>
        </div>
      </form>

      {state === 'loading' ? <p className="pip-notice" aria-live="polite">Loading audit events…</p> : null}
      {state === 'failed' ? (
        <div className="pip-error" role="alert">
          <p>The audit log could not be loaded.</p>
          <button className="pip-button-secondary" type="button" onClick={() => void load(applied, null)}>Try again</button>
        </div>
      ) : null}
      {state === 'ready' && events.length === 0 ? <p className="pip-notice">No audit events match these filters.</p> : null}

      {state === 'ready' && events.length > 0 ? (
        <div className="pip-audit-table-wrap">
          <table className="pip-audit-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr data-testid="audit-row" key={event.id} className={event.outcome === 'denied' ? 'pip-audit-row--denied' : ''}>
                  <td className="pip-audit-time">{eventTime(event.occurredAt)}</td>
                  <td>
                    <span className="pip-audit-kind">{event.actorKind}</span>
                    <span className="pip-audit-id">{event.actorRef ?? '—'}</span>
                  </td>
                  <td className="pip-audit-action">{event.action}</td>
                  <td>
                    <span className="pip-audit-kind">{event.targetKind}</span>
                    <span className="pip-audit-id">{event.targetId ?? '—'}</span>
                  </td>
                  <td>
                    <strong className={`pip-audit-badge pip-audit-badge--${event.outcome}`}>
                      {event.outcome === 'granted' ? 'Granted' : 'Denied'}
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {state === 'ready' && nextCursor ? (
        <button
          className="pip-button-secondary pip-audit-more"
          type="button"
          disabled={loadingMore}
          onClick={() => void load(applied, nextCursor)}
        >
          {loadingMore ? 'Loading…' : 'Load older events'}
        </button>
      ) : null}
    </section>
  )
}

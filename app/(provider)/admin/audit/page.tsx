'use client'

import { useEffect, useState } from 'react'

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

export default function AuditLogPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])

  useEffect(() => {
    void fetch('/api/admin/audit', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { events: [] }))
      .then((body: { events: AuditEvent[] }) => setEvents(body.events))
  }, [])

  return (
    <section data-testid="audit-log" aria-label="Audit log">
      <h1>Audit log</h1>
      {events.map((event) => (
        <article data-testid="audit-row" key={event.id}>
          <span>{event.occurredAt}</span> <span>{event.actorKind}</span> <span>{event.actorRef ?? '—'}</span>{' '}
          <span>{event.action}</span> <span>{event.targetKind}</span> <span>{event.targetId ?? '—'}</span>{' '}
          <strong>{event.outcome === 'granted' ? 'Granted' : 'Denied'}</strong>
        </article>
      ))}
    </section>
  )
}

'use client'

type Slot = { id: string; startsAt: string; endsAt: string }

export type SlotListProps = {
  slots: Slot[]
  viewerTimeZone: string
  providerTimeZone: string
  selectedSlotId: string | null
  unavailableSlotIds: ReadonlySet<string>
  onSelect: (slot: Slot) => void
}

function viewerLabel(instant: string, viewerTimeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: viewerTimeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(instant))
}

function dayLabel(instant: string, viewerTimeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: viewerTimeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(instant))
}

/** Renders the server's slot array verbatim; grouping changes presentation only. */
export default function SlotList({
  slots,
  viewerTimeZone,
  providerTimeZone,
  selectedSlotId,
  unavailableSlotIds,
  onSelect,
}: SlotListProps) {
  if (slots.length === 0) {
    return <p className="pip-notice" data-testid="slot-empty">No open times are available for this provider.</p>
  }

  const groups = new Map<string, Slot[]>()
  for (const slot of slots) {
    const day = dayLabel(slot.startsAt, viewerTimeZone)
    groups.set(day, [...(groups.get(day) ?? []), slot])
  }

  return (
    <section data-testid="slot-list" aria-label={`Open appointment times in ${viewerTimeZone}`} className="pip-slot-list">
      <p className="pip-time-zone">Times shown in your time zone: {viewerTimeZone}. Provider time zone: {providerTimeZone}.</p>
      {[...groups].map(([day, daySlots]) => (
        <section key={day} className="pip-slot-day" aria-labelledby={`slot-day-${day}`}>
          <h2 id={`slot-day-${day}`}>{day}</h2>
          <div className="pip-slot-grid">
            {daySlots.map((slot) => {
              const unavailable = unavailableSlotIds.has(slot.id)
              return (
                <button
                  key={slot.id}
                  type="button"
                  className="pip-slot-button"
                  data-testid="slot-item"
                  data-slot-id={slot.id}
                  aria-pressed={selectedSlotId === slot.id}
                  disabled={unavailable}
                  onClick={() => onSelect(slot)}
                >
                  {viewerLabel(slot.startsAt, viewerTimeZone)}
                  {unavailable ? ' — no longer available' : ''}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </section>
  )
}

'use client'

import { useEffect, useState } from 'react'

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
  // One day on screen at a time: paging is only between days that actually
  // have open times (a day with nothing open is never a page), so the arrows
  // always land somewhere useful.
  const [dayIndex, setDayIndex] = useState(0)
  useEffect(() => {
    setDayIndex(0)
  }, [slots])

  const groups = new Map<string, Slot[]>()
  for (const slot of slots) {
    const day = dayLabel(slot.startsAt, viewerTimeZone)
    groups.set(day, [...(groups.get(day) ?? []), slot])
  }
  const days = [...groups]
  const boundedIndex = Math.min(dayIndex, Math.max(0, days.length - 1))
  const shown = days[boundedIndex]

  return (
    <section data-testid="slot-list" aria-label={`Open appointment times in ${viewerTimeZone}`} className="pip-slot-list">
      <p className="pip-time-zone">Times shown in your time zone: {viewerTimeZone}. Provider time zone: {providerTimeZone}.</p>
      {slots.length === 0 && <p className="pip-notice" data-testid="slot-empty">No open times are available for this provider.</p>}
      {shown ? (
        <section className="pip-slot-day" aria-label={shown[0]}>
          <div className="pip-slot-day-nav">
            <button
              type="button"
              className="pip-slot-day-arrow"
              data-testid="slot-day-previous"
              aria-label="Previous day with open times"
              disabled={boundedIndex === 0}
              onClick={() => setDayIndex(boundedIndex - 1)}
            >
              ‹
            </button>
            <h2 aria-live="polite">
              {shown[0]}
              <span className="pip-slot-day-count"> — day {boundedIndex + 1} of {days.length} with open times</span>
            </h2>
            <button
              type="button"
              className="pip-slot-day-arrow"
              data-testid="slot-day-next"
              aria-label="Next day with open times"
              disabled={boundedIndex >= days.length - 1}
              onClick={() => setDayIndex(boundedIndex + 1)}
            >
              ›
            </button>
          </div>
          <div className="pip-slot-grid" data-testid="slot-grid">
            {shown[1].map((slot) => {
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
      ) : null}
    </section>
  )
}

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import SlotList from '../../../components/scheduling/SlotList'

type Service = { id: string; slug: string; name: string }
type Provider = { id: string; fullName: string; timeZone: string }
type Slot = { id: string; startsAt: string; endsAt: string }
type Appointment = { id: string; providerName: string; serviceName: string; startsAt: string }
type ApiError = { error?: string; message?: string }

const LOSER_HEADING = 'That slot is no longer available.'
const LOSER_GUIDANCE = ' Someone booked it moments ago. Please choose another time.'

function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function localTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(instant))
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not load booking options.')
  return response.json() as Promise<T>
}

export default function BookPage() {
  const [services, setServices] = useState<Service[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [slots, setSlots] = useState<Slot[]>([])
  const [serviceId, setServiceId] = useState('')
  const [providerId, setProviderId] = useState('')
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null)
  const [unavailableSlotIds, setUnavailableSlotIds] = useState<Set<string>>(new Set())
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [success, setSuccess] = useState<Appointment | null>(null)
  const viewerZone = useMemo(viewerTimeZone, [])
  const providerIdRef = useRef(providerId)
  const serviceIdRef = useRef(serviceId)
  providerIdRef.current = providerId
  serviceIdRef.current = serviceId
  const provider = providers.find((candidate) => candidate.id === providerId) ?? null

  useEffect(() => {
    void json<{ services: Service[] }>('/api/services').then(({ services: next }) => setServices(next)).catch((cause: Error) => setError(cause.message))
  }, [])

  useEffect(() => {
    setProviders([])
    if (!serviceId) return
    void json<{ providers: Provider[] }>(`/api/providers?serviceId=${encodeURIComponent(serviceId)}`)
      .then(({ providers: next }) => {
        setProviders(next)
        if (providerIdRef.current && !next.some((candidate) => candidate.id === providerIdRef.current)) {
          setProviderId('')
          setSlots([])
          setSelectedSlot(null)
        }
      })
      .catch((cause: Error) => setError(cause.message))
  // Changing a service narrows this selector. It deliberately does not
  // client-filter a selected provider's shared slot grid.
  }, [serviceId])

  useEffect(() => {
    setSlots([])
    setSelectedSlot(null)
    setIdempotencyKey(null)
    setConflict(false)
    const activeServiceId = serviceIdRef.current
    if (!activeServiceId || !providerId) return
    const from = new Date()
    const to = new Date(from)
    to.setDate(to.getDate() + 60)
    void json<{ slots: Slot[] }>(`/api/slots?providerId=${encodeURIComponent(providerId)}&serviceId=${encodeURIComponent(activeServiceId)}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then(({ slots: next }) => setSlots(next))
      .catch((cause: Error) => setError(cause.message))
  // Slots are a provider grid; service selection is sent on the initial read
  // for server eligibility, but never used as a browser-side slot filter.
  }, [providerId])

  function selectSlot(slot: Slot): void {
    setSelectedSlot(slot)
    setIdempotencyKey(crypto.randomUUID())
    setConflict(false)
    setError(null)
    setSuccess(null)
  }

  async function confirm(): Promise<void> {
    if (!selectedSlot || !serviceId) return
    const key = idempotencyKey ?? crypto.randomUUID()
    if (!idempotencyKey) setIdempotencyKey(key)
    setError(null)
    setConflict(false)
    const response = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: selectedSlot.id, serviceId, idempotencyKey: key }),
    })
    if (response.ok) {
      const appointment = await response.json() as Appointment
      setSuccess(appointment)
      setSlots((current) => current.filter((slot) => slot.id !== selectedSlot.id))
      setSelectedSlot(null)
      setIdempotencyKey(null)
      return
    }
    const body = await response.json().catch(() => ({})) as ApiError
    if (response.status === 409 && body.error === 'slot_unavailable') {
      setUnavailableSlotIds((current) => new Set(current).add(selectedSlot.id))
      setSelectedSlot(null)
      setConflict(true)
      return
    }
    setError(body.error === 'idempotency_key_reused' ? 'This confirmation key was already used. Choose a slot again.' : body.message ?? 'Could not confirm this appointment.')
  }

  return (
    <main className="pip-book-page">
      <h1>Book an appointment</h1>
      <div className="pip-field">
        <label htmlFor="service-select">Service</label>
        <select id="service-select" data-testid="service-select" className="pip-input" value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
          <option value="">Select a service</option>
          {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
        </select>
      </div>
      <div className="pip-field">
        <label htmlFor="provider-select">Provider</label>
        <select id="provider-select" data-testid="provider-select" className="pip-input" disabled={!serviceId} value={providerId} onChange={(event) => setProviderId(event.target.value)}>
          <option value="">Select a provider</option>
          {providers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.fullName}</option>)}
        </select>
        {serviceId && providers.length === 0 && <p className="pip-notice" data-testid="provider-empty">No providers offer this service.</p>}
      </div>
      {provider && <SlotList slots={slots} viewerTimeZone={viewerZone} providerTimeZone={provider.timeZone} selectedSlotId={selectedSlot?.id ?? null} unavailableSlotIds={unavailableSlotIds} onSelect={selectSlot} />}
      {selectedSlot && provider && (
        <section className="pip-book-confirmation" aria-label="Booking confirmation">
          <p>Confirm {services.find((service) => service.id === serviceId)?.name} with {provider.fullName}.</p>
          <p>Provider-local time: {localTime(selectedSlot.startsAt, provider.timeZone)} ({provider.timeZone})</p>
          <button type="button" className="pip-button-primary" data-testid="book-submit" onClick={() => void confirm()}>Confirm appointment</button>
        </section>
      )}
      {conflict && <p className="pip-error" data-testid="booking-conflict"><strong>{LOSER_HEADING}</strong>{LOSER_GUIDANCE}</p>}
      {error && <p className="pip-error" role="alert">{error}</p>}
      {success && <p className="pip-save-summary" data-testid="booking-success">Booked {success.serviceName} with {success.providerName} at {localTime(success.startsAt, viewerZone)}.</p>}
    </main>
  )
}

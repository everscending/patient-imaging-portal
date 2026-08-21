import http from 'k6/http'
import { check, fail, sleep } from 'k6'
import { authenticatedHeaders } from './lib/auth.js'

const BASE_URL = __ENV.BASE_URL || `http://localhost:${__ENV.PORT || '4310'}`
const EMAIL = __ENV.PATIENT_EMAIL || 'patient@demo.pip.test'
const PASSWORD = __ENV.PATIENT_PASSWORD || 'DemoPass!2026'
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || '60')
const RUN_ID = __ENV.RUN_ID

if (!/^[0-9a-f]{8}$/.test(RUN_ID)) {
  throw new Error('RUN_ID must be a unique eight-character lowercase hex value')
}

let completed = false

export const options = {
  stages: [
    { duration: '10s', target: 20 },
    { duration: '40s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: { checks: ['rate==1'] },
}

export function setup() {
  const headers = authenticatedHeaders(BASE_URL, EMAIL, PASSWORD)
  const service = http.get(`${BASE_URL}/api/services`, { headers }).json('services.0')
  if (!service?.id) fail('seeded dataset has no service')
  const provider = http.get(`${BASE_URL}/api/providers?serviceId=${service.id}`, { headers }).json('providers.0')
  if (!provider?.id) fail('seeded dataset has no provider offering the service')
  const from = new Date().toISOString()
  const to = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
  const slotsResponse = http.get(`${BASE_URL}/api/slots?providerId=${provider.id}&serviceId=${service.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers })
  const slots = slotsResponse.json('slots')
  if (!Array.isArray(slots) || slots.length < 50) fail('seeded dataset has fewer than 50 open future slots')

  const studies = http.get(`${BASE_URL}/api/studies`, { headers }).json('studies')
  if (!Array.isArray(studies) || studies.length === 0) fail('seeded dataset has no visible studies')
  let imageId = null
  for (const study of studies) {
    const detail = http.get(`${BASE_URL}/api/studies/${study.id}`, { headers }).json()
    const image = detail.images?.find((candidate) => candidate.url)
    if (image) {
      imageId = image.id
      break
    }
  }
  if (!imageId) fail('seeded dataset has no image that can be shared')
  return { headers, serviceId: service.id, slots: slots.slice(0, 50), imageId }
}

function idempotencyKey() {
  return `${RUN_ID}-0000-4000-8000-${String(__VU).padStart(12, '0')}`
}

export default function run(data) {
  if (completed) {
    sleep(1)
    return
  }
  completed = true

  const slot = data.slots[__VU - 1]
  const booking = http.post(`${BASE_URL}/api/appointments`, JSON.stringify({
    slotId: slot.id,
    serviceId: data.serviceId,
    idempotencyKey: idempotencyKey(),
  }), { headers: data.headers, tags: { operation: 'booking.create' } })
  check(booking, { 'booking write reaches persisted result': (response) => response.status === 200 || response.status === 201 })

  // A repeated RUN_ID reuses the booking and deliberately skips a duplicate
  // share. A fresh run creates exactly one share per newly created booking.
  if (booking.status === 201) {
    const share = http.post(`${BASE_URL}/api/shares`, JSON.stringify({
      resourceKind: 'image',
      resourceId: data.imageId,
      recipientEmail: `performance-${RUN_ID}-${__VU}@example.test`,
    }), { headers: data.headers, tags: { operation: 'share.create' } })
    check(share, { 'share write reaches persisted result': (response) => response.status === 201 })
  }

  // One write pair per VU gives both server-timing operations 50 samples
  // without creating thousands of durable appointments and share links.
  sleep(HOLD_SECONDS)
}

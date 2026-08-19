import http from 'k6/http'
import { check, fail, sleep } from 'k6'
import { Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || `http://localhost:${__ENV.PORT || '4310'}`
const EMAIL = __ENV.PATIENT_EMAIL || 'patient@demo.pip.test'
const PASSWORD = __ENV.PATIENT_PASSWORD || 'DemoPass!2026'

export const options = {
  stages: [
    { duration: '10s', target: 20 },
    { duration: '40s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: { pf5_slot_query_ms: ['p(95)<1000'], checks: ['rate==1'] },
}

const slotQuery = new Trend('pf5_slot_query_ms', true)

function authenticatedHeaders() {
  const response = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { operation: 'setup_login' },
  })
  if (response.status !== 200) fail(`seeded patient login failed: ${response.status}`)
  const session = response.cookies.pip_session?.[0]?.value
  if (!session) fail('seeded patient login returned no session cookie')
  return { Cookie: `pip_session=${session}` }
}

export function setup() {
  const headers = authenticatedHeaders()
  const servicesResponse = http.get(`${BASE_URL}/api/services`, { headers, tags: { operation: 'setup_services' } })
  const service = servicesResponse.json('services.0')
  if (servicesResponse.status !== 200 || !service?.id) fail('seeded dataset has no service')
  const providersResponse = http.get(`${BASE_URL}/api/providers?serviceId=${service.id}`, { headers, tags: { operation: 'setup_providers' } })
  const provider = providersResponse.json('providers.0')
  if (providersResponse.status !== 200 || !provider?.id) fail('seeded dataset has no provider offering the service')
  return { headers, serviceId: service.id, providerId: provider.id }
}

export default function run(data) {
  const from = new Date().toISOString()
  const to = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
  const url = `${BASE_URL}/api/slots?providerId=${data.providerId}&serviceId=${data.serviceId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  const response = http.get(url, { headers: data.headers, tags: { operation: 'pf5_slots' } })
  slotQuery.add(response.timings.duration)
  const slots = response.json('slots')
  if (!Array.isArray(slots)) fail(`slot query failed: ${response.status}`)
  if (slots.length === 0) fail('seeded dataset has no open future slots')
  check(response, { 'PF-5 slot query succeeds': (result) => result.status === 200 })
  sleep(1)
}

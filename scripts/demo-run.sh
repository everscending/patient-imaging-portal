#!/usr/bin/env bash
# JOR-212: one local, credential-free DEL-6 run whose complete output is the
# security scanner's public input. The real Next app talks only to the test
# Supabase boundary; the reminder fixture uses the local pip-testpg container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="$REPO_ROOT/tests/artifacts/demo-run.log"
WORK_ARTIFACT="$REPO_ROOT/.local/demo-run.$$.log"
SERVER_PID=""
REMINDER_DRIVER="$REPO_ROOT/.local/demo-reminder.ts"

mkdir -p "$(dirname "$ARTIFACT")" "$REPO_ROOT/.local"
: > "$WORK_ARTIFACT"

stop_server() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

cleanup() {
  stop_server
  rm -f "$REMINDER_DRIVER"
  rm -f "$WORK_ARTIFACT"
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"

# Resolve the application address through lib/config.ts's Playwright fallback;
# this is config.port (default 4310), never a well-known-port assumption.
APP_PORT="$(NODE_NO_WARNINGS=1 node --input-type=module -e "process.argv[1]='playwright'; globalThis.__dirname=process.cwd() + '/lib'; const {config}=await import('./lib/config.ts'); process.stdout.write(String(config.port))")"
APP_URL="http://localhost:$APP_PORT"

# When the shared local fixture already exists, propagate its published port.
# The reminder fixture creates it when absent and performs this same lookup.
if docker inspect pip-testpg >/dev/null 2>&1; then
  CONTAINER_PORT="$(docker inspect --format '{{range $port, $binding := .NetworkSettings.Ports}}{{$port}}{{end}}' pip-testpg | sed -n '1{s#/tcp##;p;}')"
  PUBLISHED="$(docker port pip-testpg "$CONTAINER_PORT" | sed -n '1p')"
  export TEST_PG_PORT="${PUBLISHED##*:}"
fi

node e2e/fixtures/start-test-server.mjs >> "$WORK_ARTIFACT" 2>&1 &
SERVER_PID=$!

APP_URL="$APP_URL" node --input-type=module - >> "$WORK_ARTIFACT" 2>&1 <<'NODE'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request } from '@playwright/test'

const appUrl = process.env.APP_URL
if (!appUrl) throw new Error('demo-run: configured app URL is unavailable')

for (let attempt = 0; attempt < 240; attempt += 1) {
  try {
    const response = await fetch(appUrl)
    if (response.status < 500) break
  } catch {
    if (attempt === 239) throw new Error('demo-run: app did not become ready')
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

const fakeState = JSON.parse(await readFile('.local/fake-auth-server.json', 'utf8'))
const fakeUrl = String(fakeState.url)
const fixture = await request.newContext()
const patient = await request.newContext({ baseURL: appUrl })

async function expectStatus(response, accepted, step) {
  if (!accepted.includes(response.status())) throw new Error(`demo-run: ${step} failed`)
  return response
}

await expectStatus(await fixture.post(`${fakeUrl}/__test__/reset-identity`), [200], 'identity reset')
const email = `demo-run-${randomUUID()}@example.test`
const password = 'DemoRunPassword9'
await expectStatus(await patient.post('/api/auth/register', { data: { email, password } }), [201], 'registration')
await expectStatus(await patient.post('/api/auth/login', { data: { email, password } }), [200], 'login')
await expectStatus(await patient.post('/api/identity/verify', {
  data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
}), [200], 'identity verification')
console.log('DEMO_STEP_COMPLETE identity-verification')

const studyId = '99669966-9966-4966-8966-996699669966'
const clipId = 'ee11ee11-ee11-4e11-8e11-ee11ee11ee11'
const imageId = '10000000-0000-4000-8000-000000000001'
const reportId = 'bb88bb88-bb88-4b88-8b88-bb88bb88bb88'
await expectStatus(await patient.get(`/api/studies/${studyId}`), [200], 'image viewing')
await expectStatus(await patient.get(`/api/studies/${studyId}/clips/${clipId}`), [200], 'cine viewing')
console.log('DEMO_STEP_COMPLETE image-and-cine-viewing')

for (const [resourceKind, resourceId] of [['image', imageId], ['report', reportId]]) {
  await expectStatus(await patient.post('/api/shares', {
    data: { resourceKind, resourceId, recipientEmail: `recipient-${randomUUID()}@example.test` },
  }), [201], `${resourceKind} sharing`)
  console.log(`DEMO_STEP_COMPLETE ${resourceKind}-sharing`)
}

await expectStatus(await patient.get(`/api/reports/${reportId}`), [200], 'report')
console.log('DEMO_STEP_COMPLETE report')

await expectStatus(await fixture.post(`${fakeUrl}/__test__/reset-availability`), [200], 'availability reset')
const provider = await request.newContext({ baseURL: appUrl })
await expectStatus(await provider.post('/api/auth/login', {
  data: { email: 'avery.chen@example.test', password: 'ProviderFixturePassword9' },
}), [200], 'provider login')
const providerId = '66336633-6633-4633-8633-663366336633'
await expectStatus(await provider.patch(`/api/providers/${providerId}/availability`, {
  data: {
    slotMinutes: 20,
    workingHours: [
      { weekday: 1, startsLocal: '08:00', endsLocal: '18:00' },
      { weekday: 2, startsLocal: '09:00', endsLocal: '17:00' },
    ],
    blocks: [],
  },
}), [200], 'availability setup')
console.log('DEMO_STEP_COMPLETE availability-setup')

async function openBooking() {
  await expectStatus(await fixture.post(`${fakeUrl}/__test__/reset-booking`), [200], 'booking reset')
  const servicesResponse = await expectStatus(await patient.get('/api/services'), [200], 'services')
  const services = await servicesResponse.json()
  const serviceId = services.services[0].id
  const providersResponse = await expectStatus(await patient.get(`/api/providers?serviceId=${serviceId}`), [200], 'providers')
  const providers = await providersResponse.json()
  const bookingProviderId = providers.providers[0].id
  const from = new Date().toISOString()
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
  const query = new URLSearchParams({ providerId: bookingProviderId, serviceId, from, to })
  const slotsResponse = await expectStatus(await patient.get(`/api/slots?${query}`), [200], 'slots')
  const slots = await slotsResponse.json()
  return { serviceId, slots: slots.slots }
}

const first = await openBooking()
const booked = await expectStatus(await patient.post('/api/appointments', {
  data: { slotId: first.slots[0].id, serviceId: first.serviceId, idempotencyKey: randomUUID() },
}), [201], 'booking')
await booked.json()
console.log('DEMO_STEP_COMPLETE booking')

const race = await openBooking()
const contenders = await Promise.all([
  patient.post('/api/appointments', {
    data: { slotId: race.slots[0].id, serviceId: race.serviceId, idempotencyKey: randomUUID() },
  }),
  patient.post('/api/appointments', {
    data: { slotId: race.slots[0].id, serviceId: race.serviceId, idempotencyKey: randomUUID() },
  }),
])
const raceStatuses = contenders.map((response) => response.status()).sort((left, right) => left - right)
if (JSON.stringify(raceStatuses) !== JSON.stringify([201, 409])) throw new Error('demo-run: no-double-book failed')
console.log('DEMO_STEP_COMPLETE no-double-book')

const auditResponse = await expectStatus(
  await fixture.get(`${fakeUrl}/__test__/identity-state`),
  [200],
  'audit detail capture',
)
const auditBody = await auditResponse.json()
for (const event of auditBody.auditEvents) {
  console.log(`DEMO_AUDIT_DETAIL ${JSON.stringify({ action: event.action, targetId: event.target_id, outcome: event.outcome, detail: event.detail })}`)
}

await Promise.all([provider.dispose(), patient.dispose(), fixture.dispose()])
NODE

stop_server

# The shared launcher must finish its whole process tree before the producer
# continues, or the next gate stage cannot reuse config.port.
APP_PORT="$APP_PORT" node --input-type=module - >> "$WORK_ARTIFACT" 2>&1 <<'NODE'
import { once } from 'node:events'
import { createServer } from 'node:http'

const server = createServer()
server.listen(Number(process.env.APP_PORT), '127.0.0.1')
await once(server, 'listening')
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
console.log('DEMO_PORT_RELEASED')
NODE

# The fake HTTP boundary intentionally has no reschedule RPC. Drive the two
# real migrated transactions and capture their persisted audit detail.
npx vitest run --project integration tests/integration/reschedule-cancel-rpc.test.ts \
  --disableConsoleIntercept -t 'demo run emits reschedule and cancel audit details' >> "$WORK_ARTIFACT" 2>&1
printf '%s\n' 'DEMO_STEP_COMPLETE reschedule-and-cancel' >> "$WORK_ARTIFACT"

# Drive one real reminder dispatch and print its persisted audit detail while
# the exported E8 fixture still owns the isolated database.
cat > "$REMINDER_DRIVER" <<'TS'
import { startE8AcceptanceFixture } from '../tests/fixtures/e8-acceptance'

const fixture = await startE8AcceptanceFixture()
const auditLines: string[] = []
try {
  await fixture.prepareDueAppointments(1)
  const result = await fixture.runAuthorizedJob()
  if (result.status !== 200 || result.body.sent !== 1) throw new Error('demo-run: reminder failed')
  for (const audit of await fixture.dispatchAudits()) {
    auditLines.push(`DEMO_AUDIT_DETAIL ${JSON.stringify({
      action: audit.action,
      targetId: audit.appointmentId,
      outcome: audit.outcome,
      detail: audit.detail,
    })}`)
  }
} finally {
  await fixture.close()
  const output = fixture.appOutput()
  process.stdout.write(output.endsWith('\n') ? output : `${output}\n`)
}
for (const line of auditLines) console.log(line)
process.exit(0)
TS
npx vite-node "$REMINDER_DRIVER" >> "$WORK_ARTIFACT" 2>&1
rm -f "$REMINDER_DRIVER"
printf '%s\n' 'DEMO_STEP_COMPLETE reminder' >> "$WORK_ARTIFACT"

printf '%s\n' 'DEMO_RUN_COMPLETE' >> "$WORK_ARTIFACT"
mv "$WORK_ARTIFACT" "$ARTIFACT"

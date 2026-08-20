#!/usr/bin/env bash
# JOR-212: one local, credential-free DEL-6 run whose complete output is the
# security scanner's public input. The real Next app talks only to the test
# Supabase boundary; the reminder fixture uses the local pip-testpg container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="$REPO_ROOT/tests/artifacts/demo-run.log"
WORK_ARTIFACT="$REPO_ROOT/.local/demo-run.$$.log"
PHI_STATE="$REPO_ROOT/.local/demo-run-phi.json"
WORK_PHI="$REPO_ROOT/.local/demo-run-phi.$$.json"
SERVER_PID=""
RPC_DRIVER="$REPO_ROOT/.local/demo-rpc.ts"
REMINDER_DRIVER="$REPO_ROOT/.local/demo-reminder.ts"
PUBLISHED=0

mkdir -p "$(dirname "$ARTIFACT")" "$REPO_ROOT/.local"
: > "$WORK_ARTIFACT"
rm -f "$ARTIFACT" "$PHI_STATE"

stop_server() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

cleanup() {
  stop_server
  rm -f "$RPC_DRIVER" "$REMINDER_DRIVER" "$WORK_ARTIFACT" "$WORK_PHI"
  if [[ "$PUBLISHED" != 1 ]]; then rm -f "$PHI_STATE"; fi
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
  PORT_BINDING="$(docker port pip-testpg "$CONTAINER_PORT" | sed -n '1p')"
  export TEST_PG_PORT="${PORT_BINDING##*:}"
fi

node e2e/fixtures/start-test-server.mjs >> "$WORK_ARTIFACT" 2>&1 &
SERVER_PID=$!

APP_URL="$APP_URL" PHI_PATH="$WORK_PHI" node --input-type=module - >> "$WORK_ARTIFACT" 2>&1 <<'NODE'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { request } from '@playwright/test'
import {
  E2_PROVIDER_EMAIL,
  E2_PROVIDER_PASSWORD,
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_IMAGE_ID,
  E2_SEEDED_REPORT_ID,
  E2_SEEDED_STUDY_ID,
} from './e2e/fixtures/fake-auth-server.ts'

const appUrl = process.env.APP_URL
const phiPath = process.env.PHI_PATH
if (!appUrl || !phiPath) throw new Error('demo-run: configured local state is unavailable')

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

const resetIdentity = await expectStatus(await fixture.post(`${fakeUrl}/__test__/reset-identity`), [200], 'identity reset')
const { patientRef } = await resetIdentity.json()
const patientRowsResponse = await expectStatus(
  await fixture.get(`${fakeUrl}/rest/v1/patients?patient_ref=eq.${encodeURIComponent(patientRef)}`),
  [200],
  'driven patient rows',
)
const [drivenPatient] = await patientRowsResponse.json()
if (!drivenPatient) throw new Error('demo-run: driven patient row is unavailable')
const email = `demo-run-${randomUUID()}@example.test`
const password = 'DemoRunPassword9'
await expectStatus(await patient.post('/api/auth/register', { data: { email, password } }), [201], 'registration')
await expectStatus(await patient.post('/api/auth/login', { data: { email, password } }), [200], 'login')
await expectStatus(await patient.post('/api/identity/verify', {
  data: { patientRef: drivenPatient.patient_ref, dateOfBirth: drivenPatient.date_of_birth },
}), [200], 'identity verification')
console.log('DEMO_STEP_COMPLETE identity-verification')

const studyResponse = await expectStatus(await patient.get(`/api/studies/${E2_SEEDED_STUDY_ID}`), [200], 'image viewing')
const drivenStudy = await studyResponse.json()
await expectStatus(await patient.get(`/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`), [200], 'cine viewing')
console.log('DEMO_STEP_COMPLETE image-and-cine-viewing')

for (const [resourceKind, resourceId] of [['image', E2_SEEDED_IMAGE_ID], ['report', E2_SEEDED_REPORT_ID]]) {
  await expectStatus(await patient.post('/api/shares', {
    data: { resourceKind, resourceId, recipientEmail: `recipient-${randomUUID()}@example.test` },
  }), [201], `${resourceKind} sharing`)
  console.log(`DEMO_STEP_COMPLETE ${resourceKind}-sharing`)
}

const reportResponse = await expectStatus(await patient.get(`/api/reports/${E2_SEEDED_REPORT_ID}`), [200], 'report')
const drivenReport = await reportResponse.json()
console.log('DEMO_STEP_COMPLETE report')

const resetAvailability = await expectStatus(await fixture.post(`${fakeUrl}/__test__/reset-availability`), [200], 'availability reset')
const { providerId } = await resetAvailability.json()
const provider = await request.newContext({ baseURL: appUrl })
await expectStatus(await provider.post('/api/auth/login', {
  data: { email: E2_PROVIDER_EMAIL, password: E2_PROVIDER_PASSWORD },
}), [200], 'provider login')
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

await writeFile(phiPath, JSON.stringify({
  patients: [{
    date_of_birth: drivenPatient.date_of_birth,
    email: drivenPatient.email,
    full_name: drivenPatient.full_name,
    phone: drivenPatient.phone,
  }],
  providers: [{ full_name: drivenReport.signedByName }],
  reports: [{ findings: drivenReport.findings, impression: drivenReport.impression }],
  studies: [{ description: drivenStudy.description }],
}), { mode: 0o600 })

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
# real migrated transactions through a temporary database and capture their
# persisted audit detail without changing the shared integration fixture.
cat > "$RPC_DRIVER" <<'TS'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { ensureContainer, startRun, stopRun } from '../tests/setup/postgres'

const phiPath = process.env.PHI_PATH
if (!phiPath) throw new Error('demo-run: PHI state path is unavailable')
const containerName = 'pip-testpg'
const pgUser = 'postgres'
const run = await startRun(await ensureContainer())

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', containerName, 'psql', '-U', pgUser, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  ).trim()
}

const suffix = randomUUID().replaceAll('-', '')
const digits = [...suffix.slice(0, 10)].map((value) => Number.parseInt(value, 16) % 10).join('')
const patient = {
  id: randomUUID(),
  user_id: randomUUID(),
  patient_ref: 'PT-0001',
  date_of_birth: `${1950 + Number.parseInt(suffix.slice(0, 2), 16) % 50}-${String(1 + Number.parseInt(suffix.slice(2, 4), 16) % 12).padStart(2, '0')}-${String(1 + Number.parseInt(suffix.slice(4, 6), 16) % 28).padStart(2, '0')}`,
  full_name: `Patient-${suffix.slice(0, 8)} Record-${suffix.slice(8, 16)}`,
  email: `${suffix}@example.test`,
  phone: `+1 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`,
}
const provider = { id: randomUUID(), full_name: `Provider-${suffix.slice(16, 24)} Record-${suffix.slice(24, 32)}` }
const serviceId = randomUUID()
const slotIds = [randomUUID(), randomUUID()]

try {
  psql(`
    insert into auth.users (id) values (${literal(patient.user_id)}::uuid);
    insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email, phone)
      values (${literal(patient.id)}::uuid, ${literal(patient.user_id)}::uuid, ${literal(patient.patient_ref)},
        ${literal(patient.date_of_birth)}::date, ${literal(patient.full_name)}, ${literal(patient.email)}, ${literal(patient.phone)});
    insert into providers (id, full_name, time_zone) values (${literal(provider.id)}::uuid, ${literal(provider.full_name)}, 'America/Chicago');
    insert into services (id, slug, name) values (${literal(serviceId)}::uuid, ${literal(`svc-${suffix}`)}, 'Demo service');
    insert into provider_services (provider_id, service_id) values (${literal(provider.id)}::uuid, ${literal(serviceId)}::uuid);
    insert into slots (id, provider_id, starts_at, ends_at) values
      (${literal(slotIds[0]!)}::uuid, ${literal(provider.id)}::uuid, now() + interval '72 hours', now() + interval '73 hours'),
      (${literal(slotIds[1]!)}::uuid, ${literal(provider.id)}::uuid, now() + interval '74 hours', now() + interval '75 hours');
  `)
  if (!/^PT-\d{4}$/.test(psql(`select patient_ref from patients where id = ${literal(patient.id)}::uuid;`))) {
    throw new Error('demo-run: migrated patient reference is invalid')
  }
  const appointmentId = psql(`insert into appointments
      (slot_id, patient_id, provider_id, service_id, status, idempotency_key)
    values (${literal(slotIds[0]!)}::uuid, ${literal(patient.id)}::uuid, ${literal(provider.id)}::uuid,
      ${literal(serviceId)}::uuid, 'requested', ${literal(randomUUID())}) returning id;`)
  const claims = literal(JSON.stringify({ sub: patient.user_id }))
  const rescheduled = JSON.parse(psql(`set role app_user; set request.jwt.claims = ${claims};
    select row_to_json(result) from reschedule_appointment(
      ${literal(appointmentId)}::uuid, ${literal(slotIds[1]!)}::uuid, ${literal(patient.user_id)}::uuid, interval '24 hours'
    ) result;`))
  if (rescheduled.result_error !== null) throw new Error('demo-run: reschedule failed')
  const cancelled = JSON.parse(psql(`set role app_user; set request.jwt.claims = ${claims};
    select row_to_json(result) from cancel_appointment(
      ${literal(appointmentId)}::uuid, ${literal(patient.user_id)}::uuid, interval '24 hours'
    ) result;`))
  if (cancelled.result_error !== null) throw new Error('demo-run: cancel failed')

  const audits = JSON.parse(psql(`select coalesce(json_agg(json_build_object(
      'action', action, 'targetId', target_id, 'outcome', outcome, 'detail', detail) order by id), '[]'::json)::text
    from audit_events where target_id = ${literal(appointmentId)}::uuid;`))
  for (const audit of audits) console.log(`DEMO_AUDIT_DETAIL ${JSON.stringify(audit)}`)

  const rows = JSON.parse(await readFile(phiPath, 'utf8'))
  rows.patients.push({
    date_of_birth: patient.date_of_birth,
    email: patient.email,
    full_name: patient.full_name,
    phone: patient.phone,
  })
  rows.providers.push({ full_name: provider.full_name })
  await writeFile(phiPath, JSON.stringify(rows), { mode: 0o600 })
} finally {
  await stopRun(run)
}
TS
PHI_PATH="$WORK_PHI" npx vite-node "$RPC_DRIVER" >> "$WORK_ARTIFACT" 2>&1
rm -f "$RPC_DRIVER"
printf '%s\n' 'DEMO_STEP_COMPLETE reschedule-and-cancel' >> "$WORK_ARTIFACT"

# Drive one real reminder dispatch and print its persisted audit detail while
# the exported E8 fixture still owns the isolated database.
cat > "$REMINDER_DRIVER" <<'TS'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process') as typeof import('node:child_process')
const originalSpawn = childProcess.spawn
childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn(...args)
  child.stdout?.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)
  return child
}) as typeof originalSpawn
syncBuiltinESMExports()

const { startE8AcceptanceFixture } = await import('../tests/fixtures/e8-acceptance')
const phiPath = process.env.PHI_PATH
if (!phiPath) throw new Error('demo-run: PHI state path is unavailable')

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
  const [patientName, dateOfBirth, , providerName] = fixture.phiTerms()
  const [mail] = await fixture.mailMessages()
  if (!patientName || !dateOfBirth || !providerName || !mail) throw new Error('demo-run: reminder fixture rows are unavailable')
  const rows = JSON.parse(await readFile(phiPath, 'utf8'))
  rows.patients.push({ date_of_birth: dateOfBirth, email: mail.to, full_name: patientName, phone: null })
  rows.providers.push({ full_name: providerName })
  await writeFile(phiPath, JSON.stringify(rows), { mode: 0o600 })
} finally {
  await fixture.close()
}
for (const line of auditLines) console.log(line)
process.exit(0)
TS
PHI_PATH="$WORK_PHI" npx vite-node "$REMINDER_DRIVER" >> "$WORK_ARTIFACT" 2>&1
rm -f "$REMINDER_DRIVER"
printf '%s\n' 'DEMO_STEP_COMPLETE reminder' >> "$WORK_ARTIFACT"

printf '%s\n' 'DEMO_RUN_COMPLETE' >> "$WORK_ARTIFACT"
mv "$WORK_PHI" "$PHI_STATE"
mv "$WORK_ARTIFACT" "$ARTIFACT"
PUBLISHED=1

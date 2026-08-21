// JOR-230 — E9's live cross-patient refusal, audit, and log-scan proof.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { env } from 'node:process'

import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

import {
  DEMO_ACCOUNT_PASSWORD,
  DEMO_ADMIN_EMAIL,
  DEMO_PATIENT_EMAIL,
  DEMO_PROVIDER_EMAIL,
} from '../db/seed/rows'
import { scanArtifact, SEED_ROWS } from '../tests/adversarial/log-scan-engine'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

let app: ChildProcess
let appOutput = ''
let appUrl: string
let localEnvironment: Record<string, string>
let localSupabaseUrl: string
let scratchDir: string

type Patient = { id: string; user_id: string | null; patient_ref: string; date_of_birth: string }
type Provider = { id: string; user_id: string | null }
type Study = { id: string; patient_id: string; visit_id: string }
type Visit = { id: string; provider_id: string }
type Report = { id: string; patient_id: string; study_id: string; status: 'preliminary' | 'signed' }
type Audit = {
  action: string
  actor_ref: string | null
  occurred_at: string
  outcome: 'granted' | 'denied'
  target_id: string | null
  target_kind: string
}
// The admin audit API (app/api/admin/audit/route.ts) returns camelCase fields —
// a distinct shape from the Audit type above, which mirrors raw PostgREST rows.
type AuditLogEntry = {
  action: string
  actorKind: string
  actorRef: string | null
  occurredAt: string
  outcome: 'granted' | 'denied'
  targetId: string | null
  targetKind: string
}

function parseEnvironment(raw: string): Record<string, string> {
  return Object.fromEntries(raw.split('\n').flatMap((line) => {
    const separator = line.indexOf('=')
    if (separator < 1) return []
    return [[line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')]]
  }))
}

function startLocalRuntime(): Record<string, string> {
  const output = execFileSync('bash', ['scripts/local-del4-runtime.sh', 'run', 'env'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...env, PORT: '45330' },
    timeout: 300_000,
  })
  const values = parseEnvironment(output)
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SOURCE_REF_SALT']) {
    if (!values[key]) throw new Error(`E9 local runtime did not expose ${key}`)
  }
  return values
}

async function unusedPort(): Promise<number> {
  const { createServer } = await import('node:http')
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('E9 app port is unavailable')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function waitForApp(): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`E9 app exited (${app.exitCode}):\n${appOutput}`)
    try {
      if ((await fetch(`${appUrl}/api/health`)).status === 200) return
    } catch {
      // Next's first development compile is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`E9 app did not become ready:\n${appOutput}`)
}

async function stopChild(): Promise<void> {
  if (app.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => app.kill('SIGKILL'), 5_000)
    app.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    app.kill('SIGTERM')
  })
}

function serviceHeaders(prefer?: string): Record<string, string> {
  const key = localEnvironment.SUPABASE_SERVICE_ROLE_KEY!
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    ...(prefer ? { prefer } : {}),
  }
}

async function serviceRows<T>(pathName: string): Promise<T[]> {
  const response = await fetch(`${localSupabaseUrl}/rest/v1/${pathName}`, { headers: serviceHeaders() })
  const body = await response.text()
  expect(response.status, body).toBe(200)
  return JSON.parse(body) as T[]
}

async function patchService(pathName: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${localSupabaseUrl}/rest/v1/${pathName}`, {
    method: 'PATCH',
    headers: serviceHeaders(),
    body: JSON.stringify(body),
  })
  expect(response.status, await response.text()).toBe(204)
}

async function signedIn(email: string): Promise<{ request: APIRequestContext; userId: string }> {
  const request = await playwrightRequest.newContext({ baseURL: appUrl })
  const response = await request.post('/api/auth/login', { data: { email, password: DEMO_ACCOUNT_PASSWORD } })
  expect(response.status(), await response.text()).toBe(200)
  const body = await response.json() as { userId: string }
  return { request, userId: body.userId }
}

async function expectRefusal(
  request: APIRequestContext,
  method: 'get' | 'patch' | 'post',
  pathname: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const response = await request[method](pathname, data ? { data } : undefined)
  expect(response.status(), `${method.toUpperCase()} ${pathname}: ${await response.text()}`).toBe(404)
}

async function deniedAudit(action: string, targetId: string): Promise<Audit[]> {
  return serviceRows<Audit>(
    `audit_events?select=action,actor_ref,occurred_at,outcome,target_id,target_kind&action=eq.${action}&target_id=eq.${targetId}&outcome=eq.denied`,
  )
}

function incrementUuid(id: string): string {
  const last = Number.parseInt(id.at(-1)!, 16)
  return `${id.slice(0, -1)}${((last + 1) % 16).toString(16)}`
}

test.describe.serial('JOR-230 E9 cross-patient hardening wiring', () => {
  test.beforeAll(async () => {
    test.setTimeout(360_000)
    localEnvironment = startLocalRuntime()
    localSupabaseUrl = localEnvironment.NEXT_PUBLIC_SUPABASE_URL!
    scratchDir = await mkdtemp(path.join(tmpdir(), 'e9-wiring-'))
    execFileSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', REPO_ROOT, scratchDir])
    await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(scratchDir, 'node_modules'), 'dir')
    const port = await unusedPort()
    appUrl = `http://127.0.0.1:${port}`
    app = spawn(process.execPath, [path.join(scratchDir, 'scripts', 'run-next.mjs'), 'dev'], {
      cwd: scratchDir,
      env: { ...env, ...localEnvironment, PORT: String(port), APP_BASE_URL: appUrl, WATCHPACK_POLLING: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    app.stdout?.on('data', (chunk: Buffer) => (appOutput += chunk.toString()))
    app.stderr?.on('data', (chunk: Buffer) => (appOutput += chunk.toString()))
    await waitForApp()
  })

  test.afterAll(async () => {
    if (app) await stopChild()
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true })
    execFileSync('bash', ['scripts/local-del4-runtime.sh', 'stop'], { cwd: REPO_ROOT, timeout: 120_000 })
  })

  test('mandatory adversarial: patient guesses across every identifier surface return 404 and one audit each', async () => {
    const patient = await signedIn(DEMO_PATIENT_EMAIL)
    const anonymous = await playwrightRequest.newContext({ baseURL: appUrl })
    const unlinked = await playwrightRequest.newContext({ baseURL: appUrl })
    try {
      const owner = (await serviceRows<Patient>(`patients?select=id,user_id,patient_ref,date_of_birth&user_id=eq.${patient.userId}`))[0]!
      const foreignStudy = (await serviceRows<Study>(`studies?select=id,patient_id,visit_id&patient_id=neq.${owner.id}&limit=1`))[0]!
      const foreignClip = (await serviceRows<{ id: string }>(`cine_clips?select=id&study_id=eq.${foreignStudy.id}&limit=1`))[0]!
      const foreignImage = (await serviceRows<{ id: string }>(`images?select=id&study_id=eq.${foreignStudy.id}&limit=1`))[0]!
      const foreignReport = (await serviceRows<Report>(`reports?select=id,patient_id,study_id,status&study_id=eq.${foreignStudy.id}&limit=1`))[0]!
      const foreignAppointment = (await serviceRows<{ id: string }>(`appointments?select=id&patient_id=neq.${owner.id}&limit=1`))[0]!
      const guesses = [
        ['study.view', foreignStudy.id, () => expectRefusal(patient.request, 'get', `/api/studies/${foreignStudy.id}`)],
        ['study.view', incrementUuid(foreignStudy.id), () => expectRefusal(patient.request, 'get', `/api/studies/${incrementUuid(foreignStudy.id)}`)],
        ['clip.view', foreignClip.id, () => expectRefusal(patient.request, 'get', `/api/studies/${foreignStudy.id}/clips/${foreignClip.id}`)],
        ['clip.view', incrementUuid(foreignClip.id), () => expectRefusal(patient.request, 'get', `/api/studies/${foreignStudy.id}/clips/${incrementUuid(foreignClip.id)}`)],
        ['report.view', foreignReport.id, () => expectRefusal(patient.request, 'get', `/api/reports/${foreignReport.id}`)],
        ['report.view', incrementUuid(foreignReport.id), () => expectRefusal(patient.request, 'get', `/api/reports/${incrementUuid(foreignReport.id)}`)],
        ['appointment.view', foreignAppointment.id, () => expectRefusal(patient.request, 'patch', `/api/appointments/${foreignAppointment.id}`, { action: 'cancel' })],
        ['appointment.view', incrementUuid(foreignAppointment.id), () => expectRefusal(patient.request, 'patch', `/api/appointments/${incrementUuid(foreignAppointment.id)}`, { action: 'cancel' })],
        ['share.create', foreignImage.id, () => expectRefusal(patient.request, 'post', '/api/shares', { resourceKind: 'image', resourceId: foreignImage.id, recipientEmail: 'foreign@example.test' })],
        ['share.create', incrementUuid(foreignImage.id), () => expectRefusal(patient.request, 'post', '/api/shares', { resourceKind: 'image', resourceId: incrementUuid(foreignImage.id), recipientEmail: 'missing@example.test' })],
      ] as const
      for (const [action, targetId, attack] of guesses) {
        await attack()
        expect(await deniedAudit(action, targetId), `${action}:${targetId}`).toHaveLength(1)
      }

      const ownStudy = (await serviceRows<Study>(`studies?select=id,patient_id,visit_id&patient_id=eq.${owner.id}&limit=1`))[0]!
      expect((await anonymous.get(`/api/studies/${ownStudy.id}`)).status()).toBe(401)
      const email = `e9-unlinked-${randomUUID()}@example.test`
      expect((await unlinked.post('/api/auth/register', { data: { email, password: DEMO_ACCOUNT_PASSWORD } })).status()).toBe(201)
      expect((await unlinked.post('/api/auth/login', { data: { email, password: DEMO_ACCOUNT_PASSWORD } })).status()).toBe(200)
      const unlinkedResponse = await unlinked.get(`/api/studies/${ownStudy.id}`)
      expect(unlinkedResponse.status()).toBe(403)
      expect(await unlinkedResponse.json()).toEqual({ error: 'identity_verification_required', message: expect.any(String) })
    } finally {
      await unlinked.dispose()
      await anonymous.dispose()
      await patient.request.dispose()
    }
  })

  test('mandatory adversarial: expired and foreign revoked share tokens stay 410 and cannot serve cached content', async () => {
    const owner = await signedIn(DEMO_PATIENT_EMAIL)
    const foreign = await playwrightRequest.newContext({ baseURL: appUrl })
    try {
      const ownerPatient = (await serviceRows<Patient>(`patients?select=id,user_id,patient_ref,date_of_birth&user_id=eq.${owner.userId}`))[0]!
      const ownerReport = (await serviceRows<Report>(`reports?select=id,patient_id,study_id,status&patient_id=eq.${ownerPatient.id}&status=eq.signed&limit=1`))[0]!
      const expiredCreate = await owner.request.post('/api/shares', {
        data: { resourceKind: 'report', resourceId: ownerReport.id, recipientEmail: 'expired@example.test' },
      })
      expect(expiredCreate.status(), await expiredCreate.text()).toBe(201)
      const expired = await expiredCreate.json() as { id: string; url: string }
      await patchService(`share_links?id=eq.${expired.id}`, { expires_at: '2000-01-01T00:00:00.000Z' })

      const foreignPatient = (await serviceRows<Patient>('patients?select=id,user_id,patient_ref,date_of_birth&user_id=is.null&limit=1'))[0]!
      const email = `e9-foreign-${randomUUID()}@example.test`
      expect((await foreign.post('/api/auth/register', { data: { email, password: DEMO_ACCOUNT_PASSWORD } })).status()).toBe(201)
      expect((await foreign.post('/api/auth/login', { data: { email, password: DEMO_ACCOUNT_PASSWORD } })).status()).toBe(200)
      expect((await foreign.post('/api/identity/verify', {
        data: { patientRef: foreignPatient.patient_ref, dateOfBirth: foreignPatient.date_of_birth },
      })).status()).toBe(200)
      const foreignReport = (await serviceRows<Report>(`reports?select=id,patient_id,study_id,status&patient_id=eq.${foreignPatient.id}&status=eq.signed&limit=1`))[0]!
      const foreignCreate = await foreign.post('/api/shares', {
        data: { resourceKind: 'report', resourceId: foreignReport.id, recipientEmail: 'foreign-recipient@example.test' },
      })
      expect(foreignCreate.status(), await foreignCreate.text()).toBe(201)
      const foreignShare = await foreignCreate.json() as { id: string; url: string }
      expect((await foreign.delete(`/api/shares/${foreignShare.id}`)).status()).toBe(204)

      for (const url of [expired.url, foreignShare.url]) {
        const pathname = `/api${new URL(url).pathname}`
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await owner.request.get(pathname)
          expect(response.status()).toBe(410)
          expect(response.headers()['cache-control']).toContain('no-store')
          expect(await response.json()).toEqual({ error: 'share_unavailable', message: 'This link is no longer available.' })
        }
      }
    } finally {
      await foreign.dispose()
      await owner.request.dispose()
    }
  })

  test('provider cannot cross provider boundaries while provider and admin may read assigned preliminary reports', async () => {
    const provider = await signedIn(DEMO_PROVIDER_EMAIL)
    const admin = await signedIn(DEMO_ADMIN_EMAIL)
    try {
      const providerRow = (await serviceRows<Provider>(`providers?select=id,user_id&user_id=eq.${provider.userId}`))[0]!
      const foreignProvider = (await serviceRows<Provider>(`providers?select=id,user_id&id=neq.${providerRow.id}&limit=1`))[0]!
      const ownVisit = (await serviceRows<Visit>(`visits?select=id,provider_id&provider_id=eq.${providerRow.id}&limit=1`))[0]!
      const foreignVisit = (await serviceRows<Visit>(`visits?select=id,provider_id&provider_id=eq.${foreignProvider.id}&limit=1`))[0]!
      const ownStudy = (await serviceRows<Study>(`studies?select=id,patient_id,visit_id&visit_id=eq.${ownVisit.id}&limit=1`))[0]!
      const foreignStudy = (await serviceRows<Study>(`studies?select=id,patient_id,visit_id&visit_id=eq.${foreignVisit.id}&limit=1`))[0]!
      const preliminary = (await serviceRows<Report>(`reports?select=id,patient_id,study_id,status&study_id=eq.${ownStudy.id}&status=eq.preliminary&limit=1`))[0]

      await expectRefusal(provider.request, 'get', `/api/provider/schedule?date=2026-08-24&providerId=${foreignProvider.id}`)
      await expectRefusal(provider.request, 'get', `/api/studies/${foreignStudy.id}`)
      const foreignReport = (await serviceRows<Report>(`reports?select=id,patient_id,study_id,status&study_id=eq.${foreignStudy.id}&limit=1`))[0]!
      await expectRefusal(provider.request, 'get', `/api/reports/${foreignReport.id}`)
      if (preliminary) {
        expect((await provider.request.get(`/api/reports/${preliminary.id}`)).status()).toBe(200)
        expect((await admin.request.get(`/api/reports/${preliminary.id}`)).status()).toBe(200)
      }
    } finally {
      await admin.request.dispose()
      await provider.request.dispose()
    }
  })

  test('mandatory adversarial: admin audit read exposes identifiers only and records itself', async () => {
    const admin = await signedIn(DEMO_ADMIN_EMAIL)
    try {
      const response = await admin.request.get('/api/admin/audit')
      expect(response.status(), await response.text()).toBe(200)
      const body = await response.json() as { events: AuditLogEntry[] }
      expect(body.events.length).toBeGreaterThan(0)
      for (const event of body.events) {
        // actorRef is nullable by design (db/migrations/009_anonymous_audit_actor.sql):
        // an authenticated-but-unlinked account denial has no patient/provider ref to attribute.
        expect(typeof event.action).toBe('string')
        expect(event.actorRef === null || typeof event.actorRef === 'string').toBe(true)
        expect(typeof event.occurredAt).toBe('string')
        expect(event.outcome).toMatch(/^(granted|denied)$/)
        expect(typeof event.targetKind).toBe('string')
      }
      expect(body.events).toContainEqual(expect.objectContaining({
        action: 'audit.view',
        actorRef: admin.userId,
        outcome: 'granted',
      }))
      expect(JSON.stringify(body)).not.toMatch(/@demo\.pip\.test|\b\d{4}-\d{2}-\d{2}\b|Morgan Rivers|findings|impression/i)
    } finally {
      await admin.request.dispose()
    }
  })

  test('mandatory adversarial: the complete demo artifact passes T52 PHI scanning', () => {
    // Re-invoking demo-run.sh here (nested inside this live Playwright run)
    // would collide with the "product" project's own webServer: both resolve
    // the same config.port, and start-test-server.mjs unconditionally
    // overwrites .local/fake-auth-server.json, so demo-run.sh's own cleanup
    // kills the shared fake-auth-server every other test in this run depends
    // on. T52's producer test (tests/adversarial/log-scan.test.ts) already
    // ran demo-run.sh and scanned its artifact earlier in this same gate run,
    // as part of VITEST_UNIT — this test independently re-verifies that
    // artifact against the stable seeded needle set instead of regenerating it.
    const artifactPath = path.join(REPO_ROOT, 'tests', 'artifacts', 'demo-run.log')
    expect(
      existsSync(artifactPath),
      `${artifactPath} is missing — tests/adversarial/log-scan.test.ts (VITEST_UNIT) produces it; run the full gate, not this spec alone`,
    ).toBe(true)
    const ageMs = Date.now() - statSync(artifactPath).mtimeMs
    // ponytail: wall-clock freshness, not a run-id correlation — a full gate
    // run's VITEST_UNIT step always finishes well under 30 minutes before
    // Playwright starts. Upgrade to a stamped gate-run id if that ever changes.
    expect(
      ageMs,
      `${artifactPath} is ${Math.round(ageMs / 1000)}s old — stale, not produced by this gate run; rerun the gate`,
    ).toBeLessThan(30 * 60 * 1000)
    const artifact = readFileSync(artifactPath, 'utf8')
    // Mirrors T52's needle set built from the seeded delivery dataset (SEED_ROWS).
    // It does not cover T52's additional ephemeral per-run driven rows, which
    // T52 itself already scanned and deletes before this test can see them.
    expect(scanArtifact(artifact, [SEED_ROWS])).toEqual({ hits: [], integrityErrors: [] })
  })
})

// JOR-232 — E10's dependency-outage wiring proof. The scratch application is
// configured to an isolated local proxy in front of the credential-free DEL-4
// Supabase runtime. Changing the proxy mode therefore pulls a dependency at
// the application's configured wire boundary; no product route is replaced.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { env } from 'node:process'

import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

import { DEMO_ACCOUNT_PASSWORD, DEMO_PATIENT_EMAIL, DEMO_PROVIDER_EMAIL } from '../db/seed/rows'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

type Dependency = 'database' | 'storage' | null
type Boundary = { url: string; setDown: (dependency: Dependency) => void; close: () => Promise<void> }

let boundary: Boundary
let scratchDir: string
let app: ChildProcess
let appUrl: string
let appOutput = ''
let localEnvironment: Record<string, string>
let localSupabaseUrl: string

async function bodyOf(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString()
}

function dependencyFor(pathname: string): Exclude<Dependency, null> | null {
  if (pathname.startsWith('/rest/v1/')) return 'database'
  if (pathname.startsWith('/storage/v1/')) return 'storage'
  return null
}

async function forward(
  target: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['connection', 'content-length', 'host', 'transfer-encoding'].includes(name)) continue
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
    else headers.set(name, value)
  }
  const body = await bodyOf(request)
  const upstream = await fetch(new URL(request.url ?? '/', target), {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
  })
  response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
  response.end(Buffer.from(await upstream.arrayBuffer()))
}

async function startBoundary(target: string): Promise<Boundary> {
  let down: Dependency = null
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://e10.local').pathname
    if (down !== null && dependencyFor(pathname) === down) {
      request.socket.destroy()
      return
    }
    void forward(target, request, response).catch((error: unknown) => {
      console.error('E10 dependency boundary forwarding failed', error)
      request.socket.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('E10 dependency boundary has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    setDown(dependency) {
      down = dependency
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('E10 application port is unavailable')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function parseEnvironment(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw.split('\n').flatMap((line) => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) return []
      const separator = trimmed.indexOf('=')
      if (separator === -1) return []
      const value = trimmed.slice(separator + 1).replace(/^['"]|['"]$/g, '')
      return [[trimmed.slice(0, separator), value]]
    }),
  )
}

function startLocalRuntime(): Record<string, string> {
  const output = execFileSync('bash', ['scripts/local-del4-runtime.sh', 'run', 'env'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...env, PORT: '45332' },
    timeout: 300_000,
  })
  const values = parseEnvironment(output)
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SOURCE_REF_SALT']) {
    if (!values[key]) throw new Error(`E10 local runtime did not expose ${key}`)
  }
  return values
}

async function waitForApp(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`E10 app exited (${child.exitCode}):\n${appOutput}`)
    try {
      const response = await fetch(`${appUrl}/api/health`)
      if (response.status === 200) return
    } catch {
      // Next's first dev compile is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`E10 app did not become ready:\n${appOutput}`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function expectEnvelope(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<void> {
  expect(response.status()).toBeGreaterThanOrEqual(400)
  expect(response.status()).not.toBe(500)
  expect(await response.json()).toEqual({ error: expect.any(String), message: expect.any(String) })
}

async function signedInRequest(email = DEMO_PATIENT_EMAIL) {
  const request = await playwrightRequest.newContext({ baseURL: appUrl })
  expect((await request.post('/api/auth/login', {
    data: { email, password: DEMO_ACCOUNT_PASSWORD },
  })).status()).toBe(200)
  return request
}

function serviceHeaders(prefer?: string): Record<string, string> {
  const key = localEnvironment.SUPABASE_SERVICE_ROLE_KEY
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

async function firstStudyId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/studies')
  expect(response.status(), await response.text()).toBe(200)
  const body = await response.json() as { studies: Array<{ id: string }> }
  expect(body.studies.length).toBeGreaterThan(0)
  return body.studies[0]!.id
}

async function linkFreshEmptyPatient(request: APIRequestContext): Promise<void> {
  const patientRef = `PT-${randomInt(1000, 10_000)}`
  const dateOfBirth = '1991-02-03'
  const email = `e10-empty-${randomUUID()}@example.test`
  const inserted = await fetch(`${localSupabaseUrl}/rest/v1/patients`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({
      id: randomUUID(),
      user_id: null,
      patient_ref: patientRef,
      date_of_birth: dateOfBirth,
      full_name: 'E10 Empty Patient',
      email,
      phone: null,
    }),
  })
  expect(inserted.status, await inserted.text()).toBe(201)

  expect((await request.post(`${appUrl}/api/auth/register`, {
    data: { email, password: DEMO_ACCOUNT_PASSWORD },
  })).status()).toBe(201)
  expect((await request.post(`${appUrl}/api/auth/login`, {
    data: { email, password: DEMO_ACCOUNT_PASSWORD },
  })).status()).toBe(200)
  expect((await request.post(`${appUrl}/api/identity/verify`, {
    data: { patientRef, dateOfBirth },
  })).status()).toBe(200)
}

async function freshEmptyPatientRequest(): Promise<APIRequestContext> {
  const request = await playwrightRequest.newContext({ baseURL: appUrl })
  await linkFreshEmptyPatient(request)
  return request
}

test.describe.serial('JOR-232 E10 outage wiring', () => {
  test.beforeAll(async () => {
    test.setTimeout(360_000)
    localEnvironment = startLocalRuntime()
    localSupabaseUrl = localEnvironment.NEXT_PUBLIC_SUPABASE_URL!
    boundary = await startBoundary(localSupabaseUrl)
    scratchDir = await mkdtemp(path.join(tmpdir(), 'e10-wiring-'))
    execFileSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', REPO_ROOT, scratchDir])
    await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(scratchDir, 'node_modules'), 'dir')
    const port = await unusedPort()
    appUrl = `http://127.0.0.1:${port}`
    app = spawn(process.execPath, [path.join(scratchDir, 'scripts', 'run-next.mjs'), 'dev'], {
      cwd: scratchDir,
      env: {
        ...env,
        ...localEnvironment,
        PORT: String(port),
        APP_BASE_URL: appUrl,
        NEXT_PUBLIC_SUPABASE_URL: boundary.url,
        CRON_SECRET: 'e10-local-cron-secret',
        EMAIL_TRANSPORT: 'resend',
        EMAIL_SEND_TIMEOUT_MS: '500',
        RESEND_API_KEY: 'e10-local-key',
        RESEND_FROM: 'portal@example.test',
        RESEND_BASE_URL: 'http://127.0.0.1:1',
        WATCHPACK_POLLING: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    app.stdout?.on('data', (chunk: Buffer) => (appOutput += chunk.toString()))
    app.stderr?.on('data', (chunk: Buffer) => (appOutput += chunk.toString()))
    await waitForApp(app)
  })

  test.afterEach(() => boundary.setDown(null))

  test.afterAll(async () => {
    if (app) await stopChild(app)
    if (boundary) await boundary.close()
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true })
    execFileSync('bash', ['scripts/local-del4-runtime.sh', 'stop'], { cwd: REPO_ROOT, timeout: 120_000 })
  })

  test('mandatory adversarial: database outage never becomes an unhandled 500', async () => {
    const request = await signedInRequest()
    try {
      const initialHealth = await request.get('/api/health')
      expect(await initialHealth.json()).toEqual({ app: 'ok', database: 'ok', storage: 'ok' })

      boundary.setDown('database')
      const health = await request.get('/api/health')
      expect(health.status()).toBe(200)
      expect(await health.json()).toEqual({ app: 'ok', database: 'down', storage: 'ok' })

      const affectedFlow = await request.get('/api/services')
      expect(affectedFlow.status(), await affectedFlow.text()).not.toBe(500)
      await expectEnvelope(affectedFlow)
      expect(appOutput).toContain(JSON.stringify({ op: 'services.list', dependency: 'database', outcome: 'down' }))
    } finally {
      await request.dispose()
    }
  })

  test('mandatory adversarial: storage outage renders a clear message, never a blank screen or stack trace', async () => {
    const request = await signedInRequest()
    try {
      const studyId = await firstStudyId(request)
      boundary.setDown('storage')
      const health = await request.get('/api/health')
      expect(health.status()).toBe(200)
      expect(await health.json()).toEqual({ app: 'ok', database: 'ok', storage: 'down' })

      const page = await request.get(`/studies/${studyId}`)
      expect(page.status()).toBe(200)
      const html = await page.text()
      expect(html).toContain('Images are temporarily unavailable… your data is safe')
      expect(html).toContain('Try again')
      expect(html.trim()).not.toBe('')
      expect(html).not.toMatch(/at .*\(.*:\d+:\d+\)|TypeError|ECONNREFUSED|stack trace/i)
      expect(appOutput).toContain(JSON.stringify({ op: 'health.probe', dependency: 'storage', outcome: 'down' }))
    } finally {
      await request.dispose()
    }
  })

  test('mandatory adversarial: failed email delivery keeps the share active and records a retry', async () => {
    const request = await signedInRequest()
    try {
      const reportsResponse = await request.get('/api/reports')
      expect(reportsResponse.status(), await reportsResponse.text()).toBe(200)
      const reports = await reportsResponse.json() as { reports: Array<{ id: string }> }
      expect(reports.reports.length).toBeGreaterThan(0)
      const recipientEmail = `e10-recipient-${randomUUID()}@example.test`
      const created = await request.post('/api/shares', {
        data: { resourceKind: 'report', resourceId: reports.reports[0]!.id, recipientEmail },
      })
      expect(created.status(), await created.text()).toBe(201)
      const share = await created.json() as { id: string; url: string }
      expect(share.url).toContain('/s/')

      const dispatch = await request.post('/api/jobs/reminders', {
        headers: { 'x-cron-secret': 'e10-local-cron-secret' },
      })
      expect(dispatch.status(), await dispatch.text()).toBe(200)

      const listed = await request.get('/api/shares')
      expect(listed.status(), await listed.text()).toBe(200)
      const listedBody = await listed.json() as { shares: Array<{ id: string; state: string }> }
      expect(listedBody.shares).toContainEqual(expect.objectContaining({ id: share.id, state: 'active' }))

      const queued = await serviceRows<{
        recipient: string
        attempts: number
        sent_at: string | null
        last_error: string | null
        next_attempt_at: string
      }>(`email_outbox?select=recipient,attempts,sent_at,last_error,next_attempt_at&recipient=eq.${encodeURIComponent(recipientEmail)}`)
      expect(queued).toEqual([
        expect.objectContaining({
          recipient: recipientEmail,
          attempts: 1,
          sent_at: null,
          last_error: 'email_delivery_failed',
          next_attempt_at: expect.any(String),
        }),
      ])
      expect(appOutput).not.toContain(recipientEmail)
      expect(appOutput).not.toContain(share.url)
    } finally {
      await request.dispose()
    }
  })

  test('mandatory adversarial: all five input surfaces reject invalid values with the pinned envelope', async () => {
    const patient = await signedInRequest()
    const anonymous = await playwrightRequest.newContext({ baseURL: appUrl })
    const provider = await signedInRequest(DEMO_PROVIDER_EMAIL)
    try {
      const servicesResponse = await patient.get('/api/services')
      expect(servicesResponse.status()).toBe(200)
      const services = await servicesResponse.json() as { services: Array<{ id: string }> }
      const providersResponse = await patient.get(`/api/providers?serviceId=${services.services[0]!.id}`)
      expect(providersResponse.status()).toBe(200)
      const providers = await providersResponse.json() as { providers: Array<{ id: string; fullName: string }> }
      const demoProvider = providers.providers.find(({ fullName }) => fullName === 'Seed Provider 1')
      expect(demoProvider).toBeTruthy()
      const responses = [
        await patient.post('/api/appointments', { data: { slotId: 'not-a-uuid' } }),
        await provider.patch(`/api/providers/${demoProvider!.id}/availability`, {
          data: { slotMinutes: 0, workingHours: [], blocks: [] },
        }),
        await patient.get('/api/studies/not-a-uuid'),
        await patient.get('/api/reports/not-a-uuid'),
        await patient.post('/api/shares', {
          data: { resourceKind: 'report', resourceId: randomUUID(), recipientEmail: 'not-an-email' },
        }),
        await anonymous.post('/api/auth/register', {
          data: { email: `${'x'.repeat(10_000)}@example.test`, password: DEMO_ACCOUNT_PASSWORD },
        }),
      ]
      for (const response of responses) await expectEnvelope(response)
    } finally {
      await provider.dispose()
      await anonymous.dispose()
      await patient.dispose()
    }
  })

  test('mandatory adversarial: a zero-row patient sees clean list empty states', async ({ page }) => {
    await linkFreshEmptyPatient(page.request)
    for (const [route, copy] of [
      ['/studies', 'No images yet'],
      ['/reports', 'No reports yet'],
      ['/appointments', 'No appointments yet'],
      ['/shares', "You haven't shared anything yet"],
    ] as const) {
      await page.goto(`${appUrl}${route}`)
      await expect(page.getByText(copy, { exact: false })).toBeVisible()
      await expect(page.locator('body')).not.toContainText(/TypeError|ECONNREFUSED|stack trace/i)
    }
  })

  test('patient deletion request and retention policy cover every retained record class', async () => {
    const request = await freshEmptyPatientRequest()
    try {
      const response = await request.post('/api/profile/deletion-request', { data: {} })
      expect(response.status(), await response.text()).toBe(202)
      expect(await response.json()).toEqual({ status: 'received', requestedAt: expect.any(String) })
      const policy = await readFile(path.join(REPO_ROOT, 'docs/retention-and-deletion.md'), 'utf8')
      for (const recordClass of ['images', 'cine clips', 'reports', 'appointments']) {
        expect(policy.toLowerCase()).toContain(recordClass)
      }
    } finally {
      await request.dispose()
    }
  })
})

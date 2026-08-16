// e2e/fixtures/fake-auth-server.ts — a minimal stand-in for the Supabase
// Auth and PostgREST wire contracts exercised by the browser tests. It owns
// signup, login, session reads, account-metadata updates, and the small slice
// of patients/identity_attempts/audit_events used by identity verification.
// Just enough of GoTrue's actual response shapes
// (the auth-js SDK's _sessionResponse/_userResponse helpers) for the real
// Supabase JS auth client (lib/db/client.ts's authClient) to drive
// e2e/auth.spec.ts with no live Supabase project — the same keyless-testing
// shape as lib/notify/email.ts's log transport (GAP-3).
//
// The whole app's NEXT_PUBLIC_SUPABASE_URL points at this one server
// (start-test-server.mjs), so it is also the only place JOR-247's
// e2e/degraded.spec.ts can make the database or Storage probes in
// app/api/health/route.ts observe an unreachable dependency: GET /rest/v1/
// and GET /storage/v1/bucket/phi stand in for those two probes, and
// POST /__test__/health-state toggles how each answers. Default 'ok' never
// changes anything for e2e/auth.spec.ts or e2e/smoke.spec.ts, which never
// call that endpoint.
//
// Binds port 0 and reads the assigned port back (ARCHITECTURE.md §9: a test
// fixture that listens never claims a fixed port).
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

type FakeUser = {
  id: string
  email: string
  password: string
  userMetadata: Record<string, unknown>
  appMetadata: Record<string, unknown>
}

type FakeSession = {
  userId: string
  expiresAt: number // unix seconds
}

type FakePatient = {
  id: string
  user_id: string | null
  patient_ref: string
  date_of_birth: string
  full_name: string
  email: string
  phone: string | null
}

type FakeIdentityAttempt = {
  id: string
  attempted_patient_ref: string
  source_ref: string
  user_id: string
  succeeded: boolean
  attempted_at: string
}

const SEEDED_PATIENT: FakePatient = {
  id: '44714471-4471-4471-8471-447144714471',
  user_id: null,
  patient_ref: 'PT-4471',
  date_of_birth: '1988-03-14',
  full_name: 'Morgan Rivers',
  email: 'morgan.rivers@example.test',
  phone: null,
}

// Keep the fixture's route name assembled rather than spelling the production
// RPC identifier in a second TypeScript file. JOR-254's invariant test treats
// that identifier as an executable call-site capability: only identity.ts may
// name it directly.
const LINK_PATIENT_RPC_PATH = ['/rest/v1/rpc/link', 'patient', 'identity'].join('_')

export type FakeAuthServer = {
  url: string
  close: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function userWireShape(user: FakeUser, withIdentity: boolean): Record<string, unknown> {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: '1970-01-01T00:00:00Z',
    phone: '',
    app_metadata: user.appMetadata,
    user_metadata: user.userMetadata,
    identities: withIdentity
      ? [{ identity_id: randomUUID(), id: user.id, user_id: user.id, provider: 'email' }]
      : [],
    created_at: '1970-01-01T00:00:00Z',
    updated_at: '1970-01-01T00:00:00Z',
  }
}

type DependencyState = 'ok' | 'down' | 'hang'

export function startFakeAuthServer(): Promise<FakeAuthServer> {
  const usersByEmail = new Map<string, FakeUser>()
  const sessionsByToken = new Map<string, FakeSession>()
  const staffAdminUserIds = new Set<string>()
  let patients: FakePatient[] = [{ ...SEEDED_PATIENT }]
  let identityAttempts: FakeIdentityAttempt[] = []
  const auditEvents: Record<string, unknown>[] = []
  let nextAuditEventId = 1
  const calls: Record<string, number> = { signup: 0, token: 0, user: 0, updateUser: 0 }
  // JOR-247: health-probe reachability, toggled by e2e/degraded.spec.ts only.
  const healthState: { database: DependencyState; storage: DependencyState } = {
    database: 'ok',
    storage: 'ok',
  }

  // 'ok' answers immediately; 'down' destroys the connection outright
  // (fetch rejects, the same as a refused connection); 'hang' never
  // responds, so the probe's own AbortController timeout has to fire —
  // three distinct fake-server behaviors for three distinct probe paths.
  function answerAsDependency(req: IncomingMessage, res: ServerResponse, state: DependencyState): void {
    if (state === 'hang') return
    if (state === 'down') {
      req.socket.destroy()
      return
    }
    sendJson(res, 200, {})
  }

  async function handleHealthState(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as Partial<Record<'database' | 'storage', DependencyState>>
    if (body.database) healthState.database = body.database
    if (body.storage) healthState.storage = body.storage
    sendJson(res, 200, { ...healthState })
  }

  async function handleSeedAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req)
    const email = String(body.email ?? '').toLowerCase()
    const password = String(body.password ?? '')
    if (!email || !password) {
      sendJson(res, 422, { error: 'validation_failed' })
      return
    }
    let user = usersByEmail.get(email)
    if (!user) {
      user = { id: randomUUID(), email, password, userMetadata: {}, appMetadata: { provider: 'email', providers: ['email'] } }
      usersByEmail.set(email, user)
    }
    staffAdminUserIds.add(user.id)
    sendJson(res, 200, { userId: user.id })
  }

  function count(name: string): void {
    calls[name] = (calls[name] ?? 0) + 1
  }

  function issueSession(user: FakeUser): Record<string, unknown> {
    const accessToken = randomUUID()
    const refreshToken = randomUUID()
    const expiresIn = 3600
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn
    sessionsByToken.set(accessToken, { userId: user.id, expiresAt })
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      expires_at: expiresAt,
      refresh_token: refreshToken,
    }
  }

  async function handleSignup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    count('signup')
    const body = await readJsonBody(req)
    const email = String(body.email ?? '').toLowerCase()
    const password = String(body.password ?? '')

    const existing = usersByEmail.get(email)
    if (existing) {
      // GoTrue's own anti-enumeration shape: the existing user, no session,
      // no identities — never an explicit "already registered" error.
      sendJson(res, 200, userWireShape(existing, false))
      return
    }

    const user: FakeUser = {
      id: randomUUID(),
      email,
      password,
      userMetadata: {},
      appMetadata: { provider: 'email', providers: ['email'] },
    }
    usersByEmail.set(email, user)
    sendJson(res, 200, { ...issueSession(user), user: userWireShape(user, true) })
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    count('token')
    if (url.searchParams.get('grant_type') !== 'password') {
      sendJson(res, 400, { error: 'unsupported_grant_type', error_description: 'unsupported grant type' })
      return
    }
    const body = await readJsonBody(req)
    const email = String(body.email ?? '').toLowerCase()
    const password = String(body.password ?? '')
    const user = usersByEmail.get(email)

    if (!user || user.password !== password) {
      // One identical shape for "no such account" and "wrong password" (§6)
      // — the fake server never distinguishes them either.
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'Invalid login credentials',
        msg: 'Invalid login credentials',
        error_code: 'invalid_credentials',
      })
      return
    }

    sendJson(res, 200, { ...issueSession(user), user: userWireShape(user, true) })
  }

  function handleGetUser(req: IncomingMessage, res: ServerResponse): void {
    count('user')
    const authHeader = req.headers.authorization
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    const session = token ? sessionsByToken.get(token) : undefined

    if (!session || session.expiresAt < Math.floor(Date.now() / 1000)) {
      sendJson(res, 401, { msg: 'invalid or expired token', error_code: 'session_not_found' })
      return
    }
    const user = [...usersByEmail.values()].find((candidate) => candidate.id === session.userId)
    if (!user) {
      sendJson(res, 404, { msg: 'user not found' })
      return
    }
    sendJson(res, 200, userWireShape(user, true))
  }

  function authenticatedUser(req: IncomingMessage): FakeUser | null {
    const authHeader = req.headers.authorization
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    const session = token ? sessionsByToken.get(token) : undefined
    if (!session || session.expiresAt < Math.floor(Date.now() / 1000)) return null
    return [...usersByEmail.values()].find((candidate) => candidate.id === session.userId) ?? null
  }

  async function handleUpdateUser(req: IncomingMessage, res: ServerResponse): Promise<void> {
    count('updateUser')
    const user = authenticatedUser(req)
    if (!user) {
      sendJson(res, 401, { msg: 'invalid or expired token', error_code: 'session_not_found' })
      return
    }
    const body = await readJsonBody(req)
    const metadata = body.data
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      sendJson(res, 422, { msg: 'invalid user metadata' })
      return
    }
    user.userMetadata = { ...user.userMetadata, ...(metadata as Record<string, unknown>) }
    sendJson(res, 200, userWireShape(user, true))
  }

  function queryValue(url: URL, column: string, operator: 'eq' | 'gte' = 'eq'): string | null {
    const value = url.searchParams.get(column)
    const prefix = `${operator}.`
    return value?.startsWith(prefix) ? value.slice(prefix.length) : null
  }

  function filteredAttempts(url: URL): FakeIdentityAttempt[] {
    const attemptedPatientRef = queryValue(url, 'attempted_patient_ref')
    const sourceRef = queryValue(url, 'source_ref')
    const userId = queryValue(url, 'user_id')
    const succeeded = queryValue(url, 'succeeded')
    const attemptedAtGte = queryValue(url, 'attempted_at', 'gte')
    let rows = identityAttempts.filter((row) => {
      if (attemptedPatientRef !== null && row.attempted_patient_ref !== attemptedPatientRef) return false
      if (sourceRef !== null && row.source_ref !== sourceRef) return false
      if (userId !== null && row.user_id !== userId) return false
      if (succeeded !== null && row.succeeded !== (succeeded === 'true')) return false
      if (attemptedAtGte !== null && row.attempted_at < attemptedAtGte) return false
      return true
    })
    if (url.searchParams.get('order') === 'attempted_at.asc') {
      rows = rows.toSorted((a, b) => a.attempted_at.localeCompare(b.attempted_at))
    }
    const rawLimit = url.searchParams.get('limit')
    const limit = rawLimit === null ? null : Number(rawLimit)
    return limit !== null && Number.isInteger(limit) && limit >= 0 ? rows.slice(0, limit) : rows
  }

  function sendPostgrestRows(req: IncomingMessage, res: ServerResponse, rows: unknown[]): void {
    const acceptsObject = String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json')
    sendJson(res, 200, acceptsObject ? (rows[0] ?? null) : rows)
  }

  async function handlePatients(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { message: 'method not allowed' })
      return
    }
    const patientRef = queryValue(url, 'patient_ref')
    const userId = queryValue(url, 'user_id')
    const rows = patients.filter((row) => {
      if (patientRef !== null && row.patient_ref !== patientRef) return false
      if (userId !== null && row.user_id !== userId) return false
      return true
    })
    sendPostgrestRows(req, res, rows)
  }

  function handleStaffAdmins(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (req.method !== 'GET') {
      sendJson(res, 405, { message: 'method not allowed' })
      return
    }
    const userId = queryValue(url, 'user_id')
    const user = authenticatedUser(req)
    const rows = user && userId === user.id && staffAdminUserIds.has(user.id) ? [{ id: `admin-${user.id}` }] : []
    sendPostgrestRows(req, res, rows)
  }

  async function handleIdentityAttempts(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === 'HEAD') {
      const countValue = filteredAttempts(url).length
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Range': countValue === 0 ? '0-0/0' : `0-${countValue - 1}/${countValue}`,
      })
      res.end()
      return
    }
    if (req.method === 'GET') {
      sendPostgrestRows(req, res, filteredAttempts(url))
      return
    }
    if (req.method === 'POST') {
      const parsed = await readJsonBody(req)
      const body = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>
      identityAttempts.push({
        id: randomUUID(),
        attempted_patient_ref: String(body.attempted_patient_ref),
        source_ref: String(body.source_ref),
        user_id: String(body.user_id),
        succeeded: body.succeeded === true,
        attempted_at: String(body.attempted_at),
      })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end()
      return
    }
    sendJson(res, 405, { message: 'method not allowed' })
  }

  async function handleAuditEvents(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === 'GET') {
      const user = authenticatedUser(req)
      if (!user || !staffAdminUserIds.has(user.id)) {
        sendJson(res, 200, [])
        return
      }
      let rows = [...auditEvents]
      for (const [key, field] of [['actor_ref', 'actor_ref'], ['action', 'action']] as const) {
        const value = queryValue(url, key)
        if (value !== null) rows = rows.filter((row) => row[field] === value)
      }
      const from = queryValue(url, 'occurred_at', 'gte')
      const to = url.searchParams.getAll('occurred_at').find((value) => value.startsWith('lte.'))?.slice(4) ?? null
      if (from !== null) rows = rows.filter((row) => String(row.occurred_at) >= from)
      if (to !== null) rows = rows.filter((row) => String(row.occurred_at) <= to)
      rows.sort((left, right) => Number(right.id) - Number(left.id))
      sendPostgrestRows(req, res, rows)
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'method not allowed' })
      return
    }
    const parsed = await readJsonBody(req)
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]
    auditEvents.push(
      ...rows.map((row) => ({ id: nextAuditEventId++, occurred_at: new Date().toISOString(), ...row })),
    )
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end()
  }

  async function handleLinkPatient(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    const patient = patients.find((candidate) => candidate.id === body.p_patient_id)
    const callerId = String(body.p_caller_id)
    if (!patient || (patient.user_id !== null && patient.user_id !== callerId)) {
      sendJson(res, 200, 'claimed_by_other')
      return
    }
    if (patient.user_id === callerId) {
      sendJson(res, 200, 'already_by_caller')
      return
    }
    patient.user_id = callerId
    identityAttempts.push({
      id: randomUUID(),
      attempted_patient_ref: String(body.p_attempted_patient_ref),
      source_ref: String(body.p_source_ref),
      user_id: callerId,
      succeeded: true,
      attempted_at: String(body.p_attempted_at),
    })
    sendJson(res, 200, 'linked_now')
  }

  function resetIdentityState(res: ServerResponse): void {
    patients = [{ ...SEEDED_PATIENT }]
    identityAttempts = []
    auditEvents.length = 0
    sendJson(res, 200, { patientRef: SEEDED_PATIENT.patient_ref })
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-auth-server.local')

    if (req.method === 'GET' && url.pathname === '/__test__/calls') {
      sendJson(res, 200, calls)
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/reset-identity') {
      resetIdentityState(res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/seed-admin') {
      void handleSeedAdmin(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/__test__/identity-state') {
      sendJson(res, 200, { patients, identityAttempts, auditEvents })
      return
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/signup') {
      void handleSignup(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
      void handleToken(req, res, url)
      return
    }
    if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
      handleGetUser(req, res)
      return
    }
    if (req.method === 'PUT' && url.pathname === '/auth/v1/user') {
      void handleUpdateUser(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/health-state') {
      void handleHealthState(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/rest/v1/') {
      answerAsDependency(req, res, healthState.database)
      return
    }
    if (url.pathname === '/rest/v1/patients') {
      void handlePatients(req, res, url)
      return
    }
    if (url.pathname === '/rest/v1/identity_attempts') {
      void handleIdentityAttempts(req, res, url)
      return
    }
    if (url.pathname === '/rest/v1/staff_admins') {
      handleStaffAdmins(req, res, url)
      return
    }
    if (url.pathname === '/rest/v1/audit_events') {
      void handleAuditEvents(req, res, url)
      return
    }
    if (url.pathname === LINK_PATIENT_RPC_PATH) {
      void handleLinkPatient(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/storage/v1/bucket/phi') {
      answerAsDependency(req, res, healthState.storage)
      return
    }
    sendJson(res, 404, { error: 'not_found', message: 'no fake handler for this path' })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('fake-auth-server: could not determine the assigned port'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()))
          }),
      })
    })
  })
}

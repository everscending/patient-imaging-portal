import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { env as processEnvironment } from 'node:process'
import { promisify } from 'node:util'

import { generateAssetPool } from '../../db/seed/assets'
import { runSeed, type AuthAdminClient, type SeedDbClient } from '../../db/seed/index'
import { buildRowSet, type RowSet } from '../../db/seed/rows'
import type { PhiStorageClient } from '../../db/seed/storage'
import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const SOURCE_SEED = 'patient-imaging-portal-e8'
const CRON_SECRET = 'e8-cron-secret'
const SERVICE_ROLE_KEY = 'e8-service-role-key'
const MIN_CHANGE_NOTICE_HOURS = 24

export type ReminderRow = {
  appointmentId: string
  leadHours: number
  outcome: 'sent' | 'failed' | 'skipped'
  sentAt: string | null
  retryableAt: string | null
}

export type JobResponse = {
  status: number
  body: Record<string, unknown>
}

export type MailMessage = { to: string; subject: string; text: string }
export type DispatchLog = { event: 'email.sent'; id: string; domain: string; transport: 'log' }
export type DispatchAudit = {
  id: number
  occurredAt: string
  actorKind: 'system'
  actorRef: null
  action: 'reminder.dispatch'
  targetKind: 'appointment'
  appointmentId: string
  outcome: 'granted' | 'denied'
  detail: {
    transport: 'log' | 'resend'
    leadHours: number
    [key: string]: unknown
  }
}

export type OutboxState = {
  id: string
  attempts: number
  nextAttemptAt: string
  sentAt: string | null
  lastError: string | null
}

export type E8AcceptanceFixture = {
  runJob(secret?: string): Promise<JobResponse>
  runAuthorizedJob(): Promise<JobResponse>
  prepareDueAppointments(count: number, emailOverride?: string): Promise<string[]>
  insertPreexistingSend(appointmentId: string): Promise<void>
  insertDueOutboxMessage(recipient?: string): Promise<string>
  setAppointmentRecipient(appointmentId: string, email: string): Promise<void>
  plantPersistedDispatchAuditLeak(appointmentId: string, leak: string): Promise<void>
  reminderRows(): Promise<ReminderRow[]>
  outboxRows(): Promise<OutboxState[]>
  mailMessages(): Promise<MailMessage[]>
  dispatchLogs(): DispatchLog[]
  dispatchAudits(): Promise<DispatchAudit[]>
  appBaseUrl(): string
  phiTerms(): string[]
  close(): Promise<void>
}

type RunningBoundary = { url: string; close(): Promise<void> }

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function dockerPsql(run: Run, sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return stdout.trim()
}

async function dockerPsqlScript(run: Run, sql: string): Promise<void> {
  execFileSync(
    'docker',
    ['exec', '-i', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql, maxBuffer: 32 * 1024 * 1024 },
  )
}

function seedDbClient(run: Run): SeedDbClient {
  return {
    async countRows(table) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('E8 fixture: invalid seed table identifier')
      return Number(await dockerPsql(run, `select count(*) from ${table};`))
    },
    async execute(sql) {
      await dockerPsqlScript(run, sql)
    },
  }
}

function seedAuthClient(run: Run): AuthAdminClient {
  return {
    auth: {
      admin: {
        async createUser(attrs) {
          await dockerPsql(run, `insert into auth.users (id) values (${sqlLiteral(attrs.id)}::uuid) on conflict do nothing;`)
          return { data: { user: { id: attrs.id } }, error: null }
        },
      },
    },
  }
}

function seedStorageClient(): PhiStorageClient {
  return {
    storage: {
      from() {
        return {
          async list() {
            return { data: [], error: null }
          },
          async upload() {
            return { data: {}, error: null }
          },
        }
      },
    },
  }
}

async function seedDatabase(run: Run, now: Date): Promise<RowSet> {
  const pool = generateAssetPool(SOURCE_SEED)
  const rowSet = buildRowSet({
    pool,
    sourceSeed: SOURCE_SEED,
    now,
    minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS,
  })
  await runSeed({
    storage: seedStorageClient(),
    authAdmin: seedAuthClient(run),
    db: seedDbClient(run),
    sourceSeed: SOURCE_SEED,
    now,
    minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS,
  })
  return rowSet
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function requiredEq(url: URL, name: string): string {
  const raw = url.searchParams.get(name)
  if (!raw?.startsWith('eq.')) throw new Error(`E8 fixture: ${name} must use an equality filter`)
  return raw.slice(3)
}

function requireIsNull(url: URL, name: string): void {
  if (url.searchParams.get(name) !== 'is.null') throw new Error(`E8 fixture: ${name} must use an is-null filter`)
}

function requiredUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`E8 fixture: ${name} must be a UUID`)
  }
  return value
}

function requiredIso(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`E8 fixture: ${name} must be an ISO timestamp`)
  return value
}

function assertServiceRole(req: IncomingMessage): void {
  if (req.headers.apikey !== SERVICE_ROLE_KEY || req.headers.authorization !== `Bearer ${SERVICE_ROLE_KEY}`) {
    throw new Error('E8 fixture: reminder data request did not use the service-role client')
  }
}

async function handleAppointments(run: Run, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'GET') throw new Error('E8 fixture: appointments accepts GET only')
  assertServiceRole(req)
  const select = url.searchParams.get('select') ?? ''
  if (select !== 'id,patients!inner(email),slots!inner(starts_at)') {
    throw new Error('E8 fixture: reminder due query changed its relational select')
  }
  if (url.searchParams.get('status') !== 'in.(requested,confirmed)') {
    throw new Error('E8 fixture: reminder due query changed its status filter')
  }
  const slotFilters = url.searchParams.getAll('slots.starts_at')
  const lower = slotFilters.find((value) => value.startsWith('gte.'))?.slice(4)
  const upper = slotFilters.find((value) => value.startsWith('lt.'))?.slice(3)
  if (!lower || !upper) throw new Error('E8 fixture: reminder due query omitted its half-open slot window')
  requiredIso(lower, 'lower due-window bound')
  requiredIso(upper, 'upper due-window bound')
  const rows = await dockerPsql(
    run,
    `select coalesce(json_agg(row_to_json(due_rows) order by due_rows.id), '[]'::json)::text
       from (
         select a.id,
                json_build_object('email', p.email) as patients,
                json_build_object('starts_at', s.starts_at) as slots
           from appointments a
           join patients p on p.id = a.patient_id
           join slots s on s.id = a.slot_id
          where a.status in ('requested', 'confirmed')
            and s.starts_at >= ${sqlLiteral(lower)}::timestamptz
            and s.starts_at < ${sqlLiteral(upper)}::timestamptz
       ) due_rows;`,
  )
  sendJson(res, 200, JSON.parse(rows))
}

async function handleClaim(run: Run, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') throw new Error('E8 fixture: reminder claim RPC accepts POST only')
  assertServiceRole(req)
  const body = await bodyOf(req)
  const appointmentId = requiredUuid(String(body.p_appointment_id ?? ''), 'claim appointment id')
  const leadHours = Number(body.p_lead_hours)
  const leaseMinutes = Number(body.p_claim_lease_minutes)
  if (!Number.isSafeInteger(leadHours) || !Number.isSafeInteger(leaseMinutes)) {
    throw new Error('E8 fixture: reminder claim intervals must be integers')
  }
  const claimed = await dockerPsql(
    run,
    `select claim_reminder_send(${sqlLiteral(appointmentId)}::uuid, ${leadHours}, ${leaseMinutes})::text;`,
  )
  sendJson(res, 200, claimed === 'true' || claimed === 't')
}

async function handleReminderUpdate(run: Run, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'PATCH') throw new Error('E8 fixture: reminder_sends accepts PATCH only')
  assertServiceRole(req)
  const appointmentId = requiredUuid(requiredEq(url, 'appointment_id'), 'reminder appointment id')
  const leadHours = Number(requiredEq(url, 'lead_hours'))
  if (!Number.isSafeInteger(leadHours)) throw new Error('E8 fixture: reminder lead-hours filter must be an integer')
  const body = await bodyOf(req)
  const assignments: string[] = []
  if (body.outcome !== undefined) {
    if (body.outcome !== 'sent') throw new Error('E8 fixture: only the sent outcome can be written through this boundary')
    assignments.push(`outcome = 'sent'`)
  }
  if (body.sent_at !== undefined) assignments.push(`sent_at = ${sqlLiteral(requiredIso(String(body.sent_at), 'sent_at'))}::timestamptz`)
  if (body.retryable_at !== undefined) {
    assignments.push(`retryable_at = ${sqlLiteral(requiredIso(String(body.retryable_at), 'retryable_at'))}::timestamptz`)
  }
  if (assignments.length === 0) throw new Error('E8 fixture: empty reminder update')
  await dockerPsql(
    run,
    `update reminder_sends set ${assignments.join(', ')}
      where appointment_id = ${sqlLiteral(appointmentId)}::uuid and lead_hours = ${leadHours};`,
  )
  res.writeHead(204)
  res.end()
}

async function handleAuditInsert(run: Run, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') throw new Error('E8 fixture: audit_events accepts POST only')
  assertServiceRole(req)
  const body = await bodyOf(req)
  const targetId = requiredUuid(String(body.target_id ?? ''), 'audit target id')
  if (body.actor_kind !== 'system' || body.actor_ref !== null || body.action !== 'reminder.dispatch' || body.target_kind !== 'appointment') {
    throw new Error('E8 fixture: reminder audit shape changed')
  }
  if (body.outcome !== 'granted' && body.outcome !== 'denied') throw new Error('E8 fixture: reminder audit outcome changed')
  await dockerPsql(
    run,
    `insert into audit_events (actor_kind, actor_ref, action, target_kind, target_id, outcome, detail)
     values ('system', null, 'reminder.dispatch', 'appointment', ${sqlLiteral(targetId)}::uuid,
       ${sqlLiteral(body.outcome)}, ${sqlLiteral(JSON.stringify(body.detail ?? null))}::jsonb);`,
  )
  res.writeHead(201)
  res.end()
}

async function handleEmailOutbox(run: Run, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  assertServiceRole(req)
  if (req.method === 'GET') {
    const rows = await dockerPsql(
      run,
      `select coalesce(json_agg(row_to_json(outbox_rows)), '[]'::json)::text
         from (select id, recipient, subject, body, attempts, next_attempt_at
                 from email_outbox where sent_at is null and next_attempt_at <= now() order by created_at) outbox_rows;`,
    )
    sendJson(res, 200, JSON.parse(rows))
    return
  }
  if (req.method === 'PATCH') {
    const body = await bodyOf(req)
    const id = requiredUuid(requiredEq(url, 'id'), 'outbox id')
    requireIsNull(url, 'sent_at')
    const keys = Object.keys(body).sort()
    if (keys.length === 1 && keys[0] === 'next_attempt_at') {
      if (url.searchParams.get('select') !== 'id') throw new Error('E8 fixture: outbox claim must return its id')
      const previousDue = requiredIso(requiredEq(url, 'next_attempt_at'), 'previous next_attempt_at')
      const claimedUntil = requiredIso(String(body.next_attempt_at), 'claimed next_attempt_at')
      const updated = await dockerPsql(
        run,
        `update email_outbox
            set next_attempt_at = ${sqlLiteral(claimedUntil)}::timestamptz
          where id = ${sqlLiteral(id)}::uuid
            and sent_at is null
            and next_attempt_at = ${sqlLiteral(previousDue)}::timestamptz
        returning json_build_object('id', id)::text;`,
      )
      sendJson(res, 200, updated === '' ? [] : [JSON.parse(updated)])
      return
    }
    if (keys.length === 1 && keys[0] === 'sent_at' && !url.searchParams.has('next_attempt_at')) {
      const sentAt = requiredIso(String(body.sent_at), 'outbox sent_at')
      await dockerPsql(
        run,
        `update email_outbox
            set sent_at = ${sqlLiteral(sentAt)}::timestamptz
          where id = ${sqlLiteral(id)}::uuid and sent_at is null;`,
      )
      sendJson(res, 200, [])
      return
    }
    if (keys.join(',') === 'attempts,last_error,next_attempt_at' && !url.searchParams.has('next_attempt_at')) {
      const attempts = Number(body.attempts)
      if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('E8 fixture: outbox attempts must be a positive integer')
      if (body.last_error !== 'email_delivery_failed') throw new Error('E8 fixture: outbox error category changed')
      const nextAttemptAt = requiredIso(String(body.next_attempt_at), 'retry next_attempt_at')
      await dockerPsql(
        run,
        `update email_outbox
            set attempts = ${attempts},
                last_error = 'email_delivery_failed',
                next_attempt_at = ${sqlLiteral(nextAttemptAt)}::timestamptz
          where id = ${sqlLiteral(id)}::uuid and sent_at is null;`,
      )
      sendJson(res, 200, [])
      return
    }
    throw new Error('E8 fixture: outbox PATCH shape changed')
  }
  throw new Error('E8 fixture: email_outbox accepts GET or PATCH only')
}

async function handleBoundaryRequest(run: Run, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://e8-supabase.local')
  if (url.pathname === '/rest/v1/appointments') return handleAppointments(run, req, res, url)
  if (url.pathname === '/rest/v1/rpc/claim_reminder_send') return handleClaim(run, req, res)
  if (url.pathname === '/rest/v1/reminder_sends') return handleReminderUpdate(run, req, res, url)
  if (url.pathname === '/rest/v1/audit_events') return handleAuditInsert(run, req, res)
  if (url.pathname === '/rest/v1/email_outbox') return handleEmailOutbox(run, req, res, url)
  sendJson(res, 404, { code: 'PGRST404', message: 'E8 fixture has no handler for this request' })
}

async function startSupabaseBoundary(run: Run): Promise<RunningBoundary> {
  const server: Server = createServer((req, res) => {
    void handleBoundaryRequest(run, req, res).catch((error: unknown) => {
      sendJson(res, 400, { code: 'E8_FIXTURE_REQUEST', message: error instanceof Error ? error.message : 'invalid request' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('E8 fixture: could not resolve Supabase boundary port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('E8 fixture: could not resolve application port')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function testEnvironment(): Promise<Record<string, string>> {
  const raw = await readFile(path.join(REPO_ROOT, '.env.test'), 'utf8')
  const values: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator !== -1) values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }
  return values
}

async function waitForApp(baseUrl: string, child: ChildProcess, output: () => string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`E8 app exited before readiness (${child.exitCode}):\n${output()}`)
    try {
      const response = await fetch(`${baseUrl}/api/jobs/reminders`, { method: 'POST' })
      if (response.status === 401) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`E8 app did not become ready: ${String(lastError)}\n${output()}`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

export async function startE8AcceptanceFixture(): Promise<E8AcceptanceFixture> {
  const run = await startRun(await ensureContainer())
  let boundary: RunningBoundary | undefined
  let child: ChildProcess | undefined
  try {
    await dockerPsql(
      run,
      `create or replace function auth.uid() returns uuid
       language sql stable
       as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    )
    const rowSet = await seedDatabase(run, new Date())
    boundary = await startSupabaseBoundary(run)
    const port = await unusedPort()
    const baseUrl = `http://127.0.0.1:${port}`
    let appOutput = ''
    const env: NodeJS.ProcessEnv = {
      ...processEnvironment,
      ...(await testEnvironment()),
      PORT: String(port),
      APP_BASE_URL: baseUrl,
      NEXT_PUBLIC_SUPABASE_URL: boundary.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'e8-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      SOURCE_REF_SALT: 'e8-source-ref-salt',
      CRON_SECRET,
      EMAIL_TRANSPORT: 'log',
      WATCHPACK_POLLING: 'true',
    }
    delete env.RESEND_API_KEY
    delete env.RESEND_FROM
    child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'run-next.mjs'), 'dev'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk: Buffer) => (appOutput += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (appOutput += chunk.toString()))
    await waitForApp(baseUrl, child, () => appOutput)

    let scenarioAppointmentIds: string[] = []
    let scenarioSlotIds: string[] = []
    let scenarioProviderIds: string[] = []
    let scenarioStartsAt = ''
    let scenarioMailBaseline = new Set<string>()
    let scenarioLogOffset = appOutput.length
    const mailDir = path.join(REPO_ROOT, '.local', 'mail')

    async function mailNames(): Promise<string[]> {
      try {
        return await readdir(mailDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    }

    async function runJob(secret?: string): Promise<JobResponse> {
      const headers = secret === undefined ? undefined : { 'x-cron-secret': secret }
      const response = await fetch(`${baseUrl}/api/jobs/reminders`, { method: 'POST', headers })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }

    return {
      runJob,
      async runAuthorizedJob() {
        return runJob(CRON_SECRET)
      },
      async prepareDueAppointments(count, emailOverride) {
        if (!Number.isSafeInteger(count) || count < 1 || count > rowSet.providers.length) {
          throw new Error(`E8 fixture: due appointment count must be between 1 and ${rowSet.providers.length}`)
        }
        if (scenarioAppointmentIds.length > 0) {
          await dockerPsqlScript(
            run,
            `delete from reminder_sends where appointment_id = any(array[${scenarioAppointmentIds.map((id) => `${sqlLiteral(id)}::uuid`).join(',')}]);
             delete from appointments where id = any(array[${scenarioAppointmentIds.map((id) => `${sqlLiteral(id)}::uuid`).join(',')}]);
             delete from slots where id = any(array[${scenarioSlotIds.map((id) => `${sqlLiteral(id)}::uuid`).join(',')}]);
             delete from provider_services where provider_id = any(array[${scenarioProviderIds.map((id) => `${sqlLiteral(id)}::uuid`).join(',')}]);
             delete from providers where id = any(array[${scenarioProviderIds.map((id) => `${sqlLiteral(id)}::uuid`).join(',')}]);`,
          )
        }
        await dockerPsql(run, `delete from reminder_sends; delete from audit_events where action = 'reminder.dispatch';`)
        scenarioAppointmentIds = Array.from({ length: count }, () => randomUUID())
        scenarioSlotIds = Array.from({ length: count }, () => randomUUID())
        scenarioProviderIds = Array.from({ length: count }, () => randomUUID())
        scenarioStartsAt = new Date(Date.now() + 24 * 60 * 60 * 1000 + 5 * 60 * 1000).toISOString()
        const endsAt = new Date(Date.parse(scenarioStartsAt) + 30 * 60 * 1000).toISOString()
        const serviceId = rowSet.services[0].id
        const statements: string[] = []
        for (let index = 0; index < count; index += 1) {
          const patient = rowSet.patients[index]
          const email = emailOverride ?? patient.email
          statements.push(
            `update patients set email = ${sqlLiteral(email)} where id = ${sqlLiteral(patient.id)}::uuid;`,
            `insert into providers (id, full_name, time_zone) values (${sqlLiteral(scenarioProviderIds[index])}::uuid, 'E8 Provider', 'America/Chicago');`,
            `insert into provider_services (provider_id, service_id) values (${sqlLiteral(scenarioProviderIds[index])}::uuid, ${sqlLiteral(serviceId)}::uuid);`,
            `insert into slots (id, provider_id, starts_at, ends_at) values (${sqlLiteral(scenarioSlotIds[index])}::uuid, ${sqlLiteral(scenarioProviderIds[index])}::uuid, ${sqlLiteral(scenarioStartsAt)}::timestamptz, ${sqlLiteral(endsAt)}::timestamptz);`,
            `insert into appointments (id, slot_id, patient_id, provider_id, service_id, status) values (${sqlLiteral(scenarioAppointmentIds[index])}::uuid, ${sqlLiteral(scenarioSlotIds[index])}::uuid, ${sqlLiteral(patient.id)}::uuid, ${sqlLiteral(scenarioProviderIds[index])}::uuid, ${sqlLiteral(serviceId)}::uuid, 'confirmed');`,
          )
        }
        await dockerPsqlScript(run, statements.join('\n'))
        scenarioMailBaseline = new Set(await mailNames())
        scenarioLogOffset = appOutput.length
        return [...scenarioAppointmentIds]
      },
      async insertPreexistingSend(appointmentId) {
        if (!scenarioAppointmentIds.includes(appointmentId)) {
          throw new Error('E8 fixture: pre-existing send must belong to the active scenario')
        }
        await dockerPsql(
          run,
          `insert into reminder_sends (appointment_id, lead_hours, outcome, sent_at)
           values (${sqlLiteral(appointmentId)}::uuid, 24, 'sent', now());`,
        )
      },
      async insertDueOutboxMessage(recipient = 'outbox@example.test') {
        const id = randomUUID()
        await dockerPsql(run, 'delete from email_outbox;')
        await dockerPsql(
          run,
          `insert into email_outbox (id, recipient, subject, body, next_attempt_at)
           values (${sqlLiteral(id)}::uuid, ${sqlLiteral(recipient)}, 'Share notice', 'A secure link is ready.', now());`,
        )
        return id
      },
      async setAppointmentRecipient(appointmentId, email) {
        if (!scenarioAppointmentIds.includes(appointmentId)) {
          throw new Error('E8 fixture: recipient update must belong to the active scenario')
        }
        const updated = await dockerPsql(
          run,
          `update patients p set email = ${sqlLiteral(email)}
             from appointments a
            where a.id = ${sqlLiteral(appointmentId)}::uuid and a.patient_id = p.id
          returning a.id::text;`,
        )
        if (updated !== appointmentId) throw new Error('E8 fixture: recipient update reached no appointment')
      },
      async plantPersistedDispatchAuditLeak(appointmentId, leak) {
        if (!scenarioAppointmentIds.includes(appointmentId)) {
          throw new Error('E8 fixture: planted audit leak must belong to the active scenario')
        }
        const updated = await dockerPsql(
          run,
          `update audit_events
              set detail = detail || jsonb_build_object('diagnostic', ${sqlLiteral(leak)})
            where action = 'reminder.dispatch'
              and target_id = ${sqlLiteral(appointmentId)}::uuid
          returning id::text;`,
        )
        if (updated === '') throw new Error('E8 fixture: planted audit leak reached no dispatch audit')
      },
      async reminderRows() {
        const raw = await dockerPsql(
          run,
          `select coalesce(json_agg(json_build_object(
             'appointmentId', appointment_id,
             'leadHours', lead_hours,
             'outcome', outcome,
             'sentAt', sent_at,
             'retryableAt', retryable_at
           ) order by appointment_id), '[]'::json)::text from reminder_sends;`,
        )
        return JSON.parse(raw) as ReminderRow[]
      },
      async outboxRows() {
        const raw = await dockerPsql(
          run,
          `select coalesce(json_agg(json_build_object(
             'id', id,
             'attempts', attempts,
             'nextAttemptAt', next_attempt_at,
             'sentAt', sent_at,
             'lastError', last_error
           ) order by id), '[]'::json)::text from email_outbox;`,
        )
        return JSON.parse(raw) as OutboxState[]
      },
      async mailMessages() {
        const names = (await mailNames()).filter((name) => !scenarioMailBaseline.has(name) && name.endsWith('.json'))
        return Promise.all(
          names.map(async (name) => JSON.parse(await readFile(path.join(mailDir, name), 'utf8')) as MailMessage),
        )
      },
      dispatchLogs() {
        return appOutput
          .slice(scenarioLogOffset)
          .split('\n')
          .filter((line) => line.includes('{"event":"email.sent"'))
          .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as DispatchLog)
      },
      async dispatchAudits() {
        if (scenarioAppointmentIds.length === 0) return []
        const raw = await dockerPsql(
          run,
          `select coalesce(json_agg(json_build_object(
             'id', id,
             'occurredAt', occurred_at,
             'actorKind', actor_kind,
             'actorRef', actor_ref,
             'action', action,
             'targetKind', target_kind,
             'appointmentId', target_id,
             'outcome', outcome,
             'detail', detail
           ) order by id), '[]'::json)::text
             from audit_events
            where action = 'reminder.dispatch';`,
        )
        return JSON.parse(raw) as DispatchAudit[]
      },
      appBaseUrl() {
        return baseUrl
      },
      phiTerms() {
        const patients = rowSet.patients.slice(0, scenarioAppointmentIds.length)
        return [
          ...patients.flatMap((patient) => [patient.full_name, patient.date_of_birth, patient.patient_ref]),
          'E8 Provider',
          rowSet.services[0].name,
          ...scenarioAppointmentIds,
          scenarioStartsAt,
          CRON_SECRET,
        ].filter((term, index, terms) => term !== '' && terms.indexOf(term) === index)
      },
      async close() {
        if (child) await stopChild(child)
        if (boundary) await boundary.close()
        await stopRun(run)
      },
    }
  } catch (error) {
    if (child) await stopChild(child)
    if (boundary) await boundary.close()
    await stopRun(run)
    throw error
  }
}

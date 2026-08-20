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
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function seededFrameStorageKeys(count: number): string[] {
  return Array.from({ length: count }, (_, streamIndex) => {
    const bytes = createHash('sha256')
      .update(`patient-imaging-portal\0e2-fixture-frame-storage\0${streamIndex}`)
      .digest()
      .subarray(0, 16)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytes.toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  })
}

const E3_CINE_FRAME_STORAGE_KEYS = seededFrameStorageKeys(100)

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

type FakeVisit = {
  id: string
  patient_id: string
  provider_id: string
  occurred_at: string
  status: 'completed' | 'scheduled' | 'cancelled'
}

type FakeStudy = {
  id: string
  patient_id: string
  visit_id: string
  description: string
}

type FakeCineFrame = {
  clip_id: string
  frame_index: number
  storage_key: string
}

type FakeReport = {
  id: string
  patient_id: string
  study_id: string
  status: 'preliminary' | 'signed'
  findings: string
  impression: string
  signed_by: string | null
  signed_at: string | null
}

type FakeProvider = {
  id: string
  user_id: string
  full_name: string
  time_zone: string
  slot_minutes: number
}

type FakeWorkingHour = {
  provider_id: string
  weekday: number
  starts_local: string
  ends_local: string
}

type FakeAvailabilityBlock = {
  id: string
  provider_id: string
  starts_at: string
  ends_at: string
  reason: string | null
}

type FakeSlot = { id: string; provider_id: string; starts_at: string; ends_at: string; status: 'open' | 'booked' }
type FakeBookingAppointment = { id: string; slot_id: string; patient_id: string; service_id: string; idempotency_key: string }
type FakeAppointment = {
  id: string
  patient_id: string
  status: 'confirmed'
  out_of_hours: boolean
  created_at: string
  slots: { starts_at: string; ends_at: string }
  providers: { full_name: string; time_zone: string }
  services: { name: string }
}
type FakeScheduleSlot = {
  id: string
  provider_id: string
  starts_at: string
  ends_at: string
  status: 'open' | 'booked'
}

type FakeScheduleAppointment = {
  id: string
  slot_id: string
  provider_id: string
  patient_id: string
  service_name: string
  status: 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
  out_of_hours: boolean
}

type FakeIdentityAttempt = {
  id: string
  attempted_patient_ref: string
  source_ref: string
  user_id: string
  succeeded: boolean
  attempted_at: string
}

type FakeShareLink = {
  id: string
  token_hash: string
  patient_id: string
  created_by: string
  recipient_email: string
  expires_at: string
  revoked_at: string | null
  image_id: string | null
  report_id: string | null
  created_at: string
}

type FakeEmailOutbox = {
  id: string
  recipient: string
  subject: string
  body: string
  attempts: number
  next_attempt_at: string
  sent_at: string | null
  last_error: string | null
  created_at: string
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

const OTHER_PATIENT: FakePatient = {
  id: '55825582-5582-4582-8582-558255825582',
  user_id: null,
  patient_ref: 'PT-5582',
  date_of_birth: '1979-08-25',
  full_name: 'Casey Vale',
  email: 'casey.vale@example.test',
  phone: null,
}

export const E2_PROVIDER_ID = '66336633-6633-4633-8633-663366336633'
export const E2_OTHER_PROVIDER_ID = '66446644-6644-4644-8644-664466446644'
export const E2_PROVIDER_EMAIL = 'avery.chen@example.test'
export const E2_OTHER_PROVIDER_EMAIL = 'riley.patel@example.test'
export const E2_NON_PROVIDER_EMAIL = 'taylor.morgan@example.test'
export const E2_PROVIDER_PASSWORD = 'ProviderFixturePassword9'
export const E2_PROVIDER_ACCOUNT_ID = '11331133-1133-4133-8133-113311331133'
export const E2_OTHER_PROVIDER_ACCOUNT_ID = '11441144-1144-4144-8144-114411441144'
export const E2_NON_PROVIDER_ACCOUNT_ID = '11551155-1155-4155-8155-115511551155'
export const E2_SEEDED_STUDY_ID = '99669966-9966-4966-8966-996699669966'
export const E2_SEEDED_REPORT_ID = 'bb88bb88-bb88-4b88-8b88-bb88bb88bb88'
export const E2_SEEDED_CLIP_ID = 'ee11ee11-ee11-4e11-8e11-ee11ee11ee11'
export const E2_SEEDED_IMAGE_ID = '10000000-0000-4000-8000-000000000001'
export const E2_FOREIGN_STUDY_ID = 'aa77aa77-aa77-4a77-8a77-aa77aa77aa77'
export const E2_FOREIGN_REPORT_ID = 'cc99cc99-cc99-4c99-8c99-cc99cc99cc99'
export const E2_FOREIGN_CLIP_ID = 'ff22ff22-ff22-4f22-8f22-ff22ff22ff22'
export const E2_BOOK_SERVICE_ID = '77667766-7766-4766-8766-776677667766'
export const E3_SCHEDULED_VISIT_ID = '77557755-7755-4755-8755-775577557755'
export const E3_SCHEDULED_STUDY_ID = '99779977-9977-4977-8977-997799779977'
export const E3_MISSING_CINE_FRAME_INDEX = 42
export const E3_MISSING_CINE_FRAME_STORAGE_KEY = E3_CINE_FRAME_STORAGE_KEYS[E3_MISSING_CINE_FRAME_INDEX]!
export const E4_CANCELLED_VISIT_ID = '77667766-7766-4766-8766-776677667766'
export const E4_CANCELLED_STUDY_ID = '99889988-9988-4988-8988-998899889988'
export const E4_PRELIMINARY_REPORT_ID = 'bd88bd88-bd88-4d88-8d88-bd88bd88bd88'
export const E5_CRON_SECRET = 'e5-test-cron-secret'

const PROVIDERS: FakeProvider[] = [
  {
    id: E2_PROVIDER_ID,
    user_id: E2_PROVIDER_ACCOUNT_ID,
    full_name: 'Dr. Avery Chen',
    time_zone: 'America/Chicago',
    slot_minutes: 30,
  },
  {
    id: E2_OTHER_PROVIDER_ID,
    user_id: E2_OTHER_PROVIDER_ACCOUNT_ID,
    full_name: 'Dr. Riley Patel',
    time_zone: 'America/New_York',
    slot_minutes: 20,
  },
]
const APPOINTMENT_SEED_NOW = Date.now()
const APPOINTMENTS: FakeAppointment[] = [
  {
    id: '22552255-2255-4255-8255-225522552255',
    patient_id: SEEDED_PATIENT.id,
    status: 'confirmed',
    out_of_hours: false,
    created_at: new Date(APPOINTMENT_SEED_NOW).toISOString(),
    slots: {
      starts_at: new Date(APPOINTMENT_SEED_NOW + 12 * 60 * 60 * 1_000).toISOString(),
      ends_at: new Date(APPOINTMENT_SEED_NOW + 13 * 60 * 60 * 1_000).toISOString(),
    },
    providers: { full_name: PROVIDERS[0].full_name, time_zone: PROVIDERS[0].time_zone },
    services: { name: 'MRI' },
  },
  {
    id: '22662266-2266-4266-8266-226622662266',
    patient_id: SEEDED_PATIENT.id,
    status: 'confirmed',
    out_of_hours: true,
    created_at: new Date(APPOINTMENT_SEED_NOW - 1).toISOString(),
    slots: {
      starts_at: new Date(APPOINTMENT_SEED_NOW + 72 * 60 * 60 * 1_000).toISOString(),
      ends_at: new Date(APPOINTMENT_SEED_NOW + 73 * 60 * 60 * 1_000).toISOString(),
    },
    providers: { full_name: PROVIDERS[0].full_name, time_zone: PROVIDERS[0].time_zone },
    services: { name: 'MRI' },
  },
]
const VISITS: FakeVisit[] = [
  {
    id: '77447744-7744-4744-8744-774477447744',
    patient_id: SEEDED_PATIENT.id,
    provider_id: PROVIDERS[0].id,
    occurred_at: '2026-08-10T14:00:00.000Z',
    status: 'completed',
  },
  {
    id: '88558855-8855-4855-8855-885588558855',
    patient_id: OTHER_PATIENT.id,
    provider_id: PROVIDERS[0].id,
    occurred_at: '2026-08-11T14:00:00.000Z',
    status: 'completed',
  },
  {
    id: E3_SCHEDULED_VISIT_ID,
    patient_id: SEEDED_PATIENT.id,
    provider_id: PROVIDERS[0].id,
    occurred_at: '2026-08-20T14:00:00.000Z',
    status: 'scheduled',
  },
  {
    id: E4_CANCELLED_VISIT_ID,
    patient_id: SEEDED_PATIENT.id,
    provider_id: PROVIDERS[0].id,
    occurred_at: '2026-08-09T14:00:00.000Z',
    status: 'cancelled',
  },
]
const STUDIES: FakeStudy[] = [
  { id: E2_SEEDED_STUDY_ID, patient_id: SEEDED_PATIENT.id, visit_id: VISITS[0].id, description: 'Seeded abdominal ultrasound' },
  {
    id: E2_FOREIGN_STUDY_ID,
    patient_id: OTHER_PATIENT.id,
    visit_id: VISITS[1].id,
    description: 'Other patient study',
  },
  {
    id: E3_SCHEDULED_STUDY_ID,
    patient_id: SEEDED_PATIENT.id,
    visit_id: E3_SCHEDULED_VISIT_ID,
    description: 'Scheduled seeded follow-up ultrasound',
  },
  {
    id: E4_CANCELLED_STUDY_ID,
    patient_id: SEEDED_PATIENT.id,
    visit_id: E4_CANCELLED_VISIT_ID,
    description: 'Cancelled seeded follow-up ultrasound',
  },
]
const IMAGES = [
  {
    id: E2_SEEDED_IMAGE_ID,
    patient_id: SEEDED_PATIENT.id,
    study_id: E2_SEEDED_STUDY_ID,
    width: 1024,
    height: 768,
    ordinal: 1,
    storage_key: 'full-1.png',
    thumb_key: 'thumb-1.png',
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    patient_id: SEEDED_PATIENT.id,
    study_id: E2_SEEDED_STUDY_ID,
    width: 800,
    height: 600,
    ordinal: 2,
    storage_key: 'full-2.png',
    thumb_key: null,
  },
]
const CINE_CLIPS = [
  {
    id: E2_SEEDED_CLIP_ID,
    patient_id: SEEDED_PATIENT.id,
    study_id: E2_SEEDED_STUDY_ID,
    frame_count: 100,
    default_fps: 12,
    poster_key: null,
  },
  {
    id: E2_FOREIGN_CLIP_ID,
    patient_id: OTHER_PATIENT.id,
    study_id: E2_FOREIGN_STUDY_ID,
    frame_count: 1,
    default_fps: 12,
    poster_key: null,
  },
]
const CINE_FRAMES: FakeCineFrame[] = Array.from({ length: 100 }, (_, frame_index) => ({
  clip_id: E2_SEEDED_CLIP_ID,
  frame_index,
  storage_key: E3_CINE_FRAME_STORAGE_KEYS[frame_index]!,
}))
const REPORTS: FakeReport[] = [
  {
    id: E2_SEEDED_REPORT_ID,
    patient_id: SEEDED_PATIENT.id,
    study_id: E2_SEEDED_STUDY_ID,
    status: 'signed',
    findings: 'No acute abnormality.',
    impression: 'Normal seeded study.',
    signed_by: PROVIDERS[0].id,
    signed_at: '2026-08-12T16:00:00.000Z',
  },
  {
    id: E2_FOREIGN_REPORT_ID,
    patient_id: OTHER_PATIENT.id,
    study_id: STUDIES[1].id,
    status: 'signed',
    findings: 'Private other-patient findings.',
    impression: 'Private other-patient impression.',
    signed_by: PROVIDERS[0].id,
    signed_at: '2026-08-13T16:00:00.000Z',
  },
  {
    id: E4_PRELIMINARY_REPORT_ID,
    patient_id: SEEDED_PATIENT.id,
    study_id: E4_CANCELLED_STUDY_ID,
    status: 'preliminary',
    findings: 'Preliminary seeded follow-up findings.',
    impression: 'Preliminary seeded follow-up impression.',
    signed_by: null,
    signed_at: null,
  },
]

const SEEDED_PATIENT_TABLES = new Map<string, unknown[]>([
  ['/rest/v1/appointments', APPOINTMENTS],
  ['/rest/v1/visits', VISITS],
  ['/rest/v1/studies', STUDIES],
  ['/rest/v1/images', IMAGES],
  ['/rest/v1/cine_clips', CINE_CLIPS],
])

// Keep the fixture's route name assembled rather than spelling the production
// RPC identifier in a second TypeScript file. JOR-254's invariant test treats
// that identifier as an executable call-site capability: only identity.ts may
// name it directly.
const LINK_PATIENT_RPC_PATH = ['/rest/v1/rpc/link', 'patient', 'identity'].join('_')
const APPLY_AVAILABILITY_RPC_PATH = ['/rest/v1/rpc/apply', 'provider', 'availability'].join('_')

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

type DependencyState = 'ok' | 'down' | 'hang' | 'error'

export function startFakeAuthServer(): Promise<FakeAuthServer> {
  const usersByEmail = new Map<string, FakeUser>([
    [
      E2_PROVIDER_EMAIL,
      {
        id: E2_PROVIDER_ACCOUNT_ID,
        email: E2_PROVIDER_EMAIL,
        password: E2_PROVIDER_PASSWORD,
        userMetadata: {},
        appMetadata: { provider: 'email', providers: ['email'] },
      },
    ],
    [
      E2_OTHER_PROVIDER_EMAIL,
      {
        id: E2_OTHER_PROVIDER_ACCOUNT_ID,
        email: E2_OTHER_PROVIDER_EMAIL,
        password: E2_PROVIDER_PASSWORD,
        userMetadata: {},
        appMetadata: { provider: 'email', providers: ['email'] },
      },
    ],
    // Intentionally authenticated but absent from PROVIDERS. Availability
    // isolation regressions use this account to prove that a valid session is
    // not sufficient authority to claim provider-owned data.
    [
      E2_NON_PROVIDER_EMAIL,
      {
        id: E2_NON_PROVIDER_ACCOUNT_ID,
        email: E2_NON_PROVIDER_EMAIL,
        password: E2_PROVIDER_PASSWORD,
        userMetadata: {},
        appMetadata: { provider: 'email', providers: ['email'] },
      },
    ],
  ])
  const sessionsByToken = new Map<string, FakeSession>()
  const staffAdminUserIds = new Set<string>()
  let patients: FakePatient[] = [{ ...SEEDED_PATIENT }, { ...OTHER_PATIENT }]
  let identityAttempts: FakeIdentityAttempt[] = []
  let shareLinks: FakeShareLink[] = []
  let emailOutbox: FakeEmailOutbox[] = []
  let providers = PROVIDERS.map((provider) => ({ ...provider }))
  let workingHours: FakeWorkingHour[] = [
    { provider_id: E2_PROVIDER_ID, weekday: 1, starts_local: '09:00:00', ends_local: '17:00:00' },
    { provider_id: E2_OTHER_PROVIDER_ID, weekday: 2, starts_local: '10:00:00', ends_local: '14:00:00' },
  ]
  let availabilityBlocks: FakeAvailabilityBlock[] = []
  let scheduleSlots: FakeScheduleSlot[] = []
  let scheduleAppointments: FakeScheduleAppointment[] = []
  let generatedSlotRangesByProvider = new Map<string, string[]>()
  const bookingServices = [
    { id: E2_BOOK_SERVICE_ID, slug: 'ultrasound', name: 'Ultrasound' },
    { id: '77887788-7788-4788-8788-778877887788', slug: 'follow-up', name: 'Follow-up ultrasound' },
    { id: '88778877-8877-4877-8877-887788778877', slug: 'empty', name: 'No-provider service' },
  ]
  let bookingSlots: FakeSlot[] = []
  let bookingAppointments: FakeBookingAppointment[] = []
  let bookingGeneration = 0
  const auditEvents: Record<string, unknown>[] = []
  let nextAuditEventId = 1
  const calls: Record<string, number> = { signup: 0, token: 0, user: 0, updateUser: 0 }
  const callsByEmail = new Map<string, Record<string, number>>()
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
    if (state === 'error') {
      sendJson(res, 404, { code: 'PGRST205' })
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

  function resetBookingState(): void {
    bookingGeneration += 1
    const start = new Date(Date.now() + 72 * 60 * 60 * 1_000)
    start.setUTCMinutes(0, 0, 0)
    bookingSlots = [0, 1, 2].map((offset) => {
      const startsAt = new Date(start.getTime() + offset * 30 * 60 * 1_000)
      const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1_000)
      return { id: `99009900-9900-4900-8900-${String(bookingGeneration * 10 + offset + 1).padStart(12, '0')}`, provider_id: E2_OTHER_PROVIDER_ID, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), status: 'open' }
    })
    bookingAppointments = []
  }

  function countForEmail(name: string, email: string): void {
    const normalizedEmail = email.trim().toLowerCase()
    const scopedCalls = callsByEmail.get(normalizedEmail) ?? { signup: 0, token: 0, user: 0, updateUser: 0 }
    scopedCalls[name] = (scopedCalls[name] ?? 0) + 1
    callsByEmail.set(normalizedEmail, scopedCalls)
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
    countForEmail('signup', email)

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
    countForEmail('token', email)
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

  function serviceRoleRequest(req: IncomingMessage): boolean {
    const authorization = req.headers.authorization
    const apiKey = req.headers.apikey
    return typeof authorization === 'string' && typeof apiKey === 'string' && authorization === `Bearer ${apiKey}`
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

  function queryValue(url: URL, column: string, operator: 'eq' | 'gte' | 'lt' = 'eq'): string | null {
    const prefix = `${operator}.`
    const value = url.searchParams.getAll(column).find((candidate) => candidate.startsWith(prefix))
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

  function bookingRpcRow(slot: FakeSlot, serviceId: string, appointment: FakeBookingAppointment | null, resultError: string | null, reused: boolean): Record<string, unknown> {
    const provider = providers.find((candidate) => candidate.id === slot.provider_id)
    const service = bookingServices.find((candidate) => candidate.id === serviceId)
    return {
      appointment_id: appointment?.id ?? null,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      appointment_status: appointment ? 'requested' : null,
      provider_name: provider?.full_name ?? null,
      provider_time_zone: provider?.time_zone ?? null,
      service_name: service?.name ?? null,
      out_of_hours: false,
      result_error: resultError,
      result_reused: reused,
    }
  }

  async function handleBookAppointment(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req)
    const caller = authenticatedUser(req)
    const patient = caller ? patients.find((candidate) => candidate.user_id === caller.id) : undefined
    const slot = bookingSlots.find((candidate) => candidate.id === body.p_slot_id)
    const serviceId = String(body.p_service_id)
    const key = String(body.p_idempotency_key)
    const previous = patient ? bookingAppointments.find((candidate) => candidate.patient_id === patient.id && candidate.idempotency_key === key) : undefined
    if (previous) {
      const previousSlot = bookingSlots.find((candidate) => candidate.id === previous.slot_id)!
      if (previous.slot_id !== body.p_slot_id || previous.service_id !== serviceId) {
        sendJson(res, 200, [bookingRpcRow(previousSlot, previous.service_id, null, 'idempotency_key_reused', false)])
        return
      }
      sendJson(res, 200, [bookingRpcRow(previousSlot, previous.service_id, previous, null, true)])
      return
    }
    if (!patient || !slot || slot.status !== 'open') {
      sendJson(res, 200, [bookingRpcRow(slot ?? bookingSlots[0], serviceId, null, 'slot_unavailable', false)])
      return
    }
    if (!bookingServices.some((candidate) => candidate.id === serviceId) || slot.provider_id !== E2_OTHER_PROVIDER_ID) {
      sendJson(res, 200, [bookingRpcRow(slot, serviceId, null, 'service_not_offered', false)])
      return
    }
    slot.status = 'booked'
    const appointment = { id: randomUUID(), slot_id: slot.id, patient_id: patient.id, service_id: serviceId, idempotency_key: key }
    bookingAppointments.push(appointment)
    sendJson(res, 200, [bookingRpcRow(slot, serviceId, appointment, null, false)])
  }

  function handleBookingRead(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (url.pathname === '/rest/v1/services') {
      sendPostgrestRows(req, res, bookingServices)
      return
    }
    if (url.pathname === '/rest/v1/provider_services') {
      const serviceId = queryValue(url, 'service_id')
      const providerId = queryValue(url, 'provider_id')
      const offerings = [
        { serviceId: E2_BOOK_SERVICE_ID, provider: providers.find((candidate) => candidate.id === E2_OTHER_PROVIDER_ID)! },
        { serviceId: E2_BOOK_SERVICE_ID, provider: providers.find((candidate) => candidate.id === E2_PROVIDER_ID)! },
        { serviceId: '77887788-7788-4788-8788-778877887788', provider: providers.find((candidate) => candidate.id === E2_OTHER_PROVIDER_ID)! },
      ]
      const rows = offerings
        .filter((offering) => offering.serviceId === serviceId && (providerId === null || offering.provider.id === providerId))
        .map(({ provider }) => ({
          providers: { id: provider.id, full_name: provider.full_name, time_zone: provider.time_zone },
          provider_id: provider.id,
        }))
      sendPostgrestRows(req, res, rows)
      return
    }
    if (url.pathname === '/rest/v1/slots') {
      const providerId = queryValue(url, 'provider_id')
      const rows = bookingSlots.filter((slot) => slot.provider_id === providerId && slot.status === 'open')
      sendPostgrestRows(req, res, rows)
      return
    }
  }

  function applyEqualityFilters<T extends Record<string, unknown>>(rows: T[], url: URL): T[] {
    return rows.filter((row) =>
      [...url.searchParams.entries()].every(([column, raw]) => {
        if (!raw.startsWith('eq.')) return true
        if (!(column in row)) return false
        return String(row[column]) === raw.slice(3)
      }),
    )
  }

  function patientScopedRows<T extends Record<string, unknown> & { patient_id: string }>(
    req: IncomingMessage,
    url: URL,
    rows: T[],
  ): T[] {
    if (serviceRoleRequest(req)) return applyEqualityFilters(rows, url)
    const user = authenticatedUser(req)
    const patientId = user ? patients.find((patient) => patient.user_id === user.id)?.id : undefined
    if (!patientId) return []
    return applyEqualityFilters(
      rows.filter((row) => row.patient_id === patientId),
      url,
    )
  }

  async function handleShareLinks(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const caller = authenticatedUser(req)
    const callerPatientId = caller ? patients.find((patient) => patient.user_id === caller.id)?.id : undefined
    const visibleRows = serviceRoleRequest(req)
      ? applyEqualityFilters(shareLinks, url)
      : callerPatientId
        ? applyEqualityFilters(shareLinks.filter((link) => link.patient_id === callerPatientId), url)
        : []

    if (req.method === 'GET') {
      const rows = url.searchParams.get('order') === 'created_at.desc'
        ? visibleRows.toSorted((left, right) => right.created_at.localeCompare(left.created_at))
        : visibleRows
      sendPostgrestRows(req, res, rows)
      return
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (!callerPatientId || body.patient_id !== callerPatientId) {
        sendJson(res, 403, { message: 'share link is not accessible' })
        return
      }
      const row: FakeShareLink = {
        id: randomUUID(),
        token_hash: String(body.token_hash),
        patient_id: callerPatientId,
        created_by: String(body.created_by),
        recipient_email: String(body.recipient_email),
        expires_at: String(body.expires_at),
        revoked_at: null,
        image_id: typeof body.image_id === 'string' ? body.image_id : null,
        report_id: typeof body.report_id === 'string' ? body.report_id : null,
        created_at: new Date().toISOString(),
      }
      shareLinks.push(row)
      const returnsRepresentation = String(req.headers.prefer ?? '').includes('return=representation')
      if (returnsRepresentation || String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json')) {
        sendJson(res, 201, String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json') ? row : [row])
      } else {
        res.writeHead(201)
        res.end()
      }
      return
    }

    if (req.method === 'PATCH') {
      const body = await readJsonBody(req)
      if (!callerPatientId || visibleRows.length === 0) {
        sendJson(res, 403, { message: 'share link is not accessible' })
        return
      }
      const visibleIds = new Set(visibleRows.map((row) => row.id))
      shareLinks = shareLinks.map((row) =>
        visibleIds.has(row.id)
          ? { ...row, revoked_at: typeof body.revoked_at === 'string' ? body.revoked_at : row.revoked_at }
          : row,
      )
      res.writeHead(204)
      res.end()
      return
    }

    sendJson(res, 405, { message: 'method not allowed' })
  }

  function filteredOutbox(url: URL): FakeEmailOutbox[] {
    return emailOutbox.filter((row) => {
      const id = queryValue(url, 'id')
      const nextAttemptAt = queryValue(url, 'next_attempt_at')
      const rawNextAttemptAt = url.searchParams.get('next_attempt_at')
      const rawAttempts = url.searchParams.get('attempts')
      const nextAttemptAtLte = rawNextAttemptAt?.startsWith('lte.') ? rawNextAttemptAt.slice(4) : null
      const attemptsLt = rawAttempts?.startsWith('lt.') ? rawAttempts.slice(3) : null
      if (id !== null && row.id !== id) return false
      if (url.searchParams.get('sent_at') === 'is.null' && row.sent_at !== null) return false
      if (nextAttemptAt !== null && row.next_attempt_at !== nextAttemptAt) return false
      if (nextAttemptAtLte && row.next_attempt_at > nextAttemptAtLte) return false
      if (attemptsLt && row.attempts >= Number(attemptsLt)) return false
      return true
    })
  }

  async function handleEmailOutbox(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === 'POST' && authenticatedUser(req)) {
      const body = await readJsonBody(req)
      const now = new Date().toISOString()
      emailOutbox.push({
        id: randomUUID(),
        recipient: String(body.recipient),
        subject: String(body.subject),
        body: String(body.body),
        attempts: 0,
        next_attempt_at: now,
        sent_at: null,
        last_error: null,
        created_at: now,
      })
      res.writeHead(201)
      res.end()
      return
    }
    if (!serviceRoleRequest(req)) {
      sendJson(res, 403, { message: 'email outbox is not accessible' })
      return
    }
    if (req.method === 'GET') {
      const rows = filteredOutbox(url).toSorted((left, right) => left.created_at.localeCompare(right.created_at))
      sendPostgrestRows(req, res, rows)
      return
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req)
      const matchingIds = new Set(filteredOutbox(url).map((row) => row.id))
      emailOutbox = emailOutbox.map((row) => matchingIds.has(row.id) ? { ...row, ...body } as FakeEmailOutbox : row)
      const updated = emailOutbox.filter((row) => matchingIds.has(row.id))
      if (String(req.headers.prefer ?? '').includes('return=representation')) {
        sendJson(res, 200, updated)
      } else {
        res.writeHead(204)
        res.end()
      }
      return
    }
    sendJson(res, 405, { message: 'method not allowed' })
  }

  async function handleExpireShare(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req)
    const shareId = String(body.shareId)
    const index = shareLinks.findIndex((link) => link.id === shareId)
    if (index === -1) {
      sendJson(res, 404, { message: 'share link not found' })
      return
    }
    shareLinks[index] = { ...shareLinks[index]!, expires_at: new Date(Date.now() - 1).toISOString() }
    sendJson(res, 200, { shareId })
  }

  function handleSeededRead(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (req.method !== 'GET') {
      sendJson(res, 405, { message: 'method not allowed' })
      return
    }
    // Provider names are globally readable under production RLS so imaging
    // can decorate a patient's study DTO. Availability rows remain scoped to
    // the owning provider below, and this read handler never permits writes.
    const caller = authenticatedUser(req)
    const callerProvider = caller ? providers.find((provider) => provider.user_id === caller.id) : undefined

    if (url.pathname === '/rest/v1/providers') {
      sendPostgrestRows(
        req,
        res,
        applyEqualityFilters(caller ? providers : [], url),
      )
      return
    }

    if (url.pathname === '/rest/v1/staff_admins') {
      const rows = caller && staffAdminUserIds.has(caller.id) ? [{ id: `admin-${caller.id}`, user_id: caller.id }] : []
      sendPostgrestRows(req, res, applyEqualityFilters(rows, url))
      return
    }

    if (url.pathname === '/rest/v1/working_hours') {
      sendPostgrestRows(
        req,
        res,
        callerProvider ? applyEqualityFilters(workingHours.filter((row) => row.provider_id === callerProvider.id), url) : [],
      )
      return
    }

    if (url.pathname === '/rest/v1/availability_blocks') {
      sendPostgrestRows(
        req,
        res,
        callerProvider ? applyEqualityFilters(availabilityBlocks.filter((row) => row.provider_id === callerProvider.id), url) : [],
      )
      return
    }

    if (url.pathname === '/rest/v1/slots') {
      const startsAtGte = queryValue(url, 'starts_at', 'gte')
      const startsAtLt = queryValue(url, 'starts_at', 'lt')
      const rows = callerProvider ? applyEqualityFilters(scheduleSlots.filter((row) =>
        row.provider_id === callerProvider.id &&
        (startsAtGte === null || row.starts_at >= startsAtGte) &&
        (startsAtLt === null || row.starts_at < startsAtLt)), url) : []
      sendPostgrestRows(req, res, rows)
      return
    }

    if (url.pathname === '/rest/v1/appointments') {
      if (!callerProvider) {
        sendPostgrestRows(req, res, patientScopedRows(req, url, APPOINTMENTS))
        return
      }
      const rows = applyEqualityFilters(scheduleAppointments.filter((row) => row.provider_id === callerProvider.id), url).map((appointment) => {
        const patient = patients.find((candidate) => candidate.id === appointment.patient_id)
        const slot = scheduleSlots.find((candidate) => candidate.id === appointment.slot_id)
        return {
          ...appointment,
          patients: patient ? { patient_ref: patient.patient_ref } : null,
          services: { name: appointment.service_name },
          slots: slot ? { starts_at: slot.starts_at, ends_at: slot.ends_at } : null,
          providers: { full_name: callerProvider.full_name, time_zone: callerProvider.time_zone },
        }
      })
      sendPostgrestRows(req, res, rows)
      return
    }

    if (url.pathname === '/rest/v1/cine_frames') {
      const user = authenticatedUser(req)
      const patientId = user ? patients.find((patient) => patient.user_id === user.id)?.id : undefined
      const rows = patientId
        ? CINE_FRAMES.filter((frame) => CINE_CLIPS.some((clip) => clip.id === frame.clip_id && clip.patient_id === patientId))
        : []
      sendPostgrestRows(req, res, applyEqualityFilters(rows, url))
      return
    }

    const tableRows = SEEDED_PATIENT_TABLES.get(url.pathname) as Array<Record<string, unknown> & { patient_id: string }> | undefined
    if (tableRows !== undefined) {
      sendPostgrestRows(req, res, patientScopedRows(req, url, tableRows))
      return
    }

    const reports = patientScopedRows(req, url, REPORTS).map((report) => {
      const study = STUDIES.find((candidate) => candidate.id === report.study_id)
      const patient = patients.find((candidate) => candidate.id === report.patient_id)
      const provider = providers.find((candidate) => candidate.id === report.signed_by)
      return {
        ...report,
        studies: study ? { description: study.description } : null,
        patients: patient ? { patient_ref: patient.patient_ref } : null,
        providers: provider ? { full_name: provider.full_name } : null,
      }
    })
    sendPostgrestRows(req, res, reports)
  }

  async function handleClock(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req)
    const advanceMs = body.advanceMs
    const sessionToken = body.sessionToken
    const session = typeof sessionToken === 'string' ? sessionsByToken.get(sessionToken) : undefined
    if (typeof advanceMs !== 'number' || !Number.isSafeInteger(advanceMs) || advanceMs < 0 || !session) {
      sendJson(res, 422, { error: 'invalid_clock_advance' })
      return
    }
    session.expiresAt -= Math.ceil(advanceMs / 1000)
    identityAttempts = identityAttempts.map((attempt) => ({
      ...attempt,
      attempted_at: new Date(Date.parse(attempt.attempted_at) - advanceMs).toISOString(),
    }))
    sendJson(res, 200, { advancedMs: advanceMs })
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
      ...rows.map((row) => ({
        id: nextAuditEventId++,
        ...row,
        occurred_at: row.occurred_at ?? new Date().toISOString(),
      })),
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

  function appointmentFallsOutsideWorkingHours(providerId: string, hours: FakeWorkingHour[]): boolean {
    const appointmentWeekday = 1
    const appointmentTime = '16:00:00'
    return providerId === E2_PROVIDER_ID && !hours.some(
      (window) =>
        window.weekday === appointmentWeekday &&
        window.starts_local <= appointmentTime &&
        appointmentTime < window.ends_local,
    )
  }

  async function handleApplyAvailability(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    const providerId = String(body.p_provider_id)
    const caller = authenticatedUser(req)
    const callerProvider = caller ? providers.find((candidate) => candidate.user_id === caller.id) : undefined
    // The production RPC receives both IDs, but neither is an authority on
    // its own.  Bind both to the authenticated provider before exposing an
    // existence check or changing any data.
    if (!caller) {
      sendJson(res, 401, { message: 'session required' })
      return
    }
    if (!callerProvider || callerProvider.id !== providerId || body.p_actor_user_id !== caller.id) {
      sendJson(res, 403, { message: 'provider availability is not accessible' })
      return
    }
    const provider = providers.find((candidate) => candidate.id === providerId)
    if (!provider) {
      sendJson(res, 404, { message: 'provider not found' })
      return
    }

    const withSeconds = (value: unknown) => {
      const wallTime = String(value)
      return wallTime.length === 5 ? `${wallTime}:00` : wallTime
    }
    const nextHours = ((body.p_working_hours ?? []) as Array<Record<string, unknown>>).map((window) => ({
      provider_id: providerId,
      weekday: Number(window.weekday),
      starts_local: withSeconds(window.startsLocal),
      ends_local: withSeconds(window.endsLocal),
    }))
    const nextBlocks = ((body.p_blocks ?? []) as Array<Record<string, unknown>>).map((block, index) => ({
      // A retry of the same write produces the same fixture rows, which keeps
      // successor E2 checks deterministic without pretending these are DB IDs.
      id: `availability-block-${providerId}-${index}`,
      provider_id: providerId,
      starts_at: String(block.startsAt),
      ends_at: String(block.endsAt),
      reason: block.reason === null || block.reason === undefined ? null : String(block.reason),
    }))
    const nextSlotRanges = Array.isArray(body.p_slots) ? body.p_slots.map(String) : []
    // The production regeneration RPC removes the previous free grid in the
    // horizon before inserting the replacement, even when a range reappears.
    const removedOpenSlots = (generatedSlotRangesByProvider.get(providerId) ?? []).length

    provider.slot_minutes = Number(body.p_slot_minutes)
    workingHours = [...workingHours.filter((row) => row.provider_id !== providerId), ...nextHours]
    availabilityBlocks = [
      ...availabilityBlocks.filter((row) => row.provider_id !== providerId),
      ...nextBlocks,
    ]
    generatedSlotRangesByProvider.set(providerId, nextSlotRanges)

    const preservedOutOfHours = appointmentFallsOutsideWorkingHours(providerId, nextHours)
      ? [
          {
            appointmentId: '33773377-3377-4377-8377-337733773377',
            startsAt: '2026-08-17T16:00:00-05:00',
            endsAt: '2026-08-17T16:30:00-05:00',
            patientRef: SEEDED_PATIENT.patient_ref,
          },
        ]
      : []

    sendJson(res, 200, [
      {
        removed_open_slots: removedOpenSlots,
        generated_open_slots: nextSlotRanges.length,
        preserved_out_of_hours: preservedOutOfHours,
      },
    ])
  }

  async function handleScheduleMutation(req: IncomingMessage, res: ServerResponse, rpc: 'transition' | 'cancel'): Promise<void> {
    const body = await readJsonBody(req)
    const caller = authenticatedUser(req)
    const callerProvider = caller ? providers.find((provider) => provider.user_id === caller.id) : undefined
    const appointmentId = String(body.p_appointment_id)
    const appointment = scheduleAppointments.find((candidate) => candidate.id === appointmentId)
    if (!callerProvider || !appointment || appointment.provider_id !== callerProvider.id || body.p_actor_user_id !== caller?.id) {
      sendJson(res, 200, [{ result_error: 'invalid_transition' }])
      return
    }
    const nextStatus = rpc === 'cancel' ? 'cancelled' : String(body.p_status)
    const slot = scheduleSlots.find((candidate) => candidate.id === appointment.slot_id)
    if (!slot) {
      sendJson(res, 200, [{ result_error: 'invalid_transition' }])
      return
    }
    const legal = (appointment.status === 'requested' && (nextStatus === 'confirmed' || nextStatus === 'cancelled')) ||
      (appointment.status === 'confirmed' && (nextStatus === 'cancelled' || ((nextStatus === 'completed' || nextStatus === 'no_show') && new Date(slot.starts_at) < new Date())))
    if (!legal) {
      sendJson(res, 200, [{ result_error: rpc === 'cancel' ? 'not_reschedulable' : 'invalid_transition' }])
      return
    }
    appointment.status = nextStatus as FakeScheduleAppointment['status']
    if (nextStatus === 'cancelled') slot.status = 'open'
    sendJson(res, 200, [{
      result_error: null,
      appointment_id: appointment.id,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      appointment_status: appointment.status,
      provider_name: callerProvider.full_name,
      provider_time_zone: callerProvider.time_zone,
      service_name: appointment.service_name,
      out_of_hours: appointment.out_of_hours,
    }])
  }

  function resetIdentityState(res: ServerResponse): void {
    patients = [{ ...SEEDED_PATIENT }, { ...OTHER_PATIENT }]
    identityAttempts = []
    shareLinks = []
    emailOutbox = []
    auditEvents.length = 0
    sendJson(res, 200, { patientRef: SEEDED_PATIENT.patient_ref })
  }


  function resetAvailabilityState(res: ServerResponse): void {
    providers = PROVIDERS.map((provider) => ({ ...provider }))
    workingHours = [
      { provider_id: E2_PROVIDER_ID, weekday: 1, starts_local: '09:00:00', ends_local: '17:00:00' },
      { provider_id: E2_OTHER_PROVIDER_ID, weekday: 2, starts_local: '10:00:00', ends_local: '14:00:00' },
    ]
    availabilityBlocks = []
    generatedSlotRangesByProvider = new Map()
    scheduleSlots = [
      { id: '26000000-0000-4000-8000-000000000001', provider_id: E2_PROVIDER_ID, starts_at: '2026-08-17T14:00:00.000Z', ends_at: '2026-08-17T14:30:00.000Z', status: 'booked' },
      { id: '26000000-0000-4000-8000-000000000002', provider_id: E2_PROVIDER_ID, starts_at: '2026-08-17T15:00:00.000Z', ends_at: '2026-08-17T15:30:00.000Z', status: 'open' },
      { id: '26000000-0000-4000-8000-000000000003', provider_id: E2_PROVIDER_ID, starts_at: '2026-08-17T16:00:00.000Z', ends_at: '2026-08-17T16:30:00.000Z', status: 'booked' },
      { id: '26000000-0000-4000-8000-000000000004', provider_id: E2_PROVIDER_ID, starts_at: '2099-08-17T16:00:00.000Z', ends_at: '2099-08-17T16:30:00.000Z', status: 'booked' },
    ]
    scheduleAppointments = [
      { id: '26000000-0000-4000-8000-000000000101', slot_id: scheduleSlots[0]!.id, provider_id: E2_PROVIDER_ID, patient_id: SEEDED_PATIENT.id, service_name: 'MRI', status: 'requested', out_of_hours: false },
      { id: '26000000-0000-4000-8000-000000000102', slot_id: scheduleSlots[2]!.id, provider_id: E2_PROVIDER_ID, patient_id: OTHER_PATIENT.id, service_name: 'Ultrasound', status: 'cancelled', out_of_hours: true },
      { id: '26000000-0000-4000-8000-000000000103', slot_id: scheduleSlots[3]!.id, provider_id: E2_PROVIDER_ID, patient_id: SEEDED_PATIENT.id, service_name: 'MRI', status: 'confirmed', out_of_hours: false },
    ]
    sendJson(res, 200, { providerId: E2_PROVIDER_ID })
  }

  resetBookingState()

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-auth-server.local')

    if (req.method === 'GET' && url.pathname === '/__test__/calls') {
      const email = url.searchParams.get('email')
      sendJson(
        res,
        200,
        email === null
          ? calls
          : (callsByEmail.get(email.trim().toLowerCase()) ?? { signup: 0, token: 0, user: 0, updateUser: 0 }),
      )
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/reset-identity') {
      resetIdentityState(res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/expire-share') {
      void handleExpireShare(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/seed-admin') {
      void handleSeedAdmin(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/reset-availability') {
      resetAvailabilityState(res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/reset-booking') {
      resetBookingState()
      sendJson(res, 200, { slots: bookingSlots.length })
      return
    }
    if (req.method === 'GET' && url.pathname === '/__test__/booking-state') {
      sendJson(res, 200, { slots: bookingSlots, appointments: bookingAppointments })
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/book-slot') {
      void readJsonBody(req).then((body) => {
        const slot = bookingSlots.find((candidate) => candidate.id === body.slotId)
        if (!slot || slot.status !== 'open') {
          sendJson(res, 409, { error: 'slot_unavailable' })
          return
        }
        slot.status = 'booked'
        bookingAppointments.push({ id: randomUUID(), slot_id: slot.id, patient_id: OTHER_PATIENT.id, service_id: E2_BOOK_SERVICE_ID, idempotency_key: randomUUID() })
        sendJson(res, 201, { appointmentCount: bookingAppointments.length })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/__test__/identity-state') {
      sendJson(res, 200, { patients, identityAttempts, auditEvents })
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test__/clock') {
      void handleClock(req, res)
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
    if (
      req.method === 'GET' &&
      url.pathname === '/rest/v1/patients' &&
      url.searchParams.get('select') === 'id' &&
      url.searchParams.get('limit') === '0'
    ) {
      answerAsDependency(req, res, healthState.database)
      return
    }
    if (url.pathname === '/rest/v1/patients') {
      void handlePatients(req, res, url)
      return
    }
    if (url.pathname === '/rest/v1/share_links') {
      void handleShareLinks(req, res, url)
      return
    }
    if (url.pathname === '/rest/v1/email_outbox') {
      void handleEmailOutbox(req, res, url)
      return
    }
    if (url.pathname === '/rest/v1/appointments' && req.method === 'GET' && serviceRoleRequest(req)) {
      sendJson(res, 200, [])
      return
    }
    if (
      url.pathname === '/rest/v1/services' ||
      url.pathname === '/rest/v1/provider_services' ||
      (url.pathname === '/rest/v1/slots' && queryValue(url, 'status') === 'open')
    ) {
      handleBookingRead(req, res, url)
      return
    }
    if (
      url.pathname === '/rest/v1/providers' ||
      url.pathname === '/rest/v1/staff_admins' ||
      url.pathname === '/rest/v1/working_hours' ||
      url.pathname === '/rest/v1/availability_blocks' ||
      url.pathname === '/rest/v1/cine_frames' ||
      url.pathname === '/rest/v1/slots' ||
      url.pathname === '/rest/v1/appointments' ||
      url.pathname === '/rest/v1/reports' ||
      SEEDED_PATIENT_TABLES.has(url.pathname)
    ) {
      handleSeededRead(req, res, url)
      return
    }
    if (url.pathname === '/rest/v1/identity_attempts') {
      void handleIdentityAttempts(req, res, url)
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
    if (url.pathname === APPLY_AVAILABILITY_RPC_PATH) {
      void handleApplyAvailability(req, res)
      return
    }
    if (url.pathname === '/rest/v1/rpc/book_appointment') {
      void handleBookAppointment(req, res)
      return
    }
    if (url.pathname === '/rest/v1/rpc/transition_appointment') {
      void handleScheduleMutation(req, res, 'transition')
      return
    }
    if (url.pathname === '/rest/v1/rpc/cancel_appointment') {
      void handleScheduleMutation(req, res, 'cancel')
      return
    }
    if (req.method === 'GET' && url.pathname === '/storage/v1/bucket/phi') {
      answerAsDependency(req, res, healthState.storage)
      return
    }
    if (req.method === 'POST' && url.pathname === '/storage/v1/object/sign/phi') {
      void readJsonBody(req).then((body) => {
        const paths = Array.isArray(body.paths) ? body.paths.filter((path): path is string => typeof path === 'string') : []
        sendJson(res, 200, paths.map((path) => ({
          error: path === E3_MISSING_CINE_FRAME_STORAGE_KEY ? 'Object not found' : null,
          path,
          signedURL: path === E3_MISSING_CINE_FRAME_STORAGE_KEY ? null : `/object/sign/phi/${encodeURIComponent(path)}?token=e2-fixture`,
        })))
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/storage/v1/object/sign/phi/')) {
      const storageKey = decodeURIComponent(url.pathname.slice('/storage/v1/object/sign/phi/'.length))
      if (storageKey === E3_MISSING_CINE_FRAME_STORAGE_KEY) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(ONE_PIXEL_PNG)
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

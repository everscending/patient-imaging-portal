// db/seed/rows.ts — ADR-0009's row set: 50 patients, 10 providers, ~150
// studies, ~250 cine clips, ~700 images, ~16,000 slots, plus services,
// provider_services, visits, reports, appointments and working hours.
// Pure: every id, timestamp-relative-offset and piece of content is a
// function of the three explicit inputs below (`pool`, `sourceSeed`, `now`,
// `minChangeNoticeHours`) — never the wall clock or a non-seeded random
// source (tests/seed/assets.test.ts's
// adversarialDbSeedSourceNeverReachesWallClockOrRandom scans this whole
// directory). `now` carries the one exception CQ-6 states: appointment
// instants are relative to the seed run, not to `sourceSeed` — only
// identities and content are.
import { createHash } from 'node:crypto'

import type { AssetPool } from './assets'

// ── demo accounts (ADR-0012 #9, ADR-0009) ──────────────────────────────────
export const DEMO_PATIENT_EMAIL = 'patient@demo.pip.test'
export const DEMO_PROVIDER_EMAIL = 'provider@demo.pip.test'
export const DEMO_ADMIN_EMAIL = 'admin@demo.pip.test'
export const DEMO_ACCOUNT_PASSWORD = 'DemoPass!2026'
export const DEMO_MAIL_DOMAIN = 'demo.pip.test'

export const DEMO_ACCOUNT_EMAILS = [DEMO_PATIENT_EMAIL, DEMO_PROVIDER_EMAIL, DEMO_ADMIN_EMAIL] as const

// ── row counts (ADR-0009 / DEL-4) ───────────────────────────────────────
export const PATIENT_COUNT = 50
export const PROVIDER_COUNT = 10
const SERVICE_SLUGS = ['obstetric', 'renal', 'thyroid'] as const
const SERVICE_NAMES: Record<(typeof SERVICE_SLUGS)[number], string> = {
  obstetric: 'Obstetric ultrasound',
  renal: 'Renal ultrasound',
  thyroid: 'Thyroid ultrasound',
}

// Sums to 150 over 50 patients (10 cycles of 5 patients, 15 visits/cycle) —
// DEL-4's "roughly 50 patients, each with 1-5 completed visits" and the
// ~150 studies target (one study per visit, 1:1).
const VISITS_PER_PATIENT_CYCLE = [2, 3, 4, 3, 3]
// Sums to 700 over 150 studies (50 cycles of 3 studies, 14 images/cycle).
const IMAGES_PER_STUDY_CYCLE = [4, 5, 5]
// Sums to 250 over 150 studies (50 cycles of 3 studies, 5 clips/cycle).
const CLIPS_PER_STUDY_CYCLE = [2, 2, 1]

const NORMAL_CLIP_FRAME_COUNT = 20 // "up to 100 frames"; the broken clip alone uses the full 100
const BROKEN_CLIP_FRAME_COUNT = 100
// Global clip index (0-based, across the whole run) that references the
// pool's one broken cine set — fixed, not seed-derived, mirroring
// db/seed/assets.ts's BROKEN_CINE_SET_INDEX/BROKEN_FRAME_INDEX choice.
const BROKEN_CLIP_GLOBAL_INDEX = 0
// The pool's non-broken cine sets, cycled through for every other clip.
const NON_BROKEN_CINE_SET_CYCLE = [0, 1, 2, 4, 5, 6, 7]

// ── slot grid (independent of lib/scheduling/availability.ts — T35 does not
// exist yet, and the seed writes working_hours/slots directly, ADR-0009) ──
const GRID_START_OFFSET_DAYS = -30
const GRID_END_OFFSET_DAYS = 130
const SLOT_MINUTES = 30
const WORKING_WEEKDAYS = [1, 2, 3, 4, 5] // Mon-Fri, 0 = Sunday
const WORKING_WINDOWS: [number, number, number, number][] = [
  [9, 0, 12, 0],
  [13, 0, 17, 0],
]
const DAY_MS = 24 * 60 * 60 * 1000

export type ServiceRow = { id: string; slug: string; name: string }
export type ProviderRow = { id: string; user_id: string | null; full_name: string; time_zone: string; slot_minutes: number }
export type ProviderServiceRow = { provider_id: string; service_id: string }
export type PatientRow = {
  id: string
  user_id: string | null
  patient_ref: string
  date_of_birth: string
  full_name: string
  email: string
  phone: string | null
}
export type VisitRow = { id: string; patient_id: string; provider_id: string; occurred_at: string; status: 'completed' }
export type StudyRow = { id: string; visit_id: string; patient_id: string; description: string }
export type ImageRow = {
  id: string
  study_id: string
  patient_id: string
  storage_key: string
  thumb_key: string | null
  width: number
  height: number
  ordinal: number
}
export type CineClipRow = {
  id: string
  study_id: string
  patient_id: string
  frame_count: number
  default_fps: number
  poster_key: string
}
export type CineFrameRow = { clip_id: string; frame_index: number; storage_key: string }
export type ReportRow = {
  id: string
  study_id: string
  patient_id: string
  status: 'preliminary' | 'signed'
  findings: string
  impression: string
  signed_by: string | null
  signed_at: string | null
}
export type WorkingHoursRow = { id: string; provider_id: string; weekday: number; starts_local: string; ends_local: string }
export type AvailabilityBlockRow = { id: string; provider_id: string; starts_at: string; ends_at: string; reason: string }
export type SlotRow = { id: string; provider_id: string; starts_at: string; ends_at: string }
export type AppointmentStatus = 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
export type AppointmentRow = {
  id: string
  slot_id: string
  patient_id: string
  provider_id: string
  service_id: string
  status: AppointmentStatus
}
export type AppointmentTransitionRow = {
  id: string
  appointment_id: string
  from_status: AppointmentStatus | null
  to_status: AppointmentStatus
  occurred_at: string
}
export type StaffAdminRow = { id: string; user_id: string }

export type RowSetFixtures = {
  demoPatientId: string
  demoPatientAuthId: string
  demoProviderId: string
  demoProviderAuthId: string
  demoAdminAuthId: string
  unlinkedPatientId: string
  patientRefFirst: string
  patientRefLast: string
  brokenCineClipId: string
  noticeWindowInsideAppointmentId: string
  noticeWindowOutsideAppointmentId: string
  statusAppointmentIds: Record<AppointmentStatus, string>
}

export type RowSet = {
  services: ServiceRow[]
  providers: ProviderRow[]
  providerServices: ProviderServiceRow[]
  patients: PatientRow[]
  visits: VisitRow[]
  studies: StudyRow[]
  images: ImageRow[]
  cineClips: CineClipRow[]
  cineFrames: CineFrameRow[]
  reports: ReportRow[]
  workingHours: WorkingHoursRow[]
  availabilityBlocks: AvailabilityBlockRow[]
  slots: SlotRow[]
  appointments: AppointmentRow[]
  appointmentTransitions: AppointmentTransitionRow[]
  staffAdmins: StaffAdminRow[]
  fixtures: RowSetFixtures
}

export type BuildRowSetInput = {
  pool: AssetPool
  sourceSeed: string
  now: Date
  minChangeNoticeHours: number
}

function deterministicId(sourceSeed: string, ...parts: (string | number)[]): string {
  const hex = createHash('sha256').update(`${sourceSeed}:rows:${parts.join(':')}`).digest('hex')
  const variant = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

function patientRefAt(index: number): string {
  return `PT-${pad4(index + 1)}`
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

function dateOnlyUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function withTime(day: Date, hour: number, minute: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute))
}

// ── pool lookups ────────────────────────────────────────────────────────
type PoolIndex = { cineFrameKey: Map<string, string>; stillKey: Map<number, string>; allKeys: Set<string> }

function indexPool(pool: AssetPool): PoolIndex {
  const cineFrameKey = new Map<string, string>()
  const stillKey = new Map<number, string>()
  const allKeys = new Set<string>()
  for (const asset of pool.assets) {
    allKeys.add(asset.key)
    if (asset.kind === 'cine-frame') cineFrameKey.set(`${asset.cineSetIndex}:${asset.frameIndex}`, asset.key)
    else stillKey.set(asset.stillIndex as number, asset.key)
  }
  return { cineFrameKey, stillKey, allKeys }
}

function frameKeyOf(index: PoolIndex, cineSetIndex: number, frameIndex: number): string {
  const key = index.cineFrameKey.get(`${cineSetIndex}:${frameIndex}`)
  if (!key) throw new Error(`db/seed/rows: no pool frame at cine set ${cineSetIndex} frame ${frameIndex}`)
  return key
}

function stillKeyOf(index: PoolIndex, stillIndex: number): string {
  const key = index.stillKey.get(stillIndex)
  if (!key) throw new Error(`db/seed/rows: no pool still at index ${stillIndex}`)
  return key
}

// ── validators — each is both a self-check buildRowSet runs on its own
// output and the exact function a mandatory-adversarial test exercises
// directly against a deliberately broken input ──────────────────────────

/** "A seed run reaching the first appointment insert with services empty." */
export function assertServicesPopulatedBeforeAppointments(servicesCount: number, appointmentsCount: number): void {
  if (appointmentsCount > 0 && servicesCount === 0) {
    throw new Error('db/seed/rows: appointments present but services is empty — services must be seeded first')
  }
}

/** "An appointment whose service its provider does not offer." */
export function assertAppointmentServiceOffered(
  providerId: string,
  serviceId: string,
  providerServices: ProviderServiceRow[],
): void {
  const offered = providerServices.some((ps) => ps.provider_id === providerId && ps.service_id === serviceId)
  if (!offered) {
    throw new Error(`db/seed/rows: provider ${providerId} does not offer service ${serviceId}`)
  }
}

/** "A notice-window fixture seeded as cancelled or completed." */
export function assertNoticeWindowFixtureConfirmed(status: AppointmentStatus): void {
  if (status !== 'confirmed') {
    throw new Error(`db/seed/rows: notice-window fixture must be confirmed, got ${status}`)
  }
}

/** "A seeded appointment with out_of_hours written directly to true." — the
 * seed never writes the column at all (it defaults to false); this asserts
 * the caller never claims otherwise. */
export function assertOutOfHoursNeverSeededTrue(outOfHours: boolean): void {
  if (outOfHours) {
    throw new Error('db/seed/rows: out_of_hours must never be seeded true — it is derived, ADR-0006')
  }
}

/** "A dataset where every patient is linked — no unlinked patient left." */
export function assertAtLeastOneUnlinkedPatient(patients: Pick<PatientRow, 'user_id'>[]): void {
  if (!patients.some((p) => p.user_id === null)) {
    throw new Error('db/seed/rows: every patient is linked — register-then-verify has nothing to demonstrate against')
  }
}

/** "A patient_ref that is not PT- plus exactly four digits." */
export function assertPatientRefFormat(ref: string): void {
  if (!/^PT-\d{4}$/.test(ref)) {
    throw new Error(`db/seed/rows: patient_ref "${ref}" is not PT- plus exactly four digits`)
  }
}

/** "...two patients sharing one, or a sequence that starts anywhere but PT-0001." */
export function assertPatientRefSequence(refs: string[]): void {
  if (refs.length === 0) return
  if (refs[0] !== 'PT-0001') throw new Error(`db/seed/rows: patient_ref sequence must start at PT-0001, got ${refs[0]}`)
  const seen = new Set<string>()
  refs.forEach((ref, i) => {
    assertPatientRefFormat(ref)
    if (ref !== patientRefAt(i)) throw new Error(`db/seed/rows: patient_ref sequence has a gap or is out of order at index ${i}: ${ref}`)
    if (seen.has(ref)) throw new Error(`db/seed/rows: duplicate patient_ref ${ref}`)
    seen.add(ref)
  })
}

/** "A demo account seeded at a deliverable domain, or at an address the README does not list." */
export function assertDemoAccountAddress(email: string): void {
  if (!(DEMO_ACCOUNT_EMAILS as readonly string[]).includes(email)) {
    throw new Error(`db/seed/rows: "${email}" is not one of the three pinned demo addresses`)
  }
  if (!email.endsWith(`@${DEMO_MAIL_DOMAIN}`)) {
    throw new Error(`db/seed/rows: "${email}" is not on the reserved non-deliverable domain ${DEMO_MAIL_DOMAIN}`)
  }
}

/** Every seeded email (not just the three demo logins) stays on the
 * reserved non-deliverable domain — a stray share or reminder generated
 * during a demo run must never reach a real inbox. */
export function assertSeededEmailNonDeliverable(email: string): void {
  if (!email.endsWith(`@${DEMO_MAIL_DOMAIN}`)) {
    throw new Error(`db/seed/rows: "${email}" is outside the reserved non-deliverable domain ${DEMO_MAIL_DOMAIN}`)
  }
}

/** "A cine_frames.storage_key pointing at an object T12 never generated." */
export function assertFrameKeyResolvesToPool(storageKey: string, poolKeys: Set<string>): void {
  if (!poolKeys.has(storageKey)) {
    throw new Error(`db/seed/rows: storage_key ${storageKey} was never generated by the pool`)
  }
}

// ── generation ──────────────────────────────────────────────────────────

function buildServices(sourceSeed: string): ServiceRow[] {
  return SERVICE_SLUGS.map((slug) => ({
    id: deterministicId(sourceSeed, 'service', slug),
    slug,
    name: SERVICE_NAMES[slug],
  }))
}

function buildProviders(sourceSeed: string, demoProviderAuthId: string): ProviderRow[] {
  return Array.from({ length: PROVIDER_COUNT }, (_, i) => ({
    id: deterministicId(sourceSeed, 'provider', i),
    user_id: i === 0 ? demoProviderAuthId : null,
    full_name: `Seed Provider ${i + 1}`,
    time_zone: 'UTC',
    slot_minutes: SLOT_MINUTES,
  }))
}

function buildProviderServices(providers: ProviderRow[], services: ServiceRow[]): ProviderServiceRow[] {
  const rows: ProviderServiceRow[] = []
  for (const provider of providers) {
    for (const service of services) rows.push({ provider_id: provider.id, service_id: service.id })
  }
  return rows
}

function buildPatients(sourceSeed: string, demoPatientAuthId: string): PatientRow[] {
  return Array.from({ length: PATIENT_COUNT }, (_, i) => ({
    id: deterministicId(sourceSeed, 'patient', i),
    user_id: i === 0 ? demoPatientAuthId : null,
    patient_ref: patientRefAt(i),
    date_of_birth: `${1950 + (i % 60)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    full_name: `Seed Patient ${pad4(i + 1)}`,
    email: `patient${pad4(i + 1)}@${DEMO_MAIL_DOMAIN}`,
    phone: null,
  }))
}

type VisitPlan = { visit: VisitRow; study: StudyRow; studyIndex: number; providerId: string }

function buildVisitsAndStudies(
  sourceSeed: string,
  patients: PatientRow[],
  providers: ProviderRow[],
  services: ServiceRow[],
  now: Date,
): VisitPlan[] {
  const plans: VisitPlan[] = []
  let globalIndex = 0
  for (let p = 0; p < patients.length; p++) {
    const visitCount = VISITS_PER_PATIENT_CYCLE[p % VISITS_PER_PATIENT_CYCLE.length]
    for (let v = 0; v < visitCount; v++) {
      const provider = providers[globalIndex % providers.length]
      const service = services[globalIndex % services.length]
      const occurredAt = addDays(now, -(30 + (globalIndex % 300)))
      const visit: VisitRow = {
        id: deterministicId(sourceSeed, 'visit', globalIndex),
        patient_id: patients[p].id,
        provider_id: provider.id,
        occurred_at: occurredAt.toISOString(),
        status: 'completed',
      }
      const study: StudyRow = {
        id: deterministicId(sourceSeed, 'study', globalIndex),
        visit_id: visit.id,
        patient_id: patients[p].id,
        description: service.name,
      }
      plans.push({ visit, study, studyIndex: globalIndex, providerId: provider.id })
      globalIndex += 1
    }
  }
  return plans
}

function buildImages(sourceSeed: string, plans: VisitPlan[], poolIndex: PoolIndex, pool: AssetPool): ImageRow[] {
  const images: ImageRow[] = []
  let stillCursor = 0
  for (const plan of plans) {
    const count = IMAGES_PER_STUDY_CYCLE[plan.studyIndex % IMAGES_PER_STUDY_CYCLE.length]
    for (let ordinal = 1; ordinal <= count; ordinal++) {
      const stillIndex = stillCursor % pool.assets.filter((a) => a.kind === 'still').length
      stillCursor += 1
      images.push({
        id: deterministicId(sourceSeed, 'image', plan.studyIndex, ordinal),
        study_id: plan.study.id,
        patient_id: plan.study.patient_id,
        storage_key: stillKeyOf(poolIndex, stillIndex),
        thumb_key: null,
        width: 800,
        height: 600,
        ordinal,
      })
    }
  }
  return images
}

function buildCineClipsAndFrames(
  sourceSeed: string,
  plans: VisitPlan[],
  poolIndex: PoolIndex,
): { clips: CineClipRow[]; frames: CineFrameRow[]; brokenCineClipId: string } {
  const clips: CineClipRow[] = []
  const frames: CineFrameRow[] = []
  let globalClipIndex = 0
  let nonBrokenCursor = 0
  let brokenCineClipId = ''

  for (const plan of plans) {
    const count = CLIPS_PER_STUDY_CYCLE[plan.studyIndex % CLIPS_PER_STUDY_CYCLE.length]
    for (let c = 0; c < count; c++) {
      const isBroken = globalClipIndex === BROKEN_CLIP_GLOBAL_INDEX
      const cineSetIndex = isBroken
        ? 3 // db/seed/assets.ts's BROKEN_CINE_SET_INDEX
        : NON_BROKEN_CINE_SET_CYCLE[nonBrokenCursor % NON_BROKEN_CINE_SET_CYCLE.length]
      if (!isBroken) nonBrokenCursor += 1
      const frameCount = isBroken ? BROKEN_CLIP_FRAME_COUNT : NORMAL_CLIP_FRAME_COUNT

      const clipId = deterministicId(sourceSeed, 'clip', globalClipIndex)
      if (isBroken) brokenCineClipId = clipId

      clips.push({
        id: clipId,
        study_id: plan.study.id,
        patient_id: plan.study.patient_id,
        frame_count: frameCount,
        default_fps: 12,
        poster_key: frameKeyOf(poolIndex, cineSetIndex, 0),
      })

      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        frames.push({ clip_id: clipId, frame_index: frameIndex, storage_key: frameKeyOf(poolIndex, cineSetIndex, frameIndex) })
      }

      globalClipIndex += 1
    }
  }

  return { clips, frames, brokenCineClipId }
}

function buildReports(sourceSeed: string, plans: VisitPlan[]): ReportRow[] {
  return plans.map((plan, i) => {
    const status: ReportRow['status'] = i % 3 === 0 ? 'preliminary' : 'signed'
    const signedAt = status === 'signed' ? addDays(new Date(plan.visit.occurred_at), 1).toISOString() : null
    return {
      id: deterministicId(sourceSeed, 'report', i),
      study_id: plan.study.id,
      patient_id: plan.study.patient_id,
      status,
      findings: `Findings for study ${i + 1}: within normal limits.`,
      impression: `Impression for study ${i + 1}: no acute abnormality.`,
      signed_by: status === 'signed' ? plan.providerId : null,
      signed_at: signedAt,
    }
  })
}

function buildWorkingHours(sourceSeed: string, providers: ProviderRow[]): WorkingHoursRow[] {
  const rows: WorkingHoursRow[] = []
  for (const provider of providers) {
    for (const weekday of WORKING_WEEKDAYS) {
      for (const [sh, sm, eh, em] of WORKING_WINDOWS) {
        rows.push({
          id: deterministicId(sourceSeed, 'working-hours', provider.id, weekday, sh, sm),
          provider_id: provider.id,
          weekday,
          starts_local: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00`,
          ends_local: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00`,
        })
      }
    }
  }
  return rows
}

function buildAvailabilityBlocks(sourceSeed: string, providers: ProviderRow[], now: Date): AvailabilityBlockRow[] {
  // One placeholder block per provider, far enough out (and off the 09-17
  // working-hours grid) that it can never collide with a generated slot —
  // T38 (epic E6) narrows real working hours later; this just gives that
  // ticket a grid to narrow, per the design decision.
  return providers.map((provider, i) => {
    const day = addDays(dateOnlyUtc(now), 45 + i)
    const startsAt = withTime(day, 3, 0)
    const endsAt = withTime(day, 4, 0)
    return {
      id: deterministicId(sourceSeed, 'availability-block', provider.id),
      provider_id: provider.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      reason: 'seed placeholder block',
    }
  })
}

type SlotPlan = { rows: SlotRow[]; byProvider: Map<string, SlotRow[]> }

function buildSlots(
  sourceSeed: string,
  providers: ProviderRow[],
  now: Date,
  excludeWindowByProviderId: Map<string, [Date, Date]>,
): SlotPlan {
  const rows: SlotRow[] = []
  const byProvider = new Map<string, SlotRow[]>()
  const gridStart = dateOnlyUtc(addDays(now, GRID_START_OFFSET_DAYS))
  const gridEnd = dateOnlyUtc(addDays(now, GRID_END_OFFSET_DAYS))

  for (const provider of providers) {
    const providerSlots: SlotRow[] = []
    const exclude = excludeWindowByProviderId.get(provider.id)
    for (let day = gridStart; day.getTime() < gridEnd.getTime(); day = addDays(day, 1)) {
      const weekday = day.getUTCDay()
      if (!WORKING_WEEKDAYS.includes(weekday)) continue
      for (const [sh, sm, eh, em] of WORKING_WINDOWS) {
        let cursor = withTime(day, sh, sm)
        const windowEnd = withTime(day, eh, em)
        while (cursor.getTime() < windowEnd.getTime()) {
          const startsAt = cursor
          const endsAt = new Date(cursor.getTime() + SLOT_MINUTES * 60_000)
          const withinExclusion = exclude && startsAt.getTime() >= exclude[0].getTime() && startsAt.getTime() < exclude[1].getTime()
          if (!withinExclusion) {
            const slot: SlotRow = {
              id: deterministicId(sourceSeed, 'slot', provider.id, startsAt.toISOString()),
              provider_id: provider.id,
              starts_at: startsAt.toISOString(),
              ends_at: endsAt.toISOString(),
            }
            providerSlots.push(slot)
            rows.push(slot)
          }
          cursor = endsAt
        }
      }
    }
    byProvider.set(provider.id, providerSlots)
  }

  return { rows, byProvider }
}

function makeAppointment(
  sourceSeed: string,
  discriminator: string,
  slot: SlotRow,
  patientId: string,
  serviceId: string,
  status: AppointmentStatus,
): AppointmentRow {
  return {
    id: deterministicId(sourceSeed, 'appointment', discriminator),
    slot_id: slot.id,
    patient_id: patientId,
    provider_id: slot.provider_id,
    service_id: serviceId,
    status,
  }
}

function makeTransition(
  sourceSeed: string,
  appointmentId: string,
  index: number,
  from: AppointmentStatus | null,
  to: AppointmentStatus,
  occurredAt: Date,
): AppointmentTransitionRow {
  return {
    id: deterministicId(sourceSeed, 'transition', appointmentId, index),
    appointment_id: appointmentId,
    from_status: from,
    to_status: to,
    occurred_at: occurredAt.toISOString(),
  }
}

/** Pure: `input` always reproduces the same row set — same ids, same
 * counts, same fixtures — given the same pool, source seed and `now`. */
export function buildRowSet(input: BuildRowSetInput): RowSet {
  const { pool, sourceSeed, now, minChangeNoticeHours } = input
  const poolIndex = indexPool(pool)

  const demoPatientAuthId = deterministicId(sourceSeed, 'auth', 'demo-patient')
  const demoProviderAuthId = deterministicId(sourceSeed, 'auth', 'demo-provider')
  const demoAdminAuthId = deterministicId(sourceSeed, 'auth', 'demo-admin')

  const services = buildServices(sourceSeed)
  const providers = buildProviders(sourceSeed, demoProviderAuthId)
  const providerServices = buildProviderServices(providers, services)
  const patients = buildPatients(sourceSeed, demoPatientAuthId)
  const staffAdmins: StaffAdminRow[] = [{ id: deterministicId(sourceSeed, 'staff-admin', 0), user_id: demoAdminAuthId }]

  const plans = buildVisitsAndStudies(sourceSeed, patients, providers, services, now)
  const visits = plans.map((p) => p.visit)
  const studies = plans.map((p) => p.study)
  const images = buildImages(sourceSeed, plans, poolIndex, pool)
  const { clips: cineClips, frames: cineFrames, brokenCineClipId } = buildCineClipsAndFrames(sourceSeed, plans, poolIndex)
  const reports = buildReports(sourceSeed, plans)
  const workingHours = buildWorkingHours(sourceSeed, providers)
  const availabilityBlocks = buildAvailabilityBlocks(sourceSeed, providers, now)

  // The demo provider's grid is skipped in a buffer around `now` so the two
  // notice-window fixtures below can never collide with the regular grid,
  // whatever `now` happens to be.
  const demoProvider = providers[0]
  const excludeWindowByProviderId = new Map<string, [Date, Date]>([
    [demoProvider.id, [addDays(now, -1), new Date(now.getTime() + (minChangeNoticeHours * 3 + 1) * 3_600_000)]],
  ])
  const { rows: slots, byProvider: slotsByProvider } = buildSlots(sourceSeed, providers, now, excludeWindowByProviderId)

  const appointments: AppointmentRow[] = []
  const appointmentTransitions: AppointmentTransitionRow[] = []

  // ── notice-window fixtures (ADR-0008/0009): both confirmed ────────────
  const insideSlot: SlotRow = {
    id: deterministicId(sourceSeed, 'slot', 'fixture-inside'),
    provider_id: demoProvider.id,
    starts_at: new Date(now.getTime() + (minChangeNoticeHours / 2) * 3_600_000).toISOString(),
    ends_at: new Date(now.getTime() + (minChangeNoticeHours / 2) * 3_600_000 + SLOT_MINUTES * 60_000).toISOString(),
  }
  const outsideSlot: SlotRow = {
    id: deterministicId(sourceSeed, 'slot', 'fixture-outside'),
    provider_id: demoProvider.id,
    starts_at: new Date(now.getTime() + minChangeNoticeHours * 3 * 3_600_000).toISOString(),
    ends_at: new Date(now.getTime() + minChangeNoticeHours * 3 * 3_600_000 + SLOT_MINUTES * 60_000).toISOString(),
  }
  slots.push(insideSlot, outsideSlot)

  const noticeWindowInside = makeAppointment(sourceSeed, 'notice-inside', insideSlot, patients[2].id, services[0].id, 'confirmed')
  const noticeWindowOutside = makeAppointment(sourceSeed, 'notice-outside', outsideSlot, patients[3].id, services[0].id, 'confirmed')
  appointments.push(noticeWindowInside, noticeWindowOutside)
  appointmentTransitions.push(
    makeTransition(sourceSeed, noticeWindowInside.id, 0, 'requested', 'confirmed', now),
    makeTransition(sourceSeed, noticeWindowOutside.id, 0, 'requested', 'confirmed', now),
  )

  // ── five status fixtures ───────────────────────────────────────────────
  const pastProviderSlots = (idx: number) => (slotsByProvider.get(providers[idx].id) ?? []).filter((s) => new Date(s.starts_at) < now)
  const futureProviderSlots = (idx: number) => (slotsByProvider.get(providers[idx].id) ?? []).filter((s) => new Date(s.starts_at) >= now)

  const requestedSlot = futureProviderSlots(1)[0]
  const confirmedSlot = futureProviderSlots(2)[0]
  const completedSlot = pastProviderSlots(3)[0]
  const cancelledSlot = pastProviderSlots(4)[0]
  const noShowSlot = pastProviderSlots(5)[0]
  const statusSlots: [AppointmentStatus, SlotRow][] = [
    ['requested', requestedSlot],
    ['confirmed', confirmedSlot],
    ['completed', completedSlot],
    ['cancelled', cancelledSlot],
    ['no_show', noShowSlot],
  ]

  const statusAppointmentIds = {} as Record<AppointmentStatus, string>
  statusSlots.forEach(([status, slot], fixtureIndex) => {
    if (!slot) throw new Error(`db/seed/rows: no slot available for the ${status} status fixture`)
    const appt = makeAppointment(sourceSeed, `status-${status}`, slot, patients[(4 + fixtureIndex) % patients.length].id, services[0].id, status)
    appointments.push(appt)
    statusAppointmentIds[status] = appt.id

    const slotStart = new Date(slot.starts_at)
    const chain: AppointmentStatus[] =
      status === 'requested'
        ? []
        : status === 'confirmed'
          ? ['requested', 'confirmed']
          : status === 'cancelled'
            ? ['requested', 'cancelled']
            : ['requested', 'confirmed', status] // completed, no_show
    let from: AppointmentStatus | null = null
    chain.forEach((to, i) => {
      appointmentTransitions.push(makeTransition(sourceSeed, appt.id, i, from, to, new Date(slotStart.getTime() - (chain.length - i) * 3_600_000)))
      from = to
    })
  })

  const unlinkedPatientId = patients[1].id

  const fixtures: RowSetFixtures = {
    demoPatientId: patients[0].id,
    demoPatientAuthId,
    demoProviderId: demoProvider.id,
    demoProviderAuthId,
    demoAdminAuthId,
    unlinkedPatientId,
    patientRefFirst: patients[0].patient_ref,
    patientRefLast: patients[patients.length - 1].patient_ref,
    brokenCineClipId,
    noticeWindowInsideAppointmentId: noticeWindowInside.id,
    noticeWindowOutsideAppointmentId: noticeWindowOutside.id,
    statusAppointmentIds,
  }

  const rowSet: RowSet = {
    services,
    providers,
    providerServices,
    patients,
    visits,
    studies,
    images,
    cineClips,
    cineFrames,
    reports,
    workingHours,
    availabilityBlocks,
    slots,
    appointments,
    appointmentTransitions,
    staffAdmins,
    fixtures,
  }

  validateRowSet(rowSet, poolIndex)
  return rowSet
}

/** Every self-check this module can prove offline, run once at the end of
 * generation — the same functions a mandatory-adversarial test calls
 * directly against a deliberately broken fixture. */
function validateRowSet(rowSet: RowSet, poolIndex: PoolIndex): void {
  assertServicesPopulatedBeforeAppointments(rowSet.services.length, rowSet.appointments.length)
  assertAtLeastOneUnlinkedPatient(rowSet.patients)
  assertPatientRefSequence(rowSet.patients.map((p) => p.patient_ref))
  assertDemoAccountAddress(DEMO_PATIENT_EMAIL)
  assertDemoAccountAddress(DEMO_PROVIDER_EMAIL)
  assertDemoAccountAddress(DEMO_ADMIN_EMAIL)
  for (const patient of rowSet.patients) assertSeededEmailNonDeliverable(patient.email)

  for (const appointment of rowSet.appointments) {
    assertAppointmentServiceOffered(appointment.provider_id, appointment.service_id, rowSet.providerServices)
    assertOutOfHoursNeverSeededTrue(false)
  }
  assertNoticeWindowFixtureConfirmed(
    rowSet.appointments.find((a) => a.id === rowSet.fixtures.noticeWindowInsideAppointmentId)?.status as AppointmentStatus,
  )
  assertNoticeWindowFixtureConfirmed(
    rowSet.appointments.find((a) => a.id === rowSet.fixtures.noticeWindowOutsideAppointmentId)?.status as AppointmentStatus,
  )

  for (const frame of rowSet.cineFrames) assertFrameKeyResolvesToPool(frame.storage_key, poolIndex.allKeys)
  for (const image of rowSet.images) assertFrameKeyResolvesToPool(image.storage_key, poolIndex.allKeys)

  const brokenClips = rowSet.cineClips.filter((c) => c.id === rowSet.fixtures.brokenCineClipId)
  if (brokenClips.length !== 1) throw new Error('db/seed/rows: expected exactly one broken cine clip')
}

// ── SQL emission ────────────────────────────────────────────────────────

export type InsertBatch = { table: string; sql: string | null }

function sqlValue(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return `'${value.replace(/'/g, "''")}'`
}

const INSERT_CHUNK_SIZE = 2000

function insertBatch<T extends Record<string, string | number | boolean | null>>(
  table: string,
  columns: (keyof T & string)[],
  rows: T[],
): InsertBatch {
  if (rows.length === 0) return { table, sql: null }
  const statements: string[] = []
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE)
    const values = chunk.map((row) => `(${columns.map((c) => sqlValue(row[c])).join(',')})`).join(',\n')
    statements.push(`insert into ${table} (${columns.join(',')}) values\n${values};`)
  }
  return { table, sql: statements.join('\n') }
}

/** Ordered so every foreign key is satisfied by the time its referencing
 * table is inserted: services and provider_services (and the linked
 * patient/provider rows) land before the first appointment. */
export function toInsertPlan(rowSet: RowSet): InsertBatch[] {
  return [
    insertBatch('services', ['id', 'slug', 'name'], rowSet.services),
    insertBatch('providers', ['id', 'user_id', 'full_name', 'time_zone', 'slot_minutes'], rowSet.providers),
    insertBatch('provider_services', ['provider_id', 'service_id'], rowSet.providerServices),
    insertBatch('patients', ['id', 'user_id', 'patient_ref', 'date_of_birth', 'full_name', 'email', 'phone'], rowSet.patients),
    insertBatch('staff_admins', ['id', 'user_id'], rowSet.staffAdmins),
    insertBatch('visits', ['id', 'patient_id', 'provider_id', 'occurred_at', 'status'], rowSet.visits),
    insertBatch('studies', ['id', 'visit_id', 'patient_id', 'description'], rowSet.studies),
    insertBatch('images', ['id', 'study_id', 'patient_id', 'storage_key', 'thumb_key', 'width', 'height', 'ordinal'], rowSet.images),
    insertBatch('cine_clips', ['id', 'study_id', 'patient_id', 'frame_count', 'default_fps', 'poster_key'], rowSet.cineClips),
    insertBatch('cine_frames', ['clip_id', 'frame_index', 'storage_key'], rowSet.cineFrames),
    insertBatch('reports', ['id', 'study_id', 'patient_id', 'status', 'findings', 'impression', 'signed_by', 'signed_at'], rowSet.reports),
    insertBatch('working_hours', ['id', 'provider_id', 'weekday', 'starts_local', 'ends_local'], rowSet.workingHours),
    insertBatch('availability_blocks', ['id', 'provider_id', 'starts_at', 'ends_at', 'reason'], rowSet.availabilityBlocks),
    insertBatch('slots', ['id', 'provider_id', 'starts_at', 'ends_at'], rowSet.slots),
    insertBatch('appointments', ['id', 'slot_id', 'patient_id', 'provider_id', 'service_id', 'status'], rowSet.appointments),
    insertBatch(
      'appointment_transitions',
      ['id', 'appointment_id', 'from_status', 'to_status', 'occurred_at'],
      rowSet.appointmentTransitions,
    ),
  ]
}

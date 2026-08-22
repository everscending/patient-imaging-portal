// lib/scheduling/availability.ts — working hours, blocks, slot generation
// (ARCHITECTURE.md §2). All zone-aware date arithmetic routes through
// lib/time/zones.ts (§2 module map) — this file only does zone-agnostic
// calendar-date bookkeeping (eachDate, addDaysToDate) and wall-clock
// second-of-day comparisons.

import { config } from '../config'
import * as zones from '../time/zones'

export type WorkingHour = { weekday: number; startsLocal: string; endsLocal: string }
export type Block = { startsAt: string; endsAt: string; reason?: string | null }

// Mirrors ARCHITECTURE.md §3's schema CHECK constraints verbatim — these are
// the schema's own literals, not a slot-horizon-shaped config value, and
// generateSlots must enforce them itself since it is pure and has no
// database CHECK to fall back on (design decision: "this is enforced in
// lib/scheduling/availability.ts, not the schema").
const MIN_SLOT_MINUTES = 5
const MAX_SLOT_MINUTES = 240
const MIN_WEEKDAY = 0
const MAX_WEEKDAY = 6

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

function assertValidDate(label: string, value: string): void {
  if (!DATE_RE.test(value)) throw new Error(`${label} is not a calendar date (YYYY-MM-DD): ${value}`)
}

function timeToSeconds(label: string, value: string): number {
  if (!TIME_RE.test(value)) throw new Error(`${label} is not a wall-clock time (HH:MM[:SS]): ${value}`)
  const [h, m, s] = value.split(':').map(Number)
  return h * 3600 + m * 60 + (s || 0)
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function dateToUtcMs(date: string): number {
  const [y, mo, da] = date.split('-').map(Number)
  return Date.UTC(y, mo - 1, da)
}

function addDaysToDate(date: string, days: number): string {
  return formatDate(dateToUtcMs(date) + days * 86_400_000)
}

// Calendar-date iteration only — never resolves a zone, so it belongs
// outside lib/time/zones.ts.
function eachDate(fromDate: string, toDate: string): string[] {
  const startMs = dateToUtcMs(fromDate)
  const endMs = dateToUtcMs(toDate)
  const dates: string[] = []
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) dates.push(formatDate(ms))
  return dates
}

// 0 = Sunday, matching ARCHITECTURE.md §3's working_hours.weekday and
// Postgres's extract(dow from date) — a plain calendar computation, not a
// zone conversion, so this stays out of lib/time/zones.ts too.
function localWeekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/**
 * Instant-walk generation (§11). Rejects a slotMinutes that does not divide the
 * provider zone's DST shift. The filter binds the slot's end, not its start.
 */
export function generateSlots(input: {
  timeZone: string
  slotMinutes: number
  workingHours: WorkingHour[]
  blocks: Block[]
  fromDate: string // local calendar date, inclusive
  toDate: string // local calendar date, inclusive
}): Array<{ startsAt: string; endsAt: string }> {
  // Rejected before any walk begins (design decision) — 'America/Chicagoo'
  // would otherwise fail deep inside the loop below.
  zones.assertKnownTimeZone(input.timeZone)

  if (input.slotMinutes < MIN_SLOT_MINUTES || input.slotMinutes > MAX_SLOT_MINUTES) {
    throw new Error(`slotMinutes must be between ${MIN_SLOT_MINUTES} and ${MAX_SLOT_MINUTES}: ${input.slotMinutes}`)
  }

  assertValidDate('fromDate', input.fromDate)
  assertValidDate('toDate', input.toDate)
  if (input.fromDate > input.toDate) {
    throw new Error(`fromDate must not be later than toDate: ${input.fromDate} > ${input.toDate}`)
  }

  const windows = input.workingHours.map((window) => {
    if (window.weekday < MIN_WEEKDAY || window.weekday > MAX_WEEKDAY) {
      throw new Error(`weekday must be between ${MIN_WEEKDAY} and ${MAX_WEEKDAY}: ${window.weekday}`)
    }
    const startsSeconds = timeToSeconds('startsLocal', window.startsLocal)
    const endsSeconds = timeToSeconds('endsLocal', window.endsLocal)
    if (endsSeconds <= startsSeconds) {
      throw new Error(`endsLocal must be later than startsLocal: ${window.startsLocal} >= ${window.endsLocal}`)
    }
    return { ...window, startsSeconds, endsSeconds }
  })

  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i]!
      const b = windows[j]!
      if (a.weekday === b.weekday && a.startsSeconds < b.endsSeconds && b.startsSeconds < a.endsSeconds) {
        throw new Error(`working-hours windows overlap on weekday ${a.weekday}`)
      }
    }
  }

  // Rejected before any walk begins, the same as every other input — an
  // unparseable or backwards block would otherwise silently remove nothing
  // (FR-10: blocked time must never come back as bookable).
  const blockRanges = input.blocks.map((block) => {
    const start = new Date(block.startsAt).getTime()
    const end = new Date(block.endsAt).getTime()
    if (Number.isNaN(start)) throw new Error(`block startsAt is not a parseable timestamp: ${block.startsAt}`)
    if (Number.isNaN(end)) throw new Error(`block endsAt is not a parseable timestamp: ${block.endsAt}`)
    if (end <= start) throw new Error(`block endsAt must be later than startsAt: ${block.startsAt} >= ${block.endsAt}`)
    return { start, end }
  })

  // §11: slot_minutes must divide the provider zone's DST shift. A
  // no-shift zone (dstShiftMinutes === 0) passes for any slotMinutes the
  // schema permits, since 0 % n is always 0 — there is nothing to divide.
  const shiftMinutes = zones.dstShiftMinutes(input.timeZone, input.fromDate)
  if (shiftMinutes % input.slotMinutes !== 0) {
    throw new Error(
      `slotMinutes (${input.slotMinutes}) does not divide ${input.timeZone}'s DST shift (${shiftMinutes} minutes)`,
    )
  }

  const slotDurationMs = input.slotMinutes * 60_000
  const candidates: Array<{ startInstant: Date; endInstant: Date }> = []

  for (const date of eachDate(input.fromDate, input.toDate)) {
    const weekday = localWeekday(date)
    for (const window of windows) {
      if (window.weekday !== weekday) continue

      // Re-anchors to startsLocal on this local date instead of stepping
      // through from a prior day's base — the rule that keeps a
      // transition day's first slot at its declared opening time, and
      // keeps neighbouring days out without needing generate_series's
      // ±1 day padding (§11).
      const anchor = zones.zonedTimeToInstant(input.timeZone, date, window.startsLocal)
      if (zones.toLocal(input.timeZone, anchor).date !== date) continue

      let current = anchor
      for (;;) {
        const local = zones.toLocal(input.timeZone, current)
        if (local.date !== date) break

        const startSeconds = timeToSeconds('local.time', local.time)
        // Naive wall-clock addition, matching §11's pinned SQL
        // (`(gs at time zone tz)::time + interval`) — the slot's end is
        // never re-derived from the zone at the end instant.
        const endSeconds = startSeconds + input.slotMinutes * 60
        const endInstant = new Date(current.getTime() + slotDurationMs)

        if (startSeconds >= window.startsSeconds && endSeconds <= window.endsSeconds) {
          candidates.push({ startInstant: current, endInstant })
        }

        current = new Date(current.getTime() + slotDurationMs)
      }
    }
  }

  const kept = candidates.filter(({ startInstant, endInstant }) => {
    const startMs = startInstant.getTime()
    const endMs = endInstant.getTime()
    return !blockRanges.some((block) => startMs < block.end && endMs > block.start)
  })

  kept.sort((a, b) => a.startInstant.getTime() - b.startInstant.getTime())

  return kept.map(({ startInstant, endInstant }) => ({
    startsAt: zones.toRfc3339(input.timeZone, startInstant),
    endsAt: zones.toRfc3339(input.timeZone, endInstant),
  }))
}

/**
 * today + config.slotHorizonDays (ADR-0012) — every availability write
 * regenerates today through this date, resolved from config rather than a
 * literal. Takes today as an explicit local date instead of reading a
 * clock, keeping this pure like generateSlots; T36's applyAvailability
 * supplies the real current date.
 */
export function defaultHorizon(today: string): { fromDate: string; toDate: string } {
  assertValidDate('today', today)
  return { fromDate: today, toDate: addDaysToDate(today, config.slotHorizonDays) }
}

export class AvailabilityValidationError extends Error {
  constructor(message = 'availability input is invalid') {
    super(message)
    this.name = 'AvailabilityValidationError'
  }
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** Translates generateSlots' developer-facing messages into caller-safe
 * prose. These name weekdays and durations only — never patient data. */
function validationMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : ''
  const overlap = /working-hours windows overlap on weekday (\d)/.exec(raw)
  if (overlap) return `${WEEKDAY_NAMES[Number(overlap[1])]}'s working-hours windows overlap.`
  if (raw.includes('endsLocal must be later')) return 'A working-hours window must end after it starts.'
  if (raw.includes('block endsAt must be later')) return 'A time-off block must end after it starts.'
  if (raw.includes('not a parseable timestamp')) return 'A time-off block has an invalid date or time.'
  const dst = /slotMinutes \((\d+)\) does not divide (.+)'s DST shift \((\d+) minutes\)/.exec(raw)
  if (dst) return `A ${dst[1]}-minute slot length does not fit ${dst[2]}'s daylight-saving change. Choose a length that divides ${dst[3]} minutes.`
  if (raw.includes('slotMinutes must be between')) return 'Slot length must be between 5 and 240 minutes.'
  return 'The request could not be validated.'
}

type AvailabilityRow = { time_zone: string; slot_minutes: number }
type WorkingHourRow = { weekday: number; starts_local: string; ends_local: string }
type BlockRow = { id: string; starts_at: string; ends_at: string; reason: string | null }

async function callerClient() {
  const [{ cookies }, { anonClient }, { SESSION_COOKIE_NAME }] = await Promise.all([
    import('next/headers'),
    import('../db/client'),
    import('../session-cookie'),
  ])
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!token) throw new Error('availability: authenticated session is unavailable')
  return anonClient(token)
}

export async function getAvailability(providerId: string): Promise<{
  timeZone: string
  slotMinutes: number
  workingHours: WorkingHour[]
  blocks: Array<{ id: string; startsAt: string; endsAt: string; reason: string | null }>
}> {
  const client = await callerClient()
  const [providerResult, hoursResult, blocksResult] = await Promise.all([
    client.from('providers').select('time_zone, slot_minutes').eq('id', providerId).maybeSingle(),
    client.from('working_hours').select('weekday, starts_local, ends_local').eq('provider_id', providerId).order('weekday').order('starts_local'),
    client.from('availability_blocks').select('id, starts_at, ends_at, reason').eq('provider_id', providerId).order('starts_at'),
  ])
  if (providerResult.error || hoursResult.error || blocksResult.error || !providerResult.data) {
    throw new Error('availability: failed to read provider availability')
  }
  const provider = providerResult.data as AvailabilityRow
  return {
    timeZone: provider.time_zone,
    slotMinutes: provider.slot_minutes,
    workingHours: ((hoursResult.data ?? []) as WorkingHourRow[]).map((row) => ({
      weekday: row.weekday,
      startsLocal: row.starts_local.slice(0, 5),
      endsLocal: row.ends_local.slice(0, 5),
    })),
    blocks: ((blocksResult.data ?? []) as BlockRow[]).map((row) => ({
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      reason: row.reason,
    })),
  }
}

/**
 * Accept-and-flag (ADR-0006). Removes only genuinely free time, regenerates,
 * recomputes out_of_hours on every live appointment, never rejects the edit.
 */
export async function applyAvailability(input: {
  providerId: string
  actorUserId: string
  slotMinutes: number
  workingHours: WorkingHour[]
  blocks: Block[]
}): Promise<{
  removedOpenSlots: number
  generatedOpenSlots: number
  preservedOutOfHours: Array<{
    appointmentId: string
    startsAt: string
    endsAt: string
    patientRef: string
  }>
}> {
  const client = await callerClient()
  const { data: providerData, error: providerError } = await client
    .from('providers')
    .select('time_zone')
    .eq('id', input.providerId)
    .maybeSingle()
  if (providerError || !providerData) throw new Error('availability: provider could not be read')

  const timeZone = (providerData as { time_zone: string }).time_zone
  const today = zones.toLocal(timeZone, new Date()).date
  const horizon = defaultHorizon(today)
  let slots: Array<{ startsAt: string; endsAt: string }>
  try {
    slots = generateSlots({
      timeZone,
      slotMinutes: input.slotMinutes,
      workingHours: input.workingHours,
      blocks: input.blocks,
      ...horizon,
    })
  } catch (cause) {
    throw new AvailabilityValidationError(validationMessage(cause))
  }

  const from = zones.zonedTimeToInstant(timeZone, horizon.fromDate, '00:00:00').toISOString()
  const afterHorizon = addDaysToDate(horizon.toDate, 1)
  const to = zones.zonedTimeToInstant(timeZone, afterHorizon, '00:00:00').toISOString()
  const slotRanges = slots.map((slot) => `[${slot.startsAt},${slot.endsAt})`)

  const { data, error } = await client.rpc('apply_provider_availability', {
    p_provider_id: input.providerId,
    p_actor_user_id: input.actorUserId,
    p_slot_minutes: input.slotMinutes,
    p_working_hours: input.workingHours,
    p_blocks: input.blocks,
    p_from: from,
    p_to: to,
    p_slots: slotRanges,
  })
  if (error) throw new Error('availability: transactional write failed')

  const raw = (Array.isArray(data) ? data[0] : data) as
    | { removed_open_slots: number; generated_open_slots: number; preserved_out_of_hours: unknown }
    | null
  if (!raw) throw new Error('availability: transactional write returned no result')
  const preserved = raw.preserved_out_of_hours as Array<{
    appointmentId: string
    startsAt: string
    endsAt: string
    patientRef: string
  }>

  return {
    removedOpenSlots: raw.removed_open_slots,
    generatedOpenSlots: raw.generated_open_slots,
    preservedOutOfHours: preserved,
  }
}

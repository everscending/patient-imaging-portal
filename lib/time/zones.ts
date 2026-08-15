// lib/time/zones.ts — instant ↔ zone conversion (ARCHITECTURE.md §2, §11).
// The only module doing zone-aware date arithmetic; lib/scheduling/availability.ts
// calls it rather than touching Intl/Date zone math itself.

export class UnknownTimeZoneError extends Error {
  constructor(zone: string) {
    super(`unknown time zone: ${zone}`)
    this.name = 'UnknownTimeZoneError'
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function offsetFormatter(zone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(zone)
  if (cached) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    // pg_timezone_names rejects the same names this constructor does
    // (ARCHITECTURE.md §3's providers_validate_time_zone trigger) — never
    // cached, so a caller cannot poison the cache with a bad name.
    throw new UnknownTimeZoneError(zone)
  }
  formatterCache.set(zone, formatter)
  return formatter
}

/** Rejects an unknown IANA zone before any caller starts walking instants. */
export function assertKnownTimeZone(zone: string): void {
  offsetFormatter(zone)
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

function localPartsAt(zone: string, instant: Date): LocalParts {
  const parts = offsetFormatter(zone).formatToParts(instant)
  const map: Record<string, string> = {}
  for (const part of parts) map[part.type] = part.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // h23 still reports midnight as "24" in some ICU builds; normalize.
    hour: Number(map.hour) === 24 ? 0 : Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** The zone's UTC offset, in minutes, at the given instant. */
export function offsetMinutesAt(zone: string, instant: Date): number {
  const local = localPartsAt(zone, instant)
  const asUtcMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
  return Math.round((asUtcMs - instant.getTime()) / 60_000)
}

/** The instant's local calendar date and wall-clock time in the zone. */
export function toLocal(zone: string, instant: Date): { date: string; time: string } {
  const local = localPartsAt(zone, instant)
  return {
    date: `${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}`,
    time: `${pad(local.hour, 2)}:${pad(local.minute, 2)}:${pad(local.second, 2)}`,
  }
}

/** Formats an instant as RFC 3339 with the zone's explicit offset at that instant. */
export function toRfc3339(zone: string, instant: Date): string {
  const offset = offsetMinutesAt(zone, instant)
  const local = localPartsAt(zone, instant)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const datePart = `${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}`
  const timePart = `${pad(local.hour, 2)}:${pad(local.minute, 2)}:${pad(local.second, 2)}`
  const offsetPart = `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`
  return `${datePart}T${timePart}${offsetPart}`
}

function parseWallClock(date: string, time: string): { y: number; mo: number; da: number; h: number; mi: number; s: number } {
  const [y, mo, da] = date.split('-').map(Number)
  const [h, mi, s] = time.split(':').map(Number)
  return { y, mo, da, h, mi, s: s ?? 0 }
}

/**
 * The instant a local wall-clock date+time resolves to in the zone.
 * A repeated local time (fall-back) resolves to its earlier occurrence; a
 * nonexistent local time (spring-forward gap) resolves forward past the gap
 * — the same non-rejecting behaviour §11 documents for Postgres.
 */
export function zonedTimeToInstant(zone: string, date: string, time: string): Date {
  const { y, mo, da, h, mi, s } = parseWallClock(date, time)
  const naiveUtcMs = Date.UTC(y, mo - 1, da, h, mi, s)

  const firstGuessOffset = offsetMinutesAt(zone, new Date(naiveUtcMs))
  const firstCandidateMs = naiveUtcMs - firstGuessOffset * 60_000
  const offsetAtFirstCandidate = offsetMinutesAt(zone, new Date(firstCandidateMs))
  if (offsetAtFirstCandidate === firstGuessOffset) {
    return new Date(firstCandidateMs)
  }

  const secondCandidateMs = naiveUtcMs - offsetAtFirstCandidate * 60_000
  const secondLocal = toLocal(zone, new Date(secondCandidateMs))
  if (secondLocal.date === date && secondLocal.time.slice(0, time.length) === time) {
    return new Date(secondCandidateMs)
  }

  return new Date(Math.min(firstCandidateMs, secondCandidateMs))
}

/**
 * The zone's DST shift in minutes, sampled daily across the calendar year
 * containing `referenceDate`. Zero for a zone that observes no DST that
 * year — ARCHITECTURE.md §11's "divides the shift" rule then permits any
 * slotMinutes, since 0 % n is always 0.
 */
export function dstShiftMinutes(zone: string, referenceDate: string): number {
  const year = Number(referenceDate.slice(0, 4))
  let min = Infinity
  let max = -Infinity
  const yearStartMs = Date.UTC(year, 0, 1, 12, 0, 0)
  for (let day = 0; day < 367; day++) {
    const offset = offsetMinutesAt(zone, new Date(yearStartMs + day * 86_400_000))
    if (offset < min) min = offset
    if (offset > max) max = offset
  }
  return max - min
}

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import * as zones from '../../lib/time/zones'
import type { Block, WorkingHour } from '../../lib/scheduling/availability'

// lib/scheduling/availability.ts imports lib/config.ts, which requires
// these four with no default (ADR-0012, SEC-6/7) at module-evaluation
// time — the same pattern tests/notify/email.test.ts and
// tests/db/client.test.ts use, since a static top-level import would
// resolve before any in-file env setup could run.
const REQUIRED_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SOURCE_REF_SALT: 'test-source-ref-salt',
}

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

afterEach(() => {
  vi.unstubAllEnvs()
})

// Loads a fresh lib/scheduling/availability.ts against REQUIRED_ENV plus
// overrides, so each test (in particular the SLOT_HORIZON_DAYS ones) sees
// its own resolved config independent of any other test's env mutation.
async function loadAvailability(overrides: Record<string, string | undefined> = {}) {
  const merged = { ...REQUIRED_ENV, ...overrides }
  for (const [key, value] of Object.entries(merged)) {
    vi.stubEnv(key, value)
  }
  vi.resetModules()
  return import('../../lib/scheduling/availability')
}

const CHICAGO = 'America/Chicago'
const LORD_HOWE = 'Australia/Lord_Howe'
const TOKYO = 'Asia/Tokyo' // no DST (ARCHITECTURE.md §11) — accepts any schema-legal slotMinutes

const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/

function localTimePart(instant: string): string {
  return instant.slice(11, 19)
}

function localDatePart(instant: string): string {
  return instant.slice(0, 10)
}

// Every weekday carries the same window(s), so a test's single fromDate
// never has to line up with a specific weekday.
function allWeekdays(windows: Array<{ startsLocal: string; endsLocal: string }>): WorkingHour[] {
  const out: WorkingHour[] = []
  for (let weekday = 0; weekday <= 6; weekday++) {
    for (const w of windows) out.push({ weekday, ...w })
  }
  return out
}

function localInstant(zone: string, date: string, time: string): string {
  return zones.toRfc3339(zone, zones.zonedTimeToInstant(zone, date, time))
}

describe('generateSlots — acceptance criteria (JOR-242)', () => {
  test('AC1: America/Chicago 00:00-06:00, 30-min slots — 12 normal, 10 spring-forward, 14 fall-back; none duplicated, none skipped, none an hour out', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([{ startsLocal: '00:00', endsLocal: '06:00' }])
    const call = (date: string): Array<{ startsAt: string; endsAt: string }> =>
      generateSlots({ timeZone: CHICAGO, slotMinutes: 30, workingHours, blocks: [], fromDate: date, toDate: date })

    const normal = call('2026-03-07')
    expect(normal).toHaveLength(12)
    expect(new Set(normal.map((s) => s.startsAt)).size).toBe(12)
    expect(normal.every((s) => localTimePart(s.startsAt) >= '00:00:00' && localTimePart(s.startsAt) < '06:00:00')).toBe(true)

    const springForward = call('2026-03-08')
    expect(springForward).toHaveLength(10)
    expect(new Set(springForward.map((s) => s.startsAt)).size).toBe(10)
    expect(springForward.map((s) => localTimePart(s.startsAt))).toEqual([
      '00:00:00', '00:30:00', '01:00:00', '01:30:00',
      '03:00:00', '03:30:00', '04:00:00', '04:30:00', '05:00:00', '05:30:00',
    ])

    const fallBack = call('2026-11-01')
    expect(fallBack).toHaveLength(14)
    expect(new Set(fallBack.map((s) => s.startsAt)).size).toBe(14)
    expect(fallBack.filter((s) => localTimePart(s.startsAt) === '01:00:00')).toHaveLength(2)
    expect(fallBack.filter((s) => localTimePart(s.startsAt) === '01:30:00')).toHaveLength(2)
  })

  test('AC2: America/Chicago 09:00-17:00, 45-min slots are rejected — 45 does not divide the zone\'s 60-minute shift', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }])
    expect(() =>
      generateSlots({ timeZone: CHICAGO, slotMinutes: 45, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' }),
    ).toThrow()
  })

  test('AC3: the first slot of each local date starts exactly at startsLocal; the 09:15/09:30 misalignment §11 documents for a stepped grid never occurs', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }])
    // 30 and 60 minutes both divide Chicago's 60-minute shift, so both are
    // accepted configurations for every date in §11's table, including the
    // two transition days where a non-reanchored grid drifts to 09:15/09:30.
    for (const slotMinutes of [30, 60]) {
      for (const date of ['2026-03-07', '2026-03-08', '2026-11-01']) {
        const slots = generateSlots({ timeZone: CHICAGO, slotMinutes, workingHours, blocks: [], fromDate: date, toDate: date })
        expect(slots.length).toBeGreaterThan(0)
        expect(localTimePart(slots[0].startsAt)).toBe('09:00:00')
      }
    }
  })

  test('AC4: Australia/Lord_Howe accepts a 30-min slot (its own DST shift) and rejects 60-min', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }])
    const accepted = generateSlots({
      timeZone: LORD_HOWE, slotMinutes: 30, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15',
    })
    expect(accepted.length).toBeGreaterThan(0)
    expect(() =>
      generateSlots({ timeZone: LORD_HOWE, slotMinutes: 60, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' }),
    ).toThrow()
  })

  test('AC5: no generated slot ends after endsLocal — 09:00-17:00 produces no 16:30-18:00 at 90 minutes and no 16:30-17:15 at 45 minutes', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }])
    for (const slotMinutes of [90, 45]) {
      const slots = generateSlots({ timeZone: TOKYO, slotMinutes, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' })
      expect(slots.some((s) => localTimePart(s.startsAt) === '16:30:00')).toBe(false)
      expect(slots.every((s) => localTimePart(s.endsAt) <= '17:00:00')).toBe(true)
    }
  })

  test('AC6: two non-overlapping windows on one weekday (09:00-12:00, 13:00-17:00) generate slots in both and none across the break', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([
      { startsLocal: '09:00', endsLocal: '12:00' },
      { startsLocal: '13:00', endsLocal: '17:00' },
    ])
    const slots = generateSlots({ timeZone: TOKYO, slotMinutes: 30, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' })
    expect(slots.some((s) => localTimePart(s.startsAt) >= '09:00:00' && localTimePart(s.startsAt) < '12:00:00')).toBe(true)
    expect(slots.some((s) => localTimePart(s.startsAt) >= '13:00:00' && localTimePart(s.startsAt) < '17:00:00')).toBe(true)
    expect(slots.some((s) => localTimePart(s.startsAt) >= '12:00:00' && localTimePart(s.startsAt) < '13:00:00')).toBe(false)
  })

  test('AC7: a block covering part of a day removes exactly the slots it overlaps and no others', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }])
    const baseline = generateSlots({ timeZone: TOKYO, slotMinutes: 30, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' })

    const block: Block = {
      startsAt: localInstant(TOKYO, '2026-06-15', '10:00'),
      endsAt: localInstant(TOKYO, '2026-06-15', '11:00'),
    }
    const withBlock = generateSlots({ timeZone: TOKYO, slotMinutes: 30, workingHours, blocks: [block], fromDate: '2026-06-15', toDate: '2026-06-15' })

    expect(withBlock).toHaveLength(baseline.length - 2)
    expect(withBlock.some((s) => localTimePart(s.startsAt) === '10:00:00')).toBe(false)
    expect(withBlock.some((s) => localTimePart(s.startsAt) === '10:30:00')).toBe(false)
    expect(withBlock.some((s) => localTimePart(s.startsAt) === '09:30:00')).toBe(true)
    expect(withBlock.some((s) => localTimePart(s.startsAt) === '11:00:00')).toBe(true)
  })

  test('AC8: the default horizon spans today through today + config.slotHorizonDays, resolved from config — changing the config value changes the last generated local date with no code edit', async () => {
    const withDefault = await loadAvailability()
    expect(withDefault.defaultHorizon('2026-01-01')).toEqual({ fromDate: '2026-01-01', toDate: '2026-03-02' })

    const withTen = await loadAvailability({ SLOT_HORIZON_DAYS: '10' })
    expect(withTen.defaultHorizon('2026-01-01')).toEqual({ fromDate: '2026-01-01', toDate: '2026-01-11' })

    const withFive = await loadAvailability({ SLOT_HORIZON_DAYS: '5' })
    expect(withFive.defaultHorizon('2026-01-01')).toEqual({ fromDate: '2026-01-01', toDate: '2026-01-06' })
  })

  test('AC9: every startsAt/endsAt is RFC 3339 with an explicit offset, and every value is distinct', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }])
    const slots = generateSlots({ timeZone: CHICAGO, slotMinutes: 30, workingHours, blocks: [], fromDate: '2026-03-01', toDate: '2026-03-10' })
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      expect(slot.startsAt).toMatch(RFC3339_WITH_OFFSET)
      expect(slot.endsAt).toMatch(RFC3339_WITH_OFFSET)
    }
    const starts = slots.map((s) => s.startsAt)
    expect(new Set(starts).size).toBe(starts.length)
  })

  test('AC10: no slot is emitted for a local date outside fromDate..toDate', async () => {
    const { generateSlots } = await loadAvailability()
    const workingHours = allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }])
    const slots = generateSlots({ timeZone: CHICAGO, slotMinutes: 30, workingHours, blocks: [], fromDate: '2026-06-08', toDate: '2026-06-10' })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((s) => {
      const date = localDatePart(s.startsAt)
      return date >= '2026-06-08' && date <= '2026-06-10'
    })).toBe(true)
  })
})

describe('generateSlots — mandatory adversarial tests (JOR-242)', () => {
  const workingHours = allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }])

  test('MAT1: slotMinutes 45 with America/Chicago is rejected', async () => {
    const { generateSlots } = await loadAvailability()
    expect(() =>
      generateSlots({ timeZone: CHICAGO, slotMinutes: 45, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' }),
    ).toThrow()
  })

  test('MAT2: slotMinutes 60 with Australia/Lord_Howe is rejected', async () => {
    const { generateSlots } = await loadAvailability()
    expect(() =>
      generateSlots({ timeZone: LORD_HOWE, slotMinutes: 60, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' }),
    ).toThrow()
  })

  test('MAT3: slotMinutes below 5 or above 240 is rejected', async () => {
    const { generateSlots } = await loadAvailability()
    expect(() =>
      generateSlots({ timeZone: TOKYO, slotMinutes: 4, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' }),
    ).toThrow()
    expect(() =>
      generateSlots({ timeZone: TOKYO, slotMinutes: 241, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' }),
    ).toThrow()
  })

  test('MAT4: an unknown time zone (including a typo\'d IANA name) is rejected', async () => {
    const { generateSlots } = await loadAvailability()
    expect(() =>
      generateSlots({ timeZone: 'America/Chicagoo', slotMinutes: 30, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' }),
    ).toThrow()
    expect(() =>
      generateSlots({ timeZone: 'Nowhere/Fake', slotMinutes: 30, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15' }),
    ).toThrow()
  })

  test('MAT5: endsLocal earlier than or equal to startsLocal is rejected', async () => {
    const { generateSlots } = await loadAvailability()
    expect(() =>
      generateSlots({
        timeZone: TOKYO, slotMinutes: 30, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15',
        workingHours: allWeekdays([{ startsLocal: '09:00', endsLocal: '09:00' }]),
      }),
    ).toThrow()
    expect(() =>
      generateSlots({
        timeZone: TOKYO, slotMinutes: 30, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15',
        workingHours: allWeekdays([{ startsLocal: '09:00', endsLocal: '08:00' }]),
      }),
    ).toThrow()
  })

  test('MAT6: a weekday outside 0-6 is rejected', async () => {
    const { generateSlots } = await loadAvailability()
    expect(() =>
      generateSlots({
        timeZone: TOKYO, slotMinutes: 30, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15',
        workingHours: [{ weekday: -1, startsLocal: '09:00', endsLocal: '17:00' }],
      }),
    ).toThrow()
    expect(() =>
      generateSlots({
        timeZone: TOKYO, slotMinutes: 30, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15',
        workingHours: [{ weekday: 7, startsLocal: '09:00', endsLocal: '17:00' }],
      }),
    ).toThrow()
  })

  test('MAT7: fromDate later than toDate is rejected', async () => {
    const { generateSlots } = await loadAvailability()
    expect(() =>
      generateSlots({ timeZone: TOKYO, slotMinutes: 30, workingHours, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-14' }),
    ).toThrow()
  })

  test('MAT8: a startsLocal/endsLocal that is not a wall-clock time string is rejected', async () => {
    const { generateSlots } = await loadAvailability()
    expect(() =>
      generateSlots({
        timeZone: TOKYO, slotMinutes: 30, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15',
        workingHours: allWeekdays([{ startsLocal: '9am', endsLocal: '17:00' }]),
      }),
    ).toThrow()
    expect(() =>
      generateSlots({
        timeZone: TOKYO, slotMinutes: 30, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15',
        workingHours: allWeekdays([{ startsLocal: '09:00', endsLocal: '25:00' }]),
      }),
    ).toThrow()
  })

  test('MAT9: output never contains two identical startsAt values (the spring-forward collision)', async () => {
    const { generateSlots } = await loadAvailability()
    const slots = generateSlots({
      timeZone: CHICAGO, slotMinutes: 30, blocks: [], fromDate: '2026-03-08', toDate: '2026-03-08',
      workingHours: allWeekdays([{ startsLocal: '00:00', endsLocal: '06:00' }]),
    })
    const starts = slots.map((s) => s.startsAt)
    expect(new Set(starts).size).toBe(starts.length)
  })

  test('MAT10: output never contains a naive local timestamp with no offset', async () => {
    const { generateSlots } = await loadAvailability()
    const slots = generateSlots({
      timeZone: CHICAGO, slotMinutes: 30, blocks: [], fromDate: '2026-03-08', toDate: '2026-03-08',
      workingHours: allWeekdays([{ startsLocal: '00:00', endsLocal: '06:00' }]),
    })
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      expect(slot.startsAt).not.toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      expect(slot.startsAt).toMatch(RFC3339_WITH_OFFSET)
    }
  })

  test('MAT11: output never contains a slot whose end exceeds endsLocal', async () => {
    const { generateSlots } = await loadAvailability()
    const slots = generateSlots({
      timeZone: TOKYO, slotMinutes: 90, blocks: [], fromDate: '2026-06-15', toDate: '2026-06-15',
      workingHours: allWeekdays([{ startsLocal: '09:00', endsLocal: '17:00' }]),
    })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((s) => localTimePart(s.endsAt) <= '17:00:00')).toBe(true)
  })

  test('MAT12: output never contains a slot on the padding day either side of the requested range', async () => {
    const { generateSlots } = await loadAvailability()
    const slots = generateSlots({
      timeZone: CHICAGO, slotMinutes: 30, blocks: [], fromDate: '2026-03-08', toDate: '2026-03-08',
      workingHours: allWeekdays([{ startsLocal: '00:00', endsLocal: '06:00' }]),
    })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.some((s) => localDatePart(s.startsAt) === '2026-03-07')).toBe(false)
    expect(slots.some((s) => localDatePart(s.startsAt) === '2026-03-09')).toBe(false)
  })

  test('MAT13: no horizon literal stands in for config.slotHorizonDays — the horizon moves when the config value moves', async () => {
    const a = await loadAvailability({ SLOT_HORIZON_DAYS: '1' })
    const b = await loadAvailability({ SLOT_HORIZON_DAYS: '90' })
    expect(a.defaultHorizon('2026-01-01').toDate).not.toBe(b.defaultHorizon('2026-01-01').toDate)
    expect(a.defaultHorizon('2026-01-01')).toEqual({ fromDate: '2026-01-01', toDate: '2026-01-02' })
    expect(b.defaultHorizon('2026-01-01')).toEqual({ fromDate: '2026-01-01', toDate: '2026-04-01' })
  })

  test('MAT14: no zone-aware date computation is performed outside lib/time/zones.ts', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'lib/scheduling/availability.ts'), 'utf8')
    expect(source).not.toMatch(/Intl\.DateTimeFormat/)
    expect(source).not.toMatch(/getTimezoneOffset/)
    expect(source).toMatch(/from '\.\.\/time\/zones'/)
  })
})

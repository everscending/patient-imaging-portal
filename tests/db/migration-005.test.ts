import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'

function psql(dbName: string, sql: string): string {
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
  }).trim()
}

let run: Run
let fixtureSequence = 0

beforeAll(async () => {
  run = await startRun(await ensureContainer())
}, 60_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

function fixture(): { providerId: string; appointmentId: string } {
  fixtureSequence += 1
  const providerId = psql(run.dbName, `insert into providers (full_name,time_zone) values ('Provider','America/Chicago') returning id;`)
  const patientId = psql(run.dbName, `insert into patients (patient_ref,date_of_birth,full_name,email) values ('PT-5${String(fixtureSequence).padStart(3, '0')}','1990-01-01','Patient','p@example.com') returning id;`)
  const serviceId = psql(run.dbName, `insert into services (slug,name) values ('svc-${providerId.slice(0, 8)}','Service') returning id;`)
  const bookedSlotId = psql(run.dbName, `insert into slots (provider_id,starts_at,ends_at) values ('${providerId}','2026-08-17 15:00+00','2026-08-17 15:30+00') returning id;`)
  psql(run.dbName, `insert into slots (provider_id,starts_at,ends_at) values
    ('${providerId}','2026-08-17 15:30+00','2026-08-17 16:00+00'),
    ('${providerId}','2026-08-16 15:30+00','2026-08-16 16:00+00'),
    ('${providerId}','2026-10-20 15:30+00','2026-10-20 16:00+00');`)
  const appointmentId = psql(run.dbName, `insert into appointments (slot_id,patient_id,provider_id,service_id,status)
    values ('${bookedSlotId}','${patientId}','${providerId}','${serviceId}','confirmed') returning id;`)
  psql(run.dbName, `insert into working_hours (provider_id,weekday,starts_local,ends_local) values ('${providerId}',1,'09:00','17:00');`)
  return { providerId, appointmentId }
}

function apply(providerId: string, hours: string, slots: string, slotMinutes = 30): string {
  return psql(run.dbName, `select removed_open_slots || '|' || generated_open_slots || '|' || jsonb_array_length(preserved_out_of_hours)
    from apply_provider_availability(
      '${providerId}', ${slotMinutes}, '${hours}'::jsonb, '[]'::jsonb,
      '2026-08-17 05:00+00', '2026-08-18 05:00+00', ${slots}::tstzrange[]
    );`)
}

describe('apply_provider_availability transactional accept-and-flag', () => {
  test('removes only free in-range slots, preserves the booking, and self-heals on restore', () => {
    const { providerId, appointmentId } = fixture()
    const closedHours = `[{"weekday":1,"startsLocal":"12:00","endsLocal":"17:00"}]`
    expect(apply(providerId, closedHours, `array['[2026-08-17 17:00+00,2026-08-17 17:30+00)']`)).toBe('1|1|1')
    expect(psql(run.dbName, `select status || '|' || out_of_hours from appointments where id='${appointmentId}';`)).toBe('confirmed|true')
    expect(psql(run.dbName, `select count(*) from slots where provider_id='${providerId}' and starts_at in ('2026-08-16 15:30+00','2026-10-20 15:30+00');`)).toBe('2')

    const restoredHours = `[{"weekday":1,"startsLocal":"09:00","endsLocal":"17:00"}]`
    expect(apply(providerId, restoredHours, `array['[2026-08-17 15:00+00,2026-08-17 15:30+00)','[2026-08-17 15:30+00,2026-08-17 16:00+00)']`)).toBe('1|1|0')
    expect(psql(run.dbName, `select out_of_hours from appointments where id='${appointmentId}';`)).toBe('f')
  })

  test('a different slot length skips a proposal overlapping the surviving booked slot', () => {
    const { providerId, appointmentId } = fixture()
    const hours = `[{"weekday":1,"startsLocal":"09:00","endsLocal":"17:00"}]`
    expect(() => apply(providerId, hours, `array['[2026-08-17 14:00+00,2026-08-17 15:00+00)','[2026-08-17 15:00+00,2026-08-17 16:00+00)','[2026-08-17 16:00+00,2026-08-17 17:00+00)']`, 60)).not.toThrow()
    expect(psql(run.dbName, `select count(*) from appointments where id='${appointmentId}' and status='confirmed';`)).toBe('1')
    expect(psql(run.dbName, `select count(*) from slots a join slots b on a.provider_id=b.provider_id and a.id<b.id and tstzrange(a.starts_at,a.ends_at) && tstzrange(b.starts_at,b.ends_at) where a.provider_id='${providerId}';`)).toBe('0')
  })

  test('a failure after replacement begins rolls every availability change back', () => {
    const { providerId } = fixture()
    const before = psql(run.dbName, `select count(*) || '|' || min(starts_local)::text from working_hours where provider_id='${providerId}';`)
    const overlapping = `[{"weekday":1,"startsLocal":"09:00","endsLocal":"13:00"},{"weekday":1,"startsLocal":"12:00","endsLocal":"17:00"}]`
    expect(() => apply(providerId, overlapping, `array[]`)).toThrow()
    expect(psql(run.dbName, `select count(*) || '|' || min(starts_local)::text from working_hours where provider_id='${providerId}';`)).toBe(before)
  })
})

import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

vi.mock('server-only', () => ({}))
vi.mock('../../lib/config', () => ({ config: { appBaseUrl: 'http://localhost:4310', minChangeNoticeHours: 24 } }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'integration-session' }) }),
}))

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const CONCURRENCY = 20
const ADVISORY_LOCK_KEY = 228_006
const execFileAsync = promisify(execFile)

let container: Container
let run: Run
let rpcBarrier: { wait: () => Promise<void> } = { wait: async () => {} }
let rpcApplicationName = 'booking-concurrency-test'

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
}

async function psqlAsync(sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  )
  return stdout.trim()
}

function appUserSql(actorUserId: string, sql: string): string {
  return `set role app_user;
          set request.jwt.claims = ${sqlLiteral(JSON.stringify({ sub: actorUserId }))};
          set application_name = ${sqlLiteral(rpcApplicationName)};
          ${sql}`
}

vi.mock('../../lib/db/client', () => ({
  anonClient: () => ({
    from: (table: string) => {
      let actorUserId = ''
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          actorUserId = value
          return query
        },
        maybeSingle: async () => {
          const id = psql(`select id from ${table} where user_id = ${sqlLiteral(actorUserId)}::uuid limit 1;`)
          return { data: id ? { id } : null, error: null }
        },
      }
      return query
    },
    rpc: async (name: string, args: Record<string, string>) => {
      if (name !== 'book_appointment') return { data: null, error: { message: 'unexpected RPC' } }
      await rpcBarrier.wait()
      const call = `select row_to_json(result) from book_appointment(
        ${sqlLiteral(args.p_patient_id)}::uuid,
        ${sqlLiteral(args.p_slot_id)}::uuid,
        ${sqlLiteral(args.p_service_id)}::uuid,
        ${sqlLiteral(args.p_idempotency_key)},
        ${sqlLiteral(args.p_actor_user_id)}::uuid
      ) result;`
      try {
        const raw = await psqlAsync(appUserSql(args.p_actor_user_id, call))
        return { data: raw ? [JSON.parse(raw)] : [], error: null }
      } catch {
        return { data: null, error: { message: 'database RPC failed' } }
      }
    },
  }),
}))

vi.mock('../../lib/audit/events', () => ({
  recordAuditEvent: async (input: {
    actorKind: string
    actorRef: string
    action: string
    targetKind: string
    targetId: string
    outcome: string
  }) => {
    psql(`insert into audit_events (actor_kind, actor_ref, action, target_kind, target_id, outcome)
          values (${sqlLiteral(input.actorKind)}::actor_kind, ${sqlLiteral(input.actorRef)},
                  ${sqlLiteral(input.action)}, ${sqlLiteral(input.targetKind)},
                  ${sqlLiteral(input.targetId)}::uuid, ${sqlLiteral(input.outcome)});`)
  },
}))

import { book } from '../../lib/scheduling/booking'

type Patient = { id: string; actorUserId: string }
type Fixture = {
  providerId: string
  serviceId: string
  otherServiceId: string
  patients: Patient[]
  slots: string[]
}

function simultaneousBarrier(callCount: number): { wait: () => Promise<void> } {
  let arrived = 0
  let release: (() => void) | undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    async wait() {
      arrived += 1
      if (arrived === callCount) release?.()
      await released
    },
  }
}

function createFixture(options: { patientCount?: number; slotCount?: number; startsInHours?: number } = {}): Fixture {
  const patientCount = options.patientCount ?? 1
  const slotCount = options.slotCount ?? 1
  const startsInHours = options.startsInHours ?? 72
  const providerId = randomUUID()
  const serviceId = randomUUID()
  const otherServiceId = randomUUID()
  const patients = Array.from({ length: patientCount }, () => ({ id: randomUUID(), actorUserId: randomUUID() }))
  const slots = Array.from({ length: slotCount }, () => randomUUID())
  const slugSuffix = randomUUID().replaceAll('-', '')

  const patientSql = patients
    .map(
      (patient, index) => `
        insert into auth.users (id) values ('${patient.actorUserId}');
        insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email)
        values ('${patient.id}', '${patient.actorUserId}', 'PT-${slugSuffix.slice(0, 8)}-${index}',
                '1990-01-01', 'Concurrency Patient ${index}', 'patient-${slugSuffix}-${index}@example.test');`,
    )
    .join('\n')
  const slotSql = slots
    .map(
      (slotId, index) => `
        insert into slots (id, provider_id, starts_at, ends_at)
        values ('${slotId}', '${providerId}',
                now() + interval '${startsInHours + index * 2} hours',
                now() + interval '${startsInHours + index * 2 + 1} hours');`,
    )
    .join('\n')

  psql(`
    insert into providers (id, full_name, time_zone) values ('${providerId}', 'Dr. Concurrency', 'America/Chicago');
    insert into services (id, slug, name) values
      ('${serviceId}', 'offered-${slugSuffix}', 'Offered Ultrasound'),
      ('${otherServiceId}', 'other-${slugSuffix}', 'Other Ultrasound');
    insert into provider_services (provider_id, service_id) values ('${providerId}', '${serviceId}');
    ${patientSql}
    ${slotSql}
  `)

  return { providerId, serviceId, otherServiceId, patients, slots }
}

function bookInput(fixture: Fixture, patientIndex: number, slotIndex: number, idempotencyKey = randomUUID()) {
  const patient = fixture.patients[patientIndex]!
  return {
    patientId: patient.id,
    slotId: fixture.slots[slotIndex]!,
    serviceId: fixture.serviceId,
    idempotencyKey,
    actorUserId: patient.actorUserId,
  }
}

function expectSqlState(sql: string, sqlState: string): void {
  try {
    execFileSync(
      'docker',
      [
        'exec',
        CONTAINER_NAME,
        'psql',
        '-U',
        PG_USER,
        '-d',
        run.dbName,
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=sqlstate',
        '-tAq',
        '-c',
        sql,
      ],
      { encoding: 'utf8' },
    )
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer | string }).stderr ?? '')
    expect(stderr).toContain(sqlState)
    return
  }
  throw new Error(`expected SQLSTATE ${sqlState}`)
}

async function acquireAdvisoryLock(): Promise<ChildProcessWithoutNullStreams> {
  const process = spawn(
    'docker',
    ['exec', '-i', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const locked = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes('LOCKED')) {
        process.stdout.off('data', onData)
        resolve()
      }
    }
    process.stdout.on('data', onData)
    process.once('error', reject)
    process.once('exit', (code) => reject(new Error(`advisory-lock psql exited early: ${code}`)))
  })
  process.stdin.write(`select pg_advisory_lock(${ADVISORY_LOCK_KEY}); select 'LOCKED';\n`)
  await locked
  return process
}

async function releaseAdvisoryLock(process: ChildProcessWithoutNullStreams): Promise<void> {
  const closed = new Promise<void>((resolve) => process.once('close', () => resolve()))
  process.stdin.end(`select pg_advisory_unlock(${ADVISORY_LOCK_KEY});\n`)
  await closed
}

async function acquireSlotRowLock(slotId: string): Promise<ChildProcessWithoutNullStreams> {
  const process = spawn(
    'docker',
    ['exec', '-i', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const locked = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes('LOCKED')) {
        process.stdout.off('data', onData)
        resolve()
      }
    }
    process.stdout.on('data', onData)
    process.once('error', reject)
    process.once('exit', (code) => reject(new Error(`slot-lock psql exited early: ${code}`)))
  })
  process.stdin.write(
    `begin; select id from slots where id = ${sqlLiteral(slotId)}::uuid for update; select 'LOCKED';\n`,
  )
  await locked
  return process
}

async function releaseSlotRowLock(process: ChildProcessWithoutNullStreams): Promise<void> {
  const closed = new Promise<void>((resolve) => process.once('close', () => resolve()))
  process.stdin.end('rollback;\n')
  await closed
}

async function waitUntilBookingIsPaused(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = Number(
      psql(`select count(*) from pg_stat_activity
             where datname = current_database()
               and application_name = 'booking-bypass-probe'
               and wait_event = 'advisory';`),
    )
    if (waiting === 1) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('booking call did not pause after acquiring the slot row lock')
}

beforeAll(async () => {
  container = await ensureContainer()
  run = await startRun(container)
  psql(`create or replace function auth.uid() returns uuid
        language sql stable
        as $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;`)
}, 120_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('book — transaction, DTO, idempotency, derived slot state, and audit', () => {
  test('book_openFutureSlot_createsRequestedAppointmentTransitionAndAudit_thenSameKeySameSlotReusesIt', async () => {
    const fixture = createFixture({ slotCount: 2 })
    const key = randomUUID()
    const input = bookInput(fixture, 0, 0, key)

    const created = await book(input)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.reused).toBe(false)
    expect(created.appointment).toMatchObject({
      status: 'requested',
      providerName: 'Dr. Concurrency',
      serviceName: 'Offered Ultrasound',
      outOfHours: false,
      canChange: true,
      allowedTransitions: ['cancelled'],
    })
    expect(created.appointment.startsAt).toMatch(/[+-]\d\d:\d\d$/)
    expect(created.appointment.changeDeadline).toMatch(/[+-]\d\d:\d\d$/)
    expect(new Date(created.appointment.startsAt).getTime() - new Date(created.appointment.changeDeadline).getTime()).toBe(
      24 * 60 * 60 * 1_000,
    )
    expect(psql(`select status from slots where id = '${fixture.slots[0]}';`)).toBe('booked')
    expect(
      psql(`select coalesce(from_status::text, 'null') || '|' || to_status::text
              from appointment_transitions where appointment_id = '${created.appointment.id}';`),
    ).toBe('null|requested')
    expect(
      psql(`select actor_kind::text || '|' || actor_ref || '|' || action || '|' || target_kind || '|' || outcome || '|' || coalesce(detail::text, 'null')
              from audit_events where target_id = '${created.appointment.id}';`),
    ).toBe(`account|${input.actorUserId}|booking.create|appointment|granted|null`)

    const reused = await book(input)
    expect(reused).toEqual({ ok: true, appointment: created.appointment, reused: true })
    expect(psql(`select count(*) from appointments where patient_id = '${input.patientId}' and idempotency_key = '${key}';`)).toBe('1')
    expect(psql(`select count(*) from audit_events where target_id = '${created.appointment.id}';`)).toBe('1')

    const differentSlot = await book({ ...input, slotId: fixture.slots[1]! })
    expect(differentSlot).toEqual({ ok: false, error: 'idempotency_key_reused' })
    expect(psql(`select count(*) from appointments where patient_id = '${input.patientId}' and idempotency_key = '${key}';`)).toBe('1')
  })

  test('book_serviceNotOffered_returnsBeforeTheSlotRowLock', async () => {
    const fixture = createFixture()
    const slotLock = await acquireSlotRowLock(fixture.slots[0]!)
    const pending = book({ ...bookInput(fixture, 0, 0), serviceId: fixture.otherServiceId })
    const result = await Promise.race([
      pending,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 1_000)),
    ])
    await releaseSlotRowLock(slotLock)
    if (result === 'blocked') await pending
    expect(result).toEqual({ ok: false, error: 'service_not_offered' })
    expect(psql(`select count(*) from appointments where slot_id = '${fixture.slots[0]}';`)).toBe('0')

    const migration = readFileSync('db/migrations/006_book_appointment.sql', 'utf8')
    expect(migration.indexOf('provider_services ps')).toBeLessThan(migration.indexOf('-- Step 2: only the requested'))
  })

  test('book_bookedSlotAndPastSlot_eachReturnSlotUnavailable', async () => {
    const bookedFixture = createFixture()
    psql(`update slots set status = 'booked' where id = '${bookedFixture.slots[0]}';`)
    await expect(book(bookInput(bookedFixture, 0, 0))).resolves.toEqual({ ok: false, error: 'slot_unavailable' })

    const pastFixture = createFixture({ startsInHours: -2 })
    await expect(book(bookInput(pastFixture, 0, 0))).resolves.toEqual({ ok: false, error: 'slot_unavailable' })
  })

  test('book_slotHoldingLiveAppointment_returnsSlotUnavailable', async () => {
    const fixture = createFixture({ patientCount: 2 })
    psql(`insert into appointments (slot_id, patient_id, provider_id, service_id, idempotency_key)
          values ('${fixture.slots[0]}', '${fixture.patients[0]!.id}', '${fixture.providerId}', '${fixture.serviceId}', '${randomUUID()}');`)
    await expect(book(bookInput(fixture, 1, 0))).resolves.toEqual({ ok: false, error: 'slot_unavailable' })
  })

  test('book_cancelledAppointmentDoesNotBlockTheFreedSlot', async () => {
    const fixture = createFixture({ patientCount: 2 })
    const cancelledId = psql(`insert into appointments (slot_id, patient_id, provider_id, service_id, idempotency_key)
      values ('${fixture.slots[0]}', '${fixture.patients[0]!.id}', '${fixture.providerId}', '${fixture.serviceId}', '${randomUUID()}') returning id;`)
    psql(`update appointments set status = 'cancelled' where id = '${cancelledId}';`)
    expect(psql(`select status from slots where id = '${fixture.slots[0]}';`)).toBe('open')

    const result = await book(bookInput(fixture, 1, 0))
    expect(result.ok).toBe(true)
    expect(psql(`select count(*) from appointments where slot_id = '${fixture.slots[0]}';`)).toBe('2')
  })
})

describe('book — mandatory concurrency and adversarial guards', () => {
  test('twentySimultaneousBookCalls_lastOpenSlot_hasOneWinnerNineteenDomainLosersAndTouchesNoOtherSlot', async () => {
    const fixture = createFixture({ patientCount: CONCURRENCY, slotCount: 3 })
    const targetSlot = fixture.slots.at(-1)!
    const untouchedSlots = fixture.slots.slice(0, -1)
    const openBefore = psql(`select count(*) from slots where id in ('${untouchedSlots.join("','")}') and status = 'open';`)
    rpcBarrier = simultaneousBarrier(CONCURRENCY)

    const results = await Promise.all(
      fixture.patients.map((_, index) => book({ ...bookInput(fixture, index, 2), slotId: targetSlot })),
    )
    rpcBarrier = { wait: async () => {} }

    const winners = results.filter((result) => result.ok)
    const losers = results.filter((result) => !result.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(CONCURRENCY - 1)
    expect(losers.every((result) => !result.ok && result.error === 'slot_unavailable')).toBe(true)
    expect(psql(`select count(*) from appointments where slot_id = '${targetSlot}';`)).toBe('1')
    expect(
      psql(`select count(*) from appointment_transitions t join appointments a on a.id = t.appointment_id where a.slot_id = '${targetSlot}';`),
    ).toBe('1')
    expect(psql(`select count(*) from slots where id in ('${untouchedSlots.join("','")}') and status = 'open';`)).toBe(openBefore)
    expect(psql(`select count(*) from audit_events ae join appointments a on a.id = ae.target_id where a.slot_id = '${targetSlot}' and ae.action = 'booking.create';`)).toBe('1')
  }, 30_000)

  test('sameIdempotencyKeyDifferentSlots_concurrentLoserIsKeyReuseNeverPhantomSuccess', async () => {
    const fixture = createFixture({ slotCount: 2 })
    const key = randomUUID()
    rpcBarrier = simultaneousBarrier(2)
    const inputs = [bookInput(fixture, 0, 0, key), bookInput(fixture, 0, 1, key)]
    const results = await Promise.all(inputs.map((input) => book(input)))
    rpcBarrier = { wait: async () => {} }

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: 'idempotency_key_reused' }])
    const storedSlot = psql(`select slot_id from appointments where patient_id = '${fixture.patients[0]!.id}' and idempotency_key = '${key}';`)
    const winnerIndex = results.findIndex((result) => result.ok)
    expect(storedSlot).toBe(inputs[winnerIndex]!.slotId)
    expect(psql(`select count(*) from appointments where patient_id = '${fixture.patients[0]!.id}' and idempotency_key = '${key}';`)).toBe('1')
  }, 15_000)

  test('sameIdempotencyKeySameSlot_concurrentLoserReReadsAndReusesTheWinner', async () => {
    const fixture = createFixture()
    const input = bookInput(fixture, 0, 0, randomUUID())
    rpcBarrier = simultaneousBarrier(2)
    const results = await Promise.all([book(input), book(input)])
    rpcBarrier = { wait: async () => {} }

    expect(results.every((result) => result.ok)).toBe(true)
    const successful = results.filter((result) => result.ok)
    expect(successful.map((result) => result.reused).sort()).toEqual([false, true])
    expect(new Set(successful.map((result) => result.appointment.id)).size).toBe(1)
    expect(psql(`select count(*) from appointments where patient_id = '${input.patientId}' and idempotency_key = '${input.idempotencyKey}';`)).toBe('1')
    expect(
      psql(`select count(*) from appointment_transitions t join appointments a on a.id = t.appointment_id
             where a.patient_id = '${input.patientId}' and a.idempotency_key = '${input.idempotencyKey}';`),
    ).toBe('1')
  }, 15_000)

  test('constraintBackstop_directInsertPastRowLock_mapsExclusionToSlotUnavailableNotRaw23P01', async () => {
    const fixture = createFixture({ patientCount: 2 })
    psql(`create function booking_test_pause() returns trigger language plpgsql as $$
            begin
              if current_setting('application_name', true) = 'booking-bypass-probe' then
                perform pg_advisory_lock(${ADVISORY_LOCK_KEY});
                perform pg_advisory_unlock(${ADVISORY_LOCK_KEY});
              end if;
              return new;
            end $$;
          create trigger booking_test_pause before insert on appointments
          for each row execute function booking_test_pause();`)
    const lockProcess = await acquireAdvisoryLock()
    rpcApplicationName = 'booking-bypass-probe'
    const pending = book(bookInput(fixture, 0, 0))
    await waitUntilBookingIsPaused()

    psql(`set session_replication_role = replica;
          insert into appointments (slot_id, patient_id, provider_id, service_id, idempotency_key)
          values ('${fixture.slots[0]}', '${fixture.patients[1]!.id}', '${fixture.providerId}', '${fixture.serviceId}', '${randomUUID()}');`)
    await releaseAdvisoryLock(lockProcess)
    await expect(pending).resolves.toEqual({ ok: false, error: 'slot_unavailable' })
    rpcApplicationName = 'booking-concurrency-test'
    psql('drop trigger booking_test_pause on appointments; drop function booking_test_pause();')
    expect(psql(`select count(*) from appointments where slot_id = '${fixture.slots[0]}';`)).toBe('1')
  }, 15_000)

  test('crossPatientBooking_isRefusedByAppointmentsInsertOwnRls', async () => {
    const fixture = createFixture({ patientCount: 2 })
    const caller = fixture.patients[0]!
    const otherPatient = fixture.patients[1]!
    await expect(
      book({ ...bookInput(fixture, 0, 0), patientId: otherPatient.id, actorUserId: caller.actorUserId }),
    ).rejects.toThrow('booking: transactional write failed')
    expect(psql(`select count(*) from appointments where slot_id = '${fixture.slots[0]}';`)).toBe('0')
  })

  test('appRoleCannotUpdateSlotsStatus_theAttemptFailsRatherThanSilentlyWriting', () => {
    const fixture = createFixture()
    expectSqlState(
      appUserSql(fixture.patients[0]!.actorUserId, `update slots set status = 'booked' where id = '${fixture.slots[0]}';`),
      '42501',
    )
    expect(psql(`select status from slots where id = '${fixture.slots[0]}';`)).toBe('open')
  })

  test('bookPathAttemptingToUpdateSlots_failsUnderTheSecurityDefinerExecutor', async () => {
    const fixture = createFixture()
    psql(`create or replace function book_appointment(
            p_patient_id uuid, p_slot_id uuid, p_service_id uuid,
            p_idempotency_key text, p_actor_user_id uuid
          ) returns table (
            result_error text, result_reused boolean, appointment_id uuid,
            appointment_slot_id uuid, starts_at timestamptz, ends_at timestamptz,
            appointment_status appointment_status, provider_name text,
            provider_time_zone text, service_name text, out_of_hours boolean
          ) language plpgsql security definer set search_path = public as $$
          begin
            update slots set status = 'booked' where id = p_slot_id;
            return;
          end $$;
          alter function book_appointment(uuid,uuid,uuid,text,uuid) owner to booking_executor;
          revoke all on function book_appointment(uuid,uuid,uuid,text,uuid) from public;
          grant execute on function book_appointment(uuid,uuid,uuid,text,uuid) to app_user;`)

    await expect(book(bookInput(fixture, 0, 0))).rejects.toThrow('booking: transactional write failed')
    expect(psql(`select status from slots where id = '${fixture.slots[0]}';`)).toBe('open')
  })
})

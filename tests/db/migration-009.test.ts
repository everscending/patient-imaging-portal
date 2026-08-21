import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'

let run: Run
let patientUserId: string
let patientId: string
let providerUserId: string
let providerId: string
let adminUserId: string

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

function expectSqlState(sql: string, sqlState: string): void {
  try {
    execFileSync(
      'docker',
      ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-tAq', '-c', sql],
      { encoding: 'utf8' },
    )
  } catch (error) {
    expect(String((error as { stderr?: Buffer | string }).stderr ?? '')).toContain(sqlState)
    return
  }
  throw new Error(`expected SQLSTATE ${sqlState}`)
}

function asAppUser(claims: string | null, sql: string): string {
  const setting = claims === null ? '' : `set request.jwt.claims = ${sqlLiteral(claims)};`
  return `set role app_user; ${setting} ${sql}`
}

function asBookingExecutorLegacySubject(subject: string, sql: string): string {
  return `set role booking_executor; set request.jwt.claim.sub = ${sqlLiteral(subject)}; ${sql}`
}

beforeAll(async () => {
  run = await startRun(await ensureContainer())
  patientUserId = randomUUID()
  patientId = randomUUID()
  providerUserId = randomUUID()
  providerId = randomUUID()
  adminUserId = randomUUID()
  psql(`
    insert into auth.users (id) values ('${patientUserId}'), ('${providerUserId}'), ('${adminUserId}');
    insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email)
    values ('${patientId}', '${patientUserId}', 'PT-2961', '1990-01-01', 'Claim Patient', 'claim-patient@example.test');
    insert into providers (id, user_id, full_name, time_zone)
    values ('${providerId}', '${providerUserId}', 'Claim Provider', 'America/Chicago');
    insert into staff_admins (user_id) values ('${adminUserId}');
  `)
}, 60_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('009 hosted PostgREST JWT claims', () => {
  test('RLS identity helpers remain keyed to Supabase auth.uid()', () => {
    expect(
      psql(`
        select bool_and(
          pg_get_functiondef(signature) like '%auth.uid()%'
          and pg_get_functiondef(signature) not like '%current_request_user_id()%'
        )
        from unnest(array[
          'current_patient_id()'::regprocedure,
          'current_provider_id()'::regprocedure,
          'is_admin()'::regprocedure
        ]) as signature;
      `),
    ).toBe('t')
  })

  test('booking executor can invoke the RLS identity helpers its transactional functions require', () => {
    expect(psql(`
      select bool_and(has_function_privilege('booking_executor', signature, 'execute'))
      from unnest(array[
        'current_patient_id()'::regprocedure,
        'current_provider_id()'::regprocedure,
        'is_admin()'::regprocedure
      ]) as signature;
    `)).toBe('t')
  })

  test('patient subject resolves through request.jwt.claims', () => {
    const claims = JSON.stringify({ sub: patientUserId })
    expect(psql(asAppUser(claims, `select coalesce(current_patient_id()::text, '');`))).toBe(patientId)
  })

  test('provider subject resolves through request.jwt.claims', () => {
    const claims = JSON.stringify({ sub: providerUserId })
    expect(psql(asAppUser(claims, `select coalesce(current_provider_id()::text, '');`))).toBe(providerId)
  })

  test('admin subject resolves through request.jwt.claims', () => {
    const claims = JSON.stringify({ sub: adminUserId })
    expect(psql(asAppUser(claims, `select is_admin();`))).toBe('t')
  })

  test('transactional RPC adapter accepts the local PostgREST subject setting when claims are absent', () => {
    expect(psql(asBookingExecutorLegacySubject(patientUserId, 'select current_request_user_id()::text;'))).toBe(patientUserId)
  })

  test('missing claims fail closed without raising', () => {
    expect(psql(asAppUser(null, `select coalesce(current_patient_id()::text, 'null') || '|' || coalesce(current_provider_id()::text, 'null') || '|' || is_admin()::text;`))).toBe(
      'null|null|false',
    )
    expect(psql(asAppUser(null, `select count(*) from patients where id = '${patientId}';`))).toBe('0')
  })

  test('an unlinked subject fails closed', () => {
    const claims = JSON.stringify({ sub: randomUUID() })
    expect(psql(asAppUser(claims, `select coalesce(current_patient_id()::text, 'null') || '|' || coalesce(current_provider_id()::text, 'null') || '|' || is_admin()::text;`))).toBe(
      'null|null|false',
    )
    expect(psql(asAppUser(claims, `select count(*) from patients where id = '${patientId}';`))).toBe('0')
  })

  test.each(['not-json', JSON.stringify({ sub: 'not-a-uuid' })])('malformed claims fail closed without raising: %s', (claims) => {
    expect(psql(asAppUser(claims, `select coalesce(current_patient_id()::text, 'null') || '|' || coalesce(current_provider_id()::text, 'null') || '|' || is_admin()::text;`))).toBe(
      'null|null|false',
    )
    expect(psql(asAppUser(claims, `select count(*) from patients where id = '${patientId}';`))).toBe('0')
  })

  test.each([null, 'not-json', JSON.stringify({ sub: 'not-a-uuid' })])(
    'missing or malformed claims deny every transactional appointment RPC: %s',
    (claims) => {
      const actor = randomUUID()
      const calls = [
        `select * from book_appointment('${randomUUID()}', '${randomUUID()}', '${randomUUID()}', 'claim-test', '${actor}');`,
        `select * from reschedule_appointment('${randomUUID()}', '${randomUUID()}', '${actor}', interval '24 hours');`,
        `select * from cancel_appointment('${randomUUID()}', '${actor}', interval '24 hours');`,
        `select * from transition_appointment('${randomUUID()}', 'confirmed', '${actor}');`,
      ]
      for (const call of calls) expectSqlState(asAppUser(claims, call), '42501')
    },
  )
})

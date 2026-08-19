// JOR-225: focused adversarial coverage for ADR-0009's derived EC-8 seed
// fixture.  This uses only a throwaway local Postgres database, never a live
// app or provider.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { generateAssetPool } from '../../db/seed/assets'
import { runSeed, type AuthAdminClient, type SeedDbClient } from '../../db/seed/index'
import { buildRowSet } from '../../db/seed/rows'
import type { PhiStorageClient } from '../../db/seed/storage'
import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const DEFAULT_SEED = 'patient-imaging-portal'
const TEST_NOW = new Date('2026-08-15T12:00:00.000Z')
const MIN_CHANGE_NOTICE_HOURS = 24
const DB_TIMEOUT_MS = 90_000

function psql(dbName: string, sql: string): string {
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
  }).trim()
}

function psqlScript(dbName: string, sql: string): void {
  execFileSync('docker', ['exec', '-i', CONTAINER_NAME, 'psql', '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    encoding: 'utf8',
    input: sql,
  })
}

function installSessionScopedAuthUid(dbName: string): void {
  psql(
    dbName,
    `create or replace function auth.uid() returns uuid language sql stable
     as $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;`,
  )
}

function createStorage(): PhiStorageClient {
  return { storage: { from: () => ({ async list() { return { data: [], error: null } }, async upload() { return { data: {}, error: null } } }) } }
}

function createDb(dbName: string): SeedDbClient {
  return {
    async countRows(table) { return Number(psql(dbName, `select count(*) from ${table};`)) },
    async execute(sql) { psqlScript(dbName, sql) },
  }
}

function createAuth(dbName: string): AuthAdminClient {
  return {
    auth: { admin: { async createUser(attrs) {
      psql(dbName, `insert into auth.users (id) values ('${attrs.id}');`)
      return { data: { user: { id: attrs.id } }, error: null }
    } } },
  }
}

async function cleanSeed(run: Run): Promise<void> {
  await runSeed({
    storage: createStorage(), authAdmin: createAuth(run.dbName), db: createDb(run.dbName),
    sourceSeed: DEFAULT_SEED, now: TEST_NOW, minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS,
  })
}

let container: Container
let run: Run
const rowSet = buildRowSet({ pool: generateAssetPool(DEFAULT_SEED), sourceSeed: DEFAULT_SEED, now: TEST_NOW, minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS })
const fixtureAppointment = rowSet.fixtures.noticeWindowOutsideAppointmentId
const fixtureProvider = rowSet.fixtures.demoProviderId
const fixtureActor = rowSet.fixtures.demoProviderAuthId

beforeAll(async () => {
  container = await ensureContainer()
  run = await startRun(container)
  installSessionScopedAuthUid(run.dbName)
  await cleanSeed(run)
}, DB_TIMEOUT_MS)

afterAll(async () => { if (run) await stopRun(run) })

describe('mandatory adversarial: out-of-hours seed fixture', () => {
  test('adversarialNoDirectOutOfHoursAssignmentUnderSeedFiles', function adversarialNoDirectOutOfHoursAssignmentUnderSeedFiles() {
    const seedRoot = path.join(process.cwd(), 'db', 'seed')
    const source = readdirSync(seedRoot).filter((file) => file.endsWith('.ts')).map((file) => readFileSync(path.join(seedRoot, file), 'utf8')).join('\n')
    expect(source).not.toMatch(/\bout_of_hours\s*=/)
  })

  test('cleanFullSeedProducesOutOfHoursAppointment', function cleanFullSeedProducesOutOfHoursAppointment() {
    expect(Number(psql(run.dbName, 'select count(*) from appointments where out_of_hours;'))).toBeGreaterThan(0)
  })

  test('preservesBookedAppointmentInsteadOfDeletingOrRecreating', function preservesBookedAppointmentInsteadOfDeletingOrRecreating() {
    const actual = psql(run.dbName, `select a.id || '|' || s.starts_at || '|' || a.status || '|' || a.slot_id
      from appointments a join slots s on s.id = a.slot_id where a.id = '${fixtureAppointment}';`)
    const expected = rowSet.appointments.find((appointment) => appointment.id === fixtureAppointment)!
    const slot = rowSet.slots.find((candidate) => candidate.id === expected.slot_id)!
    expect(actual).toBe(`${expected.id}|${slot.starts_at.replace('T', ' ').replace('.000Z', '+00')}|${expected.status}|${expected.slot_id}`)
    expect(psql(run.dbName, `select out_of_hours from appointments where id = '${fixtureAppointment}';`)).toBe('t')
  })

  test('fixtureRunsAfterAppointmentsExist', function fixtureRunsAfterAppointmentsExist() {
    expect(Number(psql(run.dbName, `select count(*) from appointments where id = '${fixtureAppointment}';`))).toBe(1)
    expect(Number(psql(run.dbName, `select count(*) from audit_events where action = 'availability.update' and target_id = '${fixtureProvider}';`))).toBe(1)
  })

  test('providerHoursRemainUsableForLaterEdits', function providerHoursRemainUsableForLaterEdits() {
    const retainedHours = Number(psql(run.dbName, `select count(*) from working_hours where provider_id = '${fixtureProvider}';`))
    expect(retainedHours).toBeGreaterThan(0)
    psqlScript(run.dbName, `
      begin;
      select set_config('request.jwt.claims', '${JSON.stringify({ sub: fixtureActor })}', true);
      select * from apply_provider_availability(
        '${fixtureProvider}', '${fixtureActor}', 30,
        '[{"weekday":1,"startsLocal":"09:00:00","endsLocal":"12:00:00"}]'::jsonb,
        '[]'::jsonb,
        '${TEST_NOW.toISOString()}'::timestamptz,
        '${new Date(TEST_NOW.getTime() + 60 * 60 * 1000).toISOString()}'::timestamptz,
        array[]::tstzrange[]
      );
      commit;
    `)
    expect(Number(psql(run.dbName, `select count(*) from working_hours where provider_id = '${fixtureProvider}';`))).toBe(1)
  })

  test('repeatedCleanSeedsFlagSameAppointment', async function repeatedCleanSeedsFlagSameAppointment() {
    const second = await startRun(container)
    try {
      installSessionScopedAuthUid(second.dbName)
      await cleanSeed(second)
      expect(psql(second.dbName, 'select id from appointments where out_of_hours order by id limit 1;')).toBe(fixtureAppointment)
    } finally {
      await stopRun(second)
    }
  }, DB_TIMEOUT_MS)
})

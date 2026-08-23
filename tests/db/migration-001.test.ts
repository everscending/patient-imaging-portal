// Applies db/migrations/001_core.sql to a fresh pip_run_<random> database
// (ADR-0013) and asserts every constraint, trigger and index the ticket
// pins. auth.users / auth.uid() (§13) are stubbed by
// tests/setup/postgres.ts's startRun() for every run in this shared
// container — 001 is the first real migration to reference auth.*, so that
// stub lives there, not duplicated per test file. The cluster-global
// app_user role is provisioned idempotently and shared across run databases.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const MIGRATION_PATH = join(process.cwd(), 'db', 'migrations', '001_core.sql')

function psql(dbName: string, sql: string): string {
  // -q suppresses command completion tags ("INSERT 0 1") that -tA alone
  // does not — without it, RETURNING output gets that tag glued onto the
  // next line and corrupts anything parsing the result.
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
  }).trim()
}

// Runs `sql` and expects it to raise an exception in `sqlstateClass`
// (e.g. check_violation, unique_violation, foreign_key_violation). Throws
// if the statement instead succeeds or fails with a different class — a
// guard that doesn't fire and a guard that fires for the wrong reason both
// fail the assertion.
function expectGuard(dbName: string, sql: string, sqlstateClass: string): void {
  const block = `
    do $$
    begin
      begin
        ${sql}
        raise exception 'expected % but the statement succeeded', '${sqlstateClass}';
      exception when ${sqlstateClass} then
        null;
      end;
    end $$;
  `
  psql(dbName, block)
}

function buildMigrationDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pip-001-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8')

let container: Container
let mainRun: Run

// Sequential refs, not random slices: 'PT-' + 4 random hex chars is a
// 65k space and two fixtures in one run DB can collide on the unique
// patient_ref (it happened in CI — PT-3088). Same pattern as rls.test.ts,
// which reserves 9000+; this file reserves 8000–8499.
let patientReferenceSequence = 8000

function nextPatientReference(): string {
  if (patientReferenceSequence > 8499) {
    throw new Error('migration-001 patient fixture exhausted its reserved reference range')
  }
  return `PT-${String(patientReferenceSequence++).padStart(4, '0')}`
}

// Fresh patient/provider/visit/study chain for FK-dependent tests.
function seedChain(dbName: string) {
  const patientId = psql(
    dbName,
    `insert into patients (patient_ref, date_of_birth, full_name, email)
     values ('${nextPatientReference()}', '1990-01-01', 'Fixture Patient', 'fixture@example.com')
     returning id;`,
  )
  const providerId = psql(
    dbName,
    `insert into providers (full_name, time_zone) values ('Fixture Provider', 'America/Chicago') returning id;`,
  )
  const visitId = psql(
    dbName,
    `insert into visits (patient_id, provider_id, occurred_at, status)
     values ('${patientId}', '${providerId}', now(), 'scheduled') returning id;`,
  )
  const studyId = psql(
    dbName,
    `insert into studies (visit_id, patient_id, description) values ('${visitId}', '${patientId}', 'fixture study') returning id;`,
  )
  return { patientId, providerId, visitId, studyId }
}

beforeAll(async () => {
  container = await ensureContainer()
  mainRun = await startRun(container) // default dir: the real db/migrations, i.e. just 001
}, 60_000)

afterAll(async () => {
  if (mainRun) await stopRun(mainRun)
})

describe('AC: 001 applies clean to an empty database (fresh pip_run_<random>, auth stubbed)', () => {
  test('appliesCleanToFreshDatabase', function appliesCleanToFreshDatabase() {
    expect(mainRun.dbName).toMatch(/^pip_run_[0-9a-f]+$/)
    const tables = psql(mainRun.dbName, `select tablename from pg_tables where schemaname = 'public' order by tablename;`)
    expect(tables.split('\n')).toContain('patients')
  })
})

describe('AC: btree_gist is created first, before any other statement', () => {
  test('btreeGistFirstAndExists', function btreeGistFirstAndExists() {
    const statements = MIGRATION_SQL.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('--'))
    expect(statements[0]).toBe('create extension if not exists btree_gist;')

    const installed = psql(mainRun.dbName, `select extname from pg_extension where extname = 'btree_gist';`)
    expect(installed).toBe('btree_gist')
  })
})

describe('AC: role app_user exists, created before any statement naming it', () => {
  test('appUserRoleCreatedFirst', function appUserRoleCreatedFirst() {
    // Statements only — a comment is allowed to explain the ordering
    // rationale (and does, quoting `app_user`) before the real statement.
    const statementsOnly = MIGRATION_SQL.split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    const createIndex = statementsOnly.indexOf('create role app_user nologin;')
    expect(createIndex).toBeGreaterThan(-1)
    const otherReferences = [...statementsOnly.matchAll(/app_user/g)]
      .map((m) => m.index!)
      .filter((index) => index !== createIndex + 'create role '.length)
    for (const index of otherReferences) {
      expect(index).toBeGreaterThan(createIndex)
    }

    const role = psql(mainRun.dbName, `select rolname from pg_roles where rolname = 'app_user' and rolcanlogin = false;`)
    expect(role).toBe('app_user')
  })
})

describe('AC: all five enums exist with exactly the values pinned above', () => {
  test('allFiveEnumsExactValues', function allFiveEnumsExactValues() {
    const expected: Record<string, string[]> = {
      slot_status: ['open', 'booked'],
      appointment_status: ['requested', 'confirmed', 'completed', 'cancelled', 'no_show'],
      report_status: ['preliminary', 'signed'],
      visit_status: ['scheduled', 'completed', 'cancelled'],
      actor_kind: ['account', 'share_recipient', 'system', 'anonymous'],
    }
    const rows = psql(
      mainRun.dbName,
      `select t.typname || '|' || e.enumlabel
       from pg_type t join pg_enum e on t.oid = e.enumtypid
       where t.typname in ('slot_status','appointment_status','report_status','visit_status','actor_kind')
       order by t.typname, e.enumsortorder;`,
    )
      .split('\n')
      .map((line) => line.split('|'))

    const grouped: Record<string, string[]> = {}
    for (const [typname, label] of rows) {
      grouped[typname] ??= []
      grouped[typname].push(label)
    }

    expect(Object.keys(grouped).sort()).toEqual(Object.keys(expected).sort())
    for (const [typname, labels] of Object.entries(expected)) {
      expect(grouped[typname]).toEqual(labels)
    }
  })
})

describe("AC + adversarial: providers.time_zone is guarded by a trigger, not a CHECK", () => {
  test('providerTimeZoneGuard', function providerTimeZoneGuard() {
    expectGuard(
      mainRun.dbName,
      `insert into providers (full_name, time_zone) values ('Bad TZ', 'America/Chicagoo');`,
      'check_violation',
    )
    const validId = psql(
      mainRun.dbName,
      `insert into providers (full_name, time_zone) values ('Good TZ', 'America/Chicago') returning id;`,
    )
    expect(validId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('AC + adversarial: providers.slot_minutes is bounded 5..240', () => {
  test('providerSlotMinutesBoundsRejected', function providerSlotMinutesBoundsRejected() {
    expectGuard(
      mainRun.dbName,
      `insert into providers (full_name, time_zone, slot_minutes) values ('SM 4', 'America/Chicago', 4);`,
      'check_violation',
    )
    expectGuard(
      mainRun.dbName,
      `insert into providers (full_name, time_zone, slot_minutes) values ('SM 241', 'America/Chicago', 241);`,
      'check_violation',
    )
  })
})

describe('AC + adversarial: reports.signed_fields_present holds both ways', () => {
  test('reportsSignedFieldsBothDirections', function reportsSignedFieldsBothDirections() {
    const { patientId, studyId } = seedChain(mainRun.dbName)
    const providerId = psql(
      mainRun.dbName,
      `insert into providers (full_name, time_zone) values ('Signer', 'America/Chicago') returning id;`,
    )

    // Adversarial: signed report with signed_at null.
    expectGuard(
      mainRun.dbName,
      `insert into reports (study_id, patient_id, status, findings, impression, signed_by, signed_at)
       values ('${studyId}', '${patientId}', 'signed', 'f', 'i', '${providerId}', null);`,
      'check_violation',
    )
    // signed report with signed_by null.
    expectGuard(
      mainRun.dbName,
      `insert into reports (study_id, patient_id, status, findings, impression, signed_by, signed_at)
       values ('${studyId}', '${patientId}', 'signed', 'f', 'i', null, now());`,
      'check_violation',
    )
    // Adversarial: preliminary report with signed_by set.
    expectGuard(
      mainRun.dbName,
      `insert into reports (study_id, patient_id, status, findings, impression, signed_by, signed_at)
       values ('${studyId}', '${patientId}', 'preliminary', 'f', 'i', '${providerId}', null);`,
      'check_violation',
    )
    // preliminary report with signed_at set.
    expectGuard(
      mainRun.dbName,
      `insert into reports (study_id, patient_id, status, findings, impression, signed_by, signed_at)
       values ('${studyId}', '${patientId}', 'preliminary', 'f', 'i', null, now());`,
      'check_violation',
    )

    // Both valid shapes insert cleanly.
    const preliminaryId = psql(
      mainRun.dbName,
      `insert into reports (study_id, patient_id, status, findings, impression)
       values ('${studyId}', '${patientId}', 'preliminary', 'f', 'i') returning id;`,
    )
    expect(preliminaryId).toMatch(/^[0-9a-f-]{36}$/)
    const signedId = psql(
      mainRun.dbName,
      `insert into reports (study_id, patient_id, status, findings, impression, signed_by, signed_at)
       values ('${studyId}', '${patientId}', 'signed', 'f', 'i', '${providerId}', now()) returning id;`,
    )
    expect(signedId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('AC: images and reports each carry unique (id, patient_id); images also (study_id, ordinal)', () => {
  test('uniqueConstraintsPresent', function uniqueConstraintsPresent() {
    function uniqueColumnSets(table: string): Set<string>[] {
      const rows = psql(
        mainRun.dbName,
        `select tc.constraint_name || '|' || kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
         where tc.constraint_type = 'UNIQUE' and tc.table_name = '${table}'
         order by tc.constraint_name, kcu.ordinal_position;`,
      )
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.split('|'))

      const grouped = new Map<string, string[]>()
      for (const [name, column] of rows) {
        const cols = grouped.get(name) ?? []
        cols.push(column)
        grouped.set(name, cols)
      }
      return [...grouped.values()].map((cols) => new Set(cols))
    }

    const imageSets = uniqueColumnSets('images')
    expect(imageSets).toContainEqual(new Set(['study_id', 'ordinal']))
    expect(imageSets).toContainEqual(new Set(['id', 'patient_id']))

    const reportSets = uniqueColumnSets('reports')
    expect(reportSets).toContainEqual(new Set(['id', 'patient_id']))
  })
})

describe('adversarial: two images with the same (study_id, ordinal)', () => {
  test('duplicateImageOrdinalRejected', function duplicateImageOrdinalRejected() {
    const { patientId, studyId } = seedChain(mainRun.dbName)
    const insertImage = (ordinal: number) =>
      `insert into images (study_id, patient_id, storage_key, width, height, ordinal)
       values ('${studyId}', '${patientId}', '${randomUUID()}', 100, 100, ${ordinal});`

    psql(mainRun.dbName, insertImage(1))
    expectGuard(mainRun.dbName, insertImage(1), 'unique_violation')
  })
})

describe('AC + adversarial: cine_clips.frame_count and default_fps bounds', () => {
  test('cineClipsFrameCountAndFpsBounds', function cineClipsFrameCountAndFpsBounds() {
    const { patientId, studyId } = seedChain(mainRun.dbName)
    const insertClip = (frameCount: number, fps?: number) =>
      `insert into cine_clips (study_id, patient_id, frame_count${fps !== undefined ? ', default_fps' : ''})
       values ('${studyId}', '${patientId}', ${frameCount}${fps !== undefined ? `, ${fps}` : ''}) returning id, default_fps;`

    // Accepts the boundary values.
    const lowId = psql(mainRun.dbName, insertClip(1))
    expect(lowId).toMatch(/^[0-9a-f-]{36}\|12$/) // default_fps defaults to 12
    psql(mainRun.dbName, insertClip(100))

    // Rejects out-of-range frame_count.
    expectGuard(mainRun.dbName, insertClip(0), 'check_violation')
    // Adversarial: a cine clip with frame_count 101.
    expectGuard(mainRun.dbName, insertClip(101), 'check_violation')

    // default_fps rejects out-of-range values.
    expectGuard(mainRun.dbName, insertClip(10, 0), 'check_violation')
    expectGuard(mainRun.dbName, insertClip(10, 61), 'check_violation')
  })
})

describe('adversarial: a cine frame with frame_index -1', () => {
  test('cineFrameNegativeIndexRejected', function cineFrameNegativeIndexRejected() {
    const { patientId, studyId } = seedChain(mainRun.dbName)
    const clipId = psql(
      mainRun.dbName,
      `insert into cine_clips (study_id, patient_id, frame_count) values ('${studyId}', '${patientId}', 5) returning id;`,
    )
    expectGuard(
      mainRun.dbName,
      `insert into cine_frames (clip_id, frame_index, storage_key) values ('${clipId}', -1, '${randomUUID()}');`,
      'check_violation',
    )
  })
})

describe('AC: cine_frames has primary key (clip_id, frame_index)', () => {
  test('cineFramesPrimaryKey', function cineFramesPrimaryKey() {
    const { patientId, studyId } = seedChain(mainRun.dbName)
    const clipId = psql(
      mainRun.dbName,
      `insert into cine_clips (study_id, patient_id, frame_count) values ('${studyId}', '${patientId}', 5) returning id;`,
    )
    psql(mainRun.dbName, `insert into cine_frames (clip_id, frame_index, storage_key) values ('${clipId}', 0, '${randomUUID()}');`)
    expectGuard(
      mainRun.dbName,
      `insert into cine_frames (clip_id, frame_index, storage_key) values ('${clipId}', 0, '${randomUUID()}');`,
      'unique_violation',
    )

    const pkColumns = psql(
      mainRun.dbName,
      `select kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
       where tc.constraint_type = 'PRIMARY KEY' and tc.table_name = 'cine_frames'
       order by kcu.ordinal_position;`,
    ).split('\n')
    expect(pkColumns).toEqual(['clip_id', 'frame_index'])
  })
})

describe('adversarial: two patients with the same patient_ref', () => {
  test('duplicatePatientRefRejected', function duplicatePatientRefRejected() {
    const ref = nextPatientReference()
    psql(
      mainRun.dbName,
      `insert into patients (patient_ref, date_of_birth, full_name, email)
       values ('${ref}', '1990-01-01', 'First', 'first@example.com');`,
    )
    expectGuard(
      mainRun.dbName,
      `insert into patients (patient_ref, date_of_birth, full_name, email)
       values ('${ref}', '1991-02-02', 'Second', 'second@example.com');`,
      'unique_violation',
    )
  })
})

describe('adversarial: two accounts (patients rows) linked to the same patients.user_id', () => {
  test('duplicatePatientUserIdRejected', function duplicatePatientUserIdRejected() {
    const userId = psql(mainRun.dbName, `insert into auth.users default values returning id;`)
    psql(
      mainRun.dbName,
      `insert into patients (user_id, patient_ref, date_of_birth, full_name, email)
       values ('${userId}', '${nextPatientReference()}', '1990-01-01', 'First', 'first@example.com');`,
    )
    expectGuard(
      mainRun.dbName,
      `insert into patients (user_id, patient_ref, date_of_birth, full_name, email)
       values ('${userId}', '${nextPatientReference()}', '1990-01-01', 'Second', 'second@example.com');`,
      'unique_violation',
    )
  })
})

describe('adversarial: a study referencing a visit that does not exist', () => {
  test('studyInvalidVisitFkRejected', function studyInvalidVisitFkRejected() {
    const patientId = psql(
      mainRun.dbName,
      `insert into patients (patient_ref, date_of_birth, full_name, email)
       values ('${nextPatientReference()}', '1990-01-01', 'Fixture', 'fixture2@example.com') returning id;`,
    )
    expectGuard(
      mainRun.dbName,
      `insert into studies (visit_id, patient_id, description) values ('${randomUUID()}', '${patientId}', 'orphan study');`,
      'foreign_key_violation',
    )
  })
})

describe("AC: every index the pinned block declares exists (pg_indexes)", () => {
  test('pinnedForeignKeyIndexesExist', function pinnedForeignKeyIndexesExist() {
    const indexdefs = psql(mainRun.dbName, `select indexdef from pg_indexes where schemaname = 'public';`).split('\n')
    const hasIndexOn = (table: string, columnPattern: string) =>
      indexdefs.some((def) => def.includes(`ON public.${table} `) && new RegExp(`\\(${columnPattern}\\)`).test(def))

    expect(hasIndexOn('identity_attempts', 'attempted_patient_ref, attempted_at DESC')).toBe(true)
    expect(hasIndexOn('identity_attempts', 'source_ref, attempted_at DESC')).toBe(true)
    expect(hasIndexOn('visits', 'patient_id, status')).toBe(true)
    expect(hasIndexOn('studies', 'patient_id')).toBe(true)
    expect(hasIndexOn('reports', 'patient_id, status')).toBe(true)
    expect(hasIndexOn('cine_clips', 'study_id')).toBe(true)
    expect(hasIndexOn('cine_frames', 'clip_id')).toBe(true)
    expect(hasIndexOn('images', 'study_id')).toBe(true)
    expect(hasIndexOn('reports', 'study_id')).toBe(true)
    expect(hasIndexOn('studies', 'visit_id')).toBe(true)
    expect(hasIndexOn('visits', 'provider_id')).toBe(true)
    expect(hasIndexOn('provider_services', 'service_id')).toBe(true)
  })
})

describe('AC: 001 creates no policy and enables RLS on no table', () => {
  test(
    'noRlsNoPolicies',
    async function noRlsNoPolicies() {
      // Scoped to 001 alone via its own migrationsDir — `mainRun` applies the
      // whole db/migrations directory, and JOR-234's 003_rls.sql (which lands
      // after this ticket) enables RLS and adds policies on top of 001+002.
      // That is 003's own AC, not a regression here; this test's name promises
      // "001 creates no policy", so it has to isolate 001 to keep meaning that.
      const dir = buildMigrationDir({ '001_core.sql': MIGRATION_SQL })
      let run: Run | undefined
      try {
        run = await startRun(container, dir)
        const rlsEnabledTables = psql(
          run.dbName,
          `select relname from pg_class
           where relnamespace = 'public'::regnamespace and relrowsecurity = true;`,
        )
        expect(rlsEnabledTables).toBe('')

        const policyCount = psql(run.dbName, `select count(*) from pg_policies where schemaname = 'public';`)
        expect(policyCount).toBe('0')
      } finally {
        rmSync(dir, { recursive: true, force: true })
        if (run) await stopRun(run)
      }
    },
    30_000,
  )
})

describe('adversarial: applying 001 to a database where btree_gist was dropped mid-file', () => {
  test(
    'btreeGistDroppedMidFileStillApplies',
    async function btreeGistDroppedMidFileStillApplies() {
      // 001 itself contains no EXCLUDE constraint or gist index (those are
      // 002's job) — dropping the extension right after it is created must
      // not stop the rest of 001 from applying. Splice the drop in right
      // after the real `create extension` statement, not literal line 1
      // (the file opens with comment lines).
      const marker = 'create extension if not exists btree_gist;'
      const markerIndex = MIGRATION_SQL.indexOf(marker)
      expect(markerIndex).toBeGreaterThan(-1)
      const spliceAt = markerIndex + marker.length
      const mutated = `${MIGRATION_SQL.slice(0, spliceAt)}\ndrop extension btree_gist;${MIGRATION_SQL.slice(spliceAt)}`

      const dir = buildMigrationDir({ '001_core.sql': mutated })
      let run: Run | undefined
      try {
        run = await startRun(container, dir)
        const tables = psql(run.dbName, `select tablename from pg_tables where schemaname = 'public' order by tablename;`)
        expect(tables.split('\n')).toContain('reports')
      } finally {
        rmSync(dir, { recursive: true, force: true })
        if (run) await stopRun(run)
      }
    },
    30_000,
  )
})

// tests/db/epic-e1.test.ts — E1's own confirmation (JOR-259 / T14, blocked by
// T8-T13). Migrates (001-003) and seeds (db/seed/index.ts) a real,
// throwaway pip_run_<random> database (ADR-0013) and proves the three
// database-level guarantees hold against the REAL, produced ~50-patient
// delivery dataset — never a per-test synthetic single row — and never as
// the migration-running superuser/table owner, which bypasses RLS entirely
// (§13, ARCHITECTURE.md §4). No application code is in the path anywhere in
// this file: every query below is raw SQL against pip-testpg via `psql`,
// never an HTTP call or a `lib/access/guard.ts` import.
//
// Every guarantee this file checks is already proven generically, at the
// schema level, against synthetic single-row fixtures by
// tests/db/rls.test.ts, tests/db/migration-002.test.ts and
// tests/seed/rows.test.ts (T8-T13) — this file introduces no new rule (E1's
// own "no new scope" design decision). What it adds is the one thing a
// synthetic-fixture test cannot show: that those rules also hold once
// db/seed/index.ts has actually run end to end and produced ADR-0009's real
// delivery dataset.
//
// Reproducibility is asserted over image and frame ASSETS only, never row
// timestamps — appointment instants are relative to the seed run (T13), so a
// byte-identical claim over rows would be false by construction (E1's design
// decision). `config.seedSourceSeed`'s default is mirrored below as a
// literal, without importing lib/config.ts, so this file stays
// network/environment-free like tests/seed/assets.test.ts.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { generateAssetPool, type AssetPool } from '../../db/seed/assets'
import { runSeed, type AuthAdminClient, type SeedDbClient } from '../../db/seed/index'
import { buildRowSet, DEMO_ADMIN_EMAIL, DEMO_PATIENT_EMAIL, DEMO_PROVIDER_EMAIL, PATIENT_COUNT, PROVIDER_COUNT, type RowSet } from '../../db/seed/rows'
import type { PhiStorageClient } from '../../db/seed/storage'
import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const THIS_FILE = path.join(process.cwd(), 'tests', 'db', 'epic-e1.test.ts')
const ARTIFACT_PATH = path.join(process.cwd(), 'tests', 'db', 'artifacts', 'epic-e1-run.json')

// Mirrors lib/config.ts's SEED_SOURCE_SEED default without importing
// lib/config.ts — same rationale as tests/seed/assets.test.ts.
const DEFAULT_SEED = 'patient-imaging-portal'
// Matches the `now` the implementation lane's own live seed run used
// (tests/seed/artifacts/rows-run.json), so this file's locally-built rowSet
// is byte-for-byte the one the Live check block cross-checks against.
const SEED_NOW = new Date('2026-08-15T20:23:37.136Z')
const MIN_CHANGE_NOTICE_HOURS = 24

const SETUP_TIMEOUT_MS = 180_000
const GENERATE_TIMEOUT_MS = 30_000

function psql(dbName: string, sql: string): string {
  // -q suppresses command completion tags ("INSERT 0 1") that -tA alone
  // does not — without it, RETURNING output gets that tag glued onto the
  // next line and corrupts anything parsing the result.
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
  }).trim()
}

function psqlScript(dbName: string, sql: string): void {
  execFileSync('docker', ['exec', '-i', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    encoding: 'utf8',
    input: sql,
    maxBuffer: 32 * 1024 * 1024,
  })
}

// Runs `sqlScript` and expects the whole thing to fail with `sqlstate` — a
// throwaway session per call, so a `set role app_user; ...; <the failing
// statement>` script needs no cleanup (Postgres rolls the whole script back
// on any error). Same helper shape as tests/db/rls.test.ts's own.
function expectRawFailure(dbName: string, sqlScript: string, sqlstate: string): void {
  try {
    execFileSync(
      'docker',
      ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-tAq', '-c', sqlScript],
      { encoding: 'utf8' },
    )
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '')
    expect(stderr).toContain(sqlstate)
    return
  }
  throw new Error(`expected sqlstate ${sqlstate} but the statement(s) succeeded: ${sqlScript}`)
}

// Every "as app_user" assertion in this suite routes through this helper —
// `set role app_user` first, always. `claimUserId` is the JWT `sub`; `null`
// means no claim at all.
function appUserScript(claimUserId: string | null, sql: string): string {
  const claim = claimUserId !== null ? `set request.jwt.claims = '${JSON.stringify({ sub: claimUserId })}';` : ''
  return `set role app_user; ${claim} ${sql}`
}

function createFakeStorageClient(): PhiStorageClient {
  return {
    storage: {
      from() {
        return {
          async list() {
            return { data: [], error: null }
          },
          async upload() {
            return { data: {}, error: null }
          },
        }
      },
    },
  }
}

function createDbClient(dbName: string): SeedDbClient {
  return {
    async countRows(table) {
      return Number(psql(dbName, `select count(*) from ${table};`))
    },
    async execute(sql) {
      psqlScript(dbName, sql)
    },
  }
}

function createDockerAuthAdminClient(dbName: string): AuthAdminClient {
  return {
    auth: {
      admin: {
        async createUser(attrs) {
          psql(dbName, `insert into auth.users (id) values ('${attrs.id}') on conflict do nothing;`)
          return { data: { user: { id: attrs.id } }, error: null }
        },
      },
    },
  }
}

function manifestOf(p: AssetPool, kind: 'still' | 'cine-frame'): { key: string; sha256: string }[] {
  return p.assets
    .filter((a) => a.kind === kind)
    .map((a) => ({ key: a.key, sha256: a.sha256 }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function aggregateSha256(manifest: { key: string; sha256: string }[]): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

let container: Container
let run: Run
let pool: AssetPool
let rowSet: RowSet

beforeAll(async () => {
  pool = generateAssetPool(DEFAULT_SEED)
  rowSet = buildRowSet({ pool, sourceSeed: DEFAULT_SEED, now: SEED_NOW, minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS })

  container = await ensureContainer()
  run = await startRun(container) // default dir: db/migrations — 001, 002, 003 applied in filename order

  await runSeed({
    storage: createFakeStorageClient(),
    authAdmin: createDockerAuthAdminClient(run.dbName),
    db: createDbClient(run.dbName),
    sourceSeed: DEFAULT_SEED,
    now: SEED_NOW,
    minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS,
  })
}, SETUP_TIMEOUT_MS)

afterAll(async () => {
  if (run) await stopRun(run)
})

// ═══════════════════════════════════════════════════════════════════════
// AC 1: clean checkout → migrate → seed produces the delivery dataset
// ═══════════════════════════════════════════════════════════════════════

describe('AC 1: migrate 001-003 then db/seed/index.ts produces the delivery dataset — ~50 patients, ~10 providers, and the three demo accounts', () => {
  test('deliveryDatasetRowCountsAndDemoAccountsMatchSpec', function deliveryDatasetRowCountsAndDemoAccountsMatchSpec() {
    expect(Number(psql(run.dbName, 'select count(*) from patients;'))).toBe(PATIENT_COUNT)
    expect(Number(psql(run.dbName, 'select count(*) from providers;'))).toBe(PROVIDER_COUNT)
    expect(Number(psql(run.dbName, 'select count(*) from visits;'))).toBeGreaterThan(0)
    expect(Number(psql(run.dbName, 'select count(*) from studies;'))).toBeGreaterThan(0)
    expect(Number(psql(run.dbName, 'select count(*) from images;'))).toBeGreaterThan(0)
    expect(Number(psql(run.dbName, 'select count(*) from cine_clips;'))).toBeGreaterThan(0)
    expect(Number(psql(run.dbName, 'select count(*) from reports;'))).toBeGreaterThan(0)
    expect(Number(psql(run.dbName, 'select count(*) from services;'))).toBeGreaterThan(0)
    expect(Number(psql(run.dbName, 'select count(*) from slots;'))).toBeGreaterThan(0)

    // The three DEMO_*_EMAIL addresses live only in Supabase Auth
    // (auth.admin.createUser), never as a column in these tables — the
    // presence check is the linked row keyed to the deterministic auth id
    // buildRowSet computed for each.
    expect(
      psql(run.dbName, `select id from patients where id = '${rowSet.fixtures.demoPatientId}' and user_id = '${rowSet.fixtures.demoPatientAuthId}';`),
    ).toBe(rowSet.fixtures.demoPatientId)
    expect(
      psql(run.dbName, `select id from providers where id = '${rowSet.fixtures.demoProviderId}' and user_id = '${rowSet.fixtures.demoProviderAuthId}';`),
    ).toBe(rowSet.fixtures.demoProviderId)
    expect(psql(run.dbName, `select user_id from staff_admins where user_id = '${rowSet.fixtures.demoAdminAuthId}';`)).toBe(
      rowSet.fixtures.demoAdminAuthId,
    )
    expect([DEMO_PATIENT_EMAIL, DEMO_PROVIDER_EMAIL, DEMO_ADMIN_EMAIL]).toEqual([
      'patient@demo.pip.test',
      'provider@demo.pip.test',
      'admin@demo.pip.test',
    ])
  })

  test('mandatory adversarial: a dataset missing one of the three demo accounts is detected', function adversarialDatasetMissingADemoAccountIsDetected() {
    // Deletes the seeded demo admin's own staff_admins row — this run's
    // throwaway pip_run_* database only, dropped in afterAll regardless of
    // this test — and re-runs the exact presence query the acceptance test
    // above uses, proving it reports the gap instead of silently passing.
    psql(run.dbName, `delete from staff_admins where user_id = '${rowSet.fixtures.demoAdminAuthId}';`)
    expect(psql(run.dbName, `select user_id from staff_admins where user_id = '${rowSet.fixtures.demoAdminAuthId}';`)).toBe('')

    // Restored so every later test in this file still sees the full
    // delivery dataset the acceptance test above already proved correct.
    psql(run.dbName, `insert into staff_admins (user_id) values ('${rowSet.fixtures.demoAdminAuthId}');`)
    expect(psql(run.dbName, `select user_id from staff_admins where user_id = '${rowSet.fixtures.demoAdminAuthId}';`)).toBe(
      rowSet.fixtures.demoAdminAuthId,
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AC 2: re-running the seed reproduces byte-identical image and frame assets
// ═══════════════════════════════════════════════════════════════════════

describe('AC 2: re-running the seed from config.seedSourceSeed reproduces byte-identical image and frame assets', () => {
  test(
    'seedReproducesByteIdenticalImageAndFrameAssetsAcrossTwoRuns',
    function seedReproducesByteIdenticalImageAndFrameAssetsAcrossTwoRuns() {
      const again = generateAssetPool(DEFAULT_SEED)
      expect(manifestOf(again, 'still')).toEqual(manifestOf(pool, 'still'))
      expect(manifestOf(again, 'cine-frame')).toEqual(manifestOf(pool, 'cine-frame'))
      expect(again.totalBytes).toBe(pool.totalBytes)
      expect(again.missingKey).toBe(pool.missingKey)
    },
    GENERATE_TIMEOUT_MS,
  )

  test(
    'mandatory adversarial: a second generation run producing different image or frame bytes is never treated as identical',
    function adversarialSecondRunDifferentBytesNeverTreatedAsIdentical() {
      const differentSeed = generateAssetPool(`${DEFAULT_SEED}-e1-adversarial`)
      expect(manifestOf(differentSeed, 'still')).not.toEqual(manifestOf(pool, 'still'))
      expect(manifestOf(differentSeed, 'cine-frame')).not.toEqual(manifestOf(pool, 'cine-frame'))

      const tamperedFrames = manifestOf(pool, 'cine-frame').map((entry, index) =>
        index === 0 ? { ...entry, sha256: `${entry.sha256.slice(0, -1)}0` } : entry,
      )
      expect(tamperedFrames).not.toEqual(manifestOf(pool, 'cine-frame'))
    },
    GENERATE_TIMEOUT_MS,
  )
})

// ═══════════════════════════════════════════════════════════════════════
// AC 3: RLS refuses a cross-patient read at the database layer, no
// application code in the path
// ═══════════════════════════════════════════════════════════════════════

describe('AC 3: RLS refuses a cross-patient read at the database layer, no application code in the path', () => {
  // patientA: the one real seeded patient with a linked account (the demo
  // patient). patientB: a different real seeded patient — deliberately the
  // one buildRowSet itself leaves unlinked (fixtures.unlinkedPatientId) —
  // with its own real studies/images/clips/reports, never logged in. The
  // real, production-shaped dataset: 49 of 50 seeded patients are unlinked
  // by design, so this is the realistic cross-patient scenario, not a
  // symmetric synthetic pair. Resolved in beforeAll, not at describe-body
  // scope — `rowSet` is only populated once the outer beforeAll above runs.
  let patientA: RowSet['patients'][number]
  let patientB: RowSet['patients'][number]

  beforeAll(() => {
    patientA = rowSet.patients.find((p) => p.id === rowSet.fixtures.demoPatientId)!
    patientB = rowSet.patients.find((p) => p.id === rowSet.fixtures.unlinkedPatientId)!
  })

  function firstFor<T extends { patient_id: string }>(rows: T[], patientId: string): T {
    const row = rows.find((r) => r.patient_id === patientId)
    if (!row) throw new Error(`no seeded row for patient ${patientId}`)
    return row
  }

  function firstSignedReportFor(patientId: string) {
    return rowSet.reports.find((r) => r.patient_id === patientId && r.status === 'signed')!
  }

  test('patientCannotReadAnotherPatientsStudiesImagesClipsFramesOrReportsInTheRealDataset', function patientCannotReadAnotherPatientsStudiesImagesClipsFramesOrReportsInTheRealDataset() {
    const studyA = firstFor(rowSet.studies, patientA.id)
    const studyB = firstFor(rowSet.studies, patientB.id)
    const imageA = firstFor(rowSet.images, patientA.id)
    const imageB = firstFor(rowSet.images, patientB.id)
    const clipA = firstFor(rowSet.cineClips, patientA.id)
    const clipB = firstFor(rowSet.cineClips, patientB.id)
    const frameA = rowSet.cineFrames.find((f) => f.clip_id === clipA.id)!
    const frameB = rowSet.cineFrames.find((f) => f.clip_id === clipB.id)!
    // Signed reports only — FR-7 hides preliminary reports from every
    // patient, including their own, and that is a different rule than the
    // cross-patient isolation this test asserts (tests/db/rls.test.ts's own
    // patientCannotSeeOwnPreliminaryReportProviderCan already covers FR-7).
    const reportA = firstSignedReportFor(patientA.id)
    const reportB = firstSignedReportFor(patientB.id)

    expect(psql(run.dbName, appUserScript(patientA.user_id, `select id from studies where id in ('${studyA.id}','${studyB.id}') order by id;`))).toBe(
      studyA.id,
    )
    expect(psql(run.dbName, appUserScript(patientA.user_id, `select id from images where id in ('${imageA.id}','${imageB.id}') order by id;`))).toBe(
      imageA.id,
    )
    expect(
      psql(run.dbName, appUserScript(patientA.user_id, `select id from cine_clips where id in ('${clipA.id}','${clipB.id}') order by id;`)),
    ).toBe(clipA.id)
    expect(
      psql(
        run.dbName,
        appUserScript(
          patientA.user_id,
          `select distinct clip_id from cine_frames where clip_id in ('${frameA.clip_id}','${frameB.clip_id}') order by clip_id;`,
        ),
      ),
    ).toBe(clipA.id)
    expect(psql(run.dbName, appUserScript(patientA.user_id, `select id from reports where id in ('${reportA.id}','${reportB.id}') order by id;`))).toBe(
      reportA.id,
    )
  })

  test('mandatory adversarial: a cross-patient read that succeeds because it ran as the table owner is not accepted as evidence', function adversarialOwnerBypassSeesBothPatientsProvingOwnerRunIsNotEvidence() {
    const studyA = firstFor(rowSet.studies, patientA.id)
    const studyB = firstFor(rowSet.studies, patientB.id)
    // As postgres — the migration-running role, owner of every table here —
    // with no role switch and no claim: RLS is bypassed entirely (§13), so
    // both rows are visible. This is exactly why the acceptance test above
    // runs as app_user instead: proving isolation as the owner would prove
    // nothing.
    expect(psql(run.dbName, `select count(*) from studies where id in ('${studyA.id}','${studyB.id}');`)).toBe('2')
  })

  test('mandatory adversarial: this file never routes a cross-patient read through application code — every query here is raw SQL against pip-testpg', function adversarialThisFileNeverRoutesThroughApplicationCode() {
    const source = readFileSync(THIS_FILE, 'utf8')
    expect(source).not.toMatch(/from ['"][^'"]*\/app\//)
    expect(source).not.toMatch(/from ['"][^'"]*lib\/access\/guard/)
    // Built by concatenation, and described without spelling either literal
    // out, so this very assertion's own source text never matches itself.
    const httpCallMarker = ['fe', 'tch('].join('')
    const navigationMarker = ['page.go', 'to('].join('')
    expect(source).not.toContain(httpCallMarker)
    expect(source).not.toContain(navigationMarker)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AC 4: an update or delete against the audit table is rejected
// ═══════════════════════════════════════════════════════════════════════

describe('AC 4: an update or delete against audit_events is rejected — append-only structurally, not by convention', () => {
  test('auditEventsRejectUpdateAndDeleteAsAppUserInsertAndAdminSelectSucceed', function auditEventsRejectUpdateAndDeleteAsAppUserInsertAndAdminSelectSucceed() {
    const marker = `e1-probe-${randomUUID()}`
    // No RETURNING here: `audit_select_admin` (is_admin()) is the table's
    // only SELECT policy, and RETURNING on an INSERT requires that same
    // SELECT policy to pass for the row being returned — app_user with no
    // admin claim can never satisfy it. The INSERT itself is unconditional
    // (`audit_insert_any` — with check (true)), so it still succeeds; the
    // admin-scoped SELECT below is how this test reads the row back.
    psql(
      run.dbName,
      appUserScript(
        null,
        `insert into audit_events (actor_kind, action, target_kind, outcome, detail) values ('system', 'audit.view', 'audit_events', 'granted', '{"marker":"${marker}"}');`,
      ),
    )

    expectRawFailure(run.dbName, appUserScript(null, `update audit_events set outcome = 'denied' where detail->>'marker' = '${marker}';`), '42501')
    expectRawFailure(run.dbName, appUserScript(null, `delete from audit_events where detail->>'marker' = '${marker}';`), '42501')

    const adminSees = psql(
      run.dbName,
      appUserScript(rowSet.fixtures.demoAdminAuthId, `select count(*) from audit_events where detail->>'marker' = '${marker}';`),
    )
    expect(adminSees).toBe('1')
  })

  test('mandatory adversarial: UPDATE and DELETE on audit_events are blocked by the grant catalogue, not by accident — restoring the grant flips it', function adversarialAuditUpdateDeleteBlockedByGrantCatalogueNotByAccident() {
    expect(psql(run.dbName, `select has_table_privilege('app_user', 'public.audit_events', 'UPDATE');`)).toBe('f')
    expect(psql(run.dbName, `select has_table_privilege('app_user', 'public.audit_events', 'DELETE');`)).toBe('f')

    // Rolled back at the end: the same catalogue bit the 42501s above depend
    // on flips true the moment the grant is restored — proof the acceptance
    // test's failure traces to this grant's absence, not a coincidence.
    const withGrantRestored = psql(
      run.dbName,
      `begin;
       grant update, delete on audit_events to app_user;
       select has_table_privilege('app_user', 'public.audit_events', 'UPDATE')::text || '|' || has_table_privilege('app_user', 'public.audit_events', 'DELETE')::text;
       rollback;`,
    )
    expect(withGrantRestored).toBe('true|true') // ::text cast of a bare boolean prints the full word, not the column-display 't'/'f'

    // the rollback undid the grant too — the acceptance test's guarantee still holds
    expect(psql(run.dbName, `select has_table_privilege('app_user', 'public.audit_events', 'UPDATE');`)).toBe('f')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AC 5: two appointments cannot exist for one slot
// ═══════════════════════════════════════════════════════════════════════

describe('AC 5: two appointments cannot exist for one slot — appointments_one_live_per_slot rejects the second write', () => {
  function realLiveAppointment() {
    const appointmentId = rowSet.fixtures.statusAppointmentIds.confirmed
    const appointment = rowSet.appointments.find((a) => a.id === appointmentId)!
    const otherPatient = rowSet.patients.find((p) => p.id !== appointment.patient_id)!
    return { appointment, otherPatient }
  }

  test('secondLiveAppointmentOnAnAlreadyBookedRealSeededSlotIsRejected', function secondLiveAppointmentOnAnAlreadyBookedRealSeededSlotIsRejected() {
    const { appointment, otherPatient } = realLiveAppointment()
    expect(psql(run.dbName, `select status from appointments where id = '${appointment.id}';`)).toBe('confirmed')

    expectRawFailure(
      run.dbName,
      `insert into appointments (slot_id, patient_id, provider_id, service_id, status)
       values ('${appointment.slot_id}', '${otherPatient.id}', '${appointment.provider_id}', '${appointment.service_id}', 'requested');`,
      '23P01', // exclusion_violation
    )
  })

  test('mandatory adversarial: a second live appointment on that same slot succeeds only if appointments_one_live_per_slot is absent, proving the check is not vacuous', function adversarialSecondLiveAppointmentSucceedsOnlyWithoutTheConstraint() {
    const { appointment, otherPatient } = realLiveAppointment()

    const withoutConstraint = psql(
      run.dbName,
      `begin;
       alter table appointments drop constraint appointments_one_live_per_slot;
       insert into appointments (slot_id, patient_id, provider_id, service_id, status)
       values ('${appointment.slot_id}', '${otherPatient.id}', '${appointment.provider_id}', '${appointment.service_id}', 'requested')
       returning status;
       rollback;`,
    )
    expect(withoutConstraint).toBe('requested')

    // the rollback undid the drop too — the acceptance test's guarantee still holds
    expectRawFailure(
      run.dbName,
      `insert into appointments (slot_id, patient_id, provider_id, service_id, status)
       values ('${appointment.slot_id}', '${otherPatient.id}', '${appointment.provider_id}', '${appointment.service_id}', 'requested');`,
      '23P01',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Live check — the one real contact with the phi bucket already happened in
// this epic's own implementation lane (tests/seed/artifacts/pool-run.json,
// rows-run.json, JOR-256/JOR-250) and is re-derived offline here, plus this
// ticket's own committed run record (tests/db/artifacts/epic-e1-run.json) —
// the gate never calls a live provider (loom's Live-check convention, same
// as tests/seed/assets.test.ts and tests/seed/rows.test.ts).
// ═══════════════════════════════════════════════════════════════════════

describe('Live check: the committed E1 run record still matches the current deterministic generation', () => {
  test(
    'liveCheckArtifactRowCountsAndAssetManifestsMatchCurrentGeneration',
    function liveCheckArtifactRowCountsAndAssetManifestsMatchCurrentGeneration() {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as {
      seed: string
      now: string
      minChangeNoticeHours: number
      rowCounts: Record<string, number>
      imageAssetManifest: { count: number; sha256Digest: string }
      frameAssetManifest: { count: number; sha256Digest: string }
      demoAccounts: { patient: string; provider: string; admin: string }
      assertions: Record<string, 'pass'>
    }

    const currentPool = generateAssetPool(artifact.seed)
    const currentRowSet = buildRowSet({
      pool: currentPool,
      sourceSeed: artifact.seed,
      now: new Date(artifact.now),
      minChangeNoticeHours: artifact.minChangeNoticeHours,
    })

    expect(currentRowSet.patients).toHaveLength(artifact.rowCounts.patients)
    expect(currentRowSet.providers).toHaveLength(artifact.rowCounts.providers)
    expect(currentRowSet.studies).toHaveLength(artifact.rowCounts.studies)
    expect(currentRowSet.images).toHaveLength(artifact.rowCounts.images)
    expect(currentRowSet.cineClips).toHaveLength(artifact.rowCounts.cine_clips)
    expect(currentRowSet.cineFrames).toHaveLength(artifact.rowCounts.cine_frames)
    expect(currentRowSet.reports).toHaveLength(artifact.rowCounts.reports)
    expect(currentRowSet.slots).toHaveLength(artifact.rowCounts.slots)

    expect(manifestOf(currentPool, 'still')).toHaveLength(artifact.imageAssetManifest.count)
    expect(aggregateSha256(manifestOf(currentPool, 'still'))).toBe(artifact.imageAssetManifest.sha256Digest)
    expect(manifestOf(currentPool, 'cine-frame')).toHaveLength(artifact.frameAssetManifest.count)
    expect(aggregateSha256(manifestOf(currentPool, 'cine-frame'))).toBe(artifact.frameAssetManifest.sha256Digest)

    expect(artifact.demoAccounts).toEqual({ patient: DEMO_PATIENT_EMAIL, provider: DEMO_PROVIDER_EMAIL, admin: DEMO_ADMIN_EMAIL })
    for (const outcome of Object.values(artifact.assertions)) expect(outcome).toBe('pass')
    },
    GENERATE_TIMEOUT_MS,
  )
})

describe('mandatory adversarial: db/seed/rows.ts and index.ts reach no wall clock and no non-seeded randomness', () => {
  test('adversarialNoDateNowMathRandomOrRandomUuidInSeedEntryPoint', function adversarialNoDateNowMathRandomOrRandomUuidInSeedEntryPoint() {
    for (const file of ['db/seed/rows.ts', 'db/seed/index.ts']) {
      const content = readFileSync(path.join(process.cwd(), file), 'utf8')
      expect(content).not.toContain('Date.now(')
      expect(content).not.toContain('Math.random(')
      expect(content).not.toContain('randomUUID(')
    }
  })
})

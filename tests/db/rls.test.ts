// Applies every forward migration to a fresh pip_run_<random> database
// (ADR-0013) and proves ARCHITECTURE.md §4's row-level security actually
// took: the enabled-check, every read and write policy, and the grant
// catalogue, all asserted as `app_user` — never as the migration-running
// superuser/owner, which bypasses RLS entirely and would prove nothing
// (§4, and this file's own ownerBypassSeesAllPatientsProvingOwnerRunsAreNotEvidence).
//
// Hosted PostgREST supplies the session JWT through `request.jwt.claims`.
// Every app_user assertion below sets that exact JSON shape so this suite
// exercises the same identity boundary as production.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const MIGRATION_003_PATH = join(process.cwd(), 'db', 'migrations', '003_rls.sql')
const MIGRATION_003_SQL = readFileSync(MIGRATION_003_PATH, 'utf8')

function psql(dbName: string, sql: string): string {
  // -q suppresses command completion tags ("INSERT 0 1") that -tA alone
  // does not — without it, RETURNING output gets that tag glued onto the
  // next line and corrupts anything parsing the result.
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
  }).trim()
}

// For a failure a DO block cannot catch cleanly here: role-switch privilege
// and RLS with-check failures. Each call is its own throwaway session, so a
// `set role app_user; ...; <the failing statement>` script needs no cleanup —
// Postgres rolls the whole multi-statement script back on any error.
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

function futureTs(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString()
}

// Every "as app_user" assertion in this suite routes through this one
// helper — `set role app_user` first, always — which is what
// appUserIsActiveRoleNeitherSuperuserNorTableOwner below asserts actually
// puts you in app_user's seat rather than leaving you as the connecting
// superuser. `claimUserId` is the JWT `sub`; `null` means no claims setting at
// all (the anonymous-session case).
function appUserScript(claimUserId: string | null, sql: string): string {
  const claim = claimUserId !== null ? `set request.jwt.claims = '${JSON.stringify({ sub: claimUserId })}';` : ''
  return `set role app_user; ${claim} ${sql}`
}

// §4 pins RLS + a policy on exactly 14 tables (13 in the enable block plus
// audit_events) and exempts email_outbox by name. Every other table in the
// schema — services, provider_services, staff_admins, working_hours,
// availability_blocks, reminder_sends, appointment_transitions — holds no
// patient-identifying data and is never named in §4 at all: not PHI, so
// never a candidate for RLS in the first place. "Holds PHI" isn't something
// a check can derive from the catalogue alone, so this list — like the
// email_outbox exemption itself — is the reviewed, by-name record of what's
// deliberately out of scope. A table that is not on it and not RLS-enabled
// is presumed PHI until proven otherwise, which is what lets this same
// check catch a genuinely new, unwired table (enabledCheckCatchesTableMissingRlsEnable).
const NON_PHI_TABLES = [
  'email_outbox',
  'services',
  'provider_services',
  'staff_admins',
  'working_hours',
  'availability_blocks',
  'reminder_sends',
  'appointment_transitions',
]

function rlsGapTables(dbName: string): string {
  const exempt = NON_PHI_TABLES.map((t) => `'${t}'`).join(',')
  return psql(
    dbName,
    `select relname from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r'
       and relname not in (${exempt}) and relrowsecurity = false
     order by relname;`,
  )
}

function insertAuthUser(dbName: string): string {
  return psql(dbName, `insert into auth.users default values returning id;`)
}

let patientReferenceSequence = 9000

function nextPatientReference(): string {
  if (patientReferenceSequence > 9999) {
    throw new Error('RLS patient fixture exhausted its reserved reference range')
  }
  return `PT-${String(patientReferenceSequence++).padStart(4, '0')}`
}

function insertPatient(dbName: string, userId: string | null = null): string {
  const userLiteral = userId === null ? 'null' : `'${userId}'`
  return psql(
    dbName,
    `insert into patients (user_id, patient_ref, date_of_birth, full_name, email)
     values (${userLiteral}, '${nextPatientReference()}', '1990-01-01', 'Patient ${randomUUID().slice(0, 4)}', 'p${randomUUID().slice(0, 8)}@example.com')
     returning id;`,
  )
}

function insertProvider(dbName: string, userId: string | null = null): string {
  const userLiteral = userId === null ? 'null' : `'${userId}'`
  return psql(
    dbName,
    `insert into providers (user_id, full_name, time_zone) values (${userLiteral}, 'Provider ${randomUUID().slice(0, 4)}', 'America/Chicago') returning id;`,
  )
}

function insertStaffAdmin(dbName: string, userId: string): string {
  return psql(dbName, `insert into staff_admins (user_id) values ('${userId}') returning id;`)
}

function insertService(dbName: string): string {
  return psql(dbName, `insert into services (slug, name) values ('svc-${randomUUID().slice(0, 8)}', 'Test Service') returning id;`)
}

function insertVisit(dbName: string, patientId: string, providerId: string): string {
  return psql(
    dbName,
    `insert into visits (patient_id, provider_id, occurred_at, status) values ('${patientId}', '${providerId}', now(), 'scheduled') returning id;`,
  )
}

function insertStudy(dbName: string, visitId: string, patientId: string): string {
  return psql(dbName, `insert into studies (visit_id, patient_id, description) values ('${visitId}', '${patientId}', 'fixture study') returning id;`)
}

function insertImage(dbName: string, studyId: string, patientId: string, ordinal = 1): string {
  return psql(
    dbName,
    `insert into images (study_id, patient_id, storage_key, width, height, ordinal)
     values ('${studyId}', '${patientId}', '${randomUUID()}', 100, 100, ${ordinal}) returning id;`,
  )
}

function insertCineClip(dbName: string, studyId: string, patientId: string): string {
  return psql(dbName, `insert into cine_clips (study_id, patient_id, frame_count) values ('${studyId}', '${patientId}', 5) returning id;`)
}

function insertCineFrame(dbName: string, clipId: string, frameIndex = 0): void {
  psql(dbName, `insert into cine_frames (clip_id, frame_index, storage_key) values ('${clipId}', ${frameIndex}, '${randomUUID()}');`)
}

function insertReport(dbName: string, studyId: string, patientId: string, status: 'preliminary' | 'signed', signedBy?: string): string {
  if (status === 'signed') {
    return psql(
      dbName,
      `insert into reports (study_id, patient_id, status, findings, impression, signed_by, signed_at)
       values ('${studyId}', '${patientId}', 'signed', 'f', 'i', '${signedBy}', now()) returning id;`,
    )
  }
  return psql(
    dbName,
    `insert into reports (study_id, patient_id, status, findings, impression) values ('${studyId}', '${patientId}', 'preliminary', 'f', 'i') returning id;`,
  )
}

function insertSlot(dbName: string, providerId: string, startsAt: string, endsAt: string): string {
  return psql(dbName, `insert into slots (provider_id, starts_at, ends_at) values ('${providerId}', '${startsAt}', '${endsAt}') returning id;`)
}

function insertAppointment(
  dbName: string,
  opts: { slotId: string; patientId: string; providerId: string; serviceId: string; status?: string },
): string {
  const status = opts.status ?? 'requested'
  return psql(
    dbName,
    `insert into appointments (slot_id, patient_id, provider_id, service_id, status)
     values ('${opts.slotId}', '${opts.patientId}', '${opts.providerId}', '${opts.serviceId}', '${status}') returning id;`,
  )
}

function insertIdentityAttempt(dbName: string): string {
  return psql(
    dbName,
    `insert into identity_attempts (attempted_patient_ref, source_ref, succeeded)
     values ('PT-${randomUUID().slice(0, 4)}', 'src-${randomUUID().slice(0, 8)}', false) returning id;`,
  )
}

function insertAuditEvent(dbName: string): string {
  return psql(
    dbName,
    `insert into audit_events (actor_kind, action, target_kind, outcome) values ('system', 'study.view', 'study', 'granted') returning id;`,
  )
}

function insertDeletionRequest(dbName: string, patientId: string, requestedBy: string): string {
  return psql(dbName, `insert into deletion_requests (patient_id, requested_by) values ('${patientId}', '${requestedBy}') returning id;`)
}

let container: Container
let mainRun: Run

beforeAll(async () => {
  container = await ensureContainer()
  mainRun = await startRun(container)
}, 60_000)

afterAll(async () => {
  if (mainRun) await stopRun(mainRun)
})

describe('AC: 003 applies clean on top of 002', () => {
  test('migrationAppliesCleanOnTopOf002', function migrationAppliesCleanOnTopOf002() {
    const functionCount = psql(
      mainRun.dbName,
      `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('current_patient_id','current_provider_id','is_admin');`,
    )
    expect(functionCount).toBe('3')

    const enabledCount = psql(
      mainRun.dbName,
      `select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity = true;`,
    )
    expect(enabledCount).toBe('14')

    expect(psql(mainRun.dbName, `select has_table_privilege('app_user', 'public.email_outbox', 'INSERT');`)).toBe('t')
    expect(psql(mainRun.dbName, `select has_table_privilege('app_user', 'public.email_outbox', 'UPDATE');`)).toBe('t')
    expect(psql(mainRun.dbName, `select has_table_privilege('app_user', 'public.deletion_requests', 'INSERT');`)).toBe('t')
    expect(
      psql(
        mainRun.dbName,
        `select has_function_privilege('app_user', 'regenerate_provider_slots(uuid,timestamptz,timestamptz,tstzrange[])', 'EXECUTE');`,
      ),
    ).toBe('t')
  })
})

describe('AC: pg_tables.rowsecurity is true for all 14 pinned tables', () => {
  test('rowSecurityEnabledOnAllFourteenPhiTables', function rowSecurityEnabledOnAllFourteenPhiTables() {
    const pinnedTables = [
      'patients',
      'providers',
      'visits',
      'studies',
      'images',
      'cine_clips',
      'cine_frames',
      'reports',
      'appointments',
      'slots',
      'identity_attempts',
      'share_links',
      'deletion_requests',
      'audit_events',
    ]
    const rows = psql(
      mainRun.dbName,
      `select relname || '|' || relrowsecurity::text from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r'
         and relname = any(array[${pinnedTables.map((t) => `'${t}'`).join(',')}])
       order by relname;`,
    )
      .split('\n')
      .map((line) => line.split('|'))
    expect(rows.length).toBe(pinnedTables.length)
    for (const [, enabled] of rows) {
      expect(enabled).toBe('true') // relrowsecurity::text, not the raw boolean output form
    }

    // AC: "the test fails on any false" — a generic scan, not the hardcoded
    // list above, so it also proves nothing else in the schema is missing.
    expect(rlsGapTables(mainRun.dbName)).toBe('')
  })
})

describe("AC: email_outbox is exempted by name in the enabled-check, with §4's reason recorded alongside it", () => {
  test('emailOutboxExemptedByNameWithReasonRecordedInMigration', function emailOutboxExemptedByNameWithReasonRecordedInMigration() {
    expect(MIGRATION_003_SQL).toMatch(/email_outbox[\s\S]{0,400}service role/i)

    const emailOutboxRls = psql(
      mainRun.dbName,
      `select relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'email_outbox';`,
    )
    expect(emailOutboxRls).toBe('f')
  })
})

describe('adversarial: a policy created on a table whose RLS was never enabled is caught by the enabled-check', () => {
  test('enabledCheckCatchesTableMissingRlsEnable', function enabledCheckCatchesTableMissingRlsEnable() {
    expect(rlsGapTables(mainRun.dbName)).toBe('')

    // Rolled back at the end — this only proves the check's shape, it does
    // not leave a stray table behind for later tests. Same exemption list
    // rlsGapTables uses, inlined because this has to run inside the same
    // transaction as the probe table so the rollback also undoes it.
    const exempt = NON_PHI_TABLES.map((t) => `'${t}'`).join(',')
    const probe = psql(
      mainRun.dbName,
      `begin;
       create table rls_probe_missing_enable (id uuid primary key default gen_random_uuid());
       create policy rls_probe_missing_enable_select on rls_probe_missing_enable for select using (true);
       select relname from pg_class
         where relnamespace = 'public'::regnamespace and relkind = 'r'
           and relname not in (${exempt}) and relrowsecurity = false
         order by relname;
       rollback;`,
    )
    expect(probe).toBe('rls_probe_missing_enable')
  })
})

describe('AC: zero tables have RLS enabled and no policy', () => {
  test('zeroTablesEnabledWithoutAtLeastOnePolicy', function zeroTablesEnabledWithoutAtLeastOnePolicy() {
    const orphans = psql(
      mainRun.dbName,
      `select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity = true
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname);`,
    )
    expect(orphans).toBe('')
  })
})

describe('AC + adversarial: a patient sees own studies, never another patient study', () => {
  test('patientSeesOwnStudiesNotPatientBs', function patientSeesOwnStudiesNotPatientBs() {
    const providerId = insertProvider(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const visitA = insertVisit(mainRun.dbName, patientA, providerId)
    const studyA = insertStudy(mainRun.dbName, visitA, patientA)

    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const visitB = insertVisit(mainRun.dbName, patientB, providerId)
    const studyB = insertStudy(mainRun.dbName, visitB, patientB)

    const seenByA = psql(
      mainRun.dbName,
      appUserScript(userA, `select id from studies where id in ('${studyA}','${studyB}') order by id;`),
    )
    expect(seenByA).toBe(studyA)
  })
})

describe('AC + adversarial: a patient sees own images, never another patient image', () => {
  test('patientSeesOwnImagesNotPatientBs', function patientSeesOwnImagesNotPatientBs() {
    const providerId = insertProvider(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const visitA = insertVisit(mainRun.dbName, patientA, providerId)
    const studyA = insertStudy(mainRun.dbName, visitA, patientA)
    const imageA = insertImage(mainRun.dbName, studyA, patientA)

    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const visitB = insertVisit(mainRun.dbName, patientB, providerId)
    const studyB = insertStudy(mainRun.dbName, visitB, patientB)
    const imageB = insertImage(mainRun.dbName, studyB, patientB)

    const seenByA = psql(
      mainRun.dbName,
      appUserScript(userA, `select id from images where id in ('${imageA}','${imageB}') order by id;`),
    )
    expect(seenByA).toBe(imageA)
  })
})

describe('AC + adversarial: a patient sees own cine clips, never another patient clip', () => {
  test('patientSeesOwnCineClipsNotPatientBs', function patientSeesOwnCineClipsNotPatientBs() {
    const providerId = insertProvider(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const visitA = insertVisit(mainRun.dbName, patientA, providerId)
    const studyA = insertStudy(mainRun.dbName, visitA, patientA)
    const clipA = insertCineClip(mainRun.dbName, studyA, patientA)

    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const visitB = insertVisit(mainRun.dbName, patientB, providerId)
    const studyB = insertStudy(mainRun.dbName, visitB, patientB)
    const clipB = insertCineClip(mainRun.dbName, studyB, patientB)

    const seenByA = psql(mainRun.dbName, appUserScript(userA, `select id from cine_clips where id in ('${clipA}','${clipB}') order by id;`))
    expect(seenByA).toBe(clipA)
  })
})

describe('AC + adversarial: a patient sees own cine frames (via clip), never another patient frame', () => {
  test('patientSeesOwnCineFramesNotPatientBsViaClip', function patientSeesOwnCineFramesNotPatientBsViaClip() {
    const providerId = insertProvider(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const visitA = insertVisit(mainRun.dbName, patientA, providerId)
    const studyA = insertStudy(mainRun.dbName, visitA, patientA)
    const clipA = insertCineClip(mainRun.dbName, studyA, patientA)
    insertCineFrame(mainRun.dbName, clipA, 0)

    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const visitB = insertVisit(mainRun.dbName, patientB, providerId)
    const studyB = insertStudy(mainRun.dbName, visitB, patientB)
    const clipB = insertCineClip(mainRun.dbName, studyB, patientB)
    insertCineFrame(mainRun.dbName, clipB, 0)

    const seenByA = psql(
      mainRun.dbName,
      appUserScript(userA, `select clip_id from cine_frames where clip_id in ('${clipA}','${clipB}') order by clip_id;`),
    )
    expect(seenByA).toBe(clipA)
  })
})

describe('AC + adversarial: a patient sees own signed report, never another patient report', () => {
  test('patientSeesOwnSignedReportNotPatientBsReports', function patientSeesOwnSignedReportNotPatientBsReports() {
    const providerId = insertProvider(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const visitA = insertVisit(mainRun.dbName, patientA, providerId)
    const studyA = insertStudy(mainRun.dbName, visitA, patientA)
    const reportA = insertReport(mainRun.dbName, studyA, patientA, 'signed', providerId)

    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const visitB = insertVisit(mainRun.dbName, patientB, providerId)
    const studyB = insertStudy(mainRun.dbName, visitB, patientB)
    insertReport(mainRun.dbName, studyB, patientB, 'signed', providerId)

    const seenByA = psql(
      mainRun.dbName,
      appUserScript(userA, `select id from reports where study_id in ('${studyA}','${studyB}') order by id;`),
    )
    expect(seenByA).toBe(reportA)
  })
})

describe('AC + adversarial: a patient sees own appointments, never another patient appointment', () => {
  test('patientSeesOwnAppointmentsNotPatientBs', function patientSeesOwnAppointmentsNotPatientBs() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const slotA = insertSlot(mainRun.dbName, providerId, futureTs(1), futureTs(2))
    const apptA = insertAppointment(mainRun.dbName, { slotId: slotA, patientId: patientA, providerId, serviceId })

    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const slotB = insertSlot(mainRun.dbName, providerId, futureTs(3), futureTs(4))
    const apptB = insertAppointment(mainRun.dbName, { slotId: slotB, patientId: patientB, providerId, serviceId })

    const seenByA = psql(
      mainRun.dbName,
      appUserScript(userA, `select id from appointments where id in ('${apptA}','${apptB}') order by id;`),
    )
    expect(seenByA).toBe(apptA)
  })
})

describe('AC + adversarial: a patient sees exactly their own patients row, zero foreign dates of birth', () => {
  test('patientSeesExactlyOwnPatientsRowZeroForeignDob', function patientSeesExactlyOwnPatientsRowZeroForeignDob() {
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)

    const seenByA = psql(
      mainRun.dbName,
      appUserScript(userA, `select id from patients where id in ('${patientA}','${patientB}') order by id;`),
    )
    expect(seenByA).toBe(patientA)

    const foreignDobs = psql(mainRun.dbName, appUserScript(userA, `select date_of_birth::text from patients where id <> '${patientA}';`))
    expect(foreignDobs).toBe('')
  })
})

describe('AC + adversarial: FR-7 — a patient never sees a preliminary report, including their own; the owning provider does', () => {
  test('patientCannotSeeOwnPreliminaryReportProviderCan', function patientCannotSeeOwnPreliminaryReportProviderCan() {
    const providerUser = insertAuthUser(mainRun.dbName)
    const providerId = insertProvider(mainRun.dbName, providerUser)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const visitA = insertVisit(mainRun.dbName, patientA, providerId)
    const studyA = insertStudy(mainRun.dbName, visitA, patientA)
    const prelimId = insertReport(mainRun.dbName, studyA, patientA, 'preliminary')

    const patientSees = psql(mainRun.dbName, appUserScript(userA, `select id from reports where id = '${prelimId}';`))
    expect(patientSees).toBe('')

    const providerSees = psql(mainRun.dbName, appUserScript(providerUser, `select id from reports where id = '${prelimId}';`))
    expect(providerSees).toBe(prelimId)
  })
})

describe('AC: a session with no request.jwt.claims reads zero rows and raises no error', () => {
  test('noJwtClaimReadsZeroRowsNoError', function noJwtClaimReadsZeroRowsNoError() {
    const userA = insertAuthUser(mainRun.dbName)
    insertPatient(mainRun.dbName, userA)

    // psql() throws in this test file whenever the statement raises a
    // Postgres error — this test not throwing IS the "raises no error"
    // half of the assertion, not merely incidental.
    const patients = psql(mainRun.dbName, appUserScript(null, `select count(*) from patients;`))
    expect(patients).toBe('0')

    const appointments = psql(mainRun.dbName, appUserScript(null, `select count(*) from appointments;`))
    expect(appointments).toBe('0')
  })
})

describe('AC + adversarial: a patient reads zero identity_attempts, an admin reads them', () => {
  test('patientReadsZeroIdentityAttemptsAdminReadsAll', function patientReadsZeroIdentityAttemptsAdminReadsAll() {
    insertIdentityAttempt(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    insertPatient(mainRun.dbName, userA)
    const adminUser = insertAuthUser(mainRun.dbName)
    insertStaffAdmin(mainRun.dbName, adminUser)

    const patientCount = psql(mainRun.dbName, appUserScript(userA, `select count(*) from identity_attempts;`))
    expect(patientCount).toBe('0')

    const adminCount = psql(mainRun.dbName, appUserScript(adminUser, `select count(*) from identity_attempts;`))
    expect(Number(adminCount)).toBeGreaterThanOrEqual(1)
  })
})

describe('AC + adversarial: a patient reads zero audit_events, an admin reads them', () => {
  test('patientReadsZeroAuditEventsAdminReadsAll', function patientReadsZeroAuditEventsAdminReadsAll() {
    insertAuditEvent(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    insertPatient(mainRun.dbName, userA)
    const adminUser = insertAuthUser(mainRun.dbName)
    insertStaffAdmin(mainRun.dbName, adminUser)

    const patientCount = psql(mainRun.dbName, appUserScript(userA, `select count(*) from audit_events;`))
    expect(patientCount).toBe('0')

    const adminCount = psql(mainRun.dbName, appUserScript(adminUser, `select count(*) from audit_events;`))
    expect(Number(adminCount)).toBeGreaterThanOrEqual(1)
  })
})

describe('AC + adversarial: a patient books for themselves; naming another patient is refused', () => {
  test('patientInsertsOwnAppointmentForeignPatientIdRefused', function patientInsertsOwnAppointmentForeignPatientIdRefused() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const slot1 = insertSlot(mainRun.dbName, providerId, futureTs(5), futureTs(6))
    const slot2 = insertSlot(mainRun.dbName, providerId, futureTs(7), futureTs(8))

    const ownAppt = psql(
      mainRun.dbName,
      appUserScript(
        userA,
        `insert into appointments (slot_id, patient_id, provider_id, service_id)
         values ('${slot1}', '${patientA}', '${providerId}', '${serviceId}') returning id;`,
      ),
    )
    expect(ownAppt).toMatch(/^[0-9a-f-]{36}$/)

    expectRawFailure(
      mainRun.dbName,
      appUserScript(
        userA,
        `insert into appointments (slot_id, patient_id, provider_id, service_id)
         values ('${slot2}', '${patientB}', '${providerId}', '${serviceId}');`,
      ),
      '42501',
    )
  })
})

describe('AC + adversarial: a patient shares their own image; naming another patient is refused', () => {
  test('patientInsertsOwnShareLinkForeignPatientIdRefused', function patientInsertsOwnShareLinkForeignPatientIdRefused() {
    const providerId = insertProvider(mainRun.dbName)
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const visitA = insertVisit(mainRun.dbName, patientA, providerId)
    const studyA = insertStudy(mainRun.dbName, visitA, patientA)
    const imageA = insertImage(mainRun.dbName, studyA, patientA)

    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const visitB = insertVisit(mainRun.dbName, patientB, providerId)
    const studyB = insertStudy(mainRun.dbName, visitB, patientB)
    const imageB = insertImage(mainRun.dbName, studyB, patientB)

    const createdBy = insertAuthUser(mainRun.dbName)

    const ownLink = psql(
      mainRun.dbName,
      appUserScript(
        userA,
        `insert into share_links (token_hash, patient_id, image_id, created_by, recipient_email, expires_at)
         values ('${randomUUID()}', '${patientA}', '${imageA}', '${createdBy}', 'recipient@example.com', '${futureTs(72)}')
         returning id;`,
      ),
    )
    expect(ownLink).toMatch(/^[0-9a-f-]{36}$/)

    // imageB genuinely belongs to patientB — a valid target on its own — so
    // this fails purely on the mismatched patient_id, not on the composite FK.
    expectRawFailure(
      mainRun.dbName,
      appUserScript(
        userA,
        `insert into share_links (token_hash, patient_id, image_id, created_by, recipient_email, expires_at)
         values ('${randomUUID()}', '${patientB}', '${imageB}', '${createdBy}', 'recipient@example.com', '${futureTs(72)}');`,
      ),
      '42501',
    )
  })
})

describe('AC + adversarial: a patient inserts a deletion request for themselves and reads it back', () => {
  test('patientInsertsOwnDeletionRequestAndReadsItBack', function patientInsertsOwnDeletionRequestAndReadsItBack() {
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)

    const insertedId = psql(
      mainRun.dbName,
      appUserScript(userA, `insert into deletion_requests (patient_id, requested_by) values ('${patientA}', '${userA}') returning id;`),
    )
    expect(insertedId).toMatch(/^[0-9a-f-]{36}$/)

    const readBack = psql(mainRun.dbName, appUserScript(userA, `select id from deletion_requests where id = '${insertedId}';`))
    expect(readBack).toBe(insertedId)
  })
})

describe("AC + adversarial: naming another patient's patient_id on a deletion request is refused", () => {
  test('patientInsertsDeletionRequestForeignPatientIdRefused', function patientInsertsDeletionRequestForeignPatientIdRefused() {
    const userA = insertAuthUser(mainRun.dbName)
    insertPatient(mainRun.dbName, userA)
    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)

    expectRawFailure(
      mainRun.dbName,
      appUserScript(userA, `insert into deletion_requests (patient_id, requested_by) values ('${patientB}', '${userA}');`),
      '42501',
    )
  })
})

describe("AC + adversarial: a patient cannot see another patient's deletion_requests row", () => {
  test('patientCannotSeeAnotherPatientsDeletionRequest', function patientCannotSeeAnotherPatientsDeletionRequest() {
    const userA = insertAuthUser(mainRun.dbName)
    insertPatient(mainRun.dbName, userA)
    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)
    const requestedByB = insertAuthUser(mainRun.dbName)
    const deletionRequestB = insertDeletionRequest(mainRun.dbName, patientB, requestedByB)

    const seenByA = psql(mainRun.dbName, appUserScript(userA, `select id from deletion_requests where id = '${deletionRequestB}';`))
    expect(seenByA).toBe('')
  })
})

describe('AC + adversarial: a provider generates their own slot; naming another provider is refused', () => {
  test('providerInsertsOwnSlotForeignProviderIdRefused', function providerInsertsOwnSlotForeignProviderIdRefused() {
    const providerUserX = insertAuthUser(mainRun.dbName)
    const providerX = insertProvider(mainRun.dbName, providerUserX)
    const providerY = insertProvider(mainRun.dbName)

    const ownSlot = psql(
      mainRun.dbName,
      appUserScript(
        providerUserX,
        `insert into slots (provider_id, starts_at, ends_at) values ('${providerX}', '${futureTs(9)}', '${futureTs(10)}') returning id;`,
      ),
    )
    expect(ownSlot).toMatch(/^[0-9a-f-]{36}$/)

    expectRawFailure(
      mainRun.dbName,
      appUserScript(
        providerUserX,
        `insert into slots (provider_id, starts_at, ends_at) values ('${providerY}', '${futureTs(11)}', '${futureTs(12)}');`,
      ),
      '42501',
    )
  })
})

describe('AC: as app_user, email_outbox insert and update succeed', () => {
  test('appUserEmailOutboxInsertAndUpdateSucceed', function appUserEmailOutboxInsertAndUpdateSucceed() {
    const insertedId = psql(
      mainRun.dbName,
      appUserScript(null, `insert into email_outbox (recipient, subject, body) values ('to@example.com', 'Reminder', 'body') returning id;`),
    )
    expect(insertedId).toMatch(/^[0-9a-f-]{36}$/)

    const updated = psql(
      mainRun.dbName,
      appUserScript(null, `update email_outbox set attempts = attempts + 1 where id = '${insertedId}' returning attempts::text;`),
    )
    expect(updated).toBe('1')
  })
})

describe('AC: as app_user, regenerate_provider_slots executes', () => {
  test('appUserExecutesRegenerateProviderSlots', function appUserExecutesRegenerateProviderSlots() {
    const result = psql(
      mainRun.dbName,
      appUserScript(
        null,
        `select removed::text || '|' || generated::text from regenerate_provider_slots(
           gen_random_uuid(), now(), now() + interval '1 hour', ARRAY[]::tstzrange[]);`,
      ),
    )
    expect(result).toBe('0|0')
  })
})

describe('AC: app_user has no UPDATE on slots and no DELETE on any table, asserted against the catalogue', () => {
  test('appUserHasNoUpdateOnSlotsAndNoDeleteAnywhereCatalogue', function appUserHasNoUpdateOnSlotsAndNoDeleteAnywhereCatalogue() {
    const slotsUpdate = psql(mainRun.dbName, `select has_table_privilege('app_user', 'public.slots', 'UPDATE');`)
    expect(slotsUpdate).toBe('f')

    // MATERIALIZED forces the schema filter to run before has_table_privilege
    // sees any row — without it, the planner is free to reorder the WHERE
    // clause and can hand has_table_privilege a non-public relation (e.g.
    // auth.users) before the schemaname = 'public' predicate ever excludes
    // it, which raises "relation ... does not exist" instead of filtering.
    const deleteAnywhere = psql(
      mainRun.dbName,
      `with public_tables as materialized (
         select tablename from pg_tables where schemaname = 'public'
       )
       select tablename from public_tables
        where has_table_privilege('app_user', 'public.' || tablename, 'DELETE')
        order by tablename;`,
    )
    expect(deleteAnywhere).toBe('')
  })
})

describe('adversarial: app_user cannot update slots.status directly', () => {
  test('appUserUpdatingSlotsStatusDirectlyRefused', function appUserUpdatingSlotsStatusDirectlyRefused() {
    const providerId = insertProvider(mainRun.dbName)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(13), futureTs(14))
    expectRawFailure(mainRun.dbName, appUserScript(null, `update slots set status = 'booked' where id = '${slotId}';`), '42501')
  })
})

describe('adversarial: app_user cannot delete from any table, including slots — the SECURITY DEFINER function deletes on its behalf, the role itself cannot', () => {
  test('appUserDeletingFromAnyTableRefusedIncludingSlots', function appUserDeletingFromAnyTableRefusedIncludingSlots() {
    const providerId = insertProvider(mainRun.dbName)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(15), futureTs(16))
    expectRawFailure(mainRun.dbName, appUserScript(null, `delete from slots where id = '${slotId}';`), '42501')

    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    expectRawFailure(mainRun.dbName, appUserScript(userA, `delete from patients where id = '${patientA}';`), '42501')
  })
})

describe('AC: a freshly linked account sees its own studies and its own signed reports', () => {
  test('freshlyLinkedPatientSeesOwnStudiesAndSignedReports', function freshlyLinkedPatientSeesOwnStudiesAndSignedReports() {
    const providerId = insertProvider(mainRun.dbName)
    const userId = insertAuthUser(mainRun.dbName)
    // seeded unlinked, as every real patient row is before FR-2 verification
    const patientId = insertPatient(mainRun.dbName, null)
    // the one write FR-2 verification makes (ARCHITECTURE.md §4): link, once,
    // when the column is null
    psql(mainRun.dbName, `update patients set user_id = '${userId}' where id = '${patientId}';`)

    const visitId = insertVisit(mainRun.dbName, patientId, providerId)
    const studyId = insertStudy(mainRun.dbName, visitId, patientId)
    const reportId = insertReport(mainRun.dbName, studyId, patientId, 'signed', providerId)

    const studies = psql(mainRun.dbName, appUserScript(userId, `select id from studies where id = '${studyId}';`))
    expect(studies).toBe(studyId)

    const reports = psql(mainRun.dbName, appUserScript(userId, `select id from reports where id = '${reportId}';`))
    expect(reports).toBe(reportId)
  })
})

describe('AC: every assertion in this suite runs as app_user, never owner or superuser', () => {
  test('appUserIsActiveRoleNeitherSuperuserNorTableOwner', function appUserIsActiveRoleNeitherSuperuserNorTableOwner() {
    const activeRole = psql(mainRun.dbName, appUserScript(null, `select current_user;`))
    expect(activeRole).toBe('app_user')

    const isSuper = psql(mainRun.dbName, `select rolsuper from pg_roles where rolname = 'app_user';`)
    expect(isSuper).toBe('f')

    const owner = psql(mainRun.dbName, `select tableowner from pg_tables where schemaname = 'public' and tablename = 'patients';`)
    expect(owner).not.toBe('app_user')
  })
})

describe('adversarial: the same isolation suite run as the table owner is not accepted as evidence', () => {
  test('ownerBypassSeesAllPatientsProvingOwnerRunsAreNotEvidence', function ownerBypassSeesAllPatientsProvingOwnerRunsAreNotEvidence() {
    const userA = insertAuthUser(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName, userA)
    const userB = insertAuthUser(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName, userB)

    // As postgres — the migration-running role, owner of every table here —
    // with no role switch and no claim: RLS is bypassed entirely, so both
    // rows are visible. This is exactly why every other assertion in this
    // file runs as app_user instead: proving isolation as the owner would
    // prove nothing.
    const asOwner = psql(mainRun.dbName, `select count(*) from patients where id in ('${patientA}','${patientB}');`)
    expect(asOwner).toBe('2')

    const asAppUserNoClaim = psql(
      mainRun.dbName,
      appUserScript(null, `select count(*) from patients where id in ('${patientA}','${patientB}');`),
    )
    expect(asAppUserNoClaim).toBe('0')
  })
})

describe("adversarial: a current_patient_id()-keyed policy on email_outbox would blind the reminder job's own drain", () => {
  test('emailOutboxPatientKeyedPolicyWouldBlindTheReminderJob', function emailOutboxPatientKeyedPolicyWouldBlindTheReminderJob() {
    psql(mainRun.dbName, `insert into email_outbox (recipient, subject, body) values ('drain-probe@example.com', 'Reminder', 'body');`)

    // Rolled back at the end: email_outbox holds no patient identifier at
    // all, so the closest honest simulation of "a current_patient_id()-keyed
    // policy" joins back through the recipient address. The reminder job has
    // no patient claim (it is not a patient session), so current_patient_id()
    // is null and the join can never match — exactly the failure §4 warns
    // against, reproduced and then undone.
    const withHypotheticalPolicy = psql(
      mainRun.dbName,
      `begin;
       alter table email_outbox enable row level security;
       create policy probe_email_outbox_patient_keyed on email_outbox for select
         using (recipient = (select email from patients where id = current_patient_id()));
       set role app_user;
       select count(*) from email_outbox;
       rollback;`,
    )
    expect(withHypotheticalPolicy).toBe('0')

    const stillNoRls = psql(
      mainRun.dbName,
      `select relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'email_outbox';`,
    )
    expect(stillNoRls).toBe('f')
  })
})

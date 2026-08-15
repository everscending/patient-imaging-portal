// Applies db/migrations/001_core.sql then 002_scheduling_sharing_audit.sql to a
// fresh pip_run_<random> database (ADR-0013) and asserts every constraint,
// trigger, function and grant the JOR-222 ticket pins — including the
// deferred-swap case and the slot-rebuild bound checks. auth.users / auth.uid()
// are stubbed by tests/setup/postgres.ts's startRun() for every run in this
// shared container (see migration-001.test.ts's header for why that lives
// there, not here).
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const HOUR = 3_600_000
const MIGRATIONS_001_AND_002 = ['001_core.sql', '002_scheduling_sharing_audit.sql'].map((name) =>
  readFileSync(join(process.cwd(), 'db', 'migrations', name), 'utf8'),
)

// Scoped to exactly 001+002 via their own migrationsDir. `mainRun` applies
// the whole db/migrations directory, and once JOR-234's 003_rls.sql lands
// there it grants app_user EXECUTE on regenerate_provider_slots — the very
// grant regenerateProviderSlotsExecuteRevokedFromPublic below asserts is
// absent. That is 003's own AC, not a regression here; this helper keeps
// that one test meaning what its name says regardless of what migrations
// land after 002.
function build001And002MigrationDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pip-002-'))
  writeFileSync(join(dir, '001_core.sql'), MIGRATIONS_001_AND_002[0])
  writeFileSync(join(dir, '002_scheduling_sharing_audit.sql'), MIGRATIONS_001_AND_002[1])
  return dir
}

function psql(dbName: string, sql: string): string {
  // -q suppresses command completion tags ("INSERT 0 1") that -tA alone
  // does not — without it, RETURNING output gets that tag glued onto the
  // next line and corrupts anything parsing the result.
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
  }).trim()
}

// Runs `sql` and expects it to raise an exception in `sqlstateClass`
// (e.g. check_violation, unique_violation, exclusion_violation,
// foreign_key_violation, not_null_violation) — an immediate, non-deferred
// failure that a PL/pgSQL exception block inside a DO $$ ... $$ can catch.
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

// Runs `sqlScript` as a raw (un-wrapped) statement sequence and expects the
// whole thing to fail with `sqlstate`. Used for failures a DO block cannot
// catch — a deferred constraint, which is checked only when the enclosing
// transaction commits (i.e. after the DO block's own PL/pgSQL body has
// already returned) — and for role-switch privilege checks, where a plain
// script needs no cleanup because each call is its own throwaway session and
// Postgres rolls the whole multi-statement script back on any error (so a
// `revoke ...; set role ...; <the failing statement>` script leaves the
// revoke undone too).
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
  return new Date(Date.now() + hoursFromNow * HOUR).toISOString()
}

function pastTs(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * HOUR).toISOString()
}

function insertPatient(dbName: string): string {
  return psql(
    dbName,
    `insert into patients (patient_ref, date_of_birth, full_name, email)
     values ('PT-${randomUUID().slice(0, 4)}', '1990-01-01', 'Patient ${randomUUID().slice(0, 4)}', 'p${randomUUID().slice(0, 8)}@example.com')
     returning id;`,
  )
}

function insertProvider(dbName: string): string {
  return psql(
    dbName,
    `insert into providers (full_name, time_zone) values ('Provider ${randomUUID().slice(0, 4)}', 'America/Chicago') returning id;`,
  )
}

function insertService(dbName: string): string {
  return psql(dbName, `insert into services (slug, name) values ('svc-${randomUUID().slice(0, 8)}', 'Test Service') returning id;`)
}

function insertSlot(dbName: string, providerId: string, startsAt: string, endsAt: string): string {
  return psql(dbName, `insert into slots (provider_id, starts_at, ends_at) values ('${providerId}', '${startsAt}', '${endsAt}') returning id;`)
}

function insertAppointment(
  dbName: string,
  opts: { slotId: string; patientId: string; providerId: string; serviceId: string; status?: string; idempotencyKey?: string | null },
): string {
  const status = opts.status ?? 'requested'
  const idempotencyKey = opts.idempotencyKey === undefined ? null : opts.idempotencyKey
  const idempotencyLiteral = idempotencyKey === null ? 'null' : `'${idempotencyKey}'`
  return psql(
    dbName,
    `insert into appointments (slot_id, patient_id, provider_id, service_id, status, idempotency_key)
     values ('${opts.slotId}', '${opts.patientId}', '${opts.providerId}', '${opts.serviceId}', '${status}', ${idempotencyLiteral})
     returning id;`,
  )
}

function insertVisitAndStudy(dbName: string, patientId: string, providerId: string): string {
  const visitId = psql(
    dbName,
    `insert into visits (patient_id, provider_id, occurred_at, status) values ('${patientId}', '${providerId}', now(), 'scheduled') returning id;`,
  )
  return psql(dbName, `insert into studies (visit_id, patient_id, description) values ('${visitId}', '${patientId}', 'fixture study') returning id;`)
}

function insertImage(dbName: string, studyId: string, patientId: string, ordinal = 1): string {
  return psql(
    dbName,
    `insert into images (study_id, patient_id, storage_key, width, height, ordinal)
     values ('${studyId}', '${patientId}', '${randomUUID()}', 100, 100, ${ordinal}) returning id;`,
  )
}

function insertReport(dbName: string, studyId: string, patientId: string): string {
  return psql(
    dbName,
    `insert into reports (study_id, patient_id, status, findings, impression) values ('${studyId}', '${patientId}', 'preliminary', 'f', 'i') returning id;`,
  )
}

function insertAuthUser(dbName: string): string {
  return psql(dbName, `insert into auth.users default values returning id;`)
}

let container: Container
let mainRun: Run

beforeAll(async () => {
  container = await ensureContainer()
  mainRun = await startRun(container) // default dir: db/migrations, i.e. 001 then 002
}, 60_000)

afterAll(async () => {
  if (mainRun) await stopRun(mainRun)
})

describe('AC: 002 applies clean on top of 001 on PostgreSQL 16', () => {
  test('migrationAppliesCleanOnTopOf001', function migrationAppliesCleanOnTopOf001() {
    const tables = psql(mainRun.dbName, `select tablename from pg_tables where schemaname = 'public' order by tablename;`).split('\n')
    for (const table of [
      'patients',
      'providers',
      'working_hours',
      'availability_blocks',
      'slots',
      'appointments',
      'appointment_transitions',
      'share_links',
      'reminder_sends',
      'email_outbox',
      'deletion_requests',
      'audit_events',
    ]) {
      expect(tables).toContain(table)
    }
  })
})

describe('AC + adversarial: working_hours allows a lunch-break split, rejects a third overlapping window', () => {
  test('workingHoursAllowsSplitWindowsRejectsOverlap', function workingHoursAllowsSplitWindowsRejectsOverlap() {
    const providerId = insertProvider(mainRun.dbName)
    psql(mainRun.dbName, `insert into working_hours (provider_id, weekday, starts_local, ends_local) values ('${providerId}', 2, '09:00', '12:00');`)
    psql(mainRun.dbName, `insert into working_hours (provider_id, weekday, starts_local, ends_local) values ('${providerId}', 2, '13:00', '17:00');`)
    expectGuard(
      mainRun.dbName,
      `insert into working_hours (provider_id, weekday, starts_local, ends_local) values ('${providerId}', 2, '11:30', '14:00');`,
      'exclusion_violation',
    )
  })
})

describe('AC + adversarial: slots reject an overlapping interval per provider, accept it across providers', () => {
  test('slotsRejectOverlapPerProviderAllowAcrossProviders', function slotsRejectOverlapPerProviderAllowAcrossProviders() {
    const providerA = insertProvider(mainRun.dbName)
    const providerB = insertProvider(mainRun.dbName)
    const start = futureTs(24)
    const end = futureTs(25)
    insertSlot(mainRun.dbName, providerA, start, end)
    expectGuard(
      mainRun.dbName,
      `insert into slots (provider_id, starts_at, ends_at) values ('${providerA}', '${futureTs(24.5)}', '${futureTs(25.5)}');`,
      'exclusion_violation',
    )
    const otherProviderSlot = insertSlot(mainRun.dbName, providerB, start, end)
    expect(otherProviderSlot).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('AC + adversarial: appointments_one_live_per_slot rejects a second live booking, allows cancelled + live to coexist', () => {
  test('secondLiveAppointmentRejectedCancelledCoexistsWithLive', function secondLiveAppointmentRejectedCancelledCoexistsWithLive() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patient1 = insertPatient(mainRun.dbName)
    const patient2 = insertPatient(mainRun.dbName)
    const patient3 = insertPatient(mainRun.dbName)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(1), futureTs(2))

    const appt1 = insertAppointment(mainRun.dbName, { slotId, patientId: patient1, providerId, serviceId, status: 'requested' })

    expectGuard(
      mainRun.dbName,
      `insert into appointments (slot_id, patient_id, provider_id, service_id, status)
       values ('${slotId}', '${patient2}', '${providerId}', '${serviceId}', 'requested');`,
      'exclusion_violation',
    )

    psql(mainRun.dbName, `update appointments set status = 'cancelled' where id = '${appt1}';`)

    const appt3 = insertAppointment(mainRun.dbName, { slotId, patientId: patient3, providerId, serviceId, status: 'requested' })
    expect(appt3).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('AC: two patients can swap slots inside one transaction with the exclude constraint deferred', () => {
  test('deferredConstraintAllowsSlotSwapWithinTransaction', function deferredConstraintAllowsSlotSwapWithinTransaction() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientA = insertPatient(mainRun.dbName)
    const patientB = insertPatient(mainRun.dbName)
    const slot1 = insertSlot(mainRun.dbName, providerId, futureTs(3), futureTs(4))
    const slot2 = insertSlot(mainRun.dbName, providerId, futureTs(5), futureTs(6))
    const apptA = insertAppointment(mainRun.dbName, { slotId: slot1, patientId: patientA, providerId, serviceId, status: 'confirmed' })
    const apptB = insertAppointment(mainRun.dbName, { slotId: slot2, patientId: patientB, providerId, serviceId, status: 'confirmed' })

    psql(
      mainRun.dbName,
      `begin;
       set constraints appointments_one_live_per_slot deferred;
       update appointments set slot_id = '${slot2}' where id = '${apptA}';
       update appointments set slot_id = '${slot1}' where id = '${apptB}';
       commit;`,
    )

    const swappedA = psql(mainRun.dbName, `select slot_id from appointments where id = '${apptA}';`)
    const swappedB = psql(mainRun.dbName, `select slot_id from appointments where id = '${apptB}';`)
    expect(swappedA).toBe(slot2)
    expect(swappedB).toBe(slot1)
  })
})

describe('AC: appointments_idempotency rejects a duplicate (patient_id, idempotency_key), allows two null keys', () => {
  test('idempotencyKeyRejectsDuplicateAllowsNulls', function idempotencyKeyRejectsDuplicateAllowsNulls() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)
    const slot1 = insertSlot(mainRun.dbName, providerId, futureTs(7), futureTs(8))
    const slot2 = insertSlot(mainRun.dbName, providerId, futureTs(9), futureTs(10))
    const slot3 = insertSlot(mainRun.dbName, providerId, futureTs(11), futureTs(12))
    const slot4 = insertSlot(mainRun.dbName, providerId, futureTs(13), futureTs(14))

    insertAppointment(mainRun.dbName, { slotId: slot1, patientId, providerId, serviceId, idempotencyKey: 'IDEMP-ABC' })
    expectGuard(
      mainRun.dbName,
      `insert into appointments (slot_id, patient_id, provider_id, service_id, idempotency_key)
       values ('${slot2}', '${patientId}', '${providerId}', '${serviceId}', 'IDEMP-ABC');`,
      'unique_violation',
    )

    const null1 = insertAppointment(mainRun.dbName, { slotId: slot3, patientId, providerId, serviceId, idempotencyKey: null })
    const null2 = insertAppointment(mainRun.dbName, { slotId: slot4, patientId, providerId, serviceId, idempotencyKey: null })
    expect(null1).toMatch(/^[0-9a-f-]{36}$/)
    expect(null2).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('AC: slots.status follows appointments through the trigger, never touched directly by the caller', () => {
  test('triggerSyncsSlotStatusBookedThenOpen', function triggerSyncsSlotStatusBookedThenOpen() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(15), futureTs(16))

    expect(psql(mainRun.dbName, `select status from slots where id = '${slotId}';`)).toBe('open')

    const apptId = insertAppointment(mainRun.dbName, { slotId, patientId, providerId, serviceId, status: 'requested' })
    expect(psql(mainRun.dbName, `select status from slots where id = '${slotId}';`)).toBe('booked')

    psql(mainRun.dbName, `update appointments set status = 'cancelled' where id = '${apptId}';`)
    expect(psql(mainRun.dbName, `select status from slots where id = '${slotId}';`)).toBe('open')
  })
})

describe('AC + adversarial: the transition trigger enforces the ordering matrix and allows non-status updates on a terminal row', () => {
  test(
    'transitionTriggerEnforcesMatrixAndAllowsNonStatusUpdateOnTerminal',
    function transitionTriggerEnforcesMatrixAndAllowsNonStatusUpdateOnTerminal() {
      const providerId = insertProvider(mainRun.dbName)
      const serviceId = insertService(mainRun.dbName)
      const patientId = insertPatient(mainRun.dbName)

      // cancelled -> completed rejected
      const slotA = insertSlot(mainRun.dbName, providerId, futureTs(20), futureTs(21))
      const apptA = insertAppointment(mainRun.dbName, { slotId: slotA, patientId, providerId, serviceId })
      psql(mainRun.dbName, `update appointments set status = 'cancelled' where id = '${apptA}';`)
      expectGuard(mainRun.dbName, `update appointments set status = 'completed' where id = '${apptA}';`, 'check_violation')

      // completed -> cancelled rejected
      const slotB = insertSlot(mainRun.dbName, providerId, futureTs(22), futureTs(23))
      const apptB = insertAppointment(mainRun.dbName, { slotId: slotB, patientId, providerId, serviceId })
      psql(mainRun.dbName, `update appointments set status = 'confirmed' where id = '${apptB}';`)
      psql(mainRun.dbName, `update appointments set status = 'completed' where id = '${apptB}';`)
      expectGuard(mainRun.dbName, `update appointments set status = 'cancelled' where id = '${apptB}';`, 'check_violation')

      // no_show -> confirmed rejected (needs a past slot to legally reach no_show first)
      const slotC = insertSlot(mainRun.dbName, providerId, pastTs(2), pastTs(1))
      const apptC = insertAppointment(mainRun.dbName, { slotId: slotC, patientId, providerId, serviceId })
      psql(mainRun.dbName, `update appointments set status = 'confirmed' where id = '${apptC}';`)
      psql(mainRun.dbName, `update appointments set status = 'no_show' where id = '${apptC}';`)
      expectGuard(mainRun.dbName, `update appointments set status = 'confirmed' where id = '${apptC}';`, 'check_violation')

      // requested -> completed rejected
      const slotD = insertSlot(mainRun.dbName, providerId, futureTs(25), futureTs(26))
      const apptD = insertAppointment(mainRun.dbName, { slotId: slotD, patientId, providerId, serviceId })
      expectGuard(mainRun.dbName, `update appointments set status = 'completed' where id = '${apptD}';`, 'check_violation')

      // confirmed -> requested rejected
      const slotE = insertSlot(mainRun.dbName, providerId, futureTs(27), futureTs(28))
      const apptE = insertAppointment(mainRun.dbName, { slotId: slotE, patientId, providerId, serviceId })
      psql(mainRun.dbName, `update appointments set status = 'confirmed' where id = '${apptE}';`)
      expectGuard(mainRun.dbName, `update appointments set status = 'requested' where id = '${apptE}';`, 'check_violation')

      // requested -> confirmed -> completed allowed
      const slotF = insertSlot(mainRun.dbName, providerId, futureTs(29), futureTs(30))
      const apptF = insertAppointment(mainRun.dbName, { slotId: slotF, patientId, providerId, serviceId })
      psql(mainRun.dbName, `update appointments set status = 'confirmed' where id = '${apptF}';`)
      psql(mainRun.dbName, `update appointments set status = 'completed' where id = '${apptF}';`)
      expect(psql(mainRun.dbName, `select status from appointments where id = '${apptF}';`)).toBe('completed')

      // a non-status update on a terminal row (apptA, cancelled) is allowed
      psql(mainRun.dbName, `update appointments set idempotency_key = 'terminal-touch-${randomUUID()}' where id = '${apptA}';`)
      expect(psql(mainRun.dbName, `select status from appointments where id = '${apptA}';`)).toBe('cancelled')
    },
  )
})

describe('AC + adversarial: no_show is rejected before the slot start instant, accepted after', () => {
  test('noShowRejectedBeforeStartAcceptedAfter', function noShowRejectedBeforeStartAcceptedAfter() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)

    const futureSlot = insertSlot(mainRun.dbName, providerId, futureTs(5), futureTs(6))
    const futureAppt = insertAppointment(mainRun.dbName, { slotId: futureSlot, patientId, providerId, serviceId })
    psql(mainRun.dbName, `update appointments set status = 'confirmed' where id = '${futureAppt}';`)
    expectGuard(mainRun.dbName, `update appointments set status = 'no_show' where id = '${futureAppt}';`, 'check_violation')

    const pastSlot = insertSlot(mainRun.dbName, providerId, pastTs(3), pastTs(2))
    const pastAppt = insertAppointment(mainRun.dbName, { slotId: pastSlot, patientId, providerId, serviceId })
    psql(mainRun.dbName, `update appointments set status = 'confirmed' where id = '${pastAppt}';`)
    psql(mainRun.dbName, `update appointments set status = 'no_show' where id = '${pastAppt}';`)
    expect(psql(mainRun.dbName, `select status from appointments where id = '${pastAppt}';`)).toBe('no_show')
  })
})

describe('AC: updated_at advances on every update to an appointment', () => {
  test('updatedAtAdvancesOnEveryAppointmentUpdate', function updatedAtAdvancesOnEveryAppointmentUpdate() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(31), futureTs(32))
    const apptId = insertAppointment(mainRun.dbName, { slotId, patientId, providerId, serviceId })

    const before = psql(mainRun.dbName, `select updated_at from appointments where id = '${apptId}';`)
    psql(mainRun.dbName, `select pg_sleep(0.05);`)
    psql(mainRun.dbName, `update appointments set idempotency_key = '${randomUUID()}' where id = '${apptId}';`)
    const after = psql(mainRun.dbName, `select updated_at from appointments where id = '${apptId}';`)

    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })
})

describe('AC + adversarial: share_links enforce owner-bound targets, exactly-one-target, and a read-only derived resource_kind', () => {
  test(
    'shareLinksEnforceOwnershipTargetCountAndGeneratedResourceKind',
    function shareLinksEnforceOwnershipTargetCountAndGeneratedResourceKind() {
      const providerId = insertProvider(mainRun.dbName)
      const patient1 = insertPatient(mainRun.dbName)
      const patient2 = insertPatient(mainRun.dbName)
      const study1 = insertVisitAndStudy(mainRun.dbName, patient1, providerId)
      const study2 = insertVisitAndStudy(mainRun.dbName, patient2, providerId)
      const image1 = insertImage(mainRun.dbName, study1, patient1)
      const report1 = insertReport(mainRun.dbName, study1, patient1)
      const image2 = insertImage(mainRun.dbName, study2, patient2)
      const userId = insertAuthUser(mainRun.dbName)

      const baseFields = (imageId: string | null, reportId: string | null, patientId: string) =>
        `token_hash, patient_id, image_id, report_id, created_by, recipient_email, expires_at)
         values ('${randomUUID()}', '${patientId}', ${imageId ? `'${imageId}'` : 'null'}, ${reportId ? `'${reportId}'` : 'null'},
                 '${userId}', 'recipient@example.com', '${futureTs(72)}'`

      // adversarial: image_id belongs to a different patient than the link claims
      expectGuard(mainRun.dbName, `insert into share_links (${baseFields(image2, null, patient1)});`, 'foreign_key_violation')

      // adversarial: dangling resource id
      expectGuard(mainRun.dbName, `insert into share_links (${baseFields(randomUUID(), null, patient1)});`, 'foreign_key_violation')

      // adversarial: zero targets
      expectGuard(mainRun.dbName, `insert into share_links (${baseFields(null, null, patient1)});`, 'check_violation')

      // adversarial: two targets
      expectGuard(mainRun.dbName, `insert into share_links (${baseFields(image1, report1, patient1)});`, 'check_violation')

      // resource_kind is derived correctly for each valid shape
      const imageLink = psql(mainRun.dbName, `insert into share_links (${baseFields(image1, null, patient1)}) returning id, resource_kind;`)
      expect(imageLink.split('|')[1]).toBe('image')
      const reportLink = psql(mainRun.dbName, `insert into share_links (${baseFields(null, report1, patient1)}) returning id, resource_kind;`)
      expect(reportLink.split('|')[1]).toBe('report')

      // adversarial: a direct write to the generated column
      const imageLinkId = imageLink.split('|')[0]
      expectRawFailure(mainRun.dbName, `update share_links set resource_kind = 'report' where id = '${imageLinkId}';`, '428C9')
    },
  )
})

describe('AC: regenerate_provider_slots removes only in-range open unreferenced slots, returns removed/generated counts', () => {
  test(
    'regenerateProviderSlotsRemovesOnlyOpenUnreferencedSlotsInRange',
    function regenerateProviderSlotsRemovesOnlyOpenUnreferencedSlotsInRange() {
      const providerId = insertProvider(mainRun.dbName)
      const pFrom = futureTs(200)
      const pTo = futureTs(224)
      insertSlot(mainRun.dbName, providerId, futureTs(201), futureTs(202))
      insertSlot(mainRun.dbName, providerId, futureTs(203), futureTs(204))
      insertSlot(mainRun.dbName, providerId, futureTs(205), futureTs(206))
      expect(psql(mainRun.dbName, `select count(*) from slots where provider_id = '${providerId}';`)).toBe('3')

      const result = psql(
        mainRun.dbName,
        `select removed::text || '|' || generated::text from regenerate_provider_slots(
           '${providerId}'::uuid, '${pFrom}'::timestamptz, '${pTo}'::timestamptz, ARRAY[]::tstzrange[]);`,
      )
      expect(result).toBe('3|0')
      expect(psql(mainRun.dbName, `select count(*) from slots where provider_id = '${providerId}';`)).toBe('0')
    },
  )
})

describe('AC + adversarial: a booked slot inside the range survives the rebuild, its appointment untouched', () => {
  test('regenerateProviderSlotsPreservesBookedSlotAndItsAppointment', function regenerateProviderSlotsPreservesBookedSlotAndItsAppointment() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)
    const pFrom = futureTs(200)
    const pTo = futureTs(224)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(205), futureTs(206))
    const apptId = insertAppointment(mainRun.dbName, { slotId, patientId, providerId, serviceId, status: 'confirmed' })
    expect(psql(mainRun.dbName, `select status from slots where id = '${slotId}';`)).toBe('booked')

    const result = psql(
      mainRun.dbName,
      `select removed::text || '|' || generated::text from regenerate_provider_slots(
         '${providerId}'::uuid, '${pFrom}'::timestamptz, '${pTo}'::timestamptz, ARRAY[]::tstzrange[]);`,
    )
    expect(result).toBe('0|0')
    expect(psql(mainRun.dbName, `select status from slots where id = '${slotId}';`)).toBe('booked')
    expect(psql(mainRun.dbName, `select status from appointments where id = '${apptId}';`)).toBe('confirmed')
  })
})

describe('adversarial: a rebuild does not remove a slot an open `requested` appointment references', () => {
  test(
    'regenerateProviderSlotsPreservesSlotWithRequestedAppointment',
    function regenerateProviderSlotsPreservesSlotWithRequestedAppointment() {
      const providerId = insertProvider(mainRun.dbName)
      const serviceId = insertService(mainRun.dbName)
      const patientId = insertPatient(mainRun.dbName)
      const pFrom = futureTs(200)
      const pTo = futureTs(224)
      const slotId = insertSlot(mainRun.dbName, providerId, futureTs(207), futureTs(208))
      const apptId = insertAppointment(mainRun.dbName, { slotId, patientId, providerId, serviceId, status: 'requested' })

      const result = psql(
        mainRun.dbName,
        `select removed::text || '|' || generated::text from regenerate_provider_slots(
           '${providerId}'::uuid, '${pFrom}'::timestamptz, '${pTo}'::timestamptz, ARRAY[]::tstzrange[]);`,
      )
      expect(result).toBe('0|0')
      expect(psql(mainRun.dbName, `select 1 from slots where id = '${slotId}';`)).toBe('1')
      expect(psql(mainRun.dbName, `select status from appointments where id = '${apptId}';`)).toBe('requested')
    },
  )
})

describe('AC + adversarial: a proposed slot overlapping a survivor (not merely sharing its start) is skipped and the rebuild completes', () => {
  test(
    'regenerateProviderSlotsSkipsOverlapNotJustSameStartAndCompletes',
    function regenerateProviderSlotsSkipsOverlapNotJustSameStartAndCompletes() {
      const providerId = insertProvider(mainRun.dbName)
      const serviceId = insertService(mainRun.dbName)
      const patientId = insertPatient(mainRun.dbName)
      const dayStartHour = 300

      // A booked 00:30-01:00 slot (relative to the day's start), which a naive
      // `on conflict (provider_id, starts_at) do nothing` alone would not stop
      // from colliding with a proposed hourly 00:00-01:00 slot.
      const bookedStart = futureTs(dayStartHour + 0.5)
      const bookedEnd = futureTs(dayStartHour + 1)
      const bookedSlotId = insertSlot(mainRun.dbName, providerId, bookedStart, bookedEnd)
      insertAppointment(mainRun.dbName, { slotId: bookedSlotId, patientId, providerId, serviceId, status: 'confirmed' })

      const proposed = Array.from({ length: 24 }, (_, i) => `tstzrange('${futureTs(dayStartHour + i)}', '${futureTs(dayStartHour + i + 1)}')`)
      const arrayLiteral = `ARRAY[${proposed.join(',')}]::tstzrange[]`
      const pFrom = futureTs(dayStartHour)
      const pTo = futureTs(dayStartHour + 24)

      const result = psql(
        mainRun.dbName,
        `select removed::text || '|' || generated::text from regenerate_provider_slots(
           '${providerId}'::uuid, '${pFrom}'::timestamptz, '${pTo}'::timestamptz, ${arrayLiteral});`,
      )
      const [removed, generated] = result.split('|').map(Number)
      expect(removed).toBe(0)
      expect(generated).toBe(23) // the 00:00-01:00 proposal is skipped; the other 23 insert

      expect(psql(mainRun.dbName, `select count(*) from slots where provider_id = '${providerId}';`)).toBe('24')
    },
  )
})

describe('AC: after a rebuild there are zero overlapping slot pairs for that provider', () => {
  test('regenerateProviderSlotsLeavesNoOverlappingPairsAfterRebuild', function regenerateProviderSlotsLeavesNoOverlappingPairsAfterRebuild() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)
    const dayStartHour = 340
    const bookedSlotId = insertSlot(mainRun.dbName, providerId, futureTs(dayStartHour + 0.5), futureTs(dayStartHour + 1))
    insertAppointment(mainRun.dbName, { slotId: bookedSlotId, patientId, providerId, serviceId, status: 'confirmed' })

    const proposed = Array.from({ length: 24 }, (_, i) => `tstzrange('${futureTs(dayStartHour + i)}', '${futureTs(dayStartHour + i + 1)}')`)
    psql(
      mainRun.dbName,
      `select regenerate_provider_slots(
         '${providerId}'::uuid, '${futureTs(dayStartHour)}'::timestamptz, '${futureTs(dayStartHour + 24)}'::timestamptz,
         ARRAY[${proposed.join(',')}]::tstzrange[]);`,
    )

    const overlaps = psql(
      mainRun.dbName,
      `select count(*) from slots s1 join slots s2
         on s1.provider_id = s2.provider_id and s1.id < s2.id
         and tstzrange(s1.starts_at, s1.ends_at) && tstzrange(s2.starts_at, s2.ends_at)
       where s1.provider_id = '${providerId}';`,
    )
    expect(overlaps).toBe('0')
  })
})

describe('AC + adversarial: a rebuild leaves another provider, and the same provider outside the range, untouched (by count)', () => {
  test(
    'regenerateProviderSlotsLeavesOtherProviderAndOutOfRangeUntouched',
    function regenerateProviderSlotsLeavesOtherProviderAndOutOfRangeUntouched() {
      const providerA = insertProvider(mainRun.dbName)
      const providerB = insertProvider(mainRun.dbName)
      const pFrom = futureTs(400)
      const pTo = futureTs(424)

      // providerA: 5 open, unreferenced slots inside the range -> removed
      const inRangeStarts = [401, 402, 403, 404, 405]
      for (const h of inRangeStarts) insertSlot(mainRun.dbName, providerA, futureTs(h), futureTs(h + 0.5))

      // providerA: slots well outside the range -> untouched, a much larger set
      // than the rebuild should ever touch
      const outOfRangeStarts = Array.from({ length: 20 }, (_, i) => 500 + i)
      for (const h of outOfRangeStarts) insertSlot(mainRun.dbName, providerA, futureTs(h), futureTs(h + 0.5))

      // providerB: open slots at the exact same instants as providerA's
      // in-range slots -> untouched, because the rebuild targets providerA only
      for (const h of inRangeStarts) insertSlot(mainRun.dbName, providerB, futureTs(h), futureTs(h + 0.5))

      expect(psql(mainRun.dbName, `select count(*) from slots where provider_id = '${providerA}';`)).toBe('25')
      expect(psql(mainRun.dbName, `select count(*) from slots where provider_id = '${providerB}';`)).toBe('5')

      const result = psql(
        mainRun.dbName,
        `select removed::text || '|' || generated::text from regenerate_provider_slots(
           '${providerA}'::uuid, '${pFrom}'::timestamptz, '${pTo}'::timestamptz, ARRAY[]::tstzrange[]);`,
      )
      expect(result).toBe('5|0')

      expect(psql(mainRun.dbName, `select count(*) from slots where provider_id = '${providerA}';`)).toBe('20')
      expect(psql(mainRun.dbName, `select count(*) from slots where provider_id = '${providerB}';`)).toBe('5')
    },
  )
})

describe('AC + adversarial: execute on regenerate_provider_slots is revoked from public', () => {
  test(
    'regenerateProviderSlotsExecuteRevokedFromPublic',
    async function regenerateProviderSlotsExecuteRevokedFromPublic() {
      const dir = build001And002MigrationDir()
      let run: Run | undefined
      try {
        run = await startRun(container, dir)
        const hasPrivilege = psql(
          run.dbName,
          `select has_function_privilege('public', 'regenerate_provider_slots(uuid,timestamptz,timestamptz,tstzrange[])', 'execute');`,
        )
        expect(hasPrivilege).toBe('f')

        expectRawFailure(
          run.dbName,
          `set role app_user; select * from regenerate_provider_slots(gen_random_uuid(), now(), now(), ARRAY[]::tstzrange[]);`,
          '42501',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
        if (run) await stopRun(run)
      }
    },
    30_000,
  )
})

describe('AC + adversarial: email_outbox defaults attempts/next_attempt_at and rejects null recipient, subject or body', () => {
  test('emailOutboxDefaultsAndRejectsNulls', function emailOutboxDefaultsAndRejectsNulls() {
    const row = psql(
      mainRun.dbName,
      `insert into email_outbox (recipient, subject, body) values ('to@example.com', 'Reminder', 'body text')
       returning attempts::text || '|' || (next_attempt_at <= now())::text || '|' || (next_attempt_at >= now() - interval '1 minute')::text;`,
    )
    const [attempts, notInFuture, recent] = row.split('|')
    expect(attempts).toBe('0')
    expect(notInFuture).toBe('true')
    expect(recent).toBe('true')

    expectGuard(mainRun.dbName, `insert into email_outbox (subject, body) values ('Reminder', 'body text');`, 'not_null_violation')
    expectGuard(mainRun.dbName, `insert into email_outbox (recipient, body) values ('to@example.com', 'body text');`, 'not_null_violation')
    expectGuard(mainRun.dbName, `insert into email_outbox (recipient, subject) values ('to@example.com', 'Reminder');`, 'not_null_violation')
  })
})

describe('AC + adversarial: deletion_requests defaults status to received, rejects a second received request at commit', () => {
  test(
    'deletionRequestsDefaultsAndRejectsSecondReceivedAtCommit',
    function deletionRequestsDefaultsAndRejectsSecondReceivedAtCommit() {
      const patientId = insertPatient(mainRun.dbName)
      const userId = insertAuthUser(mainRun.dbName)

      const status = psql(
        mainRun.dbName,
        `insert into deletion_requests (patient_id, requested_by) values ('${patientId}', '${userId}') returning status;`,
      )
      expect(status).toBe('received')

      expectRawFailure(
        mainRun.dbName,
        `insert into deletion_requests (patient_id, requested_by) values ('${patientId}', '${userId}');`,
        '23505',
      )
    },
  )
})

describe('AC + adversarial: deletion_requests rejects a status outside the pinned set', () => {
  test('deletionRequestsRejectsInvalidStatus', function deletionRequestsRejectsInvalidStatus() {
    const patientId = insertPatient(mainRun.dbName)
    const userId = insertAuthUser(mainRun.dbName)
    expectGuard(
      mainRun.dbName,
      `insert into deletion_requests (patient_id, requested_by, status) values ('${patientId}', '${userId}', 'purged');`,
      'check_violation',
    )
  })
})

describe('AC + adversarial: audit_events accepts the pinned actions, rejects an action or outcome outside the pinned sets', () => {
  test('auditEventsAcceptsPinnedActionsRejectsOthersAndOutcome', function auditEventsAcceptsPinnedActionsRejectsOthersAndOutcome() {
    const shareView = psql(
      mainRun.dbName,
      `insert into audit_events (actor_kind, action, target_kind, outcome) values ('system', 'share.view', 'share_link', 'granted') returning action;`,
    )
    expect(shareView).toBe('share.view')
    const deletionRequest = psql(
      mainRun.dbName,
      `insert into audit_events (actor_kind, action, target_kind, outcome) values ('system', 'profile.deletion_request', 'patient', 'granted') returning action;`,
    )
    expect(deletionRequest).toBe('profile.deletion_request')

    expectGuard(
      mainRun.dbName,
      `insert into audit_events (actor_kind, action, target_kind, outcome) values ('system', 'image_viewed', 'image', 'granted');`,
      'check_violation',
    )
    expectGuard(
      mainRun.dbName,
      `insert into audit_events (actor_kind, action, target_kind, outcome) values ('system', 'share.viewed', 'share_link', 'granted');`,
      'check_violation',
    )
    expectGuard(
      mainRun.dbName,
      `insert into audit_events (actor_kind, action, target_kind, outcome) values ('system', 'share.view', 'share_link', 'maybe');`,
      'check_violation',
    )
  })
})

describe('AC + adversarial: as app_user, audit_events INSERT and SELECT succeed, UPDATE and DELETE both fail', () => {
  // Scoped to exactly 001+002, like regenerateProviderSlotsExecuteRevokedFromPublic
  // above: once JOR-234's 003_rls.sql lands in db/migrations, audit_events gets
  // RLS with a read policy scoped to is_admin() (§4) — a non-admin app_user can
  // still insert but can no longer read back its own row. That is 003's own AC
  // (tests/db/rls.test.ts's patientReadsZeroAuditEventsAdminReadsAll), not a
  // regression in 002's plain grant-level SELECT check.
  test(
    'auditEventsAppUserInsertSelectOkUpdateDeleteFail',
    async function auditEventsAppUserInsertSelectOkUpdateDeleteFail() {
      const dir = build001And002MigrationDir()
      let run: Run | undefined
      try {
        run = await startRun(container, dir)
        psql(
          run.dbName,
          `set role app_user;
           insert into audit_events (actor_kind, action, target_kind, outcome) values ('system', 'audit.view', 'audit_events', 'granted');`,
        )
        const selected = psql(run.dbName, `set role app_user; select count(*) >= 1 from audit_events;`)
        expect(selected).toBe('t')

        expectRawFailure(run.dbName, `set role app_user; update audit_events set outcome = 'denied' where true;`, '42501')
        expectRawFailure(run.dbName, `set role app_user; delete from audit_events where true;`, '42501')
      } finally {
        rmSync(dir, { recursive: true, force: true })
        if (run) await stopRun(run)
      }
    },
    30_000,
  )
})

describe('adversarial: a second reminder_sends row for the same (appointment_id, lead_hours) is rejected', () => {
  test('reminderSendsRejectsDuplicateAppointmentLeadHours', function reminderSendsRejectsDuplicateAppointmentLeadHours() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(33), futureTs(34))
    const apptId = insertAppointment(mainRun.dbName, { slotId, patientId, providerId, serviceId })

    psql(mainRun.dbName, `insert into reminder_sends (appointment_id, lead_hours, outcome) values ('${apptId}', 24, 'skipped');`)
    expectGuard(
      mainRun.dbName,
      `insert into reminder_sends (appointment_id, lead_hours, outcome) values ('${apptId}', 24, 'failed');`,
      'unique_violation',
    )
  })
})

describe("adversarial: reminder_sends rejects outcome = 'sent' with sent_at null", () => {
  test('reminderSendsOutcomeSentRequiresSentAt', function reminderSendsOutcomeSentRequiresSentAt() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(35), futureTs(36))
    const apptId = insertAppointment(mainRun.dbName, { slotId, patientId, providerId, serviceId })

    expectGuard(
      mainRun.dbName,
      `insert into reminder_sends (appointment_id, lead_hours, outcome, sent_at) values ('${apptId}', 2, 'sent', null);`,
      'check_violation',
    )
    const ok = psql(
      mainRun.dbName,
      `insert into reminder_sends (appointment_id, lead_hours, outcome, sent_at) values ('${apptId}', 2, 'sent', now()) returning outcome;`,
    )
    expect(ok).toBe('sent')
  })
})

describe('adversarial: an app_user insert into audit_events fails once the sequence grant is removed, and the removal does not persist', () => {
  test('auditEventsInsertFailsAsAppUserWithoutSequenceGrant', function auditEventsInsertFailsAsAppUserWithoutSequenceGrant() {
    expectRawFailure(
      mainRun.dbName,
      `revoke usage on sequence audit_events_id_seq from app_user;
       set role app_user;
       insert into audit_events (actor_kind, action, target_kind, outcome) values ('system', 'audit.view', 'audit_events', 'granted');`,
      '42501',
    )
    // the failing insert rolled the whole script back, including the revoke
    expect(psql(mainRun.dbName, `select has_sequence_privilege('app_user', 'audit_events_id_seq', 'usage');`)).toBe('t')
  })
})

describe('adversarial: app_user cannot update slots.status directly (no grant on slots at all)', () => {
  test('appUserCannotUpdateSlotsStatusDirectly', function appUserCannotUpdateSlotsStatusDirectly() {
    const providerId = insertProvider(mainRun.dbName)
    const serviceId = insertService(mainRun.dbName)
    const patientId = insertPatient(mainRun.dbName)
    const slotId = insertSlot(mainRun.dbName, providerId, futureTs(37), futureTs(38))
    insertAppointment(mainRun.dbName, { slotId, patientId, providerId, serviceId, status: 'confirmed' })
    expect(psql(mainRun.dbName, `select status from slots where id = '${slotId}';`)).toBe('booked')

    expectRawFailure(mainRun.dbName, `set role app_user; update slots set status = 'open' where id = '${slotId}';`, '42501')
  })
})

// Applies db/migrations/001-004 to a fresh pip_run_<random> database
// (ADR-0013) and asserts what JOR-254 round 3 actually needed:
// link_patient_identity(...) writes patients.user_id and its
// identity_attempts success row in one transaction, not two independent
// PostgREST calls with a gap between them. The round-2 gate rejection was
// specifically about that gap (comment 37eb0410 on JOR-254) — the
// insertFailureRollsBackTheUpdateToo test below forces the second half of
// the function to fail and proves the first half doesn't survive it.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'

function psql(dbName: string, sql: string): string {
  // -q suppresses command completion tags ("INSERT 0 1") that -tA alone
  // does not — without it, RETURNING output gets that tag glued onto the
  // next line and corrupts anything parsing the result.
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
  }).trim()
}

// Runs `sql` and expects it to raise an exception in `sqlstateClass` — an
// immediate, non-deferred failure a PL/pgSQL exception block can catch.
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
// whole thing to fail with `sqlstate` — used for role-switch privilege
// checks, where a plain script needs no cleanup because each call is its own
// throwaway session (mirrors migration-002.test.ts's expectRawFailure).
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

function insertAuthUser(dbName: string): string {
  return psql(dbName, `insert into auth.users default values returning id;`)
}

// Sequential refs, not random slices — 4 random hex chars can collide on
// the unique patient_ref (see rls.test.ts, range 9000+). This file
// reserves 8900–8999.
let patientReferenceSequence = 8900

function nextPatientReference(): string {
  if (patientReferenceSequence > 8999) {
    throw new Error('migration-004 patient fixture exhausted its reserved reference range')
  }
  return `PT-${String(patientReferenceSequence++).padStart(4, '0')}`
}

function insertPatient(dbName: string, userId: string | null = null): string {
  const ref = nextPatientReference()
  const userIdSql = userId ? `'${userId}'` : 'null'
  return psql(
    dbName,
    `insert into patients (user_id, patient_ref, date_of_birth, full_name, email)
     values (${userIdSql}, '${ref}', '1990-01-01', 'Fixture Patient', 'fixture@example.com')
     returning id;`,
  )
}

function linkPatientIdentity(dbName: string, patientId: string, callerId: string, attemptedRef: string, sourceRef: string): string {
  return psql(
    dbName,
    `select link_patient_identity('${patientId}'::uuid, '${callerId}'::uuid, '${attemptedRef}', '${sourceRef}', now());`,
  )
}

let container: Container
let mainRun: Run

beforeAll(async () => {
  container = await ensureContainer()
  mainRun = await startRun(container) // default dir: db/migrations, i.e. 001 through 004
}, 60_000)

afterAll(async () => {
  if (mainRun) await stopRun(mainRun)
})

describe('AC: 004 applies clean on top of 001-003', () => {
  test('linkPatientIdentityFunctionExists', function linkPatientIdentityFunctionExists() {
    const exists = psql(
      mainRun.dbName,
      `select exists (select 1 from pg_proc where proname = 'link_patient_identity');`,
    )
    expect(exists).toBe('t')
  })
})

describe('AC1: a successful link writes patients.user_id and the succeeded identity_attempts row in one call', () => {
  test('linkedNowSetsUserIdAndInsertsSucceededAttemptRow', function linkedNowSetsUserIdAndInsertsSucceededAttemptRow() {
    const patientId = insertPatient(mainRun.dbName)
    const callerId = insertAuthUser(mainRun.dbName)

    const outcome = linkPatientIdentity(mainRun.dbName, patientId, callerId, 'PT-4471', 'source-hash-a')
    expect(outcome).toBe('linked_now')

    expect(psql(mainRun.dbName, `select user_id::text from patients where id = '${patientId}';`)).toBe(callerId)

    const attemptRow = psql(
      mainRun.dbName,
      `select attempted_patient_ref || '|' || source_ref || '|' || user_id::text || '|' || succeeded::text
         from identity_attempts where user_id = '${callerId}';`,
    )
    expect(attemptRow).toBe(`PT-4471|source-hash-a|${callerId}|true`)
  })
})

describe('AC: a repeat call from the same caller is a harmless no-op — already_by_caller, no second row', () => {
  test('repeatCallFromSameCallerWritesNoSecondRow', function repeatCallFromSameCallerWritesNoSecondRow() {
    const patientId = insertPatient(mainRun.dbName)
    const callerId = insertAuthUser(mainRun.dbName)

    expect(linkPatientIdentity(mainRun.dbName, patientId, callerId, 'PT-1001', 'source-hash-b')).toBe('linked_now')
    expect(linkPatientIdentity(mainRun.dbName, patientId, callerId, 'PT-1001', 'source-hash-b')).toBe('already_by_caller')

    expect(psql(mainRun.dbName, `select count(*) from identity_attempts where user_id = '${callerId}';`)).toBe('1')
  })
})

describe('AC: a second caller for an already-linked patient loses the race — claimed_by_other, user_id unchanged', () => {
  test('secondCallerIsClaimedByOtherUserIdUnchanged', function secondCallerIsClaimedByOtherUserIdUnchanged() {
    const patientId = insertPatient(mainRun.dbName)
    const firstCaller = insertAuthUser(mainRun.dbName)
    const secondCaller = insertAuthUser(mainRun.dbName)

    expect(linkPatientIdentity(mainRun.dbName, patientId, firstCaller, 'PT-2002', 'source-hash-c')).toBe('linked_now')
    expect(linkPatientIdentity(mainRun.dbName, patientId, secondCaller, 'PT-2002', 'source-hash-d')).toBe('claimed_by_other')

    expect(psql(mainRun.dbName, `select user_id::text from patients where id = '${patientId}';`)).toBe(firstCaller)
    // claimed_by_other writes no identity_attempts row of its own — that
    // failure-path insert is lib/access/identity.ts's recordAttempt call,
    // outside this function (the round-3 brief scoped only the success path
    // in here).
    expect(psql(mainRun.dbName, `select count(*) from identity_attempts where user_id = '${secondCaller}';`)).toBe('0')
  })
})

describe('adversarial: the identity_attempts insert failing rolls the patients.user_id update back too', () => {
  test('insertFailureRollsBackTheUpdateToo', function insertFailureRollsBackTheUpdateToo() {
    const patientId = insertPatient(mainRun.dbName)
    const callerId = insertAuthUser(mainRun.dbName)

    // A null attempted_patient_ref passes the function's own parameter
    // typing but violates identity_attempts.attempted_patient_ref's `not
    // null` — forcing the insert half of the function to fail *after* its
    // update half already matched a row in Postgres's internal execution,
    // but before either half commits. If the two writes were still two
    // independent statements (what round 2 rejected), this would leave
    // user_id set with no attempt row. Inside one function body they share
    // one transaction, so the failed insert must take the update down with
    // it.
    expectGuard(
      mainRun.dbName,
      `perform link_patient_identity('${patientId}'::uuid, '${callerId}'::uuid, null, 'source-hash-e', now());`,
      'not_null_violation',
    )

    expect(psql(mainRun.dbName, `select user_id is null from patients where id = '${patientId}';`)).toBe('t')
    expect(psql(mainRun.dbName, `select count(*) from identity_attempts where user_id = '${callerId}';`)).toBe('0')
  })
})

describe('AC + adversarial: execute on link_patient_identity is revoked from public', () => {
  test('linkPatientIdentityExecuteRevokedFromPublic', function linkPatientIdentityExecuteRevokedFromPublic() {
    const hasPrivilege = psql(
      mainRun.dbName,
      `select has_function_privilege('public', 'link_patient_identity(uuid,uuid,text,text,timestamptz)', 'execute');`,
    )
    expect(hasPrivilege).toBe('f')
  })
})

describe('AC + adversarial: execute on link_patient_identity is rejected for app_user (this suite\'s authenticated stand-in)', () => {
  test('linkPatientIdentityExecuteRejectedForAppUser', function linkPatientIdentityExecuteRejectedForAppUser() {
    // has_function_privilege against the raw postgres superuser connection
    // (the test above) bypasses grants and never exercises the real
    // PostgREST exposure path — Supabase grants EXECUTE to `authenticated`
    // separately from `public` at function creation, so only a call made
    // *as* that role proves the RPC is actually gated. `app_user` is this
    // project's local stand-in for `authenticated`.
    expectRawFailure(
      mainRun.dbName,
      `set role app_user; select link_patient_identity(gen_random_uuid(), gen_random_uuid(), 'PT-0000', 'source-hash-z', now());`,
      '42501',
    )
  })
})

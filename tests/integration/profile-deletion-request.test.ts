import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const execFileAsync = promisify(execFile)
let run: Run

function literal(value: string): string {
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
    { encoding: 'utf8' },
  )
  return stdout.trim()
}

function expectSqlState(sql: string, state: string): void {
  try {
    execFileSync(
      'docker',
      ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-tAq', '-c', sql],
      { encoding: 'utf8' },
    )
  } catch (error) {
    expect(String((error as { stderr?: Buffer | string }).stderr ?? '')).toContain(state)
    return
  }
  throw new Error(`expected SQLSTATE ${state}`)
}

function fixture(): { actorUserId: string; patientId: string } {
  const actorUserId = randomUUID()
  const patientId = randomUUID()
  const suffix = randomUUID().replaceAll('-', '')
  psql(`
    insert into auth.users (id) values ('${actorUserId}');
    insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email)
      values ('${patientId}', '${actorUserId}', 'PT-${suffix.slice(0, 8)}', '1990-01-01', 'Deletion Patient', '${suffix}@example.test');
  `)
  return { actorUserId, patientId }
}

function appSql(actorUserId: string, sql: string): string {
  return `set role app_user; set request.jwt.claims = ${literal(JSON.stringify({ sub: actorUserId }))}; ${sql}`
}

function requestCall(actorUserId: string, valid = true): string {
  return appSql(actorUserId, `select row_to_json(result) from request_profile_deletion(${valid}) result;`)
}

beforeAll(async () => {
  run = await startRun(await ensureContainer())
}, 120_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('profile deletion request — migrated transactional contract', () => {
  test('receivedAndInReviewAreOneOpenClassWhileTerminalHistoryMayRepeat', () => {
    const { actorUserId, patientId } = fixture()
    psql(`insert into deletion_requests (patient_id, requested_by) values ('${patientId}', '${actorUserId}');`)
    expectSqlState(
      `insert into deletion_requests (patient_id, requested_by, status) values ('${patientId}', '${actorUserId}', 'in_review');`,
      '23505',
    )
    psql(`update deletion_requests set status = 'completed' where patient_id = '${patientId}';`)
    psql(`
      insert into deletion_requests (patient_id, requested_by, status) values
        ('${patientId}', '${actorUserId}', 'completed'),
        ('${patientId}', '${actorUserId}', 'declined'),
        ('${patientId}', '${actorUserId}', 'declined');
      insert into deletion_requests (patient_id, requested_by, status)
        values ('${patientId}', '${actorUserId}', 'in_review');
    `)
    expect(psql(`select status || ':' || count(*) from deletion_requests where patient_id = '${patientId}' group by status order by status;`))
      .toBe('completed:2\ndeclined:2\nin_review:1')
  })

  test('directCallerCannotForgeServerOwnedFields', () => {
    const { actorUserId, patientId } = fixture()
    const forgedRequester = randomUUID()
    psql(`insert into auth.users (id) values ('${forgedRequester}');`)
    expectSqlState(
      appSql(actorUserId, `insert into deletion_requests (patient_id, requested_by, status, requested_at)
        values ('${patientId}', '${forgedRequester}', 'completed', '2000-01-01T00:00:00Z');`),
      '42501',
    )
    expect(psql(`select count(*) from deletion_requests where patient_id = '${patientId}';`)).toBe('0')
  })

  test('rpcDerivesFieldsAndCommitsOneGrantedAuditWithTheRequest', () => {
    const { actorUserId, patientId } = fixture()
    const result = JSON.parse(psql(requestCall(actorUserId))) as Record<string, unknown>
    expect(result).toMatchObject({ result_error: null, request_status: 'received' })
    expect(psql(`select requested_by || '|' || status || '|' || (requested_at > now() - interval '1 minute')::text
      from deletion_requests where patient_id = '${patientId}';`)).toBe(`${actorUserId}|received|true`)
    expect(psql(`select actor_kind::text || '|' || actor_ref || '|' || action || '|' || target_kind || '|' || target_id || '|' || outcome
      from audit_events where action = 'profile.deletion_request' and actor_ref = '${actorUserId}';`))
      .toBe(`account|${actorUserId}|profile.deletion_request|patient|${patientId}|granted`)
  })

  test('auditFailureRollsBackTheDeletionRequest', () => {
    const { actorUserId, patientId } = fixture()
    psql(`create function deletion_audit_rollback_probe() returns trigger language plpgsql as $$
            begin raise exception 'deletion audit rejected' using errcode = 'check_violation'; end $$;
          create trigger deletion_audit_rollback_probe before insert on audit_events
            for each row when (new.action = 'profile.deletion_request' and new.actor_ref = '${actorUserId}')
            execute function deletion_audit_rollback_probe();`)
    try {
      expectSqlState(requestCall(actorUserId), '23514')
    } finally {
      psql('drop trigger deletion_audit_rollback_probe on audit_events; drop function deletion_audit_rollback_probe();')
    }
    expect(psql(`select count(*) from deletion_requests where patient_id = '${patientId}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where actor_ref = '${actorUserId}';`)).toBe('0')
  })

  test('duplicateReturnsConflictAndAddsExactlyOneDeniedAudit', () => {
    const { actorUserId, patientId } = fixture()
    expect(JSON.parse(psql(requestCall(actorUserId)))).toMatchObject({ result_error: null })
    expect(JSON.parse(psql(requestCall(actorUserId)))).toMatchObject({ result_error: 'request_already_open' })
    expect(psql(`select count(*) from deletion_requests where patient_id = '${patientId}';`)).toBe('1')
    expect(psql(`select outcome || ':' || count(*) from audit_events where actor_ref = '${actorUserId}' group by outcome order by outcome;`))
      .toBe('denied:1\ngranted:1')
  })

  test('concurrentRequestsCreateOneOpenRowAndAuditBothOutcomes', async () => {
    const { actorUserId, patientId } = fixture()
    const results = await Promise.all([psqlAsync(requestCall(actorUserId)), psqlAsync(requestCall(actorUserId))])
    expect(results.map((raw) => (JSON.parse(raw) as { result_error: string | null }).result_error).sort())
      .toEqual([null, 'request_already_open'].sort())
    expect(psql(`select count(*) from deletion_requests where patient_id = '${patientId}';`)).toBe('1')
    expect(psql(`select outcome || ':' || count(*) from audit_events where actor_ref = '${actorUserId}' group by outcome order by outcome;`))
      .toBe('denied:1\ngranted:1')
  })

  test('invalidRequestWritesOneDeniedAuditAndNoDeletionRequest', () => {
    const { actorUserId, patientId } = fixture()
    expect(JSON.parse(psql(requestCall(actorUserId, false)))).toMatchObject({ result_error: 'validation_failed' })
    expect(psql(`select count(*) from deletion_requests where patient_id = '${patientId}';`)).toBe('0')
    expect(psql(`select target_id || '|' || outcome from audit_events where actor_ref = '${actorUserId}';`))
      .toBe(`${patientId}|denied`)
  })
})

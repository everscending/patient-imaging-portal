import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const execFileAsync = promisify(execFile)
let run: Run

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', 'pip-testpg', 'psql', '-U', 'postgres', '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
}

async function psqlAsync(sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', 'pip-testpg', 'psql', '-U', 'postgres', '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  )
  return stdout.trim()
}

function appointmentFixture(): string {
  const appointmentId = randomUUID()
  const providerId = randomUUID()
  const serviceId = randomUUID()
  const patientId = randomUUID()
  const slotId = randomUUID()
  const suffix = randomUUID().replaceAll('-', '')
  psql(`
    insert into patients (id, patient_ref, date_of_birth, full_name, email)
      values ('${patientId}', 'PT-${suffix.slice(0, 8)}', '1990-01-01', 'Reminder Patient', '${suffix}@example.test');
    insert into providers (id, full_name, time_zone) values ('${providerId}', 'Dr. Reminder', 'America/Chicago');
    insert into services (id, slug, name) values ('${serviceId}', 'svc-${suffix}', 'Reminder Service');
    insert into provider_services (provider_id, service_id) values ('${providerId}', '${serviceId}');
    insert into slots (id, provider_id, starts_at, ends_at)
      values ('${slotId}', '${providerId}', now() + interval '24 hours', now() + interval '25 hours');
    insert into appointments (id, slot_id, patient_id, provider_id, service_id, status)
      values ('${appointmentId}', '${slotId}', '${patientId}', '${providerId}', '${serviceId}', 'confirmed');
  `)
  return appointmentId
}

function claimSql(appointmentId: string): string {
  return `select claim_reminder_send('${appointmentId}'::uuid, 24, 5);`
}

beforeAll(async () => {
  run = await startRun(await ensureContainer())
}, 120_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('reminder send claim — database concurrency boundary', () => {
  test('overlappingRetryClaimsAllowOneOwnerAndNeverReclaimItsActivePreSendRow', async () => {
    const appointmentId = appointmentFixture()

    const initial = await Promise.all([psqlAsync(claimSql(appointmentId)), psqlAsync(claimSql(appointmentId))])
    expect(initial.sort()).toEqual(['f', 't'])

    // Only an adapter-confirmed failure becomes retryable. Widen the UPDATE
    // overlap so the assertion proves the database serializes two real
    // sessions at this boundary rather than relying on JavaScript ordering.
    psql(`
      update reminder_sends set retryable_at = now() where appointment_id = '${appointmentId}';
      create function slow_reminder_retry_claim() returns trigger language plpgsql as $$
        begin
          if old.retryable_at is not null and new.retryable_at is null then
            perform pg_sleep(0.25);
          end if;
          return new;
        end
      $$;
      create trigger slow_reminder_retry_claim before update on reminder_sends
        for each row execute function slow_reminder_retry_claim();
    `)

    const retries = await Promise.all([psqlAsync(claimSql(appointmentId)), psqlAsync(claimSql(appointmentId))])
    expect(retries.sort()).toEqual(['f', 't'])
    expect(psql(`select outcome || '|' || (retryable_at is null)::text
      from reminder_sends where appointment_id = '${appointmentId}';`)).toBe('failed|true')
    expect(psql(claimSql(appointmentId))).toBe('f')
  }, 120_000)

  test('abandonedPreSendClaimWaitsForLeaseThenExactlyOneOverlappingWorkerRecoversIt', async () => {
    const appointmentId = appointmentFixture()

    expect(psql(claimSql(appointmentId))).toBe('t')
    expect(psql(claimSql(appointmentId))).toBe('f')

    psql(`update reminder_sends
      set attempted_at = now() - interval '4 minutes'
      where appointment_id = '${appointmentId}';`)
    expect(psql(claimSql(appointmentId))).toBe('f')

    psql(`
      update reminder_sends
        set attempted_at = now() - interval '6 minutes'
        where appointment_id = '${appointmentId}';
      create function slow_abandoned_reminder_claim() returns trigger language plpgsql as $$
        begin
          if old.attempted_at < statement_timestamp() - interval '5 minutes' then
            perform pg_sleep(0.25);
          end if;
          return new;
        end
      $$;
      create trigger slow_abandoned_reminder_claim before update on reminder_sends
        for each row execute function slow_abandoned_reminder_claim();
    `)

    const recovered = await Promise.all([psqlAsync(claimSql(appointmentId)), psqlAsync(claimSql(appointmentId))])
    expect(recovered.sort()).toEqual(['f', 't'])
    expect(psql(`select count(*) || '|' || outcome || '|' || (retryable_at is null)::text
      from reminder_sends where appointment_id = '${appointmentId}' group by outcome, retryable_at;`)).toBe(
      '1|failed|true',
    )
    expect(psql(claimSql(appointmentId))).toBe('f')
  }, 120_000)
})

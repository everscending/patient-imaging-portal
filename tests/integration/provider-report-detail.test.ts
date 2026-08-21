import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

let run: Run

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', 'pip-testpg', 'psql', '-U', 'postgres', '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
}

function appSql(userId: string, sql: string): string {
  const claims = JSON.stringify({ sub: userId }).replaceAll("'", "''")
  return `set role app_user; set request.jwt.claims = '${claims}'; ${sql}`
}

function read(userId: string, reportId: string): string {
  return psql(appSql(userId, `select row_to_json(detail) from read_report_detail('${reportId}') detail;`))
}

beforeAll(async () => {
  run = await startRun(await ensureContainer())
}, 120_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('caller-scoped report detail RPC', () => {
  test('assignedProviderAndAdminReadPreliminaryWhilePatientAndForeignProviderSeeNoRow', () => {
    const patientUser = randomUUID()
    const providerUser = randomUUID()
    const foreignProviderUser = randomUUID()
    const adminUser = randomUUID()
    const patientId = randomUUID()
    const providerId = randomUUID()
    const foreignProviderId = randomUUID()
    const visitId = randomUUID()
    const studyId = randomUUID()
    const preliminaryId = randomUUID()
    const signedId = randomUUID()

    psql(`
      insert into auth.users (id) values
        ('${patientUser}'), ('${providerUser}'), ('${foreignProviderUser}'), ('${adminUser}');
      insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email)
        values ('${patientId}', '${patientUser}', 'PT-3090', '1990-01-01', 'Hidden Patient', 'hidden@example.test');
      insert into providers (id, user_id, full_name, time_zone) values
        ('${providerId}', '${providerUser}', 'Assigned Provider', 'America/Chicago'),
        ('${foreignProviderId}', '${foreignProviderUser}', 'Foreign Provider', 'America/Chicago');
      insert into staff_admins (user_id) values ('${adminUser}');
      insert into visits (id, patient_id, provider_id, occurred_at, status)
        values ('${visitId}', '${patientId}', '${providerId}', now(), 'completed');
      insert into studies (id, visit_id, patient_id, description)
        values ('${studyId}', '${visitId}', '${patientId}', 'Authorized study');
      insert into reports (id, study_id, patient_id, status, findings, impression, signed_by, signed_at) values
        ('${preliminaryId}', '${studyId}', '${patientId}', 'preliminary', 'Draft findings', 'Draft impression', null, null),
        ('${signedId}', '${studyId}', '${patientId}', 'signed', 'Signed findings', 'Signed impression', '${providerId}', now());
    `)

    expect(JSON.parse(read(providerUser, preliminaryId))).toEqual(expect.objectContaining({
      id: preliminaryId,
      patient_ref: 'PT-3090',
      signed_at: null,
      signed_by_name: null,
    }))
    expect(JSON.parse(read(adminUser, preliminaryId))).toEqual(expect.objectContaining({ id: preliminaryId }))
    expect(read(patientUser, preliminaryId)).toBe('')
    expect(read(foreignProviderUser, preliminaryId)).toBe('')
    expect(JSON.parse(read(patientUser, signedId))).toEqual(expect.objectContaining({ id: signedId }))
  })

  test('onlyAppUserCanExecuteAndThePatientTablePolicyIsUnchanged', () => {
    expect(psql(`select has_function_privilege('app_user', 'read_report_detail(uuid)', 'EXECUTE');`)).toBe('t')
    expect(psql(`select has_function_privilege('public', 'read_report_detail(uuid)', 'EXECUTE');`)).toBe('f')
    expect(psql(`select qual from pg_policies where tablename = 'patients' and policyname = 'patients_self';`))
      .toBe('((id = current_patient_id()) OR is_admin())')
  })
})

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const CONTAINER = 'pip-testpg'
let run: Run

const patientAccount = randomUUID()
const providerAccount = randomUUID()
const foreignProviderAccount = randomUUID()
const adminAccount = randomUUID()
const dualRoleAccount = randomUUID()
const unlinkedAccount = randomUUID()
const patientId = randomUUID()
const foreignPatientId = randomUUID()
const providerId = randomUUID()
const foreignProviderId = randomUUID()
const dualRoleProviderId = randomUUID()
const visitId = randomUUID()
const foreignVisitId = randomUUID()
const studyId = randomUUID()
const foreignStudyId = randomUUID()

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
}

/** Returns `<actor_kind>|<status>|<patient_id or ->` for one grant round. */
function grant(userId: string, id: string): string {
  return psql(`
    set role app_user;
    set request.jwt.claims = ${sqlLiteral(JSON.stringify({ sub: userId }))};
    select (result->>'actor_kind') || '|' || (result->>'status') || '|' || coalesce(result->>'patient_id', '-')
      from (select grant_study_access('${id}') as result) study_access;
  `)
}

function auditsFor(id: string): string {
  return psql(`
    select actor_kind || '|' || action || '|' || target_kind || '|' || outcome
      from audit_events
     where target_id = '${id}'
     order by id;
  `)
}

beforeAll(async () => {
  run = await startRun(await ensureContainer())
  psql(`
    insert into auth.users (id) values
      ('${patientAccount}'), ('${providerAccount}'), ('${foreignProviderAccount}'),
      ('${adminAccount}'), ('${dualRoleAccount}'), ('${unlinkedAccount}');
    insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email)
    values
      ('${patientId}', '${patientAccount}', 'PT-3151', '1990-01-01', 'Study Patient', 'study@example.test'),
      ('${foreignPatientId}', null, 'PT-3152', '1991-01-01', 'Foreign Patient', 'foreign@example.test');
    insert into providers (id, user_id, full_name, time_zone) values
      ('${providerId}', '${providerAccount}', 'Assigned Provider', 'America/Chicago'),
      ('${foreignProviderId}', '${foreignProviderAccount}', 'Foreign Provider', 'America/Chicago'),
      ('${dualRoleProviderId}', '${dualRoleAccount}', 'Staff Provider', 'America/Chicago');
    insert into staff_admins (user_id) values ('${adminAccount}'), ('${dualRoleAccount}');
    insert into visits (id, patient_id, provider_id, occurred_at, status) values
      ('${visitId}', '${patientId}', '${providerId}', now(), 'completed'),
      ('${foreignVisitId}', '${foreignPatientId}', '${foreignProviderId}', now(), 'completed');
    insert into studies (id, visit_id, patient_id, description) values
      ('${studyId}', '${visitId}', '${patientId}', 'Owned study'),
      ('${foreignStudyId}', '${foreignVisitId}', '${foreignPatientId}', 'Foreign study');
  `)
}, 60_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('012 classify-with-grant study access', () => {
  test('one round classifies the caller and decides for the patient, the visit provider, and an admin', () => {
    expect(grant(patientAccount, studyId)).toBe(`patient|200|${patientId}`)
    expect(grant(providerAccount, studyId)).toBe(`provider|200|${patientId}`)
    expect(grant(adminAccount, foreignStudyId)).toBe(`admin|200|${foreignPatientId}`)

    expect(auditsFor(studyId)).toBe([
      'account|study.view|study|granted',
      'account|study.view|study|granted',
    ].join('\n'))
    expect(auditsFor(foreignStudyId)).toBe('account|study.view|study|granted')
  })

  test('an account that is both staff and a provider keeps its admin authority', () => {
    // As a provider alone this account owns no visit on either study.
    expect(grant(dualRoleAccount, studyId)).toBe(`admin|200|${patientId}`)
  })

  test('a foreign patient, an unassigned provider, and a missing study are one opaque 404', () => {
    const missingStudyId = randomUUID()
    expect(grant(patientAccount, foreignStudyId)).toBe('patient|404|-')
    expect(grant(foreignProviderAccount, studyId)).toBe('provider|404|-')
    expect(grant(patientAccount, missingStudyId)).toBe('patient|404|-')
    expect(grant(foreignProviderAccount, missingStudyId)).toBe('provider|404|-')

    expect(auditsFor(missingStudyId)).toBe([
      'account|study.view|study|denied',
      'account|study.view|study|denied',
    ].join('\n'))
  })

  test('an authenticated account with no identity link receives 403 and one denial audit', () => {
    const isolatedStudyId = randomUUID()
    psql(`insert into studies (id, visit_id, patient_id, description)
          values ('${isolatedStudyId}', '${visitId}', '${patientId}', 'Isolated study');`)

    expect(grant(unlinkedAccount, isolatedStudyId)).toBe('patient|403|-')
    expect(auditsFor(isolatedStudyId)).toBe('account|study.view|study|denied')
  })

  test('the local PostgREST claim setting reaches a decision instead of raising', () => {
    // Local PostgREST supplies request.jwt.claim.sub rather than the hosted
    // claims object. Reading the claim directly raised insufficient_privilege
    // here, which the route surfaced as a 503 for every study request.
    // auth.uid() still resolves nothing from it in this harness, so the caller
    // classifies as an unlinked patient — a decision, which is the point.
    expect(psql(`
      set role app_user;
      set request.jwt.claim.sub = ${sqlLiteral(patientAccount)};
      select grant_study_access('${studyId}')->>'status';
    `)).toBe('403')
  })

  test('a request with no verified subject decides nothing and audits nothing', () => {
    const before = psql('select count(*) from audit_events;')
    expect(() => psql(`
      set role app_user;
      select grant_study_access('${studyId}');
    `)).toThrow(/authenticated account required/)
    expect(psql('select count(*) from audit_events;')).toBe(before)
  })

  test('the function executes with caller privileges, never a definer bypass', () => {
    expect(psql(`
      select has_function_privilege('app_user', 'grant_study_access(uuid)', 'execute')::text
             || '|' || (not prosecdef)::text
        from pg_proc
       where oid = 'grant_study_access(uuid)'::regprocedure;
    `)).toBe('true|true')
  })
})

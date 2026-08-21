import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const CONTAINER = 'pip-testpg'
let run: Run

const accountId = randomUUID()
const patientId = randomUUID()
const foreignPatientId = randomUUID()
const unlinkedAccountId = randomUUID()
const providerId = randomUUID()
const visitId = randomUUID()
const foreignVisitId = randomUUID()
const studyId = randomUUID()
const foreignStudyId = randomUUID()
const clipId = randomUUID()

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

function grant(userId: string, kind: 'study' | 'clip', id: string): string {
  return psql(`
    set role app_user;
    set request.jwt.claims = ${sqlLiteral(JSON.stringify({ sub: userId }))};
    select (result->>'status') || '|' || coalesce(result->>'patient_id', '-')
      from (select grant_patient_imaging_access('${kind}', '${id}') as result) access_grant;
  `)
}

beforeAll(async () => {
  run = await startRun(await ensureContainer())
  psql(`
    insert into auth.users (id) values ('${accountId}'), ('${unlinkedAccountId}');
    insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email)
    values
      ('${patientId}', '${accountId}', 'PT-3161', '1990-01-01', 'Grant Patient', 'grant314@example.test'),
      ('${foreignPatientId}', null, 'PT-3162', '1991-01-01', 'Foreign Patient', 'foreign314@example.test');
    insert into providers (id, full_name, time_zone)
    values ('${providerId}', 'Grant Provider', 'America/Chicago');
    insert into visits (id, patient_id, provider_id, occurred_at, status)
    values
      ('${visitId}', '${patientId}', '${providerId}', now(), 'completed'),
      ('${foreignVisitId}', '${foreignPatientId}', '${providerId}', now(), 'completed');
    insert into studies (id, visit_id, patient_id, description)
    values
      ('${studyId}', '${visitId}', '${patientId}', 'Owned study'),
      ('${foreignStudyId}', '${foreignVisitId}', '${foreignPatientId}', 'Foreign study');
    insert into cine_clips (id, study_id, patient_id, frame_count, default_fps)
    values ('${clipId}', '${studyId}', '${patientId}', 1, 12);
  `)
}, 60_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('014 patient imaging grant resolves the subject through the local-compatible adapter', () => {
  test('owned study and clip each still return one grant and persist one correlated audit row', () => {
    expect(grant(accountId, 'study', studyId)).toBe(`200|${patientId}`)
    expect(grant(accountId, 'clip', clipId)).toBe(`200|${patientId}`)

    expect(psql(`
      select action || '|' || target_kind || '|' || target_id || '|' || outcome
        from audit_events
       order by id;
    `)).toBe([
      `study.view|study|${studyId}|granted`,
      `clip.view|clip|${clipId}|granted`,
    ].join('\n'))
  })

  test('foreign and missing targets are still indistinguishable 404 denials with one audit each', () => {
    const missingClipId = randomUUID()
    expect(grant(accountId, 'study', foreignStudyId)).toBe('404|-')
    expect(grant(accountId, 'clip', missingClipId)).toBe('404|-')

    expect(psql(`
      select target_id || '|' || outcome
        from audit_events
       where target_id in ('${foreignStudyId}', '${missingClipId}')
       order by id;
    `)).toBe(`${foreignStudyId}|denied\n${missingClipId}|denied`)
  })

  test('an authenticated account without an identity link still receives 403 and one denial audit', () => {
    expect(grant(unlinkedAccountId, 'clip', clipId)).toBe('403|-')
    expect(psql(`
      select actor_ref || '|' || action || '|' || target_id || '|' || outcome
        from audit_events
       where actor_ref = '${unlinkedAccountId}';
    `)).toBe(`${unlinkedAccountId}|clip.view|${clipId}|denied`)
  })

  test('the local PostgREST claim setting reaches a decision instead of raising insufficient_privilege', () => {
    // Local PostgREST supplies request.jwt.claim.sub rather than the hosted
    // claims object. Reading request.jwt.claims directly raised
    // insufficient_privilege here, which the cine-manifest route surfaced as
    // a 503 for every clip request (JOR-316). current_patient_id() still
    // resolves through auth.uid(), which this harness's claim setting does
    // not feed, so the caller classifies as unlinked — a decision, which is
    // the point, matching migration 012's equivalent study-route assertion.
    expect(psql(`
      set role app_user;
      set request.jwt.claim.sub = ${sqlLiteral(accountId)};
      select grant_patient_imaging_access('clip', '${clipId}')->>'status';
    `)).toBe('403')
  })

  test('a request with no verified subject decides nothing and audits nothing', () => {
    const before = psql('select count(*) from audit_events;')
    expect(() => psql(`
      set role app_user;
      select grant_patient_imaging_access('clip', '${clipId}');
    `)).toThrow(/authenticated account required/)
    expect(psql('select count(*) from audit_events;')).toBe(before)
  })

  test('the function executes with caller privileges, never a definer bypass', () => {
    expect(psql(`
      select has_function_privilege(
               'app_user',
               'grant_patient_imaging_access(text,uuid)',
               'execute'
             )::text
             || '|'
             || (not prosecdef)::text
        from pg_proc
       where oid = 'grant_patient_imaging_access(text,uuid)'::regprocedure;
    `)).toBe('true|true')
  })
})

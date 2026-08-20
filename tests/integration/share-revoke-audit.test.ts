// JOR-300 persistence proof. The integration harness supplies PostgreSQL but
// not Supabase Auth/PostgREST, so only that wire boundary is adapted. The
// public DELETE handler, PHI guard, centralized audit writer, migrated RLS,
// and durable audit_events row are all real.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

vi.mock('server-only', () => ({}))

const { anonClientMock, authClientMock, serviceClientMock, cookieMock } = vi.hoisted(() => ({
  anonClientMock: vi.fn(),
  authClientMock: vi.fn(),
  serviceClientMock: vi.fn(),
  cookieMock: vi.fn(),
}))

vi.mock('../../lib/db/client', () => ({
  anonClient: anonClientMock,
  authClient: authClientMock,
  serviceClient: serviceClientMock,
}))

vi.mock('next/headers', () => ({ cookies: cookieMock }))
vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('../../lib/config', () => ({ config: {} }))

import { DELETE as revokeDelete } from '../../app/api/shares/[id]/route'

const CONTAINER = 'pip-testpg'
const ACCESS_TOKEN = 'jor-300-caller-token'
const ACTOR_USER_ID = '10000000-0000-4000-8000-000000000001'
const ACTOR_PATIENT_ID = '20000000-0000-4000-8000-000000000002'
const FOREIGN_USER_ID = '30000000-0000-4000-8000-000000000003'
const FOREIGN_PATIENT_ID = '40000000-0000-4000-8000-000000000004'
const PROVIDER_ID = '50000000-0000-4000-8000-000000000005'
const VISIT_ID = '60000000-0000-4000-8000-000000000006'
const STUDY_ID = '70000000-0000-4000-8000-000000000007'
const IMAGE_ID = '80000000-0000-4000-8000-000000000008'
const FOREIGN_SHARE_ID = '90000000-0000-4000-8000-000000000009'

type QueryRow = Record<string, unknown>
type QueryResult = { data: QueryRow | null; error: null }

let run: Run

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
}

function appSql(sql: string): string {
  return psql(`set role app_user; set request.jwt.claim.sub = ${literal(ACTOR_USER_ID)}; ${sql}`)
}

function postgresCallerClient() {
  return {
    from(table: string) {
      const filters = new Map<string, string>()
      const query = {
        select() {
          return query
        },
        eq(column: string, value: unknown) {
          filters.set(column, String(value))
          return query
        },
        async maybeSingle(): Promise<QueryResult> {
          let sql: string
          if (table === 'patients') {
            sql = `select coalesce((select row_to_json(row)::text from
              (select id from patients where user_id = ${literal(filters.get('user_id') ?? '')}::uuid limit 1) row), 'null');`
          } else if (table === 'share_links') {
            sql = `select coalesce((select row_to_json(row)::text from
              (select id, patient_id from share_links
                where id = ${literal(filters.get('id') ?? '')}::uuid
                  and patient_id = ${literal(filters.get('patient_id') ?? '')}::uuid limit 1) row), 'null');`
          } else {
            throw new Error(`JOR-300 PostgREST adapter: unexpected read table ${table}`)
          }
          return { data: JSON.parse(appSql(sql)) as QueryRow | null, error: null }
        },
        async insert(row: QueryRow): Promise<{ error: null }> {
          if (table !== 'audit_events') throw new Error(`JOR-300 PostgREST adapter: unexpected insert table ${table}`)
          const detailSql = row.detail === null || row.detail === undefined
            ? 'null'
            : `${literal(JSON.stringify(row.detail))}::jsonb`
          appSql(`insert into audit_events
            (actor_kind, actor_ref, action, target_kind, target_id, outcome, detail)
            values (
              ${literal(String(row.actor_kind))}::actor_kind,
              ${literal(String(row.actor_ref))},
              ${literal(String(row.action))},
              ${literal(String(row.target_kind))},
              ${literal(String(row.target_id))}::uuid,
              ${literal(String(row.outcome))},
              ${detailSql}
            );`)
          return { error: null }
        },
      }
      return query
    },
  }
}

beforeAll(async () => {
  run = await startRun(await ensureContainer())
  psql(`
    create or replace function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    insert into auth.users (id) values ('${ACTOR_USER_ID}'), ('${FOREIGN_USER_ID}');
    insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email) values
      ('${ACTOR_PATIENT_ID}', '${ACTOR_USER_ID}', 'PT-3001', '1990-01-01', 'Audit Caller', 'caller@example.test'),
      ('${FOREIGN_PATIENT_ID}', '${FOREIGN_USER_ID}', 'PT-3002', '1991-02-02', 'Foreign Patient', 'foreign@example.test');
    insert into providers (id, full_name, time_zone)
      values ('${PROVIDER_ID}', 'Dr. Audit', 'America/Chicago');
    insert into visits (id, patient_id, provider_id, occurred_at, status)
      values ('${VISIT_ID}', '${FOREIGN_PATIENT_ID}', '${PROVIDER_ID}', now(), 'completed');
    insert into studies (id, visit_id, patient_id, description)
      values ('${STUDY_ID}', '${VISIT_ID}', '${FOREIGN_PATIENT_ID}', 'Foreign study');
    insert into images (id, study_id, patient_id, storage_key, width, height, ordinal)
      values ('${IMAGE_ID}', '${STUDY_ID}', '${FOREIGN_PATIENT_ID}', 'foreign-image', 10, 10, 1);
    insert into share_links
      (id, token_hash, patient_id, image_id, created_by, recipient_email, expires_at)
      values ('${FOREIGN_SHARE_ID}', repeat('a', 64), '${FOREIGN_PATIENT_ID}', '${IMAGE_ID}',
        '${FOREIGN_USER_ID}', 'recipient@example.test', now() + interval '1 day');
  `)

  cookieMock.mockResolvedValue({ get: () => ({ value: ACCESS_TOKEN }) })
  authClientMock.mockReturnValue({
    auth: {
      getUser: vi.fn(async (token: string) => token === ACCESS_TOKEN
        ? { data: { user: { id: ACTOR_USER_ID } }, error: null }
        : { data: { user: null }, error: { status: 401 } }),
    },
  })
  anonClientMock.mockImplementation((token: string) => {
    if (token !== ACCESS_TOKEN) throw new Error('JOR-300 PostgREST adapter: unexpected caller token')
    return postgresCallerClient()
  })
  serviceClientMock.mockImplementation(() => {
    throw new Error('JOR-300: authenticated foreign revoke must not use the service role')
  })
}, 120_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('public share revoke denial audit persistence', () => {
  test('foreignRevokePersistsExactlyOneDurableDeniedShareRevokeRow', async () => {
    const response = await revokeDelete(
      new Request(`https://portal.example/api/shares/${FOREIGN_SHARE_ID}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: FOREIGN_SHARE_ID }) },
    )

    expect(response.status).toBe(404)
    expect(await response.text()).toBe(JSON.stringify({ error: 'not_found', message: 'The requested resource was not found.' }))
    expect(psql(`select count(*) from audit_events;`)).toBe('1')
    expect(psql(`select actor_kind || '|' || actor_ref || '|' || action || '|' || target_kind || '|' ||
      target_id || '|' || outcome || '|' || (detail is null)::text from audit_events;`)).toBe(
      `account|${ACTOR_USER_ID}|share.revoke|share_link|${FOREIGN_SHARE_ID}|denied|true`,
    )
    expect(psql(`select revoked_at is null from share_links where id = '${FOREIGN_SHARE_ID}';`)).toBe('t')
    expect(serviceClientMock).not.toHaveBeenCalled()
  })
})

// db/storage/bucket.sql is applied to the real Supabase project (whose
// Postgres already has `storage.buckets`/`storage.objects` and the `anon` /
// `authenticated` roles, provisioned by the platform, not this repo). The
// stub below recreates just enough of that shape — schema, both tables, RLS
// enabled with no policy on storage.objects, and the two roles — so the file
// can be exercised against the same disposable pip_run_<random> database
// used elsewhere (ADR-0013), the same way tests/setup/postgres.ts stubs
// auth.users for db/migrations/001_core.sql.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const BUCKET_SQL_PATH = join(process.cwd(), 'db', 'storage', 'bucket.sql')
const BUCKET_SQL = readFileSync(BUCKET_SQL_PATH, 'utf8')

function psql(dbName: string, sql: string, opts: { role?: string } = {}): string {
  const prefixed = opts.role ? `set role ${opts.role}; ${sql}` : sql
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', prefixed], {
    encoding: 'utf8',
  }).trim()
}

// Mirrors AUTH_STUB_SQL in tests/setup/postgres.ts: the minimum real shape
// of Supabase's storage schema, not the whole platform.
const STORAGE_STUB_SQL = `
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;
grant usage on schema storage to anon, authenticated;
grant select on storage.objects to anon, authenticated;
`

let container: Container
let run: Run

beforeAll(async () => {
  container = await ensureContainer()
  run = await startRun(container)
  psql(run.dbName, STORAGE_STUB_SQL)
}, 60_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('AC: db/storage/bucket.sql creates a bucket named phi with public access off', () => {
  test('createsPrivatePhiBucket', function createsPrivatePhiBucket() {
    psql(run.dbName, BUCKET_SQL)
    const row = psql(run.dbName, `select id || '|' || name || '|' || public from storage.buckets;`)
    expect(row).toBe('phi|phi|false')
  })
})

describe('AC + adversarial: re-running bucket.sql leaves exactly one bucket (never a second bucket holding PHI)', () => {
  test('rerunLeavesExactlyOneBucket', function rerunLeavesExactlyOneBucket() {
    psql(run.dbName, BUCKET_SQL)
    psql(run.dbName, BUCKET_SQL)
    psql(run.dbName, BUCKET_SQL)
    const count = psql(run.dbName, `select count(*) from storage.buckets;`)
    expect(count).toBe('1')
  })
})

describe('adversarial: bucket.sql declares exactly one bucket, never a second one holding PHI', () => {
  test('bucketSqlDeclaresExactlyOneInsert', function bucketSqlDeclaresExactlyOneInsert() {
    const insertCount = [...BUCKET_SQL.matchAll(/insert into storage\.buckets/g)].length
    expect(insertCount).toBe(1)
    expect(BUCKET_SQL).toMatch(/values\s*\(\s*'phi'\s*,\s*'phi'\s*,\s*false\s*\)/)
  })
})

describe('adversarial: bucket.sql creating the bucket with public access on is caught', () => {
  test('bucketSqlForcesPublicFalseEvenAfterAConsoleFlip', function bucketSqlForcesPublicFalseEvenAfterAConsoleFlip() {
    psql(run.dbName, BUCKET_SQL)
    // Simulate a console click flipping the bucket public — the exact drift
    // the design decision says bucket.sql must self-heal, not just avoid on
    // its own first run.
    psql(run.dbName, `update storage.buckets set public = true where id = 'phi';`)
    expect(psql(run.dbName, `select public from storage.buckets where id = 'phi';`)).toBe('t')

    psql(run.dbName, BUCKET_SQL)
    expect(psql(run.dbName, `select public from storage.buckets where id = 'phi';`)).toBe('f')
  })

  test('adversarial: a bucket.sql that inserted public = true would fail the AC test above', function bucketSqlLiteralNeverSaysPublicTrue() {
    expect(BUCKET_SQL).not.toMatch(/values\s*\(\s*'phi'\s*,\s*'phi'\s*,\s*true\s*\)/)
  })
})

describe('AC + mandatory adversarial: an anonymous GET of a known object key in phi never returns bytes', () => {
  test('noAnonSelectPolicyOnStorageObjects', function noAnonSelectPolicyOnStorageObjects() {
    psql(run.dbName, BUCKET_SQL)
    const objectName = 'known-object-key.dcm'
    psql(run.dbName, `insert into storage.objects (bucket_id, name) values ('phi', '${objectName}');`)

    // RLS is enabled on storage.objects and bucket.sql creates no policy for
    // anon or authenticated (the design decision this test exists to pin) —
    // so both roles see zero rows for a name they know exists, the same
    // "not found" the real Storage API returns rather than bytes.
    const anonRows = psql(run.dbName, `select count(*) from storage.objects where bucket_id = 'phi' and name = '${objectName}';`, { role: 'anon' })
    expect(anonRows).toBe('0')
    const authenticatedRows = psql(
      run.dbName,
      `select count(*) from storage.objects where bucket_id = 'phi' and name = '${objectName}';`,
      { role: 'authenticated' },
    )
    expect(authenticatedRows).toBe('0')
  })

  test('adversarial: a select policy for anon on storage.objects would make the row above visible', function anonPolicyWouldExposeTheRow() {
    const objectName = 'policy-check-key.dcm'
    psql(run.dbName, `insert into storage.objects (bucket_id, name) values ('phi', '${objectName}');`)
    psql(run.dbName, `create policy anon_can_read on storage.objects for select to anon using (true);`)
    const rows = psql(
      run.dbName,
      `select count(*) from storage.objects where bucket_id = 'phi' and name = '${objectName}';`,
      { role: 'anon' },
    )
    expect(rows).toBe('1') // proves the assertion above is real, not a stub that always reads 0
    psql(run.dbName, `drop policy anon_can_read on storage.objects;`)
  })
})

describe('AC: bucket.sql creates no policy on storage.objects', () => {
  test('bucketSqlCreatesNoPolicy', function bucketSqlCreatesNoPolicy() {
    expect(BUCKET_SQL).not.toMatch(/create policy/i)
  })
})

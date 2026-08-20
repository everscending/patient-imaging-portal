import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  buildMigrationProgram,
  buildSeedChecksum,
  provisionSeed,
  readMigrationFiles,
  type DeploymentConfig,
} from '../../scripts/provision-deployed-stack'
import type { AuthAdminClient } from '../../db/seed'
import type { PhiStorageClient } from '../../db/seed/storage'
import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const CONTAINER = 'pip-testpg'

function psql(dbName: string, sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-f', '-'],
    { encoding: 'utf8', input: sql },
  ).trim()
}

const PLATFORM_STUB = `
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  else
    alter role authenticated noinherit;
  end if;
end $$;
`

let run: Run
let emptyMigrationsDir: string

beforeAll(async () => {
  emptyMigrationsDir = mkdtempSync(path.join(tmpdir(), 'pip-deploy-empty-migrations-'))
  run = await startRun(await ensureContainer(), emptyMigrationsDir)
  psql(run.dbName, PLATFORM_STUB)
}, 60_000)

afterAll(async () => {
  if (run) await stopRun(run)
  if (emptyMigrationsDir) rmSync(emptyMigrationsDir, { recursive: true, force: true })
})

describe('deployed provisioning program', () => {
  test('applies all migrations and grants twice without replaying schema DDL', () => {
    const program = buildMigrationProgram(readMigrationFiles())
    psql(run.dbName, program)
    psql(run.dbName, program)

    expect(psql(run.dbName, 'select count(*) from app_deploy.schema_migrations;')).toBe('11')
    expect(psql(run.dbName, "select count(*) from storage.buckets where id = 'phi' and not public;")).toBe('1')
    expect(psql(run.dbName, "select has_table_privilege('authenticated', 'patients', 'select');")).toBe('t')
    expect(psql(run.dbName, "select has_table_privilege('authenticated', 'appointments', 'delete');")).toBe('f')
    expect(psql(run.dbName, "select has_schema_privilege('anon', 'public', 'usage');")).toBe('f')
    expect(
      psql(
        run.dbName,
        "select has_function_privilege('authenticated', 'link_patient_identity(uuid,uuid,text,text,timestamptz)', 'execute');",
      ),
    ).toBe('f')
    expect(
      psql(
        run.dbName,
        "select has_function_privilege('anon', 'link_patient_identity(uuid,uuid,text,text,timestamptz)', 'execute');",
      ),
    ).toBe('f')
  }, 60_000)

  test('retries a partial seed, stays idempotent, and rejects row-shaping input drift', async () => {
    const objects = new Map<string, Buffer>()
    const storage: PhiStorageClient = {
      storage: {
        from: () => ({
          async list() {
            return {
              data: [...objects].map(([name, bytes]) => ({
                name,
                metadata: { eTag: `"${createHash('md5').update(bytes).digest('hex')}"` },
              })),
              error: null,
            }
          },
          async upload(name, body) {
            objects.set(name, body)
            return { data: {}, error: null }
          },
        }),
      },
    }
    const users = new Map<string, string>()
    const authAdmin: AuthAdminClient = {
      auth: {
        admin: {
          async createUser(attrs) {
            const email = users.get(attrs.id)
            if (email === undefined) {
              users.set(attrs.id, attrs.email)
              psql(run.dbName, `insert into auth.users (id) values ('${attrs.id}') on conflict do nothing;`)
              return { data: { user: { id: attrs.id } }, error: null }
            }
            return email === attrs.email
              ? { data: { user: { id: attrs.id } }, error: null }
              : { data: { user: null }, error: { message: 'identity mismatch' } }
          },
        },
      },
    }
    const config: DeploymentConfig = {
      supabaseUrl: 'http://127.0.0.1',
      supabaseAnonKey: 'anon',
      supabaseServiceRoleKey: 'service',
      seedSourceSeed: 'deploy-integration',
      minChangeNoticeHours: 24,
    }
    let failOnce = true
    const sql = (program: string): string => {
      if (failOnce && program.includes('insert into app_deploy.seed_runs')) {
        failOnce = false
        throw new Error('injected seed transaction failure')
      }
      return psql(run.dbName, program)
    }

    await expect(provisionSeed(config, storage, authAdmin, sql)).rejects.toThrow('injected seed transaction failure')
    expect(psql(run.dbName, 'select count(*) from patients;')).toBe('0')
    expect(psql(run.dbName, 'select count(*) from app_deploy.seed_runs;')).toBe('0')

    await provisionSeed(config, storage, authAdmin, sql)
    const patientCount = psql(run.dbName, 'select count(*) from patients;')
    const objectCount = objects.size
    await provisionSeed(config, storage, authAdmin, sql)
    expect(psql(run.dbName, 'select count(*) from patients;')).toBe(patientCount)
    expect(psql(run.dbName, 'select count(*) from app_deploy.seed_runs;')).toBe('1')
    expect(objects.size).toBe(objectCount)
    expect(users.size).toBe(3)

    psql(
      run.dbName,
      "update app_deploy.seed_runs set checksum = '0131eb052fffffec6b7c757d8b0df5269840856a431309a6cd132dcafa26794f' where singleton;",
    )
    await provisionSeed(config, storage, authAdmin, sql)
    expect(psql(run.dbName, 'select checksum from app_deploy.seed_runs where singleton;')).toBe(
      buildSeedChecksum(config),
    )

    await expect(
      provisionSeed({ ...config, minChangeNoticeHours: 48 }, storage, authAdmin, sql),
    ).rejects.toThrow('applied seed does not match this checkout')
    await expect(
      provisionSeed({ ...config, seedSourceSeed: 'changed-source' }, storage, authAdmin, sql),
    ).rejects.toThrow('applied seed does not match this checkout')
  }, 60_000)
})

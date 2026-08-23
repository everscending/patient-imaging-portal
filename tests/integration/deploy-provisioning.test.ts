import { execFileSync, spawnSync } from 'node:child_process'
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
import { generateAssetPool } from '../../db/seed/assets'
import { buildRowSet } from '../../db/seed/rows'
import type { PhiStorageClient } from '../../db/seed/storage'
import { ensureContainer, startRun, stopRun, type Run } from '../setup/postgres'

const CONTAINER = 'pip-testpg'
const PREVIOUS_SEED_IDENTITY_CHECKSUM = '39ee3a9e535584d7d8386ecdb4b6ec248151f43becf99558644cabc7cc75b837'

function psql(dbName: string, sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-f', '-'],
    { encoding: 'utf8', input: sql },
  ).trim()
}

/** Like `psql`, but never throws — returns the real exit status and stderr so a
 *  failing run can be asserted on directly instead of just catching a thrown Error. */
function runProgram(dbName: string, sql: string): { status: number | null; stderr: string } {
  const result = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-f', '-'],
    { encoding: 'utf8', input: sql },
  )
  return { status: result.status, stderr: result.stderr }
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
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit;
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

    expect(psql(run.dbName, 'select count(*) from app_deploy.schema_migrations;')).toBe('20')
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
    expect(
      psql(
        run.dbName,
        "select has_function_privilege('authenticated', 'grant_patient_imaging_access(text,uuid)', 'execute');",
      ),
    ).toBe('t')
    expect(
      psql(
        run.dbName,
        "select has_function_privilege('anon', 'grant_patient_imaging_access(text,uuid)', 'execute');",
      ),
    ).toBe('f')
    expect(
      psql(
        run.dbName,
        "select has_function_privilege('service_role', 'grant_patient_imaging_access(text,uuid)', 'execute');",
      ),
    ).toBe('f')
    expect(
      psql(
        run.dbName,
        "select has_function_privilege('authenticated', 'grant_study_access(uuid)', 'execute');",
      ),
    ).toBe('t')
    expect(
      psql(run.dbName, "select has_function_privilege('anon', 'grant_study_access(uuid)', 'execute');"),
    ).toBe('f')
    expect(
      psql(run.dbName, "select has_function_privilege('service_role', 'grant_study_access(uuid)', 'execute');"),
    ).toBe('f')
    expect(
      psql(run.dbName, "select has_function_privilege('authenticated', 'read_report_detail(uuid)', 'execute');"),
    ).toBe('t')
    expect(
      psql(run.dbName, "select has_function_privilege('anon', 'read_report_detail(uuid)', 'execute');"),
    ).toBe('f')
  }, 60_000)

  test('a drifted recorded checksum fails the program loudly instead of silently skipping later migrations', () => {
    const files = readMigrationFiles()
    const program = buildMigrationProgram(files)
    const target = files[0]

    psql(
      run.dbName,
      `update app_deploy.schema_migrations set checksum = 'deadbeef' where filename = '${target.name}';`,
    )
    try {
      const result = runProgram(run.dbName, program)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`${target.name}: applied migration checksum changed`)
      expect(psql(run.dbName, 'select count(*) from app_deploy.schema_migrations;')).toBe('20')
    } finally {
      psql(
        run.dbName,
        `update app_deploy.schema_migrations set checksum = '${target.checksum}' where filename = '${target.name}';`,
      )
    }
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

    const rowSet = buildRowSet({
      pool: generateAssetPool(config.seedSourceSeed),
      sourceSeed: config.seedSourceSeed,
      now: new Date('2026-08-19T00:00:00.000Z'),
      minChangeNoticeHours: config.minChangeNoticeHours,
    })
    const performanceClipId = rowSet.fixtures.performanceCineClipId
    const brokenClipId = rowSet.fixtures.brokenCineClipId
    const firstPerformanceFrame = rowSet.cineFrames.find(
      (frame) => frame.clip_id === performanceClipId && frame.frame_index === 0,
    )!
    const brokenBefore = psql(
      run.dbName,
      `select json_build_object(
         'frameCount', c.frame_count,
         'frames', (select json_agg(json_build_array(f.frame_index, f.storage_key) order by f.frame_index)
                      from cine_frames f where f.clip_id = c.id)
       )::text from cine_clips c where c.id = '${brokenClipId}';`,
    )
    psql(
      run.dbName,
      `begin;
       delete from cine_frames where clip_id = '${performanceClipId}' and frame_index >= 20;
       update cine_frames set storage_key = 'unexpected-key'
        where clip_id = '${performanceClipId}' and frame_index = 0;
       update cine_clips set frame_count = 20 where id = '${performanceClipId}';
       update app_deploy.seed_runs
          set checksum = '0131eb052fffffec6b7c757d8b0df5269840856a431309a6cd132dcafa26794f'
        where singleton;
       commit;`,
    )
    await expect(provisionSeed(config, storage, authAdmin, sql)).rejects.toThrow()
    expect(psql(run.dbName, `select frame_count from cine_clips where id = '${performanceClipId}';`)).toBe('20')
    expect(psql(run.dbName, 'select checksum from app_deploy.seed_runs where singleton;')).toBe(
      PREVIOUS_SEED_IDENTITY_CHECKSUM,
    )
    psql(
      run.dbName,
      `update cine_frames set storage_key = '${firstPerformanceFrame.storage_key}'
        where clip_id = '${performanceClipId}' and frame_index = 0;`,
    )
    await provisionSeed(config, storage, authAdmin, sql)
    expect(psql(run.dbName, `select frame_count from cine_clips where id = '${performanceClipId}';`)).toBe('100')
    expect(
      JSON.parse(psql(
        run.dbName,
        `select json_agg(json_build_array(frame_index, storage_key) order by frame_index)::text
           from cine_frames where clip_id = '${performanceClipId}';`,
      )),
    ).toEqual(
      rowSet.cineFrames
        .filter((frame) => frame.clip_id === performanceClipId)
        .sort((a, b) => a.frame_index - b.frame_index)
        .map((frame) => [frame.frame_index, frame.storage_key]),
    )
    expect(psql(run.dbName, `select count(*) from cine_frames where clip_id = '${performanceClipId}';`)).toBe('100')
    expect(psql(run.dbName, `select count(*) from cine_frames where clip_id = '${brokenClipId}';`)).toBe('100')
    expect(
      psql(
        run.dbName,
        `select json_build_object(
           'frameCount', c.frame_count,
           'frames', (select json_agg(json_build_array(f.frame_index, f.storage_key) order by f.frame_index)
                        from cine_frames f where f.clip_id = c.id)
         )::text from cine_clips c where c.id = '${brokenClipId}';`,
      ),
    ).toBe(brokenBefore)
    expect(psql(run.dbName, 'select checksum from app_deploy.seed_runs where singleton;')).toBe(
      buildSeedChecksum(config),
    )
    await provisionSeed(config, storage, authAdmin, sql)
    expect(psql(run.dbName, `select count(*) from cine_frames where clip_id = '${performanceClipId}';`)).toBe('100')
    expect(psql(run.dbName, 'select count(*) from patients;')).toBe(patientCount)
    expect(psql(run.dbName, 'select count(*) from app_deploy.seed_runs;')).toBe('1')
    expect(objects.size).toBe(objectCount)
    expect(users.size).toBe(3)

    await expect(
      provisionSeed({ ...config, minChangeNoticeHours: 48 }, storage, authAdmin, sql),
    ).rejects.toThrow('applied seed does not match this checkout')
    await expect(
      provisionSeed({ ...config, seedSourceSeed: 'changed-source' }, storage, authAdmin, sql),
    ).rejects.toThrow('applied seed does not match this checkout')
  }, 150_000)
})

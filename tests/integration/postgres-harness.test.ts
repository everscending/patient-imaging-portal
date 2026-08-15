import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  _backdateForTest,
  _databaseExistsForTest,
  ensureContainer,
  startRun,
  stopRun,
  sweepStaleDatabases,
} from '../setup/postgres'

const runsToClean: Awaited<ReturnType<typeof startRun>>[] = []
const CORE_MIGRATION_PATH = join(process.cwd(), 'db', 'migrations', '001_core.sql')

function psql(dbName: string, sql: string): string {
  // -q suppresses command completion tags ("SET", "INSERT 0 1") that -tA
  // alone does not — without it, a multi-statement call's tags land glued
  // onto the actual result and corrupt anything comparing it exactly.
  return execFileSync(
    'docker',
    ['exec', 'pip-testpg', 'psql', '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
}

afterAll(async () => {
  for (const run of runsToClean.splice(0)) {
    await stopRun(run).catch(() => {})
  }
})

describe('container — acceptance: pip-testpg on postgres:16-alpine, ephemeral port', () => {
  test('the running container is named pip-testpg and runs postgres:16-alpine', async () => {
    await ensureContainer()
    const image = execFileSync('docker', ['inspect', 'pip-testpg', '--format', '{{.Config.Image}}'], {
      encoding: 'utf8',
    }).trim()
    expect(image).toBe('postgres:16-alpine')
  })

  test('adversarial: TEST_PG_PORT unset — the resolved port is never 5432', async () => {
    expect(process.env.TEST_PG_PORT).toBeUndefined()
    const container = await ensureContainer()
    expect(container.port).not.toBe(5432)
    expect(container.port).toBeGreaterThan(0)
  })
})

describe('isolation — acceptance + adversarial: a database per run, never shared', () => {
  test(
    'adversarial: two runs at once never share a database',
    async () => {
      const container = await ensureContainer()
      const [a, b] = await Promise.all([startRun(container), startRun(container)])
      runsToClean.push(a, b)

      expect(a.dbName).not.toBe(b.dbName)
      expect(a.dbName).toMatch(/^pip_run_[0-9a-f]+$/)
      expect(b.dbName).toMatch(/^pip_run_[0-9a-f]+$/)
      expect(_databaseExistsForTest(a.dbName)).toBe(true)
      expect(_databaseExistsForTest(b.dbName)).toBe(true)
    },
    // Two full `startRun`s (each: CREATE DATABASE, registry insert, auth
    // stub, migrations) queue behind each other on this single Node
    // process's synchronous docker-exec calls — no real thread-level
    // parallelism to shrink this. Default 5000ms has no headroom left once a
    // nested scratch-clone gate run contends for the same Docker daemon.
    20_000,
  )

  test('overlapping runs can share a granted cluster role without invalidating each other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pip-granted-role-migrations-'))
    let first: Awaited<ReturnType<typeof startRun>> | undefined
    let second: Awaited<ReturnType<typeof startRun>> | undefined

    try {
      writeFileSync(join(dir, '001_core.sql'), readFileSync(CORE_MIGRATION_PATH, 'utf8'))
      writeFileSync(
        join(dir, '002_grant_app_user.sql'),
        'CREATE TABLE grant_probe (id integer PRIMARY KEY); GRANT SELECT, INSERT ON grant_probe TO app_user;',
      )

      const container = await ensureContainer()
      first = await startRun(container, dir)
      second = await startRun(container, dir)

      expect(psql(first.dbName, "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'app_user';")).toBe('f')
      expect(psql(first.dbName, 'SET ROLE app_user; INSERT INTO grant_probe VALUES (1); SELECT id FROM grant_probe;')).toBe(
        '1',
      )

      await stopRun(first)
      first = undefined

      expect(psql(second.dbName, 'SET ROLE app_user; INSERT INTO grant_probe VALUES (2); SELECT id FROM grant_probe;')).toBe(
        '2',
      )
    } finally {
      if (second) await stopRun(second).catch(() => {})
      if (first) await stopRun(first).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('migrations — acceptance: db/migrations/*.sql applied in filename order', () => {
  test('a later migration that depends on an earlier one succeeds only in filename order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pip-migrations-'))
    try {
      writeFileSync(join(dir, '001_create_parent.sql'), 'CREATE TABLE parent (id integer PRIMARY KEY);')
      writeFileSync(
        join(dir, '002_create_child.sql'),
        'CREATE TABLE child (id integer PRIMARY KEY, parent_id integer REFERENCES parent(id));',
      )

      const container = await ensureContainer()
      const run = await startRun(container, dir)
      runsToClean.push(run)

      const tables = execFileSync(
        'docker',
        [
          'exec',
          'pip-testpg',
          'psql',
          '-U',
          'postgres',
          '-d',
          run.dbName,
          '-tA',
          '-c',
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
        ],
        { encoding: 'utf8' },
      ).trim()

      expect(tables.split('\n')).toEqual(['child', 'parent'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sweep — acceptance + adversarial: a leaked pip_run_* database is dropped on startup', () => {
  test('a run older than a day is dropped by the startup sweep, a fresh one is not', async () => {
    const container = await ensureContainer()
    const stale = await startRun(container)
    const fresh = await startRun(container)
    runsToClean.push(fresh)

    _backdateForTest(stale.dbName, '2 days')

    const swept = await sweepStaleDatabases()

    expect(swept).toContain(stale.dbName)
    expect(_databaseExistsForTest(stale.dbName)).toBe(false)
    expect(_databaseExistsForTest(fresh.dbName)).toBe(true)
  })
})

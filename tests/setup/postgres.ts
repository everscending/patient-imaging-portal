// The test Postgres harness (ADR-0013). One container per machine,
// `pip-testpg`, published on an ephemeral host port that the OS assigns —
// nothing in this repository picks a port number. Isolation is a database
// per run, `pip_run_<random>`, so two lanes — or two runs in one worktree —
// never share state. The harness applies db/migrations/*.sql and never
// seeds; seeding is a later ticket's job.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CONTAINER_NAME = 'pip-testpg'
const IMAGE = 'postgres:16-alpine'
const PG_USER = 'postgres'
const PG_PASSWORD = 'postgres'
const MAINTENANCE_DB = 'postgres'
const REGISTRY_TABLE = '_pip_run_registry'
const STALE_AGE = '1 day'
const READY_TIMEOUT_MS = 30_000
const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations')

export type Run = {
  dbName: string
  port: number
  databaseUrl: string
}

export type Container = {
  port: number
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

function dockerExec(args: string[], input?: string): string {
  return execFileSync('docker', ['exec', ...(input !== undefined ? ['-i'] : []), CONTAINER_NAME, ...args], {
    encoding: 'utf8',
    input,
  })
}

// Runs SQL against `database` via `docker exec` + psql — no host psql client
// and no pg driver dependency; the container already has both.
function psql(database: string, sql: string): string {
  return dockerExec(['psql', '-U', PG_USER, '-d', database, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql])
}

function psqlFile(database: string, sqlContent: string): void {
  dockerExec(['psql', '-U', PG_USER, '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', '-'], sqlContent)
}

function containerState(): 'running' | 'stopped' | 'absent' {
  const filter = `name=^/${CONTAINER_NAME}$`
  const running = docker(['ps', '--filter', filter, '--format', '{{.Names}}'])
  if (running === CONTAINER_NAME) return 'running'
  const all = docker(['ps', '-a', '--filter', filter, '--format', '{{.Names}}'])
  if (all === CONTAINER_NAME) return 'stopped'
  return 'absent'
}

function resolvePort(): number {
  const mapping = docker(['port', CONTAINER_NAME, '5432/tcp'])
  // e.g. "0.0.0.0:34567\n[::]:34567" — take the first line's trailing port.
  const firstLine = mapping.split('\n')[0]
  const port = Number(firstLine.slice(firstLine.lastIndexOf(':') + 1))
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not resolve a published port for ${CONTAINER_NAME}: ${mapping}`)
  }
  return port
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// postgres:16-alpine's entrypoint starts the server once for initdb, stops
// it, then starts it again on a fresh container — a query can succeed
// against that throwaway first server and then fail seconds later when it
// shuts down for the real one. Waiting for the log line the entrypoint
// prints right before the final start (only present on that first boot; a
// reused, already-initialized container skips straight past this) plus two
// consecutive successful queries is what actually survives the restart.
async function waitReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const logs = docker(['logs', CONTAINER_NAME])
    if (logs.includes('PostgreSQL init process complete; ready for start up.') || logs.includes('database system is ready to accept connections')) {
      break
    }
    if (Date.now() > deadline) {
      throw new Error(`${CONTAINER_NAME} did not finish initializing within ${READY_TIMEOUT_MS}ms`)
    }
    await sleep(250)
  }

  let consecutiveSuccesses = 0
  for (;;) {
    try {
      dockerExec(['psql', '-U', PG_USER, '-d', MAINTENANCE_DB, '-tA', '-c', 'SELECT 1;'])
      consecutiveSuccesses += 1
      if (consecutiveSuccesses >= 2) return
    } catch {
      consecutiveSuccesses = 0
      if (Date.now() > deadline) {
        throw new Error(`${CONTAINER_NAME} did not become ready within ${READY_TIMEOUT_MS}ms`)
      }
    }
    await sleep(250)
  }
}

function ensureRegistryTable(): void {
  psql(
    MAINTENANCE_DB,
    `CREATE TABLE IF NOT EXISTS ${REGISTRY_TABLE} (dbname text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());`,
  )
}

// Starts (or reuses) the one-per-machine container and reports the port it
// used. TEST_PG_PORT is an optional pin for attaching a client during a
// debugging session (ADR-0013) — unset (the normal case) publishes on `0` so
// the OS assigns an ephemeral port, which is read back rather than guessed.
export async function ensureContainer(): Promise<Container> {
  const state = containerState()
  if (state === 'absent') {
    const pin = process.env.TEST_PG_PORT
    const hostPort = pin && pin.length > 0 ? pin : '0'
    docker([
      'run',
      '-d',
      '--name',
      CONTAINER_NAME,
      '-e',
      `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      '--publish',
      `${hostPort}:5432`,
      IMAGE,
    ])
  } else if (state === 'stopped') {
    docker(['start', CONTAINER_NAME])
  }
  await waitReady()
  ensureRegistryTable()
  return { port: resolvePort() }
}

function randomDbName(): string {
  return `pip_run_${randomBytes(6).toString('hex')}`
}

function migrationFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(dir, name))
}

function runMigrations(dbName: string, dir: string = MIGRATIONS_DIR): void {
  for (const file of migrationFiles(dir)) {
    psqlFile(dbName, readFileSync(file, 'utf8'))
  }
}

// Creates a fresh, migrated pip_run_<random> database and registers it so
// the startup sweep can find it if this run never calls stopRun. Two calls —
// concurrent or not — never collide: each generates its own random name.
export async function startRun(container: Container, migrationsDir?: string): Promise<Run> {
  const dbName = randomDbName()
  psql(MAINTENANCE_DB, `CREATE DATABASE "${dbName}";`)
  psql(MAINTENANCE_DB, `INSERT INTO ${REGISTRY_TABLE} (dbname) VALUES ('${dbName}');`)
  runMigrations(dbName, migrationsDir)
  return {
    dbName,
    port: container.port,
    databaseUrl: `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${container.port}/${dbName}`,
  }
}

export async function stopRun(run: Run): Promise<void> {
  psql(MAINTENANCE_DB, `DROP DATABASE IF EXISTS "${run.dbName}" WITH (FORCE);`)
  psql(MAINTENANCE_DB, `DELETE FROM ${REGISTRY_TABLE} WHERE dbname = '${run.dbName}';`)
}

// Drops pip_run_* databases whose registry row is older than a day — the
// backstop for a run that crashed before calling stopRun.
export async function sweepStaleDatabases(): Promise<string[]> {
  ensureRegistryTable()
  const stale = psql(
    MAINTENANCE_DB,
    `SELECT dbname FROM ${REGISTRY_TABLE} WHERE created_at < now() - interval '${STALE_AGE}';`,
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  for (const dbName of stale) {
    psql(MAINTENANCE_DB, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`)
    psql(MAINTENANCE_DB, `DELETE FROM ${REGISTRY_TABLE} WHERE dbname = '${dbName}';`)
  }
  return stale
}

// Test-only: backdates a run's registry row so sweepStaleDatabases() can be
// exercised without waiting a real day.
export function _backdateForTest(dbName: string, ageInterval: string): void {
  psql(MAINTENANCE_DB, `UPDATE ${REGISTRY_TABLE} SET created_at = now() - interval '${ageInterval}' WHERE dbname = '${dbName}';`)
}

export function _databaseExistsForTest(dbName: string): boolean {
  const result = psql(MAINTENANCE_DB, `SELECT 1 FROM pg_database WHERE datname = '${dbName}';`)
  return result.trim() === '1'
}

// Vitest globalSetup for the `integration` project: ensures the container,
// sweeps stale databases left by crashed runs, starts this run's database,
// migrates it, and makes its connection info available to tests via
// `inject('testDatabaseUrl')`. Teardown drops the database.
export default async function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  const container = await ensureContainer()
  const swept = await sweepStaleDatabases()
  if (swept.length > 0) {
    console.log(`[postgres-harness] swept ${swept.length} stale pip_run_* database(s)`)
  }
  const run = await startRun(container)
  console.log(`[postgres-harness] ${CONTAINER_NAME} on host port ${container.port}, database ${run.dbName}`)
  provide('testDatabaseUrl', run.databaseUrl)
  provide('testDatabaseName', run.dbName)

  return async () => {
    await stopRun(run)
  }
}

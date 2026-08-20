import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateAssetPool } from '../db/seed/assets'
import { runSeed, type AuthAdminClient, type SeedDbClient } from '../db/seed/index'
import {
  DEMO_ACCOUNT_PASSWORD,
  DEMO_PATIENT_EMAIL,
} from '../db/seed/rows'
import { uploadPool, type PhiStorageClient } from '../db/seed/storage'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations')
const DEPLOY_DIR = path.join(REPO_ROOT, 'db', 'deploy')
const STORAGE_SQL = path.join(REPO_ROOT, 'db', 'storage', 'bucket.sql')
const SEED_DIR = path.join(REPO_ROOT, 'db', 'seed')
const SEED_IDENTITY_FILES = ['assets.ts', 'rows.ts'] as const
// The live seed predates the identity-only checksum. Accept exactly that
// marker for exactly its unchanged row/asset identity, then replace it with
// the narrower checksum. Either side drifting keeps the provisioner closed.
const LEGACY_SEED_CHECKSUM_UPGRADES = new Map([
  [
    '0131eb052fffffec6b7c757d8b0df5269840856a431309a6cd132dcafa26794f',
    '39ee3a9e535584d7d8386ecdb4b6ec248151f43becf99558644cabc7cc75b837',
  ],
])
const MIGRATION_LOCK = 7_402_021
const READY_TIMEOUT_MS = 30_000

export type MigrationFile = { name: string; sql: string; checksum: string }

export type DeploymentConfig = {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRoleKey: string
  seedSourceSeed: string
  minChangeNoticeHours: number
}

type SeedMarker = { sourceSeed: string; checksum: string } | null

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function readMigrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const sql = readFileSync(path.join(dir, name), 'utf8')
      return { name, sql, checksum: sha256(sql) }
    })
}

export function buildMigrationProgram(files: MigrationFile[]): string {
  const statements = [
    '\\set ON_ERROR_STOP on',
    `select pg_advisory_lock(${MIGRATION_LOCK});`,
    'create schema if not exists app_deploy;',
    `create table if not exists app_deploy.schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );`,
    `create table if not exists app_deploy.seed_runs (
      singleton boolean primary key default true check (singleton),
      source_seed text not null,
      checksum text not null,
      seed_now timestamptz not null,
      applied_at timestamptz not null default now()
    );`,
  ]

  files.forEach((file, index) => {
    const prefix = `migration_${index}_`
    statements.push(
      `select count(*) = 0 as apply,
              coalesce(bool_and(checksum = ${sqlLiteral(file.checksum)}), true) as valid
         from app_deploy.schema_migrations
        where filename = ${sqlLiteral(file.name)}
        \\gset ${prefix}`,
      `\\if :${prefix}valid`,
      `\\else`,
      `\\echo '${file.name}: applied migration checksum changed'`,
      '\\quit 3',
      '\\endif',
      `\\if :${prefix}apply`,
      'begin;',
      file.sql,
      `insert into app_deploy.schema_migrations (filename, checksum)
       values (${sqlLiteral(file.name)}, ${sqlLiteral(file.checksum)});`,
      'commit;',
      '\\endif',
    )
  })

  statements.push(
    'begin;',
    readFileSync(path.join(DEPLOY_DIR, 'postgrest-grants.sql'), 'utf8'),
    readFileSync(STORAGE_SQL, 'utf8'),
    'commit;',
    `select pg_advisory_unlock(${MIGRATION_LOCK});`,
  )
  return `${statements.join('\n')}\n`
}

function runPsql(sql: string, tuplesOnly = false): string {
  try {
    return execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(tuplesOnly ? ['-tA'] : []), '-f', '-'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: sql,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error('provision-deployed-stack: database command failed')
  }
}

export function buildSeedChecksum(config: DeploymentConfig, seedDir = SEED_DIR): string {
  const hash = createHash('sha256')
  for (const name of SEED_IDENTITY_FILES) {
    hash.update(name).update('\0').update(readFileSync(path.join(seedDir, name))).update('\0')
  }
  hash.update('minChangeNoticeHours\0').update(String(config.minChangeNoticeHours))
  return hash.digest('hex')
}

function upgradeLegacySeedChecksum(sql: typeof runPsql, markerChecksum: string, checksum: string): boolean {
  if (LEGACY_SEED_CHECKSUM_UPGRADES.get(markerChecksum) !== checksum) return false
  sql(`do $$
begin
  update app_deploy.seed_runs
     set checksum = ${sqlLiteral(checksum)}
   where singleton and checksum = ${sqlLiteral(markerChecksum)};
  if not found and not exists (
    select 1 from app_deploy.seed_runs where singleton and checksum = ${sqlLiteral(checksum)}
  ) then
    raise exception 'seed marker changed while its checksum contract was upgraded';
  end if;
end $$;`)
  return true
}

function readSeedMarker(sql: typeof runPsql): SeedMarker {
  const raw = sql(
    `select json_build_object('sourceSeed', source_seed, 'checksum', checksum)::text
       from app_deploy.seed_runs where singleton;`,
    true,
  )
  return raw === '' ? null : (JSON.parse(raw) as SeedMarker)
}

function idempotentAuthAdmin(client: ReturnType<Awaited<typeof import('../lib/db/client')>['serviceClient']>): AuthAdminClient {
  return {
    auth: {
      admin: {
        async createUser(attrs) {
          const created = await client.auth.admin.createUser(attrs)
          if (!created.error) return { data: { user: created.data.user }, error: null }

          const existing = await client.auth.admin.getUserById(attrs.id)
          if (existing.data.user?.email?.toLowerCase() === attrs.email.toLowerCase()) {
            return { data: { user: { id: attrs.id } }, error: null }
          }
          return { data: { user: null }, error: { message: 'deterministic demo account could not be created' } }
        },
      },
    },
  }
}

export async function provisionSeed(
  config: DeploymentConfig,
  storage: PhiStorageClient,
  authAdmin: AuthAdminClient,
  sql: typeof runPsql = runPsql,
): Promise<void> {
  const checksum = buildSeedChecksum(config)
  const marker = readSeedMarker(sql)
  if (marker) {
    if (marker.sourceSeed !== config.seedSourceSeed) {
      throw new Error('provision-deployed-stack: applied seed does not match this checkout')
    }
    if (marker.checksum !== checksum && !upgradeLegacySeedChecksum(sql, marker.checksum, checksum)) {
      throw new Error('provision-deployed-stack: applied seed does not match this checkout')
    }
    await uploadPool(storage, generateAssetPool(config.seedSourceSeed))
    console.log('provision-deployed-stack: seed rows already applied; assets verified')
    return
  }

  const pendingSql: string[] = []
  const db: SeedDbClient = {
    async countRows(table) {
      if (table !== 'patients') throw new Error('provision-deployed-stack: unsupported seed count table')
      return Number(sql('select count(*) from patients;', true))
    },
    async execute(sql) {
      pendingSql.push(sql)
    },
  }
  const seedNow = new Date()
  await runSeed({
    storage,
    authAdmin,
    db,
    sourceSeed: config.seedSourceSeed,
    now: seedNow,
    minChangeNoticeHours: config.minChangeNoticeHours,
  })
  sql(`begin;
${pendingSql.join('\n')}
insert into app_deploy.seed_runs (source_seed, checksum, seed_now)
values (${sqlLiteral(config.seedSourceSeed)}, ${sqlLiteral(checksum)}, ${sqlLiteral(seedNow.toISOString())});
commit;`)
  console.log('provision-deployed-stack: seed rows and assets applied')
}

async function waitForPostgrest(config: DeploymentConfig): Promise<void> {
  runPsql("notify pgrst, 'reload schema';")
  const endpoint = `${config.supabaseUrl}/rest/v1/patients?select=id&limit=0`
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          apikey: config.supabaseServiceRoleKey,
          Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        },
      })
      if (response.ok) break
    } catch {
      // The bounded retry reports no provider error or response body.
    }
    if (Date.now() >= deadline) throw new Error('provision-deployed-stack: PostgREST schema did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const { authClient } = await import('../lib/db/client')
  const caller = authClient()
  const login = await caller.auth.signInWithPassword({ email: DEMO_PATIENT_EMAIL, password: DEMO_ACCOUNT_PASSWORD })
  if (login.error || !login.data.session?.access_token) {
    throw new Error('provision-deployed-stack: demo readiness login failed')
  }
  const authenticated = await fetch(endpoint, {
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${login.data.session.access_token}`,
    },
  })
  if (!authenticated.ok) throw new Error('provision-deployed-stack: authenticated PostgREST readiness failed')
  console.log('provision-deployed-stack: PostgREST ready')
}

export async function main(): Promise<void> {
  const [{ config }, { serviceClient }] = await Promise.all([import('../lib/config'), import('../lib/db/client')])
  const deploymentConfig: DeploymentConfig = config
  const service = serviceClient()

  runPsql(buildMigrationProgram(readMigrationFiles()))
  console.log('provision-deployed-stack: migrations, grants, and bucket applied')
  await provisionSeed(deploymentConfig, service as unknown as PhiStorageClient, idempotentAuthAdmin(service))
  await waitForPostgrest(deploymentConfig)
}

if (process.env.PROVISION_DEPLOYED_STACK === '1') {
  main().catch(() => {
    // Provider/database errors can echo request details. The preceding stage
    // lines identify the failed boundary without forwarding those details.
    console.error('provision-deployed-stack: failed')
    process.exitCode = 1
  })
}

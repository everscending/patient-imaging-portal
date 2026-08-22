import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateAssetPool } from '../db/seed/assets'
import { runSeed, type AuthAdminClient, type SeedDbClient } from '../db/seed/index'
import {
  buildRowSet,
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
// EL-1's derivatives (JOR-243) changed db/seed/assets.ts and db/seed/rows.ts,
// so they changed the seed identity. Named exactly, never recomputed: a
// target that meant "whatever this checkout hashes to" would wave through
// every future seed change as well.
export const EL1_DERIVATIVE_SEED_CHECKSUM = '3419c54b02d3d00d805b45ffe2414a2d78064bf894bce14f7e05e86f32517be3'

// Realistic procedural ultrasound pixels replaced the tiled-noise assets.
// Keys and rows are unchanged — only object bytes differ — so the upgrade is
// a marker advance; the uploadPool call after the chain re-uploads every
// object whose content hash changed.
// tests/deploy/provisioning.test.ts pins it to the current checkout.
export const ULTRASOUND_PIXELS_SEED_CHECKSUM = '650767c6e628ebe0ffd4f7cea5d6ee4d394208596921840d10b13f74c70f38a2'

// One entry per intentional seed change, each moving the marker a single
// step. A stack several changes behind walks the chain in one run; a stack
// whose marker is not on the chain still finds the provisioner closed.
const SEED_DATA_CHECKSUM_UPGRADES = new Map<string, SeedDataUpgrade>([
  [
    '39ee3a9e535584d7d8386ecdb4b6ec248151f43becf99558644cabc7cc75b837',
    {
      to: 'f6cf03ef229486e9cdfeeda0d82b08efb091bda2b619e0a5d34420e73ba31693',
      apply: upgradePerformanceClipToHundredFrames,
    },
  ],
  [
    'f6cf03ef229486e9cdfeeda0d82b08efb091bda2b619e0a5d34420e73ba31693',
    { to: EL1_DERIVATIVE_SEED_CHECKSUM, apply: upgradeDerivativeKeys },
  ],
  [
    EL1_DERIVATIVE_SEED_CHECKSUM,
    { to: ULTRASOUND_PIXELS_SEED_CHECKSUM, apply: advanceMarkerForPixelOnlyChange },
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

type SeedMarker = { sourceSeed: string; checksum: string; seedNow: string } | null

/** One step of the seed-identity chain: the marker it produces, and the data
 *  change that earns it. Both run inside the same guarded transaction. */
type SeedDataUpgrade = {
  to: string
  apply: (
    sql: typeof runPsql,
    marker: NonNullable<SeedMarker>,
    markerChecksum: string,
    checksum: string,
    config: DeploymentConfig,
  ) => void
}

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
      `\\warn '${file.name}: applied migration checksum changed'`,
      `do $$ begin raise exception 'migration checksum drift: %', ${sqlLiteral(file.name)}; end $$;`,
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

/** Every seeded image's thumbnail and every seeded clip's poster, EL-1's
 *  derivatives (JOR-243). Additive: the source rows keep the keys they have,
 *  and re-running finds the work already done rather than failing. */
function upgradeDerivativeKeys(
  sql: typeof runPsql,
  marker: NonNullable<SeedMarker>,
  markerChecksum: string,
  checksum: string,
  config: DeploymentConfig,
): void {
  const rowSet = buildRowSet({
    pool: generateAssetPool(config.seedSourceSeed),
    sourceSeed: config.seedSourceSeed,
    now: new Date(marker.seedNow),
    minChangeNoticeHours: config.minChangeNoticeHours,
  })
  const derivatives = [
    ...rowSet.images.map((image) => ['image', image.id, image.storage_key, image.thumb_key ?? ''] as const),
    ...rowSet.cineClips.map((clip) => ['clip', clip.id, '', clip.poster_key] as const),
  ]
  if (rowSet.images.some((image) => !image.thumb_key)) {
    throw new Error('provision-deployed-stack: seeded image without a thumbnail derivative')
  }

  sql(`do $$
begin
  perform 1 from app_deploy.seed_runs
   where singleton
     and source_seed = ${sqlLiteral(marker.sourceSeed)}
     and checksum = ${sqlLiteral(markerChecksum)}
   for update;
  if not found then
    raise exception 'seed marker changed while seed data was upgraded';
  end if;

  create temp table el1_derivative (kind text, id uuid primary key, storage_key text, derivative_key text) on commit drop;
  insert into el1_derivative (kind, id, storage_key, derivative_key) values
${derivatives.map(([kind, id, storageKey, key]) => `(${sqlLiteral(kind)}, ${sqlLiteral(id)}, ${sqlLiteral(storageKey)}, ${sqlLiteral(key)})`).join(',\n')};

  -- Only rows still at their previous seed identity are rewritten: an image
  -- whose still is the one this checkout generates and has no thumbnail yet,
  -- and a clip whose poster is still its own frame zero.
  update images i set thumb_key = d.derivative_key
    from el1_derivative d
   where d.kind = 'image' and i.id = d.id and i.storage_key = d.storage_key and i.thumb_key is null;
  update cine_clips c set poster_key = d.derivative_key
    from el1_derivative d
   where d.kind = 'clip' and c.id = d.id
     and c.poster_key = (select f.storage_key from cine_frames f where f.clip_id = c.id and f.frame_index = 0);

  if exists (
    select 1 from el1_derivative d join images i on i.id = d.id
     where d.kind = 'image' and i.thumb_key is distinct from d.derivative_key
  ) or exists (
    select 1 from el1_derivative d join cine_clips c on c.id = d.id
     where d.kind = 'clip' and c.poster_key is distinct from d.derivative_key
  ) then
    raise exception 'seeded imaging rows do not match this checkout''s derivative keys';
  end if;

  update app_deploy.seed_runs set checksum = ${sqlLiteral(checksum)}
   where singleton and checksum = ${sqlLiteral(markerChecksum)};
end $$;`)
}

function upgradePerformanceClipToHundredFrames(
  sql: typeof runPsql,
  marker: NonNullable<SeedMarker>,
  markerChecksum: string,
  checksum: string,
  config: DeploymentConfig,
): void {
  const rowSet = buildRowSet({
    pool: generateAssetPool(config.seedSourceSeed),
    sourceSeed: config.seedSourceSeed,
    now: new Date(marker.seedNow),
    minChangeNoticeHours: config.minChangeNoticeHours,
  })
  const clip = rowSet.cineClips.find(({ id }) => id === rowSet.fixtures.performanceCineClipId)
  const frames = rowSet.cineFrames
    .filter(({ clip_id }) => clip_id === clip?.id)
    .sort((a, b) => a.frame_index - b.frame_index)
  if (!clip || frames.length !== 100 || frames.some((frame, index) => frame.frame_index !== index)) {
    throw new Error('provision-deployed-stack: invalid healthy performance cine clip transition')
  }

  const previousFrames = frames
    .slice(0, 20)
    .map((frame) => `(${frame.frame_index}, ${sqlLiteral(frame.storage_key)})`)
    .join(',\n')
  const addedFrames = frames
    .slice(20)
    .map((frame) => `(${sqlLiteral(frame.clip_id)}, ${frame.frame_index}, ${sqlLiteral(frame.storage_key)})`)
    .join(',\n')

  sql(`do $$
begin
  perform 1 from app_deploy.seed_runs
   where singleton
     and source_seed = ${sqlLiteral(marker.sourceSeed)}
     and checksum = ${sqlLiteral(markerChecksum)}
   for update;
  if not found then
    raise exception 'seed marker changed while seed data was upgraded';
  end if;

  perform 1 from cine_clips
   where id = ${sqlLiteral(clip.id)}
     and study_id = ${sqlLiteral(clip.study_id)}
     and patient_id = ${sqlLiteral(clip.patient_id)}
     and frame_count = 20
     and default_fps = ${clip.default_fps}
   for update;
  if not found or exists (
    select 1
      from (values
${previousFrames}
      ) as expected(frame_index, storage_key)
      full join (
        select frame_index, storage_key from cine_frames where clip_id = ${sqlLiteral(clip.id)}
      ) as actual using (frame_index)
     where expected.storage_key is distinct from actual.storage_key
  ) then
    raise exception 'healthy performance cine clip does not match its previous seed identity';
  end if;

  update cine_clips set frame_count = 100 where id = ${sqlLiteral(clip.id)};
  insert into cine_frames (clip_id, frame_index, storage_key) values
${addedFrames};
  update app_deploy.seed_runs set checksum = ${sqlLiteral(checksum)}
   where singleton and checksum = ${sqlLiteral(markerChecksum)};
end $$;`)
}

/** For a seed change that touches asset bytes only (no keys, no rows): the
 *  database has nothing to migrate, so the marker just advances under the
 *  same guard every other upgrade uses. */
function advanceMarkerForPixelOnlyChange(
  sql: typeof runPsql,
  marker: NonNullable<SeedMarker>,
  markerChecksum: string,
  checksum: string,
): void {
  sql(`do $$
begin
  update app_deploy.seed_runs set checksum = ${sqlLiteral(checksum)}
   where singleton
     and source_seed = ${sqlLiteral(marker.sourceSeed)}
     and checksum = ${sqlLiteral(markerChecksum)};
  if not found then
    raise exception 'seed marker changed while seed data was upgraded';
  end if;
end $$;`)
}

function readSeedMarker(sql: typeof runPsql): SeedMarker {
  const raw = sql(
    `select json_build_object('sourceSeed', source_seed, 'checksum', checksum, 'seedNow', seed_now)::text
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
    let markerChecksum = marker.checksum
    const legacyChecksum = LEGACY_SEED_CHECKSUM_UPGRADES.get(markerChecksum)
    if (legacyChecksum && upgradeLegacySeedChecksum(sql, markerChecksum, legacyChecksum)) {
      markerChecksum = legacyChecksum
    }
    while (markerChecksum !== checksum) {
      const upgrade = SEED_DATA_CHECKSUM_UPGRADES.get(markerChecksum)
      if (!upgrade) throw new Error('provision-deployed-stack: applied seed does not match this checkout')
      upgrade.apply(sql, marker, markerChecksum, upgrade.to, config)
      markerChecksum = upgrade.to
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
  try {
    await main()
  } catch {
    // Provider/database errors can echo request details. The preceding stage
    // lines identify the failed boundary without forwarding those details.
    console.error('provision-deployed-stack: failed')
    process.exitCode = 1
  }
}

// playwright.config.ts's webServer command. In CI, real Supabase secrets are
// already in the environment (.github/workflows/ci.yml) and this just starts
// the app. Locally, where no Supabase project is configured, it starts the
// fake Auth double (fake-auth-server.ts) first and points the app at it —
// the same "don't depend on reachable cloud infra for tests" call ADR-0013
// already made for Postgres. A value already set in the real environment
// always wins (mirrors lib/config.ts's applyTestEnvFallback, JOR-270): this
// only fills in the exact .env.test placeholder, never a real URL.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ENV_TEST_PLACEHOLDER_URL = 'https://test-project.supabase.co'
const usesPlaceholder = process.env.NEXT_PUBLIC_SUPABASE_URL === undefined ||
  process.env.NEXT_PUBLIC_SUPABASE_URL === ENV_TEST_PLACEHOLDER_URL

const env = { ...process.env }

if (usesPlaceholder) {
  const { startFakeAuthServer } = await import('./fake-auth-server.ts')
  const fake = await startFakeAuthServer()

  const localDir = path.resolve(import.meta.dirname, '..', '..', '.local')
  await mkdir(localDir, { recursive: true })
  await writeFile(path.join(localDir, 'fake-auth.json'), JSON.stringify({ baseUrl: fake.url }, null, 2))

  env.NEXT_PUBLIC_SUPABASE_URL = fake.url
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  env.SOURCE_REF_SALT = 'test-source-ref-salt'

  console.log(`[e2e] fake Auth double listening at ${fake.url}`)
}

const child = spawn('node', [path.resolve(import.meta.dirname, '..', '..', 'scripts', 'run-next.mjs'), 'dev'], {
  stdio: 'inherit',
  env,
})

child.on('exit', (code) => process.exit(code ?? 0))

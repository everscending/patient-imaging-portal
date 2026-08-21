// e2e/fixtures/start-test-server.mjs — playwright.config.ts's webServer
// command. Starts the fake Supabase Auth server on an ephemeral port
// (ARCHITECTURE.md §9), then spawns the real Next app with
// NEXT_PUBLIC_SUPABASE_URL overridden to point at it, so e2e/auth.spec.ts
// exercises the real register/login routes with no live Supabase project —
// the same keyless-testing shape as lib/notify/email.ts's log transport
// (GAP-3).
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E5_CRON_SECRET, startFakeAuthServer } from './fake-auth-server.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

// The same four placeholder values lib/config.ts's own Playwright fallback
// uses (JOR-270) — read from .env.test rather than duplicated here, so
// there is exactly one place that spells out the test placeholders.
async function readEnvTest() {
  const raw = await readFile(path.join(REPO_ROOT, '.env.test'), 'utf8')
  const values = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue
    values[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim()
  }
  return values
}

const fakeAuthServer = await startFakeAuthServer()

// e2e/auth.spec.ts reads this back to reach the fake server's introspection
// endpoint directly — it runs in a separate process from this one.
const localDir = path.join(REPO_ROOT, '.local')
await mkdir(localDir, { recursive: true })
await writeFile(path.join(localDir, 'fake-auth-server.json'), JSON.stringify({ url: fakeAuthServer.url }))

const envTest = await readEnvTest()
const child = spawn('node', ['scripts/run-next.mjs', 'dev'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...envTest,
    CRON_SECRET: E5_CRON_SECRET,
    RESEND_API_KEY: '',
    NEXT_PUBLIC_SUPABASE_URL: fakeAuthServer.url,
  },
})

let exiting = false
async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill('SIGTERM')
  })
}

async function cleanupAndExit(code) {
  if (exiting) return
  exiting = true
  await stopChild()
  await fakeAuthServer.close()
  process.exit(code)
}

child.on('exit', (code) => {
  void cleanupAndExit(code ?? 0)
})
process.on('SIGINT', () => void cleanupAndExit(0))
process.on('SIGTERM', () => void cleanupAndExit(0))

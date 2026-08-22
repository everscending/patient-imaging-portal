// e2e/e0-wiring.spec.ts — JOR-217's live check (T7, E0's own confirmation).
// Every property this file checks is already mechanically enforced
// elsewhere — scripts/gate.sh itself, the eslint.config.mjs forbidden-import
// rows, tests/config, tests/ci, tests/deploy, tests/gate. This file adds no
// new rule. What it adds is the one thing none of those unit-level checks
// can: proof against the *real* CLI entrypoints — a real `git clone`, a real
// `npm ci`, a real `scripts/gate.sh` exit code, a real deployed URL — rather
// than an in-process mock of them. If every assertion below passed only
// because some step was mocked, stubbed, or skipped, E0 would not actually
// hold, no matter how green the unit suite is.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { env } from 'node:process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const DEPLOY_MD_PATH = path.join(REPO_ROOT, 'docs', 'deploy.md')
const DEPLOYED_URL = 'https://patient-imaging-portal.vercel.app'

// The same four placeholder values every other fixture in this repo reads
// from .env.test (JOR-270) — read once here rather than duplicated as a
// fifth copy of the same four strings.
function readEnvTest(): Record<string, string> {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.test'), 'utf8')
  const values: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue
    values[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim()
  }
  return values
}
const REQUIRED_ENV = readEnvTest()

// ADR-0013's own rule, applied to this file's own child processes too:
// never a bare or computed port, always one the OS handed out and this
// process read back.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not resolve a free port')))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function repoSlug(): string {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const match = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)
  if (!match) throw new Error(`could not parse a GitHub owner/repo from origin remote: ${url}`)
  return match[1]
}

function ghAvailable(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

type GateRun = { tier: string; status: number; stderr: string; stdout: string }

// Reads gate results from scripts/gate.sh's own exit code, never from a
// re-run of tsc/eslint/vitest/playwright — the ticket's own design decision.
function runGate(cwd: string, tier: string, extraEnv: Record<string, string> = {}): GateRun {
  const result = spawnSync(path.join(cwd, 'scripts', 'gate.sh'), [tier], {
    cwd,
    encoding: 'utf8',
    env: { ...env, ...REQUIRED_ENV, ...extraEnv },
    maxBuffer: 1024 * 1024 * 64,
  })
  return { tier, status: result.status ?? 1, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

// Imports the real lib/config.ts, in a fresh child process, under a chosen
// environment — proves the actual module's default-resolution and
// fail-loudly behavior, not a re-implementation of it.
function importConfig(overrides: Record<string, string | undefined>): { ok: boolean; stdout: string; stderr: string } {
  const merged: NodeJS.ProcessEnv = { ...env, ...REQUIRED_ENV }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  const configUrl = pathToFileURL(path.join(REPO_ROOT, 'lib', 'config.ts')).href
  const script = `import(${JSON.stringify(configUrl)}).then((m) => { process.stdout.write(String(m.config.port)) }, (err) => { process.stderr.write(String((err && err.message) || err)); process.exit(1) })`
  const result = spawnSync('node', ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', env: merged, timeout: 15_000 })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// Collected as the suite runs and appended to docs/deploy.md once, at the
// end of the file — the run record this ticket owns.
const runRecord: {
  uiTier: number | 'skipped'
  scratchPort: number | null
  deployedStatus: number | 'unchecked'
  deployedCommitMatchesMain: boolean | 'unchecked'
} = {
  uiTier: 'skipped',
  scratchPort: null,
  deployedStatus: 'unchecked',
  deployedCommitMatchesMain: 'unchecked',
}

test.describe('Running skeleton — acceptance: the app answers on config.port', () => {
  test('acceptance: the landing page renders on the live skeleton', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your imaging care, all in one place')
  })
})

test.describe('Deployed skeleton — acceptance + mandatory adversarial: live, current, over HTTPS', () => {
  test('acceptance: the deployed URL answers 200 over HTTPS and renders the landing page', async ({ page }) => {
    const response = await page.goto(DEPLOYED_URL)
    runRecord.deployedStatus = response?.status() ?? 0
    expect(response?.status()).toBe(200)
    expect(new URL(page.url()).protocol).toBe('https:')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your imaging care, all in one place')
  })

  test('acceptance + mandatory adversarial: deployedUrl_neverServesAStaleCommitAfterAPushToMain', async function deployedUrl_neverServesAStaleCommitAfterAPushToMain() {
    test.skip(!ghAvailable(), 'gh CLI is not authenticated in this environment')
    const mainSha = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const raw = execFileSync(
      'gh',
      ['api', `repos/${repoSlug()}/deployments?environment=Production&per_page=1`],
      { encoding: 'utf8' },
    )
    const deployments = JSON.parse(raw) as Array<{ sha: string }>
    expect(deployments.length).toBeGreaterThan(0)
    runRecord.deployedCommitMatchesMain = deployments[0].sha === mainSha
    // A stale deployment — one whose sha lags the pushed commit — is exactly
    // what this equality catches: it can only hold if the last push to main
    // actually redeployed.
    expect(deployments[0].sha).toBe(mainSha)
  })
})

test.describe('Clean checkout — acceptance: install, then the cumulative UI gate passes once in a scratch clone', () => {
  test.describe.configure({ mode: 'default' })

  let scratchDir: string
  let uiRun: GateRun
  let uiPort: number

  test.beforeAll(async () => {
    test.setTimeout(15 * 60_000)
    scratchDir = mkdtempSync(path.join(tmpdir(), 'e0-wiring-scratch-'))
    // A local clone of this checkout's own git history — never the working
    // tree, so an uncommitted node_modules or .env would prove nothing
    // (design decision, JOR-217).
    execFileSync('git', ['clone', '--local', '--quiet', REPO_ROOT, scratchDir])
    execFileSync('npm', ['ci'], { cwd: scratchDir, stdio: 'pipe' })
    // Mirrors .github/workflows/ci.yml's own install step — the only
    // committed source of "how a checkout gets to a green gate" this repo
    // carries (there is no top-level README).
    execFileSync('npx', ['playwright', 'install', '--with-deps', 'chromium'], { cwd: scratchDir, stdio: 'pipe' })

    // The UI tier boots a second real Next server, which cannot share this
    // certification run's already-listening config.port. The product
    // Playwright project excludes E0/E1 wiring, so this invocation cannot
    // recursively launch certification again.
    uiPort = await freePort()
    uiRun = runGate(scratchDir, 'ui', { PORT: String(uiPort) })
    runRecord.scratchPort = uiPort
    runRecord.uiTier = uiRun.status
  })

  test.afterAll(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true })
  })

  test('mandatory adversarial: cleanCheckout_needsNoManualStepBeyondCloneNpmCiAndGateSh', async function cleanCheckout_needsNoManualStepBeyondCloneNpmCiAndGateSh() {
    // The scratch clone above never ran anything beyond `git clone`, `npm
    // ci`, and `npx playwright install`. If the checkout needed a manual
    // step this install path omits — copying a file by hand, seeding
    // something, running a setup script — the cumulative UI tier below
    // would be the failure, not a separate claim made here.
    expect(existsSync(path.join(scratchDir, 'node_modules', '.bin', 'next'))).toBe(true)
    expect(uiRun.status, uiRun.stderr).toBe(0)
  })

  test('acceptance: scripts/gate.sh ui exits 0 once in the scratch clone, the app on its own free port', () => {
    expect(uiRun.status, uiRun.stderr).toBe(0)
  })

  test('mandatory adversarial: everyGateStepActuallyRan', async function everyGateStepActuallyRan() {
    // gate.sh's own step() function echoes "[gate:<tier>] <NAME>: <cmd>" to
    // stderr immediately before running each command (never after) — a step
    // that was skipped, short-circuited, or replaced by GATE_FAKE_EXIT
    // leaves no such line. A tier that "passed" without this line for every
    // command it owns passed because a command was never run, not because
    // the codebase is clean.
    for (const name of ['TSC', 'ESLINT', 'VITEST_UNIT']) {
      expect(uiRun.stderr, uiRun.stderr).toMatch(new RegExp(`\\[gate:ui\\] ${name}:`))
    }
    for (const name of ['VITEST_INTEGRATION', 'PLAYWRIGHT', 'PLAYWRIGHT_REPORT']) {
      expect(uiRun.stderr, uiRun.stderr).toMatch(new RegExp(`\\[gate:ui\\] ${name}:`))
    }
    expect(uiRun.stderr).not.toContain('GATE_FAKE_EXIT')
  })
})

test.describe('Ports — acceptance + mandatory adversarial: the pinned §9 ports, never a well-known one', () => {
  test('acceptance: no bare 3000 or 5432 in any tracked script, config, fixture, or workflow', () => {
    const candidates = execFileSync(
      'git',
      ['ls-files', '--', '.github/workflows', '.loom.yml', 'scripts', 'e2e/fixtures', 'vercel.json', 'playwright.config.ts', 'vitest.config.ts', 'next.config.ts', 'package.json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const file of candidates) {
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      for (const port of ['3000', '5432']) {
        expect(content, `${file} must not contain a bare ${port}`).not.toMatch(new RegExp(`\\b${port}\\b`))
      }
    }
  })

  test('mandatory adversarial: portUnset_neverResolvesTo3000', async function portUnset_neverResolvesTo3000() {
    const resolved = importConfig({ PORT: undefined })
    expect(resolved.ok, resolved.stderr).toBe(true)
    expect(resolved.stdout).toBe('4310')
    expect(resolved.stdout).not.toBe('3000')
  })
})

test.describe('Environment contract — acceptance + mandatory adversarial: §8, all 25 rows, fails loudly', () => {
  test('acceptance: .env.example lists all 25 §8 rows with placeholder values only', () => {
    const content = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8')
    const keys = content
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('=')[0])
    expect(keys).toHaveLength(25)
    expect(keys).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  test('mandatory adversarial: missingServiceRoleKey_failsLoudlyNamingTheVariable', async function missingServiceRoleKey_failsLoudlyNamingTheVariable() {
    const booted = importConfig({ SUPABASE_SERVICE_ROLE_KEY: undefined })
    expect(booted.ok).toBe(false)
    expect(booted.stderr).toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })
})

test.describe('CI — acceptance: lint, unit, and end-to-end run on every push', () => {
  test('acceptance: the latest completed run on origin/main is green and its log shows scripts/gate.sh ui', () => {
    test.skip(!ghAvailable(), 'gh CLI is not authenticated in this environment')
    const mainSha = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const raw = execFileSync(
      'gh',
      ['run', 'list', '--branch', 'main', '--workflow', 'CI', '--json', 'databaseId,headSha,status,conclusion', '--limit', '10'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    const runs = JSON.parse(raw) as Array<{ databaseId: number; headSha: string; status: string; conclusion: string }>
    const run = runs.find((r) => r.headSha === mainSha)
    expect(run, `no CI run found for origin/main's HEAD (${mainSha})`).toBeDefined()
    expect(run!.status).toBe('completed')
    expect(run!.conclusion).toBe('success')
    const log = execFileSync('gh', ['run', 'view', String(run!.databaseId), '--log'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
    })
    expect(log).toMatch(/scripts\/gate\.sh ui/)
  })
})

// Appended once, after every check above has had a chance to record its own
// result — the E0 run record docs/deploy.md's Run record section describes,
// and the record the `logic` gate's own doc-content checks (tests/deploy/
// deploy-doc.test.ts) read.
test.afterAll(() => {
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const timestamp = new Date().toISOString()
  const deployedLine =
    runRecord.deployedCommitMatchesMain === 'unchecked'
      ? `${DEPLOYED_URL} — HTTP ${runRecord.deployedStatus} (commit match unchecked, gh unavailable)`
      : `${DEPLOYED_URL} — HTTP ${runRecord.deployedStatus}, matches origin/main HEAD: ${runRecord.deployedCommitMatchesMain}`

  const entry = `
## E0 wiring confirmation (JOR-217)

Appended by \`e2e/e0-wiring.spec.ts\`, the wiring ticket's own live check —
never edited after the fact, one entry per run.

| Timestamp (UTC) | Commit | Gate tiers (exit code) | Scratch clone's ui-tier port | Deployed URL check |
| --- | --- | --- | --- | --- |
| ${timestamp} | \`${commitSha}\` | ui: ${runRecord.uiTier} (cumulative: logic + api + product Playwright + E2 report validation) | ${runRecord.scratchPort ?? 'n/a'} | ${deployedLine} |

Running skeleton checked on \`config.port\` (\`PORT=4310\` in this environment,
ADR-0013 default); the scratch clone's own nested \`ui\` tier ran its Next
server on the ephemeral port above, never 4310, to avoid claiming the port
this very test run was already using (§9). The test Postgres harness
(\`pip-testpg\`) published its own ephemeral host port, read back by
\`tests/setup/postgres.ts\`, for every gate tier above that touched it.
`
  appendFileSync(DEPLOY_MD_PATH, entry)
})

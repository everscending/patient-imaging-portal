// e2e/e1-wiring.spec.ts — JOR-259's live check (T14, E1's own confirmation).
// From a clean checkout — a real `git clone`, a real `npm ci`, nothing else
// — migrate (001-003) and seed (db/seed/index.ts) produce the delivery
// dataset (design decision: "a dataset verified against a database that
// already held rows proves nothing about migrate-then-seed"). The exact
// milestone assertions this proves are tests/db/epic-e1.test.ts's own —
// this file runs that same committed file inside the scratch clone (never
// re-implementing its migrate-then-seed driver, which would itself be a
// second, divergent path to the same claim) and proves it needs no
// undocumented manual step beyond clone + npm ci. What only this file adds:
// the app answering on `config.port`.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

type Run = { status: number; stdout: string; stderr: string }

// Runs the ONE committed migrate-then-seed proof (tests/db/epic-e1.test.ts,
// via the same `vitest --project unit` invocation `scripts/gate.sh` itself
// uses) inside the scratch clone — no second script, no fixture copied by
// hand. That file's own beforeAll applies db/migrations/001-003.sql in
// filename order (tests/setup/postgres.ts's startRun) and then calls
// db/seed/index.ts's runSeed for real; its own AC-1 test asserts the exact
// row counts and demo accounts this ticket's acceptance criterion states.
function runMigrateAndSeedProof(scratchDir: string): Run {
  const result = spawnSync('npx', ['vitest', 'run', '--project', 'unit', 'tests/db/epic-e1.test.ts'], {
    cwd: scratchDir,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test.describe('Running skeleton — acceptance: the app answers on config.port', () => {
  test('acceptance: the landing page renders on the live skeleton', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your imaging care, all in one place')
  })
})

test.describe('Clean checkout — acceptance: install, migrate 001-003, and seed produce the delivery dataset with no manual step', () => {
  test.describe.configure({ mode: 'default' })

  let scratchDir: string
  let proof: Run

  test.beforeAll(async () => {
    test.setTimeout(10 * 60_000)
    scratchDir = mkdtempSync(path.join(tmpdir(), 'e1-wiring-scratch-'))
    // A local clone of this checkout's own git history — never the working
    // tree, so an uncommitted node_modules or .env would prove nothing
    // (same design decision as e2e/e0-wiring.spec.ts).
    execFileSync('git', ['clone', '--local', '--quiet', REPO_ROOT, scratchDir])
    execFileSync('npm', ['ci'], { cwd: scratchDir, stdio: 'pipe' })

    proof = runMigrateAndSeedProof(scratchDir)
  })

  test.afterAll(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true })
  })

  test('mandatory adversarial: cleanCheckoutMigrateAndSeedNeedNoManualStepBeyondCloneAndNpmCi', async function cleanCheckoutMigrateAndSeedNeedNoManualStepBeyondCloneAndNpmCi() {
    // The scratch clone above ran nothing beyond `git clone`, `npm ci`, and
    // the one committed migrate-then-seed proof — no fixture copied by
    // hand, no second command run first. If the checkout needed an
    // undocumented manual step, this would be the failure.
    expect(proof.status, proof.stdout + proof.stderr).toBe(0)
  })

  test('acceptance: migrate 001-003 then db/seed/index.ts produces ~50 patients, ~10 providers, and the three demo accounts', () => {
    // tests/db/epic-e1.test.ts:AC1's own test asserts the exact row counts
    // and the three demo accounts — this checks that it actually ran and
    // passed in the scratch clone, rather than re-deriving the same numbers
    // a second, divergent way.
    expect(proof.stdout, proof.stdout + proof.stderr).toMatch(/deliveryDatasetRowCountsAndDemoAccountsMatchSpec/)
    expect(proof.status, proof.stdout + proof.stderr).toBe(0)
  })
})

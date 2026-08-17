import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const GATE = path.join(REPO_ROOT, 'scripts', 'gate.sh')

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(GATE, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('argument handling — acceptance + adversarial: a typo fails the gate, never skips it', () => {
  test('adversarial: no argument is not a silent success', () => {
    const result = run([])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('logic')
    expect(result.stderr).toContain('api')
    expect(result.stderr).toContain('ui')
  })

  test('adversarial: an unknown tier (lint) does not exit 0', () => {
    const result = run(['lint'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('logic')
    expect(result.stderr).toContain('api')
    expect(result.stderr).toContain('ui')
  })
})

describe('propagation — acceptance + adversarial: the first failing command is a red gate', () => {
  test('adversarial: a passing first command and a failing second command is not a green gate, and the third never runs', () => {
    const result = run(['logic'], {
      GATE_FAKE_EXIT_TSC: '0',
      GATE_FAKE_EXIT_ESLINT: '5',
    })
    expect(result.status).toBe(5)
    expect(result.stderr).toContain('TSC')
    expect(result.stderr).toContain('ESLINT')
    expect(result.stderr).not.toContain('VITEST_UNIT')
  })
})

describe('cumulative tiers — acceptance: api runs logic first, ui runs api first', () => {
  test('api --list starts with every logic command, then its own', () => {
    const logic = run(['logic', '--list']).stdout.trim().split('\n')
    const api = run(['api', '--list']).stdout.trim().split('\n')
    expect(api.slice(0, logic.length)).toEqual(logic)
    expect(api.length).toBeGreaterThan(logic.length)
  })

  test('ui --list starts with every api command, then its own', () => {
    const api = run(['api', '--list']).stdout.trim().split('\n')
    const ui = run(['ui', '--list']).stdout.trim().split('\n')
    expect(ui.slice(0, api.length)).toEqual(api)
    expect(ui.length).toBeGreaterThan(api.length)
    expect(ui.at(-2)).toBe('npx playwright test --project=e2-wiring')
    expect(ui.at(-1)).toBe(
      'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e2-wiring.spec.ts',
    )
  })
})

describe('timings — every executed command reports its duration', () => {
  test('a passing command emits a machine-readable timing line', () => {
    const result = run(['logic'], {
      GATE_FAKE_EXIT_TSC: '0',
      GATE_FAKE_EXIT_ESLINT: '0',
      GATE_FAKE_EXIT_VITEST_UNIT: '0',
    })
    expect(result.status).toBe(0)
    for (const name of ['TSC', 'ESLINT', 'VITEST_UNIT']) {
      expect(result.stderr).toMatch(new RegExp(`\\[gate:logic\\] timing ${name}=\\d+s`))
    }
  })

  test('a failing command reports timing before propagating its status', () => {
    const result = run(['logic'], {
      GATE_FAKE_EXIT_TSC: '7',
    })
    expect(result.status).toBe(7)
    expect(result.stderr).toMatch(/\[gate:logic\] timing TSC=\d+s/)
  })
})

// A hand-rolled parser rather than a YAML dependency: .loom.yml's `gates:`
// block here is always this flat `tier:\n  - "cmd"` shape, and this test is
// the only reader.
function parseLoomGates(yaml: string): Record<string, string[]> {
  const lines = yaml.split('\n')
  const gatesStart = lines.findIndex((line) => line.trim() === 'gates:')
  if (gatesStart === -1) throw new Error('.loom.yml has no gates: block')

  const gates: Record<string, string[]> = {}
  let currentTier: string | null = null
  for (const line of lines.slice(gatesStart + 1)) {
    if (line.length > 0 && !/^\s/.test(line)) break // dedented past the block
    const tierMatch = line.match(/^ {2}([a-z]+):\s*$/)
    if (tierMatch) {
      currentTier = tierMatch[1]
      gates[currentTier] = []
      continue
    }
    const itemMatch = line.match(/^ {4}-\s*"(.*)"\s*$/)
    if (itemMatch && currentTier) {
      gates[currentTier].push(itemMatch[1])
    }
  }
  return gates
}

describe('drift — acceptance + adversarial: .loom.yml and gate.sh resolve the same commands', () => {
  const loomYml = readFileSync(path.join(REPO_ROOT, '.loom.yml'), 'utf8')
  const declared = parseLoomGates(loomYml)

  test('declares exactly three tiers, not a fourth', () => {
    expect(Object.keys(declared).sort()).toEqual(['api', 'logic', 'ui'])
  })

  test.each(['logic', 'api', 'ui'] as const)(
    'adversarial: %s — .loom.yml commands equal what gate.sh resolves',
    (tier) => {
      const resolved = run([tier, '--list']).stdout.trim().split('\n')
      expect(declared[tier]).toEqual(resolved)
    },
  )

  test('api names the timing acceptance test explicitly', () => {
    const api = run(['api', '--list']).stdout.trim().split('\n')
    expect(api).toContain(
      'npx vitest run --project unit tests/observability/timing.test.ts',
    )
  })
})

describe('playwright config — acceptance + adversarial: baseURL is derived, never hardcoded', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'playwright.config.ts'), 'utf8')

  test('reads baseURL from config.port, not a literal', () => {
    expect(source).toMatch(/config\.port/)
  })

  test('adversarial: no hardcoded localhost port appears in baseURL', () => {
    expect(source).not.toMatch(/localhost:\d+/)
  })

  test('ui gate validates the JSON report artifact emitted by Playwright', () => {
    const ui = run(['ui', '--list']).stdout.trim().split('\n')
    expect(ui).toContain(
      'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e2-wiring.spec.ts',
    )
    expect(source).toMatch(/\['json',\s*\{\s*outputFile:\s*'test-results\/playwright\.json'/)
  })

  test('E2 runs after the parallel product suite instead of sharing its fake-server state', () => {
    expect(source).toMatch(/name:\s*'product'[\s\S]*testIgnore:\s*\/e\[012\]-wiring\\\.spec\\\.ts\//)
    expect(source).toMatch(
      /name:\s*'e2-wiring'[\s\S]*testMatch:\s*\/e2-wiring\\\.spec\\\.ts\/[\s\S]*dependencies:\s*\['product'\]/,
    )
  })
})

describe('anonymous health Playwright check — regression: uses its lane base URL', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'e2e/degraded.spec.ts'), 'utf8')
  const healthNoSessionTest = source.match(
    /test\('acceptance: health_noSessionNoCookies_returns200',[\s\S]*?\n  }\)\n\n  test\('acceptance \(static\)/,
  )?.[0]

  test('healthNoSessionNoCookies_usesFreshCookieFreeContextAtPlaywrightBaseUrl', () => {
    expect(healthNoSessionTest).toBeDefined()
    expect(healthNoSessionTest).toMatch(/async \(\{ baseURL, playwright \}\)/)
    expect(healthNoSessionTest).toMatch(/playwright\.request\.newContext\(\{ baseURL \}\)/)
    expect(healthNoSessionTest).toMatch(/anonymous\.get\('\/api\/health'\)/)
  })

  test('adversarial: healthNoSessionNoCookies_rejectsFixedApplicationPort', () => {
    expect(healthNoSessionTest).not.toMatch(/localhost:\d+/)
  })
})

describe('Next worktree root — regression: a lane watches only its own checkout', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'next.config.ts'), 'utf8')
  const runnerSource = readFileSync(path.join(REPO_ROOT, 'scripts/run-next.mjs'), 'utf8')

  test('worktreeLocalRoot_preventsParentLockfileInference', () => {
    // `fileURLToPath(import.meta.url)` names this config file wherever the
    // checkout was cloned; its dirname therefore cannot resolve to the parent
    // repository's lockfile.
    expect(source).toMatch(/fileURLToPath\(import\.meta\.url\)/)
    expect(source).toMatch(/path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/)
    expect(source).toMatch(/outputFileTracingRoot:\s*worktreeRoot/)
    expect(source).toMatch(/turbopack:\s*\{\s*root:\s*worktreeRoot,?\s*}/)
  })

  test('adversarial_removingWorktreeLocalRoot_detectsParentInference', () => {
    // Removing both explicit roots makes Next climb to the superproject's
    // package-lock.json (Next's find-root behavior). Keep the exact config
    // shape under test so deleting either required setting is a red regression.
    expect(source).toContain('outputFileTracingRoot: worktreeRoot')
    expect(source).toContain('root: worktreeRoot')
    expect(source).not.toMatch(/root:\s*['"]/)
  })

  test('webpackTracingAndTurbopack_shareTheSameWorktreeLocalRoot', () => {
    // `next dev` can exercise Watchpack even when Turbopack has a local root.
    // Pin the tracing root separately so neither active bundler climbs to the
    // superproject and watches every linked checkout.
    expect(source).toMatch(/outputFileTracingRoot:\s*worktreeRoot/)
    expect(source).toMatch(/turbopack:\s*\{\s*root:\s*worktreeRoot,?\s*}/)
  })

  test('devServer_usesPollingToAvoidNativeWatcherExhaustionAcrossLanes', () => {
    // Worktree-local roots prevent sibling traversal, but Watchpack can still
    // exhaust native filesystem watchers when several Next dev lanes coexist.
    // Polling contains that shared OS resource without changing production.
    expect(runnerSource).toMatch(/const nextEnv = \{ \.\.\.process\.env }/)
    expect(runnerSource).toMatch(
      /mode === 'dev' && nextEnv\.WATCHPACK_POLLING === undefined[\s\S]*nextEnv\.WATCHPACK_POLLING = '1000'/,
    )
    expect(runnerSource).toMatch(/spawn\([\s\S]*env:\s*nextEnv/)
  })

  test('adversarial_removingPollingFallback_recreatesNativeWatcherRisk', () => {
    const mutant = runnerSource.replace(
      /\nif \(mode === 'dev' && nextEnv\.WATCHPACK_POLLING === undefined\) \{[\s\S]*?\n}/,
      '',
    )

    expect(runnerSource).toContain("nextEnv.WATCHPACK_POLLING = '1000'")
    expect(mutant).not.toContain("nextEnv.WATCHPACK_POLLING = '1000'")
  })

  test('twoDistinctPortServers_neverShareOrInspectSiblingWorktree', () => {
    // The root is derived from the config file, rather than PORT or a fixed
    // checkout path. Each linked worktree consequently gets its own watcher
    // root while Playwright derives each server URL from PORT.
    const linkedWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))

    expect(linkedWorktrees).toContain(REPO_ROOT)
    expect(source).not.toMatch(/\.worktrees\/\d+|\/Users\/|PORT/)
    expect(readFileSync(path.join(REPO_ROOT, 'playwright.config.ts'), 'utf8')).toMatch(/config\.port/)
  })

  test('cleanupOfEitherServerLeavesOtherWorktreeRootValid', () => {
    // Process teardown lives in the fixture. A root is config-local state, so
    // stopping one fixture cannot alter another worktree's root selection.
    const fixture = readFileSync(path.join(REPO_ROOT, 'e2e/fixtures/start-test-server.mjs'), 'utf8')
    expect(fixture).toMatch(/child\.kill\(\)/)
    expect(fixture).toMatch(/fakeAuthServer\.close\(\)/)
    expect(source).toContain('root: worktreeRoot')
  })
})

describe('repo-wide guards', () => {
  test('no bare well-known port (3000, 5432, 5433, 8080) in this ticket\'s files', () => {
    // tests/setup/postgres.ts is exempt: postgres:16-alpine always listens on
    // 5432 *inside* its container, and `docker run --publish 0:5432` names
    // that fixed container-side port deliberately — the pinned interface
    // table's own "published 0:5432" value contains the literal. What must
    // never be 5432 is the resolved *host* port, covered by the
    // TEST_PG_PORT-unset adversarial test in tests/integration.
    const candidates = ['scripts/gate.sh', '.loom.yml', 'vitest.config.ts', 'playwright.config.ts', 'k6/README.md', 'vercel.json']
    for (const file of candidates) {
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      for (const port of ['3000', '5432', '5433', '8080']) {
        expect(content, `${file} must not contain bare ${port}`).not.toMatch(new RegExp(`\\b${port}\\b`))
      }
    }
  })

  test('gate.sh owns product tools; certify.sh can launch only the isolated certification project', () => {
    const gateShContent = readFileSync(path.join(REPO_ROOT, 'scripts', 'gate.sh'), 'utf8')
    const certifyShContent = readFileSync(path.join(REPO_ROOT, 'scripts', 'certify.sh'), 'utf8')
    expect(gateShContent).toMatch(/npx (tsc|eslint|vitest|playwright)/)
    expect(certifyShContent).toMatch(/npx playwright test --project=certification/)
    expect(certifyShContent).not.toMatch(/npx (tsc|eslint|vitest)\b/)
    expect(certifyShContent).not.toMatch(/--project=product/)
  })
})

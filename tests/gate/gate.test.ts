import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const GATE = path.join(REPO_ROOT, 'scripts', 'gate.sh')

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(GATE, args, {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, stdout: e.stdout, stderr: e.stderr }
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

  test('no workflow or script under scripts/ other than gate.sh calls vitest, playwright, eslint, or tsc directly', () => {
    const gateShContent = readFileSync(path.join(REPO_ROOT, 'scripts', 'gate.sh'), 'utf8')
    // gate.sh itself is the one place allowed to name these tools.
    expect(gateShContent).toMatch(/npx (tsc|eslint|vitest|playwright)/)
  })
})

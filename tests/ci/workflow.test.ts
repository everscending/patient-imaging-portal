import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const CI_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const CERTIFICATION_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'certification.yml')
const GATE_PATH = path.join(REPO_ROOT, 'scripts', 'gate.sh')
const CERTIFY_PATH = path.join(REPO_ROOT, 'scripts', 'certify.sh')
const PLAYWRIGHT_CONFIG_PATH = path.join(REPO_ROOT, 'playwright.config.ts')

const ci = readFileSync(CI_PATH, 'utf8')
const certification = readFileSync(CERTIFICATION_PATH, 'utf8')
const certify = readFileSync(CERTIFY_PATH, 'utf8')
const playwrightConfig = readFileSync(PLAYWRIGHT_CONFIG_PATH, 'utf8')

function executableInvocations(source: string, pattern: RegExp): string[] {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => pattern.test(line))
}

const gateInvocations = executableInvocations(ci, /scripts\/gate\.sh/)

describe('per-change triggers and concurrency', () => {
  const triggerBlock = ci.match(/^on:\n([\s\S]*?)^concurrency:/m)?.[1] ?? ''

  test('every push and pull request triggers the product workflow', () => {
    expect(triggerBlock).toMatch(/^\s*push:\s*$/m)
    expect(triggerBlock).not.toMatch(/push:\s*\n\s+branches:/)
    expect(triggerBlock).toMatch(/^\s*pull_request:\s*$/m)
  })

  test('push and PR events for the same source branch share one cancelling group', () => {
    expect(ci).toContain('group: ${{ github.workflow }}-${{ github.head_ref || github.ref_name }}')
    expect(ci).toMatch(/cancel-in-progress:\s*true/)
  })

  test('the gate is not conditional on event type, so either surviving event remains a valid check', () => {
    const gateStep = ci.slice(ci.indexOf('- name: Product UI gate'))
    expect(gateStep).not.toMatch(/^\s*if:/m)
  })
})

describe('per-change coverage stays cumulative', () => {
  const resolvedUiGate = execFileSync(GATE_PATH, ['ui', '--list'], { encoding: 'utf8' })
    .trim()
    .split('\n')

  test('CI invokes the cumulative UI gate exactly once', () => {
    expect(gateInvocations).toHaveLength(1)
    expect(gateInvocations[0]).toMatch(/scripts\/gate\.sh ui\s*$/)
  })

  test('the UI gate preserves TypeScript, ESLint, unit, PostgreSQL integration, and product Playwright', () => {
    expect(resolvedUiGate).toEqual([
      'npx tsc --noEmit',
      'npx eslint .',
      'npx vitest run --project unit',
      'npx vitest run --project unit tests/observability/timing.test.ts',
      'npx vitest run --project integration tests/integration tests/scheduling/booking-concurrency.test.ts',
      'npx playwright test --project=product e2e/appointments.spec.ts',
      'npx playwright test --project=e2-wiring',
      'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e2-wiring.spec.ts',
    ])
  })

  test('ordinary product Playwright excludes wiring specs; E2 depends on product while E0/E1 remain certification', () => {
    expect(playwrightConfig).toMatch(/name:\s*'product'/)
    expect(playwrightConfig).toMatch(/testIgnore:\s*\/e\[012\]-wiring\\\.spec\\\.ts\//)
    expect(playwrightConfig).toMatch(/name:\s*'e2-wiring'/)
    expect(playwrightConfig).toMatch(/testMatch:\s*\/e2-wiring\\\.spec\\\.ts\//)
    expect(playwrightConfig).toMatch(/dependencies:\s*\['product'\]/)
    expect(playwrightConfig).toMatch(/name:\s*'certification'/)
    expect(playwrightConfig).toMatch(/testMatch:\s*\/e\[01\]-wiring\\\.spec\\\.ts\//)
  })

  test('no per-change step bypasses the gate to launch a test tool directly', () => {
    const lines = ci.split('\n').filter((line) => !/scripts\/gate\.sh/.test(line))
    for (const tool of ['eslint', 'tsc', 'vitest', 'playwright test']) {
      for (const line of lines) {
        expect(line, `line calls ${tool} outside scripts/gate.sh: ${line}`).not.toMatch(
          new RegExp(`\\bnpx ${tool}\\b`),
        )
      }
    }
  })
})

describe('fresh-clone certification stays required and visible', () => {
  const triggerBlock = certification.match(/^on:\n([\s\S]*?)^concurrency:/m)?.[1] ?? ''

  test('certification runs on main, nightly, and by manual dispatch', () => {
    expect(triggerBlock).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/)
    expect(triggerBlock).toMatch(/^\s*schedule:\s*$/m)
    expect(triggerBlock).toMatch(/cron:\s*["']17 7 \* \* \*["']/)
    expect(triggerBlock).toMatch(/^\s*workflow_dispatch:\s*$/m)
  })

  test('certification has the same obsolete-run cancellation behavior', () => {
    expect(certification).toContain('group: ${{ github.workflow }}-${{ github.head_ref || github.ref_name }}')
    expect(certification).toMatch(/cancel-in-progress:\s*true/)
  })

  test('the workflow invokes one explicit serial E0/E1 certification entry point', () => {
    expect(executableInvocations(certification, /scripts\/certify\.sh/)).toHaveLength(1)
    expect(certify).toMatch(/playwright test --project=certification --workers=1/)
  })
})

describe('timing and warm browser setup', () => {
  test.each([
    ['CI', ci],
    ['Certification', certification],
  ])('%s records setup phases and uses a versioned lockfile browser cache', (_name, workflow) => {
    expect(workflow).toContain('GITHUB_STEP_SUMMARY')
    expect(workflow).toContain('dependency setup')
    expect(workflow).toContain('Playwright setup')
    expect(workflow).toContain("hashFiles('package-lock.json')")
    expect(workflow).toContain('steps.playwright-version.outputs.version')
    expect(workflow).toMatch(/npx playwright install --with-deps chromium/)
  })

  test('the gate records unit, integration, and Playwright command durations', () => {
    const gate = readFileSync(GATE_PATH, 'utf8')
    expect(gate).toMatch(/timing \$\{name\}=\$\{duration\}s/)
    expect(gate).toContain('GITHUB_STEP_SUMMARY')
  })
})

describe('failure and environment guardrails', () => {
  const gateStepAndAfter = ci.slice(ci.indexOf(gateInvocations[0]))
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SOURCE_REF_SALT',
  ]

  test('a failing product gate cannot be swallowed', () => {
    expect(gateStepAndAfter).not.toMatch(/continue-on-error:\s*true/)
    expect(gateInvocations[0]).not.toMatch(/\|\|\s*true/)
  })

  test.each(required)('%s comes from a repository secret in both workflows', (name) => {
    const pattern = new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`)
    expect(ci).toMatch(pattern)
    expect(certification).toMatch(pattern)
  })

  test.each([
    ['ci.yml', ci],
    ['certification.yml', certification],
  ])('%s has an explicit app port and no pinned test database port', (_name, workflow) => {
    expect(workflow).toMatch(/PORT:\s*"?\d+"?/)
    expect(workflow).not.toMatch(/TEST_PG_PORT/)
  })
})

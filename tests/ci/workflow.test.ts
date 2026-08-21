import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const CI_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const CERTIFICATION_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'certification.yml')
const GATE_PATH = path.join(REPO_ROOT, 'scripts', 'gate.sh')
const CERTIFY_PATH = path.join(REPO_ROOT, 'scripts', 'certify.sh')
const PLAYWRIGHT_CONFIG_PATH = path.join(REPO_ROOT, 'playwright.config.ts')
const REPORT_VALIDATOR_PATH = path.join(REPO_ROOT, 'scripts', 'validate-playwright-report.mjs')

const ci = readFileSync(CI_PATH, 'utf8')
const certification = readFileSync(CERTIFICATION_PATH, 'utf8')
const certify = readFileSync(CERTIFY_PATH, 'utf8')
const playwrightConfig = readFileSync(PLAYWRIGHT_CONFIG_PATH, 'utf8')

const REQUIRED_UI_GATE_PREFIX = [
  'npx tsc --noEmit',
  'npx eslint .',
  'npx vitest run --project unit',
  'npx vitest run --project unit tests/coverage-config.test.ts',
  'npx vitest run --coverage --project unit --project integration',
  'npx vitest run --project unit tests/performance/performance-contract.test.ts',
  'npx vitest run --project unit tests/adversarial/cross-patient.test.ts',
  'npx vitest run --project unit tests/observability/timing.test.ts',
  'npx vitest run --project integration tests/integration tests/scheduling/booking-concurrency.test.ts',
  'npx vitest run --project e8',
]
const PLAYWRIGHT_COMMAND = 'npx playwright test --project=product --project=e2-wiring --project=e3-wiring --project=e4-wiring --project=e5-wiring --project=e8-wiring'
const REQUIRED_UI_SUITES = [
  'e2e/e8-wiring.spec.ts',
  'e2e/e5-wiring.spec.ts',
  'e2e/book.spec.ts',
  'e2e/provider-schedule.spec.ts',
  'e2e/playback-frames.spec.ts',
  'e2e/empty-states.spec.ts',
  'e2e/responsive.spec.ts',
  'e2e/accessibility.spec.ts',
  'e2e/e2-wiring.spec.ts',
  'e2e/e3-wiring.spec.ts',
  'e2e/e4-wiring.spec.ts',
] as const
const REPORT_VALIDATOR = /^node scripts\/validate-playwright-report\.mjs test-results\/playwright\.json (e2e\/[^ ]+\.spec\.ts)$/

function expectValidUiGateManifest(commands: string[]): void {
  expect(commands.slice(0, REQUIRED_UI_GATE_PREFIX.length)).toEqual(REQUIRED_UI_GATE_PREFIX)
  const browserCommands = commands.slice(REQUIRED_UI_GATE_PREFIX.length)
  expect(browserCommands[0]).toBe(PLAYWRIGHT_COMMAND)
  expect(browserCommands.filter((command) => command.startsWith('npx playwright test'))).toEqual([PLAYWRIGHT_COMMAND])

  const seenSuites = new Set<string>()
  for (const validator of browserCommands.slice(1)) {
    const suite = validator.match(REPORT_VALIDATOR)?.[1]
    expect(suite, `manifest entry is not a report validator: ${validator}`).toBeDefined()
    expect(seenSuites.has(suite!), `suite ${suite} has more than one validator`).toBe(false)
    seenSuites.add(suite!)
  }

  for (const suite of REQUIRED_UI_SUITES) expect(seenSuites.has(suite), `missing report validator for ${suite}`).toBe(true)
}

function executableInvocations(source: string, pattern: RegExp): string[] {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => pattern.test(line))
}

function pushBranches(workflow: string): string[] {
  const pushBlock = workflow.match(/^  push:\n((?: {4}.*\n)*)/m)?.[1] ?? ''
  return [...pushBlock.matchAll(/^ {6}-\s+(.+)$/gm)].map((match) => match[1])
}

const gateInvocations = executableInvocations(ci, /scripts\/gate\.sh/)

describe('per-change triggers and concurrency', () => {
  const triggerBlock = ci.match(/^on:\n([\s\S]*?)^concurrency:/m)?.[1] ?? ''

  test('adversarial: product workflow push branches are exactly main', () => {
    expect(pushBranches(ci)).toEqual(['main'])
    expect(pushBranches(ci.replace('      - main', "      - main\n      - '**'"))).not.toEqual(['main'])
    expect(triggerBlock).toMatch(/^\s*pull_request:\s*$/m)
  })

  test('obsolete runs for the same PR or main branch share one cancelling group', () => {
    expect(ci).toContain('group: ${{ github.workflow }}-${{ github.head_ref || github.ref_name }}')
    expect(ci).toMatch(/cancel-in-progress:\s*true/)
  })

  test('the gate is not conditional on event type', () => {
    const gateStep = ci.slice(ci.indexOf('- name: Product UI gate'))
    expect(gateStep).not.toMatch(/^\s*if:/m)
  })
})

describe('Playwright report validation', () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'pip-playwright-report-'))
  const reportPath = path.join(fixtureDir, 'report.json')
  const validate = (tests: unknown[]) => {
    writeFileSync(reportPath, JSON.stringify({
      stats: {},
      suites: [{ file: 'required.spec.ts', specs: [{ tests }] }],
    }))
    return spawnSync('node', [REPORT_VALIDATOR_PATH, reportPath, 'e2e/required.spec.ts'])
  }

  afterAll(() => rmSync(fixtureDir, { recursive: true }))

  test('required suites with a completed test are accepted', () => {
    expect(validate([{ status: 'expected' }]).status).toBe(0)
  })

  test('adversarial: required suites with no tests or only skipped tests are rejected', () => {
    expect(validate([]).status).not.toBe(0)
    expect(validate([{ status: 'skipped' }]).status).not.toBe(0)
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

  test('JOR-306: the UI tier launches Playwright once and validates every required suite', () => {
    const playwrightCommands = resolvedUiGate.filter((command) => command.startsWith('npx playwright test'))
    expect(playwrightCommands).toHaveLength(1)
    for (const suite of REQUIRED_UI_SUITES) {
      expect(resolvedUiGate).toContain(
        `node scripts/validate-playwright-report.mjs test-results/playwright.json ${suite}`,
      )
    }
  })

  test('the UI gate preserves the cumulative prefix and matched Playwright report entries', () => {
    expectValidUiGateManifest(resolvedUiGate)
  })

  test('JOR-253 and JOR-260 Playwright extensions are accepted without a manifest count edit', () => {
    expectValidUiGateManifest([
      ...resolvedUiGate,
      'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/appended-ticket.spec.ts',
    ])
  })

  test('the combined command cannot omit the e2-wiring project', () => {
    expect(() => expectValidUiGateManifest([
      ...REQUIRED_UI_GATE_PREFIX,
      PLAYWRIGHT_COMMAND.replace(' --project=e2-wiring', ''),
      ...REQUIRED_UI_SUITES.map((suite) => `node scripts/validate-playwright-report.mjs test-results/playwright.json ${suite}`),
    ])).toThrow()
  })

  test('uiGateExtension_withoutMatchingReportValidator_isRejected', () => {
    expect(() => expectValidUiGateManifest(resolvedUiGate.filter((command) => !command.endsWith('e2e/book.spec.ts')))).toThrow()
  })

  test('uiGateExtension_withNonValidatorOrDuplicateSuite_isRejected', () => {
    expect(() => expectValidUiGateManifest([...resolvedUiGate, 'echo not-a-validator'])).toThrow()
    expect(() => expectValidUiGateManifest([
      ...resolvedUiGate,
      'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/book.spec.ts',
    ])).toThrow()
  })

  test('uiGateRequiredPrefix_reorderedOrRemoved_isRejected', () => {
    expect(() => expectValidUiGateManifest([
      REQUIRED_UI_GATE_PREFIX[1],
      REQUIRED_UI_GATE_PREFIX[0],
      ...REQUIRED_UI_GATE_PREFIX.slice(2),
      ...resolvedUiGate.slice(REQUIRED_UI_GATE_PREFIX.length),
    ])).toThrow()
    expect(() => expectValidUiGateManifest([
      ...REQUIRED_UI_GATE_PREFIX.slice(0, -1),
      ...resolvedUiGate.slice(REQUIRED_UI_GATE_PREFIX.length),
    ])).toThrow()
  })

  test('ordinary product Playwright excludes dedicated wiring specs; E2/E3 depend on product while E0/E1 remain certification', () => {
    expect(playwrightConfig).toMatch(/name:\s*'product'/)
    expect(playwrightConfig).toMatch(/testIgnore:\s*\/e\[0123458\]-wiring\\\.spec\\\.ts\//)
    expect(playwrightConfig).toMatch(/name:\s*'e2-wiring'/)
    expect(playwrightConfig).toMatch(/testMatch:\s*\/e2-wiring\\\.spec\\\.ts\//)
    expect(playwrightConfig).toMatch(/name:\s*'e3-wiring'/)
    expect(playwrightConfig).toMatch(/testMatch:\s*\/e3-wiring\\\.spec\\\.ts\//)
    expect(playwrightConfig).toMatch(/dependencies:\s*\['product'\]/)
    expect(playwrightConfig).toMatch(/name:\s*'e4-wiring'/)
    expect(playwrightConfig).toMatch(/testMatch:\s*\/e4-wiring\\\.spec\\\.ts\//)
    expect(playwrightConfig).toMatch(/name:\s*'e8-wiring'/)
    expect(playwrightConfig).toMatch(/testMatch:\s*\/e8-wiring\\\.spec\\\.ts\//)
    expect(playwrightConfig).toMatch(/name:\s*'e5-wiring'/)
    expect(playwrightConfig).toMatch(/testMatch:\s*\/e5-wiring\\\.spec\\\.ts\//)
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
    expect(workflow).toMatch(/npx playwright install chromium/)
    expect(workflow).not.toMatch(/playwright install[^\n]*--with-deps/)
    expect(workflow).toMatch(/- name: Setup — Playwright browser\n\s+timeout-minutes:\s*[1-9]\d*\n\s+run:/)
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

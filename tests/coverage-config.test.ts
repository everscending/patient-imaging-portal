import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

import vitestConfig from '../vitest.config'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const COVERAGE_CONTRACT_COMMAND = 'npx vitest run --project unit tests/coverage-config.test.ts'
const COVERAGE_COMMAND = 'npx vitest run --coverage --project unit --project integration'
const CORE_MODULES = [
  'lib/access/guard.ts',
  'lib/access/identity.ts',
  'lib/imaging/signing.ts',
  'lib/imaging/studies.ts',
  'lib/notify/reminders.ts',
  'lib/reports/reports.ts',
  'lib/scheduling/booking.ts',
  'lib/scheduling/lifecycle.ts',
  'lib/share/links.ts',
]

type Project = { test?: { name?: string; include?: string[]; exclude?: string[] } }
type CoverageConfig = {
  include?: string[]
  exclude?: string[]
  thresholds?: Record<string, number>
}

const testConfig = (vitestConfig as { test?: { coverage?: CoverageConfig; projects?: Project[] } }).test
const coverage = testConfig?.coverage
const projects = testConfig?.projects ?? []

describe('CQ-1 coverage contract', () => {
  test('adversarial: coverage below any required metric fails instead of only printing a report', () => {
    expect(coverage?.thresholds).toEqual({
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80,
    })
  })

  test('adversarial: the include set is exactly the named core logic, with no UI or route widening', () => {
    expect([...coverage?.include ?? []].sort()).toEqual(CORE_MODULES)
  })

  test('adversarial: no named core module is removed through a coverage exclusion', () => {
    expect(coverage?.exclude).toBeUndefined()
  })

  test('adversarial: statements, branches, functions, and lines each enforce eighty percent', () => {
    expect(Object.keys(coverage?.thresholds ?? {}).sort()).toEqual(['branches', 'functions', 'lines', 'statements'])
    expect(new Set(Object.values(coverage?.thresholds ?? {}))).toEqual(new Set([80]))
  })

  test('adversarial: the coverage command runs the full unit, adversarial, integration, and concurrency suites', () => {
    const unit = projects.find((project) => project.test?.name === 'unit')?.test
    const integration = projects.find((project) => project.test?.name === 'integration')?.test
    expect(unit?.include).toEqual(['tests/**/*.test.ts'])
    expect(unit?.exclude).not.toContain('tests/adversarial/**')
    expect(integration?.include).toEqual([
      'tests/integration/**/*.test.ts',
      'tests/scheduling/booking-concurrency.test.ts',
    ])

    const commands = execFileSync(path.join(REPO_ROOT, 'scripts', 'gate.sh'), ['logic', '--list'])
      .toString()
      .trim()
      .split('\n')
    expect(commands).toContain(COVERAGE_CONTRACT_COMMAND)
    expect(commands).toContain(COVERAGE_COMMAND)
  })

  test('adversarial: no second coverage threshold is configured outside vitest.config.ts', () => {
    const otherConfig = [
      '.loom.yml',
      'package.json',
      'scripts/gate.sh',
      '.github/workflows/ci.yml',
    ].map((file) => readFileSync(path.join(REPO_ROOT, file), 'utf8')).join('\n')
    expect(otherConfig).not.toMatch(/coverage[^\n]*(?:threshold|--threshold)/i)
  })

  test('adversarial: the recorded measurement has its command, date, and source commit beside it', () => {
    const report = readFileSync(path.join(REPO_ROOT, 'docs', 'coverage.md'), 'utf8')
    expect(report).toContain(COVERAGE_COMMAND)
    expect(report).toMatch(/Measured: \d{4}-\d{2}-\d{2}/)
    expect(report).toMatch(/Source commit: `[0-9a-f]{40}`/)
    for (const modulePath of CORE_MODULES) expect(report).toContain(`\`${modulePath}\``)
  })

  test('adversarial: coverage configuration never introduces a bare well-known host port', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'vitest.config.ts'), 'utf8')
    expect(source).not.toMatch(/\b(?:3000|5432|5433|8080)\b/)
  })
})

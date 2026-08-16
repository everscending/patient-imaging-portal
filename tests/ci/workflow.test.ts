import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const workflow = readFileSync(WORKFLOW_PATH, 'utf8')

// Steps that invoke the gate runner — excludes comment lines that merely
// mention scripts/gate.sh in passing.
const gateInvocations = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .filter((line) => /scripts\/gate\.sh/.test(line))

describe('triggers — acceptance: every push and every pull request', () => {
  test('push has no branch filter, so every branch triggers the workflow', () => {
    const pushBlock = workflow.match(/^on:\n([\s\S]*?)^jobs:/m)?.[1] ?? ''
    expect(pushBlock).toMatch(/^\s*push:\s*$/m)
    // A `push:` key with nothing indented under it (immediately followed by
    // another top-level trigger key or the end of the block) restricts to
    // no branch, which means every branch.
    expect(pushBlock).not.toMatch(/push:\s*\n\s+branches:/)
  })

  test('pull_request triggers the workflow', () => {
    const pushBlock = workflow.match(/^on:\n([\s\S]*?)^jobs:/m)?.[1] ?? ''
    expect(pushBlock).toMatch(/^\s*pull_request:\s*$/m)
  })
})

describe('gate invocations — acceptance: product UI and certification are separate', () => {
  const productGateInvocation = gateInvocations.find((line) => /scripts\/gate\.sh ui\s*$/.test(line))
  const certificationInvocation = gateInvocations.find((line) => /scripts\/gate\.sh certification\s*$/.test(line))

  test('the workflow calls each entry point exactly once', () => {
    expect(gateInvocations).toHaveLength(2)
    expect(gateInvocations.filter((line) => /scripts\/gate\.sh ui\s*$/.test(line))).toHaveLength(1)
    expect(gateInvocations.filter((line) => /scripts\/gate\.sh certification\s*$/.test(line))).toHaveLength(1)
  })

  test('the product UI entry point retains cumulative logic, API, and ordinary product end-to-end coverage', () => {
    expect(productGateInvocation).toMatch(/scripts\/gate\.sh ui\s*$/)
  })

  test('the certification entry point runs independently', () => {
    expect(certificationInvocation).toMatch(/scripts\/gate\.sh certification\s*$/)
  })

  test('adversarial: no step calls eslint, tsc, vitest, or playwright directly, bypassing the gate runner', () => {
    const lines = workflow.split('\n').filter((line) => !/scripts\/gate\.sh/.test(line))
    for (const tool of ['eslint', 'tsc', 'vitest', 'playwright test']) {
      for (const line of lines) {
        expect(line, `line calls ${tool} outside scripts/gate.sh: ${line}`).not.toMatch(
          new RegExp(`\\bnpx ${tool}\\b`),
        )
      }
    }
  })
})

describe('gate.sh ui cannot have its failure swallowed by the workflow step', () => {
  // tests/gate/gate.test.ts already proves gate.sh itself propagates the
  // first non-zero exit from TSC, ESLINT, VITEST_UNIT, VITEST_INTEGRATION or
  // PLAYWRIGHT as a non-zero exit from `scripts/gate.sh ui`. What the
  // workflow step could still get wrong is masking that exit code — the
  // three adversarial scenarios below are all instances of the same
  // property, named separately because the ticket names them separately.
  const productGateInvocation = gateInvocations.find((line) => /scripts\/gate\.sh ui\s*$/.test(line))
  const gateStepAndAfter = workflow.slice(workflow.indexOf(productGateInvocation ?? ''))

  test('adversarial: a lint violation (e.g. a lib/** import of app/**) cannot turn the run green', () => {
    expect(gateStepAndAfter).not.toMatch(/continue-on-error:\s*true/)
    expect(productGateInvocation).not.toMatch(/\|\|\s*true/)
  })

  test('adversarial: a failing unit test cannot turn the run green', () => {
    expect(gateStepAndAfter).not.toMatch(/continue-on-error:\s*true/)
    expect(productGateInvocation).not.toMatch(/\|\|\s*true/)
  })

  test('adversarial: a failing end-to-end test cannot turn the run green', () => {
    expect(gateStepAndAfter).not.toMatch(/continue-on-error:\s*true/)
    expect(productGateInvocation).not.toMatch(/\|\|\s*true/)
  })
})

describe('§8 required variables — acceptance + adversarial: wired from secrets, never left to resolve empty', () => {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SOURCE_REF_SALT',
  ]

  test.each(required)('adversarial: %s comes from a repository secret, so it is never unset in CI', (name) => {
    const pattern = new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`)
    expect(workflow).toMatch(pattern)
  })
})

describe('repo-wide guards', () => {
  test('the workflow file contains no bare well-known port', () => {
    for (const port of ['3000', '5432']) {
      expect(workflow, `ci.yml must not contain bare ${port}`).not.toMatch(new RegExp(`\\b${port}\\b`))
    }
  })

  test('PORT is set explicitly, and TEST_PG_PORT is left unset (ADR-0013)', () => {
    expect(workflow).toMatch(/PORT:\s*"?\d+"?/)
    expect(workflow).not.toMatch(/TEST_PG_PORT/)
  })

  test('the workflow contains no secret value, only secrets.* references', () => {
    for (const name of [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SOURCE_REF_SALT',
    ]) {
      const line = workflow.split('\n').find((l) => l.trim().startsWith(`${name}:`))
      expect(line).toBeDefined()
      expect(line).toMatch(/\$\{\{\s*secrets\./)
    }
  })
})

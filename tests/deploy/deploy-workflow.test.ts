// .github/workflows/deploy.yml gates Vercel's own git-integration promotion
// behind scripts/gate.sh (JOR-252). Text-based assertions, matching
// tests/deploy/vercel-config.test.ts's own approach — a YAML AST parser
// would be a new dependency for a file this project already reads as text.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'deploy.yml')
const raw = readFileSync(WORKFLOW_PATH, 'utf8')
const VERCEL_JSON = readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8')

describe('AC: deploy.yml gates on push to main only', () => {
  test('triggersOnPushToMain', function triggersOnPushToMain() {
    expect(raw).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main/)
  })

  test('adversarial: does not also trigger on pull_request (that is ci.yml\'s job, not a deploy gate\'s)', function noPullRequestTrigger() {
    expect(raw).not.toMatch(/pull_request/)
  })
})

describe('AC: deploy.yml calls the repo\'s own gate, never reimplements it', () => {
  test('callsGateShUi', function callsGateShUi() {
    expect(raw).toMatch(/scripts\/gate\.sh ui/)
  })

  test('adversarial: does not invoke tsc, eslint, vitest, or playwright test directly (that is gate.sh\'s job)', function neverReimplementsGateSteps() {
    expect(raw).not.toMatch(/npx tsc\b/)
    expect(raw).not.toMatch(/npx eslint\b/)
    expect(raw).not.toMatch(/npx vitest run\b/)
    expect(raw).not.toMatch(/npx playwright test\b/)
  })
})

describe('mandatory adversarial: deploy never runs while gates fail', () => {
  const gateStepIndex = raw.indexOf('scripts/gate.sh ui')
  const confirmStepIndex = raw.indexOf('Confirm production reflects this gated commit')

  test('gateStepPrecedesTheConfirmationStep', function gateStepPrecedesTheConfirmationStep() {
    expect(gateStepIndex).toBeGreaterThan(-1)
    expect(confirmStepIndex).toBeGreaterThan(-1)
    expect(gateStepIndex).toBeLessThan(confirmStepIndex)
  })

  test('adversarial: no continue-on-error key anywhere — a failing gate step must stop the job', function noContinueOnError() {
    expect(raw).not.toMatch(/continue-on-error\s*:/)
  })

  test('adversarial: the confirmation step does not run with if: always() (which would run it even after a failed gate)', function noIfAlwaysOnConfirmStep() {
    const confirmStepBlock = raw.slice(confirmStepIndex, confirmStepIndex + 400)
    expect(confirmStepBlock).not.toMatch(/if:\s*always\(\)/)
  })

  test('adversarial: the confirmation step never issues its own vercel promote/deploy (it only lists and compares, read-only)', function confirmStepIsReadOnly() {
    const confirmStepBlock = raw.slice(confirmStepIndex, raw.length)
    expect(confirmStepBlock).not.toMatch(/vercel\s+(promote|deploy|--prod)/)
    expect(confirmStepBlock).not.toMatch(/-X\s+POST|-X\s+PUT|-X\s+DELETE|--request\s+(POST|PUT|DELETE)/i)
  })
})

describe('mandatory adversarial: no secret committed in deploy.yml', () => {
  test('adversarial: no JWT-shaped string (a Supabase anon or service role key is always one)', () => {
    expect(raw).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/)
  })

  test('adversarial: no Supabase personal access token (sbp_...)', () => {
    expect(raw).not.toMatch(/\bsbp_[a-f0-9]{10,}\b/)
  })

  test('adversarial: no bearer token or authorization header value', () => {
    expect(raw).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/i)
  })

  test('adversarial: no Vercel token pasted next to VERCEL_TOKEN', () => {
    expect(raw).not.toMatch(/VERCEL_TOKEN[=:\s]+(?!\$\{\{)[A-Za-z0-9]{20,}/)
  })

  test('every §8 secret this workflow needs is referenced via the secrets context, never a literal', () => {
    for (const name of [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SOURCE_REF_SALT',
      'APP_BASE_URL',
      'RESEND_API_KEY',
      'RESEND_FROM',
      'EMAIL_TRANSPORT',
      'CRON_SECRET',
      'VERCEL_TOKEN',
    ]) {
      expect(raw, `${name} must be read via \${{ secrets.${name} }}`).toMatch(new RegExp(`\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`))
    }
  })
})

describe('mandatory adversarial: no hardcoded host or bare well-known port in deploy.yml', () => {
  test('adversarial: the deployed host is never hardcoded — production is looked up by project name, not a pasted URL', () => {
    expect(raw).not.toContain('patient-imaging-portal.vercel.app')
  })

  test('adversarial: no bare well-known port', () => {
    for (const port of ['3000', '5432', '5433', '8080']) {
      expect(raw, `deploy.yml must not contain bare ${port}`).not.toMatch(new RegExp(`\\b${port}\\b`))
    }
  })
})

describe('mandatory adversarial: no paid tier introduced', () => {
  test('adversarial: deploy.yml never mentions upgrading to a paid Vercel/Supabase plan', () => {
    expect(raw).not.toMatch(/\b(pro plan|enterprise|team plan|upgrade billing|paid tier)\b/i)
  })

  test('adversarial: vercel.json still declares no multi-region or Vercel Cron config that a Hobby project cannot run', () => {
    const parsed = JSON.parse(VERCEL_JSON) as { regions?: unknown[]; crons?: unknown }
    expect(Array.isArray(parsed.regions) ? parsed.regions.length : 0).toBeLessThanOrEqual(1)
    expect(parsed.crons).toBeUndefined()
  })
})

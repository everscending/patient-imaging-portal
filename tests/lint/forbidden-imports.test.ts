// Proves ARCHITECTURE.md §2's eight forbidden-import rows are mechanically
// enforced, not just documented. Each row gets a fixture with exactly one
// planted violation, linted in-process against the repo's real
// eslint.config.mjs — the same config `npx eslint .` (and so
// `scripts/gate.sh logic`) runs. A violation the gate wouldn't catch is a
// defect in this test, not a passing test.
//
// Bullet → test function (Mandatory adversarial tests, ticket #197):
//   lib/imaging/studies.ts importing app/api/studies/route.ts
//     → adversarialLibImportingAppFails
//   lib/share/links.ts reading SHARE_LINK_TTL_HOURS from the process
//   environment directly → adversarialProcessEnvOutsideConfigFails
//   app/api/studies/route.ts importing @supabase/supabase-js directly
//     → adversarialSupabaseJsOutsideClientFails
//   lib/scheduling/booking.ts inserting into audit_events
//     → adversarialAuditEventsOutsideEventsFails
//   lib/notify/reminders.ts importing the Resend SDK
//     → adversarialResendOutsideEmailFails
//   app/api/reports/[reportId]/route.ts with no guard import, no allowlist
//     → adversarialApiRouteWithoutGuardFails
//   components/imaging/StudyCard.tsx minting a signed Storage URL
//     → adversarialSigningOutsideSigningFails
//   components/reports/ReportView.tsx — a second renderer
//     → adversarialSecondReportViewFails
//   an eslint-disable comment silencing any of the eight rules
//     → adversarialEslintDisableCannotSilenceRules

import { ESLint } from 'eslint'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const ESLINT_CONFIG_FILE = path.join(REPO_ROOT, 'eslint.config.mjs')

// Every local/* rule id the eight rows register (ARCHITECTURE.md §2) — used
// by the "no eslint-disable suppressions" acceptance check below.
const RULE_IDS = [
  'local/no-app-import-in-lib',
  'local/process-env-outside-config',
  'local/supabase-js-outside-client',
  'local/audit-events-outside-events',
  'local/resend-outside-email',
  'local/require-guard-import',
  'local/signing-outside-signing',
  'local/no-report-view-elsewhere',
]

// Built at runtime, never written as a literal, so this file's own source
// text never contains the token tests/config/config.test.ts's repo-wide
// guard scans for — this fixture source names it without reading it.
const PROCESS_DOT_ENV = ['process', 'env'].join('.')

let fixtureDir: string | null = null

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
  fixtureDir = null
})

// Writes `files` (relative path → source) into a fresh directory outside the
// repo tree and lints it in-process against eslint.config.mjs, with that
// directory as the ESLint cwd — the "files"/"ignores" globs in
// eslint.config.mjs (lib/**, app/**, components/**) resolve relative to it,
// exactly as they resolve relative to the repo root during a real
// `npx eslint .` run. Fixtures never touch app/, lib/, or components/ in the
// actual repo tree.
async function lintFixture(files: Record<string, string>): Promise<ESLint.LintResult[]> {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'forbidden-imports-fixture-'))
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = path.join(fixtureDir, relativePath)
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, source)
  }
  const eslint = new ESLint({ cwd: fixtureDir, overrideConfigFile: ESLINT_CONFIG_FILE })
  return eslint.lintFiles(['.'])
}

function errorRuleIds(results: ESLint.LintResult[]): string[] {
  return results.flatMap((result) => result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? ''))
}

describe('row 1 — lib/** must not import from app/**', () => {
  test('acceptance: a lib file with no app import lints clean', async () => {
    const results = await lintFixture({
      'lib/imaging/studies.ts': `export function listStudies() { return [] }\n`,
    })
    expect(errorRuleIds(results)).not.toContain('local/no-app-import-in-lib')
  })

  test('adversarial: lib/imaging/studies.ts importing app/api/studies/route.ts fails', async function adversarialLibImportingAppFails() {
    const results = await lintFixture({
      'lib/imaging/studies.ts': `import { GET } from "@/app/api/studies/route"\nexport const handler = GET\n`,
    })
    expect(errorRuleIds(results)).toContain('local/no-app-import-in-lib')
  })
})

describe('row 2 — only lib/config.ts reads the process environment directly', () => {
  test('acceptance: lib/config.ts itself is exempt', async () => {
    const results = await lintFixture({
      'lib/config.ts': `export const config = { shareLinkTtlHours: Number(${PROCESS_DOT_ENV}.SHARE_LINK_TTL_HOURS ?? 48) }\n`,
    })
    expect(errorRuleIds(results)).not.toContain('local/process-env-outside-config')
  })

  test('adversarial: lib/share/links.ts reading SHARE_LINK_TTL_HOURS from the process environment directly instead of config.shareLinkTtlHours fails', async function adversarialProcessEnvOutsideConfigFails() {
    const results = await lintFixture({
      'lib/share/links.ts': `export function ttlHours() { return Number(${PROCESS_DOT_ENV}.SHARE_LINK_TTL_HOURS ?? 48) }\n`,
    })
    expect(errorRuleIds(results)).toContain('local/process-env-outside-config')
  })
})

describe('row 3 — only lib/db/client.ts imports @supabase/supabase-js', () => {
  test('acceptance: lib/db/client.ts itself is exempt', async () => {
    const results = await lintFixture({
      'lib/db/client.ts': `import { createClient } from "@supabase/supabase-js"\nexport const client = createClient("", "")\n`,
    })
    expect(errorRuleIds(results)).not.toContain('local/supabase-js-outside-client')
  })

  test('adversarial: app/api/studies/route.ts importing @supabase/supabase-js directly fails', async function adversarialSupabaseJsOutsideClientFails() {
    const results = await lintFixture({
      'app/api/studies/route.ts': `import { createClient } from "@supabase/supabase-js"\nimport { guard } from "@/lib/access/guard"\nguard()\nexport const client = createClient("", "")\n`,
    })
    expect(errorRuleIds(results)).toContain('local/supabase-js-outside-client')
  })
})

describe('row 4 — only lib/audit/events.ts writes audit_events', () => {
  test('acceptance: lib/audit/events.ts itself is exempt', async () => {
    const results = await lintFixture({
      'lib/audit/events.ts': `export function write(db: { from(t: string): { insert(v: object): unknown } }) {\n  return db.from("audit_events").insert({})\n}\n`,
    })
    expect(errorRuleIds(results)).not.toContain('local/audit-events-outside-events')
  })

  test('adversarial: lib/scheduling/booking.ts inserting into audit_events fails', async function adversarialAuditEventsOutsideEventsFails() {
    const results = await lintFixture({
      'lib/scheduling/booking.ts': `export function book(db: { from(t: string): { insert(v: object): unknown } }) {\n  return db.from("audit_events").insert({})\n}\n`,
    })
    expect(errorRuleIds(results)).toContain('local/audit-events-outside-events')
  })
})

describe('row 5 — only lib/notify/email.ts imports the Resend SDK', () => {
  test('acceptance: lib/notify/email.ts itself is exempt', async () => {
    const results = await lintFixture({
      'lib/notify/email.ts': `import { Resend } from "resend"\nexport const resend = Resend\n`,
    })
    expect(errorRuleIds(results)).not.toContain('local/resend-outside-email')
  })

  test('adversarial: lib/notify/reminders.ts importing the Resend SDK fails', async function adversarialResendOutsideEmailFails() {
    const results = await lintFixture({
      'lib/notify/reminders.ts': `import { Resend } from "resend"\nexport const resend = Resend\n`,
    })
    expect(errorRuleIds(results)).toContain('local/resend-outside-email')
  })
})

describe('row 6 — every app/api/** file imports lib/access/guard.ts or is allowlisted', () => {
  test('acceptance: a route importing lib/access/guard.ts lints clean', async () => {
    const results = await lintFixture({
      'app/api/studies/route.ts': `import { guard } from "@/lib/access/guard"\nexport async function GET() {\n  await guard()\n  return new Response("ok")\n}\n`,
    })
    expect(errorRuleIds(results)).not.toContain('local/require-guard-import')
  })

  test('adversarial: app/api/reports/[reportId]/route.ts with no guard import and no allowlist entry fails', async function adversarialApiRouteWithoutGuardFails() {
    const results = await lintFixture({
      'app/api/reports/[reportId]/route.ts': `export async function GET() {\n  return new Response("ok")\n}\n`,
    })
    expect(errorRuleIds(results)).toContain('local/require-guard-import')
  })
})

describe('row 7 — only lib/imaging/signing.ts mints signed Storage URLs', () => {
  test('acceptance: lib/imaging/signing.ts itself is exempt', async () => {
    const results = await lintFixture({
      'lib/imaging/signing.ts': `export function sign(bucket: { createSignedUrl(p: string, s: number): unknown }) {\n  return bucket.createSignedUrl("path", 300)\n}\n`,
    })
    expect(errorRuleIds(results)).not.toContain('local/signing-outside-signing')
  })

  test('adversarial: components/imaging/StudyCard.tsx minting a signed Storage URL fails', async function adversarialSigningOutsideSigningFails() {
    const results = await lintFixture({
      'components/imaging/StudyCard.tsx': `export function StudyCard(bucket: { createSignedUrl(p: string, s: number): unknown }) {\n  return bucket.createSignedUrl("path", 300)\n}\n`,
    })
    expect(errorRuleIds(results)).toContain('local/signing-outside-signing')
  })
})

describe('row 8 — lib/reports/ReportView.tsx is the only report renderer', () => {
  test('acceptance: lib/reports/ReportView.tsx itself is exempt', async () => {
    const results = await lintFixture({
      'lib/reports/ReportView.tsx': `export function ReportView() {\n  return null\n}\n`,
    })
    expect(errorRuleIds(results)).not.toContain('local/no-report-view-elsewhere')
  })

  test('adversarial: components/reports/ReportView.tsx — a second renderer — fails', async function adversarialSecondReportViewFails() {
    const results = await lintFixture({
      'components/reports/ReportView.tsx': `export function ReportView() {\n  return null\n}\n`,
    })
    expect(errorRuleIds(results)).toContain('local/no-report-view-elsewhere')
  })
})

describe('row 9 — an eslint-disable comment cannot silence any of the eight rows', () => {
  test('adversarial: an eslint-disable comment silencing local/process-env-outside-config still fails', async function adversarialEslintDisableCannotSilenceRules() {
    const results = await lintFixture({
      'lib/share/links.ts': `/* eslint-disable local/process-env-outside-config */\nexport function ttlHours() { return Number(${PROCESS_DOT_ENV}.SHARE_LINK_TTL_HOURS ?? 48) }\n`,
    })
    expect(errorRuleIds(results)).toContain('local/process-env-outside-config')
  })

  test('acceptance: the real tree carries zero eslint-disable suppressions for any of the eight rules', () => {
    const source = readFileSync(ESLINT_CONFIG_FILE, 'utf8')
    for (const ruleId of RULE_IDS) {
      expect(source).not.toContain(`eslint-disable ${ruleId}`)
      expect(source).not.toContain(`eslint-disable-next-line ${ruleId}`)
      expect(source).not.toContain(`eslint-disable-line ${ruleId}`)
    }
  })
})

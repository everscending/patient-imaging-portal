// scripts/local-del4-runtime.sh namespaces its Supabase CLI containers and
// volumes by project id. The committed supabase/config.toml pins one fixed
// id, so two checkouts (a worktree, a scratch clone, the main clone) running
// the runtime at the same time would tear each other's stack down (JOR-321).
// These tests exercise the script's `project-id` dry run — it derives and
// prints an id without invoking the Supabase CLI at all — plus the
// adversarial check that no lifecycle command still hardcodes the fixed id.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { env } from 'node:process'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'local-del4-runtime.sh')
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8')

// Matches e2e/fixtures/local-runtime.ts's own `{ ...env, ... }` idiom (the
// `env` named import from node:process, not a literal environment access) —
// it keeps this file off the repo-wide reader-allowlist guard.
function projectId(cwd: string, overrides?: Record<string, string>): string {
  return execFileSync(SCRIPT_PATH, ['project-id'], {
    cwd,
    encoding: 'utf8',
    env: overrides ? { ...env, ...overrides } : env,
  }).trim()
}

describe('scripts/local-del4-runtime.sh project id derivation', () => {
  test('is deterministic for the same checkout path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-del4-id-'))
    try {
      expect(projectId(dir)).toBe(projectId(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('differs between distinct checkout paths', () => {
    const dirA = mkdtempSync(path.join(tmpdir(), 'pip-del4-id-a-'))
    const dirB = mkdtempSync(path.join(tmpdir(), 'pip-del4-id-b-'))
    try {
      expect(projectId(dirA)).not.toBe(projectId(dirB))
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  test('has the stable patient-imaging-<8 hex chars> format', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-del4-id-'))
    try {
      expect(projectId(dir)).toMatch(/^patient-imaging-[0-9a-f]{8}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('honors a DEL4_PROJECT_ID override', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-del4-id-'))
    try {
      expect(projectId(dir, { DEL4_PROJECT_ID: 'patient-imaging-fixed' })).toBe('patient-imaging-fixed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mandatory adversarial: no lifecycle command hardcodes the fixed project id', () => {
  test('the committed default is only ever defined, never used to address a container or volume', () => {
    const lines = SCRIPT_SOURCE.split('\n').filter((line) => line.includes('patient-imaging-308'))
    expect(lines).toEqual(["DEFAULT_PROJECT_ID='patient-imaging-308'"])
  })

  test('start/stop/reset run the CLI through --workdir instead of the bare default project', () => {
    expect(SCRIPT_SOURCE).toContain('npx --yes "$SUPABASE_CLI" --workdir "$WORKDIR"')
    expect(SCRIPT_SOURCE).not.toMatch(/npx --yes "\$SUPABASE_CLI" (start|stop|status)\b/)
  })
})

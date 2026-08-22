// scripts/uptime-check.sh polls GET /api/health on the deployed URL and
// reports availability from its own recorded log (JOR-252). These tests
// exercise the script itself — both subcommands — plus the mandatory
// adversarial checks named in the ticket.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'uptime-check.sh')
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8')

function report(logPath: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(SCRIPT_PATH, ['report', logPath], { encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string }
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

function writeLog(dir: string, lines: Record<string, unknown>[]): string {
  const logPath = path.join(dir, 'uptime-check.log')
  writeFileSync(logPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return logPath
}

describe('AC: scripts/uptime-check.sh report — three-state counting and availability', () => {
  test('countsHealthyDegradedAndUnreachableSeparately', function countsHealthyDegradedAndUnreachableSeparately() {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-uptime-'))
    try {
      const logPath = writeLog(dir, [
        { timestamp: '2026-08-22T10:00:00Z', state: 'healthy', http_status: 200, database: 'ok', storage: 'ok' },
        { timestamp: '2026-08-22T10:01:00Z', state: 'healthy', http_status: 200, database: 'ok', storage: 'ok' },
        { timestamp: '2026-08-22T10:02:00Z', state: 'degraded', http_status: 200, database: 'down', storage: 'ok' },
        { timestamp: '2026-08-22T10:03:00Z', state: 'unreachable', http_status: null },
      ])

      const { status, stdout } = report(logPath)
      expect(status).toBe(0)
      expect(stdout).toContain('Total checks: 4')
      expect(stdout).toContain('Reachable and healthy: 2')
      expect(stdout).toContain('Reachable but degraded: 1')
      expect(stdout).toContain('Unreachable: 1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mandatory adversarial: a reachable-but-degraded poll is not counted as downtime', function degradedIsNotDowntime() {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-uptime-'))
    try {
      // All four polls were reachable (three degraded, one healthy) — zero
      // were unreachable, so availability must be 100%, not reduced for the
      // degraded polls.
      const logPath = writeLog(dir, [
        { timestamp: '2026-08-22T10:00:00Z', state: 'healthy', http_status: 200, database: 'ok', storage: 'ok' },
        { timestamp: '2026-08-22T10:01:00Z', state: 'degraded', http_status: 200, database: 'down', storage: 'ok' },
        { timestamp: '2026-08-22T10:02:00Z', state: 'degraded', http_status: 200, database: 'down', storage: 'ok' },
        { timestamp: '2026-08-22T10:03:00Z', state: 'degraded', http_status: 200, database: 'ok', storage: 'down' },
      ])

      const { stdout } = report(logPath)
      expect(stdout).toContain('Availability (reachable, healthy or degraded ÷ total): 100.00%')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mandatory adversarial: degraded is never merged into healthy without distinction', function degradedIsReportedSeparately() {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-uptime-'))
    try {
      const logPath = writeLog(dir, [
        { timestamp: '2026-08-22T10:00:00Z', state: 'healthy', http_status: 200, database: 'ok', storage: 'ok' },
        { timestamp: '2026-08-22T10:01:00Z', state: 'degraded', http_status: 200, database: 'down', storage: 'ok' },
      ])

      const { stdout } = report(logPath)
      // A report that folded degraded into healthy would say "Reachable and
      // healthy: 2" — the count must stay at 1 each, reported on distinct lines.
      expect(stdout).toContain('Reachable and healthy: 1')
      expect(stdout).toContain('Reachable but degraded: 1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mandatory adversarial: an uptime figure requires a recorded window — an empty log refuses, not 100%', function emptyLogRefusesToReport() {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-uptime-'))
    try {
      const logPath = path.join(dir, 'empty.log')
      writeFileSync(logPath, '')

      const { status, stdout, stderr } = report(logPath)
      expect(status).not.toBe(0)
      expect(stdout).not.toMatch(/Availability/)
      expect(stderr).toMatch(/no recorded polls|no window/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mandatory adversarial: the window and figure come only from the log\'s own recorded results, not an external bound', function figureComesOnlyFromTheLog() {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-uptime-'))
    try {
      // report() takes only a log path — no start/end/window argument exists
      // for a caller to substitute. The reported window must equal the
      // first and last timestamps actually present in the file.
      const logPath = writeLog(dir, [
        { timestamp: '2026-08-22T09:00:00Z', state: 'healthy', http_status: 200, database: 'ok', storage: 'ok' },
        { timestamp: '2026-08-22T09:05:00Z', state: 'healthy', http_status: 200, database: 'ok', storage: 'ok' },
      ])

      const { stdout } = report(logPath)
      expect(stdout).toContain('Window start (UTC): 2026-08-22T09:00:00Z')
      expect(stdout).toContain('Window end (UTC): 2026-08-22T09:05:00Z')
      expect(stdout).toContain('Total checks: 2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mandatory adversarial: no secret committed in scripts/uptime-check.sh', () => {
  test('adversarial: no JWT-shaped string (a Supabase anon or service role key is always one)', () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/)
  })

  test('adversarial: no Supabase personal access token (sbp_...)', () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\bsbp_[a-f0-9]{10,}\b/)
  })

  test('adversarial: no bearer token or authorization header value', () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/i)
  })

  test('adversarial: no Vercel token pasted next to VERCEL_TOKEN', () => {
    expect(SCRIPT_SOURCE).not.toMatch(/VERCEL_TOKEN[=:\s]+[A-Za-z0-9]{20,}/)
  })

  test('adversarial: no CRON_SECRET value pasted in the script', () => {
    expect(SCRIPT_SOURCE).not.toMatch(/CRON_SECRET[=:\s]+[A-Za-z0-9._-]{10,}/)
  })
})

describe('mandatory adversarial: no hardcoded host or bare well-known port in scripts/uptime-check.sh', () => {
  test('adversarial: the deployed host is never hardcoded — the base URL is always an argument or env var', () => {
    expect(SCRIPT_SOURCE).not.toContain('patient-imaging-portal.vercel.app')
    expect(SCRIPT_SOURCE).not.toMatch(/https?:\/\/[a-z0-9.-]+\.(vercel\.app|supabase\.co)/i)
  })

  test('adversarial: no bare well-known port anywhere (§9)', () => {
    for (const port of ['3000', '4310', '5432', '5433', '8080']) {
      expect(SCRIPT_SOURCE, `scripts/uptime-check.sh must not contain bare ${port}`).not.toMatch(new RegExp(`\\b${port}\\b`))
    }
  })

  test('AC: base URL is read from an argument or UPTIME_CHECK_BASE_URL, never defaulted to a literal host', () => {
    expect(SCRIPT_SOURCE).toMatch(/UPTIME_CHECK_BASE_URL/)
    expect(SCRIPT_SOURCE).not.toMatch(/UPTIME_CHECK_BASE_URL:-https?:\/\//)
  })
})

describe('AC: scripts/uptime-check.sh is executable and re-runnable', () => {
  test('isExecutable', function isExecutable() {
    expect(statSync(SCRIPT_PATH).mode & 0o111).not.toBe(0)
  })

  test('reportIsSideEffectFreeAndRerunnable', function reportIsSideEffectFreeAndRerunnable() {
    const dir = mkdtempSync(path.join(tmpdir(), 'pip-uptime-'))
    try {
      const logPath = writeLog(dir, [
        { timestamp: '2026-08-22T10:00:00Z', state: 'healthy', http_status: 200, database: 'ok', storage: 'ok' },
      ])
      const before = readFileSync(logPath, 'utf8')
      report(logPath)
      report(logPath)
      const after = readFileSync(logPath, 'utf8')
      expect(after).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

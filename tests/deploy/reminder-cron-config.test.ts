import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const CONFIGURE_PATH = path.join(REPO_ROOT, 'scripts', 'configure-reminder-cron.sh')
const SQL_PATH = path.join(REPO_ROOT, 'db', 'deploy', 'reminder-cron.sql')
const MIGRATION_PATH = path.join(REPO_ROOT, 'db', 'migrations', '004_pg_cron_reminders.sql')
const DEPLOY_DOC_PATH = path.join(REPO_ROOT, 'docs', 'deploy.md')
const inheritedEnv = process['env']

describe('production reminder cron configuration', () => {
  test('deploymentCommandProvisionsTargetSecretAndCadenceBeforeScheduling', function deploymentCommandProvisionsTargetSecretAndCadenceBeforeScheduling() {
    const fixture = mkdtempSync(path.join(tmpdir(), 'pip-reminder-cron-'))
    const fakePsql = path.join(fixture, 'psql')
    const capture = path.join(fixture, 'capture.json')

    writeFileSync(
      fakePsql,
      `#!/usr/bin/env bash
set -euo pipefail
jq -n \
  --arg argv "$*" \
  --arg appBaseUrl "\${APP_BASE_URL}" \
  --arg cronSecret "\${CRON_SECRET}" \
  --arg cronMinutes "\${REMINDER_CRON_MINUTES}" \
  --arg windowMinutes "\${REMINDER_WINDOW_MINUTES}" \
  --arg pgHost "\${PGHOST}" \
  --arg pgDatabase "\${PGDATABASE}" \
  --arg pgUser "\${PGUSER}" \
  '{argv:$argv,appBaseUrl:$appBaseUrl,cronSecret:$cronSecret,cronMinutes:$cronMinutes,windowMinutes:$windowMinutes,pgHost:$pgHost,pgDatabase:$pgDatabase,pgUser:$pgUser}' \
  > "\${CAPTURE}"
`,
      { mode: 0o700 },
    )

    execFileSync(CONFIGURE_PATH, {
      cwd: REPO_ROOT,
      env: {
        ...inheritedEnv,
        PATH: `${fixture}:${inheritedEnv.PATH ?? ''}`,
        CAPTURE: capture,
        PGHOST: 'db.fixture.invalid',
        PGDATABASE: 'postgres',
        PGUSER: 'postgres.fixture',
        PGPASSWORD: 'fixture-db-password-not-real',
        APP_BASE_URL: 'https://portal.example.test',
        CRON_SECRET: 'fixture-secret-not-real',
        REMINDER_CRON_MINUTES: '7',
        REMINDER_WINDOW_MINUTES: '30',
      },
    })

    const invocation = JSON.parse(readFileSync(capture, 'utf8')) as Record<string, string>
    expect(statSync(CONFIGURE_PATH).mode & 0o111).not.toBe(0)
    expect(invocation.argv).toContain('db/deploy/reminder-cron.sql')
    expect(invocation.argv).not.toContain('fixture-db-password-not-real')
    expect(invocation.argv).not.toContain('fixture-secret-not-real')
    expect(invocation.pgHost).toBe('db.fixture.invalid')
    expect(invocation.pgDatabase).toBe('postgres')
    expect(invocation.pgUser).toBe('postgres.fixture')
    expect(invocation.appBaseUrl).toBe('https://portal.example.test')
    expect(invocation.cronSecret).toBe('fixture-secret-not-real')
    expect(invocation.cronMinutes).toBe('7')
    expect(invocation.windowMinutes).toBe('30')

    const sql = readFileSync(SQL_PATH, 'utf8')
    expect(sql).toMatch(/\\getenv\s+app_base_url\s+APP_BASE_URL/)
    expect(sql).toMatch(/\\getenv\s+cron_secret\s+CRON_SECRET/)
    expect(sql).toMatch(/\\getenv\s+reminder_cron_minutes\s+REMINDER_CRON_MINUTES/)
    expect(sql).not.toMatch(/alter database/i)
    expect(sql).toMatch(/select[\s\S]+set_config[\s\S]+app\.app_base_url[\s\S]+\\gset/i)
    expect(sql).toMatch(/select[\s\S]+set_config[\s\S]+app\.cron_secret[\s\S]+\\gset/i)
    expect(sql).toMatch(/select[\s\S]+set_config[\s\S]+app\.reminder_cron_minutes[\s\S]+\\gset/i)
    expect(sql).toMatch(/cron\.unschedule[\s\S]+cron\.schedule/i)

    const migration = readFileSync(MIGRATION_PATH, 'utf8')
    expect(migration).toMatch(/app\.app_base_url[\s\S]+is not null/i)
    expect(migration).toMatch(/app\.cron_secret[\s\S]+is not null/i)

    const deployDoc = readFileSync(DEPLOY_DOC_PATH, 'utf8')
    expect(deployDoc).toContain('scripts/configure-reminder-cron.sh')
  })
})

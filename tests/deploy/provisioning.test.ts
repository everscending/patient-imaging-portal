import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

import { buildMigrationProgram, readMigrationFiles } from '../../scripts/provision-deployed-stack'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const GRANTS = readFileSync(path.join(REPO_ROOT, 'db', 'deploy', 'postgrest-grants.sql'), 'utf8')
const SHELL = readFileSync(path.join(REPO_ROOT, 'scripts', 'provision-deployed-stack.sh'), 'utf8')

describe('deployed schema provisioning', () => {
  test('applies all migrations in filename order and tracks the full filename plus checksum', () => {
    const files = readMigrationFiles()
    expect(files.map((file) => file.name)).toEqual([
      '001_core.sql',
      '002_scheduling_sharing_audit.sql',
      '003_rls.sql',
      '004_identity_link_atomicity.sql',
      '004_pg_cron_reminders.sql',
      '005_apply_provider_availability.sql',
      '006_book_appointment.sql',
      '007_reschedule_cancel_appointments.sql',
      '008_transition_appointment.sql',
    ])

    const program = buildMigrationProgram(files)
    let previous = -1
    for (const file of files) {
      const index = program.indexOf(file.sql)
      expect(index).toBeGreaterThan(previous)
      expect(program).toContain(`where filename = '${file.name}'`)
      expect(program).toContain(file.checksum)
      previous = index
    }
    expect(program).toContain('pg_advisory_lock')
    expect(program).toContain('applied migration checksum changed')
  })

  test('production role inherits only the reviewed app role privileges', () => {
    expect(GRANTS).toContain('revoke all on schema public from public')
    expect(GRANTS).toContain('revoke all on all functions in schema public from public')
    expect(GRANTS).toContain('revoke all on schema public from anon')
    expect(GRANTS).toContain('revoke all on all functions in schema public from anon')
    expect(GRANTS).toContain('revoke all on all tables in schema public from authenticated')
    expect(GRANTS).toContain('revoke all on all sequences in schema public from authenticated')
    expect(GRANTS).toContain('revoke all on all functions in schema public from authenticated')
    expect(GRANTS).toContain('grant app_user to authenticated with inherit true, set false')
  })

  test('shell requires secrets by name and never places their values in arguments', () => {
    for (const name of [
      'PGHOST',
      'PGDATABASE',
      'PGUSER',
      'PGPASSWORD',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SOURCE_REF_SALT',
    ]) {
      expect(SHELL).toContain(name)
    }
    expect(SHELL).not.toMatch(/--password|--db-url|echo.*!required/)
  })
})

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

import { buildMigrationProgram, readMigrationFiles } from '../../scripts/provision-deployed-stack'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const GRANTS = readFileSync(path.join(REPO_ROOT, 'db', 'deploy', 'postgrest-grants.sql'), 'utf8')
const SHELL = readFileSync(path.join(REPO_ROOT, 'scripts', 'provision-deployed-stack.sh'), 'utf8')
const VITE_CONFIG = readFileSync(path.join(REPO_ROOT, 'scripts', 'vite-node.config.ts'), 'utf8')

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
      '009_hosted_jwt_claims.sql',
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
    expect(files.find((file) => file.name === '006_book_appointment.sql')?.sql).toContain(
      'grant booking_executor to current_user',
    )
    for (const name of [
      '006_book_appointment.sql',
      '007_reschedule_cancel_appointments.sql',
      '008_transition_appointment.sql',
    ]) {
      expect(files.find((file) => file.name === name)?.sql).toMatch(
        /grant create on schema public to booking_executor;[\s\S]+alter function[\s\S]+revoke create on schema public from booking_executor;/,
      )
    }
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
    expect(GRANTS).toContain('grant execute on function current_patient_id() to app_user')
    expect(GRANTS).toContain('grant execute on function current_provider_id() to app_user')
    expect(GRANTS).toContain('grant execute on function is_admin() to app_user')
  })

  test('shell requires psql and secrets by name without placing their values in arguments', () => {
    expect(SHELL).toContain('command -v psql')
    expect(SHELL).toContain('psql is required')
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
    expect(SHELL).toContain('PROVISION_DEPLOYED_STACK=1')
    expect(SHELL).toContain('-c scripts/vite-node.config.ts scripts/provision-deployed-stack.ts')
    expect(VITE_CONFIG).toContain("conditions: ['react-server']")
    expect(VITE_CONFIG).toContain("externalConditions: ['react-server']")
    expect(SHELL).not.toMatch(/--password|--db-url|echo.*!required/)
  })
})

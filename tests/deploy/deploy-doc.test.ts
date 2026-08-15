// Complements tests/deploy/vercel-config.test.ts, which covers vercel.json —
// this file covers the other half of "a real key or URL committed in
// vercel.json or docs/deploy.md" (§8's real values live only in the hosting
// projects' settings, SEC-7). docs/deploy.md is also the source a human or a
// lane copies §8 variable *names* from into the Vercel project's Environment
// Variables screen, so a wrong name here — a NEXT_PUBLIC_ prefix on the
// service-role key — is the same live mistake the ticket's "hosting project"
// bullet describes, one commit upstream of it.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const DEPLOY_MD_PATH = path.join(REPO_ROOT, 'docs', 'deploy.md')
const raw = readFileSync(DEPLOY_MD_PATH, 'utf8')

describe('mandatory adversarial: no real key or URL is committed in docs/deploy.md', () => {
  test('adversarial: no JWT-shaped string (a Supabase anon or service role key is always one)', () => {
    expect(raw).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/)
  })

  test('adversarial: no Supabase personal access token (sbp_...)', () => {
    expect(raw).not.toMatch(/\bsbp_[a-f0-9]{10,}\b/)
  })

  test('adversarial: no bearer token or authorization header value', () => {
    expect(raw).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/i)
  })

  test('adversarial: no Vercel token (starts with the CLI\'s own prefix-free 24-char shape) pasted next to VERCEL_TOKEN', () => {
    expect(raw).not.toMatch(/VERCEL_TOKEN[=:\s]+[A-Za-z0-9]{20,}/)
  })
})

describe('mandatory adversarial: no NEXT_PUBLIC_ prefix on SUPABASE_SERVICE_ROLE_KEY in the hosting project', () => {
  test('adversarial: docs/deploy.md — the source a lane copies §8 variable names from into the Vercel project — never names NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY', () => {
    expect(raw).not.toContain('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY')
  })

  test('adversarial: every NEXT_PUBLIC_-prefixed name docs/deploy.md lists is one of the two variables meant to be public', () => {
    const publicNames = new Set(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'])
    const found = raw.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? []
    for (const name of found) {
      expect(publicNames.has(name), `${name} is NEXT_PUBLIC_-prefixed but not one of the two variables meant to be public`).toBe(true)
    }
  })
})

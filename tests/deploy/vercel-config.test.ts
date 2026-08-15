import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const VERCEL_JSON_PATH = path.join(REPO_ROOT, 'vercel.json')
const raw = readFileSync(VERCEL_JSON_PATH, 'utf8')

describe('AC: vercel.json — build and runtime settings for the T1 skeleton', () => {
  const parsed = JSON.parse(raw) as Record<string, unknown>

  test('is valid JSON', () => {
    expect(parsed).toBeTypeOf('object')
  })

  test('pins the framework to nextjs, not left to console auto-detection alone', () => {
    expect(parsed.framework).toBe('nextjs')
  })

  test('pins a build command that matches package.json\'s own build script', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(parsed.buildCommand).toBe(`npm run ${Object.keys(pkg.scripts ?? {}).find((name) => pkg.scripts?.[name] === 'next build')}`)
  })
})

describe('mandatory adversarial: no real key or URL is committed in vercel.json', () => {
  test('adversarial: no JWT-shaped string (a Supabase anon or service role key is always one)', () => {
    expect(raw).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/)
  })

  test('adversarial: no Supabase personal access token (sbp_...)', () => {
    expect(raw).not.toMatch(/\bsbp_[a-f0-9]{10,}\b/)
  })

  test('adversarial: no bearer token or authorization header value', () => {
    expect(raw).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/i)
  })

  test('adversarial: no env/build.env block at all — §8 values are set in the Vercel project, never in this file', () => {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed.env).toBeUndefined()
    expect((parsed.build as Record<string, unknown> | undefined)?.env).toBeUndefined()
  })
})

describe('mandatory adversarial: no NEXT_PUBLIC_ prefix on SUPABASE_SERVICE_ROLE_KEY', () => {
  test('adversarial: vercel.json never names NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY', () => {
    expect(raw).not.toContain('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY')
  })
})

describe('repo-wide guard: no bare well-known port', () => {
  test('adversarial: vercel.json contains no bare 3000, 5432, 5433, or 8080', () => {
    for (const port of ['3000', '5432', '5433', '8080']) {
      expect(raw, `vercel.json must not contain bare ${port}`).not.toMatch(new RegExp(`\\b${port}\\b`))
    }
  })
})

// tests/scripts/run-next-env.test.ts — JOR-311: pins run-next.mjs's tiny
// .env parser (unset-key fill, shell-value precedence, quote stripping).
import { describe, expect, test } from 'vitest'
// @ts-expect-error — run-next.mjs is plain JS; allowJs is off for the app proper.
import { applyDotEnv } from '../../scripts/run-next.mjs'

describe('applyDotEnv', () => {
  test('fills a key that is not already set', () => {
    const env: Record<string, string> = {}
    applyDotEnv('FOO=bar', env)
    expect(env.FOO).toBe('bar')
  })

  test('leaves an already-set key alone (shell value wins)', () => {
    const env = { FOO: 'shell-value' }
    applyDotEnv('FOO=dotenv-value', env)
    expect(env.FOO).toBe('shell-value')
  })

  test('strips surrounding double quotes', () => {
    const env: Record<string, string> = {}
    applyDotEnv('FOO="bar"', env)
    expect(env.FOO).toBe('bar')
  })

  test('strips surrounding single quotes', () => {
    const env: Record<string, string> = {}
    applyDotEnv("FOO='bar'", env)
    expect(env.FOO).toBe('bar')
  })

  test('skips comments, blank lines, and lines with no equals sign', () => {
    const env: Record<string, string> = {}
    applyDotEnv('# comment\n\nNOT_AN_ASSIGNMENT\nFOO=bar', env)
    expect(env).toEqual({ FOO: 'bar' })
  })
})

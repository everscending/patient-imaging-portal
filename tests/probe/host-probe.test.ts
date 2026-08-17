import { execFileSync, spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const PROBE = path.join(REPO_ROOT, 'scripts', 'probe.sh')
const temporaryDirectories: string[] = []

type ProbeFixture = {
  artifact: string
  args: string
  cleanup: string
  env: Record<string, string | undefined>
  ready: string
}

function probeFixture(): ProbeFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'pip-host-probe-'))
  temporaryDirectories.push(root)
  const bin = path.join(root, 'bin')
  const artifact = path.join(root, 'result.json')
  const args = path.join(root, 'args')
  const cleanup = path.join(root, 'cleanup')
  const ready = path.join(root, 'ready')
  writeFileSync(path.join(root, '.keep'), '')
  mkdirSync(bin)
  const fakeNpx = path.join(bin, 'npx')
  writeFileSync(fakeNpx, `#!/usr/bin/env bash
set -u
printf '%s\\n' "$@" > "\${PROBE_ARGS:?}"
printf 'PORT=%s\\nAPP_BASE_URL=%s\\nLOOM_HOST_PROBE_HEAD=%s\\n' \
  "\${PORT-}" "\${APP_BASE_URL-}" "\${LOOM_HOST_PROBE_HEAD-}" > "\${PROBE_ENV:?}"
if [ "\${FAKE_WAIT:-0}" = 1 ]; then
  trap 'printf cleaned > "\${PROBE_CLEANUP:?}"; exit 143' TERM INT
  printf ready > "\${PROBE_READY:?}"
  while :; do sleep 0.1; done
fi
printf '%s\\n' "\${FAKE_OUTPUT-}"
exit "\${FAKE_EXIT:-0}"
`)
  chmodSync(fakeNpx, 0o755)
  return {
    artifact,
    args,
    cleanup,
    ready,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PORT: '45678',
      APP_BASE_URL: 'http://127.0.0.1:45678',
      LOOM_HOST_PROBE_HEAD: '0123456789abcdef',
      LOOM_HOST_PROBE_OUTPUT: artifact,
      PROBE_ARGS: args,
      PROBE_CLEANUP: cleanup,
      PROBE_ENV: path.join(root, 'env'),
      PROBE_READY: ready,
    },
  }
}

function runProbe(
  fixture: ProbeFixture,
  args = ['e2'],
  env: Record<string, string | undefined> = {},
) {
  const childEnv: NodeJS.ProcessEnv = {
    ...fixture.env,
    ...env,
    NODE_ENV: process.env.NODE_ENV,
  }
  return spawnSync(PROBE, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv,
  })
}

function artifact(fixture: ProbeFixture): Record<string, unknown> {
  return JSON.parse(readFileSync(fixture.artifact, 'utf8')) as Record<string, unknown>
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('repository-owned E2 host probe', () => {
  test('e2 maps to only the targeted browser acceptance and preserves the host environment', () => {
    const fixture = probeFixture()
    const result = runProbe(fixture, ['e2'], { FAKE_OUTPUT: '11 passed' })

    expect(result.status).toBe(0)
    expect(readFileSync(fixture.args, 'utf8').trim().split('\n')).toEqual([
      'playwright',
      'test',
      'e2e/e2-wiring.spec.ts',
      '--project=e2-wiring',
      '--no-deps',
    ])
    expect(readFileSync(fixture.env.PROBE_ENV!, 'utf8')).toBe(
      'PORT=45678\nAPP_BASE_URL=http://127.0.0.1:45678\nLOOM_HOST_PROBE_HEAD=0123456789abcdef\n',
    )
    expect(artifact(fixture)).toEqual({
      schema: 1,
      probe: 'e2',
      head: '0123456789abcdef',
      classification: 'pass',
      summary: 'targeted E2 browser acceptance passed',
    })
  })

  test('a zero exit without all 11 targeted checks is infrastructure, never a pass', () => {
    const fixture = probeFixture()
    const result = runProbe(fixture)

    expect(result.status).toBe(10)
    expect(artifact(fixture)).toEqual(expect.objectContaining({
      schema: 1,
      probe: 'e2',
      head: '0123456789abcdef',
      classification: 'infrastructure',
      summary: 'targeted E2 browser acceptance completed without confirming all 11 targeted checks',
    }))
  })

  test('an E2 assertion failure is classified as a product failure', () => {
    const fixture = probeFixture()
    const result = runProbe(fixture, ['e2'], {
      FAKE_EXIT: '1',
      FAKE_OUTPUT: 'Error: expect(received).toBe(expected)',
    })

    expect(result.status).toBe(1)
    expect(artifact(fixture)).toEqual(expect.objectContaining({
      schema: 1,
      probe: 'e2',
      head: '0123456789abcdef',
      classification: 'fail',
      summary: expect.stringContaining('expect(received).toBe(expected)'),
    }))
  })

  test('a browser bootstrap denial is classified as infrastructure', () => {
    const fixture = probeFixture()
    const result = runProbe(fixture, ['e2'], {
      FAKE_EXIT: '1',
      FAKE_OUTPUT: 'MachPortRendezvousServer bootstrap_check_in: Permission denied (1100)',
    })

    expect(result.status).toBe(10)
    expect(artifact(fixture)).toEqual(expect.objectContaining({
      schema: 1,
      probe: 'e2',
      head: '0123456789abcdef',
      classification: 'infrastructure',
      summary: expect.stringContaining('MachPortRendezvousServer'),
    }))
  })

  test('unknown, missing, and extra IDs cannot become host commands', () => {
    for (const args of [[], ['e2;touch-pwned'], ['e2', '--grep', 'anything']]) {
      const fixture = probeFixture()
      const result = runProbe(fixture, args)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('usage: scripts/probe.sh e2')
      expect(existsSync(fixture.args)).toBe(false)
      expect(existsSync(fixture.artifact)).toBe(false)
    }
  })

  test('termination cleans up the owned Playwright process', async () => {
    const fixture = probeFixture()
    const childEnv: NodeJS.ProcessEnv = {
      ...fixture.env,
      FAKE_WAIT: '1',
      NODE_ENV: process.env.NODE_ENV,
    }
    const child: ChildProcess = spawn(PROBE, ['e2'], { cwd: REPO_ROOT, env: childEnv, stdio: 'ignore' })

    for (let attempt = 0; attempt < 100 && !existsSync(fixture.ready); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(existsSync(fixture.ready)).toBe(true)
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await exited
    for (let attempt = 0; attempt < 100 && !existsSync(fixture.cleanup); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(readFileSync(fixture.cleanup, 'utf8')).toBe('cleaned')
  })
})

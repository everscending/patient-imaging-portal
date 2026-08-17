// JOR-283 — the live fixture must never let an enclosing checkout choose the
// Next application it serves.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { startFakeAuthServer, type FakeAuthServer } from '../../e2e/fixtures/fake-auth-server'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const children: ChildProcess[] = []
const fakeAuthServers: FakeAuthServer[] = []
const temporaryDirectories: string[] = []

async function nestedWorktreeFixture(): Promise<{ parentCheckout: string; worktree: string }> {
  const parentCheckout = await mkdtemp(path.join(tmpdir(), 'jor-283-parent-checkout-'))
  temporaryDirectories.push(parentCheckout)
  const worktree = path.join(parentCheckout, '.worktrees', 'lane')
  await mkdir(worktree, { recursive: true })

  await Promise.all(
    ['app', 'components', 'lib', 'scripts'].map((entry) =>
      cp(path.join(REPO_ROOT, entry), path.join(worktree, entry), { recursive: true }),
    ),
  )
  await Promise.all(
    ['.env.test', 'next.config.ts', 'package-lock.json', 'package.json', 'tsconfig.json'].map((entry) =>
      cp(path.join(REPO_ROOT, entry), path.join(worktree, entry)),
    ),
  )
  await Promise.all([
    symlink(path.join(REPO_ROOT, 'node_modules'), path.join(parentCheckout, 'node_modules'), 'dir'),
    symlink(path.join(REPO_ROOT, 'node_modules'), path.join(worktree, 'node_modules'), 'dir'),
  ])
  await writeFile(
    path.join(parentCheckout, 'package-lock.json'),
    JSON.stringify({ name: 'enclosing-checkout', lockfileVersion: 3 }),
  )

  return { parentCheckout, worktree }
}

async function testEnvironment(worktree: string): Promise<string[]> {
  const raw = await readFile(path.join(worktree, '.env.test'), 'utf8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

async function unusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not reserve a TCP port for the live launcher test'))
        return
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)))
    })
  })
}

async function waitForServer(url: string, child: ChildProcess): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`live fixture exited before it became ready: ${child.exitCode}`)
    try {
      return await fetch(url)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`live fixture did not become ready: ${String(lastError)}`)
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve()
          child.once('exit', () => resolve())
          child.kill('SIGTERM')
        }),
    ),
  )
  await Promise.all(fakeAuthServers.splice(0).map((server) => server.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test(
  'adversarial: live launcher started from parent checkout serves worktree routes',
  async function liveLauncherStartedFromParentCheckoutServesWorktreeRoutes() {
    const { parentCheckout, worktree } = await nestedWorktreeFixture()
    const port = await unusedPort()
    const fakeAuthServer = await startFakeAuthServer()
    fakeAuthServers.push(fakeAuthServer)
    const child = spawn('/usr/bin/env', [
      ...(await testEnvironment(worktree)),
      `PORT=${port}`,
      'WATCHPACK_POLLING=true',
      `NEXT_PUBLIC_SUPABASE_URL=${fakeAuthServer.url}`,
      process.execPath,
      path.join(worktree, 'scripts', 'run-next.mjs'),
      'dev',
    ], {
      cwd: parentCheckout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))

    const baseUrl = `http://127.0.0.1:${port}`
    const register = await waitForServer(`${baseUrl}/register`, child)
    expect(register.status, output).toBe(200)
    expect((await fetch(`${baseUrl}/login`)).status).toBe(200)

    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `jor-283-${Date.now()}@example.test`, password: 'CorrectHorseBattery9' }),
    })
    expect(registration.status).toBe(201)
    expect((await fetch(`${baseUrl}/api/identity/status`)).status).toBe(401)
  },
  120_000,
)

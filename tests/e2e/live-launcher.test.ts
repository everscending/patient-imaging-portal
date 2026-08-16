// JOR-283 — the live fixture must never let an enclosing checkout choose the
// Next application it serves.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const PARENT_CHECKOUT = path.resolve(REPO_ROOT, '..', '..')
const children: ChildProcess[] = []

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
})

test(
  'adversarial: live launcher started from parent checkout serves worktree routes',
  async function liveLauncherStartedFromParentCheckoutServesWorktreeRoutes() {
    expect(existsSync(path.join(PARENT_CHECKOUT, 'package-lock.json')), 'the enclosing checkout must have a lockfile').toBe(true)
    const port = await unusedPort()
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'e2e', 'fixtures', 'start-test-server.mjs')], {
      cwd: PARENT_CHECKOUT,
      env: { PORT: String(port), WATCHPACK_POLLING: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))

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

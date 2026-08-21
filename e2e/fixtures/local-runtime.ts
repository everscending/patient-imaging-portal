// Shared boot/teardown harness for the local DEL-4 runtime used by the
// wiring specs (e9-wiring.spec.ts, e10-wiring.spec.ts). Extracted by
// JOR-314 from near-identical copies in both files — behavior is
// unchanged; per-spec differences (error-message label, scratch-dir
// prefix, boundary proxy) stay at the call site.
import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { env } from 'node:process'

const REQUIRED_RUNTIME_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SOURCE_REF_SALT',
] as const

export function getRepoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
}

export function parseEnvironment(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw.split('\n').flatMap((line) => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) return []
      const separator = trimmed.indexOf('=')
      if (separator === -1) return []
      const value = trimmed.slice(separator + 1).replace(/^['"]|['"]$/g, '')
      return [[trimmed.slice(0, separator), value]]
    }),
  )
}

// port is caller-provided (always via unusedPort()) — never a literal,
// per ARCHITECTURE.md §9 / ADR-0013.
export function startLocalRuntime(repoRoot: string, port: number, label: string): Record<string, string> {
  const output = execFileSync('bash', ['scripts/local-del4-runtime.sh', 'run', 'env'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...env, PORT: String(port) },
    timeout: 300_000,
  })
  const values = parseEnvironment(output)
  for (const key of REQUIRED_RUNTIME_KEYS) {
    if (!values[key]) throw new Error(`${label} local runtime did not expose ${key}`)
  }
  return values
}

export function stopLocalRuntime(repoRoot: string): void {
  execFileSync('bash', ['scripts/local-del4-runtime.sh', 'stop'], { cwd: repoRoot, timeout: 120_000 })
}

export async function unusedPort(label: string): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error(`${label} port is unavailable`)
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

export async function waitForApp(options: {
  child: ChildProcess
  appUrl: string
  getOutput: () => string
  label: string
}): Promise<void> {
  const { child, appUrl, getOutput, label } = options
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} app exited (${child.exitCode}):\n${getOutput()}`)
    try {
      if ((await fetch(`${appUrl}/api/health`)).status === 200) return
    } catch {
      // Next's first development compile is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${label} app did not become ready:\n${getOutput()}`)
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

export async function cloneScratchWorktree(repoRoot: string, prefix: string): Promise<string> {
  const scratchDir = await mkdtemp(path.join(tmpdir(), prefix))
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', repoRoot, scratchDir])
  await symlink(path.join(repoRoot, 'node_modules'), path.join(scratchDir, 'node_modules'), 'dir')
  return scratchDir
}

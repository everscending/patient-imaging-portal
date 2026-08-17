import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const DEFAULT_LOCK_PATH = path.join(REPO_ROOT, '.local', 'identity-fixture.lock')
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000
export const IDENTITY_FIXTURE_HOOK_TIMEOUT_MS = 130_000

type IdentityFixtureLockOptions = {
  lockPath?: string
  timeoutMs?: number
  pollMs?: number
}

export async function acquireIdentityFixtureLock(options: IdentityFixtureLockOptions = {}): Promise<string> {
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS)
  const pollMs = options.pollMs ?? 100
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath)
      const token = randomUUID()
      await writeFile(path.join(lockPath, 'owner'), token, { flag: 'wx' })
      return token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  throw new Error('identity fixture lock timed out')
}

export async function releaseIdentityFixtureLock(
  token: string | undefined,
  options: Pick<IdentityFixtureLockOptions, 'lockPath'> = {},
): Promise<void> {
  if (!token) return
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH
  let owner: string
  try {
    owner = await readFile(path.join(lockPath, 'owner'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (owner !== token) return
  await rm(lockPath, { recursive: true, force: true })
}

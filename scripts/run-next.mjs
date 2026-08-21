import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NEXT_CLI = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')

const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: node scripts/run-next.mjs <dev|start>')
  process.exit(1)
}

// Next loads .env itself, but too late for this launcher's own config read.
// Fill gaps from .env before importing lib/config.ts; a variable already set
// in the real environment always wins, same precedence Next applies.
const envPath = path.join(REPO_ROOT, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue
    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (process.env[key] === undefined) process.env[key] = value
  }
}

const { config } = await import('../lib/config.ts')

// Invoke this worktree's installed CLI directly. `npx next` may select an
// enclosing checkout when a lane is started from there, which makes Next
// discover that checkout's app instead of this one.
const nextEnv = { ...process.env }
if (mode === 'dev' && nextEnv.WATCHPACK_POLLING === undefined) {
  nextEnv.WATCHPACK_POLLING = '1000'
}

const child = spawn(process.execPath, [NEXT_CLI, mode, REPO_ROOT, '-p', String(config.port)], {
  cwd: REPO_ROOT,
  env: nextEnv,
  stdio: 'inherit',
})

process.once('SIGINT', () => child.kill('SIGINT'))
process.once('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 0))

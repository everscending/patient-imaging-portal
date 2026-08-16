import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.ts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NEXT_CLI = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')

const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: node scripts/run-next.mjs <dev|start>')
  process.exit(1)
}

// Invoke this worktree's installed CLI directly. `npx next` may select an
// enclosing checkout when a lane is started from there, which makes Next
// discover that checkout's app instead of this one.
const child = spawn(process.execPath, [NEXT_CLI, mode, REPO_ROOT, '-p', String(config.port)], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})

child.on('exit', (code) => process.exit(code ?? 0))

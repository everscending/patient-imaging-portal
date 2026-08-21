import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NEXT_CLI = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')

// Strips one layer of matching quotes, same as Next's own .env loading
// (KEY="value" or KEY='value' -> value).
function unquote(value) {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1)
  }
  return value
}

// Fills gaps in `env` from a .env file's contents; a variable already set
// wins, same precedence Next applies. Exported for testing — pass a plain
// object instead of process.env.
export function applyDotEnv(contents, env) {
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue
    const key = trimmed.slice(0, separatorIndex).trim()
    const value = unquote(trimmed.slice(separatorIndex + 1).trim())
    if (env[key] === undefined) env[key] = value
  }
}

async function main() {
  const mode = process.argv[2]
  if (mode !== 'dev' && mode !== 'start') {
    console.error('usage: node scripts/run-next.mjs <dev|start>')
    process.exit(1)
  }

  // Next loads .env itself, but too late for this launcher's own config read.
  const envPath = path.join(REPO_ROOT, '.env')
  if (existsSync(envPath)) applyDotEnv(readFileSync(envPath, 'utf8'), process.env)

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
}

// Only run the launcher when this file is invoked directly (the CLI), not
// when imported for its exports (tests/scripts/run-next-env.test.ts).
// Realpath both sides: argv[1] may reach here through a symlink (macOS /var
// → /private/var) while import.meta.url is already resolved.
function isCliEntry() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (isCliEntry()) await main()

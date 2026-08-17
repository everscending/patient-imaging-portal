import { spawn } from 'node:child_process'
import { config } from '../lib/config.ts'

const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: node scripts/run-next.mjs <dev|start>')
  process.exit(1)
}

const nextEnv = { ...process.env }
if (mode === 'dev' && nextEnv.WATCHPACK_POLLING === undefined) {
  nextEnv.WATCHPACK_POLLING = '1000'
}

const child = spawn('npx', ['next', mode, '-p', String(config.port)], {
  env: nextEnv,
  stdio: 'inherit',
})

child.on('exit', (code) => process.exit(code ?? 0))

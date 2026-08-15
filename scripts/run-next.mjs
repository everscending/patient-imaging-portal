import { spawn } from 'node:child_process'
import { config } from '../lib/config.ts'

const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: node scripts/run-next.mjs <dev|start>')
  process.exit(1)
}

const child = spawn('npx', ['next', mode, '-p', String(config.port)], {
  stdio: 'inherit',
})

child.on('exit', (code) => process.exit(code ?? 0))

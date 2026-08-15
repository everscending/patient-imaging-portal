import { defineConfig } from '@playwright/test'
import { config } from './lib/config'

// baseURL is derived from config.port (ARCHITECTURE.md §9) — never a literal,
// so a second worktree booting on its own PORT never collides with this one.
export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: `http://localhost:${config.port}`,
  },
  // Starts the app (and, locally, a fake Auth double — e2e/fixtures/
  // start-test-server.mjs) before the suite runs. JOR-229 is the first
  // ticket whose tests need a real running server rather than pure
  // assertions, so this did not exist before it.
  webServer: {
    command: `node e2e/fixtures/start-test-server.mjs`,
    port: config.port,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})

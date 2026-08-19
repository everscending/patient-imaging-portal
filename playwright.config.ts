import { defineConfig } from '@playwright/test'
import { config } from './lib/config'

// baseURL is derived from config.port (ARCHITECTURE.md §9) — never a literal,
// so a second worktree booting on its own PORT never collides with this one.
export default defineConfig({
  workers: 1,
  testDir: './e2e',
  reporter: [['line'], ['json', { outputFile: 'test-results/playwright.json' }]],
  projects: [
    {
      name: 'product',
      testIgnore: /e[0124]-wiring\.spec\.ts/,
    },
    {
      // The E2 fixture exposes mutable identity and audit state. Running it
      // after product prevents unrelated parallel requests from being counted
      // as part of E2's exact audit assertions.
      name: 'e2-wiring',
      testMatch: /e2-wiring\.spec\.ts/,
      dependencies: ['product'],
    },
    {
      // E4's serial suite and fixture lock keep its real patient-session
      // evidence isolated without making this focused confirmation rerun the
      // unrelated product suite.
      name: 'e4-wiring',
      testMatch: /e4-wiring\.spec\.ts/,
    },
    {
      name: 'e8-wiring',
      testMatch: /e8-wiring\.spec\.ts/,
    },
    {
      name: 'certification',
      testMatch: /e[01]-wiring\.spec\.ts/,
    },
  ],
  use: {
    baseURL: `http://localhost:${config.port}`,
  },
  // Boots the fake Supabase Auth server plus the real Next app against it
  // (e2e/fixtures/start-test-server.mjs, JOR-229) — first `next dev` compile
  // can be slow, hence the generous timeout.
  webServer: {
    command: 'node e2e/fixtures/start-test-server.mjs',
    url: `http://localhost:${config.port}`,
    timeout: 120_000,
  },
})

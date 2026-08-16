import { defineConfig } from '@playwright/test'
import { config } from './lib/config'

// baseURL is derived from config.port (ARCHITECTURE.md §9) — never a literal,
// so a second worktree booting on its own PORT never collides with this one.
export default defineConfig({
  testDir: './e2e',
  // The cumulative UI gate covers product behavior only. Fresh-clone wiring
  // proofs are deliberately isolated: they run gates inside scratch clones,
  // so selecting them from the product project would recurse into UI gates.
  projects: [
    {
      name: 'product',
      testIgnore: ['e0-wiring.spec.ts', 'e1-wiring.spec.ts'],
    },
    {
      name: 'certification',
      testMatch: ['e0-wiring.spec.ts', 'e1-wiring.spec.ts'],
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

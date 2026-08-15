import { defineConfig } from '@playwright/test'
import { config } from './lib/config'

// baseURL is derived from config.port (ARCHITECTURE.md §9) — never a literal,
// so a second worktree booting on its own PORT never collides with this one.
export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: `http://localhost:${config.port}`,
  },
})

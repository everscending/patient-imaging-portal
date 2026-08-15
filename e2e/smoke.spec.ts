import { test, expect } from '@playwright/test'

// e2e/ (playwright.config.ts's testDir) had zero spec files, so `npx
// playwright test` exited 1 with "No tests found" even once config loading
// worked (JOR-270) — Playwright has no config-level equivalent of its own
// --pass-with-no-tests CLI flag. This placeholder keeps the PLAYWRIGHT gate
// step green until real page coverage lands; it makes no assertion about
// app behavior.
test('playwright test runner is wired up', () => {
  expect(1 + 1).toBe(2)
})

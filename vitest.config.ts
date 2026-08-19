import { defineConfig } from 'vitest/config'

// Two projects (ARCHITECTURE.md §15): `unit` is everything tests/** except
// tests/integration/**, run by the `logic` tier; `integration` is
// tests/integration/** plus the named booking concurrency proof, run by the
// `api` tier against a migrated
// pip_run_<random> database via tests/setup/postgres.ts's globalSetup
// (ADR-0013). Coverage is configured so CQ-1's 80% threshold has a reporter
// to enforce against once a later ticket sets it — no threshold here yet.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
    },
    // One shared pip-testpg container per machine (ADR-0013) — integration
    // test files that create their own pip_run_* databases must not run
    // concurrently with each other's cleanup.
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/integration/**', 'tests/scheduling/booking-concurrency.test.ts', 'tests/e8-run-record.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts', 'tests/scheduling/booking-concurrency.test.ts'],
          globalSetup: ['./tests/setup/postgres.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e8',
          environment: 'node',
          include: ['tests/e8-run-record.test.ts'],
        },
      },
    ],
  },
})

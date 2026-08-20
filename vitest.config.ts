import { defineConfig } from 'vitest/config'

// Two projects (ARCHITECTURE.md §15): `unit` is everything tests/** except
// tests/integration/**, run by the `logic` tier; `integration` is
// tests/integration/** plus the named booking concurrency proof, run by the
// `api` tier against a migrated
// pip_run_<random> database via tests/setup/postgres.ts's globalSetup
// (ADR-0013). CQ-1 measures only its named core logic, over both projects.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'lib/access/guard.ts',
        'lib/access/identity.ts',
        'lib/imaging/signing.ts',
        'lib/imaging/studies.ts',
        'lib/notify/reminders.ts',
        'lib/reports/reports.ts',
        'lib/scheduling/booking.ts',
        'lib/scheduling/lifecycle.ts',
        'lib/share/links.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
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

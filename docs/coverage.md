# Core logic coverage

CQ-1 measures the authorization and scheduling decisions that can expose PHI or
change an appointment. The coverage allowlist in `vitest.config.ts` is the
contract: UI components, route handlers, configuration and database adapters,
seed and migration code, and test helpers are outside CQ-1 and are therefore
not added to the denominator.

Command: `npx vitest run --coverage --project unit --project integration`
Measured: 2026-08-21
Source commit: `3f37809f96ee90d706865a3a856cc0ff5b63cb09`

The controlled RED measurement used source checkpoint
`64db55fcec3da1f6561bbc266e01ea4867202528`: all 839 tests passed, while
aggregate branch coverage measured 76.36%, below CQ-1. That checkpoint
predates the committed nine-module include and threshold configuration, so it
records the source baseline rather than a reproducible threshold-exit snapshot.
JOR-227 adds public-behavior coverage for the share-link failure paths. The
run recorded below passes all 953 tests across 69 files and all four CQ-1
thresholds, exiting 0.

| Named core module | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `lib/access/identity.ts` | 95.59% | 75% | 100% | 95.59% |
| `lib/access/guard.ts` | 95.04% | 82.32% | 95.23% | 95.04% |
| `lib/imaging/studies.ts` | 100% | 75.51% | 100% | 100% |
| `lib/imaging/signing.ts` | 96.87% | 89.47% | 100% | 96.87% |
| `lib/reports/reports.ts` | 98.27% | 73.33% | 100% | 98.27% |
| `lib/scheduling/booking.ts` | 93.04% | 70.12% | 92.85% | 93.04% |
| `lib/scheduling/lifecycle.ts` | 100% | 100% | 100% | 100% |
| `lib/notify/reminders.ts` | 100% | 62.50% | 100% | 100% |
| `lib/share/links.ts` | 100% | 96.49% | 100% | 100% |
| **All named core logic** | **96.70%** | **81.54%** | **97.53%** | **96.70%** |

The allowlist itself excludes everything not named above. No coverage
`exclude` glob is used, so a named module cannot be silently subtracted after
inclusion. Thresholds for statements, branches, functions, and lines are each
80%; Vitest exits non-zero if any one falls short.

Aggregate branch coverage carries the thinnest margin — 81.54% against the 80%
floor — so a change that adds unexercised branches to a named module can put
the whole tier below CQ-1 on its own.

## Why this command is safe to run in the `logic` tier

Vitest 3.2.7 gives a worker's `onTaskUpdate` RPC a fixed, non-configurable
60,000 ms deadline. A worker that blocks its event loop for longer than that
in one unbroken stretch still passes every test, then fails the run with an
unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`. The quantity that
matters is the longest *contiguous* block, not total runtime: 80 s of blocking
split into two 40 s halves exits 0, while a single 65 s block exits 1.

Under this command `perf_hooks.monitorEventLoopDelay` measures the worst block
in the suite at 6,346 ms, in `tests/integration/deploy-provisioning.test.ts` —
roughly a ninth of the deadline. That block is `provisionSeed` regenerating the
deterministic 840-asset pool, which it does once per call; the test file itself
cannot subdivide it.

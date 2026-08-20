# Core logic coverage

CQ-1 measures the authorization and scheduling decisions that can expose PHI or
change an appointment. The coverage allowlist in `vitest.config.ts` is the
contract: UI components, route handlers, configuration and database adapters,
seed and migration code, and test helpers are outside CQ-1 and are therefore
not added to the denominator.

Command: `npx vitest run --coverage --project unit --project integration`
Measured: 2026-08-20
Source commit: `f7ceff7814b2e551d867ce36e35403b567084217`

The controlled RED measurement used source checkpoint
`64db55fcec3da1f6561bbc266e01ea4867202528`: all 839 tests passed, while
aggregate branch coverage measured 76.36%, below CQ-1. That checkpoint
predates the committed nine-module include and threshold configuration, so it
records the source baseline rather than a reproducible threshold-exit snapshot.
JOR-227 adds public-behavior coverage for the share-link failure paths. The
final reconciled run passes all 897 tests and all four CQ-1 thresholds.

| Named core module | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `lib/access/identity.ts` | 95.59% | 75% | 100% | 95.59% |
| `lib/access/guard.ts` | 95.09% | 81.46% | 95% | 95.09% |
| `lib/imaging/studies.ts` | 100% | 75% | 100% | 100% |
| `lib/imaging/signing.ts` | 100% | 94.11% | 100% | 100% |
| `lib/reports/reports.ts` | 98.46% | 86.20% | 100% | 98.46% |
| `lib/scheduling/booking.ts` | 93.04% | 70.12% | 92.85% | 93.04% |
| `lib/scheduling/lifecycle.ts` | 100% | 100% | 100% | 100% |
| `lib/notify/reminders.ts` | 100% | 62.50% | 100% | 100% |
| `lib/share/links.ts` | 100% | 96.49% | 100% | 100% |
| **All named core logic** | **96.86%** | **81.78%** | **97.50%** | **96.86%** |

The allowlist itself excludes everything not named above. No coverage
`exclude` glob is used, so a named module cannot be silently subtracted after
inclusion. Thresholds for statements, branches, functions, and lines are each
80%; Vitest exits non-zero if any one falls short.

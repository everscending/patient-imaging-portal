# Core logic coverage

CQ-1 measures the authorization and scheduling decisions that can expose PHI or
change an appointment. The coverage allowlist in `vitest.config.ts` is the
contract: UI components, route handlers, configuration and database adapters,
seed and migration code, and test helpers are outside CQ-1 and are therefore
not added to the denominator.

Command: `npx vitest run --coverage --project unit --project integration`
Measured: 2026-08-20
Source commit: `9b72d73b210695317db75ac80ac9dda54834fe6f`

The initial measurement at `64db55fcec3da1f6561bbc266e01ea4867202528`
passed all 839 tests but correctly failed CQ-1 with 76.36% aggregate branch
coverage. JOR-227 adds public-behavior coverage for the share-link failure
paths. The final run passes all 856 tests and all four CQ-1 thresholds.

| Named core module | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `lib/access/identity.ts` | 95.59% | 72.54% | 100% | 95.59% |
| `lib/access/guard.ts` | 94.24% | 79.87% | 93.75% | 94.24% |
| `lib/imaging/studies.ts` | 100% | 69.56% | 100% | 100% |
| `lib/imaging/signing.ts` | 100% | 94.11% | 100% | 100% |
| `lib/reports/reports.ts` | 98.46% | 86.20% | 100% | 98.46% |
| `lib/scheduling/booking.ts` | 93.04% | 70.12% | 92.85% | 93.04% |
| `lib/scheduling/lifecycle.ts` | 100% | 100% | 100% | 100% |
| `lib/notify/reminders.ts` | 100% | 62.50% | 100% | 100% |
| `lib/share/links.ts` | 100% | 96.49% | 100% | 100% |
| **All named core logic** | **96.73%** | **80.67%** | **97.36%** | **96.73%** |

The allowlist itself excludes everything not named above. No coverage
`exclude` glob is used, so a named module cannot be silently subtracted after
inclusion. Thresholds for statements, branches, functions, and lines are each
80%; Vitest exits non-zero if any one falls short.

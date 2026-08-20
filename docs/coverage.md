# Core logic coverage

CQ-1 measures the authorization and scheduling decisions that can expose PHI or
change an appointment. The coverage allowlist in `vitest.config.ts` is the
contract: UI components, route handlers, configuration and database adapters,
seed and migration code, and test helpers are outside CQ-1 and are therefore
not added to the denominator.

Command: `npx vitest run --coverage --project unit --project integration`
Measured: 2026-08-20
Source commit: `8d64c60e46b7c4cd9a35d673ce6cde92acb79d39`

The initial measurement at `64db55fcec3da1f6561bbc266e01ea4867202528`
passed all 839 tests but correctly failed CQ-1 with 76.36% aggregate branch
coverage. JOR-227 adds public-behavior coverage for the share-link failure
paths. The final reconciled run passes all 875 tests and all four CQ-1
thresholds.

| Named core module | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `lib/access/identity.ts` | 95.59% | 75% | 100% | 95.59% |
| `lib/access/guard.ts` | 94.78% | 80.98% | 95% | 94.78% |
| `lib/imaging/studies.ts` | 100% | 75% | 100% | 100% |
| `lib/imaging/signing.ts` | 100% | 94.11% | 100% | 100% |
| `lib/reports/reports.ts` | 98.46% | 86.20% | 100% | 98.46% |
| `lib/scheduling/booking.ts` | 93.04% | 70.12% | 92.85% | 93.04% |
| `lib/scheduling/lifecycle.ts` | 100% | 100% | 100% | 100% |
| `lib/notify/reminders.ts` | 100% | 62.50% | 100% | 100% |
| `lib/share/links.ts` | 100% | 96.49% | 100% | 100% |
| **All named core logic** | **96.81%** | **81.65%** | **97.50%** | **96.81%** |

The allowlist itself excludes everything not named above. No coverage
`exclude` glob is used, so a named module cannot be silently subtracted after
inclusion. Thresholds for statements, branches, functions, and lines are each
80%; Vitest exits non-zero if any one falls short.

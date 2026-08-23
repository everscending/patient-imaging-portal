# ADR-0015 — The as-built database plane: executor-owned RPCs, the schedule view, and the reminder lease

- **Status:** Accepted
- **Date:** 2026-08-23
- **Requirements touched:** FR-11, FR-12, FR-13, FR-14, FR-15, EC-7, EC-9,
  EC-10, EC-11, SEC-2, SEC-4, SEC-6
- **Relation to other ADRs:** records as-built shape; amends the *mechanism*
  (never the semantics) of ARCHITECTURE §10 and §12; extends ADR-0014's
  transactional-audit pattern to booking

## Context

ARCHITECTURE.md §10 specified booking, reschedule, cancel and the lifecycle
transition as client-driven SQL transactions, and §12 specified reminder
idempotency as a bare `insert … on conflict do nothing`. The build could not
implement either literally: PostgREST exposes single statements and RPCs, not
multi-statement client transactions. The implementation therefore moved the
transactions into the database — and that architecture, though carrying every
pinned semantic, was never written into a document of record. A 2026-08-22
sync audit found eleven undocumented functions, one undocumented role, one
undocumented view, and §10 describing a mechanism the repo does not use.

This ADR is the record. The semantics of §10 (idempotency short-circuit,
row lock, same-key-different-slot refusal, ordered locking, the deferred
constraint for swaps) and §12 (structural idempotency, cadence < window) are
unchanged and remain pinned there.

## Decision

**1 · An uncallable executor role owns the scheduling transactions.**
`booking_executor` (`nologin nobypassrls`, migration 006) owns four
`SECURITY DEFINER` functions that *are* §10's transactions:

| Function | Migration | Writes its own audit row |
|----------|-----------|--------------------------|
| `book_appointment` | 006, audited wrapper **017** | `booking.create` — granted (create *and* EC-10 replay) or denied (refusal, targeting the contested slot) |
| `reschedule_appointment` | 007 | `booking.reschedule` granted |
| `cancel_appointment` | 007 | `booking.cancel` granted |
| `transition_appointment` | 008 | `appointment.transition` granted |

`lib/scheduling/booking.ts` calls them by RPC and holds no direct write on
`appointments` or `appointment_transitions` (revoked in 008). The caller's
JWT still drives RLS reads, each function re-verifies that the passed actor
matches the request's verified claim, and `slots_booking_lock` (a
`FOR UPDATE`-only policy with `WITH CHECK (false)`) lets the executor lock a
slot row without ever being able to update one.

Migration **017** exists because the first D2 fix wrote the granted row from
TypeScript after the RPC returned — through a writer that deliberately
swallows failures, the exact shape ADR-0014 rejected. The audited wrapper
(`book_appointment` wrapping the renamed `book_appointment_impl`) commits the
decision and its audit row atomically, aligning booking with its 007/008
siblings.

**2 · Five further narrow functions, one per seam.**
`link_patient_identity` (004 — FR-2's atomic attempt-plus-link),
`claim_reminder_send` (004 — see 4), `apply_provider_availability` (005 —
ADR-0014's first use), `read_report_detail` (011), `grant_study_access`
(012, `SECURITY INVOKER`, ADR-0003/0014). `regenerate_provider_slots` remains
(002) but is callable **only** through `apply_provider_availability` since
016 revoked its app-role execute (AUDIT.md #3).

**3 · The provider schedule reads patients through a definer-rights view.**
`provider_schedule_appointments` (migration 015, `security_barrier`):
providers can read `appointments` but not `patients`, so the schedule's
`patient_ref` column reads `patients` past RLS with the view's
`provider_id = current_provider_id() or is_admin()` predicate as the sole
guard. Recorded as a §16 known residue; any edit to the view predicate is a
security change.

**4 · Reminder idempotency is an insert-or-lease.** `claim_reminder_send`
adds a `retryable_at` lease to §12's structural PK: a crashed worker's claim
lapses and is reclaimed instead of stranding a `failed` row. Duplicates stay
impossible (the PK), and crash recovery improves — strictly stronger than the
documented `on conflict do nothing`.

## Consequences

- §4's grant block, §10's mechanism note, §12's lease note, §3's
  `login_attempts`/`retryable_at`/target-kind additions and §16's residues
  were updated alongside this ADR (sync-report tickets T7–T10).
- The `slot` audit target kind is pinned in §3: a denied booking has no
  appointment to reference; the contested slot is the honest target.
- The migration directory carries duplicate numeric prefixes (004/009/010
  pairs). Ordering is deterministic under the harness's full-filename sort;
  the tracked fix is an order-asserting guard test (T11), never renaming an
  applied migration — the 013/014 in-place-edit repairs are the cautionary
  record.
- §13's re-execution rule is satisfied by the committed database suites
  rather than a fresh manual pass: every mechanism this ADR records is
  exercised against a real Postgres by `tests/db/**`,
  `tests/scheduling/booking-concurrency.test.ts` and
  `tests/integration/**`, which gate every change.

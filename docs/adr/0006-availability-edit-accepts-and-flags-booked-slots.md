# ADR-0006 — An availability edit is accepted; a colliding appointment is preserved and flagged

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** EC-8, FR-10, FR-14, SEC-4, CQ-5

## Context

EC-8: a provider shrinks working hours, changes slot length, or blocks a range
that overlaps an appointment a patient has already booked. The PRD forbids
exactly one outcome — silently deleting or double-booking that appointment — and
explicitly permits two:

> The system either rejects the conflicting edit with a clear message, or accepts
> it while preserving and flagging the booked slot. Only genuinely free time is
> removed.

So this is a product decision, not a technical one, and it changes the FR-10
endpoint contract, the provider UI, and the EC-8 test.

## Decision

**Accept the edit. Remove only genuinely free time. Preserve every booked
appointment and flag it as sitting outside current availability.**

```
PATCH /api/providers/:providerId/availability
200 OK
{
  removedOpenSlots: 14,
  generatedOpenSlots: 22,
  preservedOutOfHours: [
    { appointmentId, startsAt, endsAt, patientRef }
  ]
}
```

`ARCHITECTURE.md` §6 is the pinned wire shape; this is a copy of it and must not
drift from it.

- Open slots inside the removed range are deleted.
- Slots holding an appointment are **not** deleted. The appointment keeps its
  start instant, its status, and its place in the FR-14 lifecycle.
- Each such appointment gets `out_of_hours = true`.
- The flag is set and cleared by the availability service alone — it is derived
  from the current availability, never edited by hand.
- Every preserved collision writes an audit event (SEC-4) naming the provider as
  actor and the appointment as target.

## Consequences

**Chosen over the cheaper option, with eyes open.** Rejecting the whole edit would
have been one code path, one test, and no new state. Accept-and-flag is more
forgiving to the provider and closer to how a clinic actually behaves — a
provider shortening next month's hours should not be blocked by one appointment
already on the books — and that is why it was chosen. The costs below are real
and accepted, not overlooked.

**A new appointment state every view must render.** `out_of_hours` appears in the
provider schedule, the patient's appointment list, and the admin view. Per CQ-5
it must be conveyed by more than colour alone — a label and an accessible
description, not a coloured border.

**The flag must be self-healing.** If the provider later restores the hours, the
appointment stops being out-of-hours. That means the flag is recomputed on every
availability write, not set once and left. A stale `out_of_hours = true` on an
appointment that is back inside working hours is a defect.

**Slots and appointments decouple.** A slot can exist outside current working
hours purely because it holds an appointment. Slot *generation* therefore reads
availability, but slot *deletion* reads availability **and** appointment
occupancy. FR-11's "only genuinely open, future slots" is unaffected: an
out-of-hours slot is occupied, so it is never open.

**EC-8's test asserts three things, not one:** the free time is gone, the booked
appointment survives with its start instant unchanged, and it is flagged. A test
asserting only survival would pass against a system that silently kept the slot
bookable.

**Reschedule interacts with the flag.** A patient rescheduling an out-of-hours
appointment moves to a genuinely open slot under the normal FR-13 rules, and the
flag clears with the move. The flag never blocks a reschedule or a cancel — it
is an annotation, not a lock.

## Alternatives considered

**Reject the whole edit, listing conflicts (409).** Atomic, one test, no new
state, no rendering work. Rejected as too rigid for the clinic behaviour being
modelled: a provider cannot adjust availability at all until every colliding
appointment is resolved by hand.

**Reject by default with a force-and-flag override.** Both behaviours, provider's
choice. The most defensible product answer and the most expensive — both other
options plus a confirmation flow, spent on the lowest-weighted rubric row.

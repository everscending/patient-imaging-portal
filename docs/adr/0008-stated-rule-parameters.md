# ADR-0008 — The five stated-rule parameters

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** FR-2, FR-5, FR-8, FR-13, FR-15, EC-1, EC-5, EC-9, SEC-8

## Context

`PRD.md` leaves five numbers open, each attached to a rule it says must be
*stated* and then enforced. A reviewer tests against the stated value, so each
one has to be fixed once, in a document of record, before any ticket is written
— otherwise whichever ticket runs first decides it, and the README, the tests
and the UI copy drift apart.

## Decision

| Parameter | Value | Governs |
|-----------|-------|---------|
| Share-link lifetime | **48 hours** | FR-5, FR-8, EC-5, SEC-8 |
| Minimum change notice | **24 hours** | FR-13 |
| Reminder lead time | **24 hours** before start | FR-15, EC-9, PF-8 |
| Identity-unlock lifetime | **45 minutes** | FR-2 |
| Failed-attempt lockout | **3 failures → 5-minute lock** | EC-1 |

These values are single-sourced in application config, surfaced in the README,
and quoted in the acceptance criteria of every ticket that enforces one. No
ticket hardcodes a duplicate.

## Rationale and consequences

**Share-link lifetime — 48 hours.** The PRD's range is 24–72 h. 48 h is long
enough for a referring provider to open the link on a following working day, and
short enough that expiry is demonstrable inside the DEL-6 video. It also bounds
the residual exposure ADR-0003 names: a signed storage URL cannot outlive its
own much shorter TTL, but the *link* is what a recipient holds, and 48 h is the
window a revocation has to beat.

**Minimum change notice — 24 hours.** The PRD's own worked example. Enforced
server-side, and enforced on both reschedule and cancel. Consequence for DEL-4:
the seed must contain at least one appointment **inside** the window and one
**outside** it, or the rule is not exercisable by a reviewer.

**Reminder lead time — 24 hours.** One reminder per appointment, one interval.
A single interval keeps EC-9's idempotency key trivially correct — one persisted
send record per `(appointment_id, interval)` with a unique constraint — and one
interval is all FR-15 asks for. The `pg_cron` job (ADR-0002) runs far more often
than the interval, and correctness comes from the unique constraint, never from
the schedule.

**Identity-unlock lifetime — 45 minutes.** Long enough that a patient can verify
once, then browse images, play a cine clip, read a report and share it without
being challenged mid-flow. Short enough to be a real second factor. Note the
interaction with SEC-8: a share link created during an unlock outlives that
unlock by design — the link's own 48 h expiry and revocation are what bound it,
not the unlock.

**Failed-attempt lockout — 3 failures, 5-minute lock.** Stricter on attempts than
a typical login lockout, and deliberately so: FR-2 is an identity-matching gate
protecting PHI, and an attacker guessing a date of birth against a known patient
reference has a small search space. The short 5-minute lock keeps a genuine
patient who mistyped from being stranded, and keeps the rule demonstrable live
in the DEL-6 video.

Two consequences of that choice matter to implementation:

- **Counting is per patient reference and per source, not per session.** Counting
  per session would let a caller clear cookies to reset the counter, which makes
  the lockout decorative.
- **The lockout response is the same generic error as a mismatch** — with no hint
  that a lock is in effect and no field-level detail. Saying "locked" confirms
  the patient reference exists, which is the leak EC-1 exists to prevent.

## Alternatives considered

Longer locks (15–30 minutes) with a higher threshold (5 failures) were the
initial proposal. Rejected in favour of the tighter threshold: on a PHI gate the
cost of a false lockout is a five-minute wait, while the cost of a permissive
threshold is a wider guessing window on a small search space.

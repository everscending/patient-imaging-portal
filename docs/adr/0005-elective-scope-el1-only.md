# ADR-0005 — Build EL-1 only; cut every other elective

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** EL-1 (selected), EL-2, EL-3, EL-4, EL-5 (cut), AI-1 (moot)

## Context

`PRD.md` lists five stretch items. The rubric treats exactly one of them as
scoring: **EL-1, fast image/cine delivery**, worth up to **+5 bonus points on top
of the base 100**, and awarded *only* if every Priority 1 core acceptance
criterion already passes. EL-2 through EL-5 carry no explicit points; they
"improve the qualitative read of the relevant rows".

The pass mark is ≥70 of the base 100. The timebox is three days.

## Decision

**Build EL-1. Cut EL-2, EL-3, EL-4 and EL-5.**

Because EL-5 is cut, **AI-1** — the natural-language booking golden set, the ≥80%
threshold, and the scorecard harness — does not apply to this build. `AI_USAGE.md`
(DEL-1) still ships, and states plainly that no runtime AI is used.

## Consequences

**EL-1 is gated, not free.** The bonus cannot be earned at the expense of core, so
EL-1 work is sequenced *after* FR-3 and FR-4 pass their own acceptance criteria,
and no EL-1 change may regress one. Its deliverable is not just speed: a
committed before/after benchmark (k6 and/or browser timing) plus a short note on
the techniques used. Without both artifacts the points are not awarded, so both
are acceptance criteria, not documentation chores.

**ADR-0003 already did most of the work.** Keeping bytes off the function path and
on the storage CDN is what gives EL-1 anywhere to go — thumbnail-first ordering,
prefetch and priority hints, per-frame fetch scheduling, cache headers. EL-1 is
an optimisation layer on an architecture that already permits it, not a
re-architecture.

**What the cuts buy.** Each cut removes correctness surface, not just work:

- **EL-2 (waitlist + auto-fill)** would write to the same rows FR-12's
  concurrency guard protects. It is the elective most able to destabilise a core
  requirement.
- **EL-3 (recurring appointments)** multiplies every EC-6 time-zone and DST case
  across a series of dates.
- **EL-4 (insurance/intake capture)** is PHI by the PRD's own statement, so every
  field added would also have to satisfy SEC-2, SEC-4, SEC-5 and SEC-6.
- **EL-5 (natural-language booking)** drags in AI-1's whole apparatus, and the
  PRD states plainly that no AI is required to pass.

**A cut elective must not be built.** No ticket may revive one, and their absence
is never a build failure. If every Core requirement lands early, the correct use
of the remaining time is CUT-5 (PWA install) or polish on the Priority 1 and
Priority 2 rows — not an unscored elective.

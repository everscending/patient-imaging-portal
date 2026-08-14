# ADR-0009 — The seed uses a shared synthetic asset pool at full row counts

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** DEL-4, DEL-5, GAP-1, GAP-2, CUT-3, FR-6, FR-9, PF-1, PF-2, PF-3, PF-5, CQ-6

## Context

DEL-4 specifies the seeded dataset: roughly 50 patients, each with 1–5 completed
visits, each visit holding 1–10 static images and 0–2 cine clips of up to 100
frames, plus 10 providers and about 16,000 appointment slots.

Taken literally that is up to **~50,000 frames**. At even 25 KB per frame it is
about **1.25 GB** — over the 1 GB free ceiling of the storage chosen in ADR-0002,
while CUT-3 forbids paying for more. The PRD's own dataset does not fit the free
tier the PRD also mandates. That is GAP-2, and it is arithmetic, not preference.

GAP-1 compounds it: no image assets were supplied at all, so whatever is stored
has to be generated.

## Decision

**Generate a small pool of distinct synthetic assets once. Every study references
pool assets by storage key. Keep every row count exactly at DEL-4's numbers.**

```
asset pool (generated, deterministic from a fixed seed)
  8 cine sets × 100 frames        ≈ 20 MB
  40 still images                 ≈  2 MB
                                  ────────
                                    ~22 MB of 1 GB

rows (unchanged from DEL-4)
  50 patients · 10 providers
  ~150 studies · ~250 cine clips · ~700 images
  ~16,000 appointment slots
```

- Storage keys stay random UUIDs (ADR-0003). A pool asset referenced by two
  studies is reached through two different clip rows with independent ownership,
  so sharing bytes never shares *access*.
- Frame generation is deterministic from a fixed seed, so a clean checkout
  reproduces byte-identical assets — which is what CQ-6 means by "reproducible
  from a clean checkout".
- The pool includes **one deliberately broken clip**: a manifest referencing a
  missing frame, so EC-2's graceful-degradation path is exercisable by a
  reviewer without hand-editing data.
- The seed also plants the fixtures other stated rules need: an appointment
  inside the 24 h notice window and one outside it (ADR-0008), at least one
  Preliminary report that must stay invisible (FR-7), at least one
  out-of-hours appointment (ADR-0006), and at least one appointment in each of
  `requested`, `confirmed`, `completed`, `cancelled` and `no_show`, so the FR-14
  lifecycle and the terminal-state trigger are both exercisable.
- **Services are seeded before appointments.** `appointments.service_id` is
  `NOT NULL`, so the seed populates `services` (obstetric, renal, thyroid — the
  study descriptions it already generates) and `provider_services` first, gives
  every provider at least one service, and gives every appointment a service its
  provider actually offers. A seed that skips this cannot insert a single
  appointment.
- **The notice-window fixtures are both live.** The appointment inside the 24 h
  window and the one outside it are each `confirmed` — a cancelled or completed
  appointment cannot exercise FR-13's rule, so a seed that leaves their status
  unstated can satisfy the letter of this list and still make the rule
  untestable.
- **The out-of-hours fixture is produced by driving the real edit, never by
  writing the flag.** `out_of_hours` is derived and recomputed on every
  availability write (ADR-0006, `CONTEXT.md`); a seed that sets it directly
  contradicts both and produces a value the first availability edit will clear.
  So the seed books an appointment, then narrows the provider's working hours
  through `lib/scheduling/availability.ts`, and lets the service set the flag.
  That also means the seed exercises the EC-8 path on every run.
- **Every seeded patient is linked to an account or is deliberately unlinked.**
  The demo accounts are linked directly so a grader can log straight in. At least
  one seeded patient is left with a null `user_id` and no account, so the
  registration-then-verify path (`ARCHITECTURE.md` §4) has something real to bind
  to — that flow is the one whose failure is silent, and it cannot be tested
  against a dataset where every patient is pre-linked.

## Consequences

**The tests that matter see the dataset the PRD specified.** Row counts are what
FR-6's and FR-9's ID-enumeration attacks search through, and what PF-5's
slot-availability query scans. Deduplicating *bytes* leaves both untouched.

**The performance numbers stay honest.** Each request still transfers a full
100-frame clip from the CDN, so PF-1, PF-2 and PF-3 measure real transfer volume.
The only thing shared is what sits at rest in a storage bucket.

**One caveat, stated in the README.** CDN and browser caching can be *warmer*
across patients than in production, because two patients' clips may resolve to
the same underlying object. Benchmarks are therefore run with distinct pool
assets per virtual user where the k6 script can arrange it, and the README says
so rather than letting a reviewer discover it.

**Storage headroom for EL-1.** Using ~22 MB of 1 GB leaves room for the
thumbnail and derivative variants EL-1 will generate (ADR-0005), which a
byte-unique dataset would not have had.

**Seeding is fast.** DEL-5 asks a reviewer to install, seed and run "in minutes".
Generating 22 MB is seconds; generating 1.25 GB is not.

## Alternatives considered

**Unique frames per study, patient count scaled down to fit.** Most realistic
bytes. Rejected because it shrinks the row counts — roughly 12 patients and
~4,000 slots — and the row counts are precisely what FR-6's ID-space test and
PF-5's query are measuring. It weakens what a grader checks in order to
strengthen something no grader checks.

**Two seed profiles: a small default and a full-scale benchmark mode.** Honest and
flexible. Rejected as two datasets to keep correct, with every acceptance
criterion then obliged to name which profile it was verified against — a
persistent ambiguity in exchange for realism the shared pool already delivers at
the request level.

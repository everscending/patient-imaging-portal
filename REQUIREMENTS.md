# Requirements — Patient Imaging, Reports & Scheduling Portal

Stable identifiers for every requirement in `PRD.md`. Nothing downstream (ADRs,
`ARCHITECTURE.md`, the UX spec, epics, tickets, gates) may cite PRD prose
directly — cite an ID from this file.

The PRD is frozen. Changes to it go through `/loom replan`, which diffs the
amended PRD against this file.

Status vocabulary:

- **Core** — must ship. Failing it fails the build.
- **Elective** — in the PRD as stretch/optional. Selected or cut in
  §Electives; a cut elective must not be built.
- **GAP** — an input the PRD assumes exists that has not arrived. Each carries
  a written contingency so no ticket blocks on it.

---

## Functional requirements (Core)

### Foundation

| ID | Requirement | Acceptance criterion |
|----|-------------|----------------------|
| **FR-1** | Patient registration & authentication | A new patient can register, log in, **and manage a basic profile**. Passwords are hashed, never stored in plaintext. Sessions expire. An unauthenticated request to any patient resource is rejected. |

### Priority 1 — Image access & secure sharing (primary focus)

| ID | Requirement | Acceptance criterion |
|----|-------------|----------------------|
| **FR-2** | Patient identity verification | Before any image **or report** unlocks, the patient enters a pre-existing Patient/Account ID plus date of birth that must match a seeded record. A correct match unlocks that patient's own studies and reports only. An incorrect match returns one generic error that never reveals which field was wrong. Repeated failed attempts are rate-limited or locked. |
| **FR-3** | View my images | A patient sees only images tied to their own verified identity and to completed (not future, not cancelled) visits. Images render with basic zoom and pan. |
| **FR-4** | Cine (multi-frame) playback | A cine clip is a JSON manifest referencing up to 100 sequentially ordered frame image files. The viewer provides play/pause, next/previous frame, and an FPS control. A 100-frame clip plays back with no visible dropped frames at its default rate (**e.g.** 10–15 FPS — the PRD's illustration; what is required is that the rate is *stated* in the README). |
| **FR-5** | Share an image via secure link | Generating a link sends it by email via Resend (required). The sharer can revoke an active link from their portal. The link expires after a stated window (**e.g.** 24–72 h — the PRD's illustration; what is required is that the window is *stated*). See §Stated parameters. Once expired or revoked it returns a clear "no longer available" response and never the image. |
| **FR-6** | No cross-patient image access | An automated test attempts access to another patient's image by guessing/incrementing IDs and by reusing an expired or foreign share link. Every attempt is rejected server-side and logged. Graded with the rigor of a security vulnerability. |

### Priority 2 — Report & document delivery

| ID | Requirement | Acceptance criterion |
|----|-------------|----------------------|
| **FR-7** | View my reports/documents | Only signed/finalized reports tied to the patient's FR-2 verified identity are visible. A Preliminary report is never shown to the patient. The report renders in-browser with correct formatting. |
| **FR-8** | Share a report via secure link | Identical rules to FR-5: email required via Resend, time-limited, revocable, audited. |
| **FR-9** | No cross-patient report access | The same adversarial automated test as FR-6, applied to report IDs and report share links. |

### Priority 3 — Scheduling (fully required, secondary weighting)

| ID | Requirement | Acceptance criterion |
|----|-------------|----------------------|
| **FR-10** | Provider availability management | A provider sets working hours, a slot length, and blocks a specific range. The generated open-slot list reflects all three. Blocked and past times never appear as bookable. |
| **FR-11** | Slot discovery & booking | The patient sees only genuinely open, future slots for the selected provider/service. Booking one creates a persisted appointment, returns a confirmation, and immediately removes that slot from the open list. |
| **FR-12** | No double-booking under concurrency | Under concurrent booking attempts on the last open slot, exactly one succeeds and the others receive a clear "slot no longer available" error. Enforced at the database level (transactional row lock or unique constraint), verified by an automated concurrent test committed to the repo. |
| **FR-13** | Reschedule & cancel | A patient can move an appointment to another open slot (freeing the old slot atomically) or cancel it. A stated minimum-notice rule is enforced server-side. The freed slot becomes bookable again. |
| **FR-14** | Appointment status lifecycle | An appointment transitions requested → confirmed → completed / cancelled / no-show. Only valid transitions are allowed, transitions are role-appropriate, and each change is recorded in the audit log (SEC-4). |
| **FR-15** | Automated email reminders | A scheduled job dispatches an email reminder a stated interval before the appointment via Resend. Dispatch is idempotent (no duplicate reminders) and every delivery attempt is logged. |

---

## Edge cases & failure modes (Core)

Each is an observable expectation a reviewer can trigger. A happy-path-only
submission visibly fails here.

| ID | Edge case | Expectation |
|----|-----------|-------------|
| **EC-1** | Identity-verification mismatch | An incorrect ID/DOB pair is rejected without revealing which field failed and without partial-match hints. Repeated failures rate-limit or lock the attempt. Refines FR-2. |
| **EC-2** | Corrupted or partial cine manifest | A manifest referencing a missing or corrupted frame file degrades gracefully — available frames shown with a clear gap indicator — and never crashes the viewer. Refines FR-4. |
| **EC-3** | Slow-network progressive load | On a throttled connection a thumbnail or first frame appears quickly with a clear loading state. The UI never freezes waiting on a full multi-frame download. |
| **EC-4** | Small-viewport / touch rendering | The image viewer, cine scrubber, and share controls are fully usable at phone width — tap targets, no horizontal-scroll clipping. An orientation change does not break playback state. |
| **EC-5** | Expired or revoked share-link reuse | A previously valid link, once expired or revoked, returns a clear "no longer available" message and never serves cached image or report content. Refines FR-5 and FR-8. |
| **EC-6** | Time zones & DST | With patient and provider in different zones, every slot displays unambiguously in each viewer's local zone and the stored appointment resolves to a single correct instant. A slot spanning a DST transition is generated and totalled correctly — no duplicated, skipped, or off-by-one-hour slots. Times are persisted in UTC or with an explicit zone, never as naive local strings. |
| **EC-7** | Concurrent booking on the last open slot | Two simultaneous bookings on the final slot resolve to exactly one confirmed appointment; the loser gets a clear "slot no longer available" response. References FR-12, does not replace it. |
| **EC-8** | Availability edit collides with a booked slot | A booked appointment is protected when a provider shrinks hours, changes slot length, or blocks an overlapping range — never silently deleted or double-booked. The system either rejects the conflicting edit with a clear message, or accepts it while preserving and flagging the booked slot. Only genuinely free time is removed. |
| **EC-9** | Reminder idempotency | The reminder job is safe to run repeatedly and to overlap with itself without ever sending a second reminder for the same appointment/interval — enforced by a persisted per-appointment send record, not by timing luck. Refines FR-15. |
| **EC-10** | Double-submit of a booking | A double-clicked or retried booking request creates at most one appointment for that slot, deduplicated server-side (idempotency key or unique constraint), not merely by disabling the button client-side. |
| **EC-11** | Cancel / no-show transition rules | A cancelled appointment cannot later be marked completed. No-show applies only to a confirmed appointment whose start time has passed. Cancelling frees the slot atomically. Invalid transitions are rejected server-side with a clear error, not silently ignored. Refines FR-14. |
| **EC-12** | Graceful degradation & input validation | A failing primary dependency (database, email provider, blob storage, optional LLM) degrades gracefully with a clear user-facing message and a structured server-side error log — never an unhandled 500 or a silently wrong result. **All external input — booking, availability, image/report access, sharing, and auth payloads — is validated and sanitized server-side**; malformed, oversized, or out-of-range requests are rejected with clear errors. First-run empty state (no images yet, no appointments yet) renders cleanly rather than erroring. |

---

## Performance benchmarks (Core)

Stated load: **20–50 concurrent virtual users for 60 s**, generated with **k6**
(script committed), against the benchmark dataset below.

### Benchmark dataset

The PRD offers this shape as an **illustration** (`e.g.`) of a dataset large
enough to make the numbers meaningful — roughly 50 patients with 1–5 completed
visits each, each visit holding 1–10 static images and 0–2 cine clips of up to
100 frames, plus 10 providers and ~16,000 appointment slots.

It is a **measurement** need, not a deliverable: DEL-4 requires a seed script,
not these exact counts. It is recorded here so the PF rows are reproducible and
so the benchmark scale is not mistaken for a grading threshold. GAP-2 and
ADR-0009 explain how this scale fits the mandated free tier.

| ID | Target | Value | Measurement method |
|----|--------|-------|--------------------|
| **PF-1** | Single image load | < 1.0 s p95 | k6 at stated load against the seeded dataset; report p95 |
| **PF-2** | Cine time-to-first-frame (100-frame clip) | < 1.0 s p95 | k6 against the seeded dataset; report p95 |
| **PF-3** | Cine fully loaded & smoothly playable (100-frame clip) | < 5.0 s p95 | k6 run plus a client playback check for dropped frames |
| **PF-4** | Share-link generation | < 1.0 s p95 | Server log timing from request to link issued |
| **PF-5** | Slot-availability query | < 1.0 s p95 | k6 at stated load against the seeded dataset; report p95 |
| **PF-6** | Booking action | < 1.0 s p95 | Server log timing from request to persisted confirmation, 20+ runs |
| **PF-7** | No double-booking under concurrency | 1 success / N−1 rejected | Automated concurrent test: N simultaneous bookings on the last open slot; assert exactly one confirmed appointment |
| **PF-8** | Reminder dispatch reliability | ≥ 99% of due reminders sent, 0 duplicates | Reminder job logs across the eval window |
| **PF-9** | Uptime (deployed demo) | ≥ 99% over the eval window | Uptime check across the review period |

---

## Security, privacy & compliance (Core)

This domain handles **Protected Health Information (PHI)**: patient identity,
ultrasound images and cine clips, finalized reports, and appointments with
named providers. PHI handling is first-class, not an add-on.

| ID | Requirement | Acceptance criterion |
|----|-------------|----------------------|
| **SEC-1** | HIPAA / PHI awareness | The README states which data is PHI and how the design protects it. A demonstration of awareness and sound practice, not a claim of certified compliance. |
| **SEC-2** | Server-side role-based access control | Three roles — patient, provider, admin — enforced on the server, never trusting the client. A patient sees only their own appointments, images, cine clips, and reports. A provider sees only their own schedule and their own patients' data. Admin access is scoped and logged. Authorization is checked on every PHI endpoint, including image/report retrieval and share-link issuance. |
| **SEC-3** | Encryption | TLS/HTTPS in transit. Encryption at rest for the database, blob storage, and any stored PHI. |
| **SEC-4** | Audit log of PHI access & booking changes | Every PHI read (image view, report view, share-link generation, share-link use) and every booking or status change is recorded with actor, action, target, and timestamp. The log is append-only and reviewable. |
| **SEC-5** | Data minimization & retention/deletion | Only the fields a flow needs are collected. A stated retention and deletion policy covers images, cine clips, and reports as well as appointment and intake data. Patients can request deletion of their data. |
| **SEC-6** | No PHI in logs | Application and server logs contain no PHI — no names, DOB, contact details, image content, or health context. Identifiers and references are logged instead. |
| **SEC-7** | Secure authentication | Hashed passwords (bcrypt or argon2, never plaintext), session expiry, and protection against common auth attacks. Secrets live in environment variables only, never committed and never logged. A committed `.env.example` documents every required variable with placeholder values only. |
| **SEC-8** | Share links are not a compliance loophole | A share link is time-limited, revocable, and audited — never a permanent, unauthenticated PHI exposure. |
| **SEC-9** | BAA awareness | The README discloses which third-party vendors would require a Business Associate Agreement for real-world use, explicitly including whichever blob storage vendor holds the mock image and cine files. PHI is kept out of reminder and share message bodies where possible — a generic notice plus a secure link. |

---

## Code quality & engineering practices (Core)

| ID | Requirement | Acceptance criterion |
|----|-------------|----------------------|
| **CQ-1** | Test coverage ≥ 80% on core logic | Measured over identity verification, image/cine/report access control, the booking engine and its concurrency guard, reschedule/cancel rules, status-lifecycle transitions, and reminder and share-link scheduling. |
| **CQ-2** | Concurrency & leakage correctness are tested | The no-double-booking guard (FR-12) and the no-cross-patient-access guards (FR-6, FR-9) each have an explicit automated adversarial or concurrent test, not just a happy-path test. |
| **CQ-3** | Error handling & observability | Clear, non-500 responses for booking conflicts, invalid status transitions, failed identity matches, and reminder/share-send failures **— and a failed send is retried or queued, not merely reported**. No unhandled 500s in the demo flow. Structured error logging with no PHI, plus a health-check endpoint reporting app, database, and storage reachability. |
| **CQ-4** | Responsive / mobile-first UI | Every patient-facing flow — identity verification, image and cine viewing, report viewing, sharing, booking — is fully usable at a typical phone-width viewport, not just desktop. |
| **CQ-5** | Accessibility | Baseline WCAG-aware practice: full keyboard navigation, labeled form controls and slot/cine buttons, sufficient colour contrast, and appointment/report status conveyed by more than colour alone. |
| **CQ-6** | Database migrations | Schema — including the unique constraints and indexes backing the no-double-book and identity-verification guarantees — is managed via committed migrations, reproducible from a clean checkout with a seed script. |
| **CQ-7** | Secure coding for PHI | No secrets in the repo. No PHI in logs. Input validation on all booking, availability, image, report, and share endpoints. Server-side authorization on every PHI route. |
| **CQ-8** | CI | Per-change product validation runs TypeScript, the linter, every unit test, the PostgreSQL integration suite, ordinary product Playwright tests, and the serial E2 wiring proof on every push and pull request through the cumulative `ui` gate. E2 runs after the parallel product project to isolate its shared audit fixture. The E0/E1 fresh-clone proofs remain CI obligations, but run independently on `main`, nightly, or manually as repository certification so the product gate never recursively launches itself. |

---

## Delivery & documentation (Core)

| ID | Requirement | Acceptance criterion |
|----|-------------|----------------------|
| **DEL-1** | Public repository with README and `AI_USAGE.md` | Both committed. `AI_USAGE.md` documents which AI tools were used and for what, which LLM/engine and versions were used for any runtime AI, and any prompts or configuration that materially shaped the solution. States clearly if no runtime AI was used. |
| **DEL-2** | Deployed application URL | A reachable deployed demo, meeting PF-9. |
| **DEL-3** | Documentation | Setup, environment variables, seed script, retention/deletion policy, and roles are all documented. |
| **DEL-4** | Committed `.env.example` and seed script | A committed seed script / sample dataset: patients with linked images, cine clips and reports; ≈10 providers, the services they offer, and their slots; demo patient, provider and admin accounts. It also plants the fixtures the stated rules need — see ADR-0009. The app runs and is gradeable from a clean checkout. **The larger row counts in §Benchmark dataset are a performance-measurement need, not a submission requirement.** |
| **DEL-5** | Grader quick-start in the README | A reviewer can install, configure from `.env.example`, seed, run the app, and run the committed test suite — including the concurrency test and the leakage test — in minutes, with demo credentials listed. |
| **DEL-6** | Video demo | Shows, in this order: patient identity verification and image/cine viewing; secure image/report sharing; report viewing; provider availability setup; patient booking; the no-double-book behaviour; reschedule/cancel; a reminder being sent or received. Also shows the app at phone width at least once. |

---

## Electives

PRD stretch items. Selection is a phase-1 decision — see `docs/adr/`. An
elective that is **cut** must not be built; a cut elective's absence is never a
build failure.

Selection closed by **ADR-0005**.

| ID | PRD item | Rubric value | Status |
|----|----------|--------------|--------|
| **EL-1** | Fast image/cine delivery — thumbnail-first progressive loading, prefetch/priority hints, per-frame streaming, caching. Requires a committed before/after benchmark (k6 and/or browser timing) plus a short note on techniques. | **Up to +5 bonus** — the only stretch item carrying explicit points, and only if every Priority 1 core criterion passes | **SELECTED** — sequenced after FR-3 and FR-4 pass; may not regress any Core criterion. Both the benchmark and the techniques note are acceptance criteria, not documentation. |
| **EL-2** | Waitlist + auto-fill on cancellation | No explicit points | **CUT** — writes to the rows FR-12's concurrency guard protects |
| **EL-3** | Recurring appointments | No explicit points | **CUT** — multiplies every EC-6 time-zone and DST case across a series |
| **EL-4** | Insurance / intake field capture (treated as PHI) | No explicit points | **CUT** — every field added would also owe SEC-2, SEC-4, SEC-5, SEC-6 |
| **EL-5** | Natural-language booking (optional AI) — carries AI-1 if selected | No explicit points | **CUT** — drags in AI-1's whole apparatus; the PRD states no AI is required to pass |

| ID | Requirement | Applies only if | Acceptance criterion |
|----|-------------|-----------------|----------------------|
| **AI-1** | Natural-language booking eval harness | EL-5 selected | A committed harness runs a golden set of ~15 labeled utterance → intended-slot/intent pairs (including ambiguous and out-of-scope inputs) and prints a per-utterance pass/fail scorecard. Threshold ≥ 80% correct slot/intent, with graceful fallback on ambiguity — ask a clarifying question or show candidate slots, never silently book the wrong slot. Model/engine version and hardware recorded in the README. Utterances are synthetic, never real patient data. |

There is **no required AI accuracy threshold** in this brief. AI-1 exists only
as a consequence of EL-5, and **EL-5 is cut — so AI-1 does not apply to this
build**. `AI_USAGE.md` (DEL-1) still ships and states plainly that no runtime AI
is used.

---

## GAPs

Inputs the PRD assumes that have not arrived. Each has a contingency, so no
ticket may block on one.

| ID | Missing input | Contingency |
|----|---------------|-------------|
| **GAP-1** | Mock ultrasound image and cine frame assets. The PRD calls the imagery "mock" but supplies none, and DEL-4's seeded dataset needs roughly 50 patients × 1–5 visits × (1–10 images + 0–2 cine clips × up to 100 frames). | **Closed by ADR-0009.** The seed generates synthetic frames deterministically from a fixed source seed, so a clean checkout reproduces byte-identical assets. A real asset pack, if it ever arrives, drops into the same storage layout without a schema change. |
| **GAP-2** | Free-tier blob storage ceiling (Supabase Storage free = 1 GB). DEL-4's dataset taken literally is ~50,000 frames ≈ 1.25 GB — it does not fit the free tier CUT-3 mandates. | **Closed by ADR-0009.** A shared synthetic asset pool (~22 MB) is referenced by all studies; **every row count stays exactly at DEL-4's numbers**, so FR-6, FR-9 and PF-5 see the specified dataset. Only bytes at rest are deduplicated; per-request transfer volume is unchanged. |
| **GAP-3** | Resend API key, and the sending domain or verified sender address for FR-5, FR-8, FR-15. Resend's free tier restricts unverified senders. | `.env.example` documents the variables. Email dispatch goes through one adapter with a **log-only fallback** so every flow is exercisable and testable without a live key; the deployed demo uses a real key. |
| **GAP-4** | Hosting accounts and the deployed URL for DEL-2 and PF-9 (backend host, frontend host, database, blob storage). | Deployment is its own epic with its own tickets. Until it lands, acceptance runs against a local stack. Nothing in the imaging, report, or scheduling epics may depend on a deployed URL. |
| **GAP-5** | The eval window for PF-8 and PF-9 (reminder reliability and uptime) is defined by the reviewer, not by this build. | Both are measured by committed, runnable checks whose output is reported for whatever window the build itself covers. The README states the window measured. |

---

## Stated parameters

Fixed by **ADR-0008**, single-sourced in application config, and quoted in the
acceptance criteria of every ticket that enforces one. No ticket may hardcode a
duplicate or pick its own value.

The three timing values below are ones the PRD leaves open but requires to be
*stated* and then enforced.

**There is deliberately no identity-unlock lifetime.** An earlier draft carried
one (45 minutes, ADR-0004/ADR-0008). The PRD never asks the FR-2 match to expire,
so **ADR-0011 removed the expiring unlock entirely**: verification links the
account to the patient record once, and nothing re-locks. FR-2 is still a gate
in front of the first unlock, and EC-1's lockout is unchanged.

| Parameter | Value | Governs |
|-----------|-------|---------|
| Share-link lifetime | **48 hours** | FR-5, FR-8, EC-5, SEC-8 |
| Minimum change notice | **24 hours** | FR-13 |
| Reminder lead time | **24 hours** before start | FR-15, EC-9, PF-8 |
| Failed-attempt lockout | **3 failures → 5-minute lock**, counted per patient reference and per source | EC-1 |

---

## Cuts

Explicitly out of scope. Named here so no ticket revives them.

| ID | Cut | Reason |
|----|-----|--------|
| **CUT-1** | Native mobile application | PRD: "A separate native mobile app is **not** required." Responsive web at phone width (CQ-4) is the requirement. |
| **CUT-2** | SMS delivery for shares and reminders (Twilio) | PRD: optional, not required, and paid. Email alone satisfies FR-5, FR-8, FR-15. |
| **CUT-3** | Any paid API or paid tier | PRD: "No paid API is required. 100% free-tier." |
| **CUT-4** | Certified HIPAA compliance, executed BAAs | PRD scopes SEC-1 and SEC-9 to *awareness and disclosure*, not certification. |
| **CUT-5** | PWA install / web-app manifest | PRD: "a welcome nice-to-have, not required." Revisit only if every Core item is done. |

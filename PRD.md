# Patient Imaging, Reports & Scheduling Portal

## Difficulty & Timebox
**Tier:** Mid–Senior · **Timebox:** 3 days · **Format:** take-home assessment
**Target industry:** Healthcare — Diagnostic Ultrasound / Medical Imaging

*(3 days is justified by the combined scope of secure, patient-matched image and cine
delivery with sharing (Priority 1), signed-report delivery with sharing (Priority 2),
and a correctness-critical scheduling engine (Priority 3) — no cross-patient data
leakage, no double-booking under concurrency — all under first-class PHI handling.)*

## Problem Statement
Patients who undergo an ultrasound exam need fast, secure, self-service access to their
own images — including cine (multi-frame) clips — and their finalized report, and they
often need to share either with a referring provider, a specialist, or a family member.
Today that handoff is slow and manual (a burned CD, a fax, a phone call to the front
desk), and any mix-up that exposes one patient's images or report to another patient is
a severe trust and compliance failure — far more costly than a scheduling
inefficiency. This portal makes image, cine, and report access instant and provably
patient-safe. It also includes scheduling — patients book, reschedule, and cancel
ultrasound visits, and providers manage their availability — but scheduling is the
**secondary** focus of this build; imaging and report delivery are the primary focus.

Target users: a **patient** who needs quick, secure access to (and sharing of) their own
ultrasound images and report, and — secondarily — the ability to book/manage visits; a
**provider** (and their front-desk **admin**) who manages availability and reviews
access/audit logs, and who never wants their patients' data crossed with anyone else's.

## Business Context
In ultrasound/OB-GYN practices, patients routinely need their images or report in
someone else's hands quickly — a specialist, a referring OB, an insurer, or themselves.
Manual handoff (CD, fax, phone) is slow and staff-intensive, and every cross-patient
data exposure risks a HIPAA incident and loss of trust that no amount of scheduling
efficiency can offset. A self-service portal that gets patients their own images, cine
clips, and signed report instantly — and lets them share it via a secure, time-limited
link — removes that bottleneck and that risk at the same time. Scheduling remains
valuable (less phone tag, fewer no-shows) and is fully required in this brief, but it is
the supporting feature here, not the centerpiece.

## Illustrative Business Case / Impact Metrics
*Illustrative — assumptions stated inline; validate against real clinic analytics.*
Assume a **clinic of 10 providers** completing **~50 ultrasound studies/week each**,
i.e. **~500 studies/week ≈ 25,000 studies/year** (50 working weeks).
- **Support-call deflection (image/report access):** if **30%** of patients currently
  call the office asking for a copy of their images/report — **~150 calls/week** at
  **5 min each** — self-service portal access eliminates most of that: **~12.5 hrs/week
  ≈ 625 hrs/year**; at an illustrative **$25/hr** loaded cost, **~$15,600/year**.
- **Referral/share turnaround:** a secure share link cuts image/report handoff to a
  referring specialist from **1–3 days** (CD burn / fax / mail) to **minutes** — a
  clinical-quality driver more than a cost line, but a real one.
- **No-show reduction (scheduling, secondary):** lower the no-show rate from an assumed
  baseline of **20%** to **12%** via automated reminders — smaller in scope than the
  imaging/report metrics above, since scheduling is the secondary focus here, but still
  fully required and measured the same way as any correctness-critical feature.
- **Booking responsiveness (product guardrail, secondary):** slot-availability and
  booking actions **< 1 s p95** — see Performance Benchmarks.

## Tech Stack
Concrete free-tier defaults; substitution allowed if justified and benchmarks met.
**No paid API is required. 100% free-tier.**
- **Backend (candidate choice, pick one):** **C# (ASP.NET Core Web API)** *or*
  **Node/Express** — both free and open source.
- **Frontend:** **React / Next.js (TypeScript)**, built responsive/mobile-first — one
  codebase that works well on a phone browser and on desktop. A separate native mobile
  app is **not** required. Making it **PWA-installable** (web-app manifest +
  home-screen install) is a welcome nice-to-have, not required.
- **Database + Auth + Storage:** **Supabase** (free — Postgres + Auth + **Storage**
  bundled, S3-compatible; its 1GB free file storage is enough for mock image/cine
  frames) *or* **Neon** (free Postgres) paired with whichever blob storage comes free
  with your frontend host — **Vercel Blob** or **Netlify Blobs** (see Cloud Platforms).
  Postgres holds image/cine/report **metadata and storage references only** — never raw
  binary frames in the database. Transactional row-locking remains central to the
  no-double-booking requirement.
- **Cloud Platforms:** **Render** or **Railway** (backend hosting, free tier) — note:
  neither offers S3-style object storage, only block disks/volumes, so don't store
  images there — + **Vercel** or **Netlify** (frontend hosting, free tier; both offer
  their own free blob storage product if you didn't pick Supabase Storage).
- **Email:** **Resend free tier** (required) — powers both reminders and secure
  image/report share links.
- **SMS:** **optional**, **not required**, via a paid provider such as **Twilio** 💲 for
  reminders or shares — email alone satisfies both requirements.
- **AI / LLM (optional only):** used **only** if the candidate builds the optional
  natural-language booking stretch feature. **Groq free tier**, **Google Gemini free
  tier**, or **Ollama (local)** — pick one; **no paid API required.** No AI is required
  to pass this brief (see AI Metrics & Test Method).
- **Development Tools:** Git, Docker (optional), a unit test framework matching your
  backend (**xUnit**/**NUnit** for C#, **Jest**/**Mocha**/**Vitest** for Node),
  **Playwright** (added — integration/E2E testing option), and **k6** for load testing.

## Functional Requirements
Each Core item has an observable acceptance criterion (pass/fail). Core is grouped into
three priority tiers reflecting where effort and correctness should concentrate:
**Priority 1 (image access & sharing)** and **Priority 2 (report/document delivery)**
are the primary focus of this assessment; **Priority 3 (scheduling)** is fully required
but secondary — see Evaluation Rubric for how that's weighted. The optional
natural-language feature's golden set and threshold are defined in **AI Metrics & Test
Method**.

### Core (must-have)

**Foundation**
1. **Patient registration & authentication** — patients sign up, log in, and manage a
   basic profile.
   *Accept:* a new patient can register and log in; passwords are hashed (never stored
   in plaintext); sessions expire; an unauthenticated request to any patient resource
   is rejected.

**Priority 1 — Image Access & Secure Sharing (primary focus)**
2. **Patient identity verification** — before any images **or reports** unlock, the
   patient enters a pre-existing Patient/Account ID plus date of birth that must match
   a seeded record.
   *Accept:* a correct ID+DOB match unlocks that patient's own studies **and reports**
   only; an
   incorrect match returns one generic error that never reveals which field was wrong;
   repeated failed attempts are rate-limited/locked (mirrors real second-factor
   patient-matching used in production imaging portals).
3. **View my images** — a patient views static images from their own completed
   ultrasound visits.
   *Accept:* a patient sees only images tied to their own verified identity and to
   completed (not future/cancelled) visits; images render with basic zoom/pan.
4. **Cine (multi-frame) playback** — a patient plays back mock ultrasound cine clips.
   *Accept:* a cine clip is a JSON manifest referencing up to **100** sequentially
   ordered frame image files; the viewer provides play/pause, next/previous frame, and
   an FPS control; a 100-frame clip plays back smoothly (no visible dropped frames) at
   its default playback rate (e.g. **10–15 FPS**, stated in the README).
5. **Share an image via secure link** — a patient shares one of their images via a
   time-limited, unguessable link.
   *Accept:* generating a link sends it by **email** (Resend — required); **SMS** via
   Twilio is optional and not required; the sharer can **revoke** an active link from
   their portal; the link expires after a stated window (e.g. 24–72 h) and, once
   expired or revoked, returns a clear "no longer available" response — never the
   image.
6. **No cross-patient image access (critical correctness test)** — a patient, or a
   share link, can never expose another patient's images.
   *Accept:* an automated test attempts access to another patient's image by
   guessing/incrementing IDs and by reusing an expired/foreign share link; every attempt
   is rejected server-side and logged. This is graded with the same rigor as a security
   vulnerability, not a minor bug — see Evaluation Rubric.

**Priority 2 — Report & Document Delivery**
7. **View my reports/documents** — a patient views their own finalized reports.
   *Accept:* only **signed/finalized** reports tied to the patient's verified identity
   (Core #2) are visible; a Preliminary report is never shown to the patient; the
   report renders in-browser with correct formatting.
8. **Share a report via secure link** — same mechanism as image sharing.
   *Accept:* identical rules to Core #5 (email required via Resend, SMS optional via
   Twilio, time-limited and revocable link).
9. **No cross-patient report access (critical correctness test)** — same rigor as
   Core #6, applied to reports.
   *Accept:* the same adversarial automated test as Core #6, applied to report
   IDs/links.

**Priority 3 — Scheduling (supporting feature, fully required)**
10. **Provider availability management** — a provider defines working hours, slot
    length, and blocked/unavailable times.
    *Accept:* a provider sets working hours (e.g. Mon–Fri 09:00–17:00), a slot length
    (e.g. 30 min), and blocks a specific range; the generated open-slot list reflects
    all three, and blocked/past times never appear as bookable.
11. **Slot discovery & booking** — a patient views open slots for a chosen
    provider/service and books one.
    *Accept:* the patient sees only genuinely open, future slots for the selected
    provider/service; booking one creates a persisted appointment, returns a
    confirmation, and immediately removes that slot from the open list.
12. **No double-booking under concurrency** — the same slot cannot be booked by two
    patients.
    *Accept:* under a **concurrent booking attempt on the last open slot**, **exactly
    one** succeeds and the other receives a clear "slot no longer available" error.
    This must hold under DB-level concurrency (transactional row lock / unique
    constraint), verified by an automated concurrent test committed to the repo.
    Still required and still correctness-critical — just weighted as Priority 3 in the
    rubric.
13. **Reschedule & cancel** — a patient reschedules or cancels an appointment under
    stated rules/notice.
    *Accept:* a patient can move an appointment to another open slot (freeing the old
    slot atomically) or cancel it; a stated minimum-notice rule (e.g. no changes
    < 24 h before start) is enforced server-side, and the freed slot becomes bookable
    again.
14. **Appointment status lifecycle** — appointments move through a defined status set.
    *Accept:* an appointment transitions **requested → confirmed → completed /
    cancelled / no-show**; only valid transitions are allowed, transitions are
    role-appropriate, and each change is recorded (see audit log).
15. **Automated email reminders** — patients receive a reminder before the appointment.
    *Accept:* a scheduled job dispatches an email reminder a stated interval before the
    appointment via Resend; dispatch is idempotent (no duplicate reminders) and
    delivery/attempt is logged.

### Stretch (bonus)
16. **Fast image/cine delivery (flagship stretch — the highest-value bonus item)** —
    thumbnail-first progressive loading, prefetch/priority hints, per-frame streaming,
    and caching so images — and especially a 100-frame mock cine clip — load as fast
    as possible. Viewing already works under Core #3/#4; this is purely a speed
    optimization on top of it, and it must never come at the expense of any Core
    acceptance criterion. This is the **only stretch item that carries explicit rubric
    points** (up to **+5 bonus** — see Evaluation Rubric): it is deliberately
    open-ended. **Show your work** — commit a
    before/after benchmark (k6 and/or browser timing) demonstrating the improvement
    and a short note explaining the techniques chosen.
17. **Waitlist + auto-fill on cancellation** — patients join a waitlist for a full
    provider/day; when a slot frees, the next waitlisted patient is offered/booked in.
18. **Recurring appointments** — book a repeating series (e.g. a serial-monitoring OB
    ultrasound schedule, weekly/biweekly across a trimester).
19. **Insurance / intake field capture** — structured intake and insurance fields
    collected at booking (treated as PHI — see Security, Privacy & Compliance).
20. **Natural-language booking (optional AI)** — a patient types "book me next Tuesday
    afternoon" and the system proposes the matching slot; graceful fallback on
    ambiguity.

### Edge Cases & Failure Modes
The solution **must** handle the following; each is an observable expectation a
reviewer can trigger, and a happy-path-only submission should visibly fail here.
1. **Identity-verification mismatch.** An incorrect ID/DOB pair is rejected without
   revealing which field failed and without partial-match hints; repeated failures
   rate-limit or lock the attempt.
2. **Corrupted or partial cine manifest.** A cine manifest referencing a missing or
   corrupted frame file degrades gracefully — shows the available frames with a clear
   gap indicator — and never crashes the viewer.
3. **Slow-network progressive load.** On a throttled connection, a thumbnail or first
   frame appears quickly with a clear loading state; the UI never freezes waiting on a
   full multi-frame download.
4. **Small-viewport / touch rendering.** The image viewer, cine scrubber, and share
   controls are fully usable (tap targets, no horizontal-scroll clipping) on a typical
   phone-width viewport; an orientation change doesn't break playback state.
5. **Expired or revoked share-link reuse.** A previously valid share link, once expired
   or revoked, returns a clear "no longer available" message and never serves cached
   image/report content.
6. **Time zones & DST across the two sides.** When patient and provider are in
   different time zones, every slot displays unambiguously in each viewer's local zone
   and the stored appointment resolves to a single correct instant. A slot spanning a
   DST transition is generated and totalled correctly — no duplicated, skipped, or
   off-by-one-hour slots. Times are persisted in UTC (or with an explicit zone), never
   as naive local strings.
7. **Concurrent booking on the last open slot.** Two simultaneous bookings on the final
   slot resolve to **exactly one** confirmed appointment; the loser gets a clear "slot
   no longer available" response — see Core #12, which this edge case references and
   does not replace.
8. **Provider edits availability that collides with an already-booked slot.** A booked
   appointment is **protected** when a provider shrinks hours, changes slot length, or
   blocks an overlapping range — never silently deleted or double-booked. The system
   either rejects the conflicting edit with a clear message, or accepts it while
   preserving and flagging the booked slot. Only genuinely free time is removed.
9. **Reminder idempotency.** The reminder job is safe to run repeatedly and to overlap
   with itself without ever sending a second reminder for the same appointment/interval
   — enforced by a persisted per-appointment send record, not by timing luck.
10. **Double-submit of a booking.** A double-clicked "book" (or a retried request)
    creates **at most one** appointment for that slot — deduplicated server-side (e.g.
    idempotency key / unique constraint), not merely by disabling the button
    client-side.
11. **Cancel / no-show transition rules.** A **cancelled** appointment cannot later be
    marked **completed**; **no-show** applies only to a **confirmed** appointment whose
    start time has passed; cancelling frees the slot atomically. Invalid transitions
    are rejected server-side with a clear error, not silently ignored.
12. **Graceful degradation & input validation.** The primary dependency failing
    (database, email/reminder provider, blob storage, or the optional LLM) degrades
    gracefully with a clear user-facing message and a structured server-side error log
    — never an unhandled 500 or a silently wrong result. All external input (booking,
    availability, image/report access, sharing, and auth payloads) is validated and
    sanitized **server-side**; malformed/oversized/out-of-range requests are rejected
    with clear errors; first-run/empty state (no images yet, no appointments yet)
    renders cleanly rather than erroring.

## Performance Benchmarks
Load is defined explicitly so results are comparable across candidates.
**Stated load:** **20–50 concurrent virtual users** for 60 s, generated with **k6**
(script committed to the repo), against a **seeded dataset** — e.g. **~50 patients**,
each with 1–5 completed visits, each visit holding 1–10 static images and 0–2 cine
clips (up to 100 frames each); plus **10 providers**, **~16,000 appointment slots**.

| Target | Value | Measurement method |
|--------|-------|--------------------|
| Single image load | < 1.0 s p95 | k6 run at the stated load against the seeded dataset; report p95 |
| Cine time-to-first-frame (100-frame clip) | < 1.0 s p95 | k6 run against the seeded dataset; report p95 |
| Cine fully loaded & smoothly playable (100-frame clip) | < 5.0 s p95 (core ceiling — Stretch #16 rewards going well beyond it) | k6 run + client playback check for dropped frames |
| Share-link generation | < 1.0 s p95 | Server log timing from request to link issued |
| Slot-availability query | < 1.0 s p95 | k6 run at the stated load against the seeded dataset; report p95 |
| Booking action | < 1.0 s p95 | Server log timing from request to persisted confirmation, 20+ runs |
| No double-booking under concurrency | 1 success / N−1 rejected | Automated concurrent test: N simultaneous bookings on the last open slot; assert exactly one confirmed appointment |
| Reminder dispatch reliability | ≥ 99% of due reminders sent, 0 duplicates | Reminder job logs across the eval window |
| Uptime (deployed demo) | ≥ 99% over the eval window | Uptime check (e.g. cron ping) across the review period |

## AI Metrics & Test Method
**AI is optional in this brief and is primarily used for code generation**, not for a
required core accuracy metric — the core product is a correctness-critical imaging,
reporting, and booking system, not an AI model. There is **no required AI accuracy
threshold** to pass.

**Only if** the candidate builds the optional **natural-language booking** stretch
feature, apply a **lightweight golden set**:
- **Golden set:** **~15 labeled utterance → intended-slot/intent pairs** (e.g. "next
  Tuesday afternoon", "earliest with Dr. Lee", "cancel my Friday visit", plus a few
  ambiguous/out-of-scope inputs).
- **Threshold:** **≥ 80% correct slot/intent** on the set, with a **graceful fallback
  on ambiguity** (ask a clarifying question or show candidate slots — never silently
  book the wrong slot).
- **Method:** a committed harness (e.g. `dotnet run --project tools/ai-eval` /
  `npm run ai:eval`) runs the set
  and prints a per-utterance pass/fail scorecard; model/engine version and hardware are
  recorded in the README. Utterances must be synthetic — never real patient data.

## Security, Privacy & Compliance
This domain handles **Protected Health Information (PHI)**: patient identity,
ultrasound images and cine clips, finalized reports, appointments with named providers,
and (in stretch) intake/insurance data. PHI handling is **first-class**, not an add-on,
and the design should demonstrate **HIPAA awareness**.
- **HIPAA / PHI awareness:** treat images, cine clips, reports, and appointment/patient
  data as PHI; the README must state which data is PHI and how the design protects it.
  This is a demonstration of awareness and sound practice, not a claim of certified
  compliance.
- **Role-based access control (server-side):** three roles — **patient / provider /
  admin** — enforced on the server (never trust the client). A **patient sees only
  their own appointments, images, cine clips, and reports**; a **provider sees only
  their own schedule and their own patients' data**; admin access is scoped and logged.
  Authorization is checked on every PHI endpoint, including image/report retrieval and
  share-link issuance (row-level ownership, e.g. Postgres RLS or explicit server-side
  checks).
- **Encryption:** **TLS/HTTPS in transit**; **encryption at rest** for the database,
  blob storage, and any stored PHI.
- **Audit log of PHI access & booking changes:** every PHI read (image view, report
  view, share-link generation/use) and every booking/status change is recorded with
  **actor, action, target, and timestamp**; the log is append-only and reviewable.
- **Data minimization & retention/deletion:** collect only the fields the flow needs;
  a stated **retention and deletion policy** covering images/cine/reports as well as
  appointment/intake data; patients can request deletion of their data.
- **No PHI in logs:** application/server logs must not contain PHI (names, DOB, contact
  details, image content, health context); log identifiers/references instead.
- **Secure authentication:** hashed passwords (bcrypt/argon2 — never plaintext),
  session expiry, and protection against common auth attacks; secrets in env vars only,
  **never committed and never logged**. A committed **`.env.example`** documents every
  required variable (with placeholder values only).
- **Share links are not a compliance loophole:** a share link must be time-limited,
  revocable, and audited — never a permanent, unauthenticated PHI exposure.
- **Business Associate Agreement (BAA):** any third-party service that stores or
  processes PHI (hosting, database, blob storage, email/SMS handling PHI content)
  requires a **BAA** for real-world use — this now explicitly includes whichever blob
  storage vendor (Supabase Storage / Vercel Blob / Netlify Blobs) holds the mock
  images/cine files. Keep PHI out of reminder/share message bodies where possible (send
  a generic notice + secure link) to limit third-party PHI exposure, and disclose which
  vendors would need a BAA.

## Code Quality & Engineering Practices
- **Test coverage ≥ 80%** on core logic (identity verification, image/cine/report
  access control, the booking engine and its concurrency guard, reschedule/cancel
  rules, status-lifecycle transitions, reminder and share-link scheduling).
- **Concurrency & leakage correctness are tested:** the no-double-booking guard and the
  no-cross-patient-access guard (images and reports) each have an explicit automated
  adversarial/concurrent test, not just a happy-path test.
- **Error handling & observability:** clear, non-500 responses for booking conflicts,
  invalid status transitions, failed identity matches, and reminder/share-send failures
  (retry/queue); no unhandled 500s in the demo flow. **Structured error logging** (no
  PHI) and a **health-check endpoint** (e.g. `GET /health`) reporting app, database, and
  storage reachability.
- **Responsive/mobile-first UI:** every patient-facing flow (identity verification,
  image/cine viewing, report viewing, sharing, and booking) is fully usable on a
  typical phone-width viewport, not just desktop — this is graded as part of code
  quality, not treated as a separate native-app requirement.
- **Accessibility (patient & provider UI):** baseline WCAG-aware practice — full
  keyboard navigation, labeled form controls and slot/cine buttons, sufficient colour
  contrast, and appointment/report status conveyed by more than colour alone.
- **Database migrations:** schema (including unique constraints/indexes backing the
  no-double-book and identity-verification guarantees) managed via committed
  migrations; reproducible from a clean checkout with a seed script.
- **Secure coding for PHI:** no secrets in the repo; no PHI in logs; input validation
  on all booking/availability/image/report/share endpoints; server-side authorization
  on every PHI route.
- **CI:** runs unit tests + linter on every push; **Playwright** integration/E2E tests
  (if used) run in CI as well; README documents setup, env vars, the seed script, and
  how to run the concurrency, leakage, and (optional) AI eval harnesses.

## AI Usage Disclosure
**Required.** Document, in `AI_USAGE.md`: which AI tools were used and for what
(primarily code generation; and, if built, the optional natural-language booking
feature), which LLM/engine and versions were used for any runtime AI, and any prompts
or configuration that materially shaped the solution. State clearly if no runtime AI
was used.

## Submission Requirements
- GitHub repository (with README + `AI_USAGE.md`)
- Deployed application URL
- Documentation (setup, env vars, seed script, retention/deletion policy, roles)
- **Committed `.env.example`** and a **committed seed script / sample dataset**
  (patients with linked images/cine clips/reports, ≈10 providers and their slots, demo
  patient + provider/admin accounts) so the app runs and is gradeable from a clean
  checkout.
- **Grader quick-start in the README:** a reviewer can install, configure from
  `.env.example`, seed, run the app, and run the committed test suite (incl. the
  concurrency test, the leakage test, and, if built, the AI eval harness) **in
  minutes**, with any demo credentials listed.
- Video demo showing, **in this order**: **patient identity verification and
  image/cine viewing**, **secure image/report sharing**, **report viewing**,
  **provider availability setup**, **patient booking**, the **no-double-book
  behavior**, **reschedule/cancel**, and a **reminder** being sent/received. Also show
  the app on a phone-width viewport at least once.

## Evaluation Rubric (100 pts + up to 5 bonus; pass ≥ 70)
| Criterion | Weight | Adequate → Excellent |
|-----------|:------:|----------------------|
| Image access, cine playback & secure sharing (Priority 1) | 25 | Basic image display only → full cine playback + secure share links + provably no cross-patient leakage under adversarial ID/link testing, incl. the imaging edge cases (corrupt manifest, slow network, small viewport) |
| Report/document viewing & secure sharing (Priority 2) | 15 | Reports visible but unstyled/no sharing → clean viewer, correct signed-only visibility, secure sharing, no cross-patient leakage |
| Foundation & scheduling flows incl. no-double-booking (Priority 3) | 10 | 1–2 flows work → all flows flawless (register/auth, availability, book, reschedule/cancel, lifecycle, reminders) incl. concurrency-safe booking and the scheduling edge cases (time zones/DST, collisions, idempotency, double-submit) |
| Security, privacy & compliance (PHI across appointments, images & reports) | 20 | Basic auth → server-side RBAC, audit log, encryption, retention/deletion, BAA awareness, no PHI in logs |
| Code quality & architecture (incl. responsive/mobile usability) | 15 | Works but coupled → clean services, migrations/constraints, ≥80% coverage, CI, solid mobile UX |
| Performance (image/cine + booking benchmarks) | 10 | Sluggish/stale → all p95 targets met under stated load, incl. the 100-frame cine case |
| Docs, AI disclosure & demo | 5 | Sparse → clear README, policies documented, crisp demo of all required moments in priority order |

**Stretch bonus (up to +5 pts, on top of the 100):** awarded **only** for Stretch #16
(**fast image/cine delivery**), and **only if every Priority 1 core acceptance
criterion passes** — the bonus can never substitute for, or be earned at the expense
of, core functionality. Full bonus requires a committed **before/after benchmark**
showing a measured improvement over the core performance targets (especially the
100-frame cine case) plus a short write-up of the techniques used. Other stretch items
improve the qualitative read of the relevant rows but carry no explicit points. The
pass mark stays **≥ 70 of the base 100**.

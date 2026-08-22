# Patient Imaging Portal

A patient imaging, reports, and scheduling portal, built against `PRD.md`,
`REQUIREMENTS.md`, and `ARCHITECTURE.md`. This file is the grader-facing entry
point. The full documentation set — policies, architecture decision records,
deployment record, and quality evidence — is indexed at
[`docs/README.md`](docs/README.md).

## Grader quick start

Requirements: Node 22, Docker, and network access for `npm ci`.

```bash
git clone <this repository's URL>
cd patient-imaging-portal
npm ci
cp .env.example .env
```

`lib/config.ts` requires four connection variables before the app or its
committed suites can run: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
`SOURCE_REF_SALT`. The commands below supply real values for those without a
hosted Supabase account, using the credential-free local runtime documented at
[`docs/local-del4-runtime.md`](docs/local-del4-runtime.md). It starts a local
Supabase stack (Postgres, Auth, Storage), applies every migration, and seeds
the deterministic demo dataset — patients, providers, cine clips, reports,
appointments, and the three demo accounts below.

```bash
bash scripts/local-del4-runtime.sh start
```

Run the app on that stack (the launcher reads `.env` itself and otherwise
defaults to the configured port):

```bash
PORT=45308 bash scripts/local-del4-runtime.sh run node scripts/run-next.mjs dev
```

Open the printed address and sign in with a demo account below.

Run the committed test suites. Each gate tier is cumulative — `api` repeats
every `logic` check, and `ui` repeats every `api` check
(`ARCHITECTURE.md` §15):

```bash
bash scripts/local-del4-runtime.sh run npm run gate:logic

# Includes the FR-12 no-double-booking concurrency test
# (tests/scheduling/booking-concurrency.test.ts) and the FR-6/FR-9
# cross-patient leakage test (tests/adversarial/cross-patient.test.ts).
bash scripts/local-del4-runtime.sh run npm run gate:api

npx playwright install --with-deps chromium
bash scripts/local-del4-runtime.sh run npm run gate:ui
```

Stop the local stack afterward with `bash scripts/local-del4-runtime.sh stop`.

### Demo accounts

Seeded once by `db/seed/rows.ts` — no other login exists in the seeded data.

| Role | Email | Password |
| --- | --- | --- |
| Patient | `patient@demo.pip.test` | `DemoPass!2026` |
| Provider | `provider@demo.pip.test` | `DemoPass!2026` |
| Admin | `admin@demo.pip.test` | `DemoPass!2026` |

## Roles

- **Patient** — reaches only their own appointments, images, cine clips, and
  reports, behind identity verification (below).
- **Provider** — reaches only their own schedule and their own patients' data.
- **Admin** — front-desk staff. Access is scoped, and every access is logged.

## Identity verification

A correct match of patient reference and date of birth links the signed-in
account to a patient record once, permanently (**ADR-0011**). There is no
expiring unlock: a linked account is never asked again, and the only
verification parameter left to configure is the failed-attempt limit in the
stated parameters below.

## PHI statement

This application handles Protected Health Information (PHI): patient
identity, images, cine clips, frames, reports, and appointments tied to named
providers. What follows is a demonstration of PHI-aware design and
engineering practice — not a claim of regulatory certification, and no
Business Associate Agreement is in place for this deployment.

Protections in place:

- **Row-level security** on every PHI table, layered behind the application's
  own ownership checks — defense in depth, never a substitute for either
  layer.
- **A single access guard** (`lib/access/guard.ts`) that every PHI route
  calls: it checks the session, the identity link, ownership, and writes the
  audit row, in one call.
- **A denied cross-patient or cross-provider request returns 404, never
  403** — a 403 would confirm the resource exists, which is itself a leak.
- **Short-lived signed URLs** for image and cine bytes, minted only after the
  guard above passes.
- **An append-only audit log** of every PHI read and every booking or status
  change, recording actor, action, target, and timestamp.
- **No PHI in application or server logs** — identifiers and references are
  logged instead of names, dates of birth, contact details, or health
  context.

## Business Associate Agreement (BAA) disclosure

For real-world use with real patient data, these third-party vendors would
need a signed Business Associate Agreement:

- **Supabase** — Postgres (data), **Storage** (images, cine clips, and
  frames), and Auth (accounts and sessions).
- **Vercel** — application host.
- **Resend** — outbound email for share-link notices and appointment
  reminders.

## Retention and deletion

Full policy: [`docs/retention-and-deletion.md`](docs/retention-and-deletion.md).
In summary: images, cine clips, frames, reports, appointments, appointment
transitions, and audit events are kept seven years; identity attempts, 90
days; share links, one year past expiry or revocation. A patient can submit a
deletion request from `/profile`. The request records intent only — a
privacy administrator verifies the requester and checks legal holds and
retention duties before anything is removed or minimized, and audit events
are never deleted by a deletion request.

## Environment variables

Every variable `lib/config.ts` reads, with its default. `.env.example`
carries placeholder values only — a real value is never committed.

| Variable | Default |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | *(required, no default)* |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | *(required, no default)* |
| `SUPABASE_SERVICE_ROLE_KEY` | *(required, no default — server only)* |
| `SOURCE_REF_SALT` | *(required, no default)* |
| `NEXT_PUBLIC_PRACTICE_NAME` | Patient Imaging Portal |
| `APP_BASE_URL` | http://localhost:4310 |
| `RESEND_API_KEY` | *(unset — email transport falls back to logging)* |
| `RESEND_FROM` | *(unset)* |
| `EMAIL_TRANSPORT` | resend |
| `EMAIL_OUTBOX_MAX_ATTEMPTS` | 5 |
| `EMAIL_SEND_TIMEOUT_MS` | 10000 |
| `CRON_SECRET` | *(unset — required in deployed environments)* |
| `SHARE_LINK_TTL_HOURS` | 48 |
| `MIN_CHANGE_NOTICE_HOURS` | 24 |
| `REMINDER_LEAD_HOURS` | 24 |
| `IDENTITY_MAX_ATTEMPTS` | 3 |
| `IDENTITY_LOCKOUT_MINUTES` | 5 |
| `SIGNED_URL_TTL_SECONDS` | 300 |
| `SLOT_HORIZON_DAYS` | 60 |
| `MAX_REQUEST_BODY_BYTES` | 65536 |
| `REMINDER_WINDOW_MINUTES` | 30 |
| `REMINDER_CRON_MINUTES` | 5 |
| `SEED_SOURCE_SEED` | patient-imaging-portal |
| `PORT` | 4310 |
| `TEST_PG_PORT` | *(unset — the OS assigns a free port and the test harness reads it back)* |

One value lives outside this table: sessions expire after a 60-minute
inactivity window, a Supabase Auth project setting rather than an application
variable. `docs/deploy.md` records where it is set.

## Stated parameters (ADR-0008)

Fixed once, in `lib/config.ts`, and enforced server-side. No ticket picks its
own number.

| Rule | Config key | Environment variable | Default |
| --- | --- | --- | --- |
| Share-link lifetime | `shareLinkTtlHours` | `SHARE_LINK_TTL_HOURS` | 48 |
| Minimum change notice for reschedule/cancel | `minChangeNoticeHours` | `MIN_CHANGE_NOTICE_HOURS` | 24 |
| Reminder lead time before an appointment | `reminderLeadHours` | `REMINDER_LEAD_HOURS` | 24 |
| Failed identity-verification attempts before lockout | `identityMaxAttempts` | `IDENTITY_MAX_ATTEMPTS` | 3 |
| Lockout duration once that limit is reached | `identityLockoutMinutes` | `IDENTITY_LOCKOUT_MINUTES` | 5 |
| Signed image/cine URL lifetime, in seconds | `signedUrlTtlSeconds` | `SIGNED_URL_TTL_SECONDS` | 300 |

Identity verification carries no lifetime parameter of its own: **ADR-0011**
made the link between an account and a patient record permanent once it
succeeds. That is this build's own reading of FR-2, not an obligation stated
in the PRD — there is no expiring unlock, and no re-verification for a
returning, linked patient.

Cine clips default to a 12 frame-per-second playback rate
(`db/seed/rows.ts`, FR-4). The share-link lifetime above is the same window
FR-5 requires be stated.

## PF-8 and PF-9 windows (GAP-5)

The eval window for reminder reliability and uptime is defined by the
reviewer, not by this build (**GAP-5**). What follows is what this build's
own committed, runnable checks have covered so far.

**PF-8 — reminder dispatch reliability.** Measured window: 2026-08-17
14:47:06.809 UTC to 2026-08-17 14:47:08.163 UTC (`tests/artifacts/e8-run.json`,
JOR-207). 10 due reminders, 10 sent, 0 duplicates, 0 failed — every due
reminder delivered exactly once across that window.

**PF-9 — deployed-demo uptime.** Not yet measured: no uptime check has run
against the deployed demo. The uptime window will be measured starting at
build promotion (JOR-252) and recorded here with its start and end once that
happens. **[pending — JOR-252]**

## Performance

Full conditions, methodology, and every measured value:
[`docs/performance-baseline.md`](docs/performance-baseline.md) and
[`docs/el1-benchmark.md`](docs/el1-benchmark.md). Every figure below is
quoted from one of those two files.

- **PF-1 single image** — accepted as an exceedance at the pre-elective
  baseline (1130.00 ms p95); met after EL-1 (859.05 ms to 934.80 ms p95
  across the two after-runs, confirmed at 870.55 ms and 913.09 ms p95 by the
  E11 confirming run).
- **PF-2 cine first frame** — met throughout (649.25 ms to 783.35 ms p95
  across all measured runs).
- **PF-3 cine fully loaded** — straddles its target across four runs
  (4657.00 ms to 5105.30 ms p95 against a 5.0 s target) and is **accepted as
  final** (`docs/performance-baseline.md`, JOR-235) — not re-chased, and no
  threshold was changed to reach that disposition. The patient-visible wait
  is covered by the poster (roughly 650 ms to 710 ms) and the bounded
  read-ahead window (roughly 1.2 s to 1.5 s p95); PF-3 as defined measures
  the whole clip, not what a patient waits for.
- **PF-4 share creation** — met (708.88 ms to 745.60 ms p95, read only from
  PHI-free server timing lines, never from k6 request duration).
- **PF-5 open-slot query** — met (346.25 ms to 351.38 ms p95).
- **PF-6 booking action** — met (559.31 ms to 576.90 ms p95, read only from
  PHI-free server timing lines).

## Known residues

Stated here rather than discovered later (`ARCHITECTURE.md` §16):

1. **Signed URLs outlive revocation** by up to the signed-URL lifetime stated
   above — bounded by that short TTL.
2. **Audit granularity is the access grant**, not the byte range: one audit
   row per authorized PHI request, not one per downloaded frame.
3. **Shared pool assets warm caches more than a production corpus would.**
   The seed deliberately references a small shared asset pool across many
   records (`ADR-0009`); benchmarks use distinct assets per virtual user
   where the load script can arrange it.
4. **Password hashing is delegated to Supabase Auth** and is not implemented
   or reviewable in this repository (`ADR-0004`).

## Vocabulary

This build uses one fixed vocabulary across code, tests, and interface copy —
the full reference, including its "words we avoid" table, is
[`CONTEXT.md`](CONTEXT.md). A few terms that matter for reading the rest of
this file: a share link is **signed**, never finalized, and is **revoked**,
never cancelled or deleted; a multi-frame recording is a **cine clip**, never
a video; a **visit** (the clinical event) is not the same thing as a
**study** (its images); and this domain's data is **PHI**, never PII.

## Deployed URL

**[pending — see [`docs/deploy.md`](docs/deploy.md) for the current record]**

## Documentation

- [`docs/README.md`](docs/README.md) — the full documentation index:
  policies, architecture decision records, deployment record, and quality
  evidence.
- [`ARCHITECTURE.md`](ARCHITECTURE.md), [`REQUIREMENTS.md`](REQUIREMENTS.md),
  [`CONTEXT.md`](CONTEXT.md), [`PRD.md`](PRD.md).
- [`AI_USAGE.md`](AI_USAGE.md) — which AI tools built this repository, and
  for what.

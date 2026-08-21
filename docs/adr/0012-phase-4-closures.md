# ADR-0012 — The twenty-two closures that writing the tickets forced

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** FR-1, FR-2, FR-5, FR-8, FR-10, FR-15, EC-1, EC-9,
  EC-12, SEC-2, SEC-4, SEC-5, SEC-6, SEC-9, CQ-3, CQ-8, DEL-3, DEL-5, PF-8

## Context

Phase 4 drafted all 73 ticket bodies before publishing any of them. Writing a
body is what turns a document's vague sentence into a decision: 22 questions
surfaced that no document of record closed, each one found by a ticket that
could not be finished without an answer. Left open, each is a place where two
lanes build incompatible things and neither can tell.

They were answered on one review surface (`.lavish/phase4-tickets.html`). This
ADR is the record; the individual documents carry the change.

## Decisions

| # | Question | Answer |
|---|----------|--------|
| 1 | Where profile fields live before FR-2 links the account | The profile form reads and writes **account** metadata. `patients` stays clinic-of-record and the patient never edits it. |
| 2 | How a list endpoint calls the access guard | `PhiTarget` gains a **collection** member. One audit row per list read, `target_id` null. |
| 3 | Who writes audit events that are not PHI reads | The **domain module that owns the action**, through `lib/audit/events.ts`. The guard keeps the PHI-read actions. ADR-0014 adds the narrow exception for a database transaction that must commit its mutation and audit rows together. |
| 4 | How an availability edit removes open slots with no DELETE grant | A `SECURITY DEFINER` function, `regenerate_provider_slots`. The app role still holds no DELETE. |
| 5 | How far ahead slots are generated | `SLOT_HORIZON_DAYS`, default **60**. |
| 6 | The stated session lifetime | **60 minutes of inactivity**, stated on `/login` and `/register`. |
| 7 | What counts as an oversized body | `MAX_REQUEST_BODY_BYTES`, default **65536** (64 KiB). |
| 8 | The patient reference format | **`PT-` plus four digits**, in sequence. The unexplained no-sequence rule is withdrawn from `CONTEXT.md`; EC-1's lockout is what guards it. |
| 9 | Demo credentials | `patient@demo.pip.test`, `provider@demo.pip.test`, `admin@demo.pip.test`, password `DemoPass!2026`. |
| 10 | Email copy, and the log transport's PHI problem | Copy pinned in `UX_SPEC.md` §4.15. The log transport writes the full message to a gitignored `.local/mail/<id>.json`; the application log line carries a message id and the recipient's **domain** only. |
| 11 | Empty-state and error copy | Pinned in `UX_SPEC.md` §4.16, in §4.3's voice. |
| 12 | Does `POST /api/shares` return the link | **Yes** — `url` added to the 201 body. |
| 13 | The shared-image payload | One entry of `GET /api/studies/:studyId`'s `images` array. |
| 14 | What may be shared | **One image, or one report** — as the PRD words it. Cine clips and whole studies stay out of scope. |
| 15 | Where auth payloads are validated | New `POST /api/auth/register` and `POST /api/auth/login`; the browser never calls the auth provider directly. |
| 16 | The reminder window and cadence | `REMINDER_WINDOW_MINUTES` 30 and `REMINDER_CRON_MINUTES` 5, with startup refusing a cadence ≥ the window. |
| 17 | The pre-send reminder outcome | **`failed`**, updated to `sent` with `sent_at` on success. |
| 18 | Where a failed email waits | An **`email_outbox`** table, drained by the same 5-minute job. |
| 19 | How a deletion request is recorded | A **`deletion_requests`** table, `202 { "status": "received" }`, and a new `profile.deletion_request` audit action. |
| 20 | What `identity_attempts.source_ref` holds | **sha256(`SOURCE_REF_SALT` + client IP)**. No raw address stored. |
| 21 | What the `docs` gate tier runs | **The tier is removed.** Document-only tickets take the `logic` tier; the reviewer walkthrough (T73) is the check. |
| 22 | Three tickets shipping browser tests below the `ui` tier | Raised to **`ui`**. |

## The four with consequences worth stating

**Collection reads (#2).** `PhiTarget` gains
`{ kind: 'collection'; of: 'study' | 'report' | 'appointment' | 'share' }`, and
`audit_events.action` gains `share.view` so a share-list read has an action of
its own. A list read writes one row with `target_id` null and `target_kind`
`<of>_list`. The alternative — one row per item — would multiply a 50-study page
view into 50 audit rows and put PF-1 at risk; skipping the guard would narrow
SEC-4 to detail views without saying so.

**Slot removal (#4).** `regenerate_provider_slots(provider_id, from, to, …)` is
`SECURITY DEFINER`, deletes only `slots` in range whose status is `open` and
which no live appointment references, then inserts the new grid. The application
role gains no privilege. This is the same pattern as `sync_slot_status`, and it
is why "no DELETE granted anywhere" survives an epic that has to delete
something.

**Auth routes (#15).** EC-12 names auth payloads as one of five surfaces that
must be validated server-side, and a browser-to-provider call leaves no server
code in the path. Two thin routes fix it, and `lib/validation` applies there
exactly as everywhere else. Password hashing stays with Supabase Auth (ADR-0004).

**Dropping the `docs` tier (#21).** It never traced to a requirement: CQ-8 asks
that the linter and tests run once per branch through its pull request and on
pushes to `main`, not that documents be linted. The consequence is that a
README-only ticket now runs the `logic` tier — slower than a document check, and
no worse than any other ticket. A dead link survives until T73's reviewer
walkthrough finds it, which is where DEL-5 is judged anyway.

## Consequences

Five new environment variables (`SLOT_HORIZON_DAYS`, `MAX_REQUEST_BODY_BYTES`,
`SOURCE_REF_SALT`, `REMINDER_WINDOW_MINUTES`, `REMINDER_CRON_MINUTES`), two new
tables, two new audit actions, one new database function, two new routes, and one
fewer gate tier. Every schema-shaped change is re-executed against Postgres 16
under `ARCHITECTURE.md` §13 before any ticket is published.

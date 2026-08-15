# Deploy record

Deployment for the Patient Imaging Portal skeleton (ADR-0002, GAP-4). One
Supabase free project and one Vercel Hobby project, wired to this
repository's `main` branch. This is the deploy record for the whole build —
later tickets append their own run to the **Run record** and **Live check**
sections below rather than starting a new file.

Nothing in the imaging, report, or scheduling epics depends on this deployed
URL (GAP-4) — those run against a local stack, and this deployment carries
the T1 skeleton only.

## Supabase project

- One free project: Postgres, Storage, Auth (ADR-0002).
- Project ref: `dyvbopxzwkavhggawedt`.
- Created via the Supabase dashboard. Every non-interactive step afterward —
  including applying `db/storage/bucket.sql` — uses `SUPABASE_ACCESS_TOKEN`
  (a personal access token, Management API auth), never interactive
  `supabase login`:
  ```
  supabase login --token "$SUPABASE_ACCESS_TOKEN"
  supabase link --project-ref dyvbopxzwkavhggawedt
  supabase db query --linked --file db/storage/bucket.sql
  ```
- Real connection values (`NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) live only in
  the Supabase project settings and in the Vercel project's environment
  variables below — never in this repository (SEC-7).

## Storage: the `phi` bucket

`db/storage/bucket.sql` is the reviewable source of the one bucket §9 pins:
private, no public policy, and no select policy for `anon` or
`authenticated` on `storage.objects` — ADR-0003's service role mints every
signed URL, and a read policy here would make that signature decorative.
Storage keys under this bucket are random UUIDs (ADR-0003); the layout is
flat, with no patient, study, or sequence identifier in a path.

Re-running `db/storage/bucket.sql` is safe: the insert is `on conflict (id)
do update set public = false`, so a bucket that already exists is left as
the one row it was, and a bucket a console click made public is put back to
private.

## Vercel project

- One Hobby project: `patient-imaging-portal`, linked to
  `everscending/patient-imaging-portal` on GitHub, production branch `main`
  (ADR-0002). A push to `main` builds and deploys that commit; a push to any
  other branch produces a preview deployment only, never a production one.
- `vercel.json` pins the framework and the build/install commands as a
  reviewable file rather than a console-only project setting (CQ-6).
- Real values for every §8 variable the deployed app needs are set in the
  Vercel project's **Settings → Environment Variables**, for both Preview
  and Production — never committed here:
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
    `SUPABASE_SERVICE_ROLE_KEY`, `SOURCE_REF_SALT` — required; `lib/config.ts`
    fails startup without them (ARCHITECTURE.md §8), which is what turned the
    first production build red before these were set (see **Run record**).
  - `APP_BASE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `EMAIL_TRANSPORT`,
    `CRON_SECRET` — optional or defaulted in `lib/config.ts`, set anyway so
    the deployed environment reflects real values, not a local fallback.
  - Every remaining §8 variable (`SHARE_LINK_TTL_HOURS`,
    `MIN_CHANGE_NOTICE_HOURS`, `REMINDER_LEAD_HOURS`, `IDENTITY_MAX_ATTEMPTS`,
    `IDENTITY_LOCKOUT_MINUTES`, `SIGNED_URL_TTL_SECONDS`, `SLOT_HORIZON_DAYS`,
    `MAX_REQUEST_BODY_BYTES`, `REMINDER_WINDOW_MINUTES`,
    `REMINDER_CRON_MINUTES`, `SEED_SOURCE_SEED`) keeps `lib/config.ts`'s
    default rather than being set explicitly. `PORT` and `TEST_PG_PORT` are
    dev/test-only; a Vercel deployment assigns its own port and reads
    neither.

## Run record

Appended once per deploy run — never edited after the fact.

| Date | Supabase project ref | Deployed URL | Deployed commit |
| --- | --- | --- | --- |
| 2026-08-15 | `dyvbopxzwkavhggawedt` | https://patient-imaging-portal.vercel.app | `PENDING` |

## Live check

Appended once per deploy run: an HTTP request to the deployed URL and one
guessed object path in `phi`, both made after the run record above.

| Timestamp (UTC) | Check | HTTP status | TLS certificate issuer | Commit |
| --- | --- | --- | --- | --- |
| PENDING | Deployed URL (`GET /`) | PENDING | PENDING | `PENDING` |
| PENDING | Guessed object in `phi` | PENDING | — | `PENDING` |

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

### Application schema and seed

The provisioner requires the standard PostgreSQL client, `psql`. On macOS,
install the client and expose its keg-only binaries for this command with:

```bash
brew install libpq
PATH="$(brew --prefix libpq)/bin:$PATH" npm run provision:deployed
```

Before running it, load the four required application variables plus
`PGHOST`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` into the shell. On hosts
where `psql` is already on `PATH`, run:

```bash
npm run provision:deployed
```

The command applies every `db/migrations/*.sql` file once in filename order,
re-applies the PostgREST grants and private bucket definition, seeds the
deterministic rows and Storage assets once, and then waits for a zero-row
authenticated PostgREST query to succeed. Applied migration checksums and the
seed checksum live in the unexposed `app_deploy` schema. A changed applied
file fails closed instead of being run again. Secrets remain in the process
environment and are never command arguments or command output.

### Reminder cron configuration

Vercel environment variables do not configure Postgres sessions. After the
database migrations are applied, provision the scheduler explicitly from the
same deployment values:

```bash
PGHOST="$PGHOST" PGDATABASE="$PGDATABASE" \
PGUSER="$PGUSER" PGPASSWORD="$PGPASSWORD" \
APP_BASE_URL="$APP_BASE_URL" \
CRON_SECRET="$CRON_SECRET" \
REMINDER_CRON_MINUTES="${REMINDER_CRON_MINUTES:-5}" \
REMINDER_WINDOW_MINUTES="${REMINDER_WINDOW_MINUTES:-30}" \
scripts/configure-reminder-cron.sh
```

The fixed SQL at `db/deploy/reminder-cron.sql` persists the URL, secret, and
cadence as database settings, then replaces `patient-imaging-reminders` with a
schedule using that cadence. Migration 004 fails closed when the target or
secret has not yet been provisioned: it creates no unauthenticated, null-target
job. Re-run the command whenever any of these deployment values changes. Real
values remain in the deployment environment and are never written to Git.

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
| 2026-08-15 | `dyvbopxzwkavhggawedt` | https://patient-imaging-portal.vercel.app | `1da62e27428e7c6cbef3bda29b01ef9bc7899bd9` |

## Live check

Appended once per deploy run: an HTTP request to the deployed URL and one
guessed object path in `phi`, both made after the run record above.

| Timestamp (UTC) | Check | HTTP status | TLS certificate issuer | Commit |
| --- | --- | --- | --- | --- |
| 2026-08-15T18:23:53Z | Deployed URL (`GET /`) | 200 | Google Trust Services (`WR1`) | `1da62e27428e7c6cbef3bda29b01ef9bc7899bd9` |
| 2026-08-15T18:23:53Z | Guessed object in `phi` | 400 | — | `1da62e27428e7c6cbef3bda29b01ef9bc7899bd9` |

## E0 wiring confirmation (JOR-217)

Appended by `e2e/e0-wiring.spec.ts`, the wiring ticket's own live check —
never edited after the fact, one entry per run.

| Timestamp (UTC) | Commit | Gate tiers (exit code) | Scratch clone's ui-tier port | Deployed URL check |
| --- | --- | --- | --- | --- |
| 2026-08-15T19:24:26.460Z | `dbfbad8533fe522d5faace95ef550dc5171ce26a` | logic: 0, api: 0, ui: 0 | 51790 | https://patient-imaging-portal.vercel.app — HTTP 200, matches origin/main HEAD: true |

Running skeleton checked on `config.port` (`PORT=4310` in this environment,
ADR-0013 default); the scratch clone's own nested `ui` tier ran its Next
server on the ephemeral port above, never 4310, to avoid claiming the port
this very test run was already using (§9). The test Postgres harness
(`pip-testpg`) published its own ephemeral host port, read back by
`tests/setup/postgres.ts`, for every gate tier above that touched it.

# Security Audit — Patient Imaging Portal

Date: 2026-08-22
Scope: auth/session, API routes, server logic, database (RLS + migrations), config, client code.
Method: three parallel read-only reviews; every finding verified in source. No files changed.

This portal holds protected health information (PHI) — medical images and signed
reports. Findings are ranked by how directly they expose that data.

## Summary

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | Critical | `email_outbox` has no row-level security and stores raw share links to other patients' imaging | `db/migrations/002…sql:242`, `003_rls.sql:9,149-159`, `lib/share/links.ts:105-108` |
| 2 | High | No rate limiting on password login; proxy design blinds Supabase's own limiter | `app/api/auth/login/route.ts:9-33`, `lib/db/client.ts:38-40` |
| 3 | High | `regenerate_provider_slots` (SECURITY DEFINER) has no caller check — any user can wipe/rewrite provider schedules | `db/migrations/002…sql:179-215`, `003_rls.sql:16` |
| 4 | High | Several tables have no RLS at all; some are writable by any logged-in user | `db/migrations/003_rls.sql:45-57,9-11` |
| 5 | Medium | Open-redirect filter bypassable with a backslash | `middleware.ts:31-43`, `app/(patient)/verify/page.tsx:14-27` |
| 6 | Medium | Logout clears the cookie but never revokes the token | `app/api/auth/logout/route.ts:9-13` |
| 7 | Medium | Audit log accepts forged inserts from any authenticated caller | `db/migrations/003_rls.sql:13,163` |
| 8 | Low | `reschedule_appointment` omits the in-RPC ownership check its siblings have | `db/migrations/007…sql:57-64,114-117` |
| 9 | Low | Session cookie `Secure` flag depends on an env var with an insecure default | `lib/session-cookie.ts:14-22`, `lib/config.ts:118` |
| 10 | Low | Supabase minimum password length is 6 | `supabase/config.toml:182` |

---

## Remediation status

Branch `security-audit-fixes`. The seven Critical/High/Medium findings are fixed;
the three Low findings are deferred (see below).

| # | Severity | Status | Fix |
|---|----------|--------|-----|
| 1 | Critical | Fixed | `db/migrations/016` enables RLS on `email_outbox` (deny-all policy) and revokes app-role grants; `lib/notify/email.ts` now enqueues as the service role. |
| 2 | High | Fixed | New `login_attempts` table + `lib/access/login-throttle.ts`; the login route locks per-email and per-source before calling Supabase. |
| 3 | High | Fixed | `016` revokes `execute` on `regenerate_provider_slots` from `app_user`/`anon`/`authenticated`; only `apply_provider_availability` (owner) calls it. |
| 4 | High | Fixed | `016` enables RLS on `reminder_sends` (deny-all), `staff_admins` (self/admin), `appointment_transitions` (participant-scoped + executor insert), and the reference/schedule tables (explicit read). |
| 5 | Medium | Fixed | Backslash rejected in `sanitizeNextPath` (middleware) and `safeNextPath` (verify page). |
| 6 | Medium | Fixed | Logout revokes the token at GoTrue `/auth/v1/logout` before clearing the cookie. |
| 7 | Medium | Fixed | `016` replaces the `with check (true)` audit-insert policy with `actor_ref = auth.uid()`. |
| 8 | Low | Deferred | In-RPC ownership check for `reschedule_appointment` — route already guards it. |
| 9 | Low | Deferred | `__Host-` cookie prefix / always-`Secure` — logs every user out on ship; needs a timed rollout. |
| 10 | Low | Deferred | Production password-length floor — a Supabase dashboard setting, not code. |

**Verification done here:** full `tsc --noEmit` clean; the Docker-free unit tests
for the changed share/email/throttle code pass (`tests/share/links.test.ts`,
`tests/notify/reminders.test.ts`, `tests/access/login-throttle.test.ts`).

**Verification still required before merge:** the Docker-backed database suite
(`tests/db/rls.test.ts`, `tests/db/migration-*.test.ts`, `tests/notify/retry.test.ts`)
was updated to the post-016 expectations but not executed here — it shares one
`pip-testpg` container and a second Claude session may be active. Run it in a quiet
window (`node_modules/.bin/vitest run --project unit tests/db tests/notify/retry.test.ts`),
plus the login/logout/verify e2e specs, then apply migration 016 to the hosted
database and confirm the live `anon`/`authenticated` grants.

**Also needed from a human (unchanged from the audit):** confirm the Vercel proxy
header for finding #2, decide the timing for the cookie rename (#9), and raise the
password floor in the Supabase dashboard (#10).

---

## Critical

### 1. Any logged-in user can read the email queue, which holds live share links to other patients' medical files

**Where:** `db/migrations/002_scheduling_sharing_audit.sql:242-253` (the `email_outbox`
table), `db/migrations/003_rls.sql:9,14,149-159`, `lib/share/links.ts:105-108`.

The `email_outbox` table (queued outgoing email) deliberately has no row-level
security, and the application role is granted read/insert/update on it. When a
patient shares an image or report, the email body written into that table
contains the full share URL with the **raw** secret token, and opening that URL
needs no login. So any signed-in account — including one that never verified as a
patient — can read every row of the queue, harvest other patients' active share
links, and view their images and signed reports. They can also update pending
rows (e.g. change the recipient before the send job runs). This also violates the
module's own stated invariant that the raw token never crosses its persistence
boundary (`links.ts:1-2`), and the migration comment claiming the table holds no
PHI is false once share emails are queued there.

**Fix:** don't persist the raw token — store the link id/path and rebuild the URL
at send time from the digest-backed row. Or enable RLS on `email_outbox` with no
policy for the app role and revoke the app role's select/insert/update, enqueuing
through a SECURITY DEFINER function or the service role only.

---

## High

### 2. No rate limiting on password login, and the proxy design blinds Supabase's limiter

**Where:** `app/api/auth/login/route.ts:9-33`, `lib/db/client.ts:38-40`.

The login route accepts unlimited password guesses: no attempt counter, lockout,
delay, or CAPTCHA. (Identity verification *does* enforce a lockout —
`lib/access/identity.ts:170-183` — but nothing equivalent guards the password.)
Because every login is relayed server-side through `authClient()`, which forwards
no client IP, Supabase's built-in per-IP limiter sees only the app server's
address for all users — so its brute-force protection is largely ineffective here.
An attacker can hammer one patient's email indefinitely.

**Fix:** add per-email and per-source-IP throttling to the login route; reuse the
`identity_attempts` lockout pattern already in `lib/access/identity.ts`.

### 3. Any logged-in user can wipe and rewrite any provider's open schedule

**Where:** `db/migrations/002_scheduling_sharing_audit.sql:179-215`, `003_rls.sql:16`.

`regenerate_provider_slots` is a SECURITY DEFINER function (runs with its owner's
powers) that deletes a provider's open slots and inserts a new grid. It takes any
provider id and performs no check of who is calling. The safe wrapper added later
(`005_apply_provider_availability.sql`) checks ownership, but the raw function stays
directly executable by the app role. Any authenticated user can delete every open
future slot for every provider (scheduling denial-of-service) or insert slots that
ignore working hours. On hosted Supabase it may be worse: unlike migrations
004/010/012/014, this function only did `revoke … from public`, not the per-role
revokes from `anon`/`authenticated` the repo's own comments say are required — so
the anonymous role likely keeps execute.

**Fix:** revoke execute on `regenerate_provider_slots` from `app_user`, `anon`, and
`authenticated`; only `apply_provider_availability` needs it.

### 4. Several tables have no row-level security; some are writable by any logged-in user

**Where:** `db/migrations/003_rls.sql:45-57` (the enable list) omits
`appointment_transitions`, `reminder_sends`, `working_hours`, `availability_blocks`,
`staff_admins`, `services`, and `provider_services`; lines 9-11 grant read on all
tables plus insert/update on `reminder_sends` to the app role.

Verified consequences: any signed-in user can read the full appointment history
(`appointment_transitions`) across all patients; read `staff_admins` to enumerate
administrator accounts; and insert/update `reminder_sends` to pre-mark other
patients' reminders as handled so those patients silently never get reminded. On
hosted Supabase, default `anon`/`authenticated` privileges are never revoked in any
migration, so these tables are likely fully readable/writable — including delete —
through the auto-generated REST API.

**Fix:** enable RLS on every one of these tables (service-role-only where the app
never needs them) and revoke the app role's `reminder_sends` writes.

---

## Medium

### 5. Open-redirect filter can be slipped past with a backslash

**Where:** `middleware.ts:31-43` (`sanitizeNextPath`), `app/(patient)/verify/page.tsx:14-27`
(`safeNextPath`).

Both sanitizers reject values not starting with `/`, starting with `//`, or
containing `scheme:` — but not a backslash. A link like `/verify?next=/%5Cevil.com`
decodes to `/\evil.com`, which passes every check. Browsers and the WHATWG URL
parser treat `\` as `/`, so `router.replace('/\evil.com')` resolves to
`https://evil.com/` — an off-site redirect from a page patients are trained to
trust, ideal for phishing.

**Fix:** in both sanitizers, also reject any decoded value containing `\`, or
validate with `new URL(decoded, origin).origin === origin`.

### 6. Logout clears the cookie but never revokes the token

**Where:** `app/api/auth/logout/route.ts:9-13`.

Logout only expires the browser cookie; it never signs the token out at Supabase,
so the access token stays valid until its natural expiry (~60 min). Anyone who
captured that token (proxy log, backup, compromised machine) keeps reading records
for the rest of that window after the patient "signs out."

**Fix:** call Supabase's `auth.admin.signOut(token)` (or the GoTrue `/logout`
endpoint with the bearer token) before clearing the cookie.

### 7. Audit log accepts forged inserts from any authenticated caller

**Where:** `db/migrations/003_rls.sql:13,163` — `grant insert … audit_events to
app_user` plus `create policy audit_insert_any … with check (true)`.

Any authenticated caller can insert arbitrary rows into the audit trail with any
`actor_ref`, `action`, `target_id`, and `outcome` — fabricating "granted" events
attributed to other accounts, or flooding the log to bury real events. Update and
delete are correctly withheld, so existing rows can't be erased; the flaw is the
unconditional `with check (true)`.

**Fix:** constrain the insert policy so `actor_ref` must equal the caller's subject
for account inserts, and route elevated (share/system/anonymous) writes through the
service role only.

---

## Low

### 8. `reschedule_appointment` omits the in-RPC ownership check its siblings have

**Where:** `db/migrations/007_reschedule_cancel_appointments.sql:57-64,114-117`.

This SECURITY DEFINER function fetches and updates an appointment by id with no
patient/provider/admin scoping — it only verifies the actor id matches the JWT
sub, not that the actor owns the appointment. `cancel_appointment` (same file,
:164-205) does check ownership. Today the only caller runs `guardPhiAccess` first
(`app/api/appointments/[id]/route.ts:30`), so this is a defense-in-depth gap, not a
live IDOR — but reschedule's safety depends entirely on the route remembering to
guard.

**Fix:** add the same actor-vs-appointment ownership check inside the function.

### 9. Session cookie `Secure` flag depends on an env var with an insecure default

**Where:** `lib/session-cookie.ts:14-22`, `lib/config.ts:118`.

`secure` is set only when `APP_BASE_URL` starts with `https://`, and `APP_BASE_URL`
silently defaults to `http://localhost:4310`. A production deploy that forgets that
one variable ships the session cookie without `Secure`, letting it travel over
plain HTTP. The cookie also skips the `__Host-` prefix.

**Fix:** rename to `__Host-pip_session` with `secure: true` always, and fail startup
if the base URL is `http://` outside development.

### 10. Weak minimum password length in Supabase auth config

**Where:** `supabase/config.toml:182` sets `minimum_password_length = 6`.

Six characters is below current guidance for a PHI portal, and below the app's own
Zod rule of 8 (`lib/validation/index.ts:181`). Impact is modest since login runs
through Supabase, but the floor should match.

**Fix:** raise to at least 8 and consider enabling `password_requirements`.

---

## Checked and clean

- **Password hashing** — none done locally by design; passwords go straight to Supabase Auth, never stored or logged.
- **Hardcoded secrets** — none. Only test/demo placeholders (`.env.test`, seed rows, k6 demo password); real `.env` untracked; CI uses `${{ secrets.* }}`.
- **SQL injection** — all queries use the PostgREST builder or parameterized `.rpc(...)`; the one interpolation (tstzrange in `availability.ts:320`) is bound, not raw.
- **IDOR on studies/reports/appointments/shares** — every by-id route goes through `guardPhiAccess`; reads use the caller-scoped client; ownership failures return 404 not 403.
- **Mass assignment / input validation** — Zod `.strict()` schemas on path/query/body; request bodies size-capped while streaming.
- **XSS / client storage** — no `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, or `localStorage`/`sessionStorage`; session token is httpOnly.
- **PHI in URLs** — client fetches key off opaque UUIDs/tokens, never patient identifiers.
- **Share-token strength** — 256-bit `randomBytes`, stored only as SHA-256, expiry + revocation enforced (weakness is only its persistence in `email_outbox`, finding #1).
- **Storage signing** — private bucket, service-role-only signed URLs, 300s TTL, path-traversal guard.
- **Timing attacks** — cron secret and date-of-birth checks hash then use `timingSafeEqual` with constant-shape paths.
- **CSRF** — httpOnly + SameSite=Lax cookie; body routes require `application/json`, which cross-site forms can't send.
- **Session fixation / account enumeration** — fresh token per login; identical 401 for wrong email vs password.
- **Cron/reminders auth** — constant-time secret comparison, fails closed when unset.
- **Dependencies** — Next.js 15.5.23, React 19, Supabase JS 2.11x, Zod 4, Resend 6; nothing obviously vulnerable; no risky install scripts.

## Caveat on hosted Supabase

Findings 3 and 4 are worse on hosted Supabase than a local run shows. The repo
pattern (migrations 004/010/012/014) is that each SECURITY DEFINER function and
table must *explicitly* revoke `anon`/`authenticated` — `revoke from public` does
not cover them. Those revokes are missing for the tables and function above, so on
a hosted instance the `anon`/`authenticated` roles very likely retain access
through the auto-generated REST API. Confirm against the live instance.

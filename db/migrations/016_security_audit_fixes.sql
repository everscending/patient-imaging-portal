-- Security audit remediation (AUDIT.md). Forward-only: every change here is a
-- new statement on top of the applied chain, never an edit to 001–015.
--
-- Closes five audit findings that all share one root cause — the app role
-- (app_user) and, on hosted Supabase, the anon/authenticated roles can reach
-- tables and a function through PostgREST that the application layer never
-- intended them to touch:
--   #1 email_outbox held share links with the raw token, readable by any session
--   #3 regenerate_provider_slots was directly executable by app_user
--   #4 reminder_sends was writable, staff_admins/appointment_transitions readable
--   #7 audit_events accepted an insert attributing any actor to the caller
--
-- Service-role work (the reminder job, share-token resolution, audit fallback)
-- is unaffected: the service role bypasses RLS, and the SECURITY DEFINER
-- functions owned by the migration role (regenerate/apply/claim) still run with
-- owner privileges. The one non-owner executor, booking_executor (008, nobypassrls),
-- gets an explicit insert policy where a table it writes gains RLS.

-- ── #1 email_outbox: lock to the service role ────────────────────────────────
-- The "no PHI, generic body" premise (003) is false for share emails: the body
-- carries /s/<raw-token>, a working key to a patient's image or report. Rather
-- than keep the table world-readable and hope no secret lands in it, deny the
-- app role outright. The reminder job drains it as the service role (RLS bypass),
-- and share creation now enqueues as the service role too (lib/notify/email.ts).
alter table email_outbox enable row level security;
create policy email_outbox_no_app_access on email_outbox
  for all using (false) with check (false);
revoke select, insert, update on email_outbox from app_user;
revoke all on email_outbox from anon, authenticated;

-- ── #3 regenerate_provider_slots: not callable by the app role ───────────────
-- app_user never calls it directly — only apply_provider_availability (005) does,
-- and that runs as owner, so it can still call regenerate regardless. Leaving the
-- raw grant let any session wipe/rewrite any provider's open slots.
revoke execute on function regenerate_provider_slots(uuid, timestamptz, timestamptz, tstzrange[])
  from app_user;
revoke all on function regenerate_provider_slots(uuid, timestamptz, timestamptz, tstzrange[])
  from anon, authenticated;

-- ── #4 reminder_sends: no app-role read or write ─────────────────────────────
-- 003's stated intent ("not written by a patient session") was never enforced:
-- RLS was off and insert/update were granted, so any session could pre-mark
-- another patient's reminder as handled and suppress it. The claim RPC (004,
-- owner) and the reminder job (service role) both bypass RLS, so the drain path
-- is untouched.
alter table reminder_sends enable row level security;
create policy reminder_sends_no_app_access on reminder_sends
  for all using (false) with check (false);
revoke select, insert, update on reminder_sends from app_user;
revoke all on reminder_sends from anon, authenticated;

-- The policies below resolve the caller through current_request_user_id()
-- (009/013): a SECURITY DEFINER that reads request.jwt.claims (hosted) OR
-- request.jwt.claim.sub (local) and fails closed on a malformed claim. It is
-- used rather than auth.uid() (which app_user cannot call, and which reads only
-- the hosted claim shape) so these policies hold under both PostgREST runtimes.
-- Both evaluating roles already hold execute: booking_executor from 009,
-- app_user from 012 — so no grant is repeated here.

-- ── #4 staff_admins: a caller may see only their own row ─────────────────────
-- Blanket SELECT let any session enumerate every administrator. is_admin()
-- reads this table as a SECURITY DEFINER owned by the table owner, so it keeps
-- working; the direct app reads (role resolution in the login route, the guard,
-- the provider layout) are all self-scoped and satisfied by the self clause.
alter table staff_admins enable row level security;
create policy staff_admins_self_or_admin on staff_admins
  for select using (user_id = current_request_user_id() or is_admin());
revoke all on staff_admins from anon, authenticated;

-- ── #4 appointment_transitions: scoped to the appointment's participants ─────
-- No patient id lives on the row, but blanket SELECT still exposed every
-- appointment's status history and the acting user ids across all patients.
-- app_user already has no write here (008). booking_executor (nobypassrls) writes
-- it from the booking/transition RPCs, so it needs an explicit insert policy.
alter table appointment_transitions enable row level security;
create policy appt_transitions_participant_read on appointment_transitions
  for select using (
    exists (
      select 1 from appointments a
       where a.id = appointment_transitions.appointment_id
         and (a.patient_id = current_patient_id()
              or a.provider_id = current_provider_id()
              or is_admin())
    )
  );
create policy appt_transitions_executor_insert on appointment_transitions
  for insert to booking_executor with check (true);
revoke all on appointment_transitions from anon, authenticated;

-- ── #4 reference / schedule tables: read stays open, but made explicit ───────
-- working_hours, availability_blocks, services and provider_services hold no
-- patient data and back the public booking surface, so read stays open — but as
-- a stated policy rather than an accidental gap, and with hosted anon/authenticated
-- writes revoked. Writes run only through owner-level SECURITY DEFINER functions.
alter table working_hours enable row level security;
create policy working_hours_read on working_hours for select using (true);
revoke all on working_hours from anon, authenticated;

alter table availability_blocks enable row level security;
create policy availability_blocks_read on availability_blocks for select using (true);
revoke all on availability_blocks from anon, authenticated;

alter table services enable row level security;
create policy services_read on services for select using (true);
revoke all on services from anon, authenticated;

alter table provider_services enable row level security;
create policy provider_services_read on provider_services for select using (true);
revoke all on provider_services from anon, authenticated;

-- ── #7 audit_events: a caller cannot attribute a row to anyone but themselves ─
-- `with check (true)` let any authenticated caller forge "granted" access events
-- for another account or flood the log as a null-actor system row. The elevated
-- writers (share recipient, guard denial, reminder job) go through the service
-- role and bypass RLS; every app_user and booking_executor insert already sets
-- actor_ref to the caller's own subject, so self-attribution is the exact bound.
drop policy audit_insert_any on audit_events;
create policy audit_insert_self on audit_events
  for insert with check (actor_ref = current_request_user_id()::text);

-- ── #2 login throttle store ──────────────────────────────────────────────────
-- Brute-force protection for the password login (app/api/auth/login). Counted
-- and written only by the login route as the service role; never touched by a
-- patient session. New table, so the 003 blanket SELECT grant does not reach it,
-- but RLS + a deny policy + explicit revokes make that non-negotiable and cover
-- hosted anon/authenticated too.
create table login_attempts (
  id            uuid primary key default gen_random_uuid(),
  email_hash    text not null,          -- sha256(salt + lowercased email); no raw address
  source_ref    text not null,          -- sha256(salt + first x-forwarded-for); no raw ip
  succeeded     boolean not null,
  attempted_at  timestamptz not null default now()
);
create index on login_attempts (email_hash, attempted_at desc);
create index on login_attempts (source_ref, attempted_at desc);

alter table login_attempts enable row level security;
create policy login_attempts_no_app_access on login_attempts
  for all using (false) with check (false);
revoke all on login_attempts from app_user, anon, authenticated;

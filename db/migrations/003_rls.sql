-- Second enforcement layer behind the application checks (ARCHITECTURE.md §4,
-- ADR-0002). Application code still verifies ownership explicitly; RLS is what
-- catches the handler that forgets. The application connects as app_user, a
-- non-superuser, non-owner role — both superusers and table owners bypass RLS,
-- so a policy tested as the migration-running role proves nothing.

-- `create role app_user` already happened in 001, with the audit_events grants.
grant usage on schema public to app_user;
grant select on all tables in schema public to app_user;
grant insert, update on appointments, identity_attempts,
                        share_links, reminder_sends to app_user;
grant insert on slots to app_user;           -- generation only, never status
grant insert on appointment_transitions, audit_events to app_user;
grant insert, update on email_outbox to app_user;      -- drained by the job
grant insert on deletion_requests to app_user;
grant execute on function regenerate_provider_slots(uuid, timestamptz, timestamptz, tstzrange[]) to app_user;
grant usage, select on all sequences in schema public to app_user;
-- deliberately NOT granted anywhere: delete
-- deliberately NOT granted on audit_events: update, delete (§3)

-- A session with no JWT claim must DENY, not error. `current_setting(...)::uuid`
-- on an empty string raises `invalid input syntax for type uuid` from inside
-- every policy, which surfaces as a 500 rather than an empty result — so the
-- claim is read through nullif().
create or replace function current_patient_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from patients
   where user_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function current_provider_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from providers where user_id = auth.uid()
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_admins where user_id = auth.uid())
$$;

-- `alter table … enable row level security` is per table and does nothing by
-- implication. A policy created on a table whose RLS is not enabled is inert —
-- accepted without error, never evaluated. So every table is listed here in
-- full, rather than one line saying "and the rest".
alter table patients            enable row level security;
alter table providers           enable row level security;
alter table visits              enable row level security;
alter table studies             enable row level security;
alter table images              enable row level security;
alter table cine_clips          enable row level security;
alter table cine_frames         enable row level security;
alter table reports             enable row level security;
alter table appointments        enable row level security;
alter table slots               enable row level security;
alter table identity_attempts   enable row level security;
alter table share_links         enable row level security;
alter table deletion_requests   enable row level security;

create policy patients_self on patients for select
  using (id = current_patient_id() or is_admin());

create policy providers_readable on providers for select
  using (true);                       -- name, zone, slot length: not PHI

create policy visits_own on visits for select
  using (patient_id = current_patient_id()
      or provider_id = current_provider_id() or is_admin());

create policy studies_own on studies for select
  using (patient_id = current_patient_id()
      or exists (select 1 from visits v
                  where v.id = studies.visit_id
                    and v.provider_id = current_provider_id())
      or is_admin());

create policy images_own on images for select
  using (patient_id = current_patient_id() or is_admin());

create policy clips_own on cine_clips for select
  using (patient_id = current_patient_id() or is_admin());

-- cine_frames carries NEITHER patient_id NOR provider_id, so it is the one
-- table that cannot use the shape above. It reaches its owner through its clip.
create policy frames_own on cine_frames for select
  using (exists (select 1 from cine_clips c
                  where c.id = cine_frames.clip_id
                    and (c.patient_id = current_patient_id() or is_admin())));

-- FR-7: the signed-only rule is a predicate, not a convention — and it binds
-- the PATIENT only. A provider may read their own patient's preliminary report.
create policy reports_own_signed on reports for select
  using ((patient_id = current_patient_id() and status = 'signed')
      or exists (select 1 from visits v
                  join studies s on s.visit_id = v.id
                 where s.id = reports.study_id
                   and v.provider_id = current_provider_id())
      or is_admin());

create policy appointments_own on appointments for select
  using (patient_id = current_patient_id()
      or provider_id = current_provider_id() or is_admin());

create policy slots_readable on slots for select
  using (status = 'open'
      or provider_id = current_provider_id() or is_admin()
      or exists (select 1 from appointments a
                  where a.slot_id = slots.id
                    and a.patient_id = current_patient_id()));

create policy attempts_admin on identity_attempts for select
  using (is_admin());        -- a patient must not read attempt history

create policy shares_own on share_links for select
  using (patient_id = current_patient_id() or is_admin());

create policy deletion_requests_own on deletion_requests for select
  using (patient_id = current_patient_id() or is_admin());

-- RLS denies by default, and a `for select` policy does not authorise a
-- write. Enabling RLS with read policies alone leaves every INSERT and UPDATE
-- refused with "new row violates row-level security policy" — a grant is not
-- enough. Every writable table therefore needs its own write policy too.

-- a patient books for themselves; nobody books on their behalf
create policy appointments_insert_own on appointments for insert
  with check (patient_id = current_patient_id());

-- patient, the owning provider, or an admin may move it along (§6's matrix
-- decides WHICH transition; this decides WHO may attempt one at all)
create policy appointments_update_own on appointments for update
  using  (patient_id = current_patient_id()
       or provider_id = current_provider_id() or is_admin())
  with check (patient_id = current_patient_id()
       or provider_id = current_provider_id() or is_admin());

create policy shares_insert_own on share_links for insert
  with check (patient_id = current_patient_id());
create policy shares_update_own on share_links for update      -- revocation
  using (patient_id = current_patient_id())
  with check (patient_id = current_patient_id());

create policy deletion_requests_insert_own on deletion_requests for insert
  with check (patient_id = current_patient_id());

-- slot generation runs as the owning provider
create policy slots_insert_own on slots for insert
  with check (provider_id = current_provider_id() or is_admin());

-- `email_outbox` gets NO RLS at all, deliberately: it is written by server
-- code on the patient's behalf and drained by the reminder job running as the
-- service role, and it holds no patient identifier — a recipient address, a
-- subject and a generic body. A policy keyed on current_patient_id() would
-- refuse the job's own reads. Exempted BY NAME in the enabled-check
-- (tests/db/rls.test.ts), not merely absent from it.

-- `identity_attempts` and `reminder_sends` get no app-role write policy,
-- because neither is written by a patient session: FR-2 verification runs
-- through the service role (it must read `patients` before any link exists),
-- and the reminder job is the service role by definition.

alter table audit_events enable row level security;

create policy audit_insert_any on audit_events for insert with check (true);
create policy audit_select_admin on audit_events for select using (is_admin());

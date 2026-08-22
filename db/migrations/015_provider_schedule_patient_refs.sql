-- 015 — JOR-260 gap: a provider can read their appointments (003:
-- appointments_own) but never the patients table (003: patients_self is
-- patient-or-admin only), so the schedule route's patients!inner(patient_ref)
-- embed silently dropped every booked row and the provider's day rendered as
-- all-open. This view is the one provider-facing surface for the patient
-- reference: definer-rights on purpose, so the view owner reads patients past
-- RLS while the where-clause scopes rows to the calling provider (or admin).
-- It exposes patient_ref only — name and DOB stay unreadable to providers
-- (UX_SPEC: providers see references, never identity).
create view provider_schedule_appointments with (security_barrier) as
select a.id,
       a.slot_id,
       a.status,
       a.out_of_hours,
       p.patient_ref,
       sv.name as service_name
  from appointments a
  join patients p on p.id = a.patient_id
  join services sv on sv.id = a.service_id
 where a.provider_id = current_provider_id()
    or is_admin();

grant select on provider_schedule_appointments to app_user;

-- Hosted PostgREST executes as `authenticated` (001 maps it to app_user
-- locally); grant it too wherever that role exists.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on provider_schedule_appointments to authenticated;
  end if;
end $$;

-- JOR-286: rescheduling and cancellation must hold their appointment, slot,
-- status-transition, and derived-slot-state work in one database transaction.
-- `app_user` calls these SECURITY DEFINER functions but never receives direct
-- UPDATE on slots or broader table grants.

grant update on appointments to booking_executor;
grant insert on audit_events to booking_executor;
grant usage on sequence audit_events_id_seq to booking_executor;
revoke select on sequence audit_events_id_seq from booking_executor;

-- A reschedule must lock its currently-booked slot as well as an open target.
-- The original booking policy admitted only open rows, which is correct for a
-- new booking but too narrow for a move/cancel.  The executor still cannot
-- write a slot: WITH CHECK false makes this a locking-only policy.
alter policy slots_booking_lock on slots
  using (
    (status = 'open' and starts_at > now())
    or exists (
      select 1 from appointments a
       where a.slot_id = slots.id
         and a.patient_id = current_patient_id()
    )
  )
  with check (false);

create or replace function reschedule_appointment(
  p_appointment_id uuid,
  p_slot_id uuid,
  p_actor_user_id uuid,
  p_minimum_notice interval
) returns table (
  result_error text,
  appointment_id uuid,
  appointment_slot_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  appointment_status appointment_status,
  provider_name text,
  provider_time_zone text,
  service_name text,
  out_of_hours boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appointment appointments%rowtype;
  v_caller_user_id uuid;
  v_locked_slots int;
begin
  v_caller_user_id := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  if v_caller_user_id is null or p_actor_user_id is distinct from v_caller_user_id then
    raise insufficient_privilege using message = 'reschedule actor does not match caller';
  end if;

  select a.* into v_appointment
    from appointments a
   where a.id = p_appointment_id
   for update;

  if not found then
    raise insufficient_privilege using message = 'appointment is not available to caller';
  end if;

  if v_appointment.status not in ('requested', 'confirmed') then
    return query select 'not_reschedulable'::text,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  -- This exact ordering is load-bearing.  Opposite moves take both row locks
  -- in UUID order, so concurrent callers serialize instead of deadlocking.
  perform s.id
    from slots s
   where s.id in (v_appointment.slot_id, p_slot_id)
   order by s.id
   for update;
  get diagnostics v_locked_slots = row_count;

  if v_locked_slots <> 2 then
    return query select 'slot_unavailable'::text,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  -- app_user controls this argument; ADR-0008 is the non-weakenable floor.
  if (select s.starts_at from slots s where s.id = v_appointment.slot_id)
       <= now() + greatest(p_minimum_notice, interval '24 hours') then
    return query select 'minimum_notice'::text,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  -- Re-check after both locks.  The provider condition makes a cross-provider
  -- target indistinguishable from an unavailable slot without exposing it.
  if not exists (
    select 1 from slots s
     where s.id = p_slot_id
       and s.provider_id = v_appointment.provider_id
       and s.status = 'open'
       and s.starts_at > now()
  ) then
    return query select 'slot_unavailable'::text,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  set constraints appointments_one_live_per_slot deferred;
  update appointments
     set slot_id = p_slot_id,
         out_of_hours = false
   where id = v_appointment.id;

  insert into audit_events (
    actor_kind, actor_ref, action, target_kind, target_id, outcome
  ) values (
    'account', p_actor_user_id::text, 'booking.reschedule',
    'appointment', v_appointment.id, 'granted'
  );

  return query
  select null::text, a.id, a.slot_id, s.starts_at, s.ends_at, a.status,
         p.full_name, p.time_zone, sv.name, a.out_of_hours
    from appointments a
    join slots s on s.id = a.slot_id
    join providers p on p.id = a.provider_id
    join services sv on sv.id = a.service_id
   where a.id = v_appointment.id;
end $$;

create or replace function cancel_appointment(
  p_appointment_id uuid,
  p_actor_user_id uuid,
  p_minimum_notice interval
) returns table (
  result_error text,
  appointment_id uuid,
  appointment_slot_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  appointment_status appointment_status,
  provider_name text,
  provider_time_zone text,
  service_name text,
  out_of_hours boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appointment appointments%rowtype;
  v_caller_user_id uuid;
  v_actor_patient_id uuid;
  v_actor_provider_id uuid;
  v_actor_is_admin boolean;
begin
  v_caller_user_id := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  if v_caller_user_id is null or p_actor_user_id is distinct from v_caller_user_id then
    raise insufficient_privilege using message = 'cancel actor does not match caller';
  end if;

  v_actor_patient_id := current_patient_id();
  v_actor_provider_id := current_provider_id();
  v_actor_is_admin := is_admin();

  select a.* into v_appointment
    from appointments a
   where a.id = p_appointment_id
   for update;

  if not found then
    raise insufficient_privilege using message = 'appointment is not available to caller';
  end if;

  -- The application resolves provider before admin before patient. Do not let
  -- the patient arm of the RLS policy turn an unrelated provider into a
  -- different effective role when the RPC is called directly.
  if v_actor_provider_id is not null
     and v_actor_provider_id is distinct from v_appointment.provider_id then
    raise insufficient_privilege using message = 'appointment is not available to caller';
  end if;

  perform s.id from slots s where s.id = v_appointment.slot_id for update;

  if v_appointment.status not in ('requested', 'confirmed') then
    return query select 'not_reschedulable'::text,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  -- A user can have both a patient row and a clinician role. Match the
  -- clinician-first route without treating an unrelated provider row as a
  -- notice-floor bypass: only an admin or this appointment's owning provider
  -- acts as a clinician here. Every other owning patient keeps FR-13's
  -- non-weakenable 24-hour floor.
  if v_actor_provider_id is null
     and not v_actor_is_admin
     and v_actor_patient_id = v_appointment.patient_id
     and (select s.starts_at from slots s where s.id = v_appointment.slot_id)
       <= now() + greatest(p_minimum_notice, interval '24 hours') then
    return query select 'minimum_notice'::text,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  update appointments set status = 'cancelled' where id = v_appointment.id;
  insert into appointment_transitions (appointment_id, from_status, to_status, actor_user_id)
  values (v_appointment.id, v_appointment.status, 'cancelled', p_actor_user_id);
  insert into audit_events (
    actor_kind, actor_ref, action, target_kind, target_id, outcome
  ) values (
    'account', p_actor_user_id::text, 'booking.cancel',
    'appointment', v_appointment.id, 'granted'
  );

  return query
  select null::text, a.id, a.slot_id, s.starts_at, s.ends_at, a.status,
         p.full_name, p.time_zone, sv.name, a.out_of_hours
    from appointments a
    join slots s on s.id = a.slot_id
    join providers p on p.id = a.provider_id
    join services sv on sv.id = a.service_id
   where a.id = v_appointment.id;
end $$;

alter function reschedule_appointment(uuid, uuid, uuid, interval) owner to booking_executor;
alter function cancel_appointment(uuid, uuid, interval) owner to booking_executor;
revoke all on function reschedule_appointment(uuid, uuid, uuid, interval) from public;
revoke all on function cancel_appointment(uuid, uuid, interval) from public;
grant execute on function reschedule_appointment(uuid, uuid, uuid, interval) to app_user;
grant execute on function cancel_appointment(uuid, uuid, interval) to app_user;

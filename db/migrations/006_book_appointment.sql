-- JOR-228: PostgREST cannot hold the booking read, slot lock, appointment
-- insert, and transition insert in one client-side transaction. This narrow
-- RPC supplies that transaction through a non-login, non-bypass-RLS executor.
-- The caller's claim still drives RLS, and slots_follow_appointments remains
-- the sole writer of slots.status.
do $$
begin
  create role booking_executor nologin nobypassrls;
exception when duplicate_object then
  null;
end
$$;

-- PostgreSQL 16 no longer gives CREATEROLE users implicit SET permission on
-- roles they create. Supabase's migration role needs this before transferring
-- ownership of the SECURITY DEFINER functions below.
grant booking_executor to current_user;

grant usage on schema public to booking_executor;
grant select on slots, appointments, provider_services, providers, services,
                patients to booking_executor;
grant insert on appointments, appointment_transitions to booking_executor;
-- SELECT ... FOR UPDATE requires UPDATE privilege even though this function
-- never issues UPDATE. The uncallable executor role holds it; app_user does
-- not, so direct attempts to write slots.status remain impossible.
grant update on slots to booking_executor;
grant usage, select on all sequences in schema public to booking_executor;

-- A locking SELECT also evaluates UPDATE RLS policies. This policy admits
-- only the executor role and only open future rows for locking; WITH CHECK
-- false keeps even that role from performing an actual application UPDATE.
create policy slots_booking_lock on slots for update to booking_executor
  using (status = 'open' and starts_at > now())
  with check (false);

create or replace function book_appointment(
  p_patient_id uuid,
  p_slot_id uuid,
  p_service_id uuid,
  p_idempotency_key text,
  p_actor_user_id uuid
) returns table (
  result_error text,
  result_reused boolean,
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
  v_existing appointments%rowtype;
  v_provider_id uuid;
  v_appointment_id uuid;
  v_constraint_name text;
  v_caller_user_id uuid;
begin
  -- Match current_patient_id()'s claim source. Calling auth.uid() directly as
  -- app_user would add an otherwise-unneeded USAGE grant on the auth schema in
  -- stock Postgres; Supabase/PostgREST supplies this same request setting.
  v_caller_user_id := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  if v_caller_user_id is null or p_actor_user_id is distinct from v_caller_user_id then
    raise insufficient_privilege using message = 'booking actor does not match caller';
  end if;

  -- Step 1: an idempotent retry never contends for the slot. Comparing the
  -- stored slot is load-bearing: the same key on another slot is an error,
  -- never a phantom success.
  select a.*
    into v_existing
    from appointments a
   where a.patient_id = p_patient_id
     and a.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.slot_id is distinct from p_slot_id then
      return query select
        'idempotency_key_reused'::text, null::boolean,
        null::uuid, null::uuid, null::timestamptz, null::timestamptz,
        null::appointment_status, null::text, null::text, null::text,
        null::boolean;
      return;
    end if;

    return query
    select null::text, true, a.id, a.slot_id, s.starts_at, s.ends_at,
           a.status, p.full_name, p.time_zone, sv.name, a.out_of_hours
      from appointments a
      join slots s on s.id = a.slot_id
      join providers p on p.id = a.provider_id
      join services sv on sv.id = a.service_id
     where a.id = v_existing.id;
    return;
  end if;

  -- The service check is deliberately before FOR UPDATE. Invalid service
  -- requests do not take a slot lock. A missing slot is unavailable rather
  -- than evidence about a provider/service relationship.
  select s.provider_id into v_provider_id from slots s where s.id = p_slot_id;
  if not found then
    return query select
      'slot_unavailable'::text, null::boolean,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text,
      null::boolean;
    return;
  end if;

  if not exists (
    select 1 from provider_services ps
     where ps.provider_id = v_provider_id and ps.service_id = p_service_id
  ) then
    return query select
      'service_not_offered'::text, null::boolean,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text,
      null::boolean;
    return;
  end if;

  -- Step 2: only the requested open, future slot is locked. After waiting on
  -- a winner, READ COMMITTED re-checks the predicate and yields no row.
  select s.provider_id
    into v_provider_id
    from slots s
   where s.id = p_slot_id
     and s.status = 'open'
     and s.starts_at > now()
   for update;

  if not found then
    -- A concurrent double-click can arrive here after the first call commits.
    -- Re-read the idempotency key before deciding that the slot was lost.
    select a.*
      into v_existing
      from appointments a
     where a.patient_id = p_patient_id
       and a.idempotency_key = p_idempotency_key;

    if found and v_existing.slot_id = p_slot_id then
      return query
      select null::text, true, a.id, a.slot_id, s.starts_at, s.ends_at,
             a.status, p.full_name, p.time_zone, sv.name, a.out_of_hours
        from appointments a
        join slots s on s.id = a.slot_id
        join providers p on p.id = a.provider_id
        join services sv on sv.id = a.service_id
       where a.id = v_existing.id;
      return;
    elsif found then
      return query select
        'idempotency_key_reused'::text, null::boolean,
        null::uuid, null::uuid, null::timestamptz, null::timestamptz,
        null::appointment_status, null::text, null::text, null::text,
        null::boolean;
      return;
    end if;

    return query select
      'slot_unavailable'::text, null::boolean,
      null::uuid, null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text,
      null::boolean;
    return;
  end if;

  -- Steps 3 and 4. The trigger derives slots.status from this insert. The
  -- exception block is a subtransaction, so a caught constraint failure does
  -- not poison the RPC's transaction before the required re-read.
  begin
    insert into appointments (
      slot_id, patient_id, provider_id, service_id, idempotency_key
    ) values (
      p_slot_id, p_patient_id, v_provider_id, p_service_id, p_idempotency_key
    ) returning id into v_appointment_id;

    insert into appointment_transitions (
      appointment_id, from_status, to_status, actor_user_id
    ) values (
      v_appointment_id, null, 'requested', p_actor_user_id
    );
  exception
    when unique_violation or exclusion_violation then
      get stacked diagnostics v_constraint_name = constraint_name;

      if v_constraint_name = 'appointments_idempotency' then
        select a.*
          into v_existing
          from appointments a
         where a.patient_id = p_patient_id
           and a.idempotency_key = p_idempotency_key;

        if found and v_existing.slot_id = p_slot_id then
          return query
          select null::text, true, a.id, a.slot_id, s.starts_at, s.ends_at,
                 a.status, p.full_name, p.time_zone, sv.name, a.out_of_hours
            from appointments a
            join slots s on s.id = a.slot_id
            join providers p on p.id = a.provider_id
            join services sv on sv.id = a.service_id
           where a.id = v_existing.id;
          return;
        end if;

        return query select
          'idempotency_key_reused'::text, null::boolean,
          null::uuid, null::uuid, null::timestamptz, null::timestamptz,
          null::appointment_status, null::text, null::text, null::text,
          null::boolean;
        return;
      end if;

      if v_constraint_name = 'appointments_one_live_per_slot' then
        return query select
          'slot_unavailable'::text, null::boolean,
          null::uuid, null::uuid, null::timestamptz, null::timestamptz,
          null::appointment_status, null::text, null::text, null::text,
          null::boolean;
        return;
      end if;

      raise;
  end;

  return query
  select null::text, false, a.id, a.slot_id, s.starts_at, s.ends_at,
         a.status, p.full_name, p.time_zone, sv.name, a.out_of_hours
    from appointments a
    join slots s on s.id = a.slot_id
    join providers p on p.id = a.provider_id
    join services sv on sv.id = a.service_id
   where a.id = v_appointment_id;
end $$;

grant create on schema public to booking_executor;
alter function book_appointment(uuid,uuid,uuid,text,uuid) owner to booking_executor;
revoke create on schema public from booking_executor;
revoke all on function book_appointment(uuid,uuid,uuid,text,uuid) from public;
grant execute on function book_appointment(uuid,uuid,uuid,text,uuid) to app_user;

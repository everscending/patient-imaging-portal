-- Status changes must cross one transactional, role-aware boundary. RLS limits
-- which appointment row a caller can reach, while this RPC limits which edge
-- that caller's effective scheduling role may take.
revoke update on appointments from app_user;
revoke insert on appointment_transitions from app_user;

create or replace function transition_appointment(
  p_appointment_id uuid,
  p_status appointment_status,
  p_actor_user_id uuid
) returns table (
  result_error text,
  appointment_id uuid,
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
  v_actor_provider_id uuid;
  v_actor_is_admin boolean;
  v_starts_at timestamptz;
begin
  v_caller_user_id := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  if v_caller_user_id is null or p_actor_user_id is distinct from v_caller_user_id then
    raise insufficient_privilege using message = 'transition actor does not match caller';
  end if;

  v_actor_provider_id := current_provider_id();
  v_actor_is_admin := is_admin();

  select a.* into v_appointment
    from appointments a
   where a.id = p_appointment_id
   for update;

  if not found then
    raise insufficient_privilege using message = 'appointment is not available to caller';
  end if;

  select s.starts_at into strict v_starts_at from slots s where s.id = v_appointment.slot_id;

  -- Match the route's provider-before-admin-before-patient resolution. A user
  -- with an unrelated provider row cannot fall back to their patient link.
  if v_actor_provider_id is not null then
    if v_actor_provider_id is distinct from v_appointment.provider_id then
      raise insufficient_privilege using message = 'appointment is not available to caller';
    end if;
  elsif not v_actor_is_admin then
    return query select 'invalid_transition'::text,
      null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  -- Cancellation has its own RPC because patient notice rules differ from
  -- clinician rules. This boundary accepts only clinician lifecycle edges.
  if not (
       (v_appointment.status = 'requested' and p_status = 'confirmed')
    or (v_appointment.status = 'confirmed'
        and p_status in ('completed', 'no_show')
        and v_starts_at < now())
  ) then
    return query select 'invalid_transition'::text,
      null::uuid, null::timestamptz, null::timestamptz,
      null::appointment_status, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  update appointments set status = p_status where id = v_appointment.id;
  insert into appointment_transitions (appointment_id, from_status, to_status, actor_user_id)
  values (v_appointment.id, v_appointment.status, p_status, p_actor_user_id);
  insert into audit_events (
    actor_kind, actor_ref, action, target_kind, target_id, outcome
  ) values (
    'account', p_actor_user_id::text, 'appointment.transition',
    'appointment', v_appointment.id, 'granted'
  );

  return query
  select null::text, a.id, s.starts_at, s.ends_at, a.status,
         p.full_name, p.time_zone, sv.name, a.out_of_hours
    from appointments a
    join slots s on s.id = a.slot_id
    join providers p on p.id = a.provider_id
    join services sv on sv.id = a.service_id
   where a.id = v_appointment.id;
end $$;

grant create on schema public to booking_executor;
alter function transition_appointment(uuid, appointment_status, uuid) owner to booking_executor;
revoke create on schema public from booking_executor;
revoke all on function transition_appointment(uuid, appointment_status, uuid) from public;
grant execute on function transition_appointment(uuid, appointment_status, uuid) to app_user;

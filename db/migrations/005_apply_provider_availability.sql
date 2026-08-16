-- JOR-198: PostgREST has no client-side transaction spanning table writes.
-- This narrow RPC replaces the provider's availability configuration, calls
-- the sole slot-removal function, and recomputes every live appointment flag
-- in one database transaction. The application role still receives no DELETE
-- or UPDATE privilege on these tables.
create or replace function apply_provider_availability(
  p_provider_id  uuid,
  p_slot_minutes int,
  p_working_hours jsonb,
  p_blocks       jsonb,
  p_from         timestamptz,
  p_to           timestamptz,
  p_slots        tstzrange[]
) returns table (
  removed_open_slots int,
  generated_open_slots int,
  preserved_out_of_hours jsonb
)
language plpgsql security definer set search_path = public as $$
declare
  v_removed int;
  v_generated int;
  v_time_zone text;
begin
  if p_slot_minutes < 5 or p_slot_minutes > 240 or p_from >= p_to then
    raise exception 'invalid availability input' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_slots, array[]::tstzrange[])) r
     where isempty(r) or lower_inf(r) or upper_inf(r)
        or lower(r) < p_from or upper(r) > p_to
  ) then
    raise exception 'slot outside regeneration window' using errcode = 'check_violation';
  end if;

  select time_zone into strict v_time_zone from providers where id = p_provider_id for update;

  -- The route guard is the user-facing ownership seam; the RPC repeats it so
  -- a caller cannot bypass that route by invoking PostgREST directly.
  if session_user <> 'postgres'
     and (auth.uid() is null
       or not exists (select 1 from providers where id = p_provider_id and user_id = auth.uid())
          and not is_admin()) then
    raise insufficient_privilege using message = 'availability target is not owned by caller';
  end if;

  delete from working_hours where provider_id = p_provider_id;
  insert into working_hours (provider_id, weekday, starts_local, ends_local)
  select p_provider_id, x.weekday, x."startsLocal", x."endsLocal"
    from jsonb_to_recordset(coalesce(p_working_hours, '[]'::jsonb))
         as x(weekday int, "startsLocal" time, "endsLocal" time);

  delete from availability_blocks where provider_id = p_provider_id;
  insert into availability_blocks (provider_id, starts_at, ends_at, reason)
  select p_provider_id, x."startsAt", x."endsAt", x.reason
    from jsonb_to_recordset(coalesce(p_blocks, '[]'::jsonb))
         as x("startsAt" timestamptz, "endsAt" timestamptz, reason text);

  update providers set slot_minutes = p_slot_minutes where id = p_provider_id;

  select removed, generated into v_removed, v_generated
    from regenerate_provider_slots(p_provider_id, p_from, p_to, coalesce(p_slots, array[]::tstzrange[]));

  update appointments a
     set out_of_hours = not (
       exists (
         select 1
           from slots s
           join working_hours wh on wh.provider_id = a.provider_id
          where s.id = a.slot_id
            and wh.weekday = extract(dow from s.starts_at at time zone v_time_zone)::int
            and (s.starts_at at time zone v_time_zone)::date = (s.ends_at at time zone v_time_zone)::date
            and (s.starts_at at time zone v_time_zone)::time >= wh.starts_local
            and (s.ends_at at time zone v_time_zone)::time <= wh.ends_local
            and s.ends_at - s.starts_at = make_interval(mins => p_slot_minutes)
            and mod(
              extract(epoch from ((s.starts_at at time zone v_time_zone)::time - wh.starts_local))::int,
              p_slot_minutes * 60
            ) = 0
       )
       and not exists (
         select 1 from slots s
         join availability_blocks b on b.provider_id = a.provider_id
          where s.id = a.slot_id
            and tstzrange(s.starts_at, s.ends_at) && tstzrange(b.starts_at, b.ends_at)
       )
     )
   where a.provider_id = p_provider_id
     and a.status in ('requested', 'confirmed');

  return query
  select v_removed,
         v_generated,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'appointmentId', a.id,
               'startsAt', s.starts_at,
               'endsAt', s.ends_at,
               'patientRef', p.patient_ref
             ) order by s.starts_at
           ) filter (where a.id is not null),
           '[]'::jsonb
         )
    from appointments a
    join slots s on s.id = a.slot_id
    join patients p on p.id = a.patient_id
   where a.provider_id = p_provider_id
     and a.status in ('requested', 'confirmed')
     and a.out_of_hours;
end $$;

revoke all on function apply_provider_availability(uuid,int,jsonb,jsonb,timestamptz,timestamptz,tstzrange[]) from public;
grant execute on function apply_provider_availability(uuid,int,jsonb,jsonb,timestamptz,timestamptz,tstzrange[]) to app_user;

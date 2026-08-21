-- Study-detail and cine-manifest routes used to spend three sequential
-- PostgREST requests on the patient identity link, target ownership, and the
-- awaited audit append. Keep those decisions at the existing PHI guard seam,
-- but execute them in one caller-scoped transaction. SECURITY INVOKER is
-- load-bearing: the caller's table grants and RLS policies still apply.
create or replace function grant_patient_imaging_access(
  p_target_kind text,
  p_target_id uuid
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  -- Hosted PostgREST supplies the verified JWT as this transaction-local
  -- setting. Reading its subject directly keeps this SECURITY INVOKER
  -- function from requiring privileges on Supabase's auth schema.
  v_actor_id uuid := (
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_patient_id uuid;
  v_action text;
  v_allowed boolean := false;
  v_status integer;
begin
  if v_actor_id is null then
    raise insufficient_privilege using message = 'authenticated account required';
  end if;

  case p_target_kind
    when 'study' then v_action := 'study.view';
    when 'clip' then v_action := 'clip.view';
    else raise invalid_parameter_value using message = 'unsupported imaging target';
  end case;

  v_patient_id := current_patient_id();
  if v_patient_id is null then
    v_status := 403;
  else
    if p_target_kind = 'study' then
      select exists (
        select 1
          from studies
         where id = p_target_id
           and patient_id = v_patient_id
      ) into v_allowed;
    else
      select exists (
        select 1
          from cine_clips
         where id = p_target_id
           and patient_id = v_patient_id
      ) into v_allowed;
    end if;
    v_status := case when v_allowed then 200 else 404 end;
  end if;

  insert into audit_events (
    actor_kind,
    actor_ref,
    action,
    target_kind,
    target_id,
    outcome
  ) values (
    'account',
    v_actor_id::text,
    v_action,
    p_target_kind,
    p_target_id,
    case when v_allowed then 'granted' else 'denied' end
  );

  return jsonb_build_object(
    'patient_id', case when v_allowed then v_patient_id else null end,
    'status', v_status
  );
end $$;

revoke all on function grant_patient_imaging_access(text, uuid) from public;
do $$
declare v_role text;
begin
  for v_role in
    select rolname
      from pg_roles
     where rolname in ('anon', 'authenticated', 'service_role')
  loop
    execute format(
      'revoke execute on function grant_patient_imaging_access(text, uuid) from %I',
      v_role
    );
  end loop;
end $$;
grant execute on function grant_patient_imaging_access(text, uuid) to app_user;

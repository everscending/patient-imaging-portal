-- The study-detail route spent one PostgREST round classifying the caller
-- (staff_admins + providers) before a second round decided access. Both reads
-- resolve the same caller identity, so fold them together: classify, decide,
-- and append the one required audit row in a single caller-scoped round.
-- SECURITY INVOKER is load-bearing for the same reason as migration 010 — the
-- caller's own table grants and RLS policies still apply underneath the
-- explicit relationship checks below, so a definer bypass can never widen what
-- this returns. Migration 010's patient-only grant stays for the cine-manifest
-- route, which admits no provider or admin actor.
create or replace function grant_study_access(p_study_id uuid)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  -- The classification helpers below read the subject through auth.uid(), so
  -- this function has to agree with them on every runtime. Migration 009's
  -- adapter is the one reader that accepts both the hosted claims object and
  -- the local PostgREST compatibility setting; reading the claim directly here
  -- would raise on the local runtime while the helpers still resolved.
  v_actor_id uuid := current_request_user_id();
  v_actor_kind text;
  v_provider_id uuid;
  v_patient_id uuid;
  v_study_patient_id uuid;
  v_visit_provider_id uuid;
  v_allowed boolean := false;
  v_status integer;
begin
  if v_actor_id is null then
    raise insufficient_privilege using message = 'authenticated account required';
  end if;

  -- Same precedence the route's two-query classification used: an account that
  -- is both staff and a provider keeps its admin authority.
  if is_admin() then
    v_actor_kind := 'admin';
  else
    v_provider_id := current_provider_id();
    v_actor_kind := case when v_provider_id is null then 'patient' else 'provider' end;
  end if;

  select s.patient_id, v.provider_id
    into v_study_patient_id, v_visit_provider_id
    from studies s
    left join visits v on v.id = s.visit_id
   where s.id = p_study_id;

  if v_actor_kind = 'patient' then
    v_patient_id := current_patient_id();
    if v_patient_id is null then
      -- An authenticated account with no identity link is not a patient yet,
      -- and must not learn whether the study exists (ADR-0011).
      v_status := 403;
    else
      v_allowed := v_study_patient_id is not null and v_study_patient_id = v_patient_id;
      v_status := case when v_allowed then 200 else 404 end;
    end if;
  else
    v_allowed := v_study_patient_id is not null
      and (v_actor_kind = 'admin' or v_visit_provider_id = v_provider_id);
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
    'study.view',
    'study',
    p_study_id,
    case when v_allowed then 'granted' else 'denied' end
  );

  return jsonb_build_object(
    'actor_kind', v_actor_kind,
    'patient_id', case when v_allowed then v_study_patient_id else null end,
    'status', v_status
  );
end $$;

revoke all on function grant_study_access(uuid) from public;
do $$
declare v_role text;
begin
  for v_role in
    select rolname
      from pg_roles
     where rolname in ('anon', 'authenticated', 'service_role')
  loop
    execute format(
      'revoke execute on function grant_study_access(uuid) from %I',
      v_role
    );
  end loop;
end $$;
grant execute on function grant_study_access(uuid) to app_user;
-- 009 granted its adapter to booking_executor only; app_user calls it now too.
grant execute on function current_request_user_id() to app_user;

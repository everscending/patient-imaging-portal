-- Hosted PostgREST exposes the authenticated JWT as one JSON setting. The
-- executor-owned appointment RPCs cannot call auth.uid() without broader auth
-- schema privileges, so keep their narrow adapter here.
create or replace function current_request_user_id() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  return (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
exception when invalid_text_representation then
  return null;
end $$;

revoke all on function current_request_user_id() from public;
grant execute on function current_request_user_id() to booking_executor;

create or replace function current_patient_id() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  return (select id from patients where user_id = auth.uid());
exception when invalid_text_representation then
  return null;
end
$$;

create or replace function current_provider_id() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  return (select id from providers where user_id = auth.uid());
exception when invalid_text_representation then
  return null;
end
$$;

create or replace function is_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (select 1 from staff_admins where user_id = auth.uid());
exception when invalid_text_representation then
  return false;
end
$$;

-- These functions are owned by their non-login executor. PostgreSQL requires
-- replacing the full definition to change one expression, so retrieve each
-- definition and replace only the reviewed legacy subject read. Abort if a
-- prior migration no longer has exactly that shape.
grant create on schema public to booking_executor;
set role booking_executor;

do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_legacy constant text := 'nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
begin
  foreach v_signature in array array[
    'book_appointment(uuid,uuid,uuid,text,uuid)'::regprocedure,
    'reschedule_appointment(uuid,uuid,uuid,interval)'::regprocedure,
    'cancel_appointment(uuid,uuid,interval)'::regprocedure,
    'transition_appointment(uuid,appointment_status,uuid)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_signature);
    if length(v_definition) - length(replace(v_definition, v_legacy, '')) <> length(v_legacy) then
      raise exception 'expected one legacy JWT subject read in %', v_signature;
    end if;
    execute replace(v_definition, v_legacy, 'current_request_user_id()');
  end loop;
end $$;

reset role;
revoke create on schema public from booking_executor;

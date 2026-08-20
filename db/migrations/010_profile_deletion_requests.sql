-- JOR-219: one open deletion request is a lifecycle rule, not one row per
-- status. Terminal history may repeat; received and in_review may not coexist.
alter table deletion_requests
  drop constraint deletion_requests_patient_id_status_key;

create unique index deletion_requests_one_open_per_patient
  on deletion_requests (patient_id)
  where status in ('received', 'in_review');

-- The caller may execute the transaction but may not forge its persisted
-- patient, actor, status, or timestamp through the table API.
revoke insert on deletion_requests from app_user;
drop policy deletion_requests_insert_own on deletion_requests;

create or replace function request_profile_deletion(
  p_request_valid boolean
) returns table (
  result_error text,
  request_status text,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_user_id uuid;
  v_patient_id uuid;
  v_requested_at timestamptz;
begin
  v_actor_user_id := current_request_user_id();
  if v_actor_user_id is null then
    raise insufficient_privilege using message = 'deletion request caller is unavailable';
  end if;

  select id into v_patient_id from patients where user_id = v_actor_user_id;

  if p_request_valid is not true then
    insert into audit_events (actor_kind, actor_ref, action, target_kind, target_id, outcome)
    values ('account', v_actor_user_id::text, 'profile.deletion_request', 'patient', v_patient_id, 'denied');
    return query select 'validation_failed'::text, null::text, null::timestamptz;
    return;
  end if;

  if v_patient_id is null then
    insert into audit_events (actor_kind, actor_ref, action, target_kind, target_id, outcome)
    values ('account', v_actor_user_id::text, 'profile.deletion_request', 'patient', null, 'denied');
    return query select 'identity_verification_required'::text, null::text, null::timestamptz;
    return;
  end if;

  begin
    insert into deletion_requests (patient_id, requested_by)
    values (v_patient_id, v_actor_user_id)
    returning deletion_requests.requested_at into v_requested_at;
  exception when unique_violation then
    insert into audit_events (actor_kind, actor_ref, action, target_kind, target_id, outcome)
    values ('account', v_actor_user_id::text, 'profile.deletion_request', 'patient', v_patient_id, 'denied');
    return query select 'request_already_open'::text, null::text, null::timestamptz;
    return;
  end;

  insert into audit_events (actor_kind, actor_ref, action, target_kind, target_id, outcome)
  values ('account', v_actor_user_id::text, 'profile.deletion_request', 'patient', v_patient_id, 'granted');

  return query select null::text, 'received'::text, v_requested_at;
end $$;

revoke all on function request_profile_deletion(boolean) from public;
grant execute on function request_profile_deletion(boolean) to app_user;

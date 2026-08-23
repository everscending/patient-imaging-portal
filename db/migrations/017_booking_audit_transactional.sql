-- Sync-report finding D2 / SEC-4: booking.create audit rows must commit in
-- the same transaction as the booking decision (ADR-0014). Previously the
-- granted row was written after the RPC by lib/scheduling/booking.ts through
-- recordAuditEvent — a writer that deliberately swallows persistence
-- failures — so a crash between the RPC commit and that call left a
-- committed appointment with zero audit rows, and refusals wrote no row at
-- all. The 006 body is untouched: it is renamed to book_appointment_impl and
-- wrapped by an audited book_appointment that runs in the same transaction.
--
-- Audit shape, matching 007/008's in-function rows:
--   granted → target_kind 'appointment' (fresh create AND the EC-10 replay:
--             one row per request, a replay is a real access)
--   denied  → target_kind 'slot', target_id = the contested slot, covering
--             slot_unavailable, idempotency_key_reused, service_not_offered
-- 'slot' as a target kind is new to audit rows; pin it in ARCHITECTURE §3's
-- audit-target prose alongside this migration's doc pass.
-- The actor-mismatch raise (insufficient_privilege) still propagates
-- unaudited: it aborts the transaction by design, and the route surfaces it
-- as a 503, never a nominal refusal.

alter function book_appointment(uuid, uuid, uuid, text, uuid)
  rename to book_appointment_impl;

-- The impl is an internal seam now: only its owner (booking_executor, who
-- owns and runs the wrapper) may call it.
revoke all on function book_appointment_impl(uuid, uuid, uuid, text, uuid) from public;
revoke execute on function book_appointment_impl(uuid, uuid, uuid, text, uuid) from app_user;

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
  rec record;
begin
  select * into rec
    from book_appointment_impl(p_patient_id, p_slot_id, p_service_id, p_idempotency_key, p_actor_user_id);

  if rec.result_error is not null then
    insert into audit_events (
      actor_kind, actor_ref, action, target_kind, target_id, outcome
    ) values (
      'account', p_actor_user_id::text, 'booking.create',
      'slot', p_slot_id, 'denied'
    );
  else
    insert into audit_events (
      actor_kind, actor_ref, action, target_kind, target_id, outcome
    ) values (
      'account', p_actor_user_id::text, 'booking.create',
      'appointment', rec.appointment_id, 'granted'
    );
  end if;

  return query select
    rec.result_error, rec.result_reused, rec.appointment_id,
    rec.appointment_slot_id, rec.starts_at, rec.ends_at,
    rec.appointment_status, rec.provider_name, rec.provider_time_zone,
    rec.service_name, rec.out_of_hours;
end $$;

-- Same ownership dance as 006: the executor owns the SECURITY DEFINER
-- surface, and only app_user may call the public wrapper.
grant create on schema public to booking_executor;
alter function book_appointment(uuid, uuid, uuid, text, uuid) owner to booking_executor;
revoke create on schema public from booking_executor;
revoke all on function book_appointment(uuid, uuid, uuid, text, uuid) from public;
grant execute on function book_appointment(uuid, uuid, uuid, text, uuid) to app_user;

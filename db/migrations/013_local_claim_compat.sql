-- Migration 009_hosted_jwt_claims.sql was edited in place after the live
-- stack had already applied it, which silently broke append-only migrations
-- (JOR-317). It is now restored byte-for-byte to what live already ran.
-- This migration carries forward the in-place edit's actual intent: local
-- PostgREST supplies request.jwt.claim.sub rather than the hosted claims
-- object, so current_request_user_id() needs a fallback to resolve on a
-- local runtime. Malformed hosted claims still reach the exception below and
-- fail closed.
create or replace function current_request_user_id() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_claims text;
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  if v_claims is not null then
    return (v_claims::jsonb ->> 'sub')::uuid;
  end if;
  return nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
exception when invalid_text_representation then
  return null;
end $$;

grant execute on function current_patient_id() to booking_executor;
grant execute on function current_provider_id() to booking_executor;
grant execute on function is_admin() to booking_executor;

-- JOR-254 round 3: the ticket's pinned design decision and AC1 require that a
-- successful FR-2 verification's write to `patients.user_id` and its
-- `identity_attempts` success row commit or fail together, in one
-- transaction. Two sequential PostgREST calls through serviceClient()
-- (`@supabase/supabase-js`) are two independent statements with nothing
-- between them — a process death or a failed second call between them left
-- `patients.user_id` permanently set (no unlock/expiry, ADR-0011) with no
-- matching successful attempt row and no audit trail. A single Postgres
-- function, called once via `.rpc(...)`, gets both writes into the one
-- transaction its own function body already runs in — no client-side
-- transaction control needed or available over PostgREST.
--
-- Only the linked_now path moves here (`lib/access/identity.ts`'s
-- `attemptLink`): the conditional `UPDATE ... WHERE user_id IS NULL` and the
-- succeeded=true `identity_attempts` insert. The failure-path attempt inserts
-- and the plain reads that distinguish already_by_caller from
-- claimed_by_other are unaffected — nothing in the round-2 rejection was
-- about them.
create or replace function link_patient_identity(
  p_patient_id            uuid,
  p_caller_id             uuid,
  p_attempted_patient_ref text,
  p_source_ref            text,
  p_attempted_at          timestamptz
) returns text
language plpgsql security definer set search_path = public as $$
declare v_updated int;
begin
  update patients
     set user_id = p_caller_id
   where id = p_patient_id
     and user_id is null;
  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    insert into identity_attempts (attempted_patient_ref, source_ref, user_id, succeeded, attempted_at)
    values (p_attempted_patient_ref, p_source_ref, p_caller_id, true, p_attempted_at);
    return 'linked_now';
  end if;

  -- The update matched zero rows either because this exact caller already
  -- holds the link (a harmless repeat submission, ADR-0011) or because
  -- someone else won the race — distinguishing them is a plain read, not a
  -- write, so it carries no atomicity requirement of its own.
  if exists (select 1 from patients where id = p_patient_id and user_id = p_caller_id) then
    return 'already_by_caller';
  end if;

  return 'claimed_by_other';
end $$;

-- `revoke ... from public` alone is not enough on Supabase: newly created
-- functions in `public` get separate, explicit EXECUTE grants to `anon`,
-- `authenticated` and `service_role` at creation time, none of which are
-- inherited through `public` and so none of which this revoke touches.
-- `security definer` plus PostgREST's auto-exposure of every public-schema
-- function as `POST /rest/v1/rpc/<name>` means an ungated `authenticated`
-- grant would let any signed-in caller link an arbitrary patient with no
-- reference match, no date-of-birth check, no attempt row and no lockout —
-- the exact bypass this ticket's "verification is the only writer of
-- patients.user_id" rule forbids. Nobody but the service role may call this
-- function; `app_user` is this project's local stand-in for `authenticated`
-- (db/migrations/001_core.sql:24).
revoke all on function link_patient_identity(uuid, uuid, text, text, timestamptz) from public;
revoke execute on function link_patient_identity(uuid, uuid, text, text, timestamptz) from app_user;

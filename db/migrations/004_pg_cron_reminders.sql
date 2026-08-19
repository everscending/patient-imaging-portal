-- A pre-send row deliberately uses outcome = 'failed' (ADR-0012), so outcome
-- alone cannot distinguish an active claim from a provider-confirmed failure.
-- retryable_at makes an explicit provider failure immediately eligible;
-- attempted_at leases an ambiguous pre-send claim for one scheduler cadence,
-- after which a crashed worker is considered abandoned.
alter table reminder_sends add column retryable_at timestamptz;

create or replace function claim_reminder_send(
  p_appointment_id uuid,
  p_lead_hours integer,
  p_claim_lease_minutes integer
) returns boolean
language plpgsql
set search_path = public
as $$
begin
  if p_claim_lease_minutes < 1 then
    raise exception 'claim lease must be at least one minute';
  end if;

  insert into reminder_sends (appointment_id, lead_hours, outcome, retryable_at)
  values (p_appointment_id, p_lead_hours, 'failed', null)
  on conflict do nothing;

  if found then
    return true;
  end if;

  -- Concurrent UPDATEs serialize on the existing row and re-check this
  -- predicate after the lock is released. Exactly one caller can clear an
  -- explicit retry marker or recover an abandoned claim. A live claim remains
  -- protected for the full configured scheduler cadence.
  update reminder_sends
     set attempted_at = clock_timestamp(), retryable_at = null
   where appointment_id = p_appointment_id
     and lead_hours = p_lead_hours
     and outcome = 'failed'
     and (
       (retryable_at is not null and retryable_at <= statement_timestamp())
       or (
         retryable_at is null
         and attempted_at <= statement_timestamp() - make_interval(mins => p_claim_lease_minutes)
       )
     );

  return found;
end
$$;

-- The service-role reminder job is the only caller. Supabase grants its
-- service_role explicitly; the stock harness calls as the migration owner.
revoke all on function claim_reminder_send(uuid, integer, integer) from public;
revoke execute on function claim_reminder_send(uuid, integer, integer) from app_user;

-- JOR-193: production scheduling is optional in the stock-Postgres test image.
-- Hosted deployments install these extensions before this migration runs.
do $$ begin
  create extension if not exists pg_cron;
exception when undefined_file or feature_not_supported then
  raise notice 'pg_cron unavailable in this Postgres image';
end $$;
do $$ begin
  create extension if not exists pg_net;
exception when undefined_file or feature_not_supported then
  raise notice 'pg_net unavailable in this Postgres image';
end $$;

-- The interval must stay shorter than the reminder window: a wider cadence
-- leaves an unexamined due band. REMINDER_CRON_MINUTES supplies */5 by default.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net')
     and nullif(current_setting('app.app_base_url', true), '') is not null
     and nullif(current_setting('app.cron_secret', true), '') is not null
     and nullif(current_setting('app.reminder_cron_minutes', true), '') is not null then
    perform cron.schedule(
      'patient-imaging-reminders',
      '*/' || current_setting('app.reminder_cron_minutes', true) || ' * * * *',
      format($job$
        select net.http_post(
          url := %L,
          headers := jsonb_build_object('x-cron-secret', %L)
        );
      $job$,
        current_setting('app.app_base_url', true) || '/api/jobs/reminders',
        current_setting('app.cron_secret', true)
      )
    );
  else
    raise notice 'reminder cron not scheduled until deployment configuration is provisioned';
  end if;
end $$;

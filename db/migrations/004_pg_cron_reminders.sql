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

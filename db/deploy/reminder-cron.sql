-- Run through scripts/configure-reminder-cron.sh after migrations. Values are
-- read from its environment; no deployment URL or secret belongs in Git.
\set ON_ERROR_STOP on
\getenv app_base_url APP_BASE_URL
\getenv cron_secret CRON_SECRET
\getenv reminder_cron_minutes REMINDER_CRON_MINUTES

-- \gset consumes the result instead of printing values, so the secret never
-- appears in deployment output. The settings only need to live for this
-- session: cron.schedule stores the resulting command and cadence.
select
  set_config('app.app_base_url', :'app_base_url', false) as configured_app_base_url,
  set_config('app.cron_secret', :'cron_secret', false) as configured_cron_secret,
  set_config('app.reminder_cron_minutes', :'reminder_cron_minutes', false) as configured_reminder_cron_minutes
\gset

do $schedule$
declare
  old_job bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_cron and pg_net must be installed before configuring reminders';
  end if;

  for old_job in
    select jobid from cron.job where jobname = 'patient-imaging-reminders'
  loop
    perform cron.unschedule(old_job);
  end loop;

  -- The interval must remain shorter than REMINDER_WINDOW_MINUTES. The shell
  -- validates that invariant before this SQL is sent to Postgres.
  perform cron.schedule(
    'patient-imaging-reminders',
    '*/' || current_setting('app.reminder_cron_minutes') || ' * * * *',
    format($job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object('x-cron-secret', %L)
      );
    $job$,
      current_setting('app.app_base_url') || '/api/jobs/reminders',
      current_setting('app.cron_secret')
    )
  );
end
$schedule$;

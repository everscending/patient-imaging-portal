#!/usr/bin/env bash
# Provision the Postgres-owned reminder scheduler from deployment secrets.
set -euo pipefail

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || { echo "configure-reminder-cron: missing $name" >&2; exit 2; }
}

require_env PGHOST
require_env PGDATABASE
require_env PGUSER
require_env PGPASSWORD
require_env APP_BASE_URL
require_env CRON_SECRET

REMINDER_CRON_MINUTES="${REMINDER_CRON_MINUTES:-5}"
REMINDER_WINDOW_MINUTES="${REMINDER_WINDOW_MINUTES:-30}"
case "$REMINDER_CRON_MINUTES" in
  ''|*[!0-9]*) echo "configure-reminder-cron: REMINDER_CRON_MINUTES must be a positive integer" >&2; exit 2 ;;
esac
case "$REMINDER_WINDOW_MINUTES" in
  ''|*[!0-9]*) echo "configure-reminder-cron: REMINDER_WINDOW_MINUTES must be a positive integer" >&2; exit 2 ;;
esac
if [ "$REMINDER_CRON_MINUTES" -lt 1 ] || [ "$REMINDER_CRON_MINUTES" -gt 59 ]; then
  echo "configure-reminder-cron: REMINDER_CRON_MINUTES must be between 1 and 59" >&2
  exit 2
fi
if [ "$REMINDER_WINDOW_MINUTES" -lt 1 ] || [ "$REMINDER_CRON_MINUTES" -ge "$REMINDER_WINDOW_MINUTES" ]; then
  echo "configure-reminder-cron: REMINDER_CRON_MINUTES must be smaller than REMINDER_WINDOW_MINUTES" >&2
  exit 2
fi
case "$APP_BASE_URL" in
  https://?*) ;;
  *) echo "configure-reminder-cron: APP_BASE_URL must be an https URL" >&2; exit 2 ;;
esac

# psql's \getenv reads these without placing the secret in a SQL argument or
# generated file. The fixed, reviewed SQL file owns all statements.
export APP_BASE_URL="${APP_BASE_URL%/}" CRON_SECRET REMINDER_CRON_MINUTES REMINDER_WINDOW_MINUTES
exec psql -v ON_ERROR_STOP=1 -f db/deploy/reminder-cron.sql

#!/usr/bin/env bash
# Credential-free local Supabase runtime for DEL-4 wiring checks.
set -euo pipefail

SUPABASE_CLI='supabase@2.115.0'

runtime_env() {
  if [[ -x /opt/homebrew/opt/libpq/bin/psql ]]; then
    export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
  fi
  # CLI output stays in this process; it is never written to a file.
  eval "$(npx --yes "$SUPABASE_CLI" status --output env)"
  export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
  export NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
  export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
  export SOURCE_REF_SALT=local-del4-source-ref-salt
  export APP_BASE_URL="http://127.0.0.1:${PORT:-45308}"
  export PGHOST=127.0.0.1 PGPORT=55482 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres
}

grant_local_service_role() {
  psql -X -q -v ON_ERROR_STOP=1 -c '
    grant usage on schema public to service_role;
    grant all privileges on all tables in schema public to service_role;
    grant all privileges on all sequences in schema public to service_role;
    grant execute on all functions in schema public to service_role;
    alter default privileges in schema public grant all privileges on tables to service_role;
    alter default privileges in schema public grant all privileges on sequences to service_role;
    alter default privileges in schema public grant execute on functions to service_role;
  '
}

seeded() {
  [[ "$(psql -X -q -At -c 'select exists (select 1 from app_deploy.seed_runs where singleton);')" == 't' ]]
}

provision() {
  scripts/provision-deployed-stack.sh
  if ! seeded; then
    scripts/provision-deployed-stack.sh
  fi
  seeded
}

start() {
  npx --yes "$SUPABASE_CLI" start >/dev/null || true
  for ((attempt = 0; attempt < 60; attempt++)); do
    if npx --yes "$SUPABASE_CLI" status >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  npx --yes "$SUPABASE_CLI" status >/dev/null
  runtime_env
  grant_local_service_role
  provision
}

reset() {
  npx --yes "$SUPABASE_CLI" stop --no-backup >/dev/null
  for volume in \
    supabase_db_patient-imaging-308 \
    supabase_edge_runtime_patient-imaging-308 \
    supabase_storage_patient-imaging-308; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume rm "$volume" >/dev/null
    fi
  done
  start
}

case "${1:-}" in
  start)
    start
    echo "local DEL-4 runtime ready on http://127.0.0.1:55481"
    ;;
  reset)
    reset
    echo "local DEL-4 runtime reset on http://127.0.0.1:55481"
    ;;
  stop)
    npx --yes "$SUPABASE_CLI" stop --no-backup >/dev/null
    ;;
  run)
    shift
    start
    exec "$@"
    ;;
  *)
    echo "usage: $0 {start|reset|stop|run command...}" >&2
    exit 64
    ;;
esac

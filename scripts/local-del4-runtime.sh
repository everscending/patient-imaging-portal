#!/usr/bin/env bash
# Credential-free local Supabase runtime for DEL-4 wiring checks.
set -euo pipefail

SUPABASE_CLI='supabase@2.115.0'
DEFAULT_PROJECT_ID='patient-imaging-308'
WORKDIR='supabase/.temp/checkout-workdir'

# Each checkout (the main clone, a worktree, a scratch clone) gets its own
# Supabase project id, derived from its absolute path, so the CLI's
# docker containers/volumes never collide across concurrently running
# checkouts (JOR-321). Override with DEL4_PROJECT_ID when a fixed id is
# needed. The tracked supabase/config.toml keeps the default id so the
# documented single-checkout quick start (running the CLI directly) is
# unchanged; everything invoked through this script instead runs against a
# derived copy of that config in $WORKDIR (gitignored, regenerated on every
# run — the tracked file is never touched).
project_id() {
  if [[ -n "${DEL4_PROJECT_ID:-}" ]]; then
    printf '%s' "$DEL4_PROJECT_ID"
    return
  fi
  local hash
  if command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-8)"
  else
    hash="$(printf '%s' "$PWD" | sha256sum | cut -c1-8)"
  fi
  printf 'patient-imaging-%s' "$hash"
}

materialize_workdir() {
  mkdir -p "$WORKDIR/supabase"
  sed "s/^project_id = \"$DEFAULT_PROJECT_ID\"\$/project_id = \"$(project_id)\"/" \
    supabase/config.toml > "$WORKDIR/supabase/config.toml"
}

supabase_cli() {
  materialize_workdir
  npx --yes "$SUPABASE_CLI" --workdir "$WORKDIR" "$@"
}

runtime_env() {
  if [[ -x /opt/homebrew/opt/libpq/bin/psql ]]; then
    export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
  fi
  # CLI output stays in this process; it is never written to a file.
  eval "$(supabase_cli status --output env)"
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
  supabase_cli start >/dev/null || true
  for ((attempt = 0; attempt < 60; attempt++)); do
    if supabase_cli status >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  supabase_cli status >/dev/null
  runtime_env
  grant_local_service_role
  provision
}

reset() {
  supabase_cli stop --no-backup >/dev/null
  local id
  id="$(project_id)"
  for volume in \
    "supabase_db_${id}" \
    "supabase_edge_runtime_${id}" \
    "supabase_storage_${id}"; do
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
    supabase_cli stop --no-backup >/dev/null
    ;;
  run)
    shift
    start
    exec "$@"
    ;;
  project-id)
    project_id
    echo
    ;;
  *)
    echo "usage: $0 {start|reset|stop|run command...|project-id}" >&2
    exit 64
    ;;
esac

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

# The committed config pins its ports in the 554xx block. A derived project
# id alone is not enough for two checkouts to coexist — the second start
# fails on "port is already allocated" (proven 2026-08-22: the failure is
# clean, the first stack survives, but coexistence needs distinct ports).
# Derive a per-checkout port base from the same path hash and shift every
# 554xx port by (base - 55480), preserving the config's internal spacing.
# DEL4_PORT_BASE overrides, mirroring DEL4_PROJECT_ID. Consumers read real
# ports from `status --output env`, never from the committed file, so the
# shift is invisible to the harness.
port_base() {
  if [[ -n "${DEL4_PORT_BASE:-}" ]]; then
    printf '%s' "$DEL4_PORT_BASE"
    return
  fi
  local hash
  if command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-4)"
  else
    hash="$(printf '%s' "$PWD" | sha256sum | cut -c1-4)"
  fi
  # 4 hex chars -> 0..65535, folded into 56000..63800 in steps of 200: the
  # config's ports live in two families (554xx and 543xx) that map to
  # base+(port%200), i.e. base+80..89 and base+125..127, so one checkout's
  # block spans <200 ports and blocks 200 apart never straddle.
  printf '%d' $(( 56000 + (16#$hash % 40) * 200 ))
}

materialize_workdir() {
  mkdir -p "$WORKDIR/supabase"
  awk -v base="$(port_base)" -v id="$(project_id)" -v def="$DEFAULT_PROJECT_ID" '
    $0 == "project_id = \"" def "\"" { print "project_id = \"" id "\""; next }
    /^(shadow_)?port = [0-9][0-9][0-9][0-9][0-9]$/ {
      n = $NF; sub(/[0-9]+$/, base + (n % 200)); print; next
    }
    /^inspector_port = [0-9]+$/ {
      # The edge-runtime inspector binds a host port too; its 4-digit value
      # gets its own fold (base+100+(n%50) -> residue 133 for 8083) so the
      # committed residues stay pairwise distinct from the 5-digit family
      # residues (80-84, 89, 127). The derivation test asserts this against
      # the real generated file, not this comment.
      n = $NF; sub(/[0-9]+$/, base + 100 + (n % 50)); print; next
    }
    { print }
  ' supabase/config.toml > "$WORKDIR/supabase/config.toml"
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
  # The DB port is derived per checkout (JOR-321) — read it from the CLI's
  # own DB_URL rather than pinning the committed default, or a second
  # checkout's provisioning would talk to the FIRST checkout's database.
  local db_port
  db_port="$(printf '%s' "$DB_URL" | sed -E 's|.*:([0-9]+)/[^/]*$|\1|')"
  export PGHOST=127.0.0.1 PGPORT="$db_port" PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres
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
  port-base)
    # Dry run for the test harness: print the derived port base, no CLI.
    port_base
    echo
    ;;
  materialize)
    # Dry run for the test harness: print the config exactly as the CLI
    # would receive it, without invoking the CLI.
    materialize_workdir
    cat "$WORKDIR/supabase/config.toml"
    ;;
  start)
    start
    # API_URL is exported by runtime_env from the CLI's own status output —
    # the derived per-checkout port, never the committed default (JOR-321).
    echo "local DEL-4 runtime ready on ${API_URL}"
    ;;
  reset)
    reset
    # reset() ends in start(), which ran runtime_env — API_URL is derived.
    echo "local DEL-4 runtime reset on ${API_URL}"
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

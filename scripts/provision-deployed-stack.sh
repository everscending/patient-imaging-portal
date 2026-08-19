#!/usr/bin/env bash
set -euo pipefail

for required in PGHOST PGDATABASE PGUSER PGPASSWORD NEXT_PUBLIC_SUPABASE_URL \
  NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SOURCE_REF_SALT; do
  if [ -z "${!required:-}" ]; then
    echo "provision-deployed-stack: missing $required" >&2
    exit 2
  fi
done

exec node --conditions=react-server node_modules/vite-node/vite-node.mjs scripts/provision-deployed-stack.ts

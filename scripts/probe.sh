#!/usr/bin/env bash
# Repository-owned browser acceptance entry point for Loom host probes.
# The caller selects a fixed semantic id, never a command or script path.
set -euo pipefail

usage() {
  echo 'usage: scripts/probe.sh e2' >&2
}

if [ "$#" -ne 1 ] || [ "$1" != e2 ]; then
  usage
  exit 64
fi

for required in PORT APP_BASE_URL LOOM_HOST_PROBE_HEAD LOOM_HOST_PROBE_OUTPUT; do
  if [ -z "${!required:-}" ]; then
    echo "scripts/probe.sh: missing required environment: $required" >&2
    exit 64
  fi
done

probe=e2
probe_pid=
probe_log=$(mktemp "${TMPDIR:-/tmp}/pip-host-probe.XXXXXX")
artifact_tmp="${LOOM_HOST_PROBE_OUTPUT}.tmp.$$"

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$probe_pid" ] && kill -0 "$probe_pid" 2>/dev/null; then
    kill "$probe_pid" 2>/dev/null || true
    wait "$probe_pid" 2>/dev/null || true
  fi
  rm -f "$probe_log" "$artifact_tmp"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

write_artifact() {
  local classification="$1" summary="$2"
  PROBE_CLASSIFICATION="$classification" PROBE_SUMMARY="$summary" \
    node - "$artifact_tmp" <<'NODE'
const fs = require('node:fs')

const output = process.argv[2]
const artifact = {
  schema: 1,
  probe: 'e2',
  head: process.env.LOOM_HOST_PROBE_HEAD,
  classification: process.env.PROBE_CLASSIFICATION,
  summary: process.env.PROBE_SUMMARY,
}
fs.writeFileSync(output, `${JSON.stringify(artifact)}\n`, { mode: 0o600 })
NODE
  mv "$artifact_tmp" "$LOOM_HOST_PROBE_OUTPUT"
}

is_infrastructure_failure() {
  [ "$1" -eq 126 ] || [ "$1" -eq 127 ] || grep -Eiq \
    'MachPortRendezvousServer|bootstrap_check_in|browserType\.launch|Executable doesn.t exist|Failed to launch (browser|chromium)|Process from config\.webServer was not able to start|Timed out waiting .*webServer|EADDRINUSE|listen EACCES|spawn .*ENOENT|No tests found' \
    "$probe_log"
}

failure_detail() {
  sed $'s/\033\\[[0-9;]*m//g' "$probe_log" \
    | grep -Ei 'MachPortRendezvousServer|bootstrap_check_in|browserType\.launch|Executable doesn.t exist|Failed to launch|config\.webServer|EADDRINUSE|listen EACCES|spawn .*ENOENT|No tests found|Error:|[0-9]+ failed' \
    | tail -n 2 \
    | tr '\n' ' ' \
    | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' \
    | cut -c1-1000 \
    || true
}

npx playwright test e2e/e2-wiring.spec.ts --project=e2-wiring --no-deps >"$probe_log" 2>&1 &
probe_pid=$!
set +e
wait "$probe_pid"
probe_rc=$?
set -e
probe_pid=
cat "$probe_log"

if [ "$probe_rc" -eq 0 ]; then
  write_artifact pass 'targeted E2 browser acceptance passed'
  exit 0
fi

if is_infrastructure_failure "$probe_rc"; then
  detail=$(failure_detail)
  write_artifact infrastructure "targeted E2 browser acceptance could not start because browser or local-stack infrastructure failed${detail:+: $detail}"
  exit 10
fi

detail=$(failure_detail)
write_artifact fail "targeted E2 browser acceptance failed${detail:+: $detail}"
exit 1

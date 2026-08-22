#!/usr/bin/env bash
# Uptime check against the deployed health endpoint (JOR-252). §9: no default
# host or port lives here — the base URL is always the caller's own argument
# or environment variable, never a guess, so the check can be pointed at any
# environment without editing this file.
#
#   scripts/uptime-check.sh run    <base-url> <log-file> [interval-seconds]
#   scripts/uptime-check.sh report <log-file>
#
# `run` polls forever (stop with SIGTERM/SIGINT) and appends one JSON line per
# poll to the log file — re-running it after a crash just appends more lines,
# it never truncates. `report` reads that same log and prints the window's
# own start/end and three-way state counts; it takes no other input, so the
# figure can never come from anything but the check's own recorded results.
set -euo pipefail

usage() {
  echo "usage: scripts/uptime-check.sh run <base-url> <log-file> [interval-seconds]" >&2
  echo "       scripts/uptime-check.sh report <log-file>" >&2
}

MODE="${1:-}"
case "$MODE" in
  run|report) ;;
  *) usage; exit 64 ;;
esac
shift

if [ "$MODE" = report ]; then
  LOG_FILE="${1:-${UPTIME_CHECK_LOG:-}}"
  [ -n "$LOG_FILE" ] || { echo "scripts/uptime-check.sh: missing log file (argument or UPTIME_CHECK_LOG)" >&2; exit 64; }
  [ -f "$LOG_FILE" ] || { echo "scripts/uptime-check.sh: log file not found: $LOG_FILE" >&2; exit 1; }

  exec node - "$LOG_FILE" <<'NODE'
const fs = require('node:fs')

const logFile = process.argv[2]
const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim().length > 0)

if (lines.length === 0) {
  console.error('scripts/uptime-check.sh: log has no recorded polls — no window to report')
  process.exit(1)
}

const records = lines.map((line) => JSON.parse(line))
const counts = { healthy: 0, degraded: 0, unreachable: 0 }
for (const record of records) counts[record.state] += 1

const total = records.length
const windowStart = records[0].timestamp
const windowEnd = records[records.length - 1].timestamp
// Reachable-but-degraded is not downtime (JOR-252 non-negotiable): only
// "unreachable" counts against availability.
const availability = ((counts.healthy + counts.degraded) / total) * 100

console.log(`Window start (UTC): ${windowStart}`)
console.log(`Window end (UTC): ${windowEnd}`)
console.log(`Total checks: ${total}`)
console.log(`Reachable and healthy: ${counts.healthy}`)
console.log(`Reachable but degraded: ${counts.degraded}`)
console.log(`Unreachable: ${counts.unreachable}`)
console.log(`Availability (reachable, healthy or degraded ÷ total): ${availability.toFixed(2)}%`)
NODE
fi

BASE_URL="${1:-${UPTIME_CHECK_BASE_URL:-}}"
LOG_FILE="${2:-${UPTIME_CHECK_LOG:-}}"
INTERVAL="${3:-${UPTIME_CHECK_INTERVAL_SECONDS:-60}}"

[ -n "$BASE_URL" ] || { echo "scripts/uptime-check.sh: missing base URL (argument or UPTIME_CHECK_BASE_URL)" >&2; exit 64; }
[ -n "$LOG_FILE" ] || { echo "scripts/uptime-check.sh: missing log file (argument or UPTIME_CHECK_LOG)" >&2; exit 64; }
case "$BASE_URL" in
  http://*|https://*) ;;
  *) echo "scripts/uptime-check.sh: base URL must start with http:// or https://" >&2; exit 64 ;;
esac
case "$INTERVAL" in
  ''|*[!0-9]*) echo "scripts/uptime-check.sh: interval must be a positive integer" >&2; exit 64 ;;
esac

mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
echo "scripts/uptime-check.sh: polling ${BASE_URL%/}/api/health every ${INTERVAL}s -> $LOG_FILE" >&2

exec env UPTIME_BASE_URL="$BASE_URL" UPTIME_LOG_FILE="$LOG_FILE" UPTIME_INTERVAL_SECONDS="$INTERVAL" node - <<'NODE'
const fs = require('node:fs')

const baseUrl = process.env.UPTIME_BASE_URL.replace(/\/$/, '')
const logFile = process.env.UPTIME_LOG_FILE
const intervalMs = Number(process.env.UPTIME_INTERVAL_SECONDS) * 1000
const url = `${baseUrl}/api/health`
const PROBE_TIMEOUT_MS = 10000

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { stopping = true })
}

function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function pollOnce() {
  const timestamp = nowUtc()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let record

  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (response.status !== 200) {
      record = { timestamp, state: 'unreachable', http_status: response.status }
    } else {
      const body = await response.json().catch(() => null)
      const database = body && body.database === 'ok' ? 'ok' : 'down'
      const storage = body && body.storage === 'ok' ? 'ok' : 'down'
      const state = database === 'ok' && storage === 'ok' ? 'healthy' : 'degraded'
      record = { timestamp, state, http_status: 200, database, storage }
    }
  } catch {
    record = { timestamp, state: 'unreachable', http_status: null }
  } finally {
    clearTimeout(timer)
  }

  fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`)
  process.stderr.write(`[uptime-check] ${timestamp} ${record.state}\n`)
}

async function main() {
  while (!stopping) {
    await pollOnce()
    if (stopping) break
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

main()
NODE

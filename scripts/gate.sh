#!/usr/bin/env bash
# The repository's own definition of done (ARCHITECTURE.md §15).
# CI, every lane, and every local check invoke this script and only this
# script — no workflow or script calls tsc/eslint/vitest/playwright directly,
# so CI and the lanes cannot drift apart (docs/adr/0012-phase-4-closures.md
# removed the fourth `docs` tier; there are three: logic, api, ui).
set -euo pipefail

VALID_TIERS="logic api ui"

usage() {
  echo "usage: scripts/gate.sh <tier|certification> [--list]" >&2
  echo "valid tiers: logic, api, ui; certification" >&2
}

TIER="${1:-}"
MODE="${2:-run}"

if [[ -z "$TIER" ]]; then
  usage
  exit 1
fi

case "$TIER" in
  logic|api|ui|certification) ;;
  *)
    usage
    exit 1
    ;;
esac

# Runs (or, in --list mode, prints without running) one command of a tier.
# GATE_FAKE_EXIT_<NAME> lets tests force a step's outcome without invoking the
# real toolchain, so gate.sh's own sequencing/propagation logic is verifiable
# without a full tsc/eslint/vitest run on every test invocation.
step() {
  local name="$1"
  shift
  if [[ "$MODE" == "--list" ]]; then
    printf '%s\n' "$*"
    return 0
  fi
  local override_var="GATE_FAKE_EXIT_${name}"
  local override="${!override_var-}"
  echo "[gate:${TIER}] ${name}: $*" >&2
  if [[ -n "$override" ]]; then
    return "$override"
  fi
  "$@"
}

run_logic() {
  step TSC npx tsc --noEmit
  step ESLINT npx eslint .
  step VITEST_UNIT npx vitest run --project unit
}

run_api() {
  run_logic
  step VITEST_INTEGRATION npx vitest run --project integration
}

run_ui() {
  run_api
  step PLAYWRIGHT_PRODUCT npx playwright test --project=product
  step PLAYWRIGHT_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e2-wiring.spec.ts
}

run_certification() {
  step PLAYWRIGHT_CERTIFICATION npx playwright test --project=certification
}

case "$TIER" in
  logic) run_logic ;;
  api) run_api ;;
  ui) run_ui ;;
  certification) run_certification ;;
esac

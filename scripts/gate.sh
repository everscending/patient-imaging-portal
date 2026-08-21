#!/usr/bin/env bash
# The repository's own definition of done (ARCHITECTURE.md §15).
# Per-change CI, every lane, and every local product check invoke this script.
# scripts/certify.sh is the one exception: it launches only the dedicated
# Playwright certification project, whose nested E0 proof returns here for one
# cumulative product UI gate. No other workflow or script calls the test tools
# directly, so product CI and the lanes cannot drift apart
# (docs/adr/0012-phase-4-closures.md removed the fourth `docs` tier; there are
# three: logic, api, ui).
set -euo pipefail

VALID_TIERS="logic api ui"

usage() {
  echo "usage: scripts/gate.sh <tier> [--list]" >&2
  echo "valid tiers: logic, api, ui" >&2
}

TIER="${1:-}"
MODE="${2:-run}"

if [[ -z "$TIER" ]]; then
  usage
  exit 1
fi

case "$TIER" in
  logic|api|ui) ;;
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
  local started=$SECONDS
  local status
  if [[ -n "$override" ]]; then
    status="$override"
  elif "$@"; then
    status=0
  else
    status=$?
  fi
  local duration=$((SECONDS - started))
  echo "[gate:${TIER}] timing ${name}=${duration}s" >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "| ${name} | ${duration}s |" >> "$GITHUB_STEP_SUMMARY"
  fi
  return "$status"
}

run_logic() {
  step TSC npx tsc --noEmit
  step ESLINT npx eslint .
  step VITEST_UNIT npx vitest run --project unit
  step VITEST_COVERAGE_CONTRACT npx vitest run --project unit tests/coverage-config.test.ts
  step VITEST_COVERAGE npx vitest run --coverage --project unit --project integration
}

run_api() {
  run_logic
  step VITEST_ACCESS_GRANT_AUTH npx vitest run --project unit tests/adversarial/cross-patient.test.ts
  step VITEST_TIMING npx vitest run --project unit tests/observability/timing.test.ts
  step VITEST_INTEGRATION npx vitest run --project integration tests/integration tests/scheduling/booking-concurrency.test.ts
  step VITEST_E8 npx vitest run --project e8
}

run_ui() {
  run_api
  # One Playwright process runs every product/wiring project. Playwright
  # resolves the product dependency once, so E2/E3 no longer repeat it.
  step PLAYWRIGHT npx playwright test --project=product --project=e2-wiring --project=e3-wiring --project=e4-wiring --project=e5-wiring --project=e8-wiring
  step PLAYWRIGHT_E8_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e8-wiring.spec.ts
  step PLAYWRIGHT_E10_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e10-wiring.spec.ts
  step PLAYWRIGHT_E5_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e5-wiring.spec.ts
  step PLAYWRIGHT_E7_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e7-wiring.spec.ts
  step PLAYWRIGHT_E12_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e12-wiring.spec.ts
  step PLAYWRIGHT_BOOK_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/book.spec.ts
  step PLAYWRIGHT_PROVIDER_SCHEDULE_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/provider-schedule.spec.ts
  step PLAYWRIGHT_EMPTY_STATES_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/empty-states.spec.ts
  step PLAYWRIGHT_RESPONSIVE_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/responsive.spec.ts
  step PLAYWRIGHT_ACCESSIBILITY_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/accessibility.spec.ts
  step PLAYWRIGHT_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e2-wiring.spec.ts
  step PLAYWRIGHT_E3_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e3-wiring.spec.ts
  step PLAYWRIGHT_E4_REPORT node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/e4-wiring.spec.ts
}

case "$TIER" in
  logic) run_logic ;;
  api) run_api ;;
  ui) run_ui ;;
esac

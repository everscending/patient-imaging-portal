#!/usr/bin/env bash
# Expensive clean-checkout proofs. Normal per-change CI calls gate.sh ui,
# whose product project excludes these wiring specs; certification runs them
# explicitly and serially so their nested installs do not compete for a runner.
set -euo pipefail

started=$SECONDS
if npx playwright test --project=certification --workers=1; then
  result=0
else
  result=$?
fi
duration=$((SECONDS - started))
echo "[certification] timing FRESH_CLONE=${duration}s" >&2
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "| fresh-clone certification | ${duration}s |" >> "$GITHUB_STEP_SUMMARY"
fi
exit "$result"

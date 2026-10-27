#!/usr/bin/env bash
# Merge-law check with a corpus that actually exercises every law.
#
# `fdev verify-merge --state` has no way to supply deltas or summaries, so the
# delta laws (delta_idempotence, delta_permutation_invariance) generate zero
# cases and delta_determinism can only test the self-summary. That is not a pass,
# it is missing material — see BACKLOG #7.
#
# This script generates a replay bundle from the contract's own update path
# (contract/examples/gen_corpus.rs) and then:
#
#   1. runs every law at once and requires 0 violations AND 0 inconclusive;
#   2. runs each law alone and requires it to generate at least one case.
#
# Step 2 is the point: a law with no cases has not been checked, and a run that
# silently drops one reads exactly like a clean bill of health.
#
# Usage: scripts/verify-merge.sh [contract-wasm]
#   CORPUS_DIR overrides the output directory (default /tmp/opencode/number-corpus).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FDEV="${FDEV:-$HOME/.local/bin/fdev}"
WASM="${1:-.build/contract/wasm32-unknown-unknown/release/number_contract.wasm}"
CORPUS="${CORPUS_DIR:-/tmp/opencode/number-corpus}"

case "$WASM" in
  /*) ;;
  *) WASM="$ROOT/$WASM" ;;
esac

command -v cargo >/dev/null || { echo "cargo not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }
[ -f "$WASM" ] || {
  echo "missing contract wasm: $WASM (run 'make contract' first)" >&2
  exit 1
}

json_field() {
  python3 -c '
import json, sys
with open(sys.argv[1]) as fh:
    report = json.load(fh)
value = report[sys.argv[2]]
print(len(value) if isinstance(value, list) else value)
' "$1" "$2"
}

echo "==> corpus"
rm -rf "$CORPUS"
mkdir -p "$CORPUS"
(
  cd "$ROOT/contract"
  cargo run --locked --example gen_corpus -- "$CORPUS" "$WASM"
)

echo "==> full check"
set +e
"$FDEV" verify-merge \
  --bundle "$CORPUS/corpus.bundle" \
  --wasm "$WASM" \
  --json > "$CORPUS/report.json" 2> "$CORPUS/report.err"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "error: fdev verify-merge exited $status" >&2
  sed -n '1,40p' "$CORPUS/report.err" >&2
  [ -s "$CORPUS/report.json" ] && cat "$CORPUS/report.json" >&2
  exit 1
fi

cases="$(json_field "$CORPUS/report.json" cases_run)"
violations="$(json_field "$CORPUS/report.json" violations)"
inconclusive="$(json_field "$CORPUS/report.json" inconclusive)"
deltas="$(json_field "$CORPUS/report.json" corpus_deltas)"
summaries="$(json_field "$CORPUS/report.json" corpus_summaries)"
diagnostics="$(json_field "$CORPUS/report.json" code_diagnostics)"
echo "    $cases cases — $violations violation(s), $inconclusive inconclusive"
echo "    corpus: $deltas delta(s), $summaries summary/summaries"

[ "$violations" -eq 0 ] || { echo "error: violations found; see $CORPUS/report.json" >&2; exit 1; }
[ "$inconclusive" -eq 0 ] || {
  echo "error: $inconclusive case(s) reached no verdict — not a pass" >&2
  exit 1
}
[ "$deltas" -gt 0 ] || { echo "error: corpus carries no deltas" >&2; exit 1; }
[ "$summaries" -gt 0 ] || { echo "error: corpus carries no summaries" >&2; exit 1; }
[ "$diagnostics" -eq 0 ] || {
  echo "error: contract code diagnostics were reported (host clock?)" >&2
  exit 1
}

properties=(
  # Keep in sync with ConformanceProperty::ALL in freenet-core. The full run
  # above checks every law regardless; this list exists to prove each one gets
  # material, so a law added upstream must be added here or it silently loses
  # its coverage assertion.
  state_idempotence
  state_commutativity
  state_associativity
  emitted_state_validity
  update_determinism
  summary_determinism
  delta_determinism
  delta_idempotence
  delta_permutation_invariance
  self_delta_empty
  whole_state_self_delta
  reconciliation_cycle
  path_agreement
  transition_path_agreement
)

echo "==> law coverage"
for property in "${properties[@]}"; do
  set +e
  "$FDEV" verify-merge \
    --bundle "$CORPUS/corpus.bundle" \
    --wasm "$WASM" \
    --property "$property" \
    --json > "$CORPUS/$property.json" 2> "$CORPUS/$property.err"
  property_status=$?
  set -e
  if [ "$property_status" -ne 0 ] || [ ! -s "$CORPUS/$property.json" ]; then
    echo "error: $property generated no checkable cases (exit $property_status)" >&2
    sed -n '1,20p' "$CORPUS/$property.err" >&2
    exit 1
  fi
  property_cases="$(json_field "$CORPUS/$property.json" cases_run)"
  property_inconclusive="$(json_field "$CORPUS/$property.json" inconclusive)"
  [ "$property_cases" -gt 0 ] || {
    echo "error: $property generated 0 cases — the corpus cannot check it" >&2
    exit 1
  }
  [ "$property_inconclusive" -eq 0 ] || {
    echo "error: $property had $property_inconclusive inconclusive case(s)" >&2
    exit 1
  }
  printf '    %-32s %s case(s)\n' "$property" "$property_cases"
done

echo "==> all ${#properties[@]} laws exercised; 0 violations, 0 inconclusive"

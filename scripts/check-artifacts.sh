#!/usr/bin/env bash
# Byte-equality gate: a fresh reproducible build must match the committed
# artifacts in published/ exactly, because those bytes are the contract id and
# the delegate key. Runs in CI on every push and PR.
#
# A mismatch means the committed artifact and the source disagree. Either:
#   - the build is no longer reproducible (toolchain, remap flags, lockfile,
#     wasm-opt), or
#   - the source changed intentionally: append the outgoing contract hash /
#     delegate entry to ui/src/migrations.ts, then run `make record-artifacts`.
#
# Usage: scripts/check-artifacts.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/number-artifacts.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "==> building into a throwaway target dir"
"$ROOT/scripts/build.sh" --target-dir "$TMP/target" --no-ui --no-package

status=0
for crate in contract delegate; do
  fresh="$TMP/target/$crate/wasm32-unknown-unknown/release/number_$crate.wasm"
  committed="$ROOT/published/$crate/number_$crate.wasm"
  if [ ! -f "$committed" ]; then
    echo "MISSING published/$crate/number_$crate.wasm (run 'make record-artifacts')" >&2
    status=1
    continue
  fi
  if cmp -s "$fresh" "$committed"; then
    echo "OK  $crate  sha256 $(sha256sum "$fresh" | cut -d' ' -f1)"
  else
    echo "MISMATCH  $crate" >&2
    sha256sum "$fresh" "$committed" >&2
    echo "  fresh build != committed artifact; see the header of this script." >&2
    status=1
  fi
done

exit "$status"

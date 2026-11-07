#!/usr/bin/env bash
# Byte-equality gate for the room artifact: a fresh reproducible build must
# match published/room/number_room.wasm and the hash recorded in
# published/room/manifest.json.
#
# This is the room sibling of scripts/check-artifacts.sh and is deliberately
# independent: it never touches published/manifest.json, published/contract or
# published/delegate. Runs under `make check-artifacts`.
#
# A mismatch means the source and the committed room artifact disagree. If the
# change was intentional, run `make room-record` (append-only generations).
#
# Usage: scripts/check-room-artifact.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/published/room/manifest.json"
COMMITTED="$ROOT/published/room/number_room.wasm"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/number-room-artifact.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "error: $*" >&2; exit 1; }

[ -f "$MANIFEST" ] || fail "missing published/room/manifest.json (run 'make room-record')"
[ -f "$COMMITTED" ] || \
  fail "missing published/room/number_room.wasm (run 'make room-record')"

echo "==> building room into a throwaway target dir"
"$ROOT/scripts/build.sh" --target-dir "$TMP/target" --crate room --no-ui --no-package

# Exclude release/deps, which carries a same-named copy of the crate artifact.
mapfile -t WASMS < <(find "$TMP/target" -type f -name 'number_room.wasm' \
  -path '*/wasm32-unknown-unknown/release/*' ! -path '*/release/deps/*' -print)
[ "${#WASMS[@]}" -eq 1 ] || \
  fail "expected exactly one number_room.wasm under $TMP/target, found ${#WASMS[@]}"
FRESH="${WASMS[0]}"

if [ ! -d "$ROOT/ui/node_modules" ]; then
  echo "==> ui deps for hashing"
  ( cd "$ROOT/ui" && npm install --silent )
fi
FRESH_HASH="$(cd "$ROOT/ui" && node --input-type=module - "$FRESH" <<'NODE'
import { readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";

const bytes = readFileSync(process.argv[2]);
const hash = blake3(bytes);
process.stdout.write(JSON.stringify({
  codeHash: bs58.encode(hash),
  codeHashHex: Buffer.from(hash).toString("hex"),
  size: bytes.length,
}));
NODE
)"
FRESH_B58="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).codeHash)' "$FRESH_HASH")"
FRESH_HEX="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).codeHashHex)' "$FRESH_HASH")"
FRESH_SIZE="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).size))' "$FRESH_HASH")"

RECORDED_B58="$(node -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).room.codeHash);
' "$MANIFEST")"
RECORDED_HEX="$(node -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).room.codeHashHex);
' "$MANIFEST")"

status=0

if cmp -s "$FRESH" "$COMMITTED"; then
  echo "OK  room  bytes identical  sha256 $(sha256sum "$FRESH" | cut -d' ' -f1)  ($FRESH_SIZE bytes)"
else
  echo "MISMATCH  published/room/number_room.wasm" >&2
  sha256sum "$FRESH" "$COMMITTED" >&2
  echo "  fresh room build != committed artifact; run 'make room-record' if intentional." >&2
  status=1
fi

if [ "$FRESH_B58" = "$RECORDED_B58" ] && [ "$FRESH_HEX" = "$RECORDED_HEX" ]; then
  echo "OK  room  code hash $FRESH_B58"
  echo "OK  room  hash hex  $FRESH_HEX"
else
  echo "MISMATCH  room code hash" >&2
  echo "  fresh:    $FRESH_B58 ($FRESH_HEX)" >&2
  echo "  recorded: $RECORDED_B58 ($RECORDED_HEX)" >&2
  echo "  the committed artifact and published/room/manifest.json disagree with the build." >&2
  status=1
fi

exit "$status"

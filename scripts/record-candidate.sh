#!/usr/bin/env bash
# Record the current reproducible candidate build as the published candidate artifact.
#
# The candidate code hash is BLAKE3 of the RAW wasm32 release WASM (never the fdev
# package), because that hash identifies one candidate generation. This registry is
# deliberately independent of the zone/delegate artifact gate: it never touches
# published/manifest.json, published/contract or published/delegate.
#
# Re-recording is append-only: a previous generation is never dropped from the
# manifest. That keeps every candidate generation reachable for readers that pinned
# an older hash.
#
# Usage: scripts/record-candidate.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/published/candidate/manifest.json"
OUT_DIR="$ROOT/published/candidate"
OUT_WASM="$OUT_DIR/number_candidate.wasm"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/number-candidate-record.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "error: $*" >&2; exit 1; }

# --no-ui is required with a single crate: the UI constants need the zone,
# delegate, room and candidate WASMs. We only build the candidate here.
echo "==> reproducible candidate build"
"$ROOT/scripts/build.sh" --target-dir "$TMP/target" --crate candidate --no-ui --no-package

# Locate the raw release WASM under the throwaway target dir. Exclude
# release/deps, which carries a same-named copy of the crate artifact.
mapfile -t WASMS < <(find "$TMP/target" -type f -name 'number_candidate.wasm' \
  -path '*/wasm32-unknown-unknown/release/*' ! -path '*/release/deps/*' -print)
[ "${#WASMS[@]}" -eq 1 ] || \
  fail "expected exactly one number_candidate.wasm under $TMP/target, found ${#WASMS[@]}"
WASM="${WASMS[0]}"
[ -f "$WASM" ] || fail "missing raw candidate wasm: $WASM"

# Hash the raw bytes. Run inside ui/ so node resolves @noble/hashes and bs58
# from the UI's node_modules, exactly as scripts/build.sh does.
if [ ! -d "$ROOT/ui/node_modules" ]; then
  echo "==> ui deps for hashing"
  ( cd "$ROOT/ui" && npm install --silent )
fi
HASHES="$(cd "$ROOT/ui" && node --input-type=module - "$WASM" <<'NODE'
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

CODE_HASH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).codeHash)' "$HASHES")"
CODE_HASH_HEX="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).codeHashHex)' "$HASHES")"
SIZE="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).size))' "$HASHES")"
[ -n "$CODE_HASH" ] && [ -n "$CODE_HASH_HEX" ] || fail "failed to hash $WASM"

TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$ROOT/rust-toolchain.toml")"
[ -n "$TOOLCHAIN" ] || fail "could not read channel from rust-toolchain.toml"

# The remap namespace is frozen and shared with the zone/delegate manifest.
REMAP_JSON="$(node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  if (!fs.existsSync(path)) process.exit(1);
  const remap = JSON.parse(fs.readFileSync(path, "utf8")).remap;
  if (!remap) process.exit(1);
  process.stdout.write(JSON.stringify(remap));
' "$ROOT/published/manifest.json")" || fail "could not read remap from published/manifest.json"

mkdir -p "$OUT_DIR"
cp "$WASM" "$OUT_WASM"
chmod 0644 "$OUT_WASM"

# Write the sibling manifest. Generations stay newest-first and append-only:
# refusing to write a shorter list makes accidental generation loss visible.
node --input-type=module - "$MANIFEST" "$CODE_HASH" "$CODE_HASH_HEX" "$TOOLCHAIN" \
  "$REMAP_JSON" "$SIZE" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [path, codeHash, codeHashHex, toolchain, remapJson, size] =
  process.argv.slice(2);
const remap = JSON.parse(remapJson);

const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const previousGenerations = previous?.candidate?.generations ?? [];

// Newest-first, append-only. The new hash moves to the front; no existing
// generation is ever removed.
const generations = [codeHash, ...previousGenerations.filter((h) => h !== codeHash)];
for (const old of previousGenerations) {
  if (!generations.includes(old)) {
    throw new Error(`refusing to drop candidate generation ${old}`);
  }
}

const manifest = {
  note:
    "Committed reproducible candidate artifact. `make candidate-check-artifacts` rebuilds " +
    "and compares bytes; `make candidate-record` is the only supported way to change " +
    "this file. This registry is independent of published/manifest.json.",
  toolchain,
  remap,
  candidate: {
    codeHash,
    codeHashHex,
    file: "published/candidate/number_candidate.wasm",
    generations,
  },
};

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.error(`recorded ${size}-byte candidate wasm`);
NODE

echo "==> recorded"
echo "    candidate code hash: $CODE_HASH"
echo "    candidate hash hex:  $CODE_HASH_HEX"
echo "    candidate wasm size: $SIZE bytes"

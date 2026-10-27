#!/usr/bin/env bash
# Record the current reproducible build as the published artifact set.
#
# This is the only supported way to change published/. It rebuilds in a
# throwaway target dir, then refuses to supersede a generation that is not in
# ui/src/migrations.ts, so a WASM change cannot land without a migration path.
#
# Sequence for an intentional re-key:
#   1. append the OUTGOING contract code hash / delegate entry to
#      ui/src/migrations.ts (they are the currently recorded generation);
#   2. make record-artifacts
#   3. re-publish the delegate / website as appropriate.
#
# Usage: scripts/record-artifacts.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/ui/src/migrations.ts"
MANIFEST="$ROOT/published/manifest.json"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/number-record.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "==> reproducible build"
"$ROOT/scripts/build.sh" --target-dir "$TMP/target" --no-package

CONTRACT_HASH="$(tr -d '[:space:]' < "$ROOT/ui/contract_code_hash.txt")"
DELEGATE_HASH="$(tr -d '[:space:]' < "$ROOT/ui/delegate_code_hash.txt")"
DELEGATE_KEY="$(tr -d '[:space:]' < "$ROOT/ui/delegate_key.txt")"
WEBAPP_ID="$(tr -d '[:space:]' < "$ROOT/delegate/webapp_contract_id.txt")"

# The registry gate: every generation that is about to stop being the active
# one must already be registered, so its users have a migration path.
require_registered() {
  local value="$1" what="$2"
  if ! grep -q -F "\"$value\"" "$MIGRATIONS"; then
    cat >&2 <<EOF
error: $what $value is the recorded (deployed) generation but is not in
       ui/src/migrations.ts.

Append it before recording the new artifact:
  - contract: push the hash onto LEGACY_CONTRACT_CODE_HASHES (newest first)
  - delegate: push { key, codeHash, webappId } onto LEGACY_DELEGATES
Then re-run: make record-artifacts
EOF
    exit 1
  fi
}

if [ -f "$MANIFEST" ]; then
  # Read one string field from the manifest; an invalid manifest aborts here.
  manifest_field() {
    node -e '
      const fs = require("node:fs");
      const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let value = manifest;
      for (const key of process.argv[2].split(".")) value = value?.[key];
      if (typeof value !== "string" || !value) process.exit(1);
      process.stdout.write(value);
    ' "$MANIFEST" "$1"
  }

  OLD_CONTRACT_HASH="$(manifest_field contract.codeHash)"
  OLD_DELEGATE_KEY="$(manifest_field delegate.key)"

  [ "$OLD_CONTRACT_HASH" = "$CONTRACT_HASH" ] || \
    require_registered "$OLD_CONTRACT_HASH" "contract code hash"
  if [ "$OLD_DELEGATE_KEY" != "$DELEGATE_KEY" ]; then
    require_registered "$OLD_DELEGATE_KEY" "delegate key"
  fi
  # Defensive: every earlier generation must still be recoverable.
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    [ "$old" = "$CONTRACT_HASH" ] || require_registered "$old" "historical contract code hash"
  done < <(node -e "for (const h of require('$MANIFEST').contract.generations.slice(1)) console.log(h)")
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    [ "$old" = "$DELEGATE_KEY" ] || require_registered "$old" "historical delegate key"
  done < <(node -e "for (const d of require('$MANIFEST').delegate.generations.slice(1)) console.log(d.key)")
else
  echo "==> no existing manifest: recording the first generation"
fi

mkdir -p "$ROOT/published/contract" "$ROOT/published/delegate"
cp "$TMP/target/contract/wasm32-unknown-unknown/release/number_contract.wasm" \
   "$ROOT/published/contract/number_contract.wasm"
cp "$TMP/target/delegate/wasm32-unknown-unknown/release/number_delegate.wasm" \
   "$ROOT/published/delegate/number_delegate.wasm"
chmod 0644 "$ROOT/published/contract/number_contract.wasm" \
           "$ROOT/published/delegate/number_delegate.wasm"

TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$ROOT/rust-toolchain.toml")"

node --input-type=module - "$MANIFEST" "$CONTRACT_HASH" "$DELEGATE_HASH" \
  "$DELEGATE_KEY" "$WEBAPP_ID" "$TOOLCHAIN" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [path, contractHash, delegateHash, delegateKey, webappId, toolchain] =
  process.argv.slice(2);

const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const uniq = (items) => [...new Set(items)];

const contractGenerations = uniq([
  contractHash,
  ...(previous?.contract?.generations ?? []),
]);
const delegateKeys = uniq([
  delegateKey,
  ...(previous?.delegate?.generations?.map((g) => g.key) ?? []),
]);

const delegateByKey = new Map(
  (previous?.delegate?.generations ?? []).map((g) => [g.key, g]),
);
delegateByKey.set(delegateKey, { key: delegateKey, codeHash: delegateHash, webappId });
const delegateGenerations = delegateKeys.map((k) => delegateByKey.get(k));

const manifest = {
  note:
    "Committed reproducible artifacts. These bytes are the contract code hash " +
    "and the delegate key. `make check-artifacts` rebuilds and compares bytes; " +
    "`make record-artifacts` is the only supported way to change this file. " +
    "Generations are newest-first and must stay in ui/src/migrations.ts.",
  toolchain,
  remap: { cargoHome: "/cargo", rustupHome: "/rustup", repoRoot: "/build" },
  contract: {
    codeHash: contractHash,
    file: "published/contract/number_contract.wasm",
    generations: contractGenerations,
  },
  delegate: {
    codeHash: delegateHash,
    key: delegateKey,
    webappId,
    file: "published/delegate/number_delegate.wasm",
    generations: delegateGenerations,
  },
};

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

echo "==> recorded"
echo "    contract code hash: $CONTRACT_HASH"
echo "    delegate code hash: $DELEGATE_HASH"
echo "    delegate key:       $DELEGATE_KEY"
echo "    webapp id:          $WEBAPP_ID"
echo
echo "Next: re-publish the delegate (make publish-delegate) and update the site"
echo "      (fdev --port 7510 website update --key number-local ui/dist) so the served UI"
echo "      carries these constants."

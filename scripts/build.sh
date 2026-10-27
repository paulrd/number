#!/usr/bin/env bash
# Build the contract + delegate WASMs and generate the UI's build-time constants.
#
# Contract WASM bytes are the contract's address, so this script:
#   - builds each crate in its own target dir (lockfile isolation),
#   - records the code hash fdev itself reports (no re-derivation drift),
#   - copies the exact raw WASM the UI PUTs into ui/public/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FDEV="${FDEV:-$HOME/.local/bin/fdev}"
export FDEV
command -v "$FDEV" >/dev/null || { echo "fdev not found (set FDEV=...)" >&2; exit 1; }

# The delegate is pinned to one web container contract instance. Its params
# are the 32 raw bytes of that contract's instance id. `fdev website list`
# prints the base58 id; the file is the checked-in source of truth for the
# local site. Override with WEBAPP_CONTRACT_ID for another deployment.
WEBAPP_ID_FILE="${WEBAPP_ID_FILE:-$ROOT/delegate/webapp_contract_id.txt}"
WEBAPP_ID="${WEBAPP_CONTRACT_ID:-}"
if [ -z "$WEBAPP_ID" ]; then
  [ -f "$WEBAPP_ID_FILE" ] || {
    echo "missing $WEBAPP_ID_FILE (or set WEBAPP_CONTRACT_ID)" >&2
    exit 1
  }
  WEBAPP_ID="$(tr -d '[:space:]' < "$WEBAPP_ID_FILE")"
fi
[ -n "$WEBAPP_ID" ] || { echo "webapp contract id is empty" >&2; exit 1; }

strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }

# fdev names its packaged output after the crate's lib target, which is not
# always the package name. Discover it instead of guessing.
packaged_file() {
  local dir="$1" name="$2" f
  f="$(find "$dir" -maxdepth 1 -type f -name "$name" | head -1)"
  [ -n "$f" ] || { echo "no packaged artifact '$name' in $dir" >&2; return 1; }
  printf '%s' "$f"
}

echo "==> ui deps"
cd "$ROOT/ui"
if [ ! -d node_modules ]; then npm install --silent; fi

echo "==> contract"
cd "$ROOT/contract"
CARGO_TARGET_DIR="$PWD/target" "$FDEV" build --features contract
CONTRACT_PKG="$(packaged_file "$ROOT/contract/build/freenet" number_contract)"
CONTRACT_WASM="$ROOT/contract/target/wasm32-unknown-unknown/release/number_contract.wasm"
[ -f "$CONTRACT_WASM" ] || { echo "missing raw contract wasm: $CONTRACT_WASM" >&2; exit 1; }

CONTRACT_CODE_HASH="$("$FDEV" inspect "$CONTRACT_PKG" code | strip_ansi | awk -F': ' '/^code hash:/{print $2; exit}')"
[ -n "$CONTRACT_CODE_HASH" ] || { echo "could not read contract code hash" >&2; exit 1; }
printf '%s' "$CONTRACT_CODE_HASH" > "$ROOT/ui/contract_code_hash.txt"
cp "$CONTRACT_WASM" "$ROOT/ui/public/number_contract.wasm"

echo "==> delegate"
cd "$ROOT/delegate"
CARGO_TARGET_DIR="$PWD/target" "$FDEV" build --package-type delegate
DELEGATE_PKG="$(packaged_file "$ROOT/delegate/build/freenet" number_delegate)"
DELEGATE_WASM="$ROOT/delegate/target/wasm32-unknown-unknown/release/number_delegate.wasm"
[ -f "$DELEGATE_WASM" ] || { echo "missing raw delegate wasm: $DELEGATE_WASM" >&2; exit 1; }

DELEGATE_CODE_HASH="$("$FDEV" inspect "$DELEGATE_PKG" delegate | strip_ansi | awk -F': ' '/^code hash:/{print $2; exit}')"
[ -n "$DELEGATE_CODE_HASH" ] || { echo "could not read delegate code hash" >&2; exit 1; }

echo "==> ui constants"
cd "$ROOT/ui"
node --input-type=module - \
  "$CONTRACT_CODE_HASH" "$DELEGATE_CODE_HASH" "$WEBAPP_ID" \
  "$ROOT/delegate/webapp_contract_id.bin" <<'NODE'
import { writeFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";

const [contractHashB58, delegateCodeHashB58, webappIdB58, paramsPath] =
  process.argv.slice(2);
const bytes = (b58, what) => {
  const b = bs58.decode(b58);
  if (b.length !== 32) throw new Error(`${what} is not 32 bytes`);
  return b;
};
const json = (u8) => JSON.stringify(Array.from(u8));

const webappId = bytes(webappIdB58, "webapp contract id");
const delegateCodeHash = bytes(delegateCodeHashB58, "delegate code hash");

// Delegate key = BLAKE3(code_hash || params), exactly as the node computes it.
// `fdev inspect <pkg> key` has no --parameters option, so it cannot report
// this key once the delegate is published with params.
const delegateKey = blake3(new Uint8Array([...delegateCodeHash, ...webappId]));
const delegateKeyB58 = bs58.encode(delegateKey);

writeFileSync(paramsPath, Buffer.from(webappId));
writeFileSync("webapp_contract_id_bytes.json", json(webappId));
writeFileSync("contract_code_hash_bytes.json", json(bytes(contractHashB58, "contract code hash")));
writeFileSync("delegate_key.txt", delegateKeyB58);
writeFileSync("delegate_key_bytes.json", json(delegateKey));
writeFileSync("delegate_code_hash_bytes.json", json(delegateCodeHash));

console.log(`contract code hash: ${contractHashB58}`);
console.log(`webapp contract id: ${webappIdB58}`);
console.log(`delegate params:    ${paramsPath}`);
console.log(`delegate key:       ${delegateKeyB58}`);
NODE

echo "==> done"

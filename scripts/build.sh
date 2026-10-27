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
DELEGATE_KEY="$("$FDEV" inspect "$DELEGATE_PKG" key | strip_ansi | awk -F': ' '/^code key:/{print $2; exit}')"
[ -n "$DELEGATE_CODE_HASH" ] || { echo "could not read delegate code hash" >&2; exit 1; }
[ -n "$DELEGATE_KEY" ] || { echo "could not read delegate key" >&2; exit 1; }

echo "==> ui constants"
cd "$ROOT/ui"
node --input-type=module - "$CONTRACT_CODE_HASH" "$DELEGATE_KEY" "$DELEGATE_CODE_HASH" <<'NODE'
import { writeFileSync } from "node:fs";
import bs58 from "bs58";

const [contractHashB58, delegateKeyB58, delegateCodeHashB58] = process.argv.slice(2);
const bytes = (b58, what) => {
  const b = bs58.decode(b58);
  if (b.length !== 32) throw new Error(`${what} is not 32 bytes`);
  return b;
};
const json = (u8) => JSON.stringify(Array.from(u8));

writeFileSync("contract_code_hash_bytes.json", json(bytes(contractHashB58, "contract code hash")));
writeFileSync("delegate_key.txt", delegateKeyB58);
writeFileSync("delegate_key_bytes.json", json(bytes(delegateKeyB58, "delegate key")));
writeFileSync("delegate_code_hash_bytes.json", json(bytes(delegateCodeHashB58, "delegate code hash")));

console.log(`contract code hash: ${contractHashB58}`);
console.log(`delegate key:       ${delegateKeyB58}`);
NODE

echo "==> done"

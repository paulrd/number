#!/usr/bin/env bash
# Canonical build for the contract + delegate WASMs.
#
# A contract's id is BLAKE3(BLAKE3(wasm) || parameters) and a delegate's key is
# BLAKE3(BLAKE3(wasm) || parameters), so the WASM bytes ARE the address. This
# script is the only supported way to build them:
#
#   - one frozen --remap-path-prefix namespace for CARGO_HOME, RUSTUP_HOME and
#     the repo root, so no build-machine path reaches the bytes;
#   - --locked, so a stale Cargo.lock fails instead of silently re-resolving;
#   - a per-crate target dir under an explicit root, so a hash you record can be
#     produced in a throwaway directory (see `make check-artifacts`);
#   - a post-build scan that fails if a build-machine path survived into the WASM.
#
# Changing the remap namespace (the replacement roots) re-keys every contract
# and delegate. Treat it as frozen.
#
# Usage: scripts/build.sh [options]
#   --target-dir DIR   Root for per-crate cargo target dirs (default .build)
#   --crate NAME       all (default) | contract | delegate
#   --no-ui            Skip the generated UI constants (no node/npm needed)
#   --no-package       Skip `fdev build` packaging (raw WASM only)
#   -h, --help
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FDEV="${FDEV:-$HOME/.local/bin/fdev}"

TARGET_ROOT=""
CRATE="all"
WITH_UI=1
WITH_PACKAGE=1

usage() {
  sed -n '/^# Usage:/,/^#   -h/p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target-dir) TARGET_ROOT="${2:?--target-dir needs a value}"; shift 2 ;;
    --crate)      CRATE="${2:?--crate needs a value}"; shift 2 ;;
    --no-ui)      WITH_UI=0; shift ;;
    --no-package) WITH_PACKAGE=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$CRATE" in
  all|contract|delegate) ;;
  *) echo "--crate must be one of: all, contract, delegate" >&2; exit 2 ;;
esac

TARGET_ROOT="${TARGET_ROOT:-$ROOT/.build}"
mkdir -p "$TARGET_ROOT"
TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd)"

# Frozen remap namespace. These replacement names are part of every artifact's
# identity: changing one re-keys the contract and the delegate.
REMAP_CARGO="/cargo"
REMAP_RUSTUP="/rustup"
REMAP_REPO="/build"

CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"

# Carrying a machine-specific path is the difference between a contract anyone
# can rebuild and one bound to this box. Refuse ambient flags that would either
# bypass the remap or vary between runs.
if [ -n "${RUSTFLAGS:-}" ]; then
  echo "RUSTFLAGS is set; it would override the reproducible build flags." >&2
  echo "Unset it (the canonical flags live in this script)." >&2
  exit 1
fi
if [ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]; then
  echo "CARGO_ENCODED_RUSTFLAGS is set; unset it and use this script." >&2
  exit 1
fi

export CARGO_BUILD_RUSTFLAGS="\
--remap-path-prefix=${CARGO_HOME_DIR}=${REMAP_CARGO} \
--remap-path-prefix=${RUSTUP_HOME_DIR}=${REMAP_RUSTUP} \
--remap-path-prefix=${ROOT}=${REMAP_REPO}"

fail() { echo "error: $*" >&2; exit 1; }

# The generated UI constants need both WASMs (contract hash, delegate key).
if [ "$WITH_UI" -eq 1 ] && [ "$CRATE" != "all" ]; then
  fail "--no-ui is required with --crate $CRATE: the UI constants need both WASMs"
fi

# A surviving absolute path means the artifact is tied to this machine.
assert_no_build_paths() {
  local wasm="$1" prefix
  for prefix in "$CARGO_HOME_DIR" "$RUSTUP_HOME_DIR" "$ROOT" "$TARGET_ROOT" "$HOME"; do
    [ -n "$prefix" ] || continue
    if grep -a -q -F -- "$prefix" "$wasm"; then
      echo "error: build-machine path leaked into $wasm" >&2
      grep -a -o -F -- "$prefix" "$wasm" | head -3 >&2 || true
      echo "The artifact is not portable; fix the crate or these build flags." >&2
      exit 1
    fi
  done
}

build_one() {
  local crate="$1" name="$2" pkgtype="$3" features="$4"
  local dir="$ROOT/$crate"
  local target="$TARGET_ROOT/$crate"
  local wasm="$target/wasm32-unknown-unknown/release/$name.wasm"

  echo "==> $crate"
  # shellcheck disable=SC2086  # $features is an intentional flag list
  ( cd "$dir" && CARGO_TARGET_DIR="$target" \
      cargo build --locked --release --target wasm32-unknown-unknown $features )

  if [ "$WITH_PACKAGE" -eq 1 ]; then
    command -v "$FDEV" >/dev/null || fail "fdev not found (set FDEV=...)"
    # shellcheck disable=SC2086
    ( cd "$dir" && CARGO_TARGET_DIR="$target" \
        "$FDEV" build --package-type "$pkgtype" $features )
  fi

  [ -f "$wasm" ] || fail "missing raw $crate wasm: $wasm"
  assert_no_build_paths "$wasm"
  echo "    $wasm"
}

if [ "$CRATE" = "all" ] || [ "$CRATE" = "contract" ]; then
  build_one contract number_contract contract "--features contract"
fi
if [ "$CRATE" = "all" ] || [ "$CRATE" = "delegate" ]; then
  build_one delegate number_delegate delegate ""
fi

if [ "$WITH_UI" -eq 1 ]; then
  echo "==> ui constants"
  # The delegate is pinned to one web container contract instance. Its params
  # are the 32 raw bytes of that contract's instance id. `fdev website list`
  # prints the base58 id; the file is the checked-in source of truth for the
  # local site. Override with WEBAPP_CONTRACT_ID for another deployment.
  WEBAPP_ID_FILE="${WEBAPP_ID_FILE:-$ROOT/delegate/webapp_contract_id.txt}"
  WEBAPP_ID="${WEBAPP_CONTRACT_ID:-}"
  if [ -z "$WEBAPP_ID" ]; then
    [ -f "$WEBAPP_ID_FILE" ] || fail "missing $WEBAPP_ID_FILE (or set WEBAPP_CONTRACT_ID)"
    WEBAPP_ID="$(tr -d '[:space:]' < "$WEBAPP_ID_FILE")"
  fi
  [ -n "$WEBAPP_ID" ] || fail "webapp contract id is empty"

  cd "$ROOT/ui"
  if [ ! -d node_modules ]; then npm install --silent; fi

  node --input-type=module - \
    "$TARGET_ROOT/contract/wasm32-unknown-unknown/release/number_contract.wasm" \
    "$TARGET_ROOT/delegate/wasm32-unknown-unknown/release/number_delegate.wasm" \
    "$WEBAPP_ID" "$ROOT/delegate/webapp_contract_id.bin" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";

const [contractWasm, delegateWasm, webappIdB58, paramsPath] =
  process.argv.slice(2);
const bytes = (b58, what) => {
  const b = bs58.decode(b58);
  if (b.length !== 32) throw new Error(`${what} is not 32 bytes`);
  return b;
};
const json = (u8) => JSON.stringify(Array.from(u8));
const codeHash = (path) => blake3(readFileSync(path));

const webappId = bytes(webappIdB58, "webapp contract id");
const contractCodeHash = codeHash(contractWasm);
const delegateCodeHash = codeHash(delegateWasm);

// Delegate key = BLAKE3(code_hash || params), exactly as the node computes it.
const delegateKey = blake3(
  new Uint8Array([...delegateCodeHash, ...webappId]),
);

writeFileSync(paramsPath, Buffer.from(webappId));
writeFileSync("webapp_contract_id_bytes.json", json(webappId));
writeFileSync("contract_code_hash.txt", bs58.encode(contractCodeHash));
writeFileSync("contract_code_hash_bytes.json", json(contractCodeHash));
writeFileSync("delegate_code_hash.txt", bs58.encode(delegateCodeHash));
writeFileSync("delegate_code_hash_bytes.json", json(delegateCodeHash));
writeFileSync("delegate_key.txt", bs58.encode(delegateKey));
writeFileSync("delegate_key_bytes.json", json(delegateKey));

console.log(`contract code hash: ${bs58.encode(contractCodeHash)}`);
console.log(`webapp contract id: ${webappIdB58}`);
console.log(`delegate params:    ${paramsPath}`);
console.log(`delegate key:       ${bs58.encode(delegateKey)}`);
NODE

  cp "$TARGET_ROOT/contract/wasm32-unknown-unknown/release/number_contract.wasm" \
     "$ROOT/ui/public/number_contract.wasm"
fi

echo "==> done"

# number

A small Freenet dApp: one personal board of **up to 8 numbers**, each with
optional metadata (label, unit, note).

- **Contract** (`contract/`) — shared, replicated state. One instance per owner,
  parameterised by the owner's Ed25519 verifying key. Signed slot updates,
  per-slot last-writer-wins on a monotonic `seq`, tombstones for cleared slots,
  canonical JSON state, small fixed-size summary, delta sync.
- **Delegate** (`delegate/`) — holds the owner's signing key locally and signs
  slot updates. Secrets never leave the node.
- **UI** (`ui/`) — TypeScript + Vite. Derives the board key from the owner key,
  creates the instance on first use (PUT), subscribes, and sends signed deltas.

Design and exact wire formats: [DESIGN.md](./DESIGN.md).

## Prerequisites

- Rust 1.85+ with the `wasm32-unknown-unknown` target
- `fdev` and `freenet` on `PATH`
- Node.js 20+

## Build

```bash
make build     # contract + delegate WASMs, UI constants, UI bundle
make check     # fmt, clippy, unit tests (contract, delegate, UI)
make verify-merge   # fdev merge-law corpus check
```

`scripts/build.sh` records the contract/delegate code hashes exactly as `fdev`
reports them, copies the raw contract WASM into `ui/public/`, and writes the
delegate key bytes for the UI. Contract and delegate are standalone crates with
their own `Cargo.lock` (see DESIGN §9): a dependency change must not silently
move the contract's address.

## Run locally

```bash
# 1. isolated node on :7510 (default 7509 may be a system service)
freenet local --ws-api-port 7510 \
  --data-dir /tmp/number-node/data \
  --config-dir /tmp/number-node/config \
  --log-dir /tmp/number-node/logs

# 2. register the delegate with that node
fdev --port 7510 publish --code delegate/build/freenet/number_delegate delegate

# 3. publish the UI as a webapp (the URL is permanent; updates are in-place)
fdev website init number-local            # once; back up the key file
fdev --port 7510 website publish --key number-local ui/dist
# later: fdev --port 7510 website update --key number-local ui/dist
```

Open the printed `/v1/contract/web/<id>/` URL on the node's port. The board is
created on first load (the UI PUTs the bundled `number_contract.wasm` with the
owner key as parameters).

For frontend iteration, `npm --prefix ui run dev` serves the UI at :8080; point
it at a node with a `/v1` proxy and an auth token (the gateway shell normally
does both — see `references` in the dapp-builder skill).

## Behaviour notes

- **Clearing a slot tombstones it** (`seq > 0`, `entry: null`), so an older peer
  cannot resurrect the value. "Removed", not "erased from the network".
- **Identity lives in the delegate** on this node. A different device has a
  different owner key and therefore a different board until key export/import
  exists.
- **Values are i64 in the contract.** The UI warns when a value exceeds
  `Number.MAX_SAFE_INTEGER`, where JavaScript would lose precision.
- **Live updates** arrive through subscription deltas. A subscription timeout in
  the gateway shell is treated as "unconfirmed", not failed — refusals surface
  through the `SubscribeResponse` callback, and live deltas have been verified
  against a local node.

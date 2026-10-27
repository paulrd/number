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
Current deployment state, done work, and the remaining backlog:
[BACKLOG.md](./BACKLOG.md).

## Prerequisites

- Rust per the committed `rust-toolchain.toml` (1.98.0, with the
  `wasm32-unknown-unknown` target; `rustup` reads the file)
- `fdev` and `freenet` on `PATH`
- Node.js 22.12+ (Playwright/axe requirement)

## Build

```bash
make build            # reproducible WASMs, UI constants, UI bundle
make check            # fmt, clippy, unit tests (contract, delegate, UI)
make check-artifacts  # rebuild and byte-compare against published/
make record-artifacts # promote the current build to published/ (gated)
make verify-merge     # every merge law, with deltas/summaries/transitions
```

Browser smoke:

```bash
cd ui && npm ci && npx playwright install chromium
make e2e-offline    # built UI + mock backend, no node
FREENET_BASE_URL=http://127.0.0.1:7510/v1/contract/web/<id>/ \
  make e2e-gateway  # gateway shell + sandboxed iframe
```

`make e2e-offline` also runs an axe accessibility check. The gateway spec is
skipped unless `FREENET_BASE_URL` points at a `/v1/contract/web/...` URL.
CI runs the contract/delegate/UI suites, the offline browser smoke,
`fdev verify-merge`, and the WASM byte-equality gate; see
`.github/workflows/ci.yml`.

### Reproducible WASM

A contract's id is `BLAKE3(BLAKE3(wasm) || parameters)` and a delegate's key is
`BLAKE3(BLAKE3(wasm) || parameters)`, so the WASM bytes **are** the address.
`scripts/build.sh` is the only supported way to produce them:

- one frozen `--remap-path-prefix` namespace for `CARGO_HOME`, `RUSTUP_HOME`
  and the repo root, so no build-machine path reaches the bytes;
- `--locked`, so a stale `Cargo.lock` fails instead of silently re-resolving;
- a per-crate target dir under `--target-dir` (default `.build/`), so a hash
  you record can be built in a throwaway directory;
- a post-build scan that fails if a build-machine path survives in the WASM.

Contract and delegate are standalone crates with their own `Cargo.lock` (see
DESIGN §9), and `rust-toolchain.toml` pins rustc: a dependency or toolchain
change must not silently move the address.

The current artifacts and their generations are committed in `published/`
(`manifest.json` plus both WASMs). `make check-artifacts` rebuilds into a
throwaway dir and fails unless the bytes match exactly; CI runs it on every
push. `make record-artifacts` is the only supported way to change `published/`.

The delegate is pinned to one web container contract instance. Its parameters
are the 32 raw bytes of that webapp's contract id, read from
`delegate/webapp_contract_id.txt` (base58; `fdev --port 7510 website list` prints it) or
from `WEBAPP_CONTRACT_ID`. The build writes
`delegate/webapp_contract_id.bin` for publishing and derives the parameterised
delegate key for the UI. Changing the id or the delegate code re-keys the
delegate; without a migration path that also starts a fresh owner identity.

### Before changing the WASM

Append the outgoing artifact to `ui/src/migrations.ts` **before** rebuilding:

- contract change: append the current contract code hash to
  `LEGACY_CONTRACT_CODE_HASHES`;
- delegate change: append the current delegate key, code hash, and webapp id
  to `LEGACY_DELEGATES`.

This is enforced, not just documented: `scripts/record-artifacts.sh` refuses to
supersede a generation missing from the registry, and `migrations.test.ts`
fails if any superseded generation recorded in `published/manifest.json` is
missing. Never remove an entry.

The UI probes the registry on first load: the delegate export/import path
carries the owner seed forward, and the contract path re-PUTs old signed state
into the new instance. Delegate migration is forward-only — a predecessor
shipped without the `export` command cannot answer and is unrecoverable.
A predecessor pinned to a different webapp id cannot be called from the new UI
(its origin policy refuses); migrate before changing the webapp id.

## Run locally

`make node` runs a loopback-only node on `:7510` (WS API) with data, config
and logs under `/tmp/opencode/number-node`. `make node-isolated` starts a
second node on `:7511` / `:31338` with its own directories, for publish and
migration tests that must not touch the node the UI uses. Override with
`WS_PORT`, `NETWORK_PORT`, `NODE_ROOT`, or the `ISOLATED_*` equivalents.

```bash
# 1. the node the UI talks to
make node

# 2. register the delegate with that node, pinned to this webapp id
fdev --port 7510 publish --code delegate/build/freenet/number_delegate \
  --parameters delegate/webapp_contract_id.bin delegate

# 3. publish the UI as a webapp (the URL is permanent; updates are in-place)
fdev --port 7510 website init number-local      # once; back up the key file
fdev --port 7510 website publish --key number-local ui/dist
# later: fdev --port 7510 website update --key number-local ui/dist
```

Always pass `--port`: `fdev` defaults to `7509`, which on a development
machine may be an SSH forward or a system service rather than this node. The
same applies to `fdev --port 7510 website list`.

Open the printed `/v1/contract/web/<id>/` URL on the node's port. The board is
created on first load (the UI PUTs the bundled `number_contract.wasm` with the
owner key as parameters).

`delegate/webapp_contract_id.txt` must match the site being served. The
checked-in value is the `number-local` id; a production site key has a
different id, so update the file and re-publish the delegate before building
the UI for that site.

### Frontend iteration (dev server)

`npm --prefix ui run dev` serves the UI at `:8080` and proxies `/v1` (HTTP and
WebSocket) to the local node, so the app uses the real delegate and board
instead of talking to `:8080`.

On startup it mints a dev auth token the way the gateway shell does: it loads
the node's shell page for the webapp in `delegate/webapp_contract_id.txt` and
presents that credential on the WebSocket upgrade. The node uses it to attest
`MessageOrigin::WebApp`, which the delegate requires, so the site must be
installed on the node. Overrides:

- `FREENET_NODE_URL` — node origin (default `http://127.0.0.1:7510`, i.e.
  `WS_PORT`; `make dev` sets it for you)
- `FREENET_WEBAPP_ID` — the webapp whose origin the delegate is pinned to
- `FREENET_AUTH_TOKEN` — use an explicit token instead of minting one

If minting fails the server still starts: contract reads work, delegate actions
fail with a visible error. Tokens live in the node's memory, so restart the dev
server after restarting the node. None of this runs for `npm run build`,
`npm test`, `vite preview`, or offline mode.

The dev server proxies a node credential, so keep it on loopback: do not pass
`--host 0.0.0.0` on a machine where other users can reach the port.

## Identity backup and restore

The owner identity is an Ed25519 seed held in this device's Freenet delegate.
The board's contract key is derived from its public key, so the seed *is* the
account: anyone with it can sign updates as the owner.

- **Back up:** open **Back up identity** in the Identity row, choose **Reveal
  backup code**, then copy it or download `number-identity-<pubkey>.json`. The
  code is versioned JSON (`"kind": "number-identity"`) containing the seed and
  the per-slot sequence counters. Store it in a password manager; there is no
  recovery server.
- **Restore:** on a device where number has not created an identity yet, the
  first-run dialog offers **Restore from a backup**. Paste the code there. This
  is the only moment restore is possible — the delegate refuses to replace an
  existing seed, so a device that already has an identity cannot import one.
- The backup carries the key, not the board. Another device restores the same
  key, derives the same board address, and loads the board from Freenet, so it
  needs network access. A local-only node will show an empty board even though
  the identity is correct (live deployment is #12).
- The code is never stored by the app: it is fetched only when you reveal it,
  kept in a readonly field, and cleared when you hide the code or close the
  dialog.

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

# number

A small Freenet dApp: one personal board of **8 number slots** and a shared
**address book**, arranged as a **tree of boards**. Each board is a node: its 8
slots are its children (each linked to a contact — label + user id/public key)
and it has at most one parent board. A slot holds a two-decimal number
(optional; blank is `0.00`) plus optional unit and note. The child contact is
mandatory; the slot stores the contact's public key, so renaming a label keeps
the link.

A parent/child edge is a tree edge only when **both sides agree**: the parent
board has a slot for the child, and the child board's parent points back to the
parent. One-sided links are shown as pending. Other owners' boards are readable
in the UI but only the owner can sign them.

- **Contract** (`contract/`) — shared, replicated state. One instance per owner,
  parameterised by the owner's Ed25519 verifying key. Signed slot and address
  book updates, last-writer-wins on a monotonic `seq`, tombstones for cleared
  slots/contacts, canonical JSON state, small fixed-size summary, delta sync.
- **Delegate** (`delegate/`) — holds the owner's signing key locally and signs
  slot and address-book updates. Secrets never leave the node.
- **UI** (`ui/`) — TypeScript + Vite. Derives the board key from the owner key,
  creates the instance on first use (PUT), subscribes, sends signed deltas, and
  manages the address book.

Values are i64 **counts of hundredths** in the contract (the wire type did not
change; the UI divides by 100 and shows exactly two decimals).

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
  `LEGACY_CONTRACT_CODE_HASHES` when the new contract accepts the old state
  (same schema and signing bytes), otherwise to
  `UNMIGRATABLE_CONTRACT_CODE_HASHES`;
- delegate change: append the current delegate key, code hash, and webapp id
  to `LEGACY_DELEGATES`.

The v2 address-book release was the breaking case: its state schema and signing
bytes changed, so v1 contract hashes are unmigratable. The v3 tree release is
migratable: it keeps the v2 slot/contacts signing bytes and adds a parent
record, so v2 boards are upgraded with an empty parent. The owner identity
migrates through the delegate in both cases.

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

# 2. optional: register the delegate up front. A fresh node can also install
#    the copy bundled with the site on first load (first-run prompt).
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
checked-in `number-local` id is used for both the local node and the live site,
so the delegate pin is the same. Publishing with a *different* website key
would change the id, requiring the file update and a delegate re-pin (and
migration) before building that site's UI.

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

## Boards as a tree

Every board is a node in a tree. Its 8 slots are its **children** (each slot's
contact is the child board owner's user id) and it has at most one **parent**.

- **Link a child:** open a slot, choose the child's contact, and save. The
  child's owner opens *their* board, sets its parent to your board, and adds
  your contact if needed.
- **Link a parent:** open **Parent → Set parent** on your board and choose the
  parent's contact. Clear it to become a root.
- **Mutual match:** an edge is a tree edge only when both boards agree — the
  parent has a slot for the child and the child's parent points back. One-sided
  links show as **Pending**; a board that does not exist shows **Not created**.
  A v2 board can be a parent (its slots are readable) but must be opened in v3
  to become a child.
- **Navigate:** breadcrumbs follow mutual parent edges to the root; **Home**
  returns to your own board. Other owners' boards are read-only. The address
  book labels a board's own slots; a viewed board's labels come from its state.
- **Cycles** are detected by the UI and are not followed. The contract enforces
  one signed parent per board and rejects a board parenting itself; it cannot
  enforce agreement or acyclicity across boards.

## Identity backup and restore

The owner identity is an Ed25519 seed held in this device's Freenet delegate.
The board's contract key is derived from its public key, so the seed *is* the
account: anyone with it can sign updates as the owner.

- **Back up:** open **Back up identity** in the Identity row, choose **Reveal
  backup code**, then copy it or download `number-identity-<pubkey>.json`. The
  code is versioned JSON (`"kind": "number-identity"`) containing the seed, the
  per-slot sequence counters, and the address-book counter. Store it in a
  password manager; there is no recovery server.
- **Restore:** on a device where number has not created an identity yet, the
  first-run dialog offers **Restore from a backup**. Paste the code there. This
  is the only moment restore is possible — the delegate refuses to replace an
  existing seed, so a device that already has an identity cannot import one.
- The backup carries the key, not the board. Another device restores the same
  key, derives the same board address, and loads the board (including its
  address book, which lives in contract state) from Freenet, so it needs
  network access. A local-only node will show an empty board even though the
  identity is correct (live deployment is #12).
- The code is never stored by the app: it is fetched only when you reveal it,
  kept in a readonly field, and cleared when you hide the code or close the
  dialog.

## Live deployment

The website contract is published on the live Freenet network under the same
webapp id as the local site (`BZBE…`), so the delegate pin is unchanged and
updates are in place. Any node that can fetch the contract serves it at
`<node>/v1/contract/web/BZBE…/`; the publishing peer is not special.

- Update in place with
  `fdev --port <live node> website update --key number-local ui/dist`. The
  signing key is backed up; the id does not move.
- The delegate is bundled with the site (`number_delegate.wasm`). On a node
  that does not have it, the first-run dialog offers to install it: the app
  fetches that file, verifies it against the code hash baked into the build,
  and registers it on the node. No server and no `fdev` step is needed for a
  visitor. The site archive grows by roughly 70 KB compressed.
- `fdev --port <port> publish --code <number_delegate package> --parameters
  delegate/webapp_contract_id.bin delegate` remains the explicit admin path
  (and the fallback if a node blocks registration).
- Atlas: the current Atlas is a read-only crawler index with no publisher
  submission, so the site is live but not listed yet (#15).

## Behaviour notes

- **A slot's contact is mandatory and is the child node.** It is selected from
  the address book and stored as the child board owner's 64-hex public key.
  Removing a contact does not invalidate old signed slots; they show an
  "unknown contact" id until re-linked.
- **A board has one signed parent record.** Setting a parent is a signed write;
  clearing it writes a parent tombstone at a higher `seq`. A parent edge only
  counts as a tree edge when the other side links back; one-sided links are
  shown as pending. Cycles are detected by the UI, not the contract.
- **Clearing a slot tombstones it** (`seq > 0`, `entry: null`), so an older peer
  cannot resurrect the value. "Removed", not "erased from the network". The
  address book and parent record have their own signed sequences: removing every
  contact or clearing the parent leaves a legal empty record at a higher `seq`.
- **Identity lives in the delegate** on this node. A different device has a
  different owner key and therefore a different board until key export/import
  exists.
- **Values are i64 counts of hundredths in the contract.** The wire format is a
  JSON number and the UI parses/emits it losslessly (BigInt), so the full range
  `-92233720368547758.08` … `92233720368547758.07` (displayed) survives editing,
  signing, and reload exactly. A blank input saves `0.00`; more than two decimal
  places is rejected.
- **v3 carries v2 boards forward.** v3 keeps the v2 slot/contacts signing bytes
  and adds a signed parent record; the client upgrades a v2 state with an empty
  parent and re-PUTs it. v1 boards remain unmigratable (the v2 address book
  changed their schema/signing bytes). The owner key is preserved through
  delegate migration in both cases.
- **Live updates** arrive through subscription deltas. The node currently
  serializes `SubscribeResponse` as `PutResponse` (upstream freenet-stdlib bug;
  see `reports/upstream-subscribe-response.md`), so a subscribe timeout is
  treated as "unconfirmed", not failed. Live deltas have been verified against
  a local node.

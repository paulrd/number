# number

UI display name: **Tally**. The repository, crate names and on-disk keys keep
`number`: renaming them changes the WASM bytes, and so the contract id and
delegate key, which would strand every existing zone.

A small Freenet dApp: one personal **zone** of **8 number slots** and a private
**address book**, arranged as a **tree of zones**. Each zone is a node: its 8
slots are its children (each linked to a contact — label + user id/public key)
and it has at most one parent zone. A slot holds a two-decimal number
(optional; blank is `0.00`) plus optional unit and note. The child contact is
mandatory; the slot stores the contact's public key, so renaming a label keeps
the link. A zone has no name of its own: the only names are the ones a parent
signs into its child slots (`childNames`), so a child is shown under the label
its parent gave it.

A parent/child edge is a tree edge only when **both sides agree**: the parent
zone has a slot for the child, and the child zone's parent points back to the
parent. A slot counts as a child slot only then; a one-sided link is shown
separately as unconfirmed. The UI shows your own zone only — there is no
navigation to other owners' zones — although the protocol reads neighbours'
signed state to resolve values, links and payment routes.

Payments route between two addresses through their least common ancestor, and
**either endpoint may be that ancestor**: a zone with any link (parent or
child) can pay and be paid. A route with only downward links means the payer
credits the first child on the path — an *implicit issue* against that child's
liability — and a route with only upward links means the payee debits the child
on the source path — an *implicit burn*. Neither writes a separate adjustment
record; the slot write is the issue or burn. See
[DESIGN-payments-lca.md](./DESIGN-payments-lca.md).

- **Contract** (`contract/`) — shared, replicated state. One instance per owner,
  parameterised by the owner's Ed25519 verifying key. Signed slot, parent,
  payment, adjustment, `selfName` and `childNames` records, last-writer-wins on
  a monotonic `seq`, tombstones for cleared slots, canonical JSON state, small
  fixed-size summary, delta sync. There is no address book in contract state.
  `selfName` remains a v6 field so older zones decode and merge, but the UI no
  longer writes or shows it: `childNames` is the only live name record.
- **Delegate** (`delegate/`) — holds the owner's signing key and the private
  address book (`label`, `userId`, octal `address`) locally, and signs slot,
  parent, payment, adjustment and child-slot name updates. **v4.1:** while
  the node runs it subscribes to the zone's parent and children and can
  advance a forward payment leg with no tab open (Background permission
  required). Secrets never leave the node.
- **UI** (`ui/`) — TypeScript + Vite. Derives the zone key from the owner key,
  creates the instance on first use (PUT), subscribes, sends signed deltas, and
  manages the address book.
- **Adjustments (v5)** — each zone owner can issue (raise) or burn (lower) the
  liability recorded for a child slot. The adjustment is signed and carried in
  a bounded log the child can read; a burn clamps at zero. It is bookkeeping,
  not a payment.

Values are i64 **counts of hundredths** in the contract (the wire type did not
change; the UI divides by 100 and shows exactly two decimals).

Design and exact wire formats: [DESIGN.md](./DESIGN.md) (v4/v5), [DESIGN-payments-lca.md](./DESIGN-payments-lca.md) for LCA-endpoint payments, and
[DESIGN-v6.md](./DESIGN-v6.md) (private address book, signed names). UI
information architecture: [DESIGN-views.md](./DESIGN-views.md).
Current deployment state, done work, and the remaining backlog:
[BACKLOG.md](./BACKLOG.md).
The historical design docs predate the user-facing **zone** wording and keep
"board" in their prose; the wire formats, field names and signing domains did
not change.

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
record, so v2 zones are upgraded with an empty parent. The owner identity
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

**Two-node tree testing needs network mode.** `make node` and
`make node-isolated` run `freenet local`: a local-only node neither fetches
contracts from another node nor publishes its own to the network, so a
parent/child edge to/from a network peer shows **Not created yet**. For a
two-node test, stop the local node and run `make node-network` (same data
directories, so the identity, zone, site and delegate survive), and make sure
the other node is also on the network (the live `:7509` peer is). Both sides
must be able to fetch the other zone for the mutual link to resolve.

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

Open the printed `/v1/contract/web/<id>/` URL on the node's port. The zone is
created on first load (the UI PUTs the bundled `number_contract.wasm` with the
owner key as parameters).

`delegate/webapp_contract_id.txt` must match the site being served. The
checked-in `number-local` id is used for both the local node and the live site,
so the delegate pin is the same. Publishing with a *different* website key
would change the id, requiring the file update and a delegate re-pin (and
migration) before building that site's UI.

### Frontend iteration (dev server)

`npm --prefix ui run dev` serves the UI at `:8080` and proxies `/v1` (HTTP and
WebSocket) to the local node, so the app uses the real delegate and zone
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

## Zones as a tree

Every zone is a node in a tree. Its 8 slots are its **children** (each slot's
contact is the child zone owner's user id) and it has at most one **parent**.

A zone has no name of its own. The only names left are the ones a parent signs
into its child slots (`childNames`), so a parent lists each child under the
label it gave that slot. On its own view a zone is simply **Your zone**, shown
with its value, its children, its octal address and your shortened user id
(with a copy control); there is no name field to fill in or rename. The
contract id is under **Details**, not in the primary header.

- **Link a child:** open a slot, choose the child's contact, and save. Advanced
  and the simple children list show the child's shortened user id (full key on
  hover). The child's owner opens *their* zone, sets its parent to your zone,
  and adds your contact if needed.
- **Link a parent:** a zone with no usable parent shows **Add a parent** on the
  simple view; choose the parent's contact. To change or clear an existing
  parent, use **Advanced → Parent** (clearing it makes the zone a root).
- **Mutual match:** an edge is a tree edge only when both zones agree — the
  parent has a slot for the child and the child's parent points back. One-sided
  links show as **Pending**; a zone that does not exist shows **Not created**.
  A v2 zone can be a parent (its slots are readable) but must be opened in v3
  to become a child.
- **No navigation:** the UI shows your own zone only. The protocol reads
  neighbouring zones for values, links and payment routes; there is no
  breadcrumb or other-owner browsing.
- **Parent value:** when a zone has a mutual parent, the value the parent holds
  in the slot naming it is shown on the simple view under the label `Balance`,
  with its unit and note. The parent is not named there. A root, a pending link, or a cleared parent slot has nothing
  to show, and the simple view instead offers the parent prompt when the link
  is missing.
- **Octal address:** every zone shows an address made of zero-based slot digits
  from the root, with no separator. A root is the empty string; each child
  appends its slot digit (`0`–`7`) to its parent's address, so a zone in slot 2
  of a zone in slot 5 of the root has address `52`. The simple view shows it
  quietly beside the heading; Advanced repeats it as a chip. The address is
  derived from mutual parent links, not stored; a pending, missing, unreadable,
  looping, or over-deep chain leaves it unsettled.
- **Cycles** are detected by the UI and are not followed. The contract enforces
  one signed parent per zone and rejects a zone parenting itself; it cannot
  enforce agreement or acyclicity across zones.

### Payments

A payment moves a positive amount from one zone to another along the unique
path through their least common ancestor (LCA). The sender supplies the
destination's **octal address**, the destination **user id**, and the amount.

- Each zone owner signs only their own state, so a payment is a sequence of
  signed legs, not one transaction. The source writes the offer; each zone on
  the upward path signs a debit, the LCA signs the paired debit and credit in
  one delta, and each zone on the downward path signs a credit. A zone
  advances the payments it can see in its inbox (its parent and eight children)
  when its owner opens it.
- An upward debit that would take a value below `0.00` fails before signing.
  A missing destination, a user id that does not match the zone at the address,
  or a failed leg starts a **reverse** walk: every zone that already acted undoes
  its own leg. A reversal is best effort; a later signed write can supersede a
  leg, and an offline owner can leave the payment reversing. The UI reports the
  state rather than pretending it settled.
- There is one active payment per zone in this version. Discovery is manual
  unless the node grants the Background capability: **Check for payments**
  clears the session cache, and the delegate auto-advances legs when the node
  runs its background task. A zone can still wait indefinitely for an owner to
  open it.
- The v4 `payments` record is signed like the parent record. v3 zones
  upgrade by adding an empty payments record; the v4 contract and delegate are a
  new generation with the usual migration path.

## Identity backup and restore

The owner identity is an Ed25519 seed held in this device's Freenet delegate.
The zone's contract key is derived from its public key, so the seed *is* the
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
- The backup carries the key and the private address book (payload v2), not the
  zone. Another device restores the same key, derives the same zone address,
  and loads the zone's signed state from Freenet, so it needs network access.
  A local-only node will show an empty zone even though the identity is
  correct (live deployment is #12).
- **Transfer, not sync.** The backup is the only cross-device path for the
  address book, and restore is offered only before this device creates an
  identity. There is no live sync; re-export after contact changes and restore
  onto a device that does not have a seed yet.
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
  the address book and stored as the child zone owner's 64-hex public key.
  Removing a contact does not invalidate old signed slots; they show an
  "unknown contact" id until re-linked.
- **A zone has one signed parent record.** Setting a parent is a signed write;
  clearing it writes a parent tombstone at a higher `seq`. A parent edge only
  counts as a tree edge when the other side links back; one-sided links are
  shown as pending. Cycles are detected by the UI, not the contract.
- **Clearing a slot tombstones it** (`seq > 0`, `entry: null`), so an older peer
  cannot resurrect the value. "Removed", not "erased from the network". The
  address book and parent record have their own signed sequences: removing every
  contact or clearing the parent leaves a legal empty record at a higher `seq`.
- **Identity lives in the delegate** on this node. A different device has a
  different owner key and therefore a different zone until the identity is
  exported and imported.
- **Values are i64 counts of hundredths in the contract.** The wire format is a
  JSON number and the UI parses/emits it losslessly (BigInt), so the full range
  `-92233720368547758.08` … `92233720368547758.07` (displayed) survives editing,
  signing, and reload exactly. A blank input saves `0.00`; more than two decimal
  places is rejected.
- **v3 carries v2 zones forward.** v3 keeps the v2 slot/contacts signing bytes
  and adds a signed parent record; the client upgrades a v2 state with an empty
  parent and re-PUTs it. v1 zones remain unmigratable (the v2 address book
  changed their schema/signing bytes). The owner key is preserved through
  delegate migration in both cases.
- **Live updates** arrive through subscription deltas. The node currently
  serializes `SubscribeResponse` as `PutResponse` (upstream freenet-stdlib bug;
  see `reports/upstream-subscribe-response.md`), so a subscribe timeout is
  treated as "unconfirmed", not failed. Live deltas have been verified against
  a local node.

# Backlog and handoff

Durable state for the project. Read this with `README.md`, then the design docs:
`DESIGN.md` (v4/v5), `DESIGN-v6.md` (private address book, signed names),
`DESIGN-network.md` (regions, onboarding, rooms; growth deferred),
`DESIGN-regions-p1.md` (stage-1 dataset, contracts, picker),
`DESIGN-views.md` (what the two surfaces may contain, + revision 3),
`DESIGN-payments-lca.md` (payments whose endpoint is the LCA),
`DESIGN-rooms.md` (members-room contract, P3a).

The app's display name is **Tally**; the repository, crate names, WASM
filenames and `number.*` secret keys stay `number`, because renaming them
changes the compiled bytes and re-keys every zone.

## Current state (2026-11-01)

| Item | Value |
|---|---|
| Webapp id | `BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k` |
| Live URL | `<any live node>/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/` |
| Live publish target | operator's VPS peer, API via the SSH-forwarded `:7509` |
| Contract | **v6** `CsFEfMWUH6ai22TWHWqExoL7nvgnHCCGz6TfbVMAcRbw` |
| Delegate | **v11** `3CPshayRgEihDtRUzUSr775LnWB5WXj7r8vjj3GMtMrd`, code `BRXSZhh95SVz7GhDPCa4HWdC4dukqma2ptajyW1GAgCm` (recorded; live nodes still v10 until published) |
| Room contract | **P3a members room** recorded in `published/room/`; code `DWAtsfi3Ed5kGNZiXFxfU1AfjfGe83iAwb1BWHttFBPM` (not pinned in the UI yet) |
| Live owner identity | `3f8411470c801051120a0ff14b5ab571c5660df42c17bc72677c37f2505c27b0` |
| Live zone (v6 instance) | `5vwEEpEBENdqKCVsHH1qqtyZ8rtP7pA2jFroSTBWB4dL` — dormant `selfName` `Dad`, root, one mutual child `Tim` |
| Live site | version `1794067282`, bundle `assets/index-BFPNfg9F.js` + lazy `assets/picker-B-_fJI4b.js`, identical on `7509`/`7511`/`7512`/`7513` |
| Tooling | `freenet` 0.2.153 (`310e494`), `fdev` 0.3.315; CI pin `FREENET_VERSION` 0.2.151 |
| Local node | `:7510` stopped, loopback-only. When started it will not fetch the live site; run `fdev --port 7510 website update --key number-local ui/dist` |
| Artifacts | `published/manifest.json` is the source of truth for the address |
| Last UI publish | 2026-11-07; site `1794067282`, no WASM change, contract/delegate generations unchanged |
| Region dataset | **S1′ (≤7) live**: 178 shards + manifest `HyUU1CqeMhABSgCiomVFxkgEdXbWLaFJ2hLFbLGxHDU` (seq 1), publisher key `2d996f41fce12cdc25b9d742edb57e247a5af693867bebb86b126d7b3c11ed07`; UI constants set; picker republished 2026-11-07 |

What the app does now, in one paragraph: one personal **zone** per owner with
eight child slots and a **private** address book in the delegate; a tree of
zones where an edge exists only when both sides point at each other; a zone has
no name of its own — the only names are the labels a parent signs into its child
slots (`childNames`), while `selfName` stays in v6 state but is dormant; a zone
with any link can pay or be paid, including when an endpoint is the LCA
(implicit issue / burn); the delegate auto-advances payment legs in the
background when the node grants Background; the UI shows your own zone only,
with the parent left unmentioned on the simple surface unless the link is
missing, and everything else behind Advanced.

## Where we left off (2026-11-07) — regions P1

### Live now

- **Region dataset stage 1 (depth ≤7) is live.** 178 shards, 1,481,182 rows,
  35,517,561 row bytes; manifest `HyUU1CqeMhABSgCiomVFxkgEdXbWLaFJ2hLFbLGxHDU`
  (seq 1), publisher verifying key
  `2d996f41fce12cdc25b9d742edb57e247a5af693867bebb86b126d7b3c11ed07`.
  Published to 7509 in 2m50s; verified the 8-shard sample from 7511 and **all
  178 shards + the manifest from 7512** (179 checks, exit 0).
- **UI constants are set** in `ui/src/region/constants.ts`: the manifest id
  above and the raw manifest code hash
  `4DfUwwoSPpfEPW5sSRjBGVc44BfAB4xn5UckqcqgqPGx`.
- **Live browser smoke passed** through the dev proxy against 7509:
  `(69,179)` resolves to `aacbea` (octal `002140`, depth 6, eight child rows,
  no console errors). Real manifest and shards, not the fixture.
- **The website is republished.** Live site `1794067282` serves
  `assets/index-BFPNfg9F.js` and the lazy picker
  `assets/picker-B-_fJI4b.js` (which carries both live constants) from all
  four nodes; hashes match the local build. The picker is now live for users.
  Note: the manifest ids live in the lazy `picker-*.js` chunk, not
  `index-*.js`; `npm run test:e2e:offline` builds `dist-offline`, not `dist`,
  so build with `npm run build` before publishing.
- The 4-shard fixture manifest `BzasDcLJ1HK3SEN7pGCd3sdK91brb5QCcGbFyDQBLLBG`
  (ephemeral key) is a throwaway on the network. It is **not** a UI constant
  and must not be reused.

### P1 complete (2026-11-07)

Published with:

```bash
fdev --port 7509 website update --key number-local ui/dist
# -> version 1794067282, 404628 bytes compressed, 9 files
```

Pre-publish: UI 271 tests and 24 offline e2e passed; bundled
`number_contract.wasm` and `number_delegate.wasm` byte-identical to
`published/`. Post-publish: HTML and all four assets fetched from
7509/7511/7512/7513 and matched the local build by SHA-256. No WASM change,
no re-key.

### What is built

- `region/wire`, `region/blob`, `region/manifest`: the two contracts and the
  shared envelope/summary codec. Raw code hashes: blob
  `H1u41bZHHy9zN19QJK3kGCmEBhFhzmh86k4GJqiMiSxN`, manifest
  `4DfUwwoSPpfEPW5sSRjBGVc44BfAB4xn5UckqcqgqPGx`.
- `region/tool`: exporter, signer, publisher, verifier. Export reproduces the
  design numbers exactly; publish has a resumable ledger and GET-verifies every
  PUT; verify samples or checks all.
- `ui/src/region/`: path codec, wire parser, geometry, dataset client (manifest
  once, shard LRU, verification, `lookupRow`/`childrenOf`/`resolve`), offline
  fixture, and the lazy Leaflet picker.
- `fixtures/regions/`: cross-language golden (72-row tree, 4 shards) used by the
  Rust tool test and the TypeScript parser tests.
- `ui/e2e/live-region.mjs`: manual live manifest read (no CI).
- CI has a `regions` job; `make check` runs `regions-check`.

Tests: **22 Rust** (4 wire, 6 blob, 7 manifest, 5 tool), **21 room**, **83
delegate**, **299 UI**, **26 offline e2e** (the region tests are Axe-clean and
make no external requests).

### P2 implemented (2026-11-07); next is P3/P4 (no contract change)

- Show a zone's region as its octal address (slot `i` = dataset child digit
  `i`) and draw its cell and assignable child cells on the picker.
- Add the designation step to admission: the parent writes the slot first
  (the region assignment), the candidate signs `parent` after seeing the
  assigned cell. Ideal = the published child cell containing the newcomer;
  otherwise any free slot. No moves this iteration.
- Root = world; match order is **shallowest zone with a free slot**; growth and
  re-organization are deferred (`DESIGN-network.md` §4). The shallowest-first
  walk is the P4 newcomer path; P2 only fixes the invariant.
- Then P3 (rooms) and P4 (`?root=` onboarding).

**P2 decisions (2026-11-07, from the design pass):**

- Free-slot ranking: published cell containing the point, then other free
  published cells by distance/population/slot, provisional cells last.
- Keep one-based `Slot 1–8` labels in Advanced and always show the zero-based
  address digit and resulting address beside them.
- Do not lock the contact field on a written slot in P2 (existing edit/clear
  behaviour stays); document it as a move-shaped operation for §4.
- Clearing a confirmed child slot stays allowed with a confirmation that names
  the freed region.
- Candidate transport in P2 is the existing "Add a parent" flow (paste the
  parent id); no `?join=` link until P4. The review screen is gated on reading
  the parent's slot, and the candidate cannot sign without seeing it.
- Provisional children draw as one ancestor highlight plus a labelled list row,
  never eight synthetic rectangles.
- Simple surface stays map-free: the quiet octal address is the region and
  mutual child rows gain their own address.
- Work is split: pass 1 = pure resolution/ranking + picker zone mode; pass 2 =
  assignment dialog + candidate review + wiring.

**What shipped (pass 1 + pass 2):**

- `region/paths` gained `addressToPath`/`pathToAddress`; `RegionDataset` gained
  `nearestPublishedAncestor`; new `zone-region.ts` (address + slots -> own cell,
  ancestor, eight child regions, free count) and `assignment.ts` (ranking and
  warning strings). All unit-tested.
- The Advanced region dialog now has **This zone** (own cell, legend, eight
  child cells with slot/letter/address/state, free count) and **A place**
  (the P1 point lookup). Root draws the world and its eight depth-1 cells;
  provisional cells use the nearest published ancestor, never a synthetic
  rectangle. Map is `aria-hidden`; the list/coordinate form is the keyboard
  path.
- `#add-child-slot` opens **Assign a child region**: optional newcomer
  location, ranked free cells (contained published cell first, then distance/
  population/slot, provisional last), warnings, then the existing slot editor
  writes the chosen slot. That write is the designation.
- The candidate's parent dialog reads the selected parent's board, derives the
  prospective address from its slot (`childSlotIndex`), and shows
  address/slot/cell plus a **See it on the map** review before signing. Missing
  or unreadable parents render explicit states; save stays available for the
  existing pending-link flow.
- Slot cards, unconfirmed rows and simple child rows show their octal region.
- `#board-region-state` fills with Published / Provisional / Root when the zone
  map is opened.

**Not in P2 (recorded for P3/P4):**

- The shallowest-zone-with-a-free-slot walk and `?root=` onboarding are P4.
- No `?join=` invite in P2: the candidate uses the existing parent-id flow, and
  the preview is informational, not a hard admission gate.
- Editing a written slot's contact is still allowed (a move-shaped operation;
  §4). Clearing still needs the existing confirmation.
- `#board-region-state` is filled only after opening the region dialog, so no
  dataset load happens on page load.
- The live site has **not** been republished with P2; it still serves the P1
  picker (`1794067282`). Publish after a maintainer review.

### P3a implemented (2026-11-07): members room

The implementation spec is `DESIGN-rooms.md`. Decisions taken there:

- **Separate WASM per room kind.** `room/` accepts `ZMR1` only; the candidate
  room (`ZCR1`) will be its own crate in P4. A shared WASM would force the P4
  request queue into today's code hash or re-key every members room.
- **History-based removal.** Old-epoch messages stay valid history; a removed
  member is rejected at the new epoch. This keeps merge associative and allows
  re-admission. The UI must render old epochs as history.
- **Membership history window 32, messages 200.** Messages are keyed by
  `BLAKE3(sig)[0..16]`, ordered by `(time, id)`, and filtered against the
  retained epoch memberships.
- **Contract never encrypts.** Bodies and epoch `secrets` are opaque; P3c adds
  client-side ECIES. The secrets shape is frozen now so P3c needs no re-key.
- **Multi-writer delta policy:** skip invalid deltas rather than rejecting the
  update; merge memberships first, then messages.
- **Artifacts deferred to P3b:** P3a adds the crate, `make room`/`room-check`,
  and CI. `published/room/` and its manifest arrive when the UI pins the hash,
  so the zone artifact gate stays independent.
- P3a exit: native tests prove exchange, outsider rejection, removal at the new
  epoch, old-message retention, and merge determinism; zone artifacts unchanged.

**What shipped (P3a):**

- New standalone `room/` crate (`number-room`, stdlib `0.12.1`, own lockfile):
  v1 state, owner-signed membership history (`seq` = epoch), 9-member cap,
  32-revision window, 200 bounded messages, opaque bodies/secrets, canonical
  membership/message bytes, join-semilattice merge, summary/full-catch-up
  delta, lenient multi-writer `update_state`, and 21 native tests including
  proptest merge laws.
- `fixtures/rooms/golden_v1.json` + `room/examples/gen_golden.rs`; regenerating
  is byte-stable. Rust consumes it now; TypeScript in P3b.
- Build plumbing: `make room` (19 s, 425,227-byte raw WASM), `make room-check`,
  `make check` includes it, a CI `room` job, and `.gitignore` entries.
  `make check-artifacts` still proves the zone/delegate bytes unchanged.
- Recorded room artifact: `published/room/number_room.wasm` (425,227 bytes),
  base58 `DWAtsfi3Ed5kGNZiXFxfU1AfjfGe83iAwb1BWHttFBPM`, hex
  `b9c54630c1e7ecac451a833e7e4d81739cc62832e6d88373b3c089e81e85c638`.
  `make room-record` / `make room-check-artifacts`; `make check-artifacts`
  verifies the sibling manifest and still proves the zone/delegate bytes
  unchanged. Not pinned in the UI yet; P3b2 adds the constant/client.

**P3b1 shipped (delegate v11):** `signRoomMembership` and `signRoomMessage`
with canonical bytes built in the delegate, per-room membership/message
counters, golden-fixture parity with the room crate, and the delegate recorded
as v11 (`3CPsh…` / `BRXS…`). v10 is in `LEGACY_DELEGATES`. No deploy: live
nodes still run v10; when v11 ships, open each zone once so the seed migrates
and the Background prompt is asked again.

**Next (P3b2):** the room client with 36-byte parameters and the pinned room
code hash (`published/room/manifest.json`), membership recomputed from zone
slots with a mismatch warning, the Advanced room panel, and a plaintext
send/render path. Then P3c adds client-side ECIES; do not present plaintext as
private.

### Gotchas worth remembering

- **The code hash is BLAKE3 of the raw WASM**, never the packaged file (the
  package embeds a container). Hashing the packaged file gives a different id.
- `cargo fmt` can change the manifest hash (panic-location line numbers). Format
  before recording; `regions-check` enforces `fmt --check`.
- `make regions-tool` builds **release**; sign/publish/verify use that binary.
  The earlier "`regions-tool` has no publish command" was a stale release build
  from before the subcommands were added.
- `publish --state` correctly overrides the 1-byte state bundled by
  `fdev build` (confirmed live).
- `region/` (crates) vs `/regions/` (ignored generated data).
- The dataset is a **prefix**: below `max_path_len` (7) cells are provisional.
  The zone tree may grow deeper; the map cannot distinguish those zones until
  S2. A deeper stage refines cells in place, without moving zones.
- The publisher seed is held by the operator outside the repo and is needed
  only to sign a new manifest seq. Losing it freezes updates; leaking it lets
  someone re-sign the index. The node ids on the VPS are **not** this key.

### Commands

```bash
# contracts (canonical remap) and tool
make regions-wasm && make regions-tool && make regions-check

# export the real stage (already done; regenerates .build/regions)
region/tool/target/release/regions-tool export \
  --db trie.db --out .build/regions --max-depth 7 --target 262144 \
  --blob-code-wasm .build/regions/blob.code.wasm \
  --expect-rows 1481182 --expect-row-bytes 35517561 --expect-shards 178

# sign (needs the operator seed), publish, verify
REGIONS_PUBLISHER_SEED="$(cat <seed-file>)" make regions-sign
make regions-publish     # 7509, 3 workers (override REGIONS_PUBLISH_PORT)
make regions-verify      # 7511, sample 8 (override REGIONS_VERIFY_PORT)

# UI
cd ui && npm run build && npm test && npm run test:e2e:offline
```

## Open items

Ranked by what a next session should care about. Nothing here blocks the current
deployment.

1. **Address-book import marker cannot persist (#ours, small).** The app runs in
   a sandboxed, opaque-origin iframe where `localStorage` throws, so the
   once-only marker is never written. Consequence is benign: the import happens
   during v5→v6 migration and the automatic repair never runs, so a deleted
   contact is never resurrected. The durable home is a delegate secret, which is
   a v11 re-key. **Decision 2026-11-02:** keep as a known limitation for now —
   the repair only matters outside the sandboxed deployment, so a delegate
   re-key solely for this marker is not justified. Store the marker in the
   delegate when a delegate change is needed anyway.
2. **Contact rename does not re-sign `childNames` (#ours, documented).** The
   child keeps seeing the name signed with the slot until the parent saves the
   slot again. Copy says so; do not let a future UI imply otherwise.
3. **`StateV6` is `deny_unknown_fields`; `Delta` and `Summary` are not
   (#ours, intentional).** State is strict so peers agree on bytes; a peer can
   still send ignored delta keys. Documented here, not in the design docs.
4. **#22 — the node shell does not render the Background grant prompt
   (upstream, blocked).** App side is solved: unregister + reinstall from the app
   triggers the prompt, and `/permission/{nonce}/respond` with `index: 0` grants
   it without changing owner or zone. A headless install can still wait on an
   unrendered prompt and leave the component Configured-but-inert. Evidence:
   `reports/upstream-background-grant-prompt.md`; filed as freenet/freenet-core
   #6039.
5. **freenet-stdlib#140 (upstream, workaround in place).** `SubscribeResponse`
   is serialised as `PutResponse`; the UI treats a subscribe timeout as
   "unconfirmed" and probes-then-PUTs. Remove the workaround when fixed.
6. **#15 Atlas listing (blocked externally).** Atlas is a read-only crawler
   index with no publisher submission. The site is live and usable by a fresh
   node but unlisted. Revisit when self-submission ships, or ask the operator to
   crawl it.

### Accepted limitations (not defects)

- **No cross-device address book.** Contacts live in the delegate; the exported
  identity (payload v2) carries them and restore brings them back. That is the
  transfer path and backup of record; there is no live sync. Decision
  2026-11-02: keep it that way — there is no server or shared private store to
  sync through.
- **Issued, not delivered.** A stalled downward payment leaves the amount issued
  at the payer until they withdraw or overwrite the slot; the UI says so. This
  follows from allowing an LCA endpoint.
- **Auto-advance needs the node's Background capability.** The app cannot grant
  it and cannot observe the decision (it infers it from `lastScan`). When it is
  not running, `Check for payments` and the manual sentence stay, so a leg can
  still advance. Decision 2026-11-01: keep that fallback and the in-app off
  switch rather than promise something the node can refuse.
- **No zone navigation.** Removed deliberately; protocol reads of neighbouring
  zones (values, links, routes) remain.
- **Mutual-only child slots.** A one-sided slot is treated as absent, listed
  separately as unconfirmed with Clear, and never routed through. Signed state is
  never auto-tombstoned.

## Rules that must not be broken

- `published/` is the deployed address. Change it only with
  `make record-artifacts`, only after the outgoing generation is in
  `ui/src/migrations.ts`, and only when `make check-artifacts` passes.
- Before changing contract WASM: append the outgoing hash to
  `LEGACY_CONTRACT_CODE_HASHES` if the new contract accepts its state, else to
  `UNMIGRATABLE_CONTRACT_CODE_HASHES`. Only the former is probed for migration.
- Before changing delegate WASM: append the outgoing key, code hash and webapp
  id to `LEGACY_DELEGATES`. Never remove a registry entry.
- The build remap namespace (`/cargo`, `/rustup`, `/build`) is frozen; changing
  a root re-keys everything.
- Signing domains are frozen for every recorded generation: `number:v2:slot`,
  `number:v2:contacts` (legacy only since v6), `number:v3:parent`,
  `number:v4:payments`, `number:v5:adjustments`, `number:v6:selfname`,
  `number:v6:childnames`.
- The owner public key is the stable anchor; the contract id moves with the
  contract WASM.
- Delegate import is refused once a seed exists. Anything that must survive an
  import (counters, contacts) is written **before** the seed.
- The payment route table is implemented twice — `ui/src/payments.ts` and
  `delegate/src/advance.rs`. Any change to it must land in both, driven by the
  same fixture-tree table, or the app and the unattended signer disagree about
  money.
- `selfName` is dormant: the v6 field and its signing domain stay for
  compatibility, but the UI must not write, read or display it. Child-slot
  names (`childNames`, signed by the parent) are the only live names.
- User-facing copy says **zone**; code identifiers, CSS ids/classes, signing
  domains and crate/file names keep `board`/`number` because renaming them
  changes bytes and re-keys everything.

## Verify

```bash
make check              # contract + delegate fmt/clippy/tests, UI build+tests
make check-artifacts    # byte-equality against published/
make e2e-offline        # built UI + mock backend, includes axe
make verify-merge       # merge laws against the v6 corpus
FREENET_BASE_URL=http://127.0.0.1:7509/v1/contract/web/<id>/ make e2e-gateway
# live nodes (through the SSH forwards)
node ui/e2e/readiness.mjs    # grants, addresses, scans, subscriptions
node ui/e2e/links.mjs        # parent tree + slot references, cycles
```

Expected at the time of writing: contract 123 tests, delegate 83, room 21, UI
299, offline e2e 26, `verify-merge` 14 laws / 0 violations.

## Live four-node test bed

VPS `unstate.ca`, APIs through local SSH forwards; four `freenet network`
services running as `paul` from `~/.local/bin/freenet` (0.2.153).

| Node | Unit | Ports | Role / owner |
|---|---|---|---|
| D | `freenet.service` | ws 7509, default network port (no flags; default data dir) | root, owner `3f84…` — the live zone above; slot 0 → A (address `root`) |
| A | `freenet-node2` | ws 7511, net 31338 | child 0 of D, owner `ea14…`; slot 0 → B (address `0`) |
| B | `freenet-node3` | ws 7512, net 31339 | child 0 of A, owner `4e7a…`; slot 3 → C, 90.00 (address `00`) |
| C | `freenet-node4` | ws 7513, net 31340 | child 3 of B, owner `06e6…`; no children (address `003`) |

A/B/C keep data, config and logs under `/var/lib/freenet-nodeN/`; D uses the
default `~/.local/share/freenet`.

Last full topology and readiness check 2026-11-02. A/B/C are READY (Background
granted, scanning, subscribed). **D is Configured but inert:** the grant reads
`granted`, but its delegate reports no code hash, no scans and no subscriptions,
and the app shows "This zone can carry payments but won't auto-advance on this
node. Reinstall the component…". Reinstall from the app origin (unregister +
install) to arm wake-ups; this is the documented #22 workaround. A delegate
re-key means each zone must be opened once so the seed migrates and the prompt is
asked again.

## Publishing (manual)

```bash
make build && make record-artifacts        # only when a WASM changed
fdev --port 7509 publish --code delegate/build/freenet/number_delegate \
     --parameters delegate/webapp_contract_id.bin delegate
fdev --port 7509 website update --key number-local ui/dist
```

The website key lives at `~/.config/freenet/website-keys/number-local.toml`
(this machine only; the VPS holds no keys). `fdev publish` alone does not arm
wake-ups — the app-origin install from the site does.

## Done

Newest first. Earlier work is summarised by commit; `git log` has the detail.

**2026-11-07 — P3b1: delegate v11 room signing**
- New `signRoomMembership` / `signRoomMessage` commands, strict validation,
  exact DESIGN-rooms §3 bytes duplicated in `delegate/src/room.rs`, per-room
  counters, and `RoomMessageResponse`.
- 9 new tests (83 total) including byte/signature/id parity with
  `fixtures/rooms/golden_v1.json`.
- Delegate re-key recorded: v11 `3CPsh…` / `BRXS…`; v10 appended to
  `LEGACY_DELEGATES`; contract unchanged; room artifact unchanged.
- No deploy. When v11 ships, open each live zone once (seed migration and
  Background prompt).

**2026-11-07 — P3a: members-room contract**
- New standalone `room/` crate implementing `DESIGN-rooms.md`: owner-signed
  membership history, bounded messages, opaque bodies/secrets, deterministic
  merge, summary/catch-up delta, lenient multi-writer updates.
- 21 native tests (signatures, bounds, removal/re-admission, merge laws,
  top-200/top-32, delta caps, replay); byte-stable golden vector.
- `make room`, `make room-check`, CI `room` job; zone/delegate artifacts still
  byte-identical. Room code hash provisional at `DWAts…` (not pinned).
- No contract/delegate/UI behavior changed; nothing published.

**2026-11-07 — P2: regions on the map and designation at admission**
- Pure layer: address codec helpers, `nearestPublishedAncestor`,
  `resolveZoneRegion`, slot ranking/warnings; +35 region tests.
- Advanced region dialog: **This zone** (own cell + eight child cells, published
  or provisional, list as keyboard path) and **A place** (P1 lookup).
- `Add a child slot` -> **Assign a child region** (optional location, ranked
  cells, then the existing editor writes the designation).
- Candidate parent dialog shows the assigned address/slot/cell before signing,
  with a map review; no save-flow change.
- Slot/unconfirmed/simple rows show octal addresses. UI only; no contract,
  delegate or signing change. 299 unit / 26 offline e2e pass.
- Not published: the live site remains at `1794067282` (P1 picker).

**2026-11-07 — site republished with the region picker**
- `fdev --port 7509 website update --key number-local ui/dist` → version
  `1794067282`, 9 files / 404628 bytes. No WASM change, no re-key.
- Live bundle `index-BFPNfg9F.js` + lazy `picker-B-_fJI4b.js`; all four nodes
  verified by SHA-256. P1 is complete; P2 starts next.

**2026-11-02 — zones (`8271776`, site `1793620651`; copy `794f870`, site `1793621397`)**
- User-facing copy says **zone**; identifiers, ids and signing domains keep
  `board`. No contract/delegate change, no re-key.
- A zone has no name of its own: the name row, Rename action and name dialog
  are gone; `selfName` is dormant (never written, read or seeded), and
  `childNames` are the only live names.
- Simple view: `Your zone` plus a quiet octal address; the record card is
  labelled `Balance` and never names the parent; the parent prompt with
  `Add a parent` appears only when the link is missing/broken. Children stay on
  the simple view. Changing/clearing a healthy parent lives in Advanced.
- Follow-up `794f870`: the record card is labelled `Balance`; the provenance
  caption is gone.
- Receive links take `name=` from the parent-given child name, else omit it.
- `DESIGN-views.md` Revision 3; `DESIGN*.md` carry a terminology note.

**2026-11-02 — readiness probe fixed**
- `ui/e2e/readiness.mjs` waits for the status pill to be *attached* (it lives on
  the hidden Advanced surface), switches to Advanced before reading, opens
  Details only when closed, and accepts the `zone` subscription wording. It now
  reports 7511/7512/7513 READY; 7509 is Configured-but-inert (see the test bed).

**2026-11-02 — contact validation consolidated (`9c26acb`, site `1793625118`)**
- UI address-book rules live once in `ui/src/contact-rules.ts`; `delegate.ts`,
  `mock.ts` and `identity.ts` are thin adapters that keep their own error
  types. `delegate/src/lib.rs` remains the authority; no wire change. 18 new
  unit tests.

**2026-11-02 — owner id and child ids (`3e99567`/`5048d47`, site `1793623558`)**
- Simple view: a quiet `Your id` row after the actions shows the shortened
  64-hex user id; the full key is the title and the copy control writes it to
  the clipboard with a visible `Copied.` result.
- Advanced child slots and the simple children list show the child's shortened
  user id (full key in the title); unconfirmed rows do not.
- UI only; no contract/delegate, state or signing change. `DESIGN-views.md`
  Revision 4.

**v6 → v10 (2026-11-01, current lineage)**
- `81bb25d` LCA-endpoint payment routes (implicit issue/burn) in UI and delegate;
  board navigation removed.
- `65c3ea6` children and parent on the default view; header copy removed;
  `Your Board Name:` label; manual payment controls conditional on auto-advance.
- `6b77fff` live-deploy fixes (contract id survives reconnect; import-marker
  warning demoted) + docs.
- `53b4dcf` leaf-first default view and the advanced page.
- `c1c54ad` contract v6 + delegate v9: private address book in the delegate,
  signed `selfName`/`childNames`, v5→v6 migration with contact import, legacy
  heal. `DESIGN-v6.md`.

**Earlier**
- `4fd9793` live board link audit; `88ea976` upstream issue recorded;
  `d38a30a` Background-prompt issue filed; `ee70b3f` #26 non-leaf warning;
  `bfc1141` #25 rerunnable smoke; `5d88595` #24 stuck state;
  `130ec53` #23 stale own-board refresh; `c57064f` readiness check;
  `8481cb1` unscanned ≠ stale; `5f42976` #22 app-side prompt;
  `f4ebadc` live smoke harnesses; `3a214f2` Clear stuck payment;
  `9460c91` delegate v8 auto-advance; `e1b5b6e` v5 issue/burn;
  `cfd6388` resolve_owner prefers committed state.
- `a95ca9e` v3 tree; `5ddf3b7` board-name/header UI `5ddf3b7`;
  `e0a64b5` tree-read timeout; `e1301f5` v2 address book + hundredths.
- Earlier still: `ba81747` (#1/#2/#4/#5/#6), `8bba3e2` (#3 reproducible build),
  `72672f6` (#7 verify-merge), `5c9a84e` (#8 dev proxy), `2f6ee8c` (#9 port
  consistency), `9eb7a35` (#10 identity export/import), `cce462a` (#11 exact
  i64), `0658c1c` (#12 live deploy), `1da4fa3` (#14 delegate bootstrap).
- Resolved items no longer tracked separately: #13 (upstream report,
  freenet-stdlib#140), #16 address book, #17 tree, #18 board names/header,
  #19 parent value + octal address, #20 cooperative payments (v4), #21 v4.1/v5
  auto-advance + issue/burn, #23 stale committed copy, #24 complete-vs-blocked,
  #25 stateful live smoke, #26 non-leaf auto-advance warning.

## Generation history

Newest first. **Never remove an entry**; the record gate and
`migrations.test.ts` enforce that every superseded generation is registered.

- Contract **v6** `CsFEfMWUH6ai22TWHWqExoL7nvgnHCCGz6TfbVMAcRbw` — current.
- Contract v5 `5YKHJAKaLcMoKaM9nhXJweGytK6CpDvsskEzPfFJ3jrg` — migratable (v6
  drops `contacts` and adds empty name records; all other signatures survive).
- Contract v4 `C8AnGpZR7y2n73SUN9ftCctG83V3n83CruunfbTEFVGT` — migratable.
- Contract v3 `7j8ycU22TP9CfgGCk1nztWe6nqiasM6TS71Lg2fj9WPg` — migratable.
- Contract v2 `A1J4T4sJ4xwRtbbu8QpXhCSyMHrW1uMp2H4H5BfBdiur` — migratable.
- Unmigratable: `6h9ugwNX5JxgXhadYvvLp8Eu1jPMRe46zXQnAKrRpt57` (unsettled v4),
  `6DJM6gSdfUdHe4ec4mwvAvQHLx9Jonkq8deEoWZ1jfmX` (v1), `3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd`
  (pre-remap build), `7aK2LcB5Uy8V8AYJYF7entSPk4noEcnYaa72EWpJG1ez` (first v1).
- Delegate **v11** `3CPshayRgEihDtRUzUSr775LnWB5WXj7r8vjj3GMtMrd` /
  `BRXSZhh95SVz7GhDPCa4HWdC4dukqma2ptajyW1GAgCm` — members-room signing;
  current in the repo, not deployed.
- Delegate v10 `6RQvoNj3CQV2AWTruyuExE3gMcXyxWK2cmE47rPXowrV` /
  `AmbYHZnEfQ8n5vZmbWT6XQU4iVTAhx9Ua9swy6QD5nBe` — LCA payments; superseded by
  v11, registered.
- Delegate v9 `9a34iJr7yK1RRV3tAu3jp7nTSkPYMb6ySv9HeTGXh7vA` / `Cnfyn…` — v6
  data layer; registered.
- Delegate v8 `8G5M9XNyrZC7kYmpnrJPtBA3N29DdmhGfAa4KoMfdwWg` / `3PoWy…` —
  auto-advance + stale-cache fix; registered.
- Older registered generations (v7 and earlier) are in `ui/src/migrations.ts`.
  The very first delegate `8GpT86YK…` predates `export` and is permanently
  unrecoverable; its zone is abandoned, as are the test-only `44uPSHVv…`.

## Handoff notes

- The four VPS services are system units owned by root but run as `paul`; a
  restart needs interactive sudo (`sudo systemctl restart freenet freenet-node2
  freenet-node3 freenet-node4`).
- Nodes were upgraded from freenet 0.2.151 to 0.2.153 on 2026-11-01; old
  binaries are kept as `~/.local/bin/{freenet,fdev}.0.2.151.bak` on both hosts.
  CI still pins 0.2.151.
- What a fresh session should do first: run `make check` and
  `make check-artifacts`, then `node ui/e2e/readiness.mjs` against the live
  nodes; if the delegate was re-keyed, open each zone once.

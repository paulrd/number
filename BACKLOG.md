# Backlog and handoff

Durable state for the project. Read this with `README.md`, then the design docs:
`DESIGN.md` (v4/v5), `DESIGN-v6.md` (private address book, signed names),
`DESIGN-network.md` (regions, onboarding, rooms; growth deferred),
`DESIGN-regions-p1.md` (stage-1 dataset, contracts, picker),
`DESIGN-views.md` (what the two surfaces may contain, + revision 3),
`DESIGN-payments-lca.md` (payments whose endpoint is the LCA),
`DESIGN-rooms.md` (members-room contract, P3a), and
`DESIGN-candidates.md` (candidates-room contract, P4a).

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
| Delegate | **v13** `CdhuwP79DJ72jXNRooDqFbJtd2X6tY7HioayqRA69wuv`, code `BJQwHJqtpRavCn2xULWuAtsDDUtyu8x74ppb3d7amRKn` (live on all four nodes) |
| Room contract | **P3a members room** recorded in `published/room/`; code `DWAtsfi3Ed5kGNZiXFxfU1AfjfGe83iAwb1BWHttFBPM`; pinned in the live UI |
| Candidate contract | **P4a** recorded in `published/candidate/`; code `4P2HZkm7K2DERij1uMf5UxgLnUYxaK3esPWEXTC3vimh`; pinned by the P4c client, not deployed |
| Live owner identity | `3f8411470c801051120a0ff14b5ab571c5660df42c17bc72677c37f2505c27b0` |
| Live zone (v6 instance) | `5vwEEpEBENdqKCVsHH1qqtyZ8rtP7pA2jFroSTBWB4dL` — dormant `selfName` `Dad`, root, one mutual child `Tim` |
| Live site | version `1794135174`, bundle `assets/index-CNI3c8J-.js` + lazy `assets/picker-XEjP6UmC.js`, identical on `7509`/`7511`/`7512`/`7513` |
| Tooling | `freenet` 0.2.155 (`5aa241a`), `fdev` 0.3.317; CI pin `FREENET_VERSION` 0.2.155 |
| Local node | `:7510` stopped, loopback-only. When started it will not fetch the live site; run `fdev --port 7510 website update --key number-local ui/dist` |
| Artifacts | `published/manifest.json` is the source of truth for the address |
| Last UI publish | 2026-11-08; site `1794135174`, delegate v13; contract unchanged |
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

## Where we left off (2026-11-08) — P4c owner side

### P4c3a implemented (2026-11-08): owner request queue

- Advanced **Join requests** panel over the owner's own candidate room:
  accepting toggle (absent config = accepting, writes `seq+1`), newest-first
  queue with requester/cell/note/time, per-row Dismiss, Clear all with
  confirmation and failure retention, refresh, and a **Copy join link**
  (`?root=<ownId>`) with a manual fallback.
- Reads and writes go through `board.candidateTransport` with the owner id;
  a missing room is an empty queue. Every write is confirmed by the transport's
  re-read; failures keep the row and show a readable error.
- No interview/admit control yet (P4c3b).
- Offline e2e: a request posted through the join flow appears in the owner
  queue, accepting toggles, dismiss empties it, join-link copy, axe and console
  clean. UI 457 tests / 33 files; offline e2e 34.

**Next is P4c3b (interview/admit), then P4d (live smoke + republish).**

- P4c3b: invite one requester per epoch (membership = owner ∪ children ∪
  requester, fresh secrets), encrypted interview chat, reject/rotate, and the
  admit handoff (owner writes the slot, candidate sees the region and signs
  parent). Spec is `DESIGN-candidates.md` §12.2.
- P4d: live two-identity onboarding smoke (no contacts → root link → request →
  interview → admit) and site republish.

### P4c2 implemented (2026-11-08): discovery UI

- Pure layer `ui/src/region/onboarding.ts`: `?root=` parsing, root validation
  (mutual parent vs pending), and the match walk — point → published digits →
  first zone with a free slot, mutual-edge descent, slot-order fallback past the
  published depth, 32-zone bound, saturated `full`/`broken`, ranked assignment
  preview. 14 tests.
- Candidate transport is now on both backends: `OnlineBoard` exposes a lazy
  `candidateTransport` (closed with the board), and `OfflineBoard` uses a new
  in-memory `OfflineCandidateTransport` (requests, config, dismiss, membership,
  messages, deterministic epochs).
- `ui/src/onboarding-panel.ts`: a `?root=` link opens a discovery dialog after
  the first-run prompts (queued like `?room=`, parameter cleared only when the
  flow settles); Advanced gains a quiet **Join a zone** action. The flow
  validates a pasted link/id, lazily loads the Leaflet picker (click or lat/lng),
  draws the chain and target, shows the target's address, `occupied/8` and
  accepting/queue state, previews the assigned slot/cell with the §11 warning,
  and posts a signed request with the exact public payload and a byte-capped
  note. Saturated branches and read failures have explicit states.
- Offline e2e covers Advanced join (request sent), the `?root=` entry and
  parameter lifecycle, duplicate `root` values, console errors and axe.

Verified: `make check` (UI 433 tests, 32 files; all Rust suites),
`npm run test:e2e:offline` (33 tests) and `make check-artifacts` all pass.

**Next is P4c3 (owner queue/interview/admit), then P4d (live smoke + republish).**

- P4c3: own candidate-room panel (queue with requester/cell/note/time, dismiss
  and clear, accepting toggle), one-candidate-per-epoch invite/interview with
  encryption, and the admit handoff (owner writes the slot, the candidate sees
  the assigned region and signs parent).
- P4d: live two-identity onboarding smoke (no contacts → root link → request →
  interview → admit) and site republish.

### P4c1 implemented (2026-11-08): candidate client layer

The wire/client layer is in place; no UI flow or deployment yet.

- `ui/src/candidate-state.ts` mirrors `candidate/src/lib.rs`: canonical state
  and delta codecs, request ids, digest, merge semilattice, and queue/
  dismissal/config rules. `room-state.ts` now exports the membership/message
  record codecs so both kinds share one implementation.
- `ui/src/candidate-client.ts` mirrors `OnlineRoomTransport` with tag `ZCR1`:
  params/instance derivation, bundled-WASM `ensure`, `request`, `setAccepting`
  and `dismiss` (owner-only), plus the membership/message/epoch methods. Every
  write is re-read and confirmed because the contract skips invalid deltas.
- `room-crypto.ts` accepts an optional `tag` on the body AAD context (default
  `ZMR1`); the candidate client passes `ZCR1`, matching delegate v13's
  tag-bound sealing.
- `delegate.ts` has typed `signCandidateRequest` / `signCandidateDismissal` /
  `signCandidateConfig` methods.
- Artifact gate: `published/candidate/` (603,909 bytes, code `4P2HZkm…`),
  `make candidate-record` / `candidate-check-artifacts`, included in
  `make check-artifacts`; `scripts/build.sh` pins and copies
  `ui/public/number_candidate.wasm`, and the UI gets the `__CANDIDATE_*`
  constants.
- One candidate per epoch remains a client invariant for the P4c2 UI.

Verified: `make check` exit 0 (UI 398 tests, all Rust suites) and
`make check-artifacts` OK for contract, delegate, room and candidate.

**Next is P4c2 (the discovery UI), then P4c3 (owner queue/interview/admit),
then P4d (live smoke).**

- P4c2: parse `?root=`; validate the root by reading it (exists, no mutual
  parent, empty address); ask for a root when absent; map click → published
  cell path → shallowest zone with a free slot (slot order beyond the published
  depth); target panel; request form with the exact public payload; saturated
  branch message.
- P4c3: own candidate-room panel (queue, dismiss/clear, accepting toggle),
  invite/interview flow (one candidate per epoch), and the admit handoff
  (owner writes the slot, candidate sees the region and signs parent).
- P4d: live two-identity onboarding smoke and site republish.

### P4b implemented and deployed (2026-11-08): delegate v13

- `validate_tag` accepts `ZMR1` and `ZCR1`; `sealRoomEpoch` / `openRoomSecret`
  bind the caller's tag into the HKDF info, so a members-room blob and a
  candidate-room blob are not interchangeable.
- New commands: `signCandidateRequest` (requester = local key, owner may
  differ; returns `requester`, `requestId`, `sig`), `signCandidateDismissal`
  and `signCandidateConfig` (owner only). No counters: a request is
  standalone, dismissals are idempotent and `config` is monotone in the
  caller-supplied `seq`.
- Canonical candidate bytes match `fixtures/candidate/golden_v1.json`; 104
  delegate tests. Delegate v13 `CdhuwP79…` / `BJQwHJqt…`; v12 registered in
  `LEGACY_DELEGATES`; artifacts recorded and `make check-artifacts` passes.
- **Live:** delegate registered on 7509; site `1794135174` (10 files, 476,616
  bytes compressed; `index-CNI3c8J-.js` + lazy `picker-XEjP6UmC.js`),
  identical on all four nodes. Every zone was opened once and migrated
  v12→v13 with the same owner and address.
- 7509 still needed the #22 routine (unregister the delegate, reinstall from
  the app origin, answer `/permission/pending` with index 0) before its wake
  cycle ran; after one cycle `readiness.mjs` reports all four READY.

### P4a implemented (2026-11-08): candidates-room contract

The implementation spec is `DESIGN-candidates.md`. This phase is the contract
only: no delegate, UI, artifact or deployment change.

- **New standalone `candidate/` crate** (`number-candidate`, lib
  `number_candidate`, own lockfile) accepting parameters `b"ZCR1" || owner_vk`.
  The members room stays frozen at `ZMR1`; nothing under `room/` changed.
- **State v1 = the members-room state plus three records.** `requests` is the
  bounded public queue (newest 8 by `(time, id)`; `want_cell` is 0–32 octal
  digits, empty = world; `note` ≤256 opaque bytes; requester-signed, no
  membership required). `dismissals` is the owner-signed set of dismissed
  request ids (newest 64). `config` is the owner-signed accepting flag,
  monotone by `seq`; absent = accepting.
- **Requests are the only open write.** Everything else keeps the members-room
  authorship rules. Clearing is dismissals; closing is `config`. Both are
  merge-effective and delete nothing from contract history.
- **Merge is a join semilattice** over memberships, messages, requests,
  dismissals and config; full catch-up deltas; invalid deltas skipped.
- **Signing domains:** memberships and messages reuse
  `number:v1:room:{membership,message}` with tag `ZCR1` (the tag separates the
  kinds); new domains are `number:v1:candidate:{request,dismiss,config}`. The
  P3c secret/body envelope is reused with `ZCR1`, so delegate v13 only has to
  accept the tag.
- **One candidate per epoch** (owner adds a candidate to membership, interviews,
  then removes them on reject or admit). The contract cannot see zone slots, so
  the client enforces this.
- **Build plumbing:** `make candidate`, `make candidate-check` (part of
  `make check`), CI `candidate` job, `.gitignore`, `scripts/build.sh
  --crate candidate`. The UI constants step is unchanged.
- **Provisional code hash** (raw WASM, 603,909 bytes):
  `4P2HZkm7K2DERij1uMf5UxgLnUYxaK3esPWEXTC3vimh`, hex
  `32374ace456c653ad49031bfba4fd5aa58de735c59d58904be5a66c03242ebac`.
  Not recorded in `published/` and not pinned by the UI: the artifact gate and
  the pin land in P4c, so the contract can still change during integration.
- Golden fixture `fixtures/candidate/golden_v1.json` (request, dismissal,
  config, plus the reused membership/message) is byte-stable.

Verified 2026-11-08: `make candidate-check` (24 tests), full `make check`
(contract, delegate, room, candidate, regions, UI 366) exit 0, and
`make check-artifacts` still proves the zone, delegate and members-room bytes
unchanged.

**Next is P4c (client + `?root=`), then P4d (deploy).**

- P4c: `?root=` parsing and validation, the shallowest-free-slot match walk,
  the target panel, request write, queue/interview/admit UI, candidate-room
  client with the pinned hash, `published/candidate/` and the artifact gate.
- P4d: live two-identity onboarding smoke (no contacts → root link → request →
  interview → admit) and site republish.

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
- **The website is republished.** Live site `1794073317` serves the P2 UI
  (`assets/index-B6sOsgQr.js` + lazy picker `assets/picker-CjhRHu9C.js`) and
  delegate v11 from all four nodes; hashes match the local build.
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

Tests: **22 Rust** (4 wire, 6 blob, 7 manifest, 5 tool), **21 room**, **24
candidate**, **104 delegate**, **457 UI**, **34 offline e2e** (the region/room
tests are Axe-clean and make no external requests), plus the manual live-room
smokes.

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

**P3b1 shipped and deployed (delegate v11):** `signRoomMembership` and
`signRoomMessage` with canonical bytes built in the delegate, per-room
membership/message counters, golden-fixture parity with the room crate, and the
delegate recorded as v11 (`3CPsh…` / `BRXS…`). v10 is in `LEGACY_DELEGATES`.
Deployed 2026-11-07: site `1794073317`; each zone was opened once, seeds
migrated, and all four nodes re-armed (D needed the #22 unregister + app-origin
reinstall). Readiness is green.

**P3b2 implemented and verified live (2026-11-07):** room data layer and panel.
`ui/src/room-state.ts` (v1 codec, digest, merge, member derivation),
`ui/src/room-client.ts` (36-byte `ZMR1` params, derived instance id, own WS,
PUT/GET/update, WASM hash check, delegate-backed membership/message signing),
`ui/src/room-panel.ts` + Advanced block/dialog, and an offline in-memory
transport. Build pinning: `make build` copies the raw room WASM to
`ui/public/number_room.wasm`, writes the hash constants, and fails if the
build differs from `published/room/manifest.json`.

Foreign rooms: `?room=<owner-id>` opens another owner's room; owner-only
controls and slot-derived mismatch checks apply only to your own room. A child
signs with its own delegate key; the contract decides membership. The client no
longer requires the signer to equal the room owner (that bug blocked every
child), and a sent message is re-read and confirmed before it is reported.

Deployed as site `1794078151`. Live two-identity smoke (`ui/e2e/live-room.mjs`,
7511/7512/7513) passes: A signs membership including B; B opens A's room via
`?room=` and posts; A sees it; C is a non-member and its composer is disabled.
UI: 349 tests, 29 offline e2e.

**Next (P3c):** client-side ECIES epoch secrets and the secret-rotation UI.
Rooms must not be called private before that. P4 is the candidate room +
`?root=` onboarding.

### P3c implemented and verified live (2026-11-07): encrypted rooms

`DESIGN-rooms.md` §7 is the frozen spec. Decisions:

- **Ed25519→X25519 conversion**, not a second key (a separate key would be a
  zone/room re-key). The delegate derives both directions from the seed.
- **Delegate v12** adds stateless `sealRoomEpoch` (owner-only; generates the
  epoch key) and `openRoomSecret`. Epoch keys are never persisted; the UI
  caches them in memory for the session. Maintainer approved this re-key.
- **AES-256-GCM** for both the 93-byte secret blob and the body; HKDF-SHA256
  with room/owner/epoch/recipient context. ChaCha20-Poly1305 blob version
  0x02 is the fallback if wasm size demands it.
- Body envelope `0x01 || nonce || ciphertext || tag`; fail-closed. Legacy
  plaintext stays readable with an "Unencrypted" badge. Encrypted composer cap
  is 995 bytes (contract cap 1024).
- **Rotate on every membership change**; removal re-seals to the remaining
  members. The composer is hard-locked while the zone-derived member set
  differs from the signed membership (not just warned).
- No forward secrecy against key compromise; rotation-based revocation only.
  UI copy must not claim more.
- v12 re-key: register v11, record artifacts, open each live zone once; then
  deploy and run an encrypted two-node smoke (encrypt, rotate, remove,
  re-admit, history).

**Shipped:** delegate v12 `C669…` / `zpYa…` (95 tests) with
`sealRoomEpoch`/`openRoomSecret` (93-byte AES-256-GCM blobs, HKDF-SHA256,
Ed25519→X25519), recorded artifacts, and v11 in `LEGACY_DELEGATES`. UI:
AES-GCM body envelopes (0x01), in-memory epoch cache, encrypted/plaintext/
unreadable badges, owner **Enable encryption**/**Rotate key**, 995-byte
composer cap, and the hard composer lock on membership mismatch.

Deployed as site `1794080195`. All four nodes re-armed on v12 (7509 and 7512
needed the #22 unregister + app-origin reinstall). `ui/e2e/live-room-crypto.mjs`
passes on 7511/7512/7513: A enables encryption, the raw body is `0x01`
ciphertext with no plaintext, B decrypts, and C (non-member) sees
"Not readable" with the composer disabled. Removal/re-admission/history remain
covered by offline/unit tests to avoid disturbing the test-bed tree.

Tests: delegate 95, UI 366, offline e2e 30, plus the live plaintext and
encrypted room smokes. Next is P4: candidate room + `?root=` onboarding.

### Gotchas worth remembering

- **The epoch secret is bound to the epoch it was sealed for.** If the delegate
  membership counter is ahead of room state, reseal at the seq you will sign;
  never store a blob sealed for a different epoch.
- **Delegate v11→v12 (and any future re-key) needs an app-origin install.**
  `fdev publish` alone arms nothing; inert nodes need the #22 unregister +
  reinstall and one wake-up cycle.

- **A room message is signed by its author, not the room owner.** The delegate
  always signs as the local key; the room contract checks the author against
  the epoch's membership. Never compare `signed.author` with the room owner id.
- **The room contract skips invalid deltas silently.** After any write, re-read
  and confirm the record/message is present before reporting success.
- **A room is opened with `?room=<owner-id>`**; owner-only membership controls
  and slot-derived mismatch checks apply only when the target is your own zone.

- **A delegate re-key still needs an app-origin install.** `fdev publish`
  registers the code but arms nothing. On the publishing node the UI may skip
  the install dialog because the new key is already registered; then the
  delegate is configured but inert (`lastScan: 0`, no subscriptions). Fix:
  send `UnregisterDelegate` over a gateway WS opened with the shell
  `freenetBridge` auth token, open the site, click Install, answer
  `/permission/pending` with `index: 0`, and wait one 300 s cycle.
- **Members-room and candidate-room records share signing domains, not tags.**
  `number:v1:room:{membership,message}` is signed with `ZMR1` in the members
  room and `ZCR1` in the candidate room. Never drop the tag from the signed
  bytes; it is the only thing preventing a replay across kinds.

- **The candidate request queue is bounded, not deleted.** Clearing writes
  owner dismissals; a dismissal that falls out of the 64-id window can let a
  stale full-state replay resurrect an old request. The 8-entry queue and the
  window make this an accepted bound.

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

# candidate room contract (native tests; no artifact yet)
make candidate-check && make candidate

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
- The candidate room is a **separate WASM** (`ZCR1`). Never fold it into the
  members room or reuse the members-room code hash; that re-keys every live
  members room. Never add open writes outside the candidate request queue.
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
make check              # every crate (fmt/clippy/tests) + UI build+tests
make check-artifacts    # byte-equality against published/
make e2e-offline        # built UI + mock backend, includes axe
make verify-merge       # merge laws against the v6 corpus
FREENET_BASE_URL=http://127.0.0.1:7509/v1/contract/web/<id>/ make e2e-gateway
# live nodes (through the SSH forwards)
node ui/e2e/readiness.mjs    # grants, addresses, scans, subscriptions
node ui/e2e/links.mjs        # parent tree + slot references, cycles
```

Expected at the time of writing: contract 123 tests, delegate 104, room 21,
candidate 24, UI 457, offline e2e 34, `verify-merge` 14 laws / 0 violations.

## Live four-node test bed

VPS `unstate.ca`, APIs through local SSH forwards; four `freenet network`
services running as `paul` from `~/.local/bin/freenet` (0.2.155).

| Node | Unit | Ports | Role / owner |
|---|---|---|---|
| D | `freenet.service` | ws 7509, default network port (no flags; default data dir) | root, owner `3f84…` — the live zone above; slot 0 → A (address `root`) |
| A | `freenet-node2` | ws 7511, net 31338 | child 0 of D, owner `ea14…`; slot 0 → B (address `0`) |
| B | `freenet-node3` | ws 7512, net 31339 | child 0 of A, owner `4e7a…`; slot 3 → C, 90.00 (address `00`) |
| C | `freenet-node4` | ws 7513, net 31340 | child 3 of B, owner `06e6…`; no children (address `003`) |

A/B/C keep data, config and logs under `/var/lib/freenet-nodeN/`; D uses the
default `~/.local/share/freenet`.

Last full topology and readiness check **2026-11-08: all four READY** on
freenet 0.2.155 (v12 delegate, Background granted, scanning, subscribed; 7509 re-armed with the #22
unregister + app-origin reinstall workaround). Earlier, D was Configured but
inert. A delegate re-key means each zone must be opened once so the seed
migrates; v10→v11 was done on 2026-11-07 without changing owners or addresses.

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

**2026-11-08 — P4c3a: owner join-request queue**
- Advanced Join requests dialog: accepting toggle, newest-first public queue
  (requester/cell/note/time), Dismiss, Clear all with confirmation, refresh,
  and Copy join link with a manual fallback. Missing room = empty queue; every
  write is confirmed by the transport.
- No interview/admit action yet; spec for that is §12.2.
- UI 457 tests / 33 files, offline e2e 34, axe and console clean.

**2026-11-08 — P4c2: discovery UI**
- Pure match walk (`region/onboarding.ts`): root parsing/validation, point →
  published digits → shallowest free-slot zone, mutual-edge descent, slot-order
  fallback, saturation; 14 tests.
- Candidate transport on both backends (lazy online, in-memory offline).
- Join-a-zone dialog: `?root=` queueing, pasted link/id, lazy map + lat/lng,
  chain/target, accepting/queue state, assigned-region preview, public request
  payload, signed request, saturated/error states. Advanced-only entry; simple
  view unchanged. Offline e2e + axe.
- UI 433 tests / 32 files; offline e2e 33; `make check` and
  `make check-artifacts` green. No deploy.

**2026-11-08 — P4c1: candidate client layer**
- `candidate-state.ts` (contract mirror: codecs, digest, merge, queue/config
  rules) and `candidate-client.ts` (`ZCR1` transport: ensure/request/
  setAccepting/dismiss plus membership/message/epoch methods), with re-read
  confirmation on every write.
- Tag-aware body AAD (`room-crypto` optional tag); delegate v13 command
  methods wired into `delegate.ts`.
- Candidate artifact recorded and gated: `published/candidate/`, `make
  candidate-record`, `candidate-check-artifacts`, build-time pin and bundled
  WASM. UI 398 tests, 28 files; `make check-artifacts` OK on all four kinds.
- No UI flow or deployment; that is P4c2/P4c3.

**2026-11-08 — P4b: delegate v13, deployed**
- Both room tags accepted; `sealRoomEpoch`/`openRoomSecret` bind the caller's
  tag into the HKDF info (member and candidate blobs are not interchangeable).
- `signCandidateRequest` (local key, any owner; returns `requestId`),
  `signCandidateDismissal` and `signCandidateConfig` (owner only), with no
  counters; canonical bytes match the candidate golden fixture. 104 tests.
- v13 `CdhuwP79…` / `BJQwHJqt…`; v12 added to `LEGACY_DELEGATES`; artifacts
  recorded; `make check-artifacts` passes.
- Deployed site `1794135174` (10 files); all four nodes opened once and
  migrated v12→v13 with the same owners and addresses. 7509 needed the #22
  unregister + app-origin reinstall, then one wake cycle; all four READY.

**2026-11-08 — freenet 0.2.155 upgrade**
- Local and VPS `freenet`/`fdev` upgraded from 0.2.153/0.3.315 to
  0.2.155 (`5aa241a`) / 0.3.317 from the signed release tarballs; SHA-256
  checked against `SHA256SUMS.txt`, `.0.2.153.bak` kept on both hosts.
- Restarted all four VPS services without interactive sudo: D is
  `Restart=always` (SIGTERM), A/B/C are `Restart=on-failure` (SIGKILL); systemd
  restarted each on the new binary.
- `readiness.mjs`: all four READY (grants, configured delegate, scans,
  subscriptions); live `index-DDEsV89s.js` identical on all four nodes.
- CI pin moved to 0.2.155.

**2026-11-08 — P4a: candidates-room contract**
- New standalone `candidate/` crate (`ZCR1`), state v1 = members-room state +
  bounded request queue (8), owner dismissal set (64) and owner accepting
  config; requests are the only open write.
- Canonical request/dismiss/config bytes; membership and message records reuse
  the room domains under the `ZCR1` tag; P3c envelope reused with `ZCR1`.
- Semilattice merge, full catch-up deltas, invalid deltas skipped; 24 native
  tests and a byte-stable golden fixture.
- `make candidate`/`candidate-check`, CI `candidate` job, build-script support;
  `make check` and `make check-artifacts` pass. No delegate/UI/artifact/deploy
  change; code hash provisional at `4P2HZkm…`.

**2026-11-07 — P3c: encrypted members rooms**
- Delegate v12 `C669…` / `zpYa…`: Ed25519→X25519 conversion, HKDF-SHA256,
  AES-256-GCM 93-byte epoch blobs, `sealRoomEpoch` (owner-only) and
  `openRoomSecret`; 95 delegate tests, golden vector.
- UI AES-GCM body envelope (0x01), in-memory epoch cache, encrypted/plaintext/
  unreadable badges, Enable encryption/Rotate key, 995-byte cap, hard composer
  lock on membership mismatch; 366 UI tests, 30 offline e2e.
- Re-key deployed: v11 registered, artifacts recorded; site `1794080195`.
- All four nodes re-armed on v12 (7509/7512 via #22 unregister + reinstall).
- `live-room-crypto.mjs` passes: raw body is ciphertext, B decrypts, C sees
  only "Not readable". Removal/re-admission/history covered offline.

**2026-11-07 — P3b2: members-room client and panel**
- Room codec/merge/digest with golden parity; 36-byte `ZMR1` derivation and a
  sibling WS transport (PUT initial state, GET, update, WASM hash pinning).
- Delegate room membership/message commands wired into `DelegateClient`.
- Advanced members-room panel: plaintext notice, derived member rows,
  none/match/mismatch, owner-only membership update, message log with history,
  composer and 1024-byte cap.
- Foreign rooms via `?room=<owner>`; owner-only controls stay on the own room.
- Fixed the client's author check (a child signs as itself, not the room owner)
  and confirm a sent message by re-reading the room.
- Deployed site `1794078151`; live smoke A↔B on 7511/7512 passes, C blocked.
- 349 UI tests, 29 offline e2e, plus `ui/e2e/live-room.mjs`.

**2026-11-07 — deployed P2 + delegate v11**
- Push `63ef861`; `fdev publish` registered delegate v11 on 7509;
  `website update` published site `1794073317` (9 files).
- All four nodes serve identical `index-B6sOsgQr.js` / lazy
  `picker-CjhRHu9C.js`. Each zone opened once; seeds migrated v10→v11 with the
  same owners and addresses.
- D (7509) needed the #22 unregister + app-origin reinstall to arm wake-ups;
  after one 300 s cycle all four nodes report READY (scans + subscriptions).
- Room artifact `published/room/` is committed but not used by the UI yet.

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
- Delegate **v13** `CdhuwP79DJ72jXNRooDqFbJtd2X6tY7HioayqRA69wuv` /
  `BJQwHJqtpRavCn2xULWuAtsDDUtyu8x74ppb3d7amRKn` — candidate-room signing
  (request/dismiss/config), `ZCR1` tag acceptance and tag-bound sealing;
  current and live.
- Delegate v12 `C669MCbRuDCcjQA6eztwag4B8F5LC9JG7ziB6jHadBHb` /
  `zpYamNqQLqZuGyAUb5u84K87cNTCR3Qum2rBUVtRyhd` — encrypted rooms
  (X25519/HKDF/AES-GCM seal/open); superseded by v13, registered.
- Delegate v11 `3CPshayRgEihDtRUzUSr775LnWB5WXj7r8vjj3GMtMrd` /
  `BRXSZhh95SVz7GhDPCa4HWdC4dukqma2ptajyW1GAgCm` — members-room signing;
  superseded by v12, registered.
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
- Nodes were upgraded from freenet 0.2.151 to 0.2.153 on 2026-11-01, then to
  0.2.155 (`5aa241a`, fdev 0.3.317) on 2026-11-08. Old binaries are kept as
  `~/.local/bin/{freenet,fdev}.0.2.151.bak` and `.0.2.153.bak` on both hosts.
  CI pins 0.2.155.
- `sudo systemctl restart` needs interactive authentication. The units restart
  themselves: `freenet.service` is `Restart=always`, the three workers are
  `Restart=on-failure`, so after replacing the binary `kill -TERM` the D PID and
  `kill -KILL` the worker PIDs. Verify with `readiness.mjs`.
- 0.2.155 logs `Startup update check skipped: the update-failure counter cannot
  be read`; binaries are upgraded manually, so ignore it.
- What a fresh session should do first: run `make check` and
  `make check-artifacts`, then `node ui/e2e/readiness.mjs` against the live
  nodes; if the delegate was re-keyed, open each zone once.

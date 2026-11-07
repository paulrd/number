# The network iteration — regions, onboarding, and rooms

Status: proposed draft 5, 2026-11-07. Conformance is required and is now derived
from the tree; growth and re-organization remain deferred. Depends on
`DESIGN.md` (v6 zone), `DESIGN-regions.md` (dataset), `DESIGN-payments.md`,
`DESIGN-v6.md`.

This is the plan for the next major iteration: give zones a geographic region,
let a newcomer find the zone to ask, and add the two rooms that support
admission. P1's implementation spec is `DESIGN-regions-p1.md`. This document
also answers whether the region dataset can be published in depth stages.

Scope decisions in this draft:

- **Every zone conforms to the region dataset, by construction.** A zone's
  region is its octal address from the world root: slot `i` is the dataset's
  child cell with digit `"abcdefgh"[i]`. Containment and sibling disjointness
  are automatic, not checks.
- **The parent designates the child's region at admission.** The owner picks a
  free slot of its own region: a published cell containing the newcomer's
  location if it is free, otherwise any free slot, published or provisional.
  The child's region is that slot's cell, so it may not contain the child's own
  location. That is accepted for this phase.
- **No region record and no zone contract change.** The region was always
  derivable from the tree; this draft makes that derivation normative. Existing
  zones keep their addresses as regions (§2).
- **Growth is deferred** (§4). A full zone cannot accept, and the match order is
  shallowest-first (D1).
- **The root is the world.** Empty address, no cell of its own; its eight slots
  are the dataset's depth-1 cells.

---

## 0. The model in one page

1. The region dataset is an 8-way spatial trie whose children tile the parent
   exactly (measured). Population is additive over the trie.
2. A zone's **region is its octal address** from the world root: the root is
   the world (empty path), and slot `i` is the dataset child cell with digit
   `"abcdefgh"[i]`. A zone's region is therefore derived, never claimed.
3. **Conformance is automatic.** A child's region is inside its parent's, and
   siblings' regions are disjoint, because the dataset's children tile the
   parent. There are no overlapping claims and no zone whose region disagrees
   with its position.
4. A zone has eight slots and all are assignable. The dataset decides whether
   an assigned cell is **published** (geometry and population) or
   **provisional** (the parent's cell with a sub-area label). Growth never
   depends on the published depth (§2.1).
5. The **parent designates** the child's region when it accepts: it picks a
   free slot, preferring a published cell that contains the newcomer's
   location. If that cell is taken, any free slot will do, and the child's
   region is that slot's cell.
6. A tree can be entered only from a root. The app's link carries the root's
   owner id; without it the app asks for one. There is no global directory.
7. A newcomer clicks a point, the app walks the tree down the digits of the
   cell containing it, and picks the **shallowest zone on that path with a free
   slot**. That zone is the one to ask.
8. The ask is a signed request posted to that zone's **candidate room**, which
   is open only while the zone is accepting. Members interview; the owner
   admits and assigns the slot.
9. The members room is the owner plus its current children: the place where an
   admission and its payments are discussed. Re-organization will use it later.
10. The dataset is published in depth stages: **178 contracts / 33.9 MiB** at
    depth ≤7 versus 9,511 / 1.75 GiB for the full tree. Deeper stages are
    separate dataset versions (§6). The published depth bounds mapped detail,
    not the tree: deeper zones exist with provisional cells (§2.1).

---

## 1. Invariants and what enforces them

| # | Invariant | Enforced by |
| --- | --- | --- |
| I1 | A zone has at most 8 children | contract (8 slots) |
| I2 | A relation is a tree edge only if both sides sign it | contract per side; readers require both |
| I3 | A zone's region is its octal address; slot `i` is dataset digit `"abcdefgh"[i]` | derivation + the dataset |
| I4 | A child's region is inside its parent's and siblings' regions are disjoint | automatic from I3 and the dataset's tiling |
| I5 | The root is the world: an empty address, no cell | definition |
| I6 | A slot is assigned at admission and not moved in this iteration | app rule; future re-organization (§4) |
| I7 | Population sums over one depth level, not over all rows | UI rule (§6.6) |
| I8 | A members room's members are the zone's owner and its occupied slots | room state, written by the owner, verifiable against the zone |

The contract does not need the dataset: the address is a path of digits, and
the dataset says which paths are cells. A reader checks a zone's region by
walking its address to the root — the same walk that already computes
`octalAddress`. Conformance is a property of the derivation, not a rule to
enforce or reconcile.

---

## 2. The region is the address

There is no new state. `octalAddress` already walks slot digits from the root;
that path **is** the region:

- the root is the world: empty path, no cell of its own;
- slot `i` maps to dataset digit `"abcdefgh"[i]`;
- a zone at address `p` occupies the cell `p`.

Because the dataset's children tile the parent, every child is inside its
parent and siblings are disjoint. Conformance is a property of the derivation,
not a rule with an escape hatch.

### 2.1 The dataset is a prefix, not a ceiling

The tree may grow deeper than the published dataset. A zone's address always
exists; its **cell geometry** is either published or provisional:

| Address | Geometry |
| --- | --- |
| cell present in the dataset | **published**: exact bounds, population, published children |
| cell absent (unpopulated, or deeper than `max_path_len`) | **provisional**: drawn as its nearest published ancestor's cell with a sub-area label; no population; no published children |

- A provisional cell is a display and descent convention, not a dataset claim.
  It is deliberately not a synthetic rectangle: the dataset's eight children
  are irregular, so a made-up subdivision would overlap published siblings.
- When a deeper stage is published, the real cell replaces the provisional one
  at the same address. The zone does not move, no signature changes, and the
  map becomes more accurate.
- This also covers legacy zones whose address is a path the dataset lacks:
  they are provisional, never "unplaced".

What the dataset adds:

- published geometry and population where it has cells;
- the **ideal digit** for an assignment: the published child cell containing
  the newcomer, when one exists;
- the descent the picker follows.

Existing zones:

- their addresses become their regions immediately; no migration, no placement
  step, no zone left unplaced.

Admission:

- the parent chooses a **free slot**; that choice is the region designation.
  All eight slots are always assignable, because growth is not capped by the
  dataset;
- the parent prefers the slot whose published cell contains the newcomer;
  otherwise any free slot, including one whose cell is provisional;
- the child's `parent` signature is its consent. The app shows the assigned
  region before the child signs; if the child refuses, the parent clears the
  slot;
- a slot is not moved during this iteration. Moving is re-organization (§4).

No contract change. Zone v6 stays; the rooms are a separate contract family
(§5).

## 3. #1 From stranger to member

### 3.1 What the dataset can and cannot answer

The dataset answers exactly: which cell contains a point at any published
depth, that cell's bounds and population, and its eight child cells. It cannot
answer "which zone is here". Zones are keyed by owner keys, and Freenet has no
global index. Two things bridge that gap: a starting point (a root id in the
link) and a walk down the digits of the cell containing the newcomer's point.
Because a zone's region is its address, that walk is exact.

### 3.2 The link carries the root

- The app link gains a root parameter: `?root=<owner-id>` (64 lowercase hex,
  the same identity format the payment links use). The owner key, not the
  contract id, so a WASM upgrade does not break the link.
- With it, the app fetches the root zone and knows where to start; the root is
  world-level, so no cell is needed. Without it, the app asks for one: "paste
  the link or the root id you were given". With neither, the user can start
  their own root (§3.6).
- No directory, no request index, no publisher-curated list. A root spreads by
  being shared, like the app itself. This removes the centralization risk in
  draft 1 and the whole root-dataset pipeline.
- The root id is validated by reading the zone: it must exist, have no mutual
  parent, and have an empty address. A stale or wrong id is rejected with a
  readable error, not a blank map.

### 3.3 The match rule

Given a point and a root:

1. Resolve the point to the deepest published cell containing it. Its digits
   `d1 d2 … dk` are the published path.
2. Walk from the root along those digits: at each zone, the next digit names
   the slot. If that slot holds a child, continue into it; if not, the walk
   stops.
3. The chain is the zones visited. The target is the **shallowest zone on the
   chain with a free slot** — the root if it has one, even when the root's
   next-digit slot is already occupied.
4. The target designates the region: the next digit if it is free, otherwise
   any free slot. The child's region is the assigned slot's cell, published or
   provisional (§2.1).

Beyond the published depth:

- When a cell is provisional the point gives no digit. The walk continues in
  slot order (`0, 1, … 7`) so a target still exists; the assigned region is
  provisional and the app says so.
- This is a growth fallback, not a geographic placement: below the published
  depth the dataset cannot distinguish one sub-area from another.

Notes:

- **Higher levels fill first, by design.** The tree fills breadth-wise; the
  root and its shallow children saturate before deeper zones are used.
- **The assigned region may not contain the newcomer's location.** That is the
  accepted cost of always conforming. The app shows the assigned cell and the
  location cell before the child signs.
- "Full" means all eight slots are occupied. Slots are always assignable; the
  dataset only decides whether a cell's geometry is published.
- A zone whose parent link is pending is not on the chain.
- The walk visits at most the address depth, one GET each, cacheable.
- If every zone reachable from the chain is full, the branch is saturated; the
  app says so and offers to start a new root (Appendix B).

### 3.4 Reaching the target

The target is known by owner id, so its **candidate room** is derivable
(`BLAKE3(room_wasm) ‖ "ZCR1" ‖ owner_vk`). No directory is needed.

- While the zone is accepting, the room takes signed join requests: a bounded
  queue (8 entries, 512 bytes each) of `{requester id, want_cell, note, sig}`.
  The contract validates the signature and the size and drops the oldest beyond
  the bound.
- The owner can clear the queue, close the zone, or ignore it. Spam is bounded
  by the queue, not by a fee: a payment cannot gate this, because payments
  route between two addresses that share a root and a stranger has no route
  until admitted.
- When the owner admits, the request is removed and the requester is added to
  the room for the interview.
- A candidate who already has a contact can skip the queue with the existing
  invite link, which carries the room key.

### 3.5 The interview and the admit

```
candidate               target zone                candidate room
   |  click map              |                           |
   |  walk the digits ------>|                           |
   |<-- target + free slots -|                           |
   |-- signed join request ------------------------------->|
   |                         |<-- members read queue -----|
   |<-- added to the room (invite carries the key) --------|
   |-- interview (members + candidate) ------------------->|
   |<-- designation: owner writes the slot (the region) ---|
   |-- candidate sees the region, signs parent = owner ---->|
   |   mutual edge; address = parent + digit; room updates |
```

- The admitter is the target zone. If it fills between the request and the
  admit, the app re-runs the match; nothing is reorganized.
- **Order matters**: the parent writes the slot first, because that write is the
  region designation; the candidate then signs `parent` after seeing the
  assigned cell. If the candidate refuses, the parent clears the slot and the
  edge never becomes mutual.
- The members room is told; the candidate room rotates its key and drops the
  candidate.
- The child's address and region settle as soon as both signatures exist.
- **Admission is for an unparented zone with no children** in this iteration.
  Admitting a zone that already has a subtree would re-address every zone in
  it, which is a move: it belongs to re-organization (§4). A root with children
  that wants to attach waits.

### 3.6 What the newcomer sees

1. **Where**: a map, one click, plus the root's link or id.
2. **Your path**: the chain from the root, each cell drawn, and the target zone
   that will assign you a slot.
3. **Your assigned region**: the slot the target can give (ideal first, then
   the alternatives), published or provisional, shown before the parent writes,
   with a warning when it does not contain your location.
4. **Who to ask**: the target's label, member count, and whether it is
   accepting.
5. **Ask**: a signed request showing exactly what becomes public.
6. **No root**: "no network here yet — start one". Starting a root is the
   existing identity flow; a root is the world, so no region is chosen.

### 3.7 Safety and economics

- Phase 1 has no open writes outside the candidate room's bounded queue. A
  candidate never touches a zone's state.
- The queue is a public, signed, bounded list: rates are capped by capacity,
  not by payment. The owner's moderation is the only filter.
- No directory means no listing power: a root cannot be delisted by anyone.
- Privacy: the request note, the requester's id and their cell are public.
  The interview is encrypted (§5), but its contract bytes persist.

---

## 4. Deferred: growth and re-organization

Capacity today: a zone has eight slots, a full zone cannot accept, and the
picker walks deeper along the chain. This iteration changes no edges, addresses
or slots.

Conformance changes what re-organization means. The tree's *shape* follows the
dataset where it is published: a zone at a published cell `p` has the dataset's
children of `p`, and deeper cells are provisional (§2.1). What is not fixed is
**which zone occupies which cell**. So the future work is an assignment problem,
not a geographic repair:

- Each zone publishes a signed **preferences** record: which neighbours or
  cells it prefers, weights, and constraints.
- The app combines owner preferences with geographic location into a distance
  metric between zones.
- A simple **bottom-up hierarchical clustering** over that metric proposes an
  assignment of zones to cells, and therefore which zones move and under whom.
- The proposal is advisory. Affected owners see it in their members rooms and
  sign individually. No automatic move and no global authority.

What this iteration must not preclude:

- **Regions derived from addresses** (§2), so the clustering already has clean
  geography to work with.
- **Stable signed edges** (mutual parent), so a proposed move is a set of
  signed writes by the owners, not a rewrite by a coordinator.
- **A place for preferences.** Do not add the record yet, but keep the state
  layout ready for one more signed record merged by `seq`, like the others. It
  needs state v8 and a migration (`deny_unknown_fields`).
- **Costly moves.** A move changes the zone's cell, its address, its children's
  addresses and payment routes. The future algorithm must treat moves as
  expensive and rate-limited; this iteration keeps addresses stable by moving
  nothing.
- **Published sub-cells** (§6.3): an assignment is only meaningful where the
  dataset has cells; provisional cells cannot distinguish zones.

Draft 2's ninth-member algorithm (classify by sub-region, promote the most
senior, move the rest) is removed. It stays in git history if it is ever
wanted; the clustering approach supersedes it.

## 5. #3 Two rooms per zone

### 5.1 Shape

| Room | Derivation | Members | Purpose |
| --- | --- | --- | --- |
| Members | `BLAKE3(room_wasm) ‖ "ZMR1" ‖ owner_vk` | owner + occupied slots | admissions, payments, and later re-organization proposals |
| Candidates | `BLAKE3(room_wasm) ‖ "ZCR1" ‖ owner_vk` | the members + invited candidates + the request queue | interviews |

Neither is part of the zone contract: chat volume, retention and access rules
differ from zone state, and every zone reader would otherwise download chat.

### 5.2 Members room

- **Membership**: a signed list in room state, written by the zone owner and
  derived from the zone's slots. The contract validates authors against it; a
  reader recomputes it from the zone and detects a mismatch.
- **Messages**: a grow-only set keyed by `hash(signature)`, each
  `{author, seq, time, body, sig}`. Merge = union, dedupe by key, sort by
  `(time, key)`. Author-supplied time affects display and retention, never
  validity. River's `MessageId = fast_hash(signature)` pattern.
- **Bounded history**: newest 200 messages, body ≤1 KiB, deterministic
  eviction by `(time, key)`; work per delta bounded by the cap.
- **Privacy**: state is public; bodies encrypted with the room's current epoch
  key. The epoch is distributed as ECIES blobs over each member's zone key,
  stored in state, as River stores secret recipients. Rotation on membership
  change; forward secrecy only.
- **Decisions** stay prose this iteration; a proposal/vote record is later.

### 5.3 Candidates room

- One room per zone, an epoch per admission round, so the room id is stable.
- Members + invited candidates, plus the bounded request queue (§3.4). The
  queue is the only open write in the design and it is capped.
- On admit: remove the request, add the candidate, interview, then the owner
  writes the slot and rotates the epoch. On reject or expiry: rotate and drop.
- Removing is not deleting: the contract and old epochs stay readable.

### 5.4 What to reuse from River

Verified against the River source (cloned read-only during this review):

| River mechanism | Use here |
| --- | --- |
| One contract per room, key from the owner's verifying key | yes, plus a domain tag per room kind |
| `ChatRoomStateV1` summary/delta/merge with per-field CRDTs | yes: membership, epoch secrets, messages |
| bounded `recent_messages`, oldest dropped by `(time,id)` | yes, 200 |
| `MessageId = fast_hash(signature)`, dedupe, sort | yes |
| `AuthorizedMember` invite chain, contract re-verifies it | adapted: membership comes from the zone's slots |
| per-member ECIES secret blobs, versioned epochs, rotation | yes |
| owner-signed config and an upgrade pointer at a fixed address | yes for the room WASM |
| signed edit/delete actions, original bytes retained | optional, later |
| delegate holds room keys, subscribes, rotates in background | yes, extend the existing delegate |

Not transferable: River's pruning of inactive members (zone membership is
structural), DMs, and room discovery (River has none; §3.2 supplies it).

### 5.5 Limits

- Room state is readable by anyone holding the contract; encryption is the only
  privacy. Never put secrets in a room.
- History is dropped from state but never from the network.
- No push, no delivery guarantee, no offline inbox.

---

## 6. The region dataset: publishing by depth stage

### 6.1 The direct answer

**Yes, and it is the right rollout — but as a version of the dataset, not a
filter over one manifest.** A dataset built for depth ≤7 is complete and
self-consistent, with its own boundaries, hashes and manifest. Publishing it
costs 178 contracts and 33.9 MiB. A later full-depth stage is a new manifest
and a new shard set; the old manifest stays readable, so clients on the old
version keep working with coarser data. The format never changes.

Measured with the packer in `DESIGN-regions.md` §4 over the real tree:

| Stage | Max depth | Rows | Packed bytes | Share | Shards | Manifest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| S1 | 6 | 222,660 | 5,313,033 (5.07 MiB) | 0.28% | **27** | ~1.2 KiB |
| S1′ | 7 | 1,481,182 | 35,517,561 (33.9 MiB) | 1.9% | **178** | ~8 KiB |
| S2 | 9 | 23,709,789 | 585,251,720 (558 MiB) | 31.2% | ~3,000 | ~135 KiB |
| S3 | 11 | 63,872,339 | 1,606,835,735 (1.50 GiB) | 85.7% | ~8,000 | ~370 KiB |
| S4 | full | 74,179,600 | 1,875,087,162 (1.75 GiB) | 100% | 9,511 | ~427 KiB |

S1 and S1′ are exact, simulated with the documented boundary algorithm over
the real rows (max shard 256,488 B / 262,021 B; average 8,246 / 8,321 rows per
shard). S2–S4 are extrapolated from the full-dataset shard count.

### 6.2 Why not "filter the entries of one manifest"

Rows are stored in preorder: a node, then all its descendants. Deep rows are
interleaved between shallow ones, so removing them changes every shard's
bytes, hash and contract id. No subset of the full shard set equals a shallow
dataset. A depth plan is a sequence of datasets, not a mask over one.

This is also why per-level reuse machinery would be wasted work: S1 is 0.28%
of the bytes, so republishing it inside S2 costs 5 MiB. Do not force
boundaries to a depth, do not build a partial-publish bitmap, and keep the
256 KiB subtree packer as designed.

### 6.3 What stage 1 must contain

The published depth bounds **mapped detail**, not growth (§2.1). Deeper zones
exist with provisional cells until a stage covers them.

- S1′ (≤7) gives exact geometry and population down to city scale, enough for
  the first networks. Beyond it the map is provisional, not unavailable.
- A deeper stage refines existing zones **in place**: no moves, no signatures,
  no address changes. The tree can already be deeper than the dataset.
- So staging is about map quality, not capacity. Publish deeper when the
  provisional areas start to matter, not because the tree needs room.
- The picker and the slot assignment use the published child cells of the
  zones they traverse; the provisional fallback covers the rest.

Recommendation: **publish S1′ (≤7) first** — 178 contracts, 33.9 MiB, 1.9% of
the full tree — then stage S2 when provisional areas become common. This is
decision D6.

### 6.4 Client semantics

The manifest carries `max_path_len`; define it as **the deepest path present in
this dataset**, not the format limit. Three lookup results:

| Result | Meaning | UI |
| --- | --- | --- |
| row found | published cell | draw it |
| `len(path) > max_path_len` | deeper than this dataset version | provisional: parent cell + sub-area label (§2.1) |
| no row, `len(path) <= max_path_len` | unpopulated cell in this dataset | provisional: parent cell + sub-area label |

`DESIGN-regions.md` §6.2 says a missing path is a normal "not a region" and
warns against GETting an unlisted key. It stays a normal result, but the UI
shows a provisional cell rather than an error. The client must never derive a
shard id for a path the manifest does not list.

### 6.5 Steady state: on-demand subtrees

Publishing 9,511 shards nobody reads is wasted; Freenet storage is
demand-driven (`DESIGN-regions.md` §9.3). Once a tree exists, the natural unit
is a **subtree dataset**: a top-level manifest listing a few subtree datasets,
each published when a zone in that area needs the depth. Measured: a depth-4
subtree is 215 KiB median (max 22 MB); a depth-5 subtree 17.6 KiB median (max
8.4 MB). Full detail around one community is usually one or two shards.

Do not build this now; it needs the hierarchical manifest that
`DESIGN-regions.md` §2 defers, and its extra GET only pays once there is a tree
to serve. S1′ plus later S2/S3 stages covers the first years.

### 6.6 Corrections to `DESIGN-regions.md`

1. **Total population.** 72,849,486,791 is the sum over all 74,179,600 rows,
   which counts each person once per trie level. The world population is the
   sum of the eight depth-1 cells: **8,334,930,181**. A UI must sum **one
   level**. Both fit JavaScript's safe integer range, so the `u32` decision
   stands; the display rule does not.
2. **Largest cell.** The maximum cell population is 2,144,729,717, which fits
   `u32` with headroom. 72.8B is not a cell and was never the `u32` constraint.
3. **Child cells are not derivable.** Children tile the parent exactly, but
   areas range from 1/2 to 1/128 of the parent (`aacb`: `h`=1/2, `g`=1/4,
   `a`=1/8, … `d`,`e`=1/128), and the digit order is subdivision order, not
   compass order. The UI must use the dataset's child rows.
4. **`max_path_len`** means the deepest path present (§6.4); a missing path is
   provisional, not an error.

---

## 7. Phases

### P0 — decisions
Decisions D1–D7 are resolved (§8). Start at P1; P2's contract change can be
scoped now.

### P1 — S1′ dataset + picker prototype (no contract change)
Implementation: `DESIGN-regions-p1.md` (contracts, exporter, publisher, picker,
tests, acceptance).
- Export with `max_path_len = 7`; publish 178 shards and the manifest with the
  existing pipeline (`DESIGN-regions.md` §9.1–9.2).
- Leaflet + `world-atlas`, no tile layer; click → cell at the published depth;
  draw the cell and its eight children; show population.
- Cache the manifest and 1–2 shards per lookup; the three lookup states.
- Exit: any land point resolves to a stable path; a second node verifies the
  dataset.

### P2 — region display and slot assignment (no contract change)
- The region is the address: show it on the zone and on the map. No state, no
  migration; existing addresses light up immediately.
- The map draws the zone's cell and its child cells: published geometry where
  the dataset has it, a provisional sub-area label where it does not.
- Admission gains a designation step: the parent picks a free slot, the app
  shows the assigned region to the candidate, then both sides sign.
- Provisional cells (paths the dataset does not contain) are labelled, not
  hidden.
- Exit: a parent assigns a slot; the child's address and region update; the map
  shows both; the candidate sees the region before signing.

### P3 — members room
- Room contract (members kind), delegate key custody, bounded messages.
- Membership from slots; the owner re-signs when a child changes.
- Exit: a root and its children exchange messages; a non-member cannot author;
  a removed child is rejected after the epoch bump.

### P4 — discovery and admission
- `?root=` link handling, the match rule, the target-zone UI.
- Candidate room: bounded signed request queue, invitations, interview.
- Admit writes the slot and the parent; the room rotates.
- Exit: an identity with no contacts opens a root link, finds the target,
  requests, interviews and joins with no other out-of-band step.

### Deferred — growth
Re-organization is not in this iteration. A full zone simply refuses; the
picker walks deeper along the chain. See §4 for the assignment-clustering
direction and the constraints it places on today's state.

---

## 8. Decisions

Resolved 2026-11-07:

| # | Decision | Value |
| --- | --- | --- |
| D1 | Match order | Shallowest zone with a free slot (closest to the root) (§3.3) |
| D2 | Region designation | The parent assigns a free slot at admission: the newcomer's cell if published and free, otherwise any free slot, published or provisional (§2, §3.5) |
| D3 | Ask channel | Bounded signed request queue in the candidate room (§3.4) |
| D4 | Root link id | Owner key |
| D5 | Room privacy | Encrypted bodies |
| D6 | First dataset stage | S1′ (≤7): 178 contracts, 33.9 MiB |
| D7 | Preferences record | Later; needs state v8 and a migration |
| D8 | Slot digit in the parent signature | Deferred; consent is procedural for now |
| D9 | Growth beyond the dataset | Allowed; deeper cells are provisional until a stage covers them (§2.1) |

### Confirmed

**The region is the address**: slot `i` is dataset digit `"abcdefgh"[i]`. A
zone's region is derived from its position, so conformance is automatic, there
is no region record, and the zone contract stays v6.

### Note on D1

Higher-level nodes fill first. The root is chosen whenever it has a free slot;
once it is full, the next zone on the point's chain is asked. Because the parent
designates the cell, a newcomer may be assigned a region that does not contain
their location — the accepted cost of always conforming.

### Still open

See Appendix B. The near-term UI decisions are the zone label/"accepting" flag
and whether an invite link carries the root id.

---

## 9. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Assigned region elsewhere | a zone owns a cell away from its owner | show both cells before signing; the room can decline |
| Provisional regions | deeper zones have no published geometry or population | draw the parent cell with a sub-area label; a deeper stage refines it in place |
| Legacy addresses outside the dataset | an existing zone's path is not a published cell | label it provisional; new admissions prefer published cells |
| Chain saturated | every zone reachable from the point is full | say so; offer a new root |
| Slot taken between proposal and admit | the designation becomes stale | re-run the match; the parent clears the slot |
| Parent assigns poorly | a zone placed far from its owner | the app suggests the ideal published cell; members discuss; future assignment clustering |
| Open request queue | spam fills it | bounded queue, owner moderation, close flag |
| Root overlap | two trees cover the same area | the link's root id selects one |
| Re-slotted child | the child's region and address change without a new signature | app rule: no moves this iteration; the child detects it on read and can leave |
| Public chat | interview transcripts leak | encrypt; no secrets in rooms; history persists |
| Population double count | wrong totals | sum one level (§6.6) |

---

## Appendix A — measurements

### A.1 Depth histogram (`trie.db`, 74,179,600 rows)

| Depth | Rows | Packed bytes | Cumulative rows | Cumulative bytes | Share |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 8 | 176 | 8 | 176 | 0.00% |
| 2 | 64 | 1,408 | 72 | 1,584 | 0.00% |
| 3 | 480 | 11,040 | 552 | 12,624 | 0.00% |
| 4 | 3,616 | 83,168 | 4,168 | 95,792 | 0.01% |
| 5 | 26,567 | 611,041 | 30,735 | 706,833 | 0.04% |
| 6 | 191,925 | 4,606,200 | 222,660 | 5,313,033 | 0.28% |
| 7 | 1,258,522 | 30,204,528 | 1,481,182 | 35,517,561 | 1.9% |
| 8 | 5,981,016 | 143,544,384 | 7,462,198 | 179,061,945 | 9.5% |
| 9 | 16,247,591 | 406,189,775 | 23,709,789 | 585,251,720 | 31.2% |
| 10 | 22,642,285 | 566,057,125 | 46,352,074 | 1,151,308,845 | 61.4% |
| 11 | 17,520,265 | 455,526,890 | 63,872,339 | 1,606,835,735 | 85.7% |
| 12 | 8,004,056 | 208,105,456 | 71,876,395 | 1,814,941,191 | 96.8% |
| 13 | 2,040,566 | 53,054,716 | 73,916,961 | 1,867,995,907 | 99.6% |
| 14 | 248,687 | 6,714,549 | 74,165,648 | 1,874,710,456 | 99.98% |
| 15 | 13,578 | 366,606 | 74,179,226 | 1,875,077,062 | 100.0% |
| 16 | 372 | 10,044 | 74,179,598 | 1,875,087,106 | 100.0% |
| 17 | 2 | 56 | 74,179,600 | 1,875,087,162 | 100.0% |

The full total reproduces `DESIGN-regions.md`'s 1,875,087,162 bytes exactly,
confirming `21 + ceil(3·len/8)`.

### A.2 Structure of the trie

- **Children tile the parent.** Verified for `aacb`, `hfcha` and the eight
  depth-1 cells: the union of the children's bboxes equals the parent's and
  the children do not overlap.
- **Areas vary.** `aacb` children are 1/2 (`h`), 1/4 (`g`), 1/8 (`a`), 1/16
  (`f`), 1/32 (`b`), 1/64 (`c`), 1/128 (`d`, `e`). `hfcha` children are 1/4
  (`e`), 1/8 ×5, 1/16 ×2. The root's eight cells are 1/2 (`h`), 1/4 (`g`),
  1/16 (`a`, `d`), 1/32 ×4 of the world. Child bboxes are data, not a function
  of the parent.
- **Digit order is subdivision order**, not geographic order.
- **Population is additive**: `aacb` = 3,562.54 = the sum of its eight children;
  the eight depth-1 cells sum to 8,334,930,181.
- **Level fullness**: depth 6 has 191,925 of 262,144 possible cells (73%),
  depth 7 1,258,522 of 2,097,152 (60%), depth 8 36%. Depth 6 is the last nearly
  complete level.

### A.3 Stage-1 packing (simulated with the documented algorithm)

| Dataset | Rows | Bytes | Shards | Avg shard | Max shard | Max rows/shard |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| depth ≤6 | 222,660 | 5,313,033 | 27 | 196,779 | 256,488 | 10,750 |
| depth ≤7 | 1,481,182 | 35,517,561 | 178 | 199,536 | 262,021 | 10,947 |

## Appendix B — open questions

1. When the ideal published cell is taken, how does the parent choose among
   the free slots? Nearest published cell, largest population, lowest digit, or
   a provisional slot? Recommendation: nearest published, then population, then
   digit order.
2. How should a provisional cell be drawn: the parent's cell plus a sub-area
   label, or a synthetic subdivision? Recommendation: label only; a synthetic
   rectangle would be contradicted by a later stage.
3. When should S2 be published: a threshold of provisional zones, a threshold
   of population in provisional areas, or a fixed review date?
4. Should a zone advertise a label and an "accepting" flag in zone state, or is
   the candidate room enough?
5. Should an invite link carry the root id as well, so an invited candidate
   learns the tree in one step?
6. When a branch is saturated, should the app start a new root, ask another
   tree, or wait? Recommendation: start a root; roots are cheap and can merge
   later.
7. The preferences record for the future assignment clustering needs state v8
   and a migration; confirm when that iteration starts.
8. Revisit binding the assigned slot digit into the child's parent signature if
   re-slotting ever happens before re-organization.

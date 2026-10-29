# number — design (v4/v5)

A personal Freenet app: one board per user, holding exactly **8 slots** and an
**address book**, arranged as a **tree of boards**. A board is a node; its 8
slots are its children; it has at most one parent. A slot is either empty or
holds an i64 **count of hundredths** (displayed with exactly two decimal
places), a mandatory **child contact** (the child board owner's `userId`), and
optional `unit` and `note`. Only the board's owner can write. The board is a
contract instance parameterised by the owner's Ed25519 verifying key, so the
owner's identity is the stable anchor (a new WASM version re-keys the instance,
but the client re-derives it from the same owner key).

The address book lives in the signed, replicated contract state. A contact
associates a human **label** with a **user id** (an Ed25519 public key, 32 bytes
as 64 lowercase hex). A slot stores the user id, not the label, so renaming a
contact does not break existing slots. The contract validates the id's format;
it deliberately does not require the id to still be present in the book, so
removing a contact cannot invalidate already-signed slot state. The UI requires
choosing a current contact when saving.

### Tree model

- A **node** is one owner's board. The child board for a user is derived from the
  same contract code hash and that user's public key, exactly like the owner's
  own board.
- A board's **parent** is a signed record holding at most one parent user id
  (`null` = root). It has its own monotonic `seq`, signature, summary pair and
  delta, and merges by the same seq/signature order as contacts and slots.
- A parent edge is **mutual** only when the parent board has a slot whose
  `entry.contact` equals the child owner id **and** the child board's
  `parent.userId` equals the parent owner id. Only mutual edges are tree edges.
  A one-sided link is shown as pending; a board whose instance does not exist is
  "not created"; a board still on v2 is "previous version".
- The contract cannot enforce mutual agreement, acyclicity, or unique children
  across boards. It enforces the local invariants: one parent field, a valid
  signed parent, no self-parent, at most 8 child slots. The UI enforces no
  self-child, no duplicate child ids on new writes, and best-effort cycle
  detection.
- Other owners' boards are public/read-only in the UI; only the owner can sign.
  Labels on a viewed board come from that board's own address book.
- A board's **octal address** is derived, not stored: the root is the empty
  string, and a child's address is its parent's address with the child's
  zero-based slot digit (`0`–`7`) appended, with no separator. The UI walks
  mutual parent links (`octalAddress` in `ui/src/tree-view.ts`) and shows the
  result in the board head. A pending, missing, unreadable, looping, or
  over-deep chain leaves the address unsettled rather than guessing a digit.
- The **parent's value for a child** comes from the parent's signed slot that
  names the child (`parentValueFor`). When present, the child board shows that
  entry's value, unit, note, and zero-based slot prominently above the grid;
  a root, pending link, or cleared parent slot shows no such band. Both views
  are read-only derivations; neither changes contract state or the wire format.

### Payments (v4)

v4 adds a signed `payments` record (one active intent per board). A payment
moves an amount from a source board to a destination board named by an octal
address and user id. Because every board signs only its own state, the payment
is a sequence of signed legs: the source offers it, each ancestor up to the LCA
debits its edge, the LCA debits and credits in one delta, each descendant on the
destination side credits its edge, and the destination's parent verifies the
user id. A debit that would go below zero aborts before signing; any later
failure starts a reverse walk in which each actor that already signed undoes
its own leg. The reverse walk never overwrites a later signed write: it reports
`superseded`/`blocked` instead. The exact record, signing bytes, route table,
statuses and reversal rules are in [DESIGN-payments.md](./DESIGN-payments.md).
Discovery is deliberately manual in the contract — a board's inbox is its
parent plus its eight children, read when the owner opens the board. v4.1 adds
a delegate that scans that inbox and can advance a forward leg while the
owner's node runs (see "Background payments" below), but there is still no
contract push: a payment can wait indefinitely and must be shown as pending,
not as delivered.

v2 boards migrate to v3: the slot and contacts signing bytes are unchanged, and
the client adds an empty parent when it re-PUTs the old signed state. v4 adds
the payments record; v5 adds the adjustments record. Both upgrades are
client-side and keep every earlier slot/contacts/parent/payments signature.
v1 boards remain unmigratable (their slot schema/signing bytes changed in v2).
See §7 "Migration". The owner identity is carried forward by the delegate's
seed export/import path.

### Adjustments (v5)

v5 adds a signed `adjustments` record (a bounded log, at most 32 entries) to a
board. Each entry records an **issue** (positive `delta`) or **burn** (negative
`delta`) of that board's liability to one child slot:
`{slot, slotSeq, delta, postValue, note}`. The slot value is still an ordinary
signed slot entry; the adjustment records the write that produced it. An issue
raises what the board records it owes the child; a burn lowers it and can never
take it below zero. The board owner signs both records, so a child can see the
parent's signed history of liability changes without the parent being online
to explain them.

- Entries are oldest first, at most 32; the owner may rewrite/truncate the
  whole record, so this is a child-facing provenance hint, not a tamper-proof
  audit trail. Per-slot `slotSeq` strictly increases; `(slot, slotSeq)` is
  unique.
- Signing bytes: `b"number:v5:adjustments" || seq u64 LE || count u32 LE ||
  per entry {slot u8 || slotSeq u64 LE || delta i64 LE || postValue i64 LE ||
  note_len u32 LE || note bytes}`. Slot/contacts/parent/payments signing bytes
  are unchanged; v2/v3/v4 signatures remain valid.
- `validate_state` checks only bounds/signature/order and never compares the
  log to the independently merged slots (that would break convergence).
  `update_state` provenance: a **new** entry must name a slot write in the same
  delta with matching `seq`, `postValue`, and `old + delta`.
- `Adjustments` merges by max(seq), tie by lexicographically greater signature
  bytes, like contacts/payments. Summary gains one `[seq, digest16]` pair;
  delta gains an optional record. v4 upgrades by adding an empty record and
  setting `v:5`; the UI registers the outgoing v4 code hash as migratable.

### Background payments (v4.1, delegate)

The delegate can advance forward payment legs while the node runs and no tab is
open. It declares `lifecycle = [NodeStarted]`, `capabilities = [Background]`,
`wakeups = [inbox = 300]`, subscribes to the owner's board, parent and slot
contacts, and scans on notifications, wake-ups and node start. It signs only a
forward leg addressed to the owner, carried by the route's previous actor, with
that actor's payments signature and leg evidence verified against its own
state; it rebuilds the leg from the owner's state and never copies a
neighbour-supplied `next`/legs. Auto-advance defaults on once configured, with
a per-payment cap (default 1,000,000 hundredths). It does not advance reverse
legs. See [DESIGN-v4.1-v5.md](./DESIGN-v4.1-v5.md) for the config, scan state
machine and the core#5600 / lossy-notification / 4-op-budget limits.

Components:

- `contract/` — `number-contract` WASM (shared state, validation, merge).
- `delegate/` — `number-delegate` WASM (private key custody + signing).
- `ui/` — TypeScript + Vite frontend (WebSocket client, owner of the UX).

The contract never reads the host clock and never uses randomness inside
`validate_state` / `update_state` / `summarize_state` / `get_state_delta`.

---

## 1. Contract parameters

`parameters` = the raw 32 bytes of the owner's Ed25519 **verifying key**. No
serde wrapper, no length prefix, no domain tag. `validate_state` rejects any
parameter blob whose length is not exactly 32.

Contract code hash: `code_hash = BLAKE3(wasm bytes)`.
Instance id: `BLAKE3(code_hash_bytes || parameters)` (exactly as
`freenet_stdlib::ContractKey::generate_id`).

## 2. Contract state (JSON, UTF-8)

```json
{
  "v": 3,
  "parent": {
    "seq": 2,
    "userId": "2222222222222222222222222222222222222222222222222222222222222222",
    "sig": "<128 lowercase hex chars>"
  },
  "contacts": {
    "seq": 1,
    "entries": [
      { "label": "Alice", "userId": "1111111111111111111111111111111111111111111111111111111111111111" }
    ],
    "sig": "<128 lowercase hex chars>"
  },
  "slots": [
    { "seq": 0, "entry": null, "sig": null },
    {
      "seq": 3,
      "entry": { "value": 1250, "contact": "1111111111111111111111111111111111111111111111111111111111111111", "unit": "kg", "note": null },
      "sig": "<128 lowercase hex chars>"
    }
  ]
}
```

Rules:

- `slots` is **exactly 8** entries; index = slot number `0..7`.
- `seq == 0` ⇒ `entry == null` and `sig == null` (initial/empty slot).
- `seq > 0` ⇒ `sig` is a valid Ed25519 signature over the signing bytes below.
  `entry == null` with `seq > 0` is a **tombstone** (slot cleared) and is legal.
- `value` is an i64 **JSON number** counting **hundredths**. It is the same wire
  type as v1; only its interpretation changed (the UI divides by 100 for
  display). The UI parses and emits numbers losslessly (BigInt via
  `lossless-json`), so the full i64 range survives exactly.
- `contact` is mandatory: exactly 64 lowercase hex characters, the child board
  owner's Ed25519 public key (the child node). The contract checks the format,
  not membership or uniqueness (see the tree model).
- `unit` ≤ 16 and `note` ≤ 512 bytes (UTF-8). `null` and absent are equivalent
  for the optional strings; serialise `null`.
- `v` must be `3`.

### Parent (`parent` record)

- `seq == 0` ⇒ `userId == null` and `sig == null` (root / never set).
- `seq > 0` ⇒ `sig` is a valid signature over the parent signing bytes.
  `userId == null` with `seq > 0` is legal (the parent was cleared).
- `userId`, when present, is exactly 64 lowercase hex characters.
- `userId` must not equal the board's own owner pubkey (no self-parent).
- At most one parent is represented by the single record. Mutual agreement with
  the parent board is a UI rule, not a contract rule.

### Address book (`contacts` record)

- `entries` is at most **64** contacts, in signed order.
- Each `label` is a non-empty UTF-8 string of at most 64 bytes.
- Each `userId` is exactly 64 lowercase hex characters (32 bytes).
- No duplicate `userId` and no duplicate exact `label`.
- `seq == 0` ⇒ `entries == []` and `sig == null`.
- `seq > 0` ⇒ `sig` is a valid signature over the contacts signing bytes.
  `entries == []` with `seq > 0` is legal (all contacts removed).
- A contact update replaces the whole record at a higher `seq`; the UI signs a
  new record for add or remove (re-adding the same user id under a new label is
  a rename). There are no per-contact counters.
- **Board name convention.** A contact whose `userId` equals the board owner's
  own user id is the board's self-entry; its `label` is the board's name. It is
  an ordinary valid contact (counts toward the 64 limit, signed in the same
  record), but the UI hides it from the contact list/selectors and manages it
  with a dedicated Board name control. Other boards use it as the fallback label
  for this board when their own address book has no entry: address-book label
  first, target board's name second, shortened id last. This needs no schema or
  signing change. The UI requires the owner to set a name on first load if the
  self-entry is absent.

### Signing bytes — slot (canonical, hand-built)

```
b"number:v2:slot"
|| slot_index: u8
|| seq: u64 little-endian
|| entry_tag: u8            // 0 = None, 1 = Some
// only when entry_tag == 1:
|| value: i64 little-endian
|| contact: 32 raw bytes    // decode the 64 hex characters
|| unit_len: u32 LE || unit bytes
|| note_len: u32 LE || note bytes
```

`None` optional strings encode as length `0` (there is no null/absent
distinction on the wire). The signature covers the slot index, the seq, and
every field of the entry. Both the contract and the delegate MUST build these
bytes with the same function shape. A golden vector in each crate's tests pins
it.

### Signing bytes — contacts

```
b"number:v2:contacts"
|| seq: u64 little-endian
|| count: u32 LE
|| for each entry, in order:
     label_len: u32 LE || label bytes
     || userId: 32 raw bytes
```

An empty list with `seq > 0` signs `count = 0`. Entry order is part of the
signature.

### Signing bytes — parent

```
b"number:v3:parent"
|| seq: u64 little-endian
|| tag: u8                 // 0 = no parent, 1 = parent set
// only when tag == 1:
|| userId: 32 raw bytes
```

A cleared parent at `seq > 0` signs `tag = 0`; `seq 0` is never signed.

## 3. Summary (JSON, UTF-8)

```json
{
  "v": 3,
  "parent": [2, "<32 hex chars>"],
  "contacts": [1, "<32 hex chars>"],
  "slots": [ [3, "<32 hex chars>"], [0, "00000000000000000000000000000000"] ]
}
```

`parent` and `contacts` are one `[seq, digest16]` pair each; `slots` is exactly
8 pairs. `digest16` is the first 16 bytes of `BLAKE3(signing bytes for that
record/slot)` for `seq > 0`, and 16 zero bytes for an empty record/slot. The
digest exists so two peers that hold the same `seq` but different content (owner
equivocation) still notice and heal. Every summary field is read by
`get_state_delta`.

## 4. Delta (JSON, UTF-8)

```json
{
  "v": 3,
  "parent": { "seq": 3, "userId": null, "sig": "<hex>" },
  "contacts": { "seq": 5, "entries": [], "sig": "<hex>" },
  "slots": [ { "i": 2, "seq": 4, "entry": null, "sig": "<hex>" } ]
}
```

`parent` and `contacts` are `null` when unchanged; otherwise they are the full
records. `get_state_delta` includes the parent iff

```
our.parent.seq > their.parent.seq
|| (equal seq && our.parent.digest16 != their.parent.digest16)
```

and includes contacts iff

```
our.contacts.seq > their.contacts.seq
|| (equal seq && our.contacts.digest16 != their.contacts.digest16)
```

and includes slot `i` iff

```
our.slots[i].seq > their.slots[i].seq
|| (equal seq && our.slots[i].digest16 != their.slots[i].digest16)
```

With an empty (or undecodable) summary — a new subscriber — include the parent
and contacts iff `seq > 0`, and every slot with `seq > 0`. If nothing
qualifies, return a literally empty `StateDelta::from(vec![])`. A
parent/contacts-only delta has `"slots": []`.

## 5. Merge rule

Parent, contacts, and slots each merge by `max` over the total order:

1. higher `seq` wins;
2. equal `seq` → the record whose **signature bytes** are lexicographically
   greater wins;
3. equal `seq` and equal signature → identical record.

Properties: associative, commutative, idempotent, absorbing. A full-state
update merges the parent, contacts, and every slot; a delta merges whichever
records are present; re-applying either is a no-op.

Invalid input is **rejected atomically** for state/delta (single writer →
atomic is correct): any bad signature, out-of-bounds metadata, malformed
contact/parent, duplicate contact id/label, self-parent, or `seq == 0` with
non-empty content rejects the whole update. Stale (lower-seq) records are not
an error — they lose the merge.

## 6. ContractInterface behaviour

- `validate_state(parameters, state, related)`:
  - params length 32 and a valid Ed25519 point;
  - state decodes as a valid `StateV3` per §2, exactly 8 slots, a valid parent
    record and contacts record;
  - the parent signature (when `seq > 0`), contacts signature (when `seq > 0`),
    and every `seq > 0` slot signature verify under the params key;
  - the parent is not the owner itself.
- `update_state(parameters, state, data)`:
  - decode current state; for each `UpdateData::State` / `Delta` /
    `StateAndDelta`, validate the incoming parent/contacts/slots, then merge per
    §5;
  - `UpdateData::Related*` is not used (no related contracts);
  - return `UpdateModification::valid(merged_bytes)`.
- `summarize_state`: §3.
- `get_state_delta`: §4, empty bytes when converged.

No `freenet_stdlib::time::now()`, no `rand` inside contract functions.

## 7. Delegate protocol (`number-delegate`)

Application messages are JSON, UTF-8, in `ApplicationMessage.payload`.

Request:

```json
{ "cmd": "identity" }
{ "cmd": "sign", "slot": 3, "seq": 7, "entry": { "value": 1250, "contact": "<64 hex>", "unit": null, "note": null } }
{ "cmd": "sign", "slot": 3, "seq": 8, "entry": null }
{ "cmd": "signContacts", "seq": 2, "entries": [ { "label": "Alice", "userId": "<64 hex>" } ] }
{ "cmd": "signParent", "seq": 3, "userId": "<64 hex>" | null }
{ "cmd": "status" }
{ "cmd": "export" }
{ "cmd": "import", "seed": "<64 hex>", "nextSeq": [1,1,1,1,1,1,1,1], "contactsNextSeq": 1, "parentNextSeq": 1 }
```

Response (outbound `ApplicationMessage`):

```json
{ "ok": true, "pubkey": "<64 hex>", "nextSeq": [1,1,1,1,1,1,1,1], "contactsNextSeq": 1, "parentNextSeq": 1 } // identity
{ "ok": true, "sig": "<128 hex>" }                                   // sign / signContacts / signParent
{ "ok": true, "hasSeed": false }                                     // status, fresh
{ "ok": true, "hasSeed": true, "pubkey": "<64 hex>", "nextSeq": [...], "contactsNextSeq": 1, "parentNextSeq": 1 } // status, initialized
{ "ok": true, "seed": "<64 hex>", "nextSeq": [...], "contactsNextSeq": 1, "parentNextSeq": 1 } // export
{ "ok": true }                                                       // import
{ "ok": false, "error": "..." }                                      // any failure
```

Secrets (delegate secret store):

- `number.v1.seed` — 32-byte Ed25519 seed, generated with
  `freenet_stdlib::rand::rand_bytes(32)` on first use. The key name is kept from
  v1 so the seed's meaning does not move with the generation.
- `number.v1.nextseq.<i>` — 8-byte little-endian u64, per slot, default 1.
- `number.v2.nextseq.contacts` — 8-byte little-endian u64, contacts record,
  default 1.
- `number.v3.nextseq.parent` — 8-byte little-endian u64, parent record, default
  1. `DELEGATE_VERSION` is 5.

Parameters:

- The delegate is parameterised by exactly the **32 raw bytes of the web
  container contract instance id** it serves. Empty or malformed parameters
  fail closed before any request is handled.
- `delegate/webapp_contract_id.txt` holds the base58 id (the value in the
  gateway's `/v1/contract/web/<id>/` URL); the build writes the raw bytes to
  `delegate/webapp_contract_id.bin` for `fdev publish --parameters`.

Rules:

- `sign`: `slot` must be `0..7`; `seq >= nextseq[slot]`; `seq > 0`; enforce the
  §2 entry bounds and contact format; sign the slot bytes; then store
  `nextseq[slot] = seq + 1`.
- `signContacts`: `seq >= contactsNextSeq`; `seq > 0`; enforce the §2 contacts
  bounds (count, labels, user ids, uniqueness); sign the contacts bytes; then
  store `contactsNextSeq = seq + 1`.
- `signParent`: `seq >= parentNextSeq`; `seq > 0`; `userId` is null or 64
  lowercase hex; reject the delegate's own pubkey; sign the parent bytes; then
  store `parentNextSeq = seq + 1`.
- Import writes the parent/contacts/per-slot counters before the seed, so a
  failed import can be retried. Older `export` responses have no
  `parentNextSeq`/`contactsNextSeq`; the UI treats a missing value as 1.
- Only accept messages whose `origin` is
  `Some(MessageOrigin::WebApp(id))` and `id` equals the pinned webapp contract
  id. Reject a different `WebApp(id)`, `MessageOrigin::Delegate`, `None`, and
  unknown variants at the single gate before dispatch.
- Core signing/storage logic must be testable without a host, e.g. a
  `sign_with(store: &mut impl SecretStore, ..)` seam (see delegate-patterns →
  "Take `impl SecretStore`").

### Delegate bootstrap (fresh nodes)

A delegate is local to a node and is not fetched from the network. The site
therefore ships the raw delegate WASM (`ui/public/number_delegate.wasm`, copied
by `scripts/build.sh`; URL injected as `__DELEGATE_WASM_URL__`) and the UI can
install it on first use.

- On connect, `OnlineBoard.ensureDelegate()` probes `status`. A missing delegate
  is **not answered** by the client API: the node logs a warning and sends no
  application message, so the probe times out. A timeout is treated as "may
  need installing"; a clear `Missing` is the same case.
- The UI asks for consent before installing anything (`delegate-dialog.ts`); it
  never auto-installs. Declining rejects the board with a clear message.
- `OnlineBoard.installDelegate()` fetches the bundled file, requires
  `BLAKE3(code) == delegateCodeHashBytes`, then sends `RegisterDelegate`
  (`WasmDelegateV1` with code, code hash, the parameterised key, and the webapp
  id as parameters; `cipher`/`nonce` are ignored by the node since #4140).
  Success is confirmed by polling `status` until the delegate answers.
- Registration is idempotent; a node that already has the delegate never sees
  the prompt. No contract or delegate bytes change, so there is no re-key. The
  site archive grows by ~70 KB compressed (the WASM is ~432 KB raw).
- If a deployment blocks registration, the fallback remains `fdev publish
  --code … delegate` on that node.

### Delegate and contract migration

- Delegate migration is **forward-only**. A successor delegate starts with an
  empty secret store; the UI asks each predecessor in the committed
  `ui/src/migrations.ts` registry for `export`, then sends `import` to the
  current delegate **before** calling `identity` (identity would create a fresh
  seed and make import impossible).
- `status` reports `hasSeed` without creating one. `import` is refused if a
  seed already exists, and writes counters before the seed so a failed import
  can be retried.
- A predecessor published before `export` existed cannot answer; that
  generation is permanently unrecoverable. Append the current delegate key,
  code hash, and webapp id to `LEGACY_DELEGATES` **before** changing the
  delegate WASM.
- A predecessor pinned to a different webapp id cannot be called from the new
  UI: its origin policy refuses the request. Migrate before changing the
  webapp id, or export from the old UI.
- Contract migration uses the owner key as the stable anchor. Append the
  outgoing contract code hash to `LEGACY_CONTRACT_CODE_HASHES` before changing
  the contract WASM. On first load, if the current instance is missing, the UI
  probes each old hash with the same owner pubkey, GETs the old state, and PUTs
  it into the current contract; `validate_state` re-checks every signature.
  Only list versions whose state/signing bytes the current contract accepts.
- **v2 is migratable into v3.** v3 keeps the v2 slot and contacts signing bytes
  and only adds a parent record. The client decodes a v2 state, adds
  `parent: {seq: 0, userId: null, sig: null}`, writes `v: 3`, and PUTs it into
  the v3 contract, which validates the old slot/contacts signatures. The v2
  contract hash `A1J4…` is in `LEGACY_CONTRACT_CODE_HASHES`.
- **v1 remains a breaking generation.** v1 changed the slot schema and signing
  bytes; no v1 board can be re-PUT into v3. v1 hashes stay in
  `UNMIGRATABLE_CONTRACT_CODE_HASHES` (registered for the record gate, never
  probed by the UI). This is deliberate; do not list a v1 hash as migratable.
- **Other owners' boards may still be on v2.** The tree reader probes the
  current code hash and then the migratable legacy hashes for a child/parent
  owner. A v2 board is readable and normalised with an empty parent, but it
  cannot be a mutual tree edge until its owner opens the v3 app and sets a
  parent.

## 8. UI flow

1. Connect `FreenetWsApi` to `${ws(s)}://${location.host}/v1/contract/command`
   with `base: "./"` assets and empty auth token, then ensure the delegate is
   installed: probe `status`; on missing/timeout show the consent dialog and,
   if accepted, register the bundled delegate (see §7).
2. Ask the current delegate for `status` (without creating a seed). If it has
   no seed, walk `LEGACY_DELEGATES`: ask each predecessor for `export`, then
   `import` the first answer. If it still has no seed, the UI blocks on a
   first-run choice (create vs. restore) and only continues after an explicit
   create or a successful restore; then ask for `identity` (delegate key +
   code hash injected at build).
3. `params = pubkey bytes`; `instance = blake3(code_hash_bytes || params)`;
   build `ContractKey(instance, code_hash_bytes)`.
4. `GET`; on not-found, `PUT` the bundled `number_contract.wasm` with params and
   an all-empty `initial_state` (mirror `buildShardPutRequest` from
   freenet-microblogging), then `SUBSCRIBE`.
5. Render 8 slots and the address book. An edit computes
   `seq = max(contract.slots[i].seq, delegate.nextSeq[i])`, then asks the
   delegate to sign that `seq`; the delegate stores `seq+1`. Contract merge then
   accepts it.
6. A contact change (add, rename, remove) signs a whole new contacts record at
   `seq = max(contract.contacts.seq + 1, delegate.contactsNextSeq)`, sends it as
   a `Delta` with `contacts` set and `slots: []`, and updates the address book
   from the response / subscription notification.
7. A parent change (set or clear) signs a new parent record at
   `seq = max(contract.parent.seq + 1, delegate.parentNextSeq)`, sends it as a
   `Delta` with `parent` set and `slots: []`, and updates from the response /
   subscription notification.
8. Send `UpdateRequest(key, DeltaUpdate(delta bytes))`; update UI from the
   response / subscription notification.
9. Clearing a slot sends `entry: null` with a higher `seq` (tombstone).
10. The editor's value is optional: blank saves `0`. It accepts at most two
    decimals, converts to an exact i64 count of hundredths, and displays every
    value with exactly two decimals. The contact select is mandatory and lists
    the current address book; adding a contact writes it before the slot save.
11. The tree UI loads the own board from the delegate key. A child or parent
    board is read by deriving its contract key from that owner's user id and the
    current code hash, then GETting it read-only (no PUT/subscribe). It falls
    back to the migratable v2 code hash and marks the board "previous version".
    Another owner's board is never signed by this device.
12. A parent→child edge is a tree edge only when both signed sides agree (see
    the tree model). Breadcrumbs follow mutual parent edges, cache fetched
    boards, cap the depth, and stop on a cycle. Pending/not-created/legacy
    edges are shown but not followed as tree edges.
13. If the own board has no self-entry, a blocking "Name your board" dialog
    writes one via the contacts record. Labels for a user/board resolve as:
    relevant address-book label, then the target board's own name (self-entry),
    then a shortened id. The header groups Identity, Board name (own) or
    Viewing (remote), Parent, Contacts, and a collapsed Details section with
    the Contract id; separators mark the groups.
14. The board head shows the current board's octal address (empty for a root)
    and the area above the grid shows the parent's value for it when the
    parent's readable state has a slot for the board. Both use the same cached
    board reads as the parent row and breadcrumbs; stale async renders are
    discarded when the viewed board changes.

### Identity backup and restore (user-facing)

- `ui/src/identity.ts` wraps the delegate's `export` payload in versioned JSON:
  `{v: 1, kind: "number-identity", seed, nextSeq, contactsNextSeq?, pubkey,
  createdAt}`. `pubkey` and `createdAt` are informational; the delegate
  validates the seed and counters. `nextSeq` must be 8 positive safe integers,
  matching the delegate. `contactsNextSeq` is optional for backward
  compatibility with v1 backups (missing ⇒ 1).
- The first-run dialog is a blocker: `status.hasSeed == false` after legacy
  migration pauses the board until the user creates a key or imports a backup.
  Escape and backdrop cannot dismiss it into an implicit new key, because the
  delegate refuses imports once a seed exists (`ui/src/identity-dialog.ts`).
- The seed is rendered only after an explicit reveal, in a readonly textarea,
  and cleared on hide or close. It is never written to storage, the URL, or the
  console. Restore validates the code before calling the delegate, and any
  codec or delegate error stays inline so the user can retry.
- Imported counters are used as-is; the first write takes
  `max(contract.seq + 1, nextSeq[i])`, so a restore cannot replay a lower seq.
- The backup carries no board data. Another device derives the same contract
  key from the restored pubkey and loads the board over Freenet; a local-only
  node will show an empty board until it can reach the network.

Build-time constants (Vite `define`):

- `__CONTRACT_CODE_HASH__` — base58 string (contract code hash)
- `__DELEGATE_KEY_BYTES__` — number array; derived as
  `BLAKE3(delegate_code_hash_bytes || webapp_id_bytes)`, because the delegate
  is published with the webapp id as parameters
- `__DELEGATE_CODE_HASH_BYTES__` — number array
- `__WEBAPP_CONTRACT_ID_BYTES__` — number array; sent as the
  `ApplicationMessages.params` on every delegate request, because the node
  checks it against the parameterised delegate key
- `__CONTRACT_WASM_URL__` — `./number_contract.wasm`

The webapp id itself comes from `delegate/webapp_contract_id.txt`; see §7.

## 9. Layout and ownership

```
contract/     # standalone crate, own Cargo.lock (NOT a workspace member)
delegate/     # standalone crate, own Cargo.lock
ui/           # Vite app; e2e/ holds the Playwright specs
published/    # committed reproducible WASMs + manifest.json (the address)
scripts/      # canonical build, byte-equality gate, artifact recorder
rust-toolchain.toml  # pinned rustc; a bump is a deliberate re-key
.build/       # throwaway per-crate cargo target dirs (ignored)
.github/      # CI (contract, delegate, UI, smoke, merge laws, byte equality)
Makefile
```

Contract and delegate are excluded from any workspace (see build-system →
"Per-contract lockfile isolation"). Their `Cargo.toml` pins are exact.

## 10. Acceptance

- `cargo test` in `contract/` covers: signature tamper per field, slot and
  contacts bounds, parent bounds/self-parent/tamper, seq-0 invariants, contacts
  uniqueness, v2-signed slots/contacts with an empty parent validating as v3,
  summary/delta round-trip including parent and contacts, parent/contacts-only
  delta, empty delta when converged, property tests for parent/slot/contacts
  merge comm/assoc/idempotence/absorption.
- `cargo test` in `delegate/` covers: identity creation/stability, slot,
  contacts, and parent signing golden vectors, seq monotonicity for all three
  counters, slot/contacts/parent bounds, parent self-check, pinned-webapp
  acceptance, foreign webapp / `Delegate` / missing-origin rejection,
  malformed delegate parameters failing closed, `status` without seed creation,
  export/import round-trip preserving identity and all counters, and import
  refusing to overwrite an existing seed.
- `make check-artifacts` rebuilds both WASMs reproducibly and byte-compares
  them to `published/`; `migrations.test.ts` proves every superseded generation
  in `published/manifest.json` is still in a migration registry, that v2 is
  migratable, and that a v1 hash is never listed as migratable.
- `make verify-merge`: the generated bundle carries states, deltas, summaries
  and transitions, including parent and contacts changes; 0 violations, 0
  inconclusive, and each of the 14 laws generates at least one case.
- `npm run build` in `ui/`, then the in-repo Playwright offline spec
  (`ui/e2e/offline.spec.ts`) against `vite preview` with the mock backend:
  mount, add contacts, save decimals, set/clear a parent, open a fixture child
  read-only, navigate breadcrumbs/home, see pending/not-created states, reject
  duplicate children, axe, clean console, blank `0.00`, >2 decimals rejected,
  and the full i64-cents range.
- Board names/header: a missing self-entry opens a non-dismissible name dialog;
  saving writes the self-entry; the Board name row renames it; a name equal to a
  contact is rejected; the address book reserves the board name and shows 63
  other contacts; removing a contact falls back to the remote board's own name
  in the slot/parent/Viewing/path labels; the Contract id is only in a closed
  Details section; separators and axe pass.
- Real node: add a contact, save a two-decimal value, reload, and confirm the
  contact label and exact hundredths survive; set a parent/child link and
  confirm the mutual check on two identities (or the offline fixture); clear a
  contact and confirm old slots show an unknown id rather than becoming
  invalid.
- v2→v3 migration on a real node: load a v2 board through the v3 UI, confirm
  the client PUTs the upgraded v3 state, the contacts/slots/values survive, and
  the parent is empty (root).
- Gateway spec (`ui/e2e/gateway.spec.ts`) with `FREENET_BASE_URL` pointing at a
  `/v1/contract/web/<id>/` URL: shell bridge, sandboxed iframe, identity and
  board mount, no fatal console/network errors.
- Fresh-node bootstrap through the gateway: a node without the delegate shows
  the install prompt, installs the bundled WASM (verified by code hash), then
  continues into identity setup; create, save, reload and confirm persistence
  with no prompt on the second load. Declining shows a clear error notice.
- Local node: publish delegate + contract, PUT/UPDATE via the UI, reload and
  confirm persistence; tombstone a slot and confirm it does not resurrect.
- Migration: publish a successor delegate, confirm the UI exports the
  predecessor seed and imports it before identity creation (same owner key);
  for a schema-compatible contract change, list the outgoing hash in
  `LEGACY_CONTRACT_CODE_HASHES` and confirm the new instance receives the old
  signed state. v2→v3 is exactly this case. Confirm the UI does **not** probe
  the v1 hashes in `UNMIGRATABLE_CONTRACT_CODE_HASHES`.

## 11. Verified behaviours (local-node findings)

These are not design preferences; each was observed against `freenet` 0.2.150
(`freenet local`, WS API on 7510) and are load-bearing for the UI.

- **A missing delegate produces no reply.** `RegisterDelegate` installs code,
  and the client API does not answer an `ApplicationMessages` request for a
  delegate that is not in the store (only a node WARN). The UI therefore treats
  a `status` timeout as "may need installing"; re-registering an existing
  delegate is harmless.
- **An empty summary means "I hold nothing".** The node presents an empty
  summary when a subscriber is first registered. `get_state_delta` therefore
  returns every non-empty slot for an empty (or undecodable) summary instead of
  rejecting it. Returning `InvalidDelta` there aborts the notification with
  `trying to read an invalid delta` in the node log, which silently kills live
  updates.
- **GET for a missing instance may time out rather than report not-found.**
  `freenet-stdlib` 0.4.0 delivers not-found through the `onContractNotFound`
  handler, not by rejecting `get()`. In captures, the node answered a GET for a
  missing board with `Ok` acknowledgements and no `NotFound` within the 4 s
  probe; the gateway shell forwards frames verbatim, so this is not a shim
  drop. The UI probes with a short budget and follows any failure with a PUT.
  PUT over an existing instance is a merge no-op (the empty initial state loses
  every slot merge), so a spurious PUT only costs bandwidth.
- **`SubscribeResponse` is serialized as `PutResponse`.** The gateway shell is
  not involved: freenet-stdlib's client-event serializer still sends the
  `PutResponse` union tag (a stale "not yet in generated code" workaround),
  dropping `subscribed`. Clients cannot confirm a subscription or see a
  refusal; a long-lived local test showed the subscribe promise timing out
  while deltas continued to arrive. The UI treats a timeout as "unconfirmed".
  Report and repro: `reports/upstream-subscribe-response.md`.
- **The board's contract key is stable per owner but moves with the contract
  WASM.** It is `BLAKE3(BLAKE3(wasm) || owner_pubkey)`. Any contract change
  (including a dependency bump) creates a new instance; the owner key remains
  the stable anchor for a future migration.
- **A delegate published with parameters must receive them on every request.**
  `ApplicationMessages.params` is checked against `BLAKE3(code_hash || params)`;
  omitting them makes the node refuse with `parameters do not match the
  delegate key` before the WASM runs. The UI now sends
  `__WEBAPP_CONTRACT_ID_BYTES__` on every delegate request.
- **Migration was exercised locally.** A successor delegate exported a
  predecessor's seed and imported it before identity creation, preserving the
  owner key and slot value. A schema-compatible contract WASM change with the
  outgoing hash in `LEGACY_CONTRACT_CODE_HASHES` re-PUT the old signed state
  into the new instance; the owner identity and slot value survived.
- **v1 was a deliberate board break; v2→v3 is not.** The address book changed
  the v1 state schema and signing bytes, so v1 boards are not carried forward.
  v3 keeps the v2 slot/contacts bytes and adds a parent record, so v2 boards
  migrate by adding an empty parent. The delegate seed is migrated in both
  cases (same owner public key), which keeps the account and migration anchor.
  Do not add a v1 hash to the migratable list: `validate_state` would reject
  the PUT.

# v4.1 auto-advance + v5 issue/burn — implementation spec (rev 2)

Status: reviewed (oracle gate, attempt 1). Two shippable passes; no ledger.

- **Pass 1 (v4.1, delegate-only):** the owner's delegate subscribes to the
  board's inbox and auto-advances a forward payment leg when the signed intent
  names the owner as `next`. Default on once configured. No contract change.
- **Pass 2 (v5, contract + UI):** a board owner signs an issue/burn adjustment
  to a slot's liability. The adjustment is a signed, capped log entry, visible
  to the child. Slot value changes remain ordinary signed slot entries (v2
  signing bytes unchanged). Burn clamps at 0.

The delegate is re-keyed once (v7 -> v8). The v8 build carries both
auto-advance and a dormant `signAdjustment`, parses **both** `StateV4` and
`StateV5`, and stores both the active and legacy code hashes, so pass 2 needs
no second delegate migration.

## Pass 1 — delegate auto-advance

### Manifest

```rust
#[delegate(manifest(
    lifecycle = [NodeStarted],
    capabilities = [Background],
    wakeups = [inbox = 300],
))]
```

`NodeStarted` is listed with `wakeups` so an older node still asks for
Background. Do not strip the `freenet-manifest` section.

### Configuration

Secret `number.v8.config`, JSON:

```json
{
  "codeHashes": ["<base58 active>", "<base58 legacy>", "..."],
  "address": "<octal>",
  "autoAdvance": true,
  "maxAmount": 1000000
}
```

- `codeHashes` are **base58** 32-byte code hashes, newest first (the active
  one, then `LEGACY_CONTRACT_CODE_HASHES`). The instance id is
  `BLAKE3(raw_code_hash || owner_key)`; a 64-hex string derives nothing.
- `address` is the owner's octal address from the UI (`octalAddress`). The
  delegate validates its last digit against the parent board it can read.
- `maxAmount` is a per-payment cap in hundredths. Default 1,000,000
  (10,000.00). `0` disables the cap. The UI can change it.
- If config is absent, auto-advance is inert and `status` says so.

Requests:

```json
{ "cmd": "configure", "codeHashes": ["..."], "address": "52",
  "autoAdvance": true, "maxAmount": 1000000 }
{ "cmd": "setAutoAdvance", "enabled": true, "maxAmount": 1000000 }
```

Both are acknowledged with a bare `{"ok":true}`. A status-shaped ack is
tolerated by the client but is ambiguous with an in-flight `status`, so the
delegate should keep the ack bare. `status` always includes the v8 fields;
`autoAdvance` is `true` for an unconfigured v8 delegate (the default-on
policy), and a v7 predecessor omits the fields entirely.

`status` gains:

```json
{ "configured": true, "codeHashes": ["..."], "matchedCodeHash": "...",
  "address": "52", "autoAdvance": true, "maxAmount": 1000000,
  "subscriptions": ["<hex>"], "lastScan": 0, "lastError": null,
  "audit": [ { "id": "...", "cursor": 1, "slots": [2], "role": "debit" } ] }
```

The UI compares `matchedCodeHash` (and the active hash) and warns when the
delegate is stale. A stale hash resolves every neighbour to a different
instance and silently returns nothing. This is the main operational failure
mode.

### Subscription set

Desired set = the owner's own instance (newest hash that resolves) + the
parent + every slot contact. Instance ids derive from each hash candidate and
the 32-byte owner id; probe newest-first and stop at the first state that
decodes.

- `SubscribeContractRequest` is idempotent; keep `number.v8.subscriptions` and
  skip ids already present.
- **Never emit `UnsubscribeContractRequest`**: core does not implement it and
  fails the whole run (freenet-core#5600). Removed children leave a live
  subscription; the 256 cap evicts LRU silently.
- Bootstrap at most 4 subscribes per invocation; persist the pending queue.
- `NodeStarted`: re-subscribe own + parent unconditionally (the persisted set is
  not authoritative after silent eviction).
- Subscriptions register demand (#5615), so they also act as the fetch path.

### Triggers and scan state machine

Every inbound is a step of one state-based scan. Explicitly handle
`ContractNotification`, `WakeupFired { tag: b"inbox" }`, `Lifecycle(NodeStarted)`,
`GetContractResponse`, `UpdateContractResponse`, `SubscribeContractResponse`,
`PutContractResponse`. An unhandled response means the scan never resumes.

Persisted `number.v8.inbox`:

```json
{ "instances": { "<hex>": { "state": "unknown|requested|known", "seq": 0 } },
  "cursor": 0, "budgetReset": "node_start|wakeup" }
```

1. Read own state locally (`ctx.get_contract_state`). On a miss, issue one
   `GetContractRequest` and stop; the response resumes the scan.
2. Recompute the desired set and pending subscribes.
3. For each desired instance: use the notification state when present, else
   the local cache. On a miss, issue **one** outstanding `GetContractRequest`
   per instance and mark `requested`; the response marks `known` or `unknown`.
   Never issue a second request for a `requested` instance.
4. The 4-network-op budget is per parked run and is **reset only on
   `NodeStarted`/`WakeupFired`**, never on a response; otherwise each response
   issues four more.
5. `GetContractResponse.state == None` is ambiguous: refusal, network
   `NotFound`, and unreachable all look the same. Mark `unknown`, retry on the
   next wake. Never read it as "no work".
6. For each known neighbour, find `payments.entry` with `next == ownerId`,
   `phase == "forward"`, `status` in {`offered`, `acted`}. Reverse and terminal
   stay manual.
7. Run the mandatory checks below. On any failure, set `lastError`, skip, and
   keep scanning other instances.
8. Build the delta from **own state** and the actor step; never copy
   neighbour-supplied `next` or legs. Sign the slot(s) and the payments record,
   emit one `UpdateContractRequest`.
9. Dedup: key `(payment_id, cursor, phase, from_owner)`. Record it before
   signing; reconcile on `UpdateContractResponse` (a successful update advances
   the record; a rejected one clears the key so a later scan can retry).
10. Audit: bounded `number.v8.audit` (last 32) with id, cursor, slots, role.

### Mandatory auto-advance checks

The delegate signs its own board, so these are the security boundary:

(a) **Previous actor identity.** The notifying/previous board's owner must be
    the route's previous actor derived from own state: the parent
    (`parent.userId`) when the value moves down; the child on the source path
    (the slot digit in `srcAddr` at own depth) when it moves up; that same
    source-side child for the LCA pair. "Adjacent" is not enough.
(b) **Previous actor's signature.** Verify the previous board's `payments`
    signature under its owner key (the slot contact or `parent.userId`). Verify
    its `payments.entry` matches the intent on `id`, `phase`, `cursor`.
(c) **Previous actor's last leg.** For each leg the previous actor claims,
    verify against that actor's own state: `slot.seq == leg.seq`,
    `slot.entry.value == leg.post_value`, `slot.sig == leg.sig`. For a
    **credit**, also require `slot.entry.contact == own owner`: the credit is
    to this board's slot. For `cursor == 0`, the previous actor is the source;
    verify the source's payments signature and that the debited slot's contact
    equals `intent.src`.
(d) **Own record.** If `own.payments.settled` contains the id, drop. If
    `own.payments.entry` has the same id and `own.cursor >= intent.cursor`,
    drop. A different non-terminal entry means busy: never clobber it.
(e) **Cursor continuity.** `cursor > 0` requires the previous record to be
    `phase == "forward"`, `status == "acted"`, and the same cursor.
(f) **Amount and funds.** `intent.amount > 0` and `<= maxAmount` (unless 0).
    Debit: `slot.entry.value >= amount`; credit: `checked_add`. Overflow aborts.
(g) **Final leg.** The credited slot's contact == `intent.dst`, and the
    destination board's `parent.userId == own owner`.

Build `next`, `status`, `cursor`, and `legs` from own state + the actor step.
`phase` becomes `terminal` and `next = 0…0` only on the final leg.

### Leg computation

Port the pure parts of `ui/src/payments.ts` (`planRoute`, `actorStep`, the
per-hop debit/credit rules and the LCA pair) into `delegate/src/advance.rs`.
Inputs: own address, own state, intent, previous board state/owner. Output: a
pure `LegPlan` (slots, new values, new payment fields). No signing in this
module. Cross-pin TS↔Rust golden vectors for:

- a 3-hop route, source-side debit;
- the LCA pair;
- a destination-side credit;
- the destination's parent final leg;
- `cursor == 0` source-parent leg;
- a negative debit (abort);
- a wrong-neighbour intent (abort);
- a credit with no upstream evidence (abort).

Slot seq = `max(slot.seq + 1, nextSeq[slot])`; payments seq =
`max(payments.seq + 1, paymentsNextSeq)`. Use the existing `sign_with` paths.

Reverse legs are **not** auto-advanced in v4.1; the UI keeps its reverse path.

### Mixed v4/v5 trees

The delegate parses `StateV4` and `StateV5`. If the own board resolves only at
a legacy hash, or any actor on the route is a v5 board while the own board is
v4 (or vice versa), auto-advance is disabled for that payment with
`lastError = "mixed-version"`. The UI shows the same "previous version"
state it already shows for v4/v3 boards. This prevents signing into a tree
the contract cannot merge.

### Policy

Default `autoAdvance = true` once configured, with `maxAmount` default
1,000,000. The mandatory checks are the policy. The user can disable it; the
UI shows the audit, last scan, and last error. No counterparty allowlist in
v4.1.

### Limits

- Only while the node runs; a skipped wake-up is not replayed (45 s start
  budget); notifications are lossy.
- GET responses have no error channel; unknown states are retried.
- At most 4 network ops per parked run; bootstrap and misses are incremental.
- No unsubscribe; subscriptions are append-only.
- `freenet local` does not run the delegate contract loop; native tests cover
  the pure logic, and a real two-node smoke test is required before calling
  pass 1 done.

## Pass 2 — v5 issue/burn

### State

```rust
pub struct Adjustments {
    pub seq: u64,                 // 0 = empty
    pub entries: Vec<Adjustment>, // oldest first, MAX_ADJUSTMENTS = 32
    pub sig: Option<String>,
}

pub struct Adjustment {
    pub slot: u8,                 // 0..7
    pub slot_seq: u64,            // the slot write this describes, > 0
    pub delta: i64,               // +issue, -burn, non-zero
    pub post_value: i64,          // >= 0
    pub note: Option<String>,     // <= 128 UTF-8 bytes
}
```

`StateV5 { v: 5, parent, contacts, payments, adjustments, slots }`.

### Signing bytes (new, v5 only)

```text
b"number:v5:adjustments"
|| seq: u64 LE
|| count: u32 LE
|| for each entry in order:
     slot: u8
     || slot_seq: u64 LE
     || delta: i64 LE
     || post_value: i64 LE
     || note_len: u32 LE || note bytes
```

Slot signing bytes remain `number:v2:slot`. An issue/burn is two signed records
in one delta: the ordinary slot entry and the `Adjustments` record.

### Validation (merge-invariant only)

`StateV5::validate` checks only predicates that read one component:

- `seq == 0` => entries empty, no sig.
- `seq > 0` => valid Ed25519 signature; `entries.len() <= 32`.
- Each entry: `slot < 8`, `slot_seq > 0`, `delta != 0`, `post_value >= 0`,
  the pre-value is non-negative and non-overflowing (`checked_sub` for positive
  `delta`, `checked_add` for negative), note <= 128 bytes.
- No duplicate `(slot, slot_seq)`; within one slot `slot_seq` strictly
  increases in list order.

**Do not cross-check `slot_seq`/`post_value` against `state.slots` in
`validate_state`.** Adjustments and slots merge independently; two valid states
can merge into a mismatched pair, and rejecting that merged state breaks
convergence. (The oracle found this concretely.)

### Provenance at update time

`update_state`, per incoming delta, before merging:

- If the delta carries an `Adjustments` record and any slot write, then for
  every *new* entry (entries not present in the current `Adjustments`) the
  referenced slot must be present in the same incoming delta, with
  `slot.seq == entry.slot_seq`, `slot.entry.value == entry.post_value`, and
  `new_value == old_value + entry.delta` where `old_value` is the pre-update
  slot value. A new entry without its slot write rejects the delta.
- Full-state updates (migration) validate signatures/bounds only; they do not
  carry provenance. This is acceptable because the owner signs the state.

The log is a **child-facing hint, not a tamper-proof audit trail**: the
higher-seq record replaces the whole log, so the owner can truncate or rewrite
their own history. State that explicitly and do not build enforcement on it.

### Merge, summary, delta

- `Adjustments` merges by `max(seq)`, tie broken by lexicographically greater
  signature bytes (same as `Contacts`/`Payments`).
- `Summary` gains `adjustments: [seq, digest16]`, zeros at seq 0.
- `Delta` gains `adjustments: Option<Adjustments>`; `get_state_delta` includes
  it on the same seq/digest rule.
- `Summary.v`/`Delta.v` become 5. Add per-version decode tests.
- Add a `merged_states_stay_valid` proptest covering Adjustment/slot
  mismatches.

### Migration

- The contract v5 accepts only `v == 5`. The client upgrades a v4 state by
  adding `adjustments: {seq:0, entries:[], sig:null}` and setting `v:5`; all
  existing signatures remain valid.
- v5 is a **new contract instance**, not an in-place upgrade: register the
  active v4 code hash in `LEGACY_CONTRACT_CODE_HASHES` (record gate), then
  GET(v4)/PUT(v5) and leave the v4 instance quiescent.
- v2/v3 hashes remain; the UI upgrade chain becomes v2 -> v5 and v3 -> v5.
  v1 stays unmigratable.

### Delegate (already in v8)

- `number.v5.nextseq.adjustments` (u64, default 1).
- `{"cmd":"signAdjustment","seq":N,"entries":[...]}`: require
  `seq >= nextseq`, validate the record (same bounds, note **bytes**,
  `slot_seq` > 0), sign, persist `seq + 1`, return `{ "seq": N, "sig": "..." }`.
- `export`/`import` carry the counter; older delegates default it to 1.

### UI

- `STATE_VERSION = 5`; add `V4_STATE_VERSION = 4`; upgrade v2/v3/v4 to v5.
- Issue/Burn action on a slot: amount, direction, short reason; clamp at 0.
  Sign the new slot entry first (get its seq), then the `Adjustments` record
  with that `slot_seq`, then submit one delta. Direct value edits outside this
  flow are removed; unit/note/contact edits stay ordinary slot updates.
- Child view: in the "Held by parent" band, show the parent's current
  liability plus the recent adjustments for the slot that names this child
  (delta, post value, note). If the parent's slot seq advanced past the last
  adjustment, label the value as changed by a payment.
- The UI sends the delegate `codeHashes` (active + legacy), `address`,
  `autoAdvance`, `maxAmount` on connect; shows `matchedCodeHash`, last scan,
  last error, and the audit.

### Tests

- Adjustment signing golden vectors, cross-pinned contract <-> delegate <-> UI.
- Contract: tamper (slot, seq, delta, post, note, duplicate `(slot,slot_seq)`,
  decreasing slot_seq), provenance (missing slot write, wrong value, wrong
  delta), merge proptests, summary/delta round-trip, v4->v5 upgrade,
  `merged_states_stay_valid`.
- `make verify-merge` runs the new properties with positive case counts.
- Delegate: signAdjustment vector, counter persistence, import/export default.
- UI: codec v5, upgrade, issue/burn flow, child visibility.
- Pass 1: advance vectors above; real two-node smoke test for notification/
  wakeup/GET response handling.

## Release order

1. Delegate v8 (manifest + auto-advance + dormant signAdjustment, parses v4 and
   v5, codeHashes list). Register v7 in `LEGACY_DELEGATES`; migrate seed and
   all counters **before** `configure`; otherwise v8 mints a fresh owner key.
2. Verify pass 1 on a real node (two-node smoke).
3. Contract v5 + UI v5. Register the active v4 hash first; GET(v4)/PUT(v5).
4. The delegate refuses auto-advance in a mixed-version tree; the UI shows
   "previous version".

## Non-goals

- No one-ledger contract; no unsigned routed legs.
- No reverse auto-advance in v4.1.
- No counterparty allowlist in v4.1.
- No delegate legacy probing beyond the configured hash list.

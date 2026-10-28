# Cooperative payments (v4) — implementation spec

Status: first slice. This is the protocol the code implements; it is deliberately
asynchronous and manual-advance. It does not promise instant delivery.

## Model

Each board keeps at most **one active payment** in its signed state. A payment
moves along the unique path in the board tree between the source and destination
addresses. The amount is in hundredths, positive, and never makes a debited
value negative.

Only the owner of a board signs that board's state. Therefore a payment advances
in signed legs:

1. the source writes the intent in its own `payments` record;
2. each board on the route, including the LCA, discovers the intent from its
   **inbox** (its parent and its eight children) when that board is opened;
3. each board applies its own leg and re-signs the intent in its own record;
4. the destination is credited by its parent, which also checks the supplied
   user id;
5. a failure starts a reverse walk; each board that already acted undoes its own
   leg. A reversal is best effort: if an owner does not act, or a later signed
   write has superseded the leg, the payment stays `reversing`/`blocked` and the
   UI says so.

There is no server, no push notification, and no cross-contract transaction.

## Addresses and route

`octalAddress` is zero-based slot digits from the root, no separator; root is
`""`. A source and destination must share one root.

Let `A = srcAddr`, `B = dstAddr`, `l` = length of the longest common prefix
(LCA). Require `dS = len(A) - l >= 1` and `dD = len(B) - l >= 1`: there must be
at least one debit and one credit. Payments where the source or destination is
the LCA are refused (they would create value). The first slice does **not**
require equal depths; it implements the requested arithmetic literally, so
`dS != dD` changes the sum of the touched edge values.

`cursor` = number of route hops already applied. `N = dS + dD`.

| cursor | actor | effect |
|---|---|---|
| `0` | source owns the intent; no leg | sets `next` to the source's parent |
| `0 <= i < dS - 1` | ancestor of source at depth `len(A) - 1 - i` | debit its slot for the child below by `amount`; `cursor = i + 1` |
| `i = dS - 1` | LCA | debit the source-side slot and credit the destination-side slot in one delta; `cursor = dS + 1` |
| `dS + 1 <= i < N - 1` | ancestor of destination at depth `i - 1` | credit its slot for the child below; `cursor = i + 1` |
| `i = N - 1` | parent of destination | credit its slot for the destination; validate the user id; `cursor = N`, `complete` |

The LCA's two legs are one atomic `update_state`. The source has no leg: its
incoming value is held in its parent's slot, which the source cannot sign.

A forward actor also checks that the intent came from the previous route actor
and that the previous actor's signed record has the same payment id and cursor.
A reverse actor requires its own signed record to match the request on id, src,
dst, amount and both addresses, and requires the request to come from the next
route actor; it never trusts a neighbour's amount or route. The source-close
branch uses the same own-record check, so it cannot clobber a newer offer. This binds
each leg to the one before it instead of trusting a cursor supplied by any
neighbour. A source whose record is still the offered copy may start its next
payment once the signed chain it can read is terminal; it does not need a
separate acknowledgement write.

## State: `payments` record

State version is `4`. The record is optional on the wire for v3 upgrade; the
canonical v4 state always writes it.

```json
"payments": {
  "seq": 6,
  "settled": ["<32 lowercase hex>"],
  "entry": {
    "id": "<32 lowercase hex>",
    "src": "<64 hex owner id>",
    "dst": "<64 hex owner id>",
    "amount": 1250,
    "srcAddr": "52",
    "dstAddr": "31",
    "cursor": 2,
    "phase": "forward",
    "status": "acted",
    "next": "<64 hex expected actor>",
    "fail": null,
    "legs": [
      { "slot": 1, "seq": 4, "postValue": 3750, "sig": "<128 hex>" }
    ]
  },
  "sig": "<128 hex>"
}
```

- `seq == 0` means the empty record (`settled: []`, `entry: null`, `sig: null`).
- `seq > 0` with `entry: null` is a legal tombstone.
- `seq > 0` with an entry requires a signature over the canonical bytes below.
- `settled` holds up to **8** recently settled payment ids, oldest first. The
  client appends the outgoing entry's id whenever it replaces that entry with a
  different id (or clears it). `findIncoming` ignores an intent whose id is in
  this list, so a stale copy cannot replay after the board has moved on. The cap
  is a Phase 1 bound; an id older than the last 8 payments can still be replayed,
  which is documented as a known limitation.
- `phase`: `forward` | `reverse` | `terminal`.
- `status`: `offered` | `acted` | `complete` | `reversing` | `reversed` |
  `aborted` | `blocked` | `superseded`.
- `fail`: `null` | `negative` | `no-destination` | `busy` | `refused` |
  `address-mismatch` | `blocked` | `superseded`.
- `next` is the owner id expected to act next; all-zero when terminal.
- `id = blake3(src || srcSeq || dst || amount)[0..16]` hex, where `srcSeq` is
  the source's payment record seq (the intent's origin). It is unique per
  origin intent and prevents stale copies from being treated as a new payment.
- `legs` has at most 2 entries (the LCA has two). `slot` is 0..7, `seq > 0`,
  `postValue` is the signed post-leg value, `sig` is the slot signature. The
  reversal engine reverses only when the current slot still has exactly that
  `seq` and `sig`; otherwise it reports `superseded` and does not overwrite.
- At most one entry per board in this slice. A second concurrent intent is
  refused as `busy`.

### Canonical signing bytes

```text
b"number:v4:payments"
|| seq: u64 little-endian
|| settled_count: u8
|| for each settled id: 16 raw bytes
|| tag: u8                       // 0 = no entry, 1 = entry
// only when tag == 1:
|| id: 16 raw bytes
|| src: 32 raw bytes
|| dst: 32 raw bytes
|| amount: i64 little-endian
|| srcAddr_len: u32 LE || srcAddr ASCII bytes
|| dstAddr_len: u32 LE || dstAddr ASCII bytes
|| cursor: u8
|| phase_tag: u8                 // forward=0, reverse=1, terminal=2
|| status_tag: u8                // offered=0, acted=1, complete=2, reversing=3,
                                 // reversed=4, aborted=5, blocked=6, superseded=7
|| fail_tag: u8                  // none=0, negative=1, no-destination=2, busy=3,
                                 // refused=4, address-mismatch=5, blocked=6,
                                 // superseded=7
|| next: 32 raw bytes
|| legs_count: u8
|| for each leg:
     slot: u8 || seq: u64 LE || postValue: i64 LE || sig: 64 raw bytes
```

The contract, delegate and UI share one golden vector for this encoding.

## Validation

Contract validation (in addition to the existing state rules):

- `payments.seq == 0` => empty `settled`, empty entry and no sig; `seq > 0` => valid signature.
- `settled.len() <= 8`; every id is 32 lowercase hex; no duplicates.
- entry fields: ids/addresses hex shape; address length <= 32 and digits `0..7`;
  `amount > 0`; `cursor <= 64`; phases/statuses/fails in range; `legs.len() <= 2`;
  unique leg slot; terminal `next` is all zero; leg signatures are lowercase
  128-hex; `leg.seq > 0`.
- The contract deliberately does not check tree topology, the LCA, the amount
  arithmetic, or that a leg's slot write is in the same delta. Those are UI
  protocol rules; the signed record is evidence, not proof.

## Merge and summaries

- `payments` merges exactly like `parent`/`contacts`: higher `seq` wins, equal
  `seq` -> lexicographically greater signature bytes. The whole record, including
  `settled`, moves together; a tombstone at a higher seq clears the active
  payment but keeps its settled ids.
- `Summary.v = 4` adds a `payments: [seq, digest16]` pair.
- `Delta.v = 4` adds `payments: Payments | null`; absent/null means unchanged.
- `get_state_delta` includes payments when newer or diverged at equal seq.

## Legality and failure

Before a debit:
- read the actor's own current slot value (the parent slot for the child below);
- require `value >= amount`; otherwise write an `aborted`/`reverse` record with
  `fail: "negative"` and `next` = previous actor, and do not sign the slot.

Before a credit reversal (when undoing a credit):
- require the current value still has at least `amount`; otherwise
  `blocked`/`reversal-blocked` and stop.

Destination check (last actor, and the source's preflight):
- the destination board read by `dst` must exist;
- its signed `parent.userId` must equal the last actor;
- the last actor's slot for it must have `contact == dst`;
- the supplied user id must equal the board owner id (which is how the board was
  read); a mismatch aborts.

If the source preflight fails, nothing is written. If a leg fails later, the
already-applied legs are reversed in LIFO order. The reverse intent carries the
route and cursor; each actor reverses its own leg(s) and forwards to the previous
actor. At cursor 0 the source writes a terminal `reversed` (or `blocked`) record.

## Inbox

A board's inbox is its parent plus its eight direct children. On open/refresh it
reads those boards and selects `payments.entry` where `next` equals its own owner
id. This is the only discovery mechanism. A payment advances only when its next
owner opens the board. A source can show the aggregate by walking the route and
reading each actor's record; no push exists.

## Migration

v4 is additive. Slot, contacts and parent signing bytes are unchanged. A v3 state
upgrades by adding `payments: {seq:0, entry:null, sig:null}` and setting `v:4`.
The current v3 contract hash is registered as legacy; the current delegate key is
registered before rebuilding. Existing v2/v3 boards migrate through the existing
GET -> upgrade -> PUT path.

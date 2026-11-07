# Rooms — implementation spec (P3a, members room)

Status: draft 1, 2026-11-07. Implements the **members room** of
`DESIGN-network.md` §5. The candidate room (bounded request queue, interviews,
`?root=` onboarding) is P4 and is a separate contract.

Scope decisions:

- The room is a **new standalone contract crate** (`room/`). It does not touch
  `contract/`, so the zone code hash and every existing zone stay put.
- **One WASM per room kind.** This crate accepts `ZMR1` only and will be frozen
  before P4. The candidate room (`ZCR1`) gets its own crate/WASM, so adding the
  request queue later cannot re-key existing members rooms.
- The contract stores message bodies as **opaque bytes**. Encryption is
  client-side (P3c); P3a/P3b may run plaintext. The epoch-secret blob shape is
  present and owner-signed from the first version, so P3c does not need a
  contract change.
- Membership is a **history**: old epochs remain valid history; removal takes
  effect at the next epoch. This is the associative rule (see §6).

## 1. Key derivation

```
room_wasm   = the built room WASM
code_hash   = BLAKE3(room_wasm)                      // raw WASM, never packaged
parameters  = b"ZMR1" || owner_vk                    // 4 + 32 = 36 bytes
instance_id = BLAKE3(code_hash_bytes || parameters)  // standard Freenet id
```

`owner_vk` is the 32-byte Ed25519 verifying key of the zone owner. The room is
derived from the owner key, not the zone contract id, so a zone WASM upgrade
does not break room links. The client must pin the published room code hash;
never derive a room from a fetched WASM.

Accepting `ZMR1` here and `ZCR1` elsewhere is deliberate: sharing one WASM
would force the P4 queue into today's code hash or re-key every room.

## 2. State v1

`deny_unknown_fields` on every struct. Lowercase hex only. The owner and kind
live in the parameters and are covered by every signature, so one static
initial state works for every room:

```json
{ "v": 1, "memberships": [], "messages": [] }
```

```json
{
  "v": 1,
  "memberships": [
    {
      "seq": 1,
      "members": ["<64 hex>", "..."],
      "secrets": [
        { "recipient": "<64 hex>", "blob": "<lowercase hex>" }
      ],
      "sig": "<128 lowercase hex>"
    }
  ],
  "messages": [
    {
      "author": "<64 hex>",
      "epoch": 1,
      "seq": 1,
      "time": 1762500000000,
      "body": "<lowercase hex>",
      "sig": "<128 lowercase hex>"
    }
  ]
}
```

Bounds:

| Constant | Value |
|---|---|
| `MAX_MEMBERS` | 9 (owner + eight slots) |
| `MAX_MEMBERSHIPS` | 32 |
| `MAX_SECRETS_PER_MEMBERSHIP` | 9 |
| `MAX_SECRET_BLOB_BYTES` | 256 |
| `MAX_MESSAGES` | 200 |
| `MAX_BODY_BYTES` | 1024 |
| `MAX_MESSAGES_PER_DELTA` | 16 |
| `MAX_MEMBERSHIPS_PER_DELTA` | 1 |

Membership records:

- `seq > 0`; it is both the revision and the epoch.
- `members` is strictly ascending, duplicate-free, length 1..=9, and includes
  the parameter owner key.
- `secrets` is either empty, or exactly one blob per member with recipients
  matching the member set (ascending) and blobs of 1..=256 bytes. Rotations are
  therefore complete, never partial.
- `sig` verifies against the parameter owner key.

Messages:

- `author` is a valid key and is a member at `epoch`.
- `epoch > 0` and names a membership record retained in state.
- `seq > 0` (delegate-assigned, per author; no global ordering rule).
- `time` is author-supplied (milliseconds). It orders display/eviction only.
- `body` is 1..=1024 decoded bytes, opaque.
- `sig` verifies against `author`.

`sorted` means ascending by `seq` for memberships and by `(time, id)` for
messages, where `id = lowercase_hex(BLAKE3(raw_sig)[0..16])`. The id is derived,
never stored.

A state with messages but no membership records is invalid.

## 3. Canonical signing bytes

Membership:

```
b"number:v1:room:membership"
|| tag: 4 bytes                       // b"ZMR1"
|| owner_vk: 32 bytes
|| seq: u64 LE
|| member_count: u16 LE
|| each member ascending: 32 bytes
|| secret_count: u16 LE
|| each secret ascending by recipient:
     recipient: 32 bytes || blob_len: u32 LE || blob
```

Message:

```
b"number:v1:room:message"
|| tag: 4 bytes
|| owner_vk: 32 bytes
|| author: 32 bytes
|| epoch: u64 LE
|| seq: u64 LE
|| time: i64 LE
|| body_len: u32 LE
|| body
```

The tag and owner bind the signature to one room kind and owner; the author
binds it to one member. The code hash is deliberately absent so a future room
generation can carry records forward.

## 4. Validation

`validate_state` accepts when every field is within bounds, records are sorted
and unique, and every signature verifies. Parameters must be exactly 36 bytes,
start with `ZMR1`, and end with a valid Ed25519 point.

`update_state`:

1. Decode the current state; validate it.
2. Decode each `UpdateData` independently. Invalid deltas are **skipped**, not
   fatal: rooms are multi-writer, so one malformed delta must not block a valid
   one. This is the opposite of the zone's single-writer all-or-nothing policy.
3. Two-phase application: merge every valid membership record first, then
   validate messages against the merged epoch history. A message with an
   unknown epoch is dropped; the rest of its delta still applies.
4. Incremental deltas carry at most 1 membership and 16 messages; `full` and
   incremental fields are mutually exclusive. A full state is the catch-up
   path and is validated as a whole.

`validate_state` is strict (a peer must agree on bytes); `update_state` is
lenient per delta.

## 5. Merge, summary, delta

Merge is a join semilattice:

- memberships: union by `seq`; equal seq keeps the lexicographically greater
  signature bytes; sort ascending; keep the newest 32.
- messages: union by id; drop a message whose epoch is not in the merged
  membership window or whose author is not in that epoch; sort by `(time, id)`;
  keep the newest 200.

The membership window is monotone: a message whose epoch survives the top-32
filter was valid in every intermediate union, so eviction cannot resurrect or
drop order-dependently.

Summary is `{ "v": 1, "digest": "<32 hex>" }` where digest is
`BLAKE3(canonical_state_bytes)[0..16]`. `get_state_delta`: equal digest ->
empty delta; otherwise `{ "v": 1, "full": <state> }`. P3a produces full
catch-up deltas and accepts incremental ones.

## 6. Membership, removal, re-admission

The owner's client derives membership as
`[owner] ∪ { slot.entry.contact for every occupied slot }`, deduped and sorted.
The contract cannot check this against the zone; readers recompute it and show
a mismatch as a warning. A duplicate contact in two slots collapses. Clearing a
slot without re-signing membership leaves the child a member: the UI must
prompt the owner.

Removal:

1. The zone slot is cleared or rebound.
2. The owner signs membership `seq N+1` with the new member list (and, from
   P3c, fresh secrets).
3. A message by the removed member at epoch `N+1` is rejected.
4. Their messages at epochs `<= N` remain valid **history** and stay subject to
   eviction.

A removed member who kept an old epoch key can still post an old-epoch message;
the contract cannot distinguish a late delivery from a new forgery without
order-dependence. The UI renders old epochs as history, never as current
activity. Re-admission at a new epoch is natural; old messages stay valid under
their old epoch.

## 7. Encryption boundary (P3c)

The contract never interprets `body` or `secrets`. P3c adds:

- a per-epoch symmetric key, wrapped once per member with ECIES and stored in
  `secrets`;
- `body` becomes ciphertext;
- the delegate holds the unwrapped epoch key and rotates it when membership
  changes.

Open for P3c: Ed25519→X25519 conversion (no zone state change, conversion
caveats) versus a separate X25519 key (cleaner, but needs zone state and a
re-key). P3a/P3b must not ship as "private": state is public and bodies may be
plaintext.

## 8. Artifacts and upgrades

- The room crate is standalone with its own `Cargo.lock`, like `contract/`.
- `make room` builds it through `scripts/build.sh`; `make room-check` runs
  fmt/clippy/tests; CI gets a `room` job.
- `published/room/` and a sibling room manifest (code hash + generations) are
  added in P3b, when the UI pins the hash. Do not mix room generations into the
  zone `published/manifest.json` gate.
- A future room generation is a new code hash; signed records migrate by copy
  because the signing bytes exclude the code hash. Keep a
  `LEGACY_ROOM_CODE_HASHES` registry when that happens.

## 9. P3a acceptance

Native tests (`room/src/lib.rs`, `room/tests/`):

1. empty initial state validates for any owner; `ZCR1` and wrong lengths fail.
2. membership and message signatures bind tag, owner, author, seq, epoch, time,
   body, member order, secret recipient/blob, and sig.
3. bounds: 0/10 members, duplicate/unsorted members, owner absent, partial or
   oversized secrets, empty/oversized body, bad hex.
4. non-member cannot author; state unchanged.
5. removal: member at epoch 2 accepted, removed at epoch 3 rejected; the old
   epoch-2 message is retained.
6. merge laws: commutative, associative, idempotent, absorbing under shuffled
   delivery, including re-admission and membership-window eviction.
7. top-200 and top-32 are deterministic under shuffled arrival and ties.
8. summary/delta round-trip; behind sends a full state and converges.
9. invalid delta does not block a valid delta; membership merges before
   messages within a batch.
10. delta caps reject 17 messages / 2 memberships before signature loops.
11. canonical JSON round-trips byte-identically; unknown fields are rejected.
12. cross-room replay fails for a different owner or tag.
13. golden vectors in `fixtures/rooms/` (Rust now, TypeScript in P3b).

Build:

14. `make room-check` is part of `make check`.
15. `make check-artifacts` still proves the zone and delegate bytes unchanged
    (room artifacts enter the gate in P3b).

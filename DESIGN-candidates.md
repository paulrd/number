# Candidates room — implementation spec (P4a, candidate room)

Status: draft 1, 2026-11-08. Implements the **candidates room** of
`DESIGN-network.md` §5.3 and the ask channel of §3.4. The members room is
`DESIGN-rooms.md` (P3a/P3c, live). This phase adds only the contract: no
delegate, UI, or deployment change.

Scope decisions:

- The candidate room is a **new standalone crate** (`candidate/`), like `room/`.
  It accepts `ZCR1` only. The members room stays frozen at `ZMR1`: sharing one
  WASM would re-key every live members room.
- The state is the members-room state plus three records: a **bounded request
  queue**, an **owner dismissal set**, and an **accepting config**. Membership,
  messages, secrets and the encryption envelope are copied unchanged so the
  P3c client machinery can be reused with a different tag.
- The queue is the **only open write** in the design: a request is validated by
  its own signature and needs no membership, no zone, and no receipt from the
  owner. Everything else keeps the members-room authorship rules.
- **No artifacts in this phase.** The crate is testable natively, but
  `published/candidate/` and the UI code-hash pin land when the client is wired
  (P4c). Until then the contract may change freely; the delegate and UI are
  untouched, so nothing can reference it.
- One admission round per epoch: the owner invites **one** candidate by adding
  them to the membership, interviews, then removes them on reject or on admit.
  The contract cannot see zone slots, so this is a client invariant.

## 1. Key derivation

```
room_wasm   = the built candidate WASM
code_hash   = BLAKE3(room_wasm)                      // raw WASM, never packaged
parameters  = b"ZCR1" || owner_vk                    // 4 + 32 = 36 bytes
instance_id = BLAKE3(code_hash_bytes || parameters)  // standard Freenet id
```

`owner_vk` is the zone owner's Ed25519 key. The client must pin the published
candidate code hash; never derive a room from a fetched WASM. The members room
and the candidate room for the same owner are different instances because the
tag differs.

## 2. State v1

`deny_unknown_fields` on every struct. Lowercase hex only. The owner and kind
live in the parameters and are covered by every signature, so one static
initial state works for every candidate room:

```json
{
  "v": 1,
  "memberships": [],
  "messages": [],
  "requests": [],
  "dismissals": [],
  "config": null
}
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
  ],
  "requests": [
    {
      "requester": "<64 hex>",
      "want_cell": "003",
      "time": 1762500000000,
      "note": "<lowercase hex>",
      "sig": "<128 lowercase hex>"
    }
  ],
  "dismissals": [{ "id": "<32 hex>", "sig": "<128 lowercase hex>" }],
  "config": { "seq": 1, "accepting": true, "sig": "<128 lowercase hex>" }
}
```

`memberships`, `messages` and `secrets` are exactly the members-room records
(`DESIGN-rooms.md` §2): same fields, bounds, ordering and signature bytes. The
candidate room reuses those two signing domains with its own tag:

```
number:v1:room:membership || ZCR1 || ...
number:v1:room:message    || ZCR1 || ...
```

The tag separates the kinds, so a members-room signature cannot be replayed
into a candidate room and vice versa. Reusing the domain keeps the delegate's
existing byte builders usable: P4b only has to accept `ZCR1` as a tag.

Bounds:

| Constant | Value |
|---|---|
| `MAX_MEMBERS` | 9 (owner + eight slots, or a full members list plus one candidate) |
| `MAX_MEMBERSHIPS` | 32 |
| `MAX_SECRETS_PER_MEMBERSHIP` | 9 |
| `MAX_SECRET_BLOB_BYTES` | 256 |
| `MAX_MESSAGES` | 200 |
| `MAX_BODY_BYTES` | 1024 |
| `MAX_REQUESTS` | 8 |
| `MAX_WANT_CELL_CHARS` | 32 |
| `MAX_NOTE_BYTES` | 256 |
| `MAX_DISMISSALS` | 64 |
| `MAX_MESSAGES_PER_DELTA` | 16 |
| `MAX_MEMBERSHIPS_PER_DELTA` | 1 |
| `MAX_REQUESTS_PER_DELTA` | 8 |
| `MAX_DISMISSALS_PER_DELTA` | 8 |
| `MAX_CONFIGS_PER_DELTA` | 1 |

A request costs at most 64 (requester) + 8 (time) + 32 (want_cell) + 256
(note) + 128 (sig) ≈ 500 bytes of JSON — the "512 bytes each" budget in
`DESIGN-network.md` §3.4. The queue is capped at eight entries, so spam is
bounded by capacity.

Record rules:

- `requests.requester` is a valid key; it need not be a member.
- `requests.want_cell` is 0..=32 characters from `0`..`7`, the zone-address
  form. The empty string is the world. It records the deepest published cell
  containing the newcomer's point (what the match walk used) and becomes public
  with the request.
- `requests.note` is 0..=256 decoded bytes of opaque lowercase hex. The UI
  sends UTF-8 text; the contract never interprets it.
- `requests.time` is author-supplied milliseconds; it orders display and
  eviction only.
- `dismissals.id` is the derived request id (see §3); `sig` is the owner's.
- `config.seq > 0`; `accepting` is the owner's zone-open flag. A state with no
  config is accepting (the initial state has none).
- A request whose id appears in `dismissals` is invalid in state; dismissal
  removes it everywhere (§5).

## 3. Canonical signing bytes

Membership and message: as `DESIGN-rooms.md` §3, with tag `ZCR1`.

Request (`requester` signs):

```
b"number:v1:candidate:request"
|| tag: 4 bytes                       // b"ZCR1"
|| owner_vk: 32 bytes
|| requester: 32 bytes
|| time: i64 LE
|| want_cell_len: u16 LE
|| want_cell: ASCII digits             // 0..=32 bytes
|| note_len: u32 LE
|| note                                // 0..=256 bytes
```

Dismissal (owner signs):

```
b"number:v1:candidate:dismiss"
|| tag: 4 bytes
|| owner_vk: 32 bytes
|| request_id: 16 bytes                // BLAKE3(raw request sig)[0..16]
```

Config (owner signs):

```
b"number:v1:candidate:config"
|| tag: 4 bytes
|| owner_vk: 32 bytes
|| seq: u64 LE
|| accepting: u8                      // 0 or 1
```

Derived ids:

```
request_id = lowercase_hex(BLAKE3(raw_request_sig)[0..16])   // 32 hex chars
```

The id is derived, never stored on the request. A replay of the same signed
request therefore has the same id and stays dismissed.

## 4. Validation

`validate_state` accepts when every field is within bounds, records are sorted
and unique, and every signature verifies under the right key:

- memberships: as members room (ascending `seq`, `members` strictly ascending
  including the owner, secrets empty or one per member, owner signature).
- messages: as members room (author is a member at `epoch`; the epoch names a
  retained membership; sorted by `(time, id)`).
- requests: individually valid signatures, ascending by `(time, id)`, unique
  ids, none dismissed.
- dismissals: ascending by `id`, unique, ≤64, each owner-signed over its id.
- config: if present, `seq > 0` and owner-signed.

Parameters must be exactly 36 bytes, start with `ZCR1`, and end with a valid
Ed25519 point. `ZMR1` is rejected.

`update_state`:

1. Decode the current state; validate it.
2. Decode each `UpdateData` independently. Invalid deltas are **skipped**, not
   fatal — multi-writer policy, same as the members room.
3. Stage every valid update, then apply in a fixed order: memberships first,
   then messages against the **merged** epoch history; requests, dismissals and
   config are merged independently. Config and dismissals apply before the
   request filter, so one delta may add a request and another dismiss it.
4. Incremental deltas carry at most 1 membership, 16 messages, 8 requests,
   8 dismissals and 1 config; `full` and the incremental fields are mutually
   exclusive. A full state is the catch-up path and is validated as a whole.

`validate_state` is strict (peers must agree on bytes); `update_state` is
lenient per delta.

## 5. Merge, summary, delta

Merge is a join semilattice:

- memberships: union by `seq`; equal seq keeps the lexicographically greater
  signature; sort ascending; keep the newest 32.
- messages: union by id; drop a message whose epoch is not in the merged
  membership window or whose author is not in that epoch; sort by `(time, id)`;
  keep the newest 200.
- requests: union by id; drop any request whose id is dismissed; sort by
  `(time, id)`; keep the newest 8.
- dismissals: union by id; sort ascending; keep the lexicographically greatest
  64.
- config: keep the record with the greatest `seq`; on equal `seq`, the greater
  signature bytes. (The owner's write is monotone in `seq`, so concurrent
  copies resolve without a coordinator.)

Bounded dismissal window: once more than 64 dismissals exist, the
lexicographically smallest ones leave the state. A request whose dismissal has
left the window can reappear from a stale full-state replay. The queue holds
eight, so any request dismissed within the last 64 dismissals stays dismissed;
this is an accepted bound, not a permanent deletion.

The membership window is monotone exactly as in the members room. Requests
have no epoch: they are public queue entries, valid even when no membership
exists yet.

Summary is `{ "v": 1, "digest": "<32 hex>" }` where digest is
`BLAKE3(canonical_state_bytes)[0..16]`. `get_state_delta`: equal digest ->
empty delta; otherwise `{ "v": 1, "full": <state> }`. This phase produces full
catch-up deltas and accepts incremental ones.

## 6. Operations and invariants

- **Ask.** A candidate writes a signed request directly (a delta with one
  request). No membership, no contact and no zone write are required.
- **Clear / close.** The owner dismisses request ids (clear) and/or writes
  `config { accepting: false }` (close). Both are effective on merge; neither
  deletes contract history.
- **Invite / interview.** The owner writes a membership record that adds the
  candidate. Messages then behave as in the members room, encrypted with the
  epoch key sealed to the new member set.
- **Reject.** The owner writes the next membership without the candidate and
  with fresh secrets; the candidate loses access to the new epoch. Old epochs
  remain readable history.
- **Admit.** The owner writes the zone slot (the region designation), the
  candidate signs `parent`, then the owner writes the next membership without
  the candidate. The members room is updated separately.
- **Rotation.** Exactly one key per membership record; rotate on every
  membership change, never on messages (`DESIGN-rooms.md` §7.5).
- The contract never reads the host clock and never uses randomness. The
  caller supplies `time` and the owner supplies `seq`.

## 7. Encryption

The P3c envelope is reused with tag `ZCR1`:

- secret blob info/AAD: `number:v1:room:secret || ZCR1 || roomId || owner ||
  epoch_le || recipient`;
- body AAD: `number:v1:room:body || ZCR1 || roomId || owner || author ||
  epoch_le`.

Body and secret bytes stay opaque to the contract. Delegate v13 must accept
`ZCR1` in `signRoomMembership`, `signRoomMessage`, `sealRoomEpoch` and
`openRoomSecret`; P4a does not change the delegate.

### 7.1 Delegate v13 commands

The four existing room commands accept either tag (`ZMR1` or `ZCR1`). The
epoch-secret HKDF info and the sealed blob are bound to the tag supplied by the
caller, so a members-room blob cannot be opened as a candidate-room blob.

Three new commands sign candidate-only records. They have no room id argument:
the room is uniquely derived from `tag || owner`, and the tag is fixed to
`ZCR1` in the signed bytes.

```
signCandidateRequest { owner, time, wantCell, note }
  -> { "ok": true, "requester": "<64 hex>", "requestId": "<32 hex>",
       "sig": "<128 hex>" }
```

`requester` is always the local delegate key; `owner` is the target zone's
owner key and may differ from the local key. No counter is read or written: a
request is a standalone signed record and the candidate may ask several
targets. `requestId` is `BLAKE3(raw sig)[0..16]` as 32 lowercase hex.

```
signCandidateDismissal { owner, id }        // owner only
  -> { "ok": true, "id": "<32 hex>", "sig": "<128 hex>" }
```

```
signCandidateConfig { owner, seq, accepting }   // owner only
  -> { "ok": true, "seq": N, "sig": "<128 hex>" }
```

The delegate refuses dismissal and config unless its local key equals `owner`.
Neither uses a counter: dismissals are idempotent, and `config` is monotone in
the caller-supplied `seq` (merge keeps the greatest). A replayed old config
signature is harmless by construction.

Validation mirrors the contract: `owner`/`requester` are Ed25519 points,
`wantCell` is 0–32 characters from `0`–`7`, `note` is lowercase hex of 0–256
bytes, `id` is 32 lowercase hex, and `seq > 0`.

## 8. Build and artifacts

- `candidate/` is standalone with its own `Cargo.lock`, like `room/`.
- `make candidate` builds it through `scripts/build.sh`; `make candidate-check`
  runs fmt/clippy/tests; `make check` includes it; CI gets a `candidate` job.

### 8.1 Client layer (P4c)

- `ui/src/candidate-state.ts` mirrors the contract state/delta encoders, merge,
  digest, request ids and config helpers. It reuses the members-room membership
  and message shapes: `room-state.ts` exports its two record parsers and
  encoders (no behaviour change) so the candidate codec has one implementation
  of those records.
- `ui/src/candidate-client.ts` mirrors `OnlineRoomTransport` with tag `ZCR1`
  and its own pinned constants (`__CANDIDATE_CODE_HASH__`,
  `__CANDIDATE_CODE_HASH_BYTES__`, `__CANDIDATE_WASM_URL__`). It creates a
  missing instance from the bundled raw WASM, reads, and re-reads every write
  to confirm it landed (the contract skips invalid deltas silently).
- New client operations: `request(owner, {wantCell, note})` (builds the
  requester-signed record with `time = Date.now()`, writes it, confirms),
  `setAccepting(owner, accepting)` (owner only; `seq = latest.seq + 1`) and
  `dismiss(owner, requestId)` (owner only). Membership/message/epoch methods
  are the members-room ones with `ZCR1`.
- `room-crypto.ts` gains an optional `tag` on `RoomBodyContext` (default
  `ZMR1`); the candidate client passes `ZCR1` for both body AAD and epoch-secret
  context.
- `ui/src/delegate.ts` gains `signCandidateRequest`, `signCandidateDismissal`
  and `signCandidateConfig` methods; the signer interface used by the client
  requires them.
- The one-candidate-per-epoch rule is a client invariant: the owner adds one
  candidate to the membership for an interview and removes them on reject or
  admit. The UI must not invite a second candidate into the same epoch.
- Artifacts are pinned now: `published/candidate/` (raw WASM + manifest),
  `make candidate-record` / `make candidate-check-artifacts`,
  `make check-artifacts` includes the candidate gate, and `scripts/build.sh`
  copies the raw WASM to `ui/public/number_candidate.wasm` and fails if the
  build does not match the recorded hash.
- No contract change: P4c adds the client, the `?root=` flow and the UI.

## 9. P4a acceptance

Native tests (`candidate/src/lib.rs`):

1. empty initial state validates for any owner; `ZMR1`, wrong lengths and bad
   points fail.
2. membership and message signatures bind tag, owner, author, seq, epoch, time,
   body, member order, secret recipient/blob, and sig — parity with
   `fixtures/candidate/golden_v1.json`.
3. request signature binds tag, owner, requester, time, `want_cell` and note;
   any field change fails. `ZMR1` replay fails.
4. bounds: 9 requests, empty/oversized note, >32-char or non-octal
   `want_cell`, bad hex, bad signature.
5. a non-member's valid request is accepted; a second request from another
   non-member is accepted; the queue keeps the newest 8 by `(time, id)` under
   shuffled arrival.
6. dismissal: the owner removes a request in merge; the state carrying both
   the request and its dismissal is invalid; a non-owner dismissal is
   rejected; dismissed ids stay dismissed when the request replays.
7. config: `accepting: false` becomes state; a higher `seq` wins; a lower
   `seq` is ignored; equal `seq` resolves by signature bytes.
8. membership/message behaviour is unchanged from the members room: non-member
   cannot author; removal takes effect at the next epoch; old messages stay
   valid history; re-admission works.
9. merge laws: commutative, associative, idempotent, absorbing under shuffled
   delivery, including requests, dismissals and config.
10. top-8 requests, top-64 dismissals, top-200 messages and top-32 memberships
    are deterministic under shuffled arrival and ties.
11. summary/delta round-trip; behind sends a full state and converges.
12. an invalid delta does not block a valid request delta; one delta may add a
    request and another dismiss it.
13. delta caps reject 17 messages, 2 memberships, 9 requests, 9 dismissals or
    2 configs before signature loops.
14. canonical JSON round-trips byte-identically; unknown fields are rejected;
    `config` is present as `null` in the initial state.
15. cross-owner and cross-tag replay fails.
16. golden vectors in `fixtures/candidate/golden_v1.json` (request, dismissal,
    config, plus the reused membership/message) are byte-stable.

Build:

17. `make candidate-check` is part of `make check`; CI has a `candidate` job.
18. `make check-artifacts` still proves the zone, delegate and members-room
    bytes unchanged.
